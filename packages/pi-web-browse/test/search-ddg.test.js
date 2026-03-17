import test from "node:test";
import assert from "node:assert/strict";

import { extractDuckDuckGoResults } from "../lib/search.js";

test("extractDuckDuckGoResults extracts title/link/snippet", () => {
  const html = `
  <div class="results">
    <div class="result">
      <a class="result__a" href="https://example.com/page">Example Title</a>
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.org%2Ffoo">Encoded Link</a>
      <a class="result__snippet">Some snippet text that is long enough.</a>
    </div>
  </div>`;

  const out = extractDuckDuckGoResults(html, 5);
  assert.ok(out.length >= 1);

  // First entry should be Example Title
  assert.equal(out[0].title, "Example Title");
  assert.equal(out[0].link, "https://example.com/page");
});
