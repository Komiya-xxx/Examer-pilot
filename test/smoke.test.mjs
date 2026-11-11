import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("builds a Chinese static home page", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");

  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<title>法医病理学<\/title>/);
  assert.match(html, /<h1>法医病理学<\/h1>/);
});
