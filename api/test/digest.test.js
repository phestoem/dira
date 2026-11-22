import assert from "node:assert/strict";
import test from "node:test";
import { comingUpFrom, openPaymentsFrom, ownRecords, quietFor, quietVisions, renderDigest } from "../src/services/digestService.js";

// Synthetic records only. Coming up: open dated records in the next 30 days, days left, what is not recorded.
// Payments: open amounts due this month. Visions: nudged only after 14+ quiet days, never in days.
// Yesterday: only records saved from something the person sent.

const TODAY = { year: 2025, month: 6, day: 10, hour: 7, weekday: "Tuesday" };
const day = (iso) => new Date(`${iso}T00:00:00Z`);
const EVENT = (id, title, extra = {}) => ({ id, title, status: "active", eventType: "personal", people: [], financials: {}, createdAt: day("2025-05-01"), ...extra });

test("coming up: open dated records within 30 days, grouped by trip and project, what is not recorded said once", () => {
  const project = [{ entityId: "p1", name: "Harbour Cabins", role: "project" }];
  const events = [
    EVENT("t1", "Trip to Corrin", { occurredAt: day("2025-06-28"), endsAt: day("2025-07-05") }),
    EVENT("t2", "Flight tickets to Corrin", { occurredAt: day("2025-06-28"), financials: { amount: 400, currency: "EUR", direction: "expense" } }),
    EVENT("w1", "Cabin roof repair", { occurredAt: day("2025-07-01"), datePrecision: "month", people: project }),
    EVENT("w2", "Roof quotation from the fundi", { people: project }),
    EVENT("w3", "Cabin fence repair", { occurredAt: day("2025-07-03"), people: project }),
    EVENT("x1", "Dentist", { occurredAt: day("2025-06-11") }),
    EVENT("x2", "Done already", { occurredAt: day("2025-06-12"), status: "completed" }),
    EVENT("x3", "Too far", { occurredAt: day("2025-07-20") }),
    EVENT("x4", "In the past", { occurredAt: day("2025-06-01") }),
  ];
  const groups = comingUpFrom(events, TODAY);
  assert.deepEqual(groups.map((group) => [group.title, group.daysAway, group.items.map((item) => item.title)]), [
    ["Dentist", 1, []],
    // Within the trip's dates: the ticket and the fence (dated) come before the roof (month only); the fence joins
    // through its project too.
    ["Trip to Corrin", 18, ["Flight tickets to Corrin", "Cabin fence repair", "Cabin roof repair"]],
  ]);
  const trip = groups[1];
  assert.equal(trip.date, "28 June");
  assert.equal(trip.until, "5 July");
  assert.equal(trip.items[2].monthOnly, true);
  assert.equal(trip.items[2].date, "July 2025");
  // The ticket covers flights and budget, the end date the return; the roof quotation covers contractor and cost.
  assert.deepEqual(trip.notRecorded, ["accommodation", "local transport", "payments", "materials"]);
  assert.equal(new Set(trip.notRecorded).size, trip.notRecorded.length);
  assert.deepEqual(groups[0].notRecorded, []);
});

test("coming up: records of one project without a trip sit under the project's name", () => {
  const project = [{ entityId: "p1", name: "Harbour Cabins", role: "project" }];
  const events = [
    EVENT("w1", "Cabin roof repair", { occurredAt: day("2025-07-01"), datePrecision: "month", people: project }),
    EVENT("w3", "Cabin fence repair", { occurredAt: day("2025-06-20"), people: project }),
    EVENT("x1", "Dentist", { occurredAt: day("2025-06-11") }),
  ];
  const groups = comingUpFrom(events, TODAY);
  assert.deepEqual(groups.map((group) => [group.title, group.project, group.items.map((item) => item.title)]), [
    ["Dentist", false, []],
    ["Harbour Cabins", true, ["Cabin fence repair", "Cabin roof repair"]],
  ]);
});

test("coming up: a project's payments never count as a trip's budget", () => {
  const project = [{ entityId: "p2", name: "Quiet Harbour", role: "project" }];
  const events = [
    EVENT("t1", "Trip to Corrin", { occurredAt: day("2025-06-28"), endsAt: day("2025-07-05") }),
    EVENT("u1", "Travel and harbour update", { occurredAt: day("2025-07-01"), datePrecision: "month", people: project }),
    EVENT("u2", "Harbour deposit paid", { people: project, financials: { amount: 900, currency: "EUR", direction: "expense" } }),
  ];
  const [group] = comingUpFrom(events, TODAY);
  assert.equal(group.title, "Trip to Corrin");
  assert.ok(group.notRecorded.includes("budget"), group.notRecorded.join(", "));
});

