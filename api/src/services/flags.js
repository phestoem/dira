// Feature switches for the personal scope (docs/PERSONAL_SCOPE.md section 4). A paused feature keeps its code and
// is turned back on by its flag. Values: on/true/1/yes or off/false/0/no; anything else means the default.

const DEFAULTS = {
  DIRA_BRIDGE: true, // Altimetrix bridge: events out, read-only context in
  DIRA_AUTO_EXTRACT: false, // automatic graph extraction after saves and conversations, for every user
  DIRA_GRAPH_REBUILD: false, // /graph/rebuild and the hourly catch-up
  DIRA_FACT_CHIPS: false, // fact chips under answers (home) and on the advisor page
};

export function flagOn(name, env = process.env) {
  const value = String(env[name] ?? "").trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(value)) return true;
  if (["off", "false", "0", "no"].includes(value)) return false;
  return Boolean(DEFAULTS[name]);
}

// For the startup log and /health.
export function flagStatus(env = process.env) {
  return Object.fromEntries(Object.keys(DEFAULTS).map((name) => [name, flagOn(name, env) ? "on" : "off"]));
}
