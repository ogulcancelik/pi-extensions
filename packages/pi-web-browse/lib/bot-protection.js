const DEFAULT_MARKERS = [
  "making sure you're not a bot",
  "protected by anubis",
  "anubis uses a proof-of-work",
  "checking your browser",
  "just a moment",
  "cf-browser-verification",
  "enable javascript and cookies to continue",
  "attention required",
  "verify you are human",
  "unusual traffic",
];

export function isLikelyBotProtectionText(title, text, markers = DEFAULT_MARKERS) {
  const t = String(title || "").toLowerCase();
  const body = String(text || "").slice(0, 6000).toLowerCase();
  const haystack = `${t}\n${body}`;
  return markers.some((m) => haystack.includes(m));
}

export async function isLikelyBotProtectionPage(page, markers = DEFAULT_MARKERS) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.evaluate((markersArg) => {
        const title = (document.title || "").toLowerCase();
        const text = (document.body?.innerText || "").slice(0, 6000).toLowerCase();
        const haystack = `${title}\n${text}`;
        return markersArg.some((marker) => haystack.includes(marker));
      }, markers);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Execution context was destroyed") || message.includes("Cannot find context")) {
        await page.waitForTimeout(250).catch(() => {});
        continue;
      }

      return false;
    }
  }

  return false;
}

export async function waitForBotProtectionToClear(
  page,
  url,
  {
    markers = DEFAULT_MARKERS,
    timeoutMs = 30000,
    log = (msg) => console.error(msg),
  } = {},
) {
  // Fast-path: for normal pages, do NOT wait for networkidle.
  await page.waitForTimeout(150 + Math.floor(Math.random() * 150));

  let detected = false;
  for (let i = 0; i < 3; i += 1) {
    detected = await isLikelyBotProtectionPage(page, markers);
    if (detected) break;
    await page.waitForTimeout(200);
  }

  if (!detected) return { detected: false, cleared: true, waitedMs: 0 };

  const start = Date.now();
  log(`Bot protection detected for ${url}. Waiting for it to clear...`);

  await page
    .waitForFunction(
      (markersArg) => {
        const title = (document.title || "").toLowerCase();
        const text = (document.body?.innerText || "").slice(0, 6000).toLowerCase();
        const haystack = `${title}\n${text}`;
        return !markersArg.some((marker) => haystack.includes(marker));
      },
      markers,
      { timeout: timeoutMs },
    )
    .catch(() => {});

  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(150);

  const stillBlocked = await isLikelyBotProtectionPage(page, markers);
  if (stillBlocked) {
    const title = await page.title().catch(() => "");
    throw new Error(`Bot protection challenge did not clear (title="${title}")`);
  }

  return { detected: true, cleared: true, waitedMs: Date.now() - start };
}
