// ra looks at its own site. Build it with `bun run site`, then run `node ../src/cli.ts check` in this folder.
import { defineConfig } from "../src/index.ts";
import { groups } from "./pages.ts";

const states: Record<string, string> = { home: "/" };
for (const group of groups) {
  for (const page of group.pages) states[page.slug ? `docs-${page.slug}` : "docs"] = `/docs/${page.slug ? `${page.slug}/` : ""}`;
}

export default defineConfig({
  app: { static: "dist" },
  views: ["desktop", "tablet", "phone", "phone.dark", "narrow"],
  states: {
    ...states,
    "find-the-journey-recipe": {
      url: "/docs/for-coding-agents/",
      views: ["desktop"],
      steps: async (page) => {
        const main = page.getByRole("main");
        const recipe = main.getByRole("link", { name: "Map and replay a user journey", exact: true });
        await recipe.scrollIntoViewIfNeeded();
        await main.getByText("ra map", { exact: true }).first().waitFor();
        if (process.env.RA_WALK_DIR) await page.screenshot({ path: `${process.env.RA_WALK_DIR}/01-agent-guide.png` });
        await recipe.click();
        await page.waitForURL(url => url.pathname.endsWith("/docs/recipes/") && url.hash === "#map-and-replay-a-user-journey");
        const heading = main.getByRole("heading", { name: "Map and replay a user journey", exact: true });
        await heading.scrollIntoViewIfNeeded();
        await main.getByText('"reschedule-meeting"', { exact: false }).first().waitFor();
        if (process.env.RA_WALK_DIR) await page.screenshot({ path: `${process.env.RA_WALK_DIR}/02-recipe.png` });
      },
    },
  },
});
