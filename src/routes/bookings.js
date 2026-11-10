import { Router } from "express";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { getDb } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { dateStr, todayStr, nightsBetween } from "../utils/dates.js";
import { usersByIds, publicUser, contactInfo, pageParams, notify, parseObjectId } from "../utils/helpers.js";

const router = Router();
router.use(requireAuth);

const SERVICE_FEE = Number(process.env.SERVICE_FEE ?? 5);
const STATUSES = ["pending", "accepted", "rejected", "completed", "cancelled"];
const round2 = (n) => Math.round(n * 100) / 100;

const bookings = () => getDb().collection("bookings");

const createSchema = z.object({
  sitterId: z.string().min(1),
  catId: z.string().min(1),
  serviceType: z.string().trim().min(1).max(40).optional(),
  from: dateStr,
  to: dateStr,
  note: z.string().trim().max(500).optional(),
});

// Kon role kon status theke kon status e jete pare
const RULES = {
  sitter: { pending: ["accepted", "rejected"], accepted: ["completed", "cancelled"] },
  owner: { pending: ["cancelled"], accepted: ["cancelled"] },
  admin: { pending: ["cancelled"], accepted: ["cancelled"] },
};

async function findConflict({ sitterId, from, to, excludeId }) {
  const db = getDb();
  const blocked = await db.collection("availability").findOne({
    sitterId,
    from: { $lt: to },
    to: { $gte: from },
  });
  if (blocked) return "The sitter is not available on these dates";

  const query = { sitterId, status: "accepted", from: { $lt: to }, to: { $gt: from } };
  if (excludeId) query._id = { $ne: excludeId };
  const booked = await bookings().findOne(query);
  if (booked) return "The sitter already has a booking on these dates";
  return null;
}

// Serialize acceptance for one sitter across API instances. The short lease
// expires automatically if a process dies while holding it.
async function withSitterBookingLock(sitterId, operation) {
  const locks = getDb().collection("bookingLocks");
  const token = new ObjectId().toHexString();
  const now = new Date();
  let lock;
  try {
    lock = await locks.findOneAndUpdate(
      { _id: sitterId, $or: [{ expiresAt: { $lt: now } }, { expiresAt: { $exists: false } }] },
      { $set: { token, expiresAt: new Date(now.getTime() + 2 * 60 * 1000) } },
      { upsert: true, returnDocument: "after" }
    );
  } catch (err) {
    if (err.code === 11000) return null; // Another request owns the sitter lock.
    throw err;
  }
  if (!lock || lock.token !== token) return null;
  try {
    return await operation();
  } finally {
    await locks.deleteOne({ _id: sitterId, token });
  }
}

