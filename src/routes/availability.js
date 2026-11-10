import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { dateStr, todayStr } from "../utils/dates.js";
import { parseObjectId } from "../utils/helpers.js";

const router = Router();
router.use(requireAuth, requireRole("sitter"));

const blocks = () => getDb().collection("availability");

const blockSchema = z.object({
  from: dateStr,
  to: dateStr,
  status: z.enum(["unavailable", "holiday"]),
  note: z.string().trim().max(200).optional(),
});

// GET /api/availability  -> ei sitter er block kora date gulo
router.get("/", async (req, res) => {
  const list = await blocks()
    .find({ sitterId: req.user.id, to: { $gte: todayStr() } })
    .sort({ from: 1 })
    .toArray();
  res.json({ blocks: list });
});

router.post("/", async (req, res) => {
  const data = blockSchema.parse(req.body);
  if (data.to < data.from) return res.status(400).json({ message: "End date cannot be before start date" });
  if (data.from < todayStr()) return res.status(400).json({ message: "Start date cannot be in the past" });

  // Accepted booking thakle block kora jabe na
  const clash = await getDb().collection("bookings").findOne({
    sitterId: req.user.id,
    status: "accepted",
    from: { $lte: data.to },
    to: { $gt: data.from },
  });
  if (clash) return res.status(409).json({ message: "You already have an accepted booking in this range" });

  const doc = { ...data, sitterId: req.user.id, createdAt: new Date() };
  const result = await blocks().insertOne(doc);
  res.status(201).json({ block: { ...doc, _id: result.insertedId } });
});

// DELETE /api/availability/:id  -> abar available kore dei
router.delete("/:id", async (req, res) => {
  const _id = parseObjectId(req, res);
  if (!_id) return;
  const result = await blocks().deleteOne({ _id, sitterId: req.user.id });
  if (!result.deletedCount) return res.status(404).json({ message: "Not found" });
  res.json({ message: "Removed" });
});

export default router;