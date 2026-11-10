import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { connectDB } from "./src/db.js";
import { notFound, errorHandler } from "./src/middleware/error.js";
import usersRouter from "./src/routes/users.js";
import catsRouter from "./src/routes/cats.js";
import sittersRouter from "./src/routes/sitters.js";
import availabilityRouter from "./src/routes/availability.js";
import bookingsRouter from "./src/routes/bookings.js";
import reviewsRouter from "./src/routes/reviews.js";
import notificationsRouter from "./src/routes/notifications.js";
import dashboardRouter from "./src/routes/dashboard.js";
import adminRouter from "./src/routes/admin.js";

const app = express();

const allowedOrigins = (process.env.CLIENT_URL ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
if (allowedOrigins.length === 0) {
  throw new Error("CLIENT_URL must contain at least one allowed frontend origin");
}
if (!process.env.AUTH_URL) {
  throw new Error("AUTH_URL is required to validate Better Auth JWTs");
}

app.use(helmet());
app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 600 }));

app.get("/", (req, res) => res.json({ app: "Meow API", status: "ok" }));

app.use("/api/users", usersRouter);
app.use("/api/cats", catsRouter);
app.use("/api/sitters", sittersRouter);
app.use("/api/availability", availabilityRouter);
app.use("/api/bookings", bookingsRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/admin", adminRouter);

app.use(notFound);
app.use(errorHandler);

const port = process.env.PORT || 5000;
await connectDB();
app.listen(port, () => console.log(`Meow API running on port ${port}`));
