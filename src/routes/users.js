import { Router } from "express";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

const updateSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  phone: z.union([
    z.literal(""),
    z.string().trim().regex(/^\+?[0-9\s-]{7,15}$/, "Invalid phone number"),
  ]).optional(),
  image: z.union([z.literal(""), z.string().url()]).optional(),
});

const roleSchema = z.object({ role: z.enum(["owner", "sitter"]) }); // admin kokhono na

function idFilter(id) {
  return ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
}

// GET /api/users/me
router.get("/me", async (req, res) => {
  const user = await getDb().collection("user").findOne(idFilter(req.user.id));
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json({
    user: {
      id: String(user._id),
      name: user.name,
      email: user.email,
      phone: user.phone || null,
      image: user.image || null,
    },
  });
});

// PUT /api/users/me
router.put("/me", async (req, res) => {
  const data = updateSchema.parse(req.body);
  const set = { updatedAt: new Date() };
  const unset = {};
  for (const key of ["name", "phone", "image"]) {
    if (data[key] === "" && (key === "phone" || key === "image")) unset[key] = "";
    else if (data[key] !== undefined) set[key] = data[key];
  }
  const update = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;
  const result = await getDb().collection("user").updateOne(idFilter(req.user.id), update);
  if (!result.matchedCount) return res.status(404).json({ message: "User not found" });
  res.json({ message: "Profile updated" });
});

// PATCH /api/users/me/role  (Google login er por owner/sitter choose korar jonno)
router.patch("/me/role", async (req, res) => {
  if (req.user.role === "admin")
    return res.status(403).json({ message: "Admin role cannot be changed" });
  const { role } = roleSchema.parse(req.body);
  await getDb()
    .collection("user")
    .updateOne(idFilter(req.user.id), {
      $set: { role, updatedAt: new Date() },
    });
  res.json({ message: "Role updated", role });
});

export default router;
