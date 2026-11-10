import { Router } from "express";
import { getDb } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { todayStr } from "../utils/dates.js";
import { usersByIds, publicUser } from "../utils/helpers.js";

const router = Router();
router.use(requireAuth);

// GET /api/dashboard/owner
router.get("/owner", requireRole("owner"), async (req, res) => {
  const db = getDb();
  const ownerId = req.user.id;
  const today = todayStr();
  const bookings = db.collection("bookings");

  const [totalCats, activeBookings, pendingBookings, completedBookings, upcoming, cats, myReviews] =
    await Promise.all([
      db.collection("cats").countDocuments({ ownerId }),
      bookings.countDocuments({ ownerId, status: "accepted", to: { $gte: today } }),
      bookings.countDocuments({ ownerId, status: "pending" }),
      bookings.countDocuments({ ownerId, status: "completed" }),
      bookings.find({ ownerId, status: { $in: ["accepted", "pending"] }, to: { $gte: today } }).sort({ from: 1 }).limit(3).toArray(),
      db.collection("cats").find({ ownerId }).sort({ createdAt: -1 }).limit(4).toArray(),
      db.collection("reviews").find({ ownerId }).sort({ createdAt: -1 }).limit(3).toArray(),
    ]);

  const users = await usersByIds([...upcoming.map((b) => b.sitterId), ...myReviews.map((r) => r.sitterId)]);

  res.json({
    stats: { totalCats, activeBookings, pendingBookings, completedBookings },
    upcoming: upcoming.map((b) => ({ ...b, sitter: publicUser(users.get(b.sitterId)) })),
    cats,
    recentReviews: myReviews.map((r) => ({ ...r, sitter: publicUser(users.get(r.sitterId)) })),
  });
});

// GET /api/dashboard/sitter
router.get("/sitter", requireRole("sitter"), async (req, res) => {
  const db = getDb();
  const sitterId = req.user.id;
  const today = todayStr();
  const bookings = db.collection("bookings");

  const [profile, totalBookings, pendingRequests, completedJobs, earningsAgg, recentRequests, upcoming] =
    await Promise.all([
      db.collection("sitterProfiles").findOne({ userId: sitterId }),
      bookings.countDocuments({ sitterId }),
      bookings.countDocuments({ sitterId, status: "pending" }),
      bookings.countDocuments({ sitterId, status: "completed" }),
      bookings.aggregate([
        { $match: { sitterId, status: "completed" } },
        { $group: { _id: null, total: { $sum: "$subtotal" } } },
      ]).toArray(),
      bookings.find({ sitterId, status: "pending" }).sort({ createdAt: -1 }).limit(5).toArray(),
      bookings.find({ sitterId, status: "accepted", to: { $gte: today } }).sort({ from: 1 }).limit(5).toArray(),
    ]);

  const users = await usersByIds([...recentRequests, ...upcoming].map((b) => b.ownerId));
  const attach = (b) => ({ ...b, owner: publicUser(users.get(b.ownerId)) });

  res.json({
    profileStatus: profile?.verificationStatus ?? "none",
    stats: {
      totalBookings,
      pendingRequests,
      completedJobs,
      averageRating: profile?.ratingAvg ?? 0,
      earnings: earningsAgg[0]?.total ?? 0,
    },
    recentRequests: recentRequests.map(attach),
    upcoming: upcoming.map(attach),
  });
});

export default router;