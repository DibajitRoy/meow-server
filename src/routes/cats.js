import { Router } from "express";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { getDb } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireRole("owner"));

const catSchema = z.object({
  name: z.string().trim().min(1).max(50),
  breed: z.string().trim().max(60).optional(),
  age: z.number().min(0).max(40).optional(),
  gender: z.enum(["male", "female", "unknown"]).default("unknown"),
  weight: z.number().min(0).max(30).optional(),
  feedingSchedule: z.string().trim().max(500).optional(),
  careInstructions: z.string().trim().max(1000).optional(),
  medicalNotes: z.string().trim().max(1000).optional(),
  vaccinated: z.boolean().default(false),
  emergencyContact: z.string().trim().max(100).optional(),
  photo: z.string().url().optional(),
});

const cats = () => getDb().collection("cats");

function parseId(req, res) {
  if (!ObjectId.isValid(req.params.id)) {
    res.status(400).json({ message: "Invalid id" });
    return null;
  }
  return new ObjectId(req.params.id);
}

// GET /api/cats
router.get("/", async (req, res) => {
  const list = await cats()
    .find({ ownerId: req.user.id })
    .sort({ createdAt: -1 })
    .toArray();
  res.json({ cats: list });
});

// POST /api/cats
router.post("/", async (req, res) => {
  const data = catSchema.parse(req.body);
  const doc = {
    ...data,
    ownerId: req.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await cats().insertOne(doc);
  res.status(201).json({ cat: { ...doc, _id: result.insertedId } });
});

// GET /api/cats/:id
router.get("/:id", async (req, res) => {
  const _id = parseId(req, res);
  if (!_id) return;
  const cat = await cats().findOne({ _id, ownerId: req.user.id });
  if (!cat) return res.status(404).json({ message: "Cat not found" });
  res.json({ cat });
});

// PUT /api/cats/:id
router.put("/:id", async (req, res) => {
  const _id = parseId(req, res);
  if (!_id) return;
  const data = catSchema.parse(req.body);

  // Khali pathale oi field mochhe jabe
  const optional = ["breed", "age", "weight", "feedingSchedule", "careInstructions", "medicalNotes", "emergencyContact", "photo"];
  const unset = Object.fromEntries(optional.filter((k) => data[k] === undefined).map((k) => [k, ""]));

  const update = { $set: { ...data, updatedAt: new Date() } };
  if (Object.keys(unset).length) update.$unset = unset;

  const result = await cats().findOneAndUpdate({ _id, ownerId: req.user.id }, update, { returnDocument: "after" });
  if (!result) return res.status(404).json({ message: "Cat not found" });
  res.json({ cat: result });
});
// DELETE /api/cats/:id
router.delete("/:id", async (req, res) => {
  const _id = parseId(req, res);
  if (!_id) return;
  const result = await cats().deleteOne({ _id, ownerId: req.user.id });
  if (!result.deletedCount)
    return res.status(404).json({ message: "Cat not found" });
  res.json({ message: "Cat deleted" });
});

export default router;