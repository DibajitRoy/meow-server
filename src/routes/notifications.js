import { Router } from "express";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { parseObjectId } from "../utils/helpers.js";

const router = Router();
router.use(requireAuth);

const notifications = () => getDb().collection("notifications");

// GET /api/notifications
router.get("/", async (req, res) => {
  const [items, unreadCount] = await Promise.all([
    notifications().find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(30).toArray(),
    notifications().countDocuments({ userId: req.user.id, read: false }),
  ]);
  res.json({ notifications: items, unreadCount });
});

// PATCH /api/notifications/read-all
router.patch("/read-all", async (req, res) => {
  await notifications().updateMany({ userId: req.user.id, read: false }, { $set: { read: true } });
  res.json({ message: "All marked as read" });
});

// PATCH /api/notifications/:id/read
router.patch("/:id/read", async (req, res) => {
  const _id = parseObjectId(req, res);
  if (!_id) return;
  await notifications().updateOne({ _id, userId: req.user.id }, { $set: { read: true } });
  res.json({ message: "Marked as read" });
});

export default router;