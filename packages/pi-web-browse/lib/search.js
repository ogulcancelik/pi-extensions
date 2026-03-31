import { load } from "cheerio";

const SEARCH_DIAG_ENABLED = ["1", "true", "yes"].includes(String(process.env.WEB_BROWSE_DEBUG_SEARCH || "").toLowerCase());
const GOOGLE_RESULTS_WAIT_MS = parseInt(process.env.WEB_BROWSE_GOOGLE_RESULTS_WAIT_MS || "4000", 10);
const DISABLE_DDG_FALLBACK = ["1", "true", "yes"].includes(
  String(process.env.WEB_BROWSE_DISABLE_DDG_FALLBACK || process.env.NO_DDG_FALLBACK || "").toLowerCase(),
);
const GOOGLE_BLOCKED_SIGNALS = [
  "unusual traffic",
  "our systems have detected unusual traffic",
  "before you continue to google search",
  "before you continue",
  "sorry",
  "detected unusual traffic",
  "not a robot",
  "verify you are human",
  "captcha",
];

function diag(message) {
  if (SEARCH_DIAG_ENABLED) console.error(`[search-diag] ${message}`);
}

function buildGoogleSearchUrl(query, num) {
  const params = new URLSearchParams({
    q: query,
    num: String(num),
  });

  const hl = process.env.WEB_BROWSE_SEARCH_HL;
  const gl = process.env.WEB_BROWSE_SEARCH_GL;
  if (hl) params.set("hl", hl);
  if (gl) params.set("gl", gl);

  return `https://www.google.com/search?${params.toString()}`;
}

async function getGoogleSearchDiagnostics(page) {
  return await page.evaluate(() => ({
    title: document.title || "",
    text: document.body?.innerText?.slice(0, 4000) || "",
    bodyHtmlSnippet: document.body?.innerHTML?.slice(0, 500) || "",
    hasCaptcha: Boolean(
      document.querySelector(
        "#captcha-form, form[action*='sorry'], .g-recaptcha, iframe[src*='recaptcha'], div[aria-label*='captcha' i]",
      ),
    ),
    resultCount: document.querySelectorAll("h3").length,
    searchBoxCount: document.querySelectorAll("input[name='q'], textarea[name='q']").length,
  }));
}

function isLikelyGoogleBlocked(diagnostics, currentUrl = "") {
  const title = String(diagnostics?.title || "").toLowerCase();
  const text = String(diagnostics?.text || "").toLowerCase();
  const url = String(currentUrl || "").toLowerCase();
  const haystack = `${title}\n${text}\n${url}`;

  return Boolean(diagnostics?.hasCaptcha) || GOOGLE_BLOCKED_SIGNALS.some((signal) => haystack.includes(signal));
}

async function handleGoogleConsentIfNeeded(page, searchUrl) {
  if (!page.url().includes("consent.google.com")) return false;

  diag("Google: consent page detected, clicking...");

  const consentButtons = [
    "button#L2AGLb",
    "button:has-text('I agree')",
    "button:has-text('Accept all')",
    "button:has-text('Accept')",
  ];

  for (const selector of consentButtons) {
    const button = page.locator(selector);
    if (await button.count()) {
      await button.first().click({ timeout: 5000, force: true });
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      break;
    }
  }

  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(200 + Math.floor(Math.random() * 300));
  return true;
}

async function waitForGoogleResultsOrBlock(page, startMs, timeoutMs = GOOGLE_RESULTS_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const diagnostics = await getGoogleSearchDiagnostics(page);

    if (isLikelyGoogleBlocked(diagnostics, page.url())) {
      diag(`Google: blocked page detected in ${Date.now() - startMs}ms`);
      throw new Error(`Google blocked automated access (${diagnostics.title || page.url()})`);
    }

    if (diagnostics.resultCount > 0) {
      diag(`Google: detected ${diagnostics.resultCount} h3 results in ${Date.now() - startMs}ms`);
      return diagnostics;
    }

    await page.waitForTimeout(250);
  }

  const diagnostics = await getGoogleSearchDiagnostics(page);
  diag(`Google: no results after ${Date.now() - startMs}ms`);
  return diagnostics;
}

export function extractDuckDuckGoResults(html, num) {
  const $ = load(html);
  const results = [];

  $(".result").each((i, el) => {
    if (results.length >= num) return false;
    const $el = $(el);
    const titleEl = $el.find(".result__a").first();
    const snippetEl = $el.find(".result__snippet").first();

    const title = titleEl.text().trim();
    const href = titleEl.attr("href");
    const snippet = snippetEl.text().trim();

    let link = href;
    if (href && href.includes("uddg=")) {
      const match = href.match(/uddg=([^&]+)/);
      if (match) link = decodeURIComponent(match[1]);
    }

    if (title && link && !link.includes("duckduckgo.com")) {
      results.push({ title, link, snippet });
    }
  });

  return results;
}

