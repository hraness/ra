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
  states,
});
