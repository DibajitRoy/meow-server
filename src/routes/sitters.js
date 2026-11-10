import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { dateStr, todayStr } from "../utils/dates.js";
import { usersByIds, publicUser, pageParams, escapeRegex, notifyAdmins } from "../utils/helpers.js";

const router = Router();
const profiles = () => getDb().collection("sitterProfiles");

const profileSchema = z.object({
  bio: z.string().trim().min(10).max(1500),
  city: z.string().trim().min(2).max(60),
  address: z.string().trim().max(200).optional(),
  pricePerDay: z.number().min(1).max(10000),
  experienceYears: z.number().int().min(0).max(60),
  services: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  photo: z.string().url().optional(),
  gallery: z.array(z.string().url()).max(8).default([]),
  acceptingBookings: z.boolean().default(true),
});

const searchSchema = z.object({
  city: z.string().trim().optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  rating: z.coerce.number().min(0).max(5).optional(),
  experience: z.coerce.number().min(0).optional(),
  service: z.string().trim().min(1).max(40).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
  sort: z.enum(["rating", "priceLow", "priceHigh", "experience"]).default("rating"),
});

const SORTS = {
  rating: { ratingAvg: -1, ratingCount: -1 },
  priceLow: { pricePerDay: 1 },
  priceHigh: { pricePerDay: -1 },
  experience: { experienceYears: -1 },
};

// ---------- Sitter nijer profile ----------

router.get("/me/profile", requireAuth, requireRole("sitter"), async (req, res) => {
  const profile = await profiles().findOne({ userId: req.user.id });
  res.json({ profile });
});

router.put("/me/profile", requireAuth, requireRole("sitter"), async (req, res) => {
  const data = profileSchema.parse(req.body);
  const existing = await profiles().findOne({ userId: req.user.id });

    const unset = {};
  if (data.address === undefined) unset.address = "";
  if (data.photo === undefined) unset.photo = "";

  const update = {
    $set: { ...data, updatedAt: new Date() },
    $setOnInsert: { verificationStatus: "pending", ratingAvg: 0, ratingCount: 0, createdAt: new Date() },
  };
  if (Object.keys(unset).length) update.$unset = unset;

  await profiles().updateOne({ userId: req.user.id }, update, { upsert: true });

  // Rejected hoye thakle abar submit korle pending e jabe
  if (existing?.verificationStatus === "rejected") {
    await profiles().updateOne(
      { userId: req.user.id },
      { $set: { verificationStatus: "pending" }, $unset: { rejectionReason: "" } }
    );
  }

  if (!existing || existing.verificationStatus === "rejected") {
    await notifyAdmins({
      type: "sitter_verification",
      title: "New sitter awaiting verification",
      message: `${req.user.name} submitted a sitter profile.`,
      link: "/dashboard/admin/sitters",
    });
  }

  const profile = await profiles().findOne({ userId: req.user.id });
  res.json({ profile });
});

// ---------- Public: search ----------

router.get("/", async (req, res) => {
  // Khali ("") query param gulo bad dei
  const clean = Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== ""));
  const q = searchSchema.parse(clean);
  const { page, limit, skip } = pageParams(req.query, 9);

  const filter = { verificationStatus: "verified", acceptingBookings: true };
  if (q.city) filter.city = { $regex: escapeRegex(q.city), $options: "i" };
  if (q.minPrice !== undefined || q.maxPrice !== undefined) {
    filter.pricePerDay = {};
    if (q.minPrice !== undefined) filter.pricePerDay.$gte = q.minPrice;
    if (q.maxPrice !== undefined) filter.pricePerDay.$lte = q.maxPrice;
  }
  if (q.rating !== undefined) filter.ratingAvg = { $gte: q.rating };
  if (q.experience !== undefined) filter.experienceYears = { $gte: q.experience };
  if (q.service) filter.services = { $regex: escapeRegex(q.service), $options: "i" };

  // Date dile je sitter ei somoy busy tader bad dei
  if (q.from && q.to && q.to > q.from) {
    const db = getDb();
    const [booked, blocked] = await Promise.all([
      db.collection("bookings").distinct("sitterId", { status: "accepted", from: { $lt: q.to }, to: { $gt: q.from } }),
      db.collection("availability").distinct("sitterId", { from: { $lt: q.to }, to: { $gte: q.from } }),
    ]);
    const busy = [...new Set([...booked, ...blocked])];
    if (busy.length) filter.userId = { $nin: busy };
  }

  const [items, total] = await Promise.all([
    profiles().find(filter).sort(SORTS[q.sort]).skip(skip).limit(limit).toArray(),
    profiles().countDocuments(filter),
  ]);
  const users = await usersByIds(items.map((p) => p.userId));

  res.json({
    sitters: items.map((p) => {
      const u = publicUser(users.get(p.userId));
      return {
        id: p.userId,
        name: u?.name ?? "Sitter",
        photo: p.photo || u?.image || null,
        city: p.city,
        pricePerDay: p.pricePerDay,
        experienceYears: p.experienceYears,
        services: p.services,
        bio: p.bio.slice(0, 140),
        ratingAvg: p.ratingAvg,
        ratingCount: p.ratingCount,
        verified: true,
      };
    }),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

// ---------- Public: sitter details ----------

router.get("/:id", async (req, res) => {
  const profile = await profiles().findOne({ userId: req.params.id, verificationStatus: "verified" });
  if (!profile) return res.status(404).json({ message: "Sitter not found" });

  const db = getDb();
  const today = todayStr();
  const [reviews, blocks, booked] = await Promise.all([
    db.collection("reviews").find({ sitterId: profile.userId, status: { $ne: "hidden" } }).sort({ createdAt: -1 }).limit(10).toArray(),
    db.collection("availability").find({ sitterId: profile.userId, to: { $gte: today } }).toArray(),
    db.collection("bookings").find({ sitterId: profile.userId, status: "accepted", to: { $gt: today } }).toArray(),
  ]);
  const users = await usersByIds([profile.userId, ...reviews.map((r) => r.ownerId)]);
  const u = publicUser(users.get(profile.userId));

  res.json({
    sitter: {
      id: profile.userId,
      name: u?.name ?? "Sitter",
      photo: profile.photo || u?.image || null,
      bio: profile.bio,
      city: profile.city,
      address: profile.address || null,
      pricePerDay: profile.pricePerDay,
      experienceYears: profile.experienceYears,
      services: profile.services,
      gallery: profile.gallery,
      ratingAvg: profile.ratingAvg,
      ratingCount: profile.ratingCount,
      verified: true,
    },
    reviews: reviews.map((r) => ({
      _id: r._id,
      rating: r.rating,
      comment: r.comment,
      photos: r.photos,
      createdAt: r.createdAt,
      owner: publicUser(users.get(r.ownerId)),
    })),
    unavailable: [
      ...blocks.map((b) => ({ from: b.from, to: b.to, type: b.status })),
      ...booked.map((b) => ({ from: b.from, to: b.to, type: "booked" })),
    ],
  });
});

export default router;
