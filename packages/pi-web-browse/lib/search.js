import { load } from "cheerio";

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
  let page;

  try {
    page = await context.newPage();
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${clampedNum}&hl=en&gl=us&pws=0&safe=off`;

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(200 + Math.floor(Math.random() * 300));

    if (page.url().includes("consent.google.com")) {
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
          await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
          break;
        }
      }

      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(200 + Math.floor(Math.random() * 300));
    }

    await page.waitForSelector("body", { timeout: 10000 });

    try {
      await page.waitForFunction(() => document.querySelectorAll("h3").length > 0, { timeout: 10000 });
    } catch {
      // allow fallthrough
    }

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
      const diagnostics = await page.evaluate(() => ({
        title: document.title || "",
        text: document.body?.innerText?.slice(0, 500) || "",
        bodyHtmlSnippet: document.body?.innerHTML?.slice(0, 500) || "",
        hasCaptcha: Boolean(document.querySelector("#captcha-form, form[action*='sorry'], .g-recaptcha")),
        resultCount: document.querySelectorAll("h3").length,
        searchBoxCount: document.querySelectorAll("input[name='q'], textarea[name='q']").length,
      }));

      const blockedSignals = ["unusual traffic", "before you continue", "sorry", "detected", "our systems"];
      if (diagnostics.hasCaptcha || blockedSignals.some((signal) => diagnostics.text.toLowerCase().includes(signal))) {
        throw new Error(`Google blocked automated access (${diagnostics.title || page.url()})`);
      }

      console.error(
        `Google returned zero results (url=${page.url()}, title=${diagnostics.title}, results=${diagnostics.resultCount}, searchBoxes=${diagnostics.searchBoxCount})`,
      );
      console.error(`Google body snippet: ${diagnostics.bodyHtmlSnippet}`);
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

  try {
    results = await searchGoogleFromContext(context, query, numResults);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Google search failed: ${message}`);
  }

  if (results.length === 0) {
    log("Google returned no results. Falling back to DuckDuckGo...");
    try {
      results = await searchDuckDuckGo(httpFetch, headers, query, numResults);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`DuckDuckGo search failed: ${message}`);
    }
  }

  return results;
}
