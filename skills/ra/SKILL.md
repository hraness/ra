---
name: ra
description: Look at a web app's interface in a real browser, inside a fake and closed world, and read in words what is wrong with it. Use when changing anything a person sees (CSS, layout, components, copy that may not fit), when asked whether a page works on a phone or in dark mode, when reproducing a visual bug, or before handing off a UI change. Not for logic that a unit test can prove.
---

# ra

ra runs the app in Chromium and answers everything outside the app from a world you describe: API replies, blocked hosts and stand-in servers. It then prints what a person would meet on the page: what is wrong, what a screen reader would hear and how the page is laid out. Pictures are written to disk, and you open one only when the words leave a doubt.

## When to reach for it

- You changed something visual: CSS, a layout, a component, or text that might not fit.
- A state is hard to reach by hand: empty, failed, overflowing, signed out, or a date at midnight.
- A change could reach further than the place you edited, such as a shared component, a design token or a global style.
- Someone asks whether it works on a phone, or whether it can be read in dark mode.

Do not use ra to test logic, to restate the implementation, or to check that live services work.

## The loop

1. `ra states` lists the states the project names. Without a config, `ra look http://127.0.0.1:3000/path` works on any running app.
2. `ra look <state> --at phone` shows one state. Read the findings, fix them, and look again. Use `--at phone,desktop` or `--at all` when more views matter.
3. Before a change whose reach you cannot see, run `ra snap`. After it, run `ra diff`. It says which elements moved, resized, appeared or vanished, which outline lines changed, and which findings are new.
4. Before handing off, run `ra check`. Exit 0 means nothing is wrong in any state at any view.

Run ra through the project's package runner (`bunx --no-install ra`, `npx ra`). It brings and verifies its own browser, so do not start Chrome yourself.

## Reading a look

```
broken at phone (390×844)
http://127.0.0.1:64156/broken — 200 — "Fixture — Broken on purpose"
page 921×1991, 7 requests, 2 stopped, 2.0s

16 findings
  cut-off       "Subscribe to updates" is cut off on the right by its own box (84px hidden).
                at button.button.cut "Subscribe to updates"
  covered       button "Pay now" is covered by span.veil; a click or tap on it would land on that instead.
                at button.button "Pay now"
  outside       The page asked api.example.com for data (GET https://api.example.com/v1/me); nothing in its world answers. …

outline
  main: …
    heading "Everything here is wrong" [level=1]
    button "Subscribe to updates"

layout
  main "Everything here is wrong"  390×857 at 0,65  10 items stacked
    section#cut                    350×48 at 20,220

pictures: .ra/look/broken.phone.png (first screen), .ra/look/broken.phone.full.png (whole page)
browser: Chromium 158.0.8127.18, playwright-core 1.65.0, …
```

- **The header** gives the address, status, title and page size. A page wider than the view means it scrolls sideways.
- **The findings** are the point. Each one names the element (`at …`) and says by how much it is wrong. [`docs/findings.md`](../../docs/findings.md) says how each kind is decided.
- **Notes** say what a look had to leave out, such as the part of a very long page below its first 40 screens. `ra check` prints them under their state, passing or not, and counts them in its last line.
- **The outline** is what a screen reader would hear. Each line maps onto `getByRole(role, { name })`. Check copy, headings, labels and order here rather than in a picture.
- **The layout** lists boxes with their sizes and positions in CSS pixels, with how the children of each are arranged. Check alignment, wrapping and stacking here.
- **The pictures** are for what words cannot carry, such as a gradient, an illustration or whether something looks right at all.
- **Exit codes:** 0 fine; 1 `ra check` found something; 2 the command or config is wrong; 3 the app or the browser could not run. The message says what to do.

`--json` gives the same thing as data. `--in "<selector>"` narrows a look to part of the page, and `--full` prints a long outline in full.

## Getting to a state

Prefer a named state in `ra.config.ts`, so the next look is one command:

```ts
"projects-empty": {
  url: "/projects",
  world: { replies: { "GET /api/projects": { json: [] } } },
  see: ["No projects yet"],
},
```

- Name states after visual risks: typical, empty, overflowing, failed. Do not name one for every route.
- Every request the page makes needs a reply, an `allow` or a `block`. An `outside` finding names the host that is missing one.
- A reply cannot answer where a redirect leads, because the browser follows redirects without asking. When an `outside` finding says a redirect was stopped, give the address that redirected a reply.
- An error status that the world is told to give is the state itself. ra reports how the page handles it, not the error.
- For calls made by the app's server, use `upstreams` and pass `{upstream.NAME}` to the app in `app.env`.
- `storage`, `cookies` and `clock` set up the rest. `steps(page)` clicks through to a state after the page loads.
- `javascript: false` looks at the page with its scripts off, as a reader without JavaScript or a crawler sees it. Every check still runs. It is still a read-only page load, so a run against a deployment may use it without `live`. `see` cannot match text inside `<noscript>`; check that text in `expect` with a CSS locator.
- A look never hangs the run. Steps, an `expect` or ra's own checks that take longer than the project's `timeout` (30 seconds by default) end the look with a `steps`, `expect` or `busy` finding, and the next look runs. A state's steps are timed as a whole, so a long flow may need a larger `timeout`; ra's waits for the page to settle and for its images come on top of it.

For a one-off interaction, use `--then`. It runs Playwright code with `page` in scope before the look and prints what the code returns:

```sh
ra look checkout --at phone --then "await page.getByRole('button', { name: 'Pay' }).click()"
```

## Do not

- Do not accept a finding to make `ra check` pass. Fix it. `accept` is for findings that are true and fine, and it needs a `why`.
- Do not `allow` an API to silence an `outside` finding. Give it a reply instead. `allow` is for fonts and CDNs that the page really needs.
- Do not commit `.ra/`. It holds pictures and snapshots for this machine, and it ignores itself in git.
- Do not compare pictures in CI. `ra check` is the CI step, and it needs no baselines.
- Do not read every picture. Read the findings and the outline first, and open a picture only for what they cannot say.

When `ra doctor` says the browser is missing, install it with the project's own Playwright: `bunx --no-install playwright-core install chromium` or `npx playwright-core install chromium`.
