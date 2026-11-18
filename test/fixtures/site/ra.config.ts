import { defineConfig } from "../../../src/index.ts";

export default defineConfig({
  app: { static: "." },
  views: ["desktop", "phone", "phone.dark"],
  states: {
    home: { url: "/", note: "The control: nothing is wrong here." },
    tricky: { url: "/tricky", note: "Deliberate clipping, scrolling and hiding that must not be reported." },
    // An open modal dialog whose frame scrolls, over a dimmed and blurred page: clean too.
    dialog: { url: "/dialog", note: "A search dialog, open, with results scrolled out of its frame." },
    // Steps leave a look where they put it, unscrolled. A row under the docked bar is not covered: the list
    // can scroll it clear.
    docked: {
      url: "/docked",
      views: ["phone"],
      steps: async (page) => {
        await page.getByRole("searchbox", { name: "Search" }).waitFor();
      },
    },
    // Scripts off: the page's fallback is what is looked at, and every check still runs.
    // Text inside <noscript> is out of reach of `see`, so `expect` finds it by CSS.
    noscript: {
      url: "/noscript",
      views: ["desktop"],
      javascript: false,
      see: ["Scripts have not run."],
      expect: async (page) => {
        if (!(await page.locator("noscript p.faint").isVisible())) throw new Error("The line inside <noscript> is not showing.");
      },
    },
    // Scripts off: Chromium refuses the page's script preloads, which is not a problem.
    "tricky-without-scripts": { url: "/tricky", views: ["desktop"], javascript: false },
    // A jump leaves a link under the sticky header, and the facts above the screen where the moved skip
    // link waits: neither is a problem.
    "tricky-after-a-jump": {
      url: "/tricky",
      views: ["phone"],
      steps: async (page) => {
        await page.getByRole("link", { name: "Jump to where it lands" }).click();
      },
    },
    broken: { url: "/broken", note: "One of every problem." },
    // Controls that stay put under a bar that stays put too: a scroll never brings them clear, so they are
    // covered, whether ra scrolls the page or steps leave it where it is.
    pinned: { url: "/pinned", views: ["phone"] },
    "pinned-after-steps": {
      url: "/pinned",
      views: ["phone"],
      steps: async (page) => {
        await page.getByRole("button", { name: "Chat" }).waitFor();
      },
    },
    // A page that hides its overflow cannot be scrolled, so a button under its bar stays covered.
    "locked-after-steps": {
      url: "/locked",
      views: ["phone"],
      steps: async (page) => {
        await page.getByRole("button", { name: "Continue" }).waitFor();
      },
    },
    // A full-screen menu that scrolls: the small icons below its fold are tap targets.
    menu: { url: "/menu", views: ["phone"] },
    // Scripts off too, but here the page's own policy refuses its stylesheet, which is.
    refused: { url: "/refused", views: ["desktop"], javascript: false },
    untitled: { url: "/untitled", views: ["phone"] },
    // A strict Content-Security-Policy, which ra's own looking must not trip.
    strict: { url: "/strict", views: ["desktop"], note: "Two pale lines, one in a shadow root, on a page that allows no inline style." },
    // Plain text has no title or viewport to give, and is not faulted for it.
    plain: { url: "/gone.txt", views: ["phone"] },
    // A web page served as plain text is a finding, not a note.
    mislabeled: { url: "/mislabeled.txt", views: ["phone"] },
    // The world answers 503 on purpose: the error state is the subject, not a finding.
    outage: {
      url: "/outage",
      views: ["desktop"],
      world: { replies: { "GET /api/status": { status: 503, json: { error: "down" } } } },
      see: ["Something went wrong"],
    },
    // A reply that throws is a broken world, and is reported.
    faulty: {
      url: "/outage",
      views: ["desktop"],
      world: {
        replies: {
          "GET /api/status": () => {
            throw new Error("no answer written for this");
          },
        },
      },
    },
    // example.com is real and reachable. If the closed world leaked, this look
    // would load it; it must end in a failed load instead.
    leave: {
      url: "/leave",
      note: "A redirect to a real outside site, which must never be reached.",
      views: ["desktop"],
      world: { replies: { "GET /leave": { status: 302, headers: { location: "https://example.com/" } } } },
    },
    // The browser follows redirects by itself, so routing never sees where
    // they lead. The world still stops each hop, and ra says which rule
    // could not apply: the block holds quietly, the reply cannot answer.
    detours: {
      url: "/detours",
      views: ["desktop"],
      world: {
        replies: {
          "POST /track": { status: 307, headers: { location: "https://track.example.test/t" } },
          "GET /avatar": { status: 302, headers: { location: "https://cdn.example.test/avatar.json" } },
          "https://cdn.example.test/**": { json: {} },
        },
        block: ["track.example.test"],
      },
      see: ["Done."],
    },
  },
});
