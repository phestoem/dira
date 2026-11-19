import assert from "node:assert/strict";
import test from "node:test";
import { applyCorrections } from "../src/services/contextEngine.js";
import { amountText, dateRange, joinNames, summaryLine } from "../src/services/savedSummary.js";

// The one-line read-back of a save: title, dates, people, amount.

test("summaryLine: title, date range, people and amount, leaving out what is missing", () => {
  assert.equal(
    summaryLine({ title: "Trip to Lakeview", start: "2026-12-22", end: "2027-01-05", people: ["Bo Linden"], financials: { amount: 1200, currency: "EUR" } }),
    "Trip to Lakeview, 22 Dec 2026 → 5 Jan 2027, with Bo Linden, 1,200 EUR",
  );
  assert.equal(summaryLine({ title: "Roof repair", start: new Date("2027-03-02T00:00:00Z") }), "Roof repair, 2 Mar 2027");
  assert.equal(summaryLine({ title: "Call the bank" }), "Call the bank");
  assert.equal(summaryLine({ title: "", people: [] }), "Untitled");
});

test("pieces: ranges, name lists and amounts", () => {
  assert.equal(dateRange("2027-03-10", "2027-03-10"), "10 Mar 2027");
  assert.equal(dateRange(null, "2027-03-17"), "until 17 Mar 2027");
  assert.equal(dateRange(null, null), "");
  assert.equal(joinNames(["Bo Linden", "Cy Marsh", "Bo Linden", "Dee Park"]), "Bo Linden, Cy Marsh and Dee Park");
  assert.equal(amountText({ amount: 600000, currency: "TSH" }), "600,000 TSH");
  assert.equal(amountText({ amount: 0, currency: "EUR" }), "");
  assert.equal(amountText({}), "");
});

test("an end date before the start is dropped", () => {
  assert.equal(applyCorrections({ title: "Stay", occurredAt: "2027-03-10", endDate: "2027-03-01" }, {}).endDate, null);
  assert.equal(applyCorrections({ title: "Stay", occurredAt: "2027-03-10", endDate: "2027-03-12" }, {}).endDate, "2027-03-12");
  assert.equal(applyCorrections({ title: "Stay", occurredAt: null, endDate: "2027-03-12" }, {}).endDate, "2027-03-12");
});

test("dates without a year snap to the occurrence nearest today; a stated year is kept", async () => {
  const { snapYearless } = await import("../src/services/contextEngine.js");
  const today = "2026-11-18";
  const snap = (occurredAt, endDate, text = "no year here") => {
    const out = snapYearless({ occurredAt, endDate }, text, today);
    return [out.occurredAt, out.endDate];
  };
  assert.deepEqual(snap("2026-03-04", null), ["2027-03-04", null], "4 March: next March is nearer than last");
  assert.deepEqual(snap("2023-11-03", null), ["2026-11-03", null], "3 November: two weeks ago");
  assert.deepEqual(snap("2026-12-22", "2026-01-05"), ["2026-12-22", "2027-01-05"], "the end follows the start into the next year");
  assert.deepEqual(snap("2026-10-02", "2026-10-05"), ["2026-10-02", "2026-10-05"]);
  assert.deepEqual(snap("2023-11-03", null, "Paid on 3 November 2023"), ["2023-11-03", null], "a stated year is kept");
});
