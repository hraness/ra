/**
 * ra run for real against the fixture site: a real browser, the real CLI.
 * Needs Chromium for the installed playwright-core:
 *   node node_modules/playwright-core/cli.js install chromium
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { serveStatic, type RunningApp } from "../src/app.ts";
import type { Observation } from "../src/observe.ts";

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

function ra(args: string[], cwd = site): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
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

  test("reports a page without a title or viewport", () => {
    assert.deepEqual(kinds(looks, "untitled", "phone"), ["document", "document"]);
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
    assert.match(leave.findings.find((finding) => finding.kind === "load")!.message, /sent outside its world/u);
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
    assert.match(ran.err, /There is no state named "nowhere"\. The states are: home, tricky, broken, untitled, outage, faulty, leave, detours/u);
  });
});

describe("the closed world", () => {
  test("stops a redirect to another port on this machine, and owns up to one that slips through an allowed host", async () => {
    const seen: string[] = [];
    const other = createServer((request, response) => {
      seen.push(request.url ?? "/");
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Other</title></head><body><main><h1>Reached</h1></main></body></html>');
    });
    await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
    const port = (other.address() as AddressInfo).port;
    try {
      const copy = copySite();
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
  },
});
`,
      );
      const ran = await ra(["check", "--json"], copy);
      assert.equal(ran.status, 1, ran.err);
      const found = (JSON.parse(ran.out) as { looks: Observation[] }).looks;
      assert.deepEqual(kinds(found, "escape", "desktop"), ["load", "outside"]);
      const escape = found.find((look) => look.state === "escape")!;
      assert.match(escape.findings.find((finding) => finding.kind === "outside")!.message, /^A redirect from \/escape tried to take the page to http:\/\/127\.0\.0\.1:\d+\/escaped, which is not in its world, and was stopped/u);
      assert.deepEqual(kinds(found, "slip", "desktop"), ["outside"]);
      const slip = found.find((look) => look.state === "slip")!;
      assert.match(slip.findings[0]!.message, /^A redirect from \/slip took the page to http:\/\/localhost:\d+\/secret, which its world does not allow, and the request went through, because localhost:\d+ is allowed/u);
      assert.deepEqual(
        seen.filter((path) => path !== "/favicon.ico"),
        ["/secret"],
        "only the hop the finding owns up to reached the other server",
      );
    } finally {
      other.closeAllConnections();
      other.close();
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
