import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { DEFAULT_UPLOAD_DIR, saveUpload, uploadDir } from "../src/services/uploadStore.js";

// Uploaded originals are kept in a persistent folder: never /tmp, folder 700, files 600, never overwritten.

test("upload folder: never /tmp, prod default, override for dev", async (t) => {
  const saved = process.env.DIRA_UPLOAD_DIR;
  t.after(() => (saved === undefined ? delete process.env.DIRA_UPLOAD_DIR : (process.env.DIRA_UPLOAD_DIR = saved)));
  delete process.env.DIRA_UPLOAD_DIR;
  assert.equal(uploadDir(), DEFAULT_UPLOAD_DIR);
  assert.doesNotMatch(DEFAULT_UPLOAD_DIR, /^\/tmp/);
  for (const bad of ["/tmp/dira-uploads", "/tmp", "relative/uploads"]) {
    process.env.DIRA_UPLOAD_DIR = bad;
    assert.throws(() => uploadDir(), /outside \/tmp/);
  }
  const base = mkdtempSync(resolve(process.cwd(), "../logs/upload-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  process.env.DIRA_UPLOAD_DIR = `${base}/uploads`;
  const path = await saveUpload("a.txt", Buffer.from("receipt"));
  assert.equal(path, `${base}/uploads/a.txt`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(`${base}/uploads`).mode & 0o777, 0o700);
  await assert.rejects(() => saveUpload("a.txt", Buffer.from("other")), /EEXIST/);
});
