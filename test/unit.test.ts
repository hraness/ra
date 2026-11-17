/**
 * Everything that can be checked without a browser.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { checkCommandLine, planLaunch, rejectInstalledChrome, resolveExecutable } from "../src/browser.ts";
import { ConfigError, mergeWorlds, readConfig, resolveView } from "../src/config.ts";
import { contrastRatio, findLowContrast, neededRatio } from "../src/contrast.ts";
import { boxChanges, lineChanges } from "../src/diff.ts";
import type { Box } from "../src/inspect.ts";
import { applyAccepts, type Finding, type Observation } from "../src/observe.ts";
import { outlineOf } from "../src/outline.ts";
import { comparePixels, decodePng, encodePng, frame, type Image } from "../src/png.ts";
import { checkText } from "../src/report.ts";
import { findReply, judge, reachableHosts, resolverSwitch, sameApp } from "../src/world.ts";

const scratch = mkdtempSync(join(tmpdir(), "ra-unit-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe("browser launch policy", () => {
  test("merges every --disable-features into one switch with the required names", () => {
    const plan = planLaunch(["--headless", "--disable-features=A,B", "--mute-audio"], ["--disable-features=C", "--window-size=10,10"]);
    assert.deepEqual(plan.ignore, ["--disable-features=A,B"]);
    const switches = plan.args.filter((arg) => arg.startsWith("--disable-features="));
    assert.deepEqual(switches, ["--disable-features=A,B,C,PaintHolding,MacAppCodeSignClone"]);
    assert.ok(plan.args.includes("--window-size=10,10"));
    assert.ok(plan.args.includes("--enable-automation"));
    assert.ok(!plan.args.includes("--mute-audio"), "Playwright already passes --mute-audio here, so it is not added twice");
  });

  test("adds --mute-audio when the defaults lack it", () => {
    assert.ok(planLaunch(["--headless"]).args.includes("--mute-audio"));
  });

  test("refuses to enable a feature that must stay off, and a split switch", () => {
    assert.throws(() => planLaunch([], ["--enable-features=PaintHolding"]), /must stay disabled/u);
    assert.throws(() => planLaunch([], ["--disable-features"]), /one argument/u);
  });

  test("checks the command line the browser reports", () => {
    const executable = realpathSync(process.execPath);
    const good = [executable, "--disable-features=X,PaintHolding,MacAppCodeSignClone", "--mute-audio"];
    assert.deepEqual(checkCommandLine(good, executable, ["X"]), []);
    assert.match(checkCommandLine([executable, "--disable-features=X", "--disable-features=PaintHolding", "--mute-audio"], executable, []).join(" "), /one --disable-features switch and found 2/u);
    assert.match(checkCommandLine([executable, "--disable-features=PaintHolding"], executable, []).join(" "), /MacAppCodeSignClone.*not muted/su);
    assert.match(checkCommandLine(["/bin/sh", ...good.slice(1)], executable, []).join(" "), /not the resolved/u);
  });

  test("refuses the installed Google Chrome on every platform", () => {
    for (const path of [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/opt/google/chrome/chrome",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ]) {
      assert.throws(() => rejectInstalledChrome(path), /Refusing the installed Google Chrome/u, path);
    }
    rejectInstalledChrome("/Users/a/Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    rejectInstalledChrome("/home/a/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome");
  });

  test("resolves only a real file inside Playwright's versioned directory", () => {
    const pinned = join(scratch, "chromium-1234");
    const elsewhere = join(scratch, "elsewhere");
    mkdirSync(pinned, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    const real = join(pinned, "chrome");
    writeFileSync(real, "#!/bin/sh\n");
    chmodSync(real, 0o755);
    assert.equal(resolveExecutable(real), realpathSync(real));

    const outside = join(elsewhere, "chrome");
    writeFileSync(outside, "#!/bin/sh\n");
    chmodSync(outside, 0o755);
    symlinkSync(outside, join(pinned, "linked"));
    assert.throws(() => resolveExecutable(join(pinned, "linked")), /resolves outside its pinned revision/u);
    assert.throws(() => resolveExecutable(outside), /outside its versioned installation/u);
    assert.throws(() => resolveExecutable(join(pinned, "missing")), /is not installed/u);
    assert.throws(() => resolveExecutable("chromium-1234/chrome"), /not absolute/u);
  });
});

describe("views and config", () => {
  test("reads built-in views, sizes and modifiers", () => {
    assert.deepEqual(resolveView("phone.dark"), { name: "phone.dark", width: 390, height: 844, touch: true, scale: 2, scheme: "dark", motion: false });
    assert.deepEqual(resolveView("1024x768.touch.motion"), { name: "1024x768.touch.motion", width: 1024, height: 768, touch: true, scale: 1, scheme: "light", motion: true });
    assert.equal(resolveView("kiosk.dark", [{ name: "kiosk", width: 1080, height: 1920 }]).width, 1080);
    assert.throws(() => resolveView("watch"), ConfigError);
    assert.throws(() => resolveView("phone.sideways"), /Unknown view modifier/u);
  });

  test("fills defaults and marks states that need their own world as local", () => {
    const project = readConfig(
      {
        world: { block: ["*.analytics.example"] },
        states: {
          home: "/",
          empty: { url: "/inbox", world: { replies: { "GET /api/inbox": { json: [] } } } },
          shared: { url: "/about", live: true, world: { replies: { "/api/x": { json: 1 } } } },
        },
      },
      scratch,
    );
    assert.deepEqual(project.views.map((view) => view.name), ["desktop", "phone"]);
    assert.equal(project.tapTarget, 24);
    const byName = Object.fromEntries(project.states.map((state) => [state.name, state]));
    assert.equal(byName.home!.local, false);
    assert.equal(byName.empty!.local, true);
    assert.equal(byName.shared!.local, false);
    assert.deepEqual(byName.empty!.world.block, ["*.analytics.example"], "states inherit the project's world");
    assert.ok("GET /api/inbox" in byName.empty!.world.replies);
  });

  test("lays one world over another", () => {
    const merged = mergeWorlds({ allow: ["a.example"], replies: { "/x": { json: 1 } } }, { allow: ["b.example"], replies: { "/x": { json: 2 } } });
    assert.deepEqual(merged.allow, ["a.example", "b.example"]);
    assert.deepEqual(merged.replies["/x"], { json: 2 });
  });
});

describe("the closed world", () => {
  const origin = "http://127.0.0.1:4000";
  const at = (address: string) => new URL(address, origin);

  test("decides in order: reply, block, the app, allow, unexpected", () => {
    const world = { replies: { "GET /api/me": { json: {} }, "https://api.example.com/**": { json: [] } }, block: ["/beacon", "*.tracker.example"], allow: ["fonts.example.com"] };
    assert.equal(judge(world, origin, "GET", at("/api/me")), "replied");
    assert.equal(judge(world, origin, "POST", at("/api/me")), "app", "a method-limited reply does not catch other methods");
    assert.equal(judge(world, origin, "GET", at("https://api.example.com/v1/items")), "replied");
    assert.equal(judge(world, origin, "POST", at("/beacon")), "blocked");
    assert.equal(judge(world, origin, "GET", at("https://cdn.tracker.example/t.js")), "blocked");
    assert.equal(judge(world, origin, "GET", at("/index.css")), "app");
    assert.equal(judge(world, origin, "GET", at("http://localhost:4000/other")), "app", "every loopback name is the app");
    assert.equal(judge(world, origin, "GET", at("https://fonts.example.com/inter.woff2")), "allowed");
    assert.equal(judge(world, origin, "GET", at("https://elsewhere.example.org/")), "unexpected");
  });

  test("keeps * within a path segment and lets ** cross them; the most literal rule wins", () => {
    const replies = { "/api/*": { json: "one" }, "/api/**": { json: "any" }, "/api/items": { json: "items" } };
    assert.deepEqual(findReply(replies, "GET", at("/api/items"), origin), { json: "items" });
    assert.deepEqual(findReply(replies, "GET", at("/api/other"), origin), { json: "one" });
    assert.deepEqual(findReply(replies, "GET", at("/api/a/b"), origin), { json: "any" });
    assert.equal(findReply(replies, "GET", at("/apix"), origin), undefined);
  });

  test("treats the app's origin by scheme, port and loopback name", () => {
    assert.ok(sameApp(new URL("ws://localhost:4000/socket"), origin));
    assert.ok(!sameApp(new URL("http://127.0.0.1:4001/"), origin));
    assert.ok(!sameApp(new URL("https://127.0.0.1:4000/"), origin));
  });

  test("lets only loopback and allowed hosts resolve", () => {
    assert.deepEqual(reachableHosts([{ allow: ["https://fonts.example.com/**", "/local/path", "GET *.cdn.example"] }]), ["fonts.example.com", "*.cdn.example"]);
    assert.equal(reachableHosts([{ allow: ["*"] }]), null, "a world that allows everything turns the backstop off");
    assert.equal(
      resolverSwitch(["app.example.com"]),
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE *.localhost , EXCLUDE 127.0.0.1 , EXCLUDE app.example.com",
    );
  });
});

describe("outline", () => {
  const snapshot = [
    "- banner:",
    '  - link "Fixture":',
    "    - /url: http://127.0.0.1:4000/",
    '  - navigation "Main":',
    '    - link "Pricing":',
    "      - /url: http://127.0.0.1:4000/pricing",
    "- main:",
    '  - heading "Welcome" [level=1]',
    "  - paragraph: Plain words.",
    "  - paragraph:",
    "    - text: Read the",
    '    - link "guide":',
    "      - /url: /guide",
    "    - text: first.",
    "  - generic:",
    "    - text: Email",
    '    - textbox "Email"',
    "  - list:",
    ...Array.from({ length: 30 }, (_, index) => `    - listitem: Item ${index + 1}`),
  ].join("\n");

  test("drops wrappers, keeps addresses, and joins loose text", () => {
    const { lines } = outlineOf(snapshot, { origin: "http://127.0.0.1:4000", lines: Infinity });
    assert.ok(lines.includes('  link "Fixture" → /'));
    assert.ok(lines.includes('    link "Pricing" → /pricing'));
    assert.ok(lines.includes('  heading "Welcome" [level=1]'));
    assert.ok(lines.includes("  paragraph: Plain words."));
    assert.ok(lines.includes("  paragraph: Read the guide first."));
    assert.ok(lines.includes('    link "guide" → /guide'));
    assert.ok(lines.includes('  textbox "Email"'), "a label that repeats its control's name is not printed twice");
    assert.ok(!lines.some((line) => line.trim() === "generic"));
  });

  test("folds long runs of alike items to fit", () => {
    const { lines, full } = outlineOf(snapshot, { lines: 20 });
    assert.ok(lines.length <= 20);
    assert.ok(full > 20);
    assert.ok(lines.some((line) => /… \d+ more listitem/u.test(line)));
  });
});

describe("pictures", () => {
  const blank = (width: number, height: number): Image => ({ width, height, data: new Uint8Array(width * height * 4).fill(255) });
  const paint = (image: Image, x0: number, y0: number, size: number, rgb: [number, number, number]) => {
    for (let y = y0; y < y0 + size; y++) {
      for (let x = x0; x < x0 + size; x++) image.data.set([...rgb, 255], (y * image.width + x) * 4);
    }
  };

  test("round-trips a PNG", () => {
    const image = blank(40, 30);
    paint(image, 5, 5, 6, [10, 120, 200]);
    const back = decodePng(encodePng(image));
    assert.equal(back.width, 40);
    assert.equal(back.height, 30);
    assert.deepEqual(back.data, image.data);
  });

  test("finds where two pictures differ and frames it", () => {
    const before = blank(200, 200);
    const after = blank(200, 200);
    paint(after, 100, 120, 30, [0, 0, 0]);
    const difference = comparePixels(before, after);
    assert.ok(difference.ratio > 0 && difference.ratio < 0.1);
    const [area] = difference.areas;
    assert.ok(area !== undefined && area.x <= 100 && area.y <= 120 && area.x + area.width >= 130 && area.y + area.height >= 150);
    assert.equal(comparePixels(before, blank(200, 200)).areas.length, 0);
    frame(after, difference.areas);
    assert.notDeepEqual(after.data, decodePng(encodePng(after)).data.fill(255));
  });
});

describe("contrast", () => {
  test("measures WCAG ratios", () => {
    assert.equal(Math.round(contrastRatio([0, 0, 0], [255, 255, 255])), 21);
    assert.equal(contrastRatio([119, 119, 119], [255, 255, 255]).toFixed(2), "4.48");
    assert.equal(neededRatio(16, 400), 4.5);
    assert.equal(neededRatio(24, 400), 3);
    assert.equal(neededRatio(19, 700), 3);
  });

  test("reads the background from what was painted under the text", () => {
    const painted: Image = { width: 120, height: 20, data: new Uint8Array(120 * 20 * 4).fill(255) };
    const bare: Image = { width: 120, height: 20, data: new Uint8Array(120 * 20 * 4).fill(255) };
    for (let x = 10; x < 100; x += 3) for (let y = 5; y < 15; y++) painted.data.set([185, 189, 199, 255], (y * 120 + x) * 4);
    const sample = { where: "p.faint", text: "Faint", box: { x: 0, y: 0, width: 120, height: 20 }, size: 16, weight: 400 };
    const [problem] = findLowContrast([{ ...sample, color: [185, 189, 199, 1] }], painted, bare);
    assert.ok(problem !== undefined);
    assert.equal(problem.background, "#ffffff");
    assert.ok(problem.ratio < 2 && problem.needs === 4.5);
    assert.deepEqual(findLowContrast([{ ...sample, color: [20, 20, 20, 1] }], painted, bare), []);
  });
});

describe("diff", () => {
  test("lists lines only one side has", () => {
    assert.deepEqual(lineChanges(["a", "b", "c", "e"], ["a", "c", "d", "e"]), { removed: ["b"], added: ["d"] });
  });

  test("groups elements that moved together", () => {
    const box = (key: string, y: number, height = 20): Box => ({ key, x: 0, y, width: 100, height });
    const before = [box('h1 "Title"', 0, 40), box("text one", 50), box("text two", 80), box("text three", 110)];
    const after = [box('h1 "Title"', 0, 52), box("text one", 62), box("text two", 92), box("text three", 122), box("text new", 150)];
    assert.deepEqual(boxChanges(before, after), ['resized: h1 "Title" 100×40 → 100×52', "moved: 3 elements 12px down, from text one on", "appeared: text new"]);
  });
});

describe("findings", () => {
  const finding = (kind: string, message: string): Finding => ({ kind, message, where: "", selector: "" });
  const look = (state: string, view: string, findings: Finding[]): Observation =>
    ({ state, view, findings, notes: [] }) as unknown as Observation;

  test("accepting a finding records why, and which rules were used", () => {
    const findings = [finding("contrast", "Faint text on the hero"), finding("console", "Hydration warning")];
    const rule = { finding: "contrast", match: "hero", why: "The hero is decorative." };
    const used = applyAccepts(findings, [rule, { finding: "image", why: "never matches" }]);
    assert.deepEqual(used, [rule]);
    assert.equal(findings[0]!.accepted, "The hero is decorative.");
    assert.equal(findings[1]!.accepted, undefined);
  });

  test("a check report names views only for findings that show at some of them", () => {
    const states = [{ name: "home", url: "/" }, { name: "about", url: "/about" }] as never;
    const receipt = { executable: "/x/chromium-1/chrome", version: "1.0", playwright: "1.0.0", disabledFeatures: [], muted: true as const };
    const summary = checkText(
      states,
      [
        look("home", "desktop", [finding("console", "The console logged an error: boom")]),
        look("home", "phone", [finding("console", "The console logged an error: boom"), finding("page-scroll", "The page scrolls sideways by 12px.")]),
        look("about", "desktop", []),
        look("about", "phone", []),
      ],
      { origin: "http://127.0.0.1:1", live: false, ms: 1000, receipt, notes: [], skipped: [], unused: [] },
    );
    assert.equal(summary.ok, false);
    assert.equal(summary.findings, 2);
    assert.match(summary.text, /console {6}The console logged an error: boom\n/u);
    assert.match(summary.text, /page-scroll {2}The page scrolls sideways by 12px\. \[phone\]/u);
    assert.match(summary.text, /✓ about/u);
  });
});
