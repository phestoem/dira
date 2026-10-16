import { PrismaClient } from "@prisma/client";
import { isReadonly, ReadonlyError } from "./readonly.js";

const globalForPrisma = globalThis;
const WRITES = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "$executeRaw",
  "$executeRawUnsafe",
]);

const base =
  globalForPrisma.prismaBase ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

// Backstop for X-DIRA-Readonly: any write that a readonly request reaches, directly or from
// background work it started, fails here instead of touching the database.
export const prisma = base.$extends({
  query: {
    async $allOperations({ model, operation, args, query }) {
      if (isReadonly() && WRITES.has(operation)) {
        throw new ReadonlyError(`${operation} ${model || "raw"}`);
      }
      return query(args);
    },
  },
});

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prismaBase = base;
}
