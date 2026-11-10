import { MongoClient } from "mongodb";

let client;
let db;

export async function connectDB() {
  client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db(process.env.MONGODB_DB || "meow");

  await Promise.all([
    db.collection("cats").createIndex({ ownerId: 1 }),
    db.collection("sitterProfiles").createIndex({ userId: 1 }, { unique: true }),
    db.collection("sitterProfiles").createIndex({ verificationStatus: 1, city: 1 }),
    db.collection("bookings").createIndex({ ownerId: 1, createdAt: -1 }),
    db.collection("bookings").createIndex({ sitterId: 1, status: 1, from: 1, to: 1 }),
    db.collection("availability").createIndex({ sitterId: 1, from: 1 }),
    db.collection("reviews").createIndex({ bookingId: 1 }, { unique: true }),
    db.collection("reviews").createIndex({ sitterId: 1, createdAt: -1 }),
    db.collection("notifications").createIndex({ userId: 1, createdAt: -1 }),
  ]);

  console.log("MongoDB connected");
  return db;
}

export function getDb() {
  if (!db) throw new Error("Database not connected");
  return db;
}