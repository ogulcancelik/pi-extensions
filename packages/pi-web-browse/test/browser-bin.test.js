import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveBrowserBin } from "../lib/browser-bin.js";

test("resolveBrowserBin uses preferredBin when executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "web-browse-bin-test-"));
  const bin = join(dir, "my-browser");

  writeFileSync(bin, "#!/usr/bin/env sh\necho ok\n");
  chmodSync(bin, 0o755);

  const resolved = resolveBrowserBin(bin, { PATH: "" });
  assert.equal(resolved, bin);
});

test("resolveBrowserBin finds binary on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "web-browse-bin-test-"));
  const bin = join(dir, "brave");

  writeFileSync(bin, "#!/usr/bin/env sh\necho ok\n");
  chmodSync(bin, 0o755);

  const resolved = resolveBrowserBin(null, { PATH: dir });
  assert.equal(resolved, bin);
});
