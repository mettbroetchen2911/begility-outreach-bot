// ============================================================================
// Lead Engine — Singleton Prisma Client
//
// EVERY file imports from here. Never `new PrismaClient()` elsewhere.
// On Neon free tier you get 5 concurrent connections — one pool is mandatory.
// ============================================================================

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
