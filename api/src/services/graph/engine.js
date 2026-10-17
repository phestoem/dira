// PEOPLE_ENGINE=tools uses schema extraction and tool-calling answers; PEOPLE_ENGINE=hybrid keeps the rules
// extraction and lets the model pick one tool whose answer code formats; anything else keeps the rules engine.
export function peopleEngine() {
  const engine = String(process.env.PEOPLE_ENGINE || "rules").trim().toLowerCase();
  return ["tools", "hybrid"].includes(engine) ? engine : "rules";
}
