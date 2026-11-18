/**
 * ra run for real against the fixture site: a real browser, the real CLI.
 * Needs Chromium for the installed playwright-core:
 *   node node_modules/playwright-core/cli.js install chromium
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { serveStatic, type RunningApp } from "../src/app.ts";
import type { Observation } from "../src/observe.ts";
import { decodePng } from "../src/png.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const index = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const site = fileURLToPath(new URL("./fixtures/site/", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "ra-browser-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

interface Ran {
  status: number | null;
  out: string;
  err: string;
}

function ra(args: string[], cwd = site, limit?: number): Promise<Ran> {
  return new Promise((resolve, reject) => {
    // A limit ends a run that would otherwise hang the suite.
    const child = spawn(process.execPath, [cli, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], ...(limit === undefined ? {} : { timeout: limit }) });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, out, err }));
  });
}

function kinds(looks: Observation[], state: string, view: string): string[] {
  const look = looks.find((candidate) => candidate.state === state && candidate.view === view);
  assert.ok(look !== undefined, `no look at ${state} through ${view}`);
  return look.findings.map((finding) => finding.kind).sort();
}

/** A small page with nothing wrong on it. */
function html(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
}

/** A copy of the fixture site whose config imports ra by absolute path, so it can be changed freely. */
function copySite(): string {
  const copy = mkdtempSync(join(scratch, "site-"));
  cpSync(site, copy, { recursive: true, filter: (source) => !source.includes(`${join(site, ".ra")}`) });
  const config = join(copy, "ra.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace("../../../src/index.ts", index));
  return copy;
}

describe("ra check on the fixture site", () => {
  let looks: Observation[];
  let result: { ok: boolean; receipt: { executable: string; version: string; disabledFeatures: string[]; muted: boolean } };
  let status: number | null;

  before(async () => {
    const ran = await ra(["check", "--json"]);
    status = ran.status;
    assert.ok(ran.out.startsWith("{"), `ra check printed no JSON: ${ran.err}`);
    result = JSON.parse(ran.out) as typeof result;
    looks = (result as unknown as { looks: Observation[] }).looks;
  });

  test("exits 1 because some states are broken", () => {
    assert.equal(status, 1);
    assert.equal(result.ok, false);
  });

  test("finds nothing on the control page or on deliberate clipping and scrolling", () => {
    for (const view of ["desktop", "phone", "phone.dark"]) {
      assert.deepEqual(kinds(looks, "home", view), [], `home at ${view}`);
      assert.deepEqual(kinds(looks, "tricky", view), [], `tricky at ${view}`);
    }
  });

  test("finds nothing under an open dialog whose frame scrolls", () => {
    for (const view of ["desktop", "phone", "phone.dark"]) {
      const look = looks.find((candidate) => candidate.state === "dialog" && candidate.view === view)!;
      assert.deepEqual(look.findings.map((finding) => `${finding.kind}: ${finding.message}`), [], `dialog at ${view}`);
    }
  });

  test("keeps a touch view's layout in its full picture, where contrast is read", () => {
    // Chromium matches a mouse while it captures beyond the viewport; the rows
    // above the button are shorter for a mouse, which would move it up.
    const look = looks.find((candidate) => candidate.state === "tricky" && candidate.view === "phone")!;
    const button = look.boxes.find((box) => box.key === 'link "Start now"');
    assert.ok(button !== undefined && look.fullPicture !== null, look.boxes.map((box) => box.key).join(", "));
    const picture = decodePng(readFileSync(look.fullPicture));
    const x = Math.round(button.x + button.width / 2);
    const y = Math.round(button.y + 6);
    const at = (y * picture.width + x) * 4;
    const pixel = [picture.data[at]!, picture.data[at + 1]!, picture.data[at + 2]!];
    assert.ok(pixel.every((value) => value < 60), `the top of the dark button, at ${x},${y}, is ${pixel.join(",")} in the picture`);
  });

  test("looks at a page with its scripts off, and checks what it shows then", () => {
    const look = looks.find((candidate) => candidate.state === "noscript")!;
    const said = look.findings.map((finding) => `${finding.kind}: ${finding.message}`);
    assert.deepEqual(kinds(looks, "noscript", "desktop"), ["contrast"], said.join("\n"));
    assert.match(look.findings[0]!.message, /^"This line shows only when scripts are o…" has 1\.9:1 contrast/u);
    assert.ok(!look.notes.some((note) => note.includes("never stopped changing")), look.notes.join("\n"));
  });

  test("finds every planted problem", () => {
    const desktop = kinds(looks, "broken", "desktop");
    for (const kind of ["console", "contrast", "covered", "cut-off", "image", "no-name", "outside", "overlap", "request", "spill"]) {
      assert.ok(desktop.includes(kind), `broken at desktop should have ${kind}: ${desktop.join(", ")}`);
    }
    assert.ok(!desktop.includes("page-scroll"), "the 900px box fits a desktop");
    assert.ok(!desktop.includes("small-target"), "tap targets are only checked on touch views");
    for (const view of ["phone", "phone.dark"]) {
      const phone = kinds(looks, "broken", view);
      assert.ok(phone.includes("page-scroll"), `broken at ${view} scrolls sideways`);
      assert.ok(phone.includes("small-target"), `broken at ${view} has small tap targets`);
    }
    assert.equal(desktop.filter((kind) => kind === "outside").length, 2);
  });

  test("finds the real problems beside what it leaves alone", () => {
    const look = looks.find((candidate) => candidate.state === "broken" && candidate.view === "desktop")!;
    const said = look.findings.map((finding) => `${finding.kind}: ${finding.message}`);
    const expected = [
      // Covers that let the text show: a drawing, a frame, a faint veil, and a clear wrapper labelled as a dialog.
      /^contrast: "Pale words under a drawing" has 1\.9:1 contrast/u,
      /^contrast: "Pale words inside a frame" has 1\.9:1 contrast/u,
      /^contrast: "White words under a pale veil" has 2\.1:1 contrast/u,
      /^contrast: "White words under an oklch veil" has 2\.1:1 contrast/u,
      /^contrast: "White words under a mixed veil" has 2\.1:1 contrast/u,
      /^contrast: "Pale words beside a clear wrapper\." has 1\.9:1 contrast/u,
      // A menu bar and a list that are part of the page are not open popups.
      /^covered: link "A link the menu bar hides" is covered by /u,
      /^covered: button "Continue" is covered by /u,
      // A sidebar whose own control would close it was not opened over the page.
      /^covered: link "A link the open sidebar hides" is covered by /u,
      // A control hidden from screen readers that Tab still reaches.
      /^no-name: 2 controls have no accessible name, starting with button\.button\./u,
      // A picture that holds a link is checked as text.
      /^cut-off: "Start the free trial" is cut off on the right by its own box/u,
      /^contrast: "Billed yearly, cancel any time\." has 1\.9:1 contrast/u,
      // A scaled line that its clip shows in part.
      /^contrast: "Pale words, scaled and partly clipped" has [\d.]+:1 contrast/u,
    ];
    for (const pattern of expected) assert.ok(said.some((line) => pattern.test(line)), `${pattern}\n${said.join("\n")}`);
  });

  test("reports a page without a title or viewport", () => {
    assert.deepEqual(kinds(looks, "untitled", "phone"), ["document", "document"]);
  });

  test("measures contrast under a strict Content-Security-Policy, and logs nothing of its own", () => {
    const strict = looks.find((look) => look.state === "strict")!;
    const said = strict.findings.map((finding) => finding.message);
    assert.deepEqual(kinds(looks, "strict", "desktop"), ["contrast", "contrast"], said.join("\n"));
    assert.ok(said.some((message) => message.startsWith('"This grey line is too pale')), said.join("\n"));
    assert.ok(said.some((message) => message.startsWith('"So is this one, inside a shadow root."')), said.join("\n"));
  });

  test("does not ask a page served as plain text for a title or viewport", () => {
    assert.deepEqual(kinds(looks, "plain", "phone"), []);
    const plain = looks.find((look) => look.state === "plain")!;
    assert.ok(plain.notes.includes("The page is text/plain, not HTML, so ra did not look for a title or a viewport."), plain.notes.join("\n"));
  });

  test("says when a web page is served as plain text", () => {
    const mislabeled = looks.find((look) => look.state === "mislabeled")!;
    assert.deepEqual(
      mislabeled.findings.map((finding) => finding.message),
      ["The page is HTML served as text/plain, so the browser shows its markup as text. Serve it as text/html."],
    );
  });

  test("treats an error the world was told to give as the state, and a throwing reply as a finding", () => {
    assert.deepEqual(kinds(looks, "outage", "desktop"), []);
    assert.deepEqual(kinds(looks, "faulty", "desktop"), ["request"]);
    const faulty = looks.find((look) => look.state === "faulty")!;
    assert.match(faulty.findings[0]!.message, /The world's reply for GET \/api\/status threw: no answer written for this/u);
  });

  test("never lets a redirect reach an outside site", () => {
    const leave = looks.find((look) => look.state === "leave")!;
    assert.ok(!leave.url.includes("example.com") || leave.findings.some((finding) => finding.kind === "load"));
    assert.deepEqual(kinds(looks, "leave", "desktop"), ["load", "outside"]);
    assert.ok(!leave.title.includes("Example Domain"), "example.com was reached");
    const outside = leave.findings.find((finding) => finding.kind === "outside")!;
    assert.match(outside.message, /^A redirect from \/leave tried to take the page to https:\/\/example\.com\/, which is not in its world, and was stopped\./u);
    assert.match(
      leave.findings.find((finding) => finding.kind === "load")!.message,
      /^The page did not load, because a redirect from \/leave sent it outside its world, to https:\/\/example\.com\/ \(net::ERR_PROXY_CONNECTION_FAILED at \S+\)\. The outside finding says more\.$/u,
    );
  });

  test("stops redirect hops that routing never sees, blocks them quietly, and says when a reply could not answer one", () => {
    assert.deepEqual(kinds(looks, "detours", "desktop"), ["request"]);
    const detours = looks.find((look) => look.state === "detours")!;
    assert.match(detours.findings[0]!.message, /GET https:\/\/cdn\.example\.test\/avatar\.json has a reply, but the page reached it through a redirect from \/avatar.*Give \/avatar the reply instead/u);
    assert.equal(detours.requests.blocked, 1, "the hop to the blocked tracker");
  });

  test("runs the provisioned browser the way the policy requires", () => {
    assert.ok(!/\/Google Chrome\.app\//u.test(result.receipt.executable));
    assert.match(result.receipt.executable, /chromium(?:_headless_shell)?-\d+/u);
    for (const name of ["PaintHolding", "MacAppCodeSignClone"]) assert.ok(result.receipt.disabledFeatures.includes(name), name);
    assert.equal(result.receipt.muted, true);
  });
});

describe("a look that never finishes", () => {
  test("is stopped at the project's timeout and reported, and the run goes on and ends", async () => {
    const copy = copySite();
    writeFileSync(
      join(copy, "ra.config.ts"),
      `import { defineConfig } from ${JSON.stringify(index)};
export default defineConfig({
  app: { static: "." },
  views: ["desktop"],
  timeout: 2000,
  states: {
    stuck: { url: "/", steps: () => new Promise(() => {}) },
    waiting: { url: "/", expect: () => new Promise(() => {}) },
    // Its timer would keep ra running for a minute after the run, were ra to wait for it.
    sleeper: { url: "/", steps: () => new Promise((done) => setTimeout(done, 60_000)) },
    // A page that keeps changing is waited for up to 2.5s, longer than the timeout itself.
    moving: { url: "/", steps: (page) => page.evaluate(() => { setInterval(() => { document.documentElement.dataset.tick = String(Date.now()); }, 50); }) },
    late: { url: "/late" },
    // On a touch view, the page freezes once ra holds its hover rule for the pictures.
    held: { url: "/held", views: ["phone"] },
    home: { url: "/" },
  },
});
`,
    );
    const started = performance.now();
    const ran = await ra(["check", "--json"], copy, 120_000);
    const took = performance.now() - started;
    assert.equal(ran.status, 1, ran.err);
    assert.ok(took < 45_000, `ra ended ${Math.round(took / 1000)}s after it started`);
    const looks = (JSON.parse(ran.out) as { looks: Observation[] }).looks;
    const look = (state: string) => looks.find((candidate) => candidate.state === state)!;
    const said = (state: string) => look(state).findings.map((finding) => `${finding.kind}: ${finding.message}`);
    assert.deepEqual(said("stuck"), ["steps: The steps for this state did not finish within 2s, so the look stopped there."]);
    assert.deepEqual(said("sleeper"), ["steps: The steps for this state did not finish within 2s, so the look stopped there."]);
    assert.deepEqual(said("waiting"), ["expect: The expect for this state did not finish within 2s, so the look stopped there."]);
    assert.deepEqual(said("moving"), []);
    assert.ok(look("moving").notes.includes("The page never stopped changing; it was looked at while still moving."), look("moving").notes.join("\n"));
    // What the checks found before the page stopped answering still stands.
    assert.ok(said("late").includes("no-name: button.button has no accessible name, so a screen reader cannot say what it does."), said("late").join("\n"));
    assert.ok(
      said("late").some((line) => /^busy: The page stopped answering for [\d.]+s while ra waited for it to settle, so the look stopped there\.$/u.test(line)),
      said("late").join("\n"),
    );
    // Where the frozen page is caught depends on playwright-core: an older one never gives up on the
    // picture, so ra's own limit stops it there; a newer one does, and then ra's checks run out of time.
    assert.equal(said("held").length, 1, said("held").join("\n"));
    assert.match(said("held")[0]!, /^busy: The page stopped answering/u);
    assert.deepEqual(said("home"), []);
  });

  test("waits as long as the largest timeout, which Node's timers can just hold", async () => {
    const copy = copySite();
    writeFileSync(
      join(copy, "ra.config.ts"),
      `import { defineConfig } from ${JSON.stringify(index)};
export default defineConfig({ app: { static: "." }, views: ["desktop"], timeout: 2147483647, states: { home: { url: "/" } } });
`,
    );
    const ran = await ra(["check", "--json"], copy, 120_000);
    assert.equal(ran.status, 0, ran.err);
    assert.doesNotMatch(ran.err, /TimeoutOverflowWarning/u);
    const [look] = (JSON.parse(ran.out) as { looks: Observation[] }).looks;
    assert.deepEqual(look!.findings, []);
  });
});

describe("ra look", () => {
  test("describes one state at one view, with pictures", async () => {
    const ran = await ra(["look", "home", "--at", "phone", "--json"]);
    assert.equal(ran.status, 0, ran.err);
    const [look] = (JSON.parse(ran.out) as { looks: Observation[] }).looks;
    assert.equal(look!.viewport.width, 390);
    assert.equal(look!.title, "Fixture — Home");
    assert.ok(look!.outline.some((line) => line.trim().startsWith("heading ")), look!.outline.join("\n"));
    assert.ok(look!.picture !== null && existsSync(look!.picture));
    assert.deepEqual(look!.findings, []);
  });

  test("prints text for a path, and what --then returns", async () => {
    const ran = await ra(["look", "/tricky", "--then", "return await page.title()"]);
    assert.equal(ran.status, 0, ran.err);
    assert.match(ran.out, /^tricky at desktop \(1440×900\)/u);
    assert.match(ran.out, /returned\n {2}Fixture — Tricky but fine/u);
    assert.match(ran.out, /\nbrowser: Chromium /u);
  });

  test("looks at an app that is already running, without a config", async () => {
    const app: RunningApp = await serveStatic(site);
    try {
      const ran = await ra(["look", `${app.origin}/broken`, "--at", "narrow", "--json"], scratch);
      assert.equal(ran.status, 0, ran.err);
      const [look] = (JSON.parse(ran.out) as { looks: Observation[] }).looks;
      assert.equal(look!.viewport.width, 320);
      assert.ok(look!.findings.some((finding) => finding.kind === "page-scroll"));
    } finally {
      await app.stop();
    }
  });

  test("says how to name a state that does not exist, and exits 2", async () => {
    const ran = await ra(["look", "nowhere"]);
    assert.equal(ran.status, 2);
    assert.match(ran.err, /There is no state named "nowhere"\. The states are: home, tricky, dialog, noscript, broken, untitled, strict, plain, mislabeled, outage, faulty, leave, detours\./u);
  });
});

describe("the closed world", () => {
  test("stops redirects that leave the world, and owns up to the ones that go through by host", async () => {
    const seen: string[] = [];
    const other = createServer((request, response) => {
      const path = request.url ?? "/";
      seen.push(path);
      if (path.endsWith(".js")) response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end("");
      else response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html("Other", "<p>Reached.</p>"));
    });
    await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
    const port = (other.address() as AddressInfo).port;
    // A port that nothing listens on.
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const dead = (closed.address() as AddressInfo).port;
    await new Promise<void>((done) => closed.close(() => done()));
    try {
      const copy = copySite();
      mkdirSync(join(copy, "track"));
      cpSync(join(copy, "ok.png"), join(copy, "track", "p.png"));
      writeFileSync(join(copy, "pixel.html"), html("Pixel", '<img src="/pixel" alt="">'));
      writeFileSync(join(copy, "mixed.html"), html("Mixed", `<script src="/hop"></script><script src="http://localhost:${port}/direct.js"></script>`));
      writeFileSync(join(copy, "refused.html"), html("Refused", '<script src="/dead"></script>'));
      writeFileSync(
        join(copy, "ra.config.ts"),
        `import { defineConfig } from ${JSON.stringify(index)};
export default defineConfig({
  app: { static: "." },
  views: ["desktop"],
  states: {
    escape: { url: "/escape", world: { replies: { "GET /escape": { status: 302, headers: { location: "http://127.0.0.1:${port}/escaped" } } } } },
    slip: {
      url: "/slip",
      world: { replies: { "GET /slip": { status: 302, headers: { location: "http://localhost:${port}/secret" } } }, allow: ["localhost:${port}/ok/**"] },
    },
    // The page itself is sent to a host that its world blocks.
    gone: {
      url: "/gone",
      world: { replies: { "GET /gone": { status: 302, headers: { location: "http://127.0.0.1:${port}/away" } } }, block: ["127.0.0.1:${port}"] },
    },
    // An image is sent to a path on the app that its world blocks.
    pixel: { url: "/pixel.html", world: { replies: { "GET /pixel": { status: 302, headers: { location: "/track/p.png" } } }, block: ["/track/**"] } },
    // A script is sent to a host that only slip's world allows; the states share one browser.
    mixed: { url: "/mixed.html", world: { replies: { "GET /hop": { status: 302, headers: { location: "http://localhost:${port}/hopped.js" } } } } },
    // A script is sent past the proxy to a port where nothing listens, so it fails, but it was not stopped.
    refused: {
      url: "/refused.html",
      world: { replies: { "GET /dead": { status: 302, headers: { location: "http://localhost:${dead}/dead.js" } } }, allow: ["localhost:${dead}/ok/**"] },
    },
  },
});
`,
      );
      const ran = await ra(["check", "--json"], copy);
      assert.equal(ran.status, 1, ran.err);
      const found = (JSON.parse(ran.out) as { looks: Observation[] }).looks;
      const said = (state: string, kind: string) =>
        found
          .find((look) => look.state === state)!
          .findings.filter((finding) => finding.kind === kind)
          .map((finding) => finding.message);

      assert.deepEqual(kinds(found, "escape", "desktop"), ["load", "outside"]);
      assert.match(said("escape", "outside")[0]!, /^A redirect from \/escape tried to take the page to http:\/\/127\.0\.0\.1:\d+\/escaped, which is not in its world, and was stopped/u);
      assert.match(
        said("escape", "load")[0]!,
        /^The page did not load, because a redirect from \/escape sent it outside its world, to http:\/\/127\.0\.0\.1:\d+\/escaped \(net::ERR_\w+ at \S+\)\. The outside finding says more\.$/u,
      );

      assert.deepEqual(kinds(found, "slip", "desktop"), ["outside"]);
      assert.match(
        said("slip", "outside")[0]!,
        /^A redirect from \/slip took the page to http:\/\/localhost:\d+\/secret, which its world does not allow, and the request went through, because localhost:\d+ is allowed, and ra can stop a redirect only by its host\. Give \/slip a reply that does not redirect there, or allow that address too\.$/u,
      );

      assert.deepEqual(kinds(found, "gone", "desktop"), ["load"]);
      assert.match(said("gone", "load")[0]!, /^The page did not load, because a redirect from \/gone took it to http:\/\/127\.0\.0\.1:\d+\/away, which its world blocks \(net::ERR_\w+ at \S+\)\.$/u);
      assert.equal(found.find((look) => look.state === "gone")!.requests.blocked, 1);

      assert.deepEqual(kinds(found, "pixel", "desktop"), ["outside"]);
      assert.equal(
        said("pixel", "outside")[0],
        "A redirect from /pixel took the page's request for an image to /track/p.png, which its world blocks, and the request went through, because it is on the app's own address, and ra can stop a redirect only by its host. Give /pixel a reply that does not redirect there, or block /pixel too.",
      );

      assert.deepEqual(kinds(found, "mixed", "desktop"), ["outside", "outside"]);
      const [through, asked] = said("mixed", "outside");
      assert.match(
        through!,
        /^A redirect from \/hop took the page's request for a script to http:\/\/localhost:\d+\/hopped\.js, which its world does not allow, and the request went through, because localhost:\d+ is allowed in another state's world, and the states share one browser, and ra can stop a redirect only by its host\./u,
        "what went through comes first, apart from what was stopped on the same host",
      );
      assert.match(asked!, /^The page asked localhost:\d+ for a script \(GET http:\/\/localhost:\d+\/direct\.js\); nothing in its world answers\./u);

      assert.deepEqual(kinds(found, "refused", "desktop"), ["outside"]);
      assert.equal(
        said("refused", "outside")[0],
        `A redirect from /dead took the page's request for a script to http://localhost:${dead}/dead.js, which its world does not allow, and the request went through, because localhost:${dead} is allowed, and ra can stop a redirect only by its host. Give /dead a reply that does not redirect there, or allow that address too.`,
      );

      assert.deepEqual(
        seen.filter((path) => path !== "/favicon.ico").sort(),
        ["/hopped.js", "/secret"],
        "only the hops the findings own up to reached the other server",
      );
    } finally {
      other.closeAllConnections();
      other.close();
    }
  });

  for (const [bind, name] of [
    ["127.0.0.1", "0.0.0.0"],
    ["::1", "[::1]"],
  ] as const) {
    test(`lets the browser reach an app on this machine at ${name}`, async (t) => {
      const app = createServer((_request, response) => response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html("Loopback", "<p>Here.</p>")));
      try {
        await new Promise<void>((done, fail) => app.once("error", fail).listen(0, bind, done));
      } catch (error) {
        t.skip(`this machine cannot listen on ${bind}: ${(error as Error).message}`);
        return;
      }
      try {
        const port = (app.address() as AddressInfo).port;
        const ran = await ra(["look", `http://${name}:${port}/`, "--at", "desktop", "--json"], scratch);
        assert.equal(ran.status, 0, ran.err);
        const [look] = (JSON.parse(ran.out) as { looks: Observation[] }).looks;
        assert.deepEqual(look!.findings, []);
        assert.equal(look!.title, "Loopback");
      } finally {
        app.closeAllConnections();
        app.close();
      }
    });
  }

  test("against a deployment, says to block the deployment's own paths, since no reply stands in for them", async () => {
    const seen: string[] = [];
    const redirects: Record<string, string> = {
      "/widget.js": "https://cdn.example.test/widget.js",
      "/out.js": "https://elsewhere.example.test/out.js",
      "/go.js": "/ph/e.js",
    };
    const deployment = createServer((request, response) => {
      const path = request.url ?? "/";
      seen.push(path);
      const to = redirects[path];
      // A deployment that sends its pages to one address, here with www, and
      // a page that loads with one script from there.
      if (path === "/moved") response.writeHead(301, { location: `http://www.${request.headers.host}/` }).end();
      else if (path === "/www.js") response.writeHead(301, { location: `http://www.${request.headers.host}${path}` }).end();
      else if (path === "/loads") response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html("Loads", '<script src="/www.js"></script>'));
      else if (to !== undefined) response.writeHead(302, { location: to }).end();
      else if (path.endsWith(".js")) response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end("");
      else response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html("Deployed", Object.keys(redirects).map((script) => `<script src="${script}"></script>`).join("")));
    });
    await new Promise<void>((done) => deployment.listen(0, "127.0.0.1", done));
    try {
      const port = (deployment.address() as AddressInfo).port;
      const project = mkdtempSync(join(scratch, "deployed-"));
      writeFileSync(
        join(project, "ra.config.ts"),
        `import { defineConfig } from ${JSON.stringify(index)};
export default defineConfig({
  views: ["desktop"],
  states: { home: "/" },
  world: { replies: { "https://cdn.example.test/**": { body: "" } }, block: ["/ph/**"] },
});
`,
      );
      // A name under .localhost reaches this machine, but ra does not count it as
      // one of the machine's own names, so it treats the app as a deployment.
      const ran = await ra(["look", `http://app.localhost:${port}/`, "--json"], project);
      assert.equal(ran.status, 0, ran.err);
      const [look] = (JSON.parse(ran.out) as { looks: Observation[] }).looks;
      assert.deepEqual(look!.findings.map((finding) => finding.kind).sort(), ["outside", "outside", "request"]);
      const said = (kind: string) => look!.findings.filter((finding) => finding.kind === kind).map((finding) => finding.message);
      assert.equal(
        said("request")[0],
        "GET https://cdn.example.test/widget.js has a reply, but the page reached it through a redirect from /widget.js, which the browser follows by itself, so the request failed. No reply stands in for /widget.js on a deployment, so block /widget.js, or look at the app on this machine, where /widget.js can have the reply.",
      );
      assert.deepEqual(said("outside"), [
        "A redirect from /go.js took the page's request for a script to /ph/e.js, which its world blocks, and the request went through, because it is on the app's own address, and ra can stop a redirect only by its host. Block /go.js too.",
        "A redirect from /out.js tried to take the page's request for a script to https://elsewhere.example.test/out.js, which is not in its world, and was stopped. The browser follows redirects by itself, so a reply for elsewhere.example.test cannot answer it. List elsewhere.example.test under block to stop it quietly, or under allow to let it through; no reply stands in for /out.js on a deployment.",
      ]);
      assert.ok(seen.includes("/ph/e.js"), "the blocked path went through, as the finding says");

      // Pointed at an address the site redirects away from, ra says which address to look at.
      const moved = await ra(["look", `http://app.localhost:${port}/moved`, "--json"], project);
      assert.equal(moved.status, 0, moved.err);
      const [away] = (JSON.parse(moved.out) as { looks: Observation[] }).looks;
      const there = `http://www.app.localhost:${port}`;
      assert.deepEqual(away!.findings.map((finding) => finding.kind), ["load", "outside"]);
      assert.match(
        away!.findings[0]!.message,
        new RegExp(`^The page did not load, because a redirect from /moved took it to ${there.replaceAll(".", "\\.")}/, the same site at another address, which ra does not count as the app \\(net::ERR_\\w+ at \\S+\\)\\. Look at ${there.replaceAll(".", "\\.")} instead\\.$`, "u"),
      );
      assert.equal(
        away!.findings[1]!.message,
        `A redirect from /moved tried to take the page to ${there}/. That is the same site at another address, which ra does not count as the app, so it was stopped. Look at ${there} instead.`,
      );

      // When the page loads, the other address is not the one to look at: one script from there gets the usual advice.
      const loads = await ra(["look", `http://app.localhost:${port}/loads`, "--json"], project);
      assert.equal(loads.status, 0, loads.err);
      const [stays] = (JSON.parse(loads.out) as { looks: Observation[] }).looks;
      assert.deepEqual(
        stays!.findings.map((finding) => finding.message),
        [
          `A redirect from /www.js tried to take the page's request for a script to ${there}/www.js. That is the same site at another address, which ra does not count as the app, so it was stopped. List www.app.localhost:${port} under block to stop it quietly, or under allow to let it through; no reply stands in for /www.js on a deployment.`,
        ],
      );
    } finally {
      deployment.closeAllConnections();
      deployment.close();
    }
  });
});

