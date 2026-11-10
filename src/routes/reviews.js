import { Router } from "express";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { getDb } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  usersByIds, publicUser, pageParams, notify, notifyAdmins, recalcSitterRating, parseObjectId,
} from "../utils/helpers.js";

const router = Router();
const reviews = () => getDb().collection("reviews");

const createSchema = z.object({
  bookingId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().min(5).max(1000),
  photos: z.array(z.string().url()).max(4).default([]),
});

// POST /api/reviews  (owner, shudhu completed booking e)
router.post("/", requireAuth, requireRole("owner"), async (req, res) => {
  const data = createSchema.parse(req.body);
  if (!ObjectId.isValid(data.bookingId)) return res.status(400).json({ message: "Invalid booking" });

  const booking = await getDb().collection("bookings").findOne({
    _id: new ObjectId(data.bookingId),
    ownerId: req.user.id,
  });
  if (!booking) return res.status(404).json({ message: "Booking not found" });
  if (booking.status !== "completed") {
    return res.status(400).json({ message: "You can review only completed bookings" });
  }

  const doc = {
    bookingId: String(booking._id),
    ownerId: req.user.id,
    sitterId: booking.sitterId,
    rating: data.rating,
    comment: data.comment,
    photos: data.photos,
    status: "visible",
    createdAt: new Date(),
  };

  try {
    const result = await reviews().insertOne(doc);
    doc._id = result.insertedId;
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: "You already reviewed this booking" });
    throw err;
  }

  await recalcSitterRating(booking.sitterId);
  await notify(booking.sitterId, {
    type: "new_review",
    title: "New review",
    message: `${req.user.name} gave you ${data.rating} star${data.rating > 1 ? "s" : ""}.`,
    link: "/dashboard/sitter/reviews",
  });

  res.status(201).json({ review: doc });
});

// GET /api/reviews/mine  (owner: ami ja likhechi, sitter: amar upor ja likha hoyeche)
router.get("/mine", requireAuth, async (req, res) => {
  if (!["owner", "sitter"].includes(req.user.role)) return res.json({ reviews: [] });
  const { page, limit, skip } = pageParams(req.query);
  const isOwner = req.user.role === "owner";
  const filter = isOwner ? { ownerId: req.user.id } : { sitterId: req.user.id, status: { $ne: "hidden" } };

  const [items, total] = await Promise.all([
    reviews().find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    reviews().countDocuments(filter),
  ]);
  const users = await usersByIds(items.map((r) => (isOwner ? r.sitterId : r.ownerId)));

  res.json({
    reviews: items.map((r) => ({
      ...r,
      [isOwner ? "sitter" : "owner"]: publicUser(users.get(isOwner ? r.sitterId : r.ownerId)),
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

// GET /api/reviews/sitter/:sitterId  (public, "See all reviews")
router.get("/sitter/:sitterId", async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const filter = { sitterId: req.params.sitterId, status: { $ne: "hidden" } };
  const [items, total] = await Promise.all([
    reviews().find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    reviews().countDocuments(filter),
  ]);
  const users = await usersByIds(items.map((r) => r.ownerId));
  res.json({
    reviews: items.map((r) => ({
      _id: r._id,
      rating: r.rating,
      comment: r.comment,
      photos: r.photos,
      createdAt: r.createdAt,
      owner: publicUser(users.get(r.ownerId)),
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

// POST /api/reviews/:id/report  (sitter kono review report korte pare)
router.post("/:id/report", requireAuth, requireRole("sitter"), async (req, res) => {
  const _id = parseObjectId(req, res);
  if (!_id) return;
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);

  const review = await reviews().findOne({ _id, sitterId: req.user.id });
  if (!review) return res.status(404).json({ message: "Review not found" });
  if (review.status !== "visible") return res.status(400).json({ message: "Review cannot be reported" });

  await reviews().updateOne({ _id }, { $set: { status: "reported", reportReason: reason, reportedAt: new Date() } });
  await notifyAdmins({
    type: "review_reported",
    title: "Review reported",
    message: `${req.user.name} reported a review.`,
    link: "/dashboard/admin/reviews",
  });
  res.json({ message: "Review reported" });
});

export default router;