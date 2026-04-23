import { PrismaClient, Prisma } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prismaBase: PrismaClient | undefined;
  prisma: ReturnType<typeof wrap> | undefined;
};

function isTransient(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes("kind: Closed") ||
    msg.includes("Connection terminated") ||
    msg.includes("Connection refused") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("Connection pool timeout") ||
    msg.includes("Server has closed the connection")
  ) return true;
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return ["P1001", "P1002", "P1008", "P1017"].includes(err.code);
  }
  return false;
}

function wrap(base: PrismaClient) {
  return base.$extends({
    query: {
      $allOperations: async ({ model, operation, args, query }) => {
        const MAX = 3;
        let lastErr: unknown;
        for (let attempt = 1; attempt <= MAX; attempt++) {
          try {
            return await query(args);
          } catch (err) {
            lastErr = err;
            if (!isTransient(err) || attempt === MAX) throw err;
            const delay = 200 * Math.pow(2, attempt - 1);
            console.warn(
              `[prisma] Transient on ${model ?? "raw"}.${operation} ` +
              `(attempt ${attempt}/${MAX}): ${err instanceof Error ? err.message : String(err)}. ` +
              `Retrying in ${delay}ms.`
            );
            await new Promise((r) => setTimeout(r, delay));
          }
        }
        throw lastErr;
      },
    },
  });
}

const prismaBase =
  globalForPrisma.prismaBase ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["warn", "error"],
  });

export const prisma = globalForPrisma.prisma ?? wrap(prismaBase);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prismaBase = prismaBase;
  globalForPrisma.prisma = prisma;
}
