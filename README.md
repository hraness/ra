# ra

**UI testing for coding agents.** A real browser, a fake world, and what is wrong in plain words.

[![Release](https://img.shields.io/github/v/release/hraness/ra?label=release)](https://github.com/hraness/ra/releases/latest)
[![CI](https://github.com/hraness/ra/actions/workflows/ci.yml/badge.svg)](https://github.com/hraness/ra/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

ra opens your web app in Playwright's Chromium, inside a world you describe: fake API replies, blocked hosts and stand-ins for the services your server calls. It looks at each state you name, such as an empty inbox, a failed payment or a name 80 characters long, on desktop, phone and dark mode. Then it prints what a person would run into, one sentence per problem, naming the element and, where it can, saying by how much.

No screenshot baselines, no live services, no model judging pixels.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/media/ra-look-dark.png">
  <img src=".github/media/ra-look.png" width="830" alt="A phone screenshot of ra's broken fixture page with seven numbered problems, beside the sentences ra printed for them: the page scrolls sideways by 531px, a button's label is cut off by 84px, a long word runs 119px past its box, two lines are drawn over each other, a Pay now button is covered by another element, two tap targets are 18 by 18 pixels, and grey text has 1.9:1 contrast.">
</picture>

That is `ra look broken --at phone` on [a fixture page](test/fixtures/site/broken.html) full of planted problems. Its twin, [`tricky.html`](test/fixtures/site/tricky.html), is full of things that only look wrong, and ra must print nothing for it.

## Start

```sh
npm install -D https://github.com/hraness/ra/releases/download/v0.1.5/hraness-ra-0.1.5.tgz playwright-core
npx playwright-core install chromium
npx ra look http://127.0.0.1:3000/ --at phone
```

ra needs Node 22.18 or later. If your project already has `playwright` or `@playwright/test`, leave `playwright-core` out and install the browser with `npx playwright install chromium`. That first look needs no config. To check every screen at once, [name your states](#setting-up) and run `ra check`.

## For agents

ra is made to be run by a coding agent in the middle of a change. [`skills/ra/SKILL.md`](skills/ra/SKILL.md) teaches the agent when to reach for ra and how to read what it prints. It ships in the package; copy it to where your agent reads skills:

```sh
mkdir -p .claude/skills && cp -R node_modules/@hraness/ra/skills/ra .claude/skills/
```

The loop:

1. Run `ra look <state> --at phone`, read the findings and the outline, and fix what is wrong.
2. Run `ra look` again to confirm. Run `ra check` before handing off.
3. For a change with a wide reach, run `ra snap` first and `ra diff` afterwards.
4. Open a picture only when the words leave a doubt, such as how a gradient looks. Every look writes `.ra/look/<state>.<view>.png` (the first screen) and `.full.png` (the whole page).

A look is short, and it is text the agent can act on. On ra's fixture site, a page with nothing wrong prints 52 lines, about 500 tokens: "no findings", an outline whose lines map onto `getByRole`, a sketch of the layout, and where the pictures are. The broken page at phone prints 123 lines, about 1,900 tokens, for 37 findings.

<details>
<summary>A look at a page with nothing wrong, trimmed</summary>

```
$ npx ra look home --at desktop
home at desktop (1440×900)
http://127.0.0.1:57437/ — 200 — "Fixture — Home"
page 1440×1237, 3 requests, 1.1s

no findings

outline
  banner
    link "Fixture" → /
    navigation "Main"
      link "Tricky" → /tricky
      link "Broken" → /broken
      link "App" → /app
  main
    heading "A page with nothing wrong" [level=1]
    paragraph: This page is the control. Whatever ra reports here is a false alarm, at any width and in either colour scheme.
    link "Open the app" → /app
    …
    heading "A form" [level=2]
    textbox "Email"
    checkbox "Send me news"
    button "Sign up"
  contentinfo
    …

layout
  header.top                        1440×65 at 0,0  sticky, 3 items in nav, 3 across
    nav "Main"                      192×40 at 1228,12  3 items, 3 across
  main "A page with nothing wrong"  960×1027 at 240,65  3 items in ul.cards, 3 across
    form                            920×176 at 260,836  3 items stacked
  footer                            1440×145 at 0,1092  3 items in nav, 3 across
    nav "Footer"                    1400×40 at 20,1117  3 items, 3 across

pictures: .ra/look/home.desktop.png (first screen), .ra/look/home.desktop.full.png (whole page)
```

</details>

## Why not just a screenshot?

An agent that wants to know whether its UI change worked has three easy options, and each misses something.

**A screenshot for the model to judge.** Models are weakest at the measurements that layout bugs come down to. In [UI-Lens](https://cvpr.thecvf.com/virtual/2026/poster/38861) (CVPR 2026), ten multimodal models looked for defects on 4,759 Chinese-language pages annotated by design experts. Their task-average F1 was 20.36% for text overflow and 31.21% for container overlap, and on tasks that need fine-grained element boundaries the authors found performance "near random". A screenshot also shows only what fits in it: a picture of the screen crops whatever makes the page scroll sideways, and a picture of a long page is scaled down before the model sees it. ra measures instead. Boxes come from the layout engine, and contrast comes from the painted pixels, read with the text shown and with it hidden.

**A Playwright script against the real network.** Browser tests flake far more than most tests. At Google, 1.65% of all tests were flaky, against 10.45% of Java WebDriver tests and 18.72% of Python ones ([Google Testing Blog, 2017](https://testing.googleblog.com/2017/04/where-do-our-flaky-tests-come-from.html)). A 2025 study found that "75% of flaky tests across all projects belong to a cluster" of tests that fail together, with "intermittent networking issues and instabilities in external dependencies as the predominant causes of systemic flakiness" ([Parry et al.](https://arxiv.org/abs/2504.16777)). Playwright's own advice is "Only test what you control" and to "use the Playwright Network API and guarantee the response needed" ([best practices](https://playwright.dev/docs/best-practices)). ra does that for every state, with no test code. Its world is fake by default, and a request that nothing in it answers is stopped and reported, not sent.

**An accessibility snapshot.** A tree of roles and names is text a model can read, but it has no colour, no geometry and no stacking order, so it cannot show low contrast, overlap, clipping or a covered button. [Playwright's MCP docs](https://playwright.dev/mcp/snapshots) suggest adding screenshots where layout matters, and describe acting on screenshots as "Approximate — requires coordinate guessing". ra prints the same kind of outline and puts measured findings beside it.

| | Screenshot to a model | Script against the network | Accessibility snapshot | ra |
| --- | --- | --- | --- | --- |
| Who decides what is wrong | The model, by eye | Your assertions | The model, from text | Measurements |
| Contrast, overlap, clipping, covering | Often misjudged | Only what you assert | Not in the tree | Measured and reported |
| Live services in the loop | Unless you mock them | Unless you mock them | Unless you mock them | Never; a request nothing answers is reported |
| Empty, failing and overflowing states | Reached by hand | Mocks you write | Reached by hand | Named once in a config |

## On real sites

So far ra runs on its author's own sites: nine of them, including docs and marketing sites, a payment form, a mockup editor and a phone-first web app. One full run of all nine is about 200 states and 700 looks, at about 1–3 seconds a look in CI.

In its first two days on those sites, ra's findings led to 22 fixes. 19 came from its built-in checks: 7 contrast, 6 cut-off, spill or sideways scroll, 3 small tap targets, a failed request, a console error and a covered control. Some of them:

- **Sideways scroll that a screenshot crops away.** An email field kept its default width. With the button beside it, a hero scrolled sideways at 320–374px, and up to 390px in Spanish.
- **A link cut off on every page.** At 320px, a docs site's header cut its Install link off by 40px. At 390px the page was 410px wide.
- **One colour, 106 findings.** A faint text colour, used for rows, headings and a caption, measured 3.2–3.4:1 in light mode and 4.0–4.2:1 in dark. One token change, to 5.1:1 and 6.4:1, fixed every place it appeared.
- **Only in production.** A 404 page's links went through the app's router. Production answered the router's prefetch with 500 and 404, and the local server did not. `ra check --url` against the deployment, still in a closed world, caught it.
- **Hidden but reachable.** ra reported controls under a list panel as covered. Tab and screen readers could still reach them, until the part underneath was made `inert`.

The same sites deleted at least 1,772 lines of hand-written browser scripts in favour of ra states. Three of those scripts had never run in CI.

A false alarm counts as a bug in ra. Real pages turned up 23 patterns that ra misjudged in its first two days. Each is fixed in 0.1.1–0.1.5 and reproduced in ra's tests.

## When it is worth it

Browser checks are slow, flaky when written carelessly, and easy to write in ways that prove nothing. ra is only worth running when the answer depends on what a browser actually paints.

**Use ra when:**

- **The question is "what does a person see here?"** For example: does this fit at 320px, does dark mode keep the text readable, is anything covering the button, does the long name spill out of its card. Only the layout engine knows, with real fonts, the real cascade and real widths.
- **The state is expensive to reach by hand.** Examples are an empty inbox, a failed payment, a 3,000-row table, an upstream returning 500, a name 80 characters long, or a clock just before midnight. You name each one once as a URL plus a fake world, and from then on one command reaches it.
- **A change has a visual blast radius.** Examples are a CSS refactor, a design-token change or a dependency bump. Run `ra snap`, make the change, then run `ra diff`. It tells you which elements moved, resized, appeared or vanished, which outline lines changed, and which findings are new.
- **An agent is changing UI.** It works from text it can act on, and opens a picture only when the text is not enough.

**Do not use ra for:**

- **Logic.** If it can be tested without a browser, test it without one.
- **Restating the implementation.** Asserting `toHaveCSS("color", "rgb(…)")` or a class name proves that you wrote what you wrote. ra asks what a person would ask instead: can this be read, can it be reached, does it fit.
- **Proving a live system works.** ra closes the world on purpose. Smoke tests and monitoring against real services do that job. `ra check --url https://…` against a deployment checks what the deployment *shows*, and the outside world stays closed even then.
- **Pixel baselines in CI, or coverage ledgers.** Baselines drift with fonts and anti-aliasing, and people re-approve them without looking. Snapshots in ra live on your machine for the length of one change. CI runs `ra check`, which has no baselines.
- **Cross-browser matrices.** ra drives Chromium only. Use Playwright Test when WebKit- or Firefox-specific behaviour matters.
- **A full accessibility audit.** ra reports what a person would trip over: unnamed controls, missing alt text, low painted contrast and small tap targets. Run axe or a manual audit for the rest.

## Limits

- Chromium only, and not a full accessibility audit; see [when it is worth it](#when-it-is-worth-it).
- It runs on macOS and Linux.
- Placeholder text is not checked for contrast yet.
- Pictures and contrast cover at most the first 12,000px of a page. ra says so when a page is taller.
- When a page scrolls inside an element rather than as a whole, its pictures show that element's first screen, and ra says so.
- ra is new and has one maintainer. So far it runs only on its author's own sites.

## Rules

1. **Real app, real browser, fake world.** ra serves or starts your actual app and drives a real Chromium. Only what lies *outside* the app is fake.
2. **A state is a URL into a world.** A state is an address plus the answers the outside world gives: a path, its fake API replies, storage, cookies, a clock, and optional steps. It needs no fixtures database or test build.
3. **Looking costs text, not pixels.** Every look prints:
   - an accessibility outline whose lines map onto `getByRole`
   - a layout sketch
   - findings as sentences, each naming the element
   - picture paths, which are there for when the text is not enough
4. **The world is closed.** Every request that leaves the app is replied to, blocked by name, allowed by name, or stopped and reported. Routing judges each request the page makes. Beneath it, the browser sends everything but the app and the allowed hosts to a proxy that refuses it, so the redirect hops, IP addresses and WebRTC traffic that routing never sees are stopped too. This holds against deployments, and `ra doctor` tries it in your browser.
5. **One browser, launched one way, with a receipt.** ra runs the Chromium that your project's pinned Playwright provisioned. It refuses an installed, auto-updating Google Chrome. It launches with one merged `--disable-features` switch and audio muted, reads the running browser's command line back over CDP to prove it, and prints the result as a receipt.
6. **Nothing runs inside your app.** There is no SDK, bridge, test build or port to implement. If your app runs, ra can look at it.
7. **Pixel baselines are ephemeral.** `ra snap` and `ra diff` keep their files in `.ra/`, which ignores itself in git. Nothing ra writes is meant to be committed.

## Setting up

ra needs Node 22.18 or later and a Playwright in your project: `playwright-core`, `playwright` or `@playwright/test`. With Bun, install it like this:

```sh
bun add -d https://github.com/hraness/ra/releases/download/v0.1.5/hraness-ra-0.1.5.tgz playwright-core
bunx --no-install playwright-core install chromium
```

To upgrade, give the new release's address the same way. npm replaces the old one: `npm install -D <new address>`. Bun stops with `DependencyLoop` while its lockfile names the old address, so remove ra and add it again (`bun remove @hraness/ra`, then `bun add -d <new address>`), or change the address in `package.json` and run `bun install`.

`ra look` also takes the address of a deployment:

```sh
npx ra look https://example.com/pricing --at phone.dark
```

To name states, add `ra.config.ts` at the project root:

```ts
import { defineConfig } from "@hraness/ra";

export default defineConfig({
  app: { command: "bun run dev --port {port}" },
  views: ["desktop", "phone", "phone.dark"],
  world: {
    allow: ["fonts.googleapis.com", "fonts.gstatic.com"],
    block: ["*.posthog.com"],
    replies: { "GET /api/me": { json: { name: "Ada" } } },
  },
  states: {
    home: "/",
    pricing: "/pricing",
    "inbox-empty": { url: "/inbox", world: { replies: { "GET /api/messages": { json: [] } } } },
    "inbox-down": {
      url: "/inbox",
      world: { replies: { "GET /api/messages": { status: 500, json: { error: "down" } } } },
      see: ["Something went wrong"],
    },
    "long-name": {
      url: "/settings",
      world: { replies: { "GET /api/me": { json: { name: "Wolfeschlegelsteinhausenbergerdorff" } } } },
    },
  },
});
```

Then:

```sh
npx ra states                     # what this project names
npx ra look inbox-empty --at phone
npx ra check                      # every state through every view; exits 1 on findings
npx ra snap && $EDITOR app.css && npx ra diff
```

Node strips the types from `ra.config.ts`, so relative imports in it need their `.ts` extension, and it cannot use path aliases.

## Commands

| Command | What it does |
| --- | --- |
| `ra look <state \| /path \| address>` | Looks at one state through its first view, or the views given with `--at`. Prints the outline, the layout, the findings and where the pictures are. `--in "<selector>"` narrows it to part of the page. `--then "<code>"` runs Playwright code first, with `page` in scope, and prints what it returns; `@file.js` reads that code from a file. `--full` prints the whole outline. |
| `ra check [state…]` | Looks at every state through every view. Each finding is listed once, with the views it shows at. Exits 1 when anything is wrong. |
| `ra snap [state…]` | Keeps how the states look now. |
| `ra diff [state…]` | Says what changed since the snapshot, in words, and writes a copy of each changed picture with the changes framed. |
| `ra states` | Lists the states this project names. |
| `ra doctor` | Shows which browser ra runs, starts it, and tries the closed world in it. |

These options work with every command: `--url <origin>` uses an app that is already running, or a deployment. `--allow <host>` lets the page reach that host during this run. `--json` prints data instead of text. `--config <file>` and `--jobs <n>` do what they say.

Exit codes: `0` fine; `1` `ra check` found something; `2` the command or the config is wrong; `3` the app or the browser could not run. On Ctrl-C, ra closes the browser and stops the app, then exits with `130` (`143` for SIGTERM).

## Config

**`app`** says how to reach the app. It takes one of three forms:

- `{ command, ready?, env?, timeout? }` runs a shell command. `{port}` in the command is replaced with a free port, which is also set as `PORT`.
- `{ static: "dist" }` serves built files. It understands clean URLs and serves a 404 page if there is one.
- `{ url }` points at an app that is already running.

With `command`, the app runs in its own process group under a small keeper process. The keeper ends the whole group, background jobs included, when ra finishes, when ra is interrupted, and even when ra is killed outright.

**`views`** lists what to look through:

- The built-in views are `desktop` (1440×900), `tablet` (820×1180, touch), `phone` (390×844, touch) and `narrow` (320×640, touch).
- A size such as `1024x768` also works.
- Any of these can be followed by `.dark`, `.light`, `.touch` or `.motion` (which leaves animations running).
- Custom views are `{ name, width, height, touch?, scale? }`.
- The default is `["desktop", "phone"]`.

**`world`** says what everything outside the app answers. Set it for the whole project and lay more over it for each state:

- **`replies`**: rules mapped to answers. A rule can be:
  - a path on the app: `"/api/items"`
  - a method and a path: `"POST /api/items"`
  - a full address: `"https://api.example.com/v1/**"`
  - a host: `"*.example.com"`

  `*` matches within one path segment and `**` matches across segments. The most literal matching rule wins. An answer is `{ status?, json?, body?, type?, headers? }`, where `body` is text or bytes, or a function of the request that returns one. ra checks every rule and every fixed answer when it reads the config, and says how to write one it cannot use. An answer that a function returns is checked when it is returned.
- **`block`**: hosts or addresses to drop quietly, such as analytics.
- **`allow`**: outside hosts the page may really reach, such as a font CDN.
- **`upstreams`**: stand-in servers for what the app's *server* calls. Each name gets a loopback address, passed to `app.command` and `app.env` as `{upstream.NAME}`. Point your server's API base URL at it.

ra decides what happens to each request in this order: a reply, then a block, then the app itself, then an allow. Anything else is stopped and reported as an `outside` finding.

The browser follows a redirect by itself, so routing sees only the first request. A reply cannot answer where a redirect leads: give the reply to the address that redirects. ra stops every hop that leaves the app and its allowed hosts, and reports it. It stops a hop by its host, so a hop goes through to an allowed host even when the allow rule names only some paths there, and to any path on the app, even one under `block`. The states of one run share a browser, so a host that one state allows is open to the others' redirects too. ra reports each such hop as having gone through, and says why.

**`states`** are named entries. Each is a path, or an object with these fields:

- `url`, plus a one-line `note`.
- `world`, laid over the project's world.
- `storage`, `session` and `cookies`: the starting localStorage, sessionStorage and cookies.
- `clock`: the time the page believes it is.
- `ready`: a selector that must be visible before the state counts as reached.
- `steps(page, reached)`: actions that reach the state after the page loads.
- `see`: text that must be visible.
- `expect(page, reached)`: anything else that must hold; throw to fail.
- `status`: the response status this state is meant to have, when it is not a success.
- `views`: views for this state instead of the project's.
- `accept`: findings to accept for this state.
- `scroll`: whether ra scrolls through the page, testing each control as it passes the middle of the screen. A state without steps is scrolled unless this is `false`. A state with steps is looked at where its steps leave it unless this is `true`.
- `live: true`: marks the state as safe to look at on a deployment.
- `javascript: false`: looks at the page with its scripts turned off, as a reader without JavaScript or a crawler sees it, `<noscript>` content included. Every check still runs. It is still a read-only page load, so it does not make a state local, and a run against a deployment may use it without `live`. With scripts off, `session` is not set, since no script could read it, and `see` cannot match text inside `<noscript>`; check that text in `expect` with a CSS locator. The browser refuses the page's scripts and script preloads then, and ra does not report that.

A state with its own world or steps only makes sense on your machine. Against a deployment, `ra check --url https://…` skips such states unless they are marked `live`, and `ra look` refuses them.

Against a deployment, the deployment answers for itself: no reply rule stands in for it, though `block` still applies to its paths. Outside hosts stay closed unless they are allowed, so a check against a deployment shows exactly what the page depends on. It answers whether the deployment looks right, not whether the services behind it work. Give ra the address the deployment settles on, since only that origin counts as the app: when it redirects to https or to `www.`, the page does not load, and the finding names the address to look at instead.

**`accept`** lists findings you have decided to live with: `{ finding: "contrast", match: "hero", why: "The hero text sits on a photo we test by hand." }`. A `why` is required, and it is printed wherever the finding appears. When every state is checked, `ra check` names the accept entries that matched nothing, so stale ones get removed.

Other settings: `tapTarget` (default 24), `timeout` (default 30000), `settle` (default 5000), `locale` (default `en-US`) and `timezone` (default `UTC`). `timeout` is how long ra waits for a page to load and for its `ready` mark, and how long a state's `steps`, its `expect` and ra's own checks may take. A part that runs longer is reported, and the run goes on with the next look. A state's `steps` and the `--then` code are timed as a whole, so a long flow may need a larger `timeout`. It takes milliseconds above 0 and up to 2147483647.

## What it finds

Each finding is a sentence that names the element and says why it matters. [docs/findings.md](docs/findings.md) explains how each kind is decided, what it deliberately ignores, and how to accept one.

- **Layout:**
  - `page-scroll`: the page scrolls sideways.
  - `cut-off`: text or a control is clipped by a box that hides overflow.
  - `spill`: text runs out of its box.
  - `overlap`: two pieces of text are painted over each other.
  - `covered`: something sits on top of a control, so a click would land on that instead.
- **Reading and reaching:**
  - `contrast`: measured from the painted pixels, not from CSS.
  - `small-target`: tap targets on touch views that are small and crowded.
  - `no-name`: controls without an accessible name, and images without alt text.
- **Content:**
  - `image`: an image did not load, or is stretched.
  - `blank`: the page shows nothing.
  - `document`: there is no title or viewport, or the status is unexpected.
  - `error-overlay`: a dev-server error overlay is showing.
- **Behaviour:**
  - `console`: an error was logged.
  - `request`: a request failed or answered 4xx/5xx.
  - `outside`: a request left the world.
  - `load`: the page did not load.
  - `busy`: the page never went quiet.
  - `expect` and `steps`: your own checks or steps failed.

ra exists to stay quiet on pages that are fine, so a false alarm is a bug in ra. The fixture page [`test/fixtures/site/tricky.html`](test/fixtures/site/tricky.html) collects deliberate ellipses, line clamps, scrolling strips, off-screen drawers and screen-reader-only text. ra must report nothing on it.

## In CI

Run `ra check`. It needs no stored baselines, so it only fails when something is wrong now:

```yaml
- run: bun install --frozen-lockfile
- run: bunx --no-install playwright-core install --with-deps chromium
- run: bunx --no-install ra check
```

A failing check prints each finding once, tagged with the views it shows at when that is not every view, and ends with a receipt for the browser it ran. This is ra's own fixture site, trimmed:

```
$ ra check
ra check — 23 states, 33 looks in 10.4s — http://127.0.0.1:58744

✗ noscript  /noscript
  contrast  "This line shows only when scripts are o…" has 1.9:1 contrast (#b9bdc7 on #ffffff); text this size needs 4.5:1.
            at p.faint "This line shows only when scripts are o…"
✗ broken  /broken
  cut-off       "Subscribe to updates" is cut off on the right by its own box (84px hidden).
                at button.button.cut "Subscribe to updates"
  covered       button "Pay now" is covered by span.veil; a click or tap on it would land on that instead.
                at button.button "Pay now"
  outside       The page asked api.example.com for data (GET https://api.example.com/v1/me); nothing in its world answers. Give api.example.com a reply, or list it under allow or block.
  page-scroll   The page scrolls sideways by 531px. Sticking out: div.too-wide "This box is 900 pixels wide whatever th…" (900px wide, ends 530px past the edge). [phone, phone.dark]
  …
✗ pinned  /pinned
  covered  button "Add to cart" is covered by p "Free shipping over fifty"; a click or tap on it would land on that instead.
  covered  p.cookies "This site keeps a cookie." covers 2 controls: button "Help", button "Chat".
           at button.help "Help"
…
✗ leave  /leave
  load     The page did not load, because a redirect from /leave sent it outside its world, to https://example.com/ (net::ERR_PROXY_CONNECTION_FAILED at http://127.0.0.1:58744/leave). The outside finding says more.
  outside  A redirect from /leave tried to take the page to https://example.com/, which is not in its world, and was stopped. The browser follows redirects by itself, so a reply for example.com cannot answer it. Give /leave a reply that does not redirect there, or list example.com under block to stop it quietly, or under allow to let it through.
…

✓ home
✓ tricky
…

57 findings in 13 of 23 states, with 3 notes. Look closer: ra look noscript --at desktop
browser: Chromium 158.0.8127.18, playwright-core 1.65.0, ~/Library/Caches/ms-playwright/chromium-1254/…/Google Chrome for Testing
```

`ra check --json` prints every look as data, for tools that want more than the exit code.

## The browser

ra runs the Chromium that your project's own `playwright-core` installed, in headless mode. Before launching, it:

- resolves the executable and follows symlinks
- refuses any path into an installed Google Chrome
- requires the file to sit in Playwright's versioned browser directory
- learns Playwright's default switches for that version without starting a browser, by pointing Playwright at a script that writes down its arguments

It then launches with:

- a single `--disable-features` switch holding Playwright's list plus `PaintHolding` and `MacAppCodeSignClone`
- `--mute-audio`
- the closed world: a proxy that refuses everything, bypassed only for the app on its own port and for the allowed hosts; a host-resolver rule that lets no other name resolve; and WebRTC held to proxied connections, which that proxy refuses

After launch, ra reads `Browser.getBrowserCommandLine` and refuses to continue unless the running browser has every one of these. Every run ends with a receipt line. `ra doctor` shows the same receipt and tries the closed world: a throwaway app must answer, while another port on this machine, an IP address, an outside host and a WebRTC connection must each be stopped.

ra runs on macOS and Linux and is tested with playwright-core 1.58 through 1.65.

## As a library

`defineConfig` is all most projects need. Scripts that drive a browser themselves can also use:

- `openBrowser`: the launch policy and its receipt
- `closeWorld`: the closed world's routing, applied to any `BrowserContext`. Launch the browser with the switches beneath it, so that what routing never sees is stopped too. `reachableHosts` returns `null` when a world lets every host through, and then there is nothing to close:

  ```ts
  const hosts = reachableHosts(worlds);
  const owned = await openBrowser({ args: hosts === null ? [] : closedWorldSwitches(origin, hosts) });
  ```

  Like Playwright, `openBrowser` closes the browser on SIGINT, SIGTERM and SIGHUP, and exits on Ctrl-C. Pass `handleSignals: false` when your script handles those signals itself.
- `ruleProblem`: what is wrong with a rule, in words, or `null`
- `observe` and `inspectPage`: a look. When one browser serves several worlds, pass `observe` the same hosts as `reachable`, so that it knows which redirects the browser let through.
- `compareLooks`: a diff

## Neighbours

As of November 2026. Each of these moves fast.

- **Agent browsers**, such as Playwright MCP, Chrome DevTools MCP and agent-browser, give the agent a page to drive, its accessibility tree and pictures. Whether the layout is right is left to the model. ra measures the layout and hands the agent a verdict.
- **Visual regression tools**, such as Chromatic, Percy, Argos, Meticulous and BackstopJS, compare new pictures with earlier ones. They show every change, wanted or not, and someone decides which changes are bugs. A bug that was there from the start is part of the baseline. `ra check` needs no baseline, and `ra snap` and `ra diff` say in words what moved during one change.
- **Accessibility engines**, such as axe-core and Lighthouse, check many more rules than ra has. Run one alongside ra, which adds what only the painted page shows: contrast over images and gradients, text that is clipped or spills, and controls that something else covers.
- **Rendered-UI linters** are the closest. [renderlint](https://github.com/ngocanhnckh/renderlint) shares ra's premise and measures contrast the same way, with more rules, a sweep across widths, stress passes with longer text and a Stop hook for Claude Code. [Impeccable](https://github.com/pbakaus/impeccable)'s `detect` looks for design "slop" with deterministic rules. ra puts its weight on the world around the page: each state brings its own replies, storage, cookies and clock, a request that nothing answers is reported, and the same closed world holds when ra looks at a deployment.

## Where it came from

ra replaces Direct, an earlier framework that had the right core ideas, the wrong weight and the wrong output. [docs/from-direct.md](docs/from-direct.md) says what was kept, what was dropped and why. [docs/recipes.md](docs/recipes.md) shows how ra fits each kind of app.

## Licence

MIT
