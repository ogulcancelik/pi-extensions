import test from "node:test";
import assert from "node:assert/strict";

import { isLikelyBotProtectionText } from "../lib/bot-protection.js";

test("isLikelyBotProtectionText detects anubis marker", () => {
  const title = "Making sure you're not a bot!";
  const text = "Protected by Anubis from Techaro";
  assert.equal(isLikelyBotProtectionText(title, text), true);
});

test("isLikelyBotProtectionText is false for normal page", () => {
  const title = "Example Domain";
  const text = "This domain is for use in illustrative examples.";
  assert.equal(isLikelyBotProtectionText(title, text), false);
});
