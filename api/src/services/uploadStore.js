import { mkdirSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";

// Uploaded originals are kept, not cached: a persistent folder (never /tmp, which a reboot or cleanup empties),
// folder 700, files 600. DIRA_UPLOAD_DIR overrides it (dev keeps its own folder); the default is prod's.
export const DEFAULT_UPLOAD_DIR = "/opt/qusaz/dira-data/uploads";

export function uploadDir() {
  const dir = String(process.env.DIRA_UPLOAD_DIR || "").trim() || DEFAULT_UPLOAD_DIR;
  if (!dir.startsWith("/") || /^\/tmp(\/|$)/.test(dir)) throw new Error(`DIRA_UPLOAD_DIR must be an absolute path outside /tmp (got "${dir}")`);
  return dir.replace(/\/+$/, "");
}

export function ensureUploadDir() {
  const dir = uploadDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function saveUpload(name, buffer) {
  const dir = uploadDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = `${dir}/${name}`;
  await writeFile(filePath, buffer, { mode: 0o600, flag: "wx" });
  await chmod(filePath, 0o600);
  return filePath;
}
