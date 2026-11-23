// Where the site puts each part of the README. The copy lives in README.md, docs/ and the skill; this file only
// places it. Every `##` section of the README is either a page here or listed in `skipped`, and the build stops
// on one that is neither, so renaming or adding a README heading means changing this file in the same change.

/**
 * A docs page: a README `##` section, named by its heading's anchor, or a Markdown file in the repository. A README
 * page can open with the README's definition, the paragraph under its title, or with the picture under that.
 */
export type Page = { slug: string; readme: string; opens?: "definition" | "picture"; searchTitle?: string } | { slug: string; file: string };

/** The sidebar, in reading order. Each slug is the page's address under docs/; the empty slug is docs/ itself. */
export const groups: { label: string; pages: Page[] }[] = [
  {
    label: "Overview",
    pages: [
      { slug: "", readme: "start", opens: "definition", searchTitle: "Get started with visual QA" },
      { slug: "what-it-finds", readme: "what-it-finds", searchTitle: "Responsive layout and contrast checks" },
      { slug: "how-it-works", readme: "how-it-works", opens: "picture" },
      { slug: "when-to-use-it", readme: "when-to-use-it" },
    ],
  },
  {
    label: "Guides",
    pages: [
      { slug: "setting-up", readme: "setting-up" },
      { slug: "for-coding-agents", readme: "for-coding-agents", searchTitle: "Set up visual QA for coding agents" },
      { slug: "user-journeys", readme: "replay-web-and-native-user-journeys" },
      { slug: "in-ci", readme: "in-ci", searchTitle: "UI testing in CI" },
      { slug: "recipes", file: "docs/recipes.md" },
    ],
  },
  {
    label: "Reference",
    pages: [
      { slug: "reference", readme: "reference" },
      { slug: "findings", file: "docs/findings.md" },
      { slug: "skill", file: "skills/ra/SKILL.md" },
    ],
  },
  {
    label: "Background",
    pages: [
      { slug: "how-it-compares", readme: "how-it-compares", searchTitle: "Compare visual QA and screenshot testing tools" },
      { slug: "design-decisions", readme: "design-decisions" },
      { slug: "verification", readme: "verification" },
      { slug: "from-direct", file: "docs/from-direct.md" },
    ],
  },
];

/**
 * README sections that are not pages. The documentation list names the other files, and the build takes each one's
 * title and description from it; the licence is linked from every page's footer.
 */
export const skipped = ["documentation", "licence"];

/**
 * The landing page after its first screen, in order. `whole` shows the section as it is. `intro` shows its opening
 * paragraphs, then each `###` heading with its first paragraph and the list or table that paragraph introduces.
 * `opening` shows the first paragraph. `leads` shows the opening paragraph and the bold leads from its lists.
 */
export const landing: { readme: string; show: "whole" | "intro" | "leads" | "opening" }[] = [
  { readme: "what-it-finds", show: "whole" },
  { readme: "replay-web-and-native-user-journeys", show: "intro" },
  { readme: "for-coding-agents", show: "opening" },
  { readme: "how-it-works", show: "intro" },
  { readme: "how-it-compares", show: "opening" },
  { readme: "when-to-use-it", show: "leads" },
  { readme: "start", show: "whole" },
];

/** The README section that holds the documentation list. */
export const documentation = "documentation";
