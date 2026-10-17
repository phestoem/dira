// Switches for the knowledge layer. KNOWLEDGE_LAYER=claims sends chat input through ingest() and the claim store;
// anything else keeps the old paths. Models are settings so cost and quality can be traded without code changes.

export function claimsLayerOn() {
  return String(process.env.KNOWLEDGE_LAYER || "").trim().toLowerCase() === "claims";
}

export function routerModel() {
  return String(process.env.KNOWLEDGE_ROUTER_MODEL || "").trim() || "gpt-4o-mini";
}

export function extractModel() {
  return String(process.env.KNOWLEDGE_EXTRACT_MODEL || "").trim() || "gpt-5.5";
}