test("open payments: amounts due this month, not paid, not income", () => {
  const money = (amount) => ({ amount, currency: "EUR", direction: "expense" });
  const events = [
    EVENT("p1", "Second instalment", { dueAt: day("2025-06-20"), financials: money(500) }),
    EVENT("p2", "Planned tank purchase", { status: "planned", occurredAt: day("2025-06-15"), financials: money(300) }),
    EVENT("p3", "Paid instalment", { dueAt: day("2025-06-05"), status: "completed", financials: money(500) }),
    EVENT("p4", "Rent received", { dueAt: day("2025-06-25"), financials: { amount: 900, currency: "EUR", direction: "income" } }),
    EVENT("p5", "Next month", { dueAt: day("2025-07-02"), financials: money(100) }),
    EVENT("p6", "A past purchase this month", { occurredAt: day("2025-06-03"), financials: money(80) }),
  ];
  assert.deepEqual(openPaymentsFrom(events, TODAY).map((item) => [item.title, item.amount, item.daysAway]), [["Planned tank purchase", "300 EUR", 5], ["Second instalment", "500 EUR", 10]]);
});

test("visions: nudged only after 14 quiet days, counting linked records, worded in weeks or months", () => {
  const now = new Date("2025-06-10T07:00:00Z");
  const visions = [
    { id: "v1", title: "Fresh", lastTouchedAt: new Date("2025-06-10T06:00:00Z"), createdAt: day("2025-01-01"), connectedEvents: [], connectedEntities: [] },
    { id: "v2", title: "Quiet", lastTouchedAt: day("2025-05-12"), createdAt: day("2025-01-01"), connectedEvents: [], connectedEntities: [] },
    { id: "v3", title: "Old touch, new record", lastTouchedAt: day("2025-03-01"), createdAt: day("2025-01-01"), connectedEvents: [], connectedEntities: [{ entityId: "p1" }] },
    { id: "v4", title: "Thirteen days", lastTouchedAt: day("2025-05-28"), createdAt: day("2025-01-01"), connectedEvents: [], connectedEntities: [] },
  ];
  const events = [EVENT("e1", "Cabin update", { people: [{ entityId: "p1", role: "project" }], createdAt: day("2025-06-08") })];
  assert.deepEqual(quietVisions(visions, events, now).map((vision) => [vision.title, vision.quietFor]), [["Quiet", "4 weeks"]]);
  assert.equal(quietFor(14), "2 weeks");
  assert.equal(quietFor(75), "2 months");
  assert.equal(quietFor(400), "over a year");
});

test("yesterday keeps only records saved from what the person sent", () => {
  const events = [EVENT("a", "Sent by them"), EVENT("b", "Written by a one-off")];
  assert.deepEqual(ownRecords(events, ["a"]).map((event) => event.title), ["Sent by them"]);
});

test("the rendered digest: coming up first, payments said even when none, never a count of days for a vision", () => {
  const html = renderDigest({
    comingUp: [{ title: "Trip to Corrin", date: "28 June", until: "5 July", daysAway: 18, monthOnly: false, project: false, items: [{ title: "Cabin roof repair", date: "July 2025", daysAway: 21, monthOnly: true }], notRecorded: ["accommodation"] }],
    openPayments: [], upcomingBirthdays: [], upcomingEvents: [], memorials: [], pendingQueue: 0,
    dormantVisions: [{ title: "Quiet", daysSinceTouch: 29, quietFor: "4 weeks" }],
    yesterday: [{ title: "Sent by them", kind: "event" }],
  }, TODAY);
  const order = ["Coming up", "Payments in June", "Visions", "Yesterday"].map((label) => html.indexOf(`>${label}<`));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), `sections out of order: ${order}`);
  assert.match(html, /Trip to Corrin: 28 June to 5 July, 18 days left/);
  assert.match(html, /· Cabin roof repair: July 2025 \(no day recorded\)/);
  assert.equal(html.match(/Not recorded yet/g).length, 1);
  assert.match(html, /Not recorded yet: accommodation/);
  assert.match(html, /No open payments on record\./);
  assert.match(html, /Nothing new on “Quiet” for 4 weeks\./);
  assert.doesNotMatch(html, /\b\d+ days\b(?! left)/);
});
