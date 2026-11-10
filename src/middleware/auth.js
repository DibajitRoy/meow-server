import { createRemoteJWKSet, jwtVerify } from "jose";
import { ObjectId } from "mongodb";
import { getDb } from "../db.js";

const authUrl = process.env.AUTH_URL;
const JWKS = createRemoteJWKSet(new URL("/api/auth/jwks", authUrl));

function toIdFilter(id) {
  return ObjectId.isValid(id)
    ? { $or: [{ _id: new ObjectId(id) }, { _id: id }] }
    : { _id: id };
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: "Login required" });

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: authUrl,
      audience: process.env.AUTH_AUDIENCE || authUrl,
    });

    // Role/status DB theke fresh nichi (token e puraton thakte pare)
    const user = await getDb()
      .collection("user")
      .findOne(toIdFilter(payload.sub));

    if (!user) return res.status(401).json({ message: "User not found" });
    if (user.status === "blocked")
      return res.status(403).json({ message: "Account is blocked" });

    req.user = {
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role || "owner",
    };
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "You do not have permission" });
    }
    next();
  };
}

export { toIdFilter };