// ---------- Create ----------
router.post("/", requireRole("owner"), async (req, res) => {
  const data = createSchema.parse(req.body);
  const db = getDb();

  if (data.from < todayStr()) return res.status(400).json({ message: "Start date cannot be in the past" });
  const nights = nightsBetween(data.from, data.to);
  if (nights < 1) return res.status(400).json({ message: "End date must be after start date" });
  if (nights > 60) return res.status(400).json({ message: "Maximum booking length is 60 days" });
  if (!ObjectId.isValid(data.catId)) return res.status(400).json({ message: "Invalid cat" });

  const cat = await db.collection("cats").findOne({ _id: new ObjectId(data.catId), ownerId: req.user.id });
  if (!cat) return res.status(404).json({ message: "Cat not found" });

  const profile = await db.collection("sitterProfiles").findOne({
    userId: data.sitterId,
    verificationStatus: "verified",
    acceptingBookings: true,
  });
  if (!profile) return res.status(404).json({ message: "Sitter is not available for booking" });

  const serviceType = data.serviceType || profile.services?.[0] || "Cat sitting";
  if (profile.services?.length && !profile.services.some((service) => service.toLowerCase() === serviceType.toLowerCase())) {
    return res.status(400).json({ message: "Choose a service offered by this sitter" });
  }

  const conflict = await findConflict({ sitterId: data.sitterId, from: data.from, to: data.to });
  if (conflict) return res.status(409).json({ message: conflict });

  const catBusy = await bookings().findOne({
    catId: data.catId,
    status: { $in: ["pending", "accepted"] },
    from: { $lt: data.to },
    to: { $gt: data.from },
  });
  if (catBusy) return res.status(409).json({ message: "This cat already has a booking on these dates" });

  const subtotal = round2(profile.pricePerDay * nights);
  const doc = {
    ownerId: req.user.id,
    sitterId: data.sitterId,
    catId: data.catId,
    serviceType,
    cat: {
      name: cat.name,
      breed: cat.breed || null,
      age: cat.age ?? null,
      photo: cat.photo || null,
      feedingSchedule: cat.feedingSchedule || null,
      careInstructions: cat.careInstructions || null,
      medicalNotes: cat.medicalNotes || null,
      emergencyContact: cat.emergencyContact || null,
    },
    from: data.from,
    to: data.to,
    nights,
    pricePerDay: profile.pricePerDay,
    subtotal,
    serviceFee: SERVICE_FEE,
    total: round2(subtotal + SERVICE_FEE),
    note: data.note || null,
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await bookings().insertOne(doc);

  await notify(data.sitterId, {
    type: "booking_request",
    title: "New booking request",
    message: `${req.user.name} wants to book you for ${cat.name} (${data.from} to ${data.to}).`,
    link: "/dashboard/sitter/requests",
  });

  res.status(201).json({ booking: { ...doc, _id: result.insertedId } });
});

// ---------- List ----------
router.get("/", async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const filter = {};
  if (req.user.role === "owner") filter.ownerId = req.user.id;
  else if (req.user.role === "sitter") filter.sitterId = req.user.id;
  if (STATUSES.includes(req.query.status)) filter.status = req.query.status;

  const [items, total] = await Promise.all([
    bookings().find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    bookings().countDocuments(filter),
  ]);
  const users = await usersByIds(items.flatMap((b) => [b.ownerId, b.sitterId]));

  res.json({
    bookings: items.map((b) => ({
      ...b,
      owner: publicUser(users.get(b.ownerId)),
      sitter: publicUser(users.get(b.sitterId)),
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

// ---------- Details ----------
router.get("/:id", async (req, res) => {
  const _id = parseObjectId(req, res);
  if (!_id) return;
  const b = await bookings().findOne({ _id });
  const allowed =
    b && (req.user.role === "admin" || b.ownerId === req.user.id || b.sitterId === req.user.id);
  if (!allowed) return res.status(404).json({ message: "Booking not found" });

  const users = await usersByIds([b.ownerId, b.sitterId]);
  const ownerU = users.get(b.ownerId);
  const sitterU = users.get(b.sitterId);
  const showContact = ["accepted", "completed"].includes(b.status);
  const review = await getDb().collection("reviews").findOne({ bookingId: String(b._id) });

  res.json({
    booking: {
      ...b,
      owner: { ...publicUser(ownerU), ...(showContact ? contactInfo(ownerU) : {}) },
      sitter: { ...publicUser(sitterU), ...(showContact ? contactInfo(sitterU) : {}) },
      reviewed: !!review,
    },
  });
});

// ---------- Status change ----------
router.patch("/:id/status", async (req, res) => {
  const _id = parseObjectId(req, res);
  if (!_id) return;
  const { status } = z.object({ status: z.enum(["accepted", "rejected", "completed", "cancelled"]) }).parse(req.body);

  const b = await bookings().findOne({ _id });
  const involved =
    b && (req.user.role === "admin" || b.ownerId === req.user.id || b.sitterId === req.user.id);
  if (!involved) return res.status(404).json({ message: "Booking not found" });

  const allowedNext = RULES[req.user.role]?.[b.status] ?? [];
  if (!allowedNext.includes(status)) {
    return res.status(400).json({ message: `You cannot change a ${b.status} booking to ${status}` });
  }

  if (status === "completed" && todayStr() < b.from) {
    return res.status(400).json({ message: "You can complete a booking only after it has started" });
  }

  let updated;
  if (status === "accepted") {
    updated = await withSitterBookingLock(b.sitterId, async () => {
      const current = await bookings().findOne({ _id, status: "pending" });
      if (!current) return null;
      const conflict = await findConflict({ sitterId: current.sitterId, from: current.from, to: current.to, excludeId: current._id });
      if (conflict) return { conflict };
      return bookings().findOneAndUpdate(
        { _id: current._id, status: "pending" },
        { $set: { status, updatedAt: new Date(), acceptedAt: new Date() } },
        { returnDocument: "after" }
      );
    });
    if (updated?.conflict) return res.status(409).json({ message: updated.conflict });
    if (!updated) return res.status(409).json({ message: "Another booking action is in progress. Refresh and try again." });
  } else {
    updated = await bookings().findOneAndUpdate(
      { _id, status: b.status },
      { $set: { status, updatedAt: new Date(), [`${status}At`]: new Date() } },
      { returnDocument: "after" }
    );
    if (!updated) return res.status(409).json({ message: "The booking changed. Refresh and try again." });
  }

  // Onno pokkhoke notification
  const toOwner = req.user.role !== "owner";
  const target = toOwner ? b.ownerId : b.sitterId;
  const messages = {
    accepted: ["Booking accepted", `Your booking for ${b.cat.name} was accepted.`],
    rejected: ["Booking rejected", `Your booking request for ${b.cat.name} was declined.`],
    completed: ["Booking completed", `The stay for ${b.cat.name} is complete. Please leave a review.`],
    cancelled: ["Booking cancelled", `A booking for ${b.cat.name} (${b.from} to ${b.to}) was cancelled.`],
  };
  await notify(target, {
    type: `booking_${status}`,
    title: messages[status][0],
    message: messages[status][1],
    link: toOwner ? `/dashboard/owner/bookings/${b._id}` : "/dashboard/sitter/bookings",
  });
  if (req.user.role === "admin") {
    const other = toOwner ? b.sitterId : b.ownerId;
    await notify(other, { type: "booking_cancelled", title: messages.cancelled[0], message: messages.cancelled[1] });
  }

  res.json({ booking: updated });
});

export default router;
