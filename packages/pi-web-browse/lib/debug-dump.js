import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function safeSlug(input) {
  return (
    String(input)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "page"
  );
}

export async function dumpDebugArtifacts(
  page,
  {
    reason = "error",
    url = null,
    enabled = false,
    baseDir = tmpdir(),
    prefix = "web-browse-dump",
  } = {},
) {
  if (!enabled) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(baseDir, `${prefix}-${stamp}-${safeSlug(url || reason || "dump")}`);

  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }

  const meta = {
    reason,
    url,
    at: new Date().toISOString(),
  };

  try {
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  } catch {
    // ignore
  }

  try {
    const title = await page.title().catch(() => "");
    writeFileSync(join(dir, "title.txt"), title);
  } catch {
    // ignore
  }

  try {
    const html = await page.content();
    writeFileSync(join(dir, "content.html"), html);
  } catch {
    // ignore
  }

  try {
    const text = await page.evaluate(() => document.body?.innerText || "");
    writeFileSync(join(dir, "text.txt"), text);
  } catch {
    // ignore
  }

  try {
    await page.screenshot({ path: join(dir, "screenshot.png"), fullPage: true });
  } catch {
    // ignore
  }

  return dir;
}