export async function searchDuckDuckGoLite(httpFetch, headers, query, num) {
  const url = `https://duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const response = await httpFetch(url, { headers });
  if (response.status === 202) throw new Error("DuckDuckGo returned 202 (blocked)");
  if (!response.ok) throw new Error(`Search failed: ${response.status} ${response.statusText}`);

  const html = await response.text();
  const $ = load(html);
  const results = [];

  $("a.result-link").each((i, el) => {
    if (results.length >= num) return false;
    const title = $(el).text().trim();
    const link = $(el).attr("href");
    const snippet = $(el).closest("tr").next("tr").find(".result-snippet").text().trim();

    if (title && link) {
      results.push({ title, link, snippet: snippet || "" });
    }
  });

  return results;
}

export async function searchDuckDuckGo(httpFetch, headers, query, num) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await httpFetch(url, { headers });
  if (response.status === 202) throw new Error("DuckDuckGo returned 202 (blocked)");
  if (!response.ok) throw new Error(`Search failed: ${response.status} ${response.statusText}`);

  const html = await response.text();
  let results = extractDuckDuckGoResults(html, num);

  if (results.length === 0) {
    results = await searchDuckDuckGoLite(httpFetch, headers, query, num);
  }

  return results;
}

export async function searchGoogleFromContext(context, query, num) {
  const clampedNum = Math.max(1, Math.min(num, 20));
  const startMs = Date.now();
  let page;

  try {
    page = await context.newPage();
    const searchUrl = buildGoogleSearchUrl(query, clampedNum);

    diag("Google: navigating to search...");
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    diag(`Google: goto done in ${Date.now() - startMs}ms`);

    await page.waitForTimeout(200 + Math.floor(Math.random() * 300));
    await handleGoogleConsentIfNeeded(page, searchUrl);
    await page.waitForSelector("body", { timeout: 10000 });
    diag(`Google: body ready in ${Date.now() - startMs}ms`);

    const diagnostics = await waitForGoogleResultsOrBlock(page, startMs);

    const extractResultsFromDocument = () => {
      const items = [];
      const titleEls = Array.from(document.querySelectorAll("h3"));

      for (const titleEl of titleEls) {
        const title = titleEl.textContent?.trim();
        const linkEl = titleEl.closest("a[href]");
        const link = linkEl?.getAttribute("href");

        if (!title || !link) continue;

        let finalLink = link;
        if (link.startsWith("/url?")) {
          try {
            const url = new URL(`https://www.google.com${link}`);
            finalLink = url.searchParams.get("q") || link;
          } catch {
            finalLink = link;
          }
        }

        if (finalLink.startsWith("/") || finalLink.includes("google.com")) continue;

        let snippet = "";
        const container =
          linkEl.closest("div.MjjYud, div.g, div[data-snf], div[data-sncf]") || linkEl.parentElement?.parentElement;

        if (container) {
          const snippetEl = container.querySelector(".VwiC3b, .yXK7lf, .lEBKkf, span.aCOpRe");
          snippet = snippetEl?.textContent?.trim() || "";

          if (!snippet) {
            const spans = Array.from(container.querySelectorAll("span"))
              .map((el) => el.textContent?.trim() || "")
              .filter((text) => text.length > 40 && text !== title);
            snippet = spans[0] || "";
          }
        }

        items.push({ title, link: finalLink, snippet });
      }

      return items;
    };

    const results = [];
    for (const frame of page.frames()) {
      try {
        const frameResults = await frame.evaluate(extractResultsFromDocument);
        results.push(...frameResults);
      } catch {
        // ignore
      }
    }

    if (results.length === 0) {
      diag(`Google: zero extractable results at ${Date.now() - startMs}ms`);
      if (isLikelyGoogleBlocked(diagnostics, page.url())) {
        throw new Error(`Google blocked automated access (${diagnostics.title || page.url()})`);
      }

      console.error(
        `Google returned zero results (url=${page.url()}, title=${diagnostics.title}, results=${diagnostics.resultCount}, searchBoxes=${diagnostics.searchBoxCount})`,
      );
      diag(`Google body snippet: ${diagnostics.bodyHtmlSnippet}`);
    } else {
      diag(`Google: extracted ${results.length} results in ${Date.now() - startMs}ms`);
    }

    return results.slice(0, clampedNum);
  } finally {
    if (page && !page.isClosed()) {
      await page.close().catch(() => {});
    }
  }
}

/**
 * Main search flow: try Google (via browser context) first, fall back to DuckDuckGo.
 */
export async function searchWebFromContext({
  context,
  httpFetch,
  headers,
  query,
  numResults,
  log = (msg) => console.error(msg),
} = {}) {
  let results = [];
  let source = "none";
  const overallStartMs = Date.now();

  try {
    diag(`Starting Google search for "${query}"...`);
    results = await searchGoogleFromContext(context, query, numResults);
    if (results.length > 0) source = "google";
    diag(`Google done: ${results.length} results in ${Date.now() - overallStartMs}ms`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diag(`Google search failed at ${Date.now() - overallStartMs}ms: ${message}`);
    log(`Google search failed: ${message}`);
  }

  if (results.length === 0) {
    if (DISABLE_DDG_FALLBACK) {
      diag("Google returned no results. DDG fallback disabled.");
    } else {
      log("Google returned no results. Falling back to DuckDuckGo...");
      const ddgStartMs = Date.now();
      try {
        results = await searchDuckDuckGo(httpFetch, headers, query, numResults);
        if (results.length > 0) source = "duckduckgo";
        diag(`DDG done: ${results.length} results in ${Date.now() - ddgStartMs}ms (total ${Date.now() - overallStartMs}ms)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        diag(`DDG failed at ${Date.now() - ddgStartMs}ms: ${message}`);
        log(`DuckDuckGo search failed: ${message}`);
      }
    }
  }

  diag(`Search complete: ${results.length} results total in ${Date.now() - overallStartMs}ms (source=${source})`);
  return { results, source };
}
