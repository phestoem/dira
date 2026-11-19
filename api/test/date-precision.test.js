import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUnderstood, snapYearless } from "../src/services/contextEngine.js";
import { whenText } from "../src/services/focus.js";
import { dateRange, formatDay, summaryLine } from "../src/services/savedSummary.js";

// "in December" is a month, not an invented day: stored as the month's first day with datePrecision "month", and
// shown and counted as a month everywhere.

test("a month without a day is kept as a month", () => {
  const month = normalizeUnderstood({ title: "Renovation", occurredAt: "2026-12", summary: "In December." });
  assert.equal(month.occurredAt, "2026-12-01");
  assert.equal(month.datePrecision, "month");
  const day = normalizeUnderstood({ title: "Trip", occurredAt: "2026-12-10", summary: "On 10 December." });
  assert.equal(day.occurredAt, "2026-12-10");
  assert.equal(day.datePrecision, null);
  assert.equal(normalizeUnderstood({ title: "x", occurredAt: "2026-13", summary: "" }).occurredAt, null);
});

test("a yearless month goes to the nearest one, still a month", () => {
  const out = snapYearless({ occurredAt: "2023-12-01", datePrecision: "month" }, "renovation in December", "2026-11-20");
  assert.equal(out.occurredAt, "2026-12-01");
  assert.equal(out.datePrecision, "month");
});

test("shown without a day; counted without inventing one", () => {
  assert.equal(formatDay("2026-12-01", "month"), "Dec 2026");
  assert.equal(formatDay("2026-12-01"), "1 Dec 2026");
  assert.equal(dateRange("2026-12-01", null, "month"), "Dec 2026");
  assert.equal(summaryLine({ title: "Renovation plans", start: "2026-12-01", precision: "month" }), "Renovation plans, Dec 2026");
  const today = new Date("2026-11-20T00:00:00Z");
  assert.equal(whenText(new Date("2026-12-01T00:00:00Z"), today, "month"), "in Dec 2026 (no day recorded)");
  assert.equal(whenText(new Date("2026-11-01T00:00:00Z"), today, "month"), "this month (no day recorded)");
  assert.equal(whenText(new Date("2026-12-10T00:00:00Z"), today), "in 20 days");
});

test("saved: month kept when the confirmed date is unchanged, a picked day is a day", async (t) => {
  const { prisma } = await import("../src/prisma.js");
  const { createEventFromUnderstanding } = await import("../src/services/contextEngine.js");
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `precision-${stamp}@example.com`, handle: `precision${stamp}`, name: "Ada Tester" } });
  t.after(async () => {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  });
  const understood = { title: "Renovation plans", summary: "Walls in December.", occurredAt: "2026-12-01", datePrecision: "month", people: [], financial: { hasFinancials: false }, confidence: 0.9 };
  const kept = await createEventFromUnderstanding(user.id, understood, null, true, null, { occurredAt: new Date("2026-12-01T00:00:00Z") });
  assert.equal(kept.datePrecision, "month");
  const picked = await createEventFromUnderstanding(user.id, { ...understood, title: "Renovation start" }, null, true, null, { occurredAt: new Date("2026-12-07T00:00:00Z") });
  assert.equal(picked.datePrecision, null);
  assert.equal(picked.occurredAt.toISOString().slice(0, 10), "2026-12-07");
});
