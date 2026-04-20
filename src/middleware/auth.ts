import { Request, Response, NextFunction } from "express";

const EXEMPT_PATHS = new Set(["/health", "/api/messages"]);

if (process.env.NODE_ENV === "production" && !process.env.API_KEY) {
  throw new Error(
    "API_KEY is required in production. Refusing to start with unauthenticated endpoints.",
  );
}

export function apiKeyGuard(req: Request, res: Response, next: NextFunction): void {
  if (EXEMPT_PATHS.has(req.path)) {
    next();
    return;
  }

  const apiKey = process.env.API_KEY;
  
  if (!apiKey) {
    next();
    return;
  }

  const provided = req.headers["x-api-key"];
  if (provided === apiKey) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token === apiKey) {
      next();
      return;
    }
  }

  console.warn(`Auth rejected: ${req.method} ${req.path} from ${req.ip}`);
  res.status(401).json({ error: "Unauthorized — provide x-api-key header or Bearer token" });
}
