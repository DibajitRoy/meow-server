import "dotenv/config";
import { MongoClient } from "mongodb";

const email = process.argv[2]?.toLowerCase();
if (!email) {
  console.log("Usage: node scripts/seed-sitter.js <email>");
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.MONGODB_DB || "meow");

const user = await db.collection("user").findOne({ email });
if (!user) {
  console.log(`No user found with email ${email}. Register first.`);
  await client.close();
  process.exit(1);
}

await db.collection("user").updateOne({ _id: user._id }, { $set: { role: "sitter" } });

await db.collection("sitterProfiles").updateOne(
  { userId: String(user._id) },
  {
    $set: {
      bio: "Passionate cat lover with experience caring for cats of all ages. I provide daily play, feeding and lots of cuddles.",
      city: "Dhaka",
      address: "Dhaka, Bangladesh",
      pricePerDay: 20,
      experienceYears: 3,
      services: ["Daily Visit", "Feeding", "Playtime", "Litter Cleaning"],
      gallery: [],
      acceptingBookings: true,
      verificationStatus: "verified",
      updatedAt: new Date(),
    },
    $setOnInsert: { ratingAvg: 0, ratingCount: 0, createdAt: new Date() },
  },
  { upsert: true }
);

console.log(`Done: ${email} is now a verified sitter in Dhaka.`);
await client.close();
