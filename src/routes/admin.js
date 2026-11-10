import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db.js";
import { requireAuth, requireRole, toIdFilter } from "../middleware/auth.js";
import {
  usersByIds, publicUser, pageParams, escapeRegex, notify, recalcSitterRating, parseObjectId,
} from "../utils/helpers.js";

const router = Router();
router.use(requireAuth, requireRole("admin"));

const users = () => getDb().collection("user");

// ---------- Stats ----------
router.get("/stats", async (req, res) => {
  const db = getDb();
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
  sixMonthsAgo.setDate(1);
  sixMonthsAgo.setHours(0, 0, 0, 0);

  const [totalUsers, owners, sitters, cats, totalBookings, pendingSitters, byStatus, monthly, revenueAgg, recent] =
    await Promise.all([
      users().countDocuments({}),
      users().countDocuments({ role: "owner" }),
      users().countDocuments({ role: "sitter" }),
      db.collection("cats").countDocuments({}),
      db.collection("bookings").countDocuments({}),
      db.collection("sitterProfiles").countDocuments({ verificationStatus: "pending" }),
      db.collection("bookings").aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
      db.collection("bookings").aggregate([
        { $match: { createdAt: { $gte: sixMonthsAgo } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      db.collection("bookings").aggregate([
        { $match: { status: "completed" } },
        { $group: { _id: null, gross: { $sum: "$total" }, fees: { $sum: "$serviceFee" } } },
      ]).toArray(),
      db.collection("bookings").find({}).sort({ createdAt: -1 }).limit(5).toArray(),
    ]);

  const u = await usersByIds(recent.flatMap((b) => [b.ownerId, b.sitterId]));

  res.json({
    totals: { totalUsers, owners, sitters, cats, totalBookings, pendingSitters },
    bookingsByStatus: Object.fromEntries(byStatus.map((s) => [s._id, s.count])),
    monthlyBookings: monthly.map((m) => ({ month: m._id, count: m.count })),
    revenue: { gross: revenueAgg[0]?.gross ?? 0, fees: revenueAgg[0]?.fees ?? 0 },
    recentBookings: recent.map((b) => ({
      _id: b._id,
      status: b.status,
      from: b.from,
      to: b.to,
      total: b.total,
      cat: b.cat.name,
      owner: publicUser(u.get(b.ownerId)),
      sitter: publicUser(u.get(b.sitterId)),
    })),
  });
});

// ---------- Users ----------
router.get("/users", async (req, res) => {
  const { page, limit, skip } = pageParams(req.query, 10);
  const filter = {};
  if (["owner", "sitter", "admin"].includes(req.query.role)) filter.role = req.query.role;
  if (["active", "blocked"].includes(req.query.status)) {
    filter.status = req.query.status === "blocked" ? "blocked" : { $ne: "blocked" };
  }
  if (req.query.q) {
    const rx = { $regex: escapeRegex(String(req.query.q)), $options: "i" };
    filter.$or = [{ name: rx }, { email: rx }];
  }

  const [items, total] = await Promise.all([
    users().find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    users().countDocuments(filter),
  ]);

  res.json({
    users: items.map((x) => ({
      id: String(x._id),
      name: x.name,
      email: x.email,
      phone: x.phone || null,
      role: x.role || "owner",
      status: x.status || "active",
      image: x.image || null,
      createdAt: x.createdAt,
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

router.patch("/users/:id/status", async (req, res) => {
  const { status } = z.object({ status: z.enum(["active", "blocked"]) }).parse(req.body);
  if (req.params.id === req.user.id) return res.status(400).json({ message: "You cannot change your own status" });

  const target = await users().findOne(toIdFilter(req.params.id));
  if (!target) return res.status(404).json({ message: "User not found" });
  if (target.role === "admin") return res.status(403).json({ message: "Admin accounts cannot be blocked" });

  await users().updateOne({ _id: target._id }, { $set: { status, updatedAt: new Date() } });
  res.json({ message: `User ${status}` });
});

// ---------- Sitter verification ----------
router.get("/sitters", async (req, res) => {
  const { page, limit, skip } = pageParams(req.query, 10);
  const filter = {};
  if (["pending", "verified", "rejected"].includes(req.query.status)) filter.verificationStatus = req.query.status;

  const [items, total] = await Promise.all([
    getDb().collection("sitterProfiles").find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    getDb().collection("sitterProfiles").countDocuments(filter),
  ]);
  const u = await usersByIds(items.map((p) => p.userId));

  res.json({
    sitters: items.map((p) => {
      const user = u.get(p.userId);
      return {
        userId: p.userId,
        name: user?.name ?? "Unknown",
        email: user?.email ?? null,
        photo: p.photo || user?.image || null,
        city: p.city,
        bio: p.bio,
        experienceYears: p.experienceYears,
        pricePerDay: p.pricePerDay,
        services: p.services,
        verificationStatus: p.verificationStatus,
        rejectionReason: p.rejectionReason || null,
        createdAt: p.createdAt,
      };
    }),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

router.patch("/sitters/:userId/verification", async (req, res) => {
  const { status, reason } = z
    .object({ status: z.enum(["verified", "rejected"]), reason: z.string().trim().max(300).optional() })
    .parse(req.body);

  const set = { verificationStatus: status, verifiedAt: new Date() };
  const update = status === "rejected" ? { $set: { ...set, rejectionReason: reason || "Not specified" } } : { $set: set, $unset: { rejectionReason: "" } };

  const result = await getDb().collection("sitterProfiles").updateOne({ userId: req.params.userId }, update);
  if (!result.matchedCount) return res.status(404).json({ message: "Sitter profile not found" });

  await notify(req.params.userId, {
    type: `sitter_${status}`,
    title: status === "verified" ? "Your profile is verified 🎉" : "Your profile was rejected",
    message:
      status === "verified"
        ? "Owners can now find and book you."
        : `Reason: ${reason || "Not specified"}. Update your profile and submit again.`,
    link: "/dashboard/sitter/profile",
  });

  res.json({ message: `Sitter ${status}` });
});

// ---------- Review moderation ----------
router.get("/reviews", async (req, res) => {
  const { page, limit, skip } = pageParams(req.query, 10);
  const filter = {};
  if (["visible", "reported", "hidden"].includes(req.query.status)) filter.status = req.query.status;

  const [items, total] = await Promise.all([
    getDb().collection("reviews").find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    getDb().collection("reviews").countDocuments(filter),
  ]);
  const u = await usersByIds(items.flatMap((r) => [r.ownerId, r.sitterId]));

  res.json({
    reviews: items.map((r) => ({
      ...r,
      owner: publicUser(u.get(r.ownerId)),
      sitter: publicUser(u.get(r.sitterId)),
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

router.patch("/reviews/:id", async (req, res) => {
  const _id = parseObjectId(req, res);
  if (!_id) return;
  const { status } = z.object({ status: z.enum(["visible", "hidden"]) }).parse(req.body);

  const review = await getDb().collection("reviews").findOneAndUpdate(
    { _id },
    { $set: { status, moderatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!review) return res.status(404).json({ message: "Review not found" });

  await recalcSitterRating(review.sitterId);
  res.json({ message: `Review ${status}` });
});

export default router;