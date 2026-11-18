import assert from "node:assert/strict";
import test from "node:test";
import { placesIn } from "../src/services/userPlaces.js";

// Invented places: the user's own place names come from the database, never from source.
test("places a text mentions are found from the user's own place names", () => {
  const names = ["Akureyri", "Lake Myvatn", "Vik"];
  assert.deepEqual(placesIn("Paid the roofer in Lake Myvatn, then drove to akureyri.", names), ["Lake Myvatn", "Akureyri"]);
  assert.deepEqual(placesIn("Viking museum trip", names), [], "whole words only");
  assert.deepEqual(placesIn("anything", []), []);
});
