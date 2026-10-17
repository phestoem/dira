// PEOPLE_ENGINE=tools uses schema extraction and tool-calling answers; PEOPLE_ENGINE=hybrid keeps the rules
// extraction and lets the model pick one tool whose answer code formats; anything else keeps the rules engine.
export function peopleEngine() {
  const engine = String(process.env.PEOPLE_ENGINE || "rules").trim().toLowerCase();
  return ["tools", "hybrid"].includes(engine) ? engine : "rules";
}

// PEOPLE_EXTRACTOR=rules|schema picks the people pass on its own (e.g. rules extraction with tools answering);
// unset, it follows the engine: schema for tools, rules otherwise.
export function peopleExtractor() {
  const extractor = String(process.env.PEOPLE_EXTRACTOR || "").trim().toLowerCase();
  if (["rules", "schema"].includes(extractor)) return extractor;
  return peopleEngine() === "tools" ? "schema" : "rules";
}
