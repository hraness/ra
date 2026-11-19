// Renders the README's first picture from site/figures/flow.html, in light and dark at 2x, with ra's own browser
// launch. Run it after changing the figure: `bun run figures`, in the machine's browser lane if it has one.
// `node site/figures/render.ts <folder>` writes the pictures to that folder instead, to compare them first.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openBrowser } from "../../src/index.ts";

const repo = join(import.meta.dirname, "..", "..");
const out = process.argv[2] ?? join(repo, ".github", "media");
mkdirSync(out, { recursive: true });
const source = pathToFileURL(join(import.meta.dirname, "flow.html"));

const owned = await openBrowser({ from: repo, handleSignals: true });
console.log(`browser: Chromium ${owned.receipt.version}, playwright-core ${owned.receipt.playwright}, ${owned.receipt.executable}`);
try {
  for (const [theme, file] of [
    ["light", "ra-flow.png"],
    ["dark", "ra-flow-dark.png"],
  ] as const) {
    const context = await owned.browser.newContext({ viewport: { width: 830, height: 700 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto(`${source.href}?theme=${theme}`);
    await page.waitForLoadState("load");
    await page.evaluate(() => document.fonts.ready);
    const figure = page.locator(".flow");
    await figure.screenshot({ path: join(out, file) });
    const box = await figure.boundingBox();
    console.log(`${join(out, file)}: ${Math.round((box?.width ?? 0) * 2)}×${Math.round((box?.height ?? 0) * 2)}`);
    await context.close();
  }
} finally {
  await owned.close();
}
