import { ZodError } from "zod";

export function notFound(req, res) {
  res.status(404).json({ message: "Route not found" });
}

export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      message: "Validation failed",
      errors: err.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      })),
    });
  }
  console.error(err);
  res.status(err.status || 500).json({ message: "Something went wrong" });
}