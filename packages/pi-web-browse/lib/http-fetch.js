import { parseHtmlToContent } from "./extract.js";

/**
 * Fetch a URL via plain HTTP (no browser). Useful as a fallback when CDP is disabled.
 */
export async function fetchUrlViaHttp(httpFetch, headers, url, truncate = true) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await httpFetch(url, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      throw new Error(`Not HTML: ${contentType}`);
    }

    const html = await response.text();
    const parsed = parseHtmlToContent(html, url, truncate);

    return {
      url,
      title: parsed.title,
      content: parsed.content,
      error: null,
    };
  } catch (err) {
    clearTimeout(timeout);
    const message = err?.name === "AbortError" ? "Timeout after 15s" : (err?.cause?.message || err?.message || String(err));
    return { url, title: "", content: "", error: message };
  }
}
