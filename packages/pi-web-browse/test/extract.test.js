import test from "node:test";
import assert from "node:assert/strict";

import { parseHtmlToContent } from "../lib/extract.js";

test("parseHtmlToContent extracts title and text", () => {
  const html = `<!doctype html>
  <html><head><title>Hello</title></head>
  <body><article><h1>Hello World</h1><p>This is a test.</p></article></body></html>`;

  const out = parseHtmlToContent(html, "https://example.com", true);

  assert.ok(out.title.length > 0);
  assert.match(out.content, /Hello World/);
  assert.match(out.content, /This is a test/);
});

test("parseHtmlToContent truncates by default", () => {
  const longText = "x".repeat(4000);
  const html = `<!doctype html><html><head><title>Long</title></head><body><p>${longText}</p></body></html>`;
  const out = parseHtmlToContent(html, "https://example.com", true);
  assert.ok(out.content.length <= 2100);
  assert.match(out.content, /truncated/);
});

test("parseHtmlToContent does not truncate when truncate=false", () => {
  const longText = "x".repeat(4000);
  const html = `<!doctype html><html><head><title>Long</title></head><body><p>${longText}</p></body></html>`;
  const out = parseHtmlToContent(html, "https://example.com", false);
  assert.ok(out.content.length >= 3900);
  assert.doesNotMatch(out.content, /truncated/);
});