describe("ra snap and ra diff", () => {
  test("say what a change did", async () => {
    const copy = copySite();
    const snapped = await ra(["snap", "home", "--at", "desktop"], copy);
    assert.equal(snapped.status, 0, snapped.err);
    appendFileSync(join(copy, "site.css"), "\n.card h3 { font-size: 30px; }\n");
    const ran = await ra(["diff", "home", "--at", "desktop", "--json"], copy);
    assert.equal(ran.status, 0, ran.err);
    const [change] = (JSON.parse(ran.out) as { changes: Array<{ changed: boolean; lines: string[]; picture: string | null }> }).changes;
    assert.ok(change!.changed);
    assert.ok(change!.lines.some((line) => /^resized: .*taller/u.test(line)), change!.lines.join("\n"));
    assert.ok(change!.picture !== null && existsSync(change!.picture));
    const same = await ra(["diff", "home", "--at", "desktop"], copy);
    assert.match(same.out, /resized/u);
  });
});

describe("ra doctor", () => {
  test("starts and closes the browser", async () => {
    const ran = await ra(["doctor", "--json"]);
    assert.equal(ran.status, 0, ran.err);
    const report = JSON.parse(ran.out) as { ok: boolean; receipt: { version: string }; closedWorld: boolean | null };
    assert.equal(report.ok, true);
    assert.match(report.receipt.version, /^\d+\./u);
    assert.equal(report.closedWorld, true, "the trial reached the app and nothing else");
  });
});
