import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";

const jsdomVirtualConsole = new VirtualConsole();
jsdomVirtualConsole.on("jsdomError", (err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("Could not parse CSS stylesheet")) return;
});

export function parseHtmlToContent(html, url, truncate = true) {
  let dom;
  try {
    dom = new JSDOM(html, { url, virtualConsole: jsdomVirtualConsole });
  } catch {
    dom = new JSDOM(html, { url, runScripts: "outside-only", virtualConsole: jsdomVirtualConsole });
  }

  const document = dom.window.document;

  let article = null;
  try {
    const reader = new Readability(document.cloneNode(true));
    article = reader.parse();
  } catch {
    // Readability failed
  }

  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  let content = "";

  try {
    if (article?.content) {
      content = turndown.turndown(article.content);
    } else {
      const body = document.querySelector("body");
      if (body) content = turndown.turndown(body.innerHTML);
    }
  } catch {
    content = article?.textContent || document.body?.textContent || "";
  }

  let finalContent = content.trim();

  if (truncate && finalContent.length > 2000) {
    const cutPoint = finalContent.lastIndexOf("\n\n", 2000);
    if (cutPoint > 1000) {
      finalContent = finalContent.slice(0, cutPoint) + "\n\n[... truncated, use --full for complete content ...]";
    } else {
      finalContent = finalContent.slice(0, 2000) + "\n\n[... truncated, use --full for complete content ...]";
    }
  }

  return {
    title: article?.title || document.title || "",
    content: finalContent,
  };
}
