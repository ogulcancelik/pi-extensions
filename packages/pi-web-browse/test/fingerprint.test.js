import test from "node:test";
import assert from "node:assert/strict";

import { getDefaultCdpProfileDir } from "../lib/fingerprint.js";

test("getDefaultCdpProfileDir is browser-specific", () => {
  const chromeDir = getDefaultCdpProfileDir({ browserKind: "chrome" }, "/tmp/home");
  const braveDir = getDefaultCdpProfileDir({ browserKind: "brave" }, "/tmp/home");

  assert.equal(chromeDir, "/tmp/home/.config/web-browse-cdp-profile-chrome");
  assert.equal(braveDir, "/tmp/home/.config/web-browse-cdp-profile-brave");
  assert.notEqual(chromeDir, braveDir);
});
