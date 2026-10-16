import { AsyncLocalStorage } from "async_hooks";

// A request sent with X-DIRA-Readonly: 1 runs inside this store. Everything it calls,
// including setImmediate and other background work it starts, sees isReadonly() === true,
// and the Prisma client in prisma.js refuses to write while it is set.
const store = new AsyncLocalStorage();

export const READONLY_HEADER = "x-dira-readonly";

export class ReadonlyError extends Error {
  constructor(what) {
    super(`readonly request: refused to ${what}`);
    this.name = "ReadonlyError";
    this.statusCode = 409;
  }
}

export function wantsReadonly(request) {
  return String(request.headers[READONLY_HEADER] || "").trim() === "1";
}

export function runReadonly(fn) {
  return store.run({ readonly: true }, async () => await fn());
}

export function isReadonly() {
  return store.getStore()?.readonly === true;
}
