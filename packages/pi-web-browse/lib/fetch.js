import { parseHtmlToContent } from "./extract.js";
import { waitForBotProtectionToClear } from "./bot-protection.js";
import { dumpDebugArtifacts } from "./debug-dump.js";

export async function fetchUrlFromContext(
  context,
  url,
  truncate,
  {
    botProtectionTimeoutMs = 30000,
    debugDumpEnabled = false,
    debugDumpBaseDir = null,
  } = {},
) {
  let page;

  try {
    page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    await waitForBotProtectionToClear(page, url, { timeoutMs: botProtectionTimeoutMs });

    const html = await page.content();
    const parsed = parseHtmlToContent(html, url, truncate);

    return { url, title: parsed.title, content: parsed.content, error: null };
  } catch (err) {
    const message = err?.name === "AbortError"
      ? "Timeout after 45s"
      : (err?.cause?.message || err?.message || String(err));

    if (page && !page.isClosed()) {
      const dumpDir = await dumpDebugArtifacts(page, {
        reason: "fetch-error",
        url,
        enabled: debugDumpEnabled,
        baseDir: debugDumpBaseDir || undefined,
      });

      if (dumpDir) {
        console.error(`Debug dump saved: ${dumpDir}`);
      }
    }

    return { url, title: "", content: "", error: message };
  } finally {
    if (page && !page.isClosed()) {
      await page.close().catch(() => {});
    }
  }
}

export async function fetchUrlsFromContext(context, urls, truncate, opts = {}) {
  const results = [];
  for (const url of urls) {
    results.push(await fetchUrlFromContext(context, url, truncate, opts));
  }
  return results;
}

export async function cleanupContextPages(context, keepAlivePage = null) {
  try {
    const pages = context.pages();
    for (const p of pages) {
      if (keepAlivePage && p === keepAlivePage) continue;
      if (!p.isClosed()) await p.close().catch(() => {});
    }
  } catch {
    // ignore
  }
}
