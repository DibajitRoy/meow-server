import { ObjectId } from "mongodb";
import { getDb } from "../db.js";

// URL param theke ObjectId nei, invalid hole 400 pathai
export function parseObjectId(req, res, param = "id") {
  const value = req.params[param];
  if (!ObjectId.isValid(value)) {
    res.status(400).json({ message: "Invalid id" });
    return null;
  }
  return new ObjectId(value);
}

// Ekshathe onek user anar jonno (Map: id -> user)
export async function usersByIds(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const mixed = unique.flatMap((id) => (ObjectId.isValid(id) ? [new ObjectId(id), id] : [id]));
  const users = await getDb().collection("user").find({ _id: { $in: mixed } }).toArray();
  return new Map(users.map((u) => [String(u._id), u]));
}

export function publicUser(u) {
  if (!u) return null;
  return { id: String(u._id), name: u.name, image: u.image || null };
}

export function contactInfo(u) {
  if (!u) return null;
  return { phone: u.phone || null, email: u.email };
}

export function pageParams(query, defLimit = 10, max = 50) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(max, Math.max(1, parseInt(query.limit) || defLimit));
  return { page, limit, skip: (page - 1) * limit };
}

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function notify(userId, { type, title, message, link }) {
  await getDb().collection("notifications").insertOne({
    userId: String(userId),
    type,
    title,
    message,
    link: link || null,
    read: false,
    createdAt: new Date(),
  });
}

export async function notifyAdmins(payload) {
  const admins = await getDb().collection("user").find({ role: "admin" }).toArray();
  await Promise.all(admins.map((a) => notify(a._id, payload)));
}

// Review change hole sitter er average rating abar hishab kori
export async function recalcSitterRating(sitterId) {
  const [agg] = await getDb()
    .collection("reviews")
    .aggregate([
      { $match: { sitterId, status: { $ne: "hidden" } } },
      { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
    ])
    .toArray();
  await getDb()
    .collection("sitterProfiles")
    .updateOne(
      { userId: sitterId },
      { $set: { ratingAvg: agg ? Math.round(agg.avg * 10) / 10 : 0, ratingCount: agg ? agg.count : 0 } }
    );
}