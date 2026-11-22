import assert from "node:assert/strict";
import test from "node:test";
import { isPlainFeeling } from "../src/services/intentRouter.js";

// A plain first-person feeling with no fact goes to the journal, whatever the classifier says; anything carrying a
// number, money, a date, an event or a question keeps its own path.

test("plain feelings", () => {
  for (const text of ["Tonight I feel thankful for my friends.", "I feel so tired", "This morning I was really happy with the kids!", "I was sad", "Lately I'm feeling a bit lonely", "I felt proud of Wren"]) {
    assert.ok(isPlainFeeling(text), text);
  }
});

test("feelings that carry a fact, a question or news are not plain", () => {
  for (const text of [
    "I felt thankful when we bought the plot in Elmstead",
    "I feel tired, what should I focus on?",
    "I am happy to report the cabin is finished",
    "I am glad the roof is done",
    "I felt anxious about the 500 EUR payment",
    "I was happy on Friday",
    "I am Robin",
    "I was born in Corrin",
    "Feeling thankful",
    "I felt thankful for my family because the cabin sold",
  ]) {
    assert.equal(isPlainFeeling(text), false, text);
  }
});
