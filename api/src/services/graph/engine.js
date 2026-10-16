// PEOPLE_ENGINE=tools uses schema extraction and tool-calling answers; anything else keeps the rules engine.
export function peopleEngine() {
  return String(process.env.PEOPLE_ENGINE || "rules").trim().toLowerCase() === "tools" ? "tools" : "rules";
}
