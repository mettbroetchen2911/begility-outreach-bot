// ============================================================================
// Lead Engine — API Key Middleware
//
// Two auth modes:
//   1. API_KEY header check — for Cloud Scheduler, manual API calls, webhooks
//   2. OIDC token check — for Cloud Scheduler (validates Google-signed JWT)
//
// Endpoints exempt from this middleware:
//   - GET /health (Cloud Run probe, must be unauthenticated)
//   - GET /tier1_approve, /tier1_reject (HMAC-secured, own auth)
// ============================================================================

import { Request, Response, NextFunction } from "express";

const EXEMPT_PATHS = new Set(["/health", "/tier1_approve", "/tier1_reject"]);

export function apiKeyGuard(req: Request, res: Response, next: NextFunction): void {
  // Allow exempt paths through without auth
  if (EXEMPT_PATHS.has(req.path)) {
    next();
    return;
  }

  const apiKey = process.env.API_KEY;

  // If no API_KEY is configured, warn but allow (dev mode)
  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      console.warn("⚠️  API_KEY not set in production — all endpoints are unprotected");
    }
    next();
    return;
  }

  // Check x-api-key header
  const provided = req.headers["x-api-key"];
  if (provided === apiKey) {
    next();
    return;
  }

  // Check Authorization: Bearer <key> (Cloud Scheduler OIDC or simple bearer)
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
