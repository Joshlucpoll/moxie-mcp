import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUrl, base64ToBytes, buildAttachmentForm } from "../src/lib.ts";

test("buildUrl appends path and skips empty query values", () => {
  const u = buildUrl("https://x.dev/api/public/", "/action/clients/search", { query: "acme", empty: "", nope: undefined });
  assert.equal(u, "https://x.dev/api/public/action/clients/search?query=acme");
});

test("base64 round-trips to bytes", () => {
  const b64 = Buffer.from("hello").toString("base64");
  assert.deepEqual([...base64ToBytes(b64)], [...Buffer.from("hello")]);
});

test("attachment form carries fields and file bytes", async () => {
  const form = buildAttachmentForm({ type: "PROJECT", id: "P1" }, { name: "a.txt", b64: Buffer.from("hi").toString("base64") });
  assert.equal(form.get("type"), "PROJECT");
  const file = form.get("file");
  assert.equal(file.name, "a.txt");
  assert.equal(await file.text(), "hi");
});
