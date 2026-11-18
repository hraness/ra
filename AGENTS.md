# ra

ra looks at a web app's interface in a real browser inside a fake world, and says in words what is wrong. The README explains what it is for; `docs/` has the reference.

## Setup and checks

- Node 22.18 or later runs ra, because it strips the types from `.ts` files. Bun installs packages and runs scripts, but never runs ra itself; `src/cli.ts` refuses to.
- `bun install`
- `bun run check` runs the type check, the unit tests and the build, then starts the built CLI. Run it before every push.
- `bun run test:browser` runs the real CLI against `test/fixtures/site` in a real browser. It needs Chromium for the pinned playwright-core: `node node_modules/playwright-core/cli.js install chromium`. Run it after any change to `src/`. On a shared machine, run it through the machine's scheduler, not alongside other browser work.
- `cd test/fixtures/site && node ../../../src/cli.ts look broken --at phone` shows what the fixture prints.

## Code

- `src/cli.ts`: the command, its help and its exit codes.
- `src/config.ts`: `ra.config.ts`, views and states.
- `src/app.ts`: starting or serving the app, and the keeper process that stops all of it.
- `src/world.ts`: the closed world (routing, the browser switches beneath it, the trial `ra doctor` runs, upstream stand-ins).
- `src/browser.ts`: the only place a browser is launched, plus the receipt.
- `src/run.ts`: one session (the app, the stand-ins and one browser) and the looks it runs.
- `src/observe.ts`: one look at one state through one view.
- `src/inspect.ts`: the checks that run inside the page.
- `src/contrast.ts`, `src/outline.ts`, `src/diff.ts`, `src/png.ts`, `src/report.ts`: contrast measurement, the outline, snapshots and diffs, PNG handling, and the printed text.

## Rules

- **No runtime dependencies.** `playwright-core` is an optional peer that comes from the project being looked at. Keep it that way.
- **Quiet on correct pages.** Every finding kind has a planted case in `test/fixtures/site/broken.html`. Every deliberate pattern that looks like a problem but is not one (ellipsis, line clamp, scroller, drawer, screen-reader text) sits in `tricky.html`, which must stay clean. A new check needs both, plus a browser test.
- **Findings are sentences.** Each names the element and says by how much it is wrong. Write it for an agent that will act on it, and keep CSS jargon out unless it is the fix.
- **One launch path.** Only `src/browser.ts` starts a browser. Its policy is covered by unit tests: the provisioned Chromium only, never an installed Chrome; one merged `--disable-features` that includes `PaintHolding` and `MacAppCodeSignClone`; `--mute-audio`; and a verified command line.
- **The world stays closed.** A request that nothing in the world answers is stopped and reported, including against deployments. Do not add a way around this. The `leave`, `detours` and closed-world browser tests, and the trial in `ra doctor`, prove it; a change that weakens one of them is a regression.
- **Public repository.** Docs and examples describe kinds of product in general terms. Do not name or describe private products that use ra, or include their data.

## Delivery

- Work on a branch and open a pull request to `main`. The `Required` check must pass. Squash-merge it.
- `dist/` is never committed. The release workflow builds it.
- To release, bump `version` in `package.json` in the pull request, and change the release address and the `verify-asset` command in `README.md` to match; a unit test checks that they agree. Once CI passes on `main`, `auto-tag` tags the version and `release` publishes an immutable GitHub release with the packed tarball as its one asset. GitHub records the SHA-256 of the asset.
