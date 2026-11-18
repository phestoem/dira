import { prisma } from "../../prisma.js";
import { flagOn } from "../flags.js";

// Automatic extraction (after intake, email and journal saves, vision creation, conversations) runs only while
// this is on. A graph reset turns it off and a real rebuild turns it back on. What a person states and
// confirms as a connection is saved either way.
export function graphAutoExtractEnabled(settings, envValue = process.env.GRAPH_AUTO_EXTRACT) {
  if (settings && typeof settings === "object" && !Array.isArray(settings) && typeof settings.graphAutoExtract === "boolean") {
    return settings.graphAutoExtract;
  }
  return String(envValue || "").trim().toLowerCase() === "true";
}

export async function setGraphAutoExtract(userId, enabled) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const current = user?.settings && typeof user.settings === "object" && !Array.isArray(user.settings) ? user.settings : {};
  await prisma.user.update({
    where: { id: userId },
    data: { settings: { ...current, graphAutoExtract: Boolean(enabled) } },
  });
}

// Skipped items keep graphExtractedAt = null, so the next rebuild picks them up.
// DIRA_AUTO_EXTRACT=off (the default) pauses it for every user, whatever their setting.
export async function autoExtractOn(userId, what) {
  if (!flagOn("DIRA_AUTO_EXTRACT")) {
    if (what) console.log(`[graph] auto-extract is paused (DIRA_AUTO_EXTRACT): leaving ${what} for the next rebuild`);
    return false;
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const on = graphAutoExtractEnabled(user?.settings);
  if (!on && what) console.log(`[graph] auto-extract is off: leaving ${what} for the next rebuild`);
  return on;
}
