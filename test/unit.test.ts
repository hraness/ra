/**
 * Everything that can be checked without a browser.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { serveStatic, startApp } from "../src/app.ts";
import { checkCommandLine, planLaunch, rejectInstalledChrome, resolveExecutable } from "../src/browser.ts";
import { ConfigError, loadProject, mergeWorlds, readConfig, resolveView } from "../src/config.ts";
import { contrastRatio, findLowContrast, neededRatio } from "../src/contrast.ts";
import { boxChanges, lineChanges } from "../src/diff.ts";
import type { Box } from "../src/inspect.ts";
import { verifyNativeFigure } from "../src/native.ts";
import { applyAccepts, type Finding, type Observation } from "../src/observe.ts";
import { outlineOf } from "../src/outline.ts";
import { comparePixels, decodePng, encodePng, frame, type Image } from "../src/png.ts";
import { checkText, lookText } from "../src/report.ts";
import { closeSessions, openSession } from "../src/run.ts";
import { allowsHost, closedWorldSwitches, findReply, isAppElsewhere, isOwnAddress, judge, reachableHosts, resolverSwitch, sameApp, startUpstreams, stoppedByClosedWorld } from "../src/world.ts";

const scratch = mkdtempSync(join(tmpdir(), "ra-unit-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe("a published native scene", () => {
  const scene = {
    name: "Week view", src: "/week.webp", alt: "Planning at 10",
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  };
  const readAsset = (src: string) => {
    assert.equal(src, "/week.webp");
    return Buffer.from("abc");
  };
  test("checks the selected image bytes and the captured description", async () => {
    await verifyNativeFigure("/guide", scene, { src: "/week.webp", alt: "Planning at 10" }, readAsset);
    await verifyNativeFigure("/guide", { ...scene, alt: undefined }, { src: "/week.webp" }, readAsset);
  });
  test("identifies a missing or swapped figure before reading its source", async () => {
    await assert.rejects(verifyNativeFigure("/guide", scene, null, readAsset), /\/guide \(Week view\).*missing/u);
    await assert.rejects(verifyNativeFigure("/guide", scene, { src: "/day.webp" }, readAsset), /expected image "\/week.webp", found "\/day.webp"/u);
  });
  test("rejects stale guide facts, substituted bytes and incomplete capture records", async () => {
    await assert.rejects(verifyNativeFigure("/guide", scene, { ...scene, alt: "Planning at 12" }, readAsset), /Planning at 10.*Planning at 12/u);
    await assert.rejects(verifyNativeFigure("/guide", scene, scene, () => Buffer.from("abd")), /has SHA-256.*expected/u);
    await assert.rejects(verifyNativeFigure("/guide", { ...scene, sha256: "" }, scene, readAsset), /capture needs/u);
    await assert.rejects(verifyNativeFigure("/guide", scene, scene, () => { throw Error("ENOENT"); }), /could not read.*week.webp/u);
  });
});

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
    assert.deepEqual(checkCommandLine([...good, "--proxy-server=http://127.0.0.1:1"], executable, [], ["--proxy-server=http://127.0.0.1:1"]), []);
    assert.deepEqual(checkCommandLine(good, executable, [], ["--proxy-server=http://127.0.0.1:1"]), ["The browser is running without --proxy-server=http://127.0.0.1:1."]);
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

  test("turns a state's scripts off without making it local, and takes only true or false for it", () => {
    const project = readConfig({ states: { bare: { url: "/", javascript: false } } }, scratch);
    assert.equal(project.states[0]!.javascript, false);
    assert.equal(project.states[0]!.local, false);
    // A string or a number is shown as written; anything else, which may not print, by its kind.
    for (const [value, said] of [["false", '"false"'], [1, "1"], [() => false, "a function"], [1n, "a bigint"], [null, "null"], [[true], "a list"]] as const) {
      assert.throws(
        () => readConfig({ states: { bare: { url: "/", javascript: value } } } as never, scratch),
        (error: unknown) => error instanceof ConfigError && error.message === `State "bare" has javascript set to ${said}; it takes true or false.`,
      );
    }
  });

  test("takes a timeout that a timer can wait for, and refuses one that would end every look at once", () => {
    assert.equal(readConfig({ states: { home: "/" }, timeout: 2_147_483_647 }, scratch).timeout, 2_147_483_647);
    for (const [value, said] of [[0, "0"], [-1, "-1"], [Infinity, "Infinity"], [2 ** 31, "2147483648"], [Number.NaN, "NaN"], ["30000", '"30000"'], [30_000n, "a bigint"]] as const) {
      assert.throws(
        () => readConfig({ states: { home: "/" }, timeout: value } as never, scratch),
        (error: unknown) =>
          error instanceof ConfigError && error.message === `The timeout is ${said}; it takes milliseconds above 0 and up to 2147483647, such as 30000.`,
      );
    }
  });

  test("says what is wrong with a view, whatever was given for it", () => {
    for (const [view, said] of [
      [null, "null"],
      [7, "7"],
      [{ name: "Kiosk", width: 1080, height: 1920 }, 'name "Kiosk", width 1080 and height 1920'],
      [{ name: "kiosk", width: 1080n, height: 1920 }, 'name "kiosk", width a bigint and height 1920'],
      [{ name: Symbol("kiosk"), width: 1080, height: 1920 }, "name a symbol, width 1080 and height 1920"],
    ] as const) {
      assert.throws(
        () => readConfig({ views: [view], states: { home: "/" } } as never, scratch),
        (error: unknown) => error instanceof ConfigError && error.message === `A view needs a lowercase name, a width and a height; got ${said}.`,
      );
    }
  });

  test("refuses a rule or an answer it cannot use when the config loads, and says how to write it", () => {
    const load = (world: object) => () => readConfig({ world, states: { home: "/" } } as never, scratch);
    assert.throws(load({ replies: { "get /api/me": { json: {} } } }), /^ConfigError: world\.replies: "get \/api\/me" needs its method in capitals, as in "GET \/api\/me"\.$/u);
    assert.throws(load({ replies: { "GET api/me": { json: {} } } }), /reads as a host named "api"; a path on the app starts with "\/", as in "GET \/api\/me"/u);
    assert.throws(load({ replies: { "GET /a /b": { json: {} } } }), /more in it than a method and an address/u);
    assert.throws(load({ replies: { "/api/me": { jsn: {} } } }), /the answer for "\/api\/me" has an unknown setting "jsn"; the settings are status, json, body, type, headers/u);
    assert.throws(load({ replies: { "/api/me": { status: 99 } } }), /has status 99, which is not a number from 100 to 599/u);
    assert.throws(load({ replies: { "/api/me": { json: {}, body: "x" } } }), /both json and body/u);
    assert.throws(load({ block: ["post /beacon"] }), /world\.block: "post \/beacon" needs its method in capitals/u);
    assert.throws(load({ allow: ["https:/fonts.example.com"] }), /world\.allow: "https:\/fonts\.example\.com" names no host ra can read; write a host such as "api\.example\.com"/u);
    assert.throws(load({ upstreams: { content: { "https://cms.example.com/articles": { json: [] } } } }), /world\.upstreams\.content: "https:\/\/cms\.example\.com\/articles" is not a path/u);
    assert.throws(load({ upstreams: { "my content": {} } }), /cannot be used as \{upstream\.my content\}/u);
    assert.throws(
      () => readConfig({ states: { home: { url: "/", world: { replies: { "get /x": { json: 1 } } } } } }, scratch),
      /State "home" world\.replies: "get \/x" needs its method in capitals/u,
    );
    assert.doesNotThrow(
      load({
        replies: { "GET /api/me": () => ({ json: {} }), "https://api.example.com/**": { body: new Uint8Array([1]), type: "image/png" }, "*.cdn.example": { status: 204 } },
        allow: ["localhost:8080/**", "fonts.gstatic.com", "*"],
        block: ["/ph/**", "POST https://*.tracker.example/**"],
        upstreams: { content: { "GET /articles": { json: [] } } },
      }),
    );
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

  test("against a deployment, lets the deployment answer for itself, and still applies blocks to it", () => {
    const live = "https://www.example.com";
    const world = { replies: { "/api/me": { json: {} }, "https://*.example.com/**": { json: [] } }, block: ["/ph/**"] };
    const on = (address: string, method = "GET") => judge(world, live, method, new URL(address), { live: true });
    assert.equal(on("https://www.example.com/api/me"), "app");
    assert.equal(on("https://www.example.com/anything"), "app", "a host rule that names the deployment does not stand in for it");
    assert.equal(on("https://api.example.com/v1"), "replied", "the same rule still answers for other hosts");
    assert.equal(on("https://www.example.com/ph/e", "POST"), "blocked");
    assert.equal(judge(world, live, "GET", new URL("https://www.example.com/api/me")), "replied", "on this machine, a reply comes first");
  });

  test("sends what routing never sees to a proxy that refuses it, except the app and the allowed hosts", () => {
    const hosts = reachableHosts([{ allow: ["https://fonts.example.com/**", "/local/path", "GET *.cdn.example", "localhost:8080/api/**"] }])!;
    assert.deepEqual(hosts, ["fonts.example.com", "*.cdn.example", "localhost:8080"]);
    assert.deepEqual(closedWorldSwitches("http://127.0.0.1:4000", hosts), [
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE *.localhost , EXCLUDE 127.0.0.1 , EXCLUDE ::1 , EXCLUDE 0.0.0.0 , EXCLUDE fonts.example.com , EXCLUDE *.cdn.example",
      "--proxy-server=http://127.0.0.1:1",
      "--proxy-bypass-list=<-loopback>;127.0.0.1:4000;localhost:4000;[::1]:4000;0.0.0.0:4000;fonts.example.com;*.cdn.example;localhost:8080",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    ]);
    // A deployment's entry names its port even when it is the default, since one without a port lets every port through.
    const deployment = closedWorldSwitches("https://www.example.com", []);
    assert.match(deployment[0]!, /EXCLUDE www\.example\.com$/u);
    assert.equal(deployment[2], "--proxy-bypass-list=<-loopback>;www.example.com:443");
    assert.equal(closedWorldSwitches("http://app.example.com:8080", [])[2], "--proxy-bypass-list=<-loopback>;app.example.com:8080");
  });

  test("knows which addresses the browser lets through as the app's own", () => {
    assert.equal(isOwnAddress(new URL("https://www.example.com/a"), "https://www.example.com"), true);
    assert.equal(isOwnAddress(new URL("https://www.example.com:443/a"), "https://www.example.com"), true, "the default port, named");
    assert.equal(isOwnAddress(new URL("http://www.example.com:8080/a"), "https://www.example.com"), false, "another port of the same host");
    assert.equal(isOwnAddress(new URL("https://api.example.com/a"), "https://www.example.com"), false);
    assert.equal(isOwnAddress(new URL("http://localhost:5000/a"), "http://127.0.0.1:5000"), true, "any loopback name");
    assert.equal(isOwnAddress(new URL("http://[::1]:5000/a"), "http://0.0.0.0:5000"), true);
    assert.equal(isOwnAddress(new URL("https://127.0.0.1:5000/a"), "http://127.0.0.1:5000"), true, "the browser goes by host and port, whatever the scheme");
    assert.equal(isOwnAddress(new URL("http://127.0.0.1:5001/a"), "http://127.0.0.1:5000"), false);
  });

  test("says a failed request was stopped only when the closed world stopped it", () => {
    const origin = "http://127.0.0.1:5000";
    const hosts = ["api.example.com", "cdn.example.com:8443"];
    const stopped = (url: string, error: string, reachable: readonly string[] | null = hosts) => stoppedByClosedWorld(new URL(url), error, origin, reachable);
    assert.equal(stopped("https://other.example.com/a", "net::ERR_TUNNEL_CONNECTION_FAILED"), true, "the proxy refused it");
    assert.equal(stopped("https://api.example.com/a", "net::ERR_TUNNEL_CONNECTION_FAILED"), true, "a refusal by the proxy is the last word");
    assert.equal(stopped("https://api.example.com/a", "net::ERR_NAME_NOT_RESOLVED"), false, "an allowed host failed by itself");
    assert.equal(stopped("http://localhost:5000/a", "net::ERR_CONNECTION_REFUSED"), false, "the app's own address");
    assert.equal(stopped("https://cdn.example.com:8443/a", "net::ERR_CONNECTION_RESET"), false, "an allowed host on the port its rule names");
    assert.equal(stopped("https://cdn.example.com/a", "net::ERR_ABORTED"), true, "another port of a host allowed on one port only");
    assert.equal(stopped("http://other.example.com:6000/a", "net::ERR_UNSAFE_PORT"), true, "the browser refused it before the proxy could");
    assert.equal(stopped("https://other.example.com/a", "net::ERR_TUNNEL_CONNECTION_FAILED", null), false, "nothing is stopped when every host is let through");
  });

  test("knows the app's own site at another address", () => {
    assert.equal(isAppElsewhere(new URL("https://example.com/"), "http://example.com"), true, "upgraded to https");
    assert.equal(isAppElsewhere(new URL("https://www.example.com/a"), "https://example.com"), true, "with www.");
    assert.equal(isAppElsewhere(new URL("https://example.com/a"), "http://www.example.com"), true, "upgraded, without www.");
    assert.equal(isAppElsewhere(new URL("https://example.com/a"), "https://example.com"), false, "the app itself");
    assert.equal(isAppElsewhere(new URL("http://example.com/a"), "https://example.com"), false, "downgraded");
    assert.equal(isAppElsewhere(new URL("https://example.com:8443/a"), "https://example.com"), false, "another port");
    assert.equal(isAppElsewhere(new URL("https://app.example.com/a"), "https://example.com"), false, "another host");
    assert.equal(isAppElsewhere(new URL("http://www.app.localhost:5000/"), "http://app.localhost:5000"), true);
  });

  test("lets an app on this machine through by any loopback name it is given as", () => {
    for (const origin of ["http://0.0.0.0:5000", "http://[::1]:5000", "http://localhost:5000"]) {
      const [resolver, , bypass] = closedWorldSwitches(origin, []);
      // Chromium compares resolver rules with the bare host, so the IPv6 address has no brackets there.
      assert.equal(resolver, "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE *.localhost , EXCLUDE 127.0.0.1 , EXCLUDE ::1 , EXCLUDE 0.0.0.0", origin);
      assert.equal(bypass, "--proxy-bypass-list=<-loopback>;127.0.0.1:5000;localhost:5000;[::1]:5000;0.0.0.0:5000", origin);
    }
    const six = closedWorldSwitches("http://[2001:db8::1]:8443", ["[2001:db8::2]:9000"]);
    assert.match(six[0]!, /EXCLUDE 2001:db8::1 , EXCLUDE 2001:db8::2$/u);
    assert.equal(six[2], "--proxy-bypass-list=<-loopback>;[2001:db8::1]:8443;[2001:db8::2]:9000");
  });

  test("knows which hosts a world lets the browser reach, whatever the path", () => {
    const world = { allow: ["https://fonts.example.com/css/**", "localhost:8080/api/**", "GET *.cdn.example"] };
    assert.equal(allowsHost(world, new URL("https://fonts.example.com/other")), true, "the browser cannot tell paths apart");
    assert.equal(allowsHost(world, new URL("http://localhost:8080/elsewhere")), true);
    assert.equal(allowsHost(world, new URL("http://localhost:9090/api/x")), false, "a rule with a port names that port only");
    assert.equal(allowsHost(world, new URL("https://img.cdn.example/a.png")), true);
    assert.equal(allowsHost(world, new URL("https://example.com/")), false);
    assert.equal(allowsHost({ allow: ["https://api.example.com:443/**"] }, new URL("https://api.example.com/v1")), true, "the default port, named");
    assert.equal(allowsHost({ allow: ["*"] }, new URL("https://example.com/")), true);
    assert.equal(allowsHost({}, new URL("https://example.com/")), false);
  });

  test("a stand-in answers with text or bytes, and says when a reply gives no answer", async () => {
    const upstreams = await startUpstreams(["api"]);
    try {
      upstreams.use({ upstreams: { api: { "GET /bad": () => ({ jsn: 1 }) as never, "GET /bytes": { body: new Uint8Array([104, 105]) } } } });
      const bad = await fetch(`${upstreams.urls.api}/bad`);
      assert.equal(bad.status, 500);
      assert.match(await bad.text(), /The world's reply for GET \/bad gave an answer that has an unknown setting "jsn"/u);
      const bytes = await fetch(`${upstreams.urls.api}/bytes`);
      assert.equal(await bytes.text(), "hi");
      assert.equal(bytes.headers.get("content-type"), "application/octet-stream");
      const none = await fetch(`${upstreams.urls.api}/none`);
      assert.equal(none.status, 501);
      assert.deepEqual(upstreams.drain().map((call) => call.outcome), ["replied", "replied", "unexpected"]);
    } finally {
      await upstreams.close();
    }
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

describe("the app", () => {
  const appModule = fileURLToPath(new URL("../src/app.ts", import.meta.url));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (done: () => boolean, ms: number, what: string) => {
    const deadline = Date.now() + ms;
    while (!done()) {
      if (Date.now() > deadline) assert.fail(what);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  /** A command that leaves a process in the background, writes its pid down, then serves on PORT. */
  const serving = (pids: string) =>
    `sleep 300 & echo $! > ${pids}; exec node -e "require('node:http').createServer((q, s) => s.end('ok')).listen(process.env.PORT, '127.0.0.1')"`;

  test("stops everything its command started, background jobs included", async () => {
    const pids = join(scratch, "pids-stop");
    const app = await startApp({ command: serving(pids), timeout: 30 }, { root: scratch });
    assert.equal(await (await fetch(app.origin)).text(), "ok");
    const sleeper = Number(readFileSync(pids, "utf8"));
    assert.ok(alive(sleeper));
    await app.stop();
    await until(() => !alive(sleeper), 2000, "the background job outlived the app");
    await app.stop();
  });

  test("leaves nothing behind when the command exits before the app answers", async () => {
    const pids = join(scratch, "pids-exit");
    await assert.rejects(startApp({ command: `sleep 300 & echo $! > ${pids}; echo giving up; exit 3`, timeout: 30 }, { root: scratch }), /The app stopped before it answered .*giving up/su);
    await until(() => !alive(Number(readFileSync(pids, "utf8"))), 2000, "the background job outlived the command");
  });

  test("is stopped when ra is killed outright", async () => {
    const pids = join(scratch, "pids-killed");
    const host = join(scratch, "host.mts");
    writeFileSync(
      host,
      `import { startApp } from ${JSON.stringify(appModule)};
await startApp({ command: ${JSON.stringify(serving(pids))}, timeout: 30 }, { root: ${JSON.stringify(scratch)} });
process.stdout.write("ready\\n");
setInterval(() => undefined, 1000);
`,
    );
    const child = spawn(process.execPath, [host], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => chunk.toString().includes("ready") && resolve());
      child.once("exit", (code) => reject(new Error(`the stand-in for ra exited with ${code}`)));
    });
    const sleeper = Number(readFileSync(pids, "utf8"));
    child.kill("SIGKILL");
    await until(() => !alive(sleeper), 5000, "the app outlived a killed ra");
  });

  test("is stopped when ra is interrupted while the app is still starting", async () => {
    const project = mkdtempSync(join(scratch, "interrupted-"));
    const pids = join(project, "pids");
    writeFileSync(join(project, "ra.config.ts"), `export default { app: { command: ${JSON.stringify(`sleep 300 & echo $! > ${pids}; sleep 300`)}, timeout: 60 }, states: { home: "/" } };\n`);
    const child = spawn(process.execPath, [cli, "check"], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    await until(() => existsSync(pids) && readFileSync(pids, "utf8").trim() !== "", 10_000, "the app never started");
    const sleeper = Number(readFileSync(pids, "utf8"));
    child.kill("SIGINT");
    assert.equal(await exited, 130);
    assert.equal(err, "", "an interrupt is not an error");
    await until(() => !alive(sleeper), 5000, "the app outlived an interrupted ra");
  });

  test("closing every session waits for one that is still starting its app, and stops the app", async () => {
    const project = mkdtempSync(join(scratch, "opening-"));
    const pids = join(project, "pids");
    writeFileSync(join(project, "ra.config.ts"), `export default { app: { command: ${JSON.stringify(`sleep 300 & echo $! > ${pids}; sleep 300`)}, timeout: 60 }, states: { home: "/" } };\n`);
    const opening = openSession(await loadProject(project));
    const refused = assert.rejects(opening, /^AppError: ra stopped the app before it answered \(.*\), because the run was closing\.$/su);
    await until(() => existsSync(pids) && readFileSync(pids, "utf8").trim() !== "", 10_000, "the app never started");
    const sleeper = Number(readFileSync(pids, "utf8"));
    await closeSessions();
    // The keeper exits once the app's whole group is gone; allow a moment for the system to reap it.
    await until(() => !alive(sleeper), 1000, "closeSessions returned while the app was still running");
    await refused;
  });

  test("a static file that cannot be read fails that response, and the server keeps going", async (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root can read any file");
      return;
    }
    const root = mkdtempSync(join(scratch, "static-"));
    writeFileSync(join(root, "index.html"), "ok");
    writeFileSync(join(root, "locked.html"), "no");
    chmodSync(join(root, "locked.html"), 0o000);
    const app = await serveStatic(root);
    try {
      await assert.rejects(fetch(`${app.origin}/locked`).then((response) => response.text()));
      assert.equal(await (await fetch(`${app.origin}/`)).text(), "ok");
    } finally {
      await app.stop();
    }
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

  /** A look with everything the printed text reads. */
  const whole = (findings: Finding[]): Observation =>
    ({
      state: "list",
      view: "desktop",
      url: "http://127.0.0.1:1/list",
      status: 200,
      title: "List",
      viewport: { width: 1440, height: 900 },
      page: { width: 1440, height: 1200 },
      requests: { total: 1, replied: 0, allowed: 0, blocked: 0, unexpected: 0 },
      ms: 1000,
      findings,
      notes: [],
      outline: [],
      outlineFull: 0,
      regions: [],
      picture: null,
      fullPicture: null,
    }) as unknown as Observation;
  /** A text that is too pale, worded as a look words it. */
  const pale = (text: string, colour = "#828282"): Finding => ({
    kind: "contrast",
    message: `"${text}" has 3.5:1 contrast (${colour} on #f6f6ef); text this size needs 4.5:1.`,
    where: `span.row "${text}"`,
    selector: "",
  });
  const rows = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"].map((name) => `Row ${name}`);
  const contrastLines = (text: string) => text.split("\n").filter((line) => line.startsWith("  contrast  "));

  test("a look names the first ten texts of one colour and counts the rest", () => {
    const text = lookText(
      whole([
        finding("no-name", "2 controls have no accessible name, starting with a."),
        ...rows.map((row) => pale(row)),
        pale("Another colour", "#999999"),
        finding("spill", '"Supercalifragilistic" runs 119px past the right edge of its box, div.tight.'),
      ]),
    );
    // Every finding is still counted, and the ones of other kinds and colours are all printed.
    assert.match(text, /\n15 findings\n/u);
    assert.equal(contrastLines(text).length, 11, text);
    assert.match(text, / {2}no-name {3}2 controls have no accessible name, starting with a\.\n/u);
    assert.match(text, / {2}spill {5}"Supercalifragilistic" runs 119px/u);
    // The count sits under the tenth text, where "the same colours" has something to point at.
    assert.ok(
      text.includes(
        '  contrast  "Row ten" has 3.5:1 contrast (#828282 on #f6f6ef); text this size needs 4.5:1.\n'
          + '            at span.row "Row ten"\n'
          + "            2 more texts have the same colours. --json lists every one.\n"
          + '  contrast  "Another colour" has 3.5:1 contrast (#999999 on #f6f6ef); text this size needs 4.5:1.\n',
      ),
      text,
    );
    assert.doesNotMatch(text, /Row eleven|Row twelve/u);
  });

  test("a look prints ten texts of one colour whole, and says so in the singular for an eleventh", () => {
    const ten = lookText(whole(rows.slice(0, 10).map((row) => pale(row))));
    assert.equal(contrastLines(ten).length, 10, ten);
    assert.doesNotMatch(ten, /the same colours/u);
    const eleven = lookText(whole(rows.slice(0, 11).map((row) => pale(row))));
    assert.equal(contrastLines(eleven).length, 10, eleven);
    assert.match(eleven, /\n {12}1 more text has the same colours\. --json lists every one\.$/u);
  });

  test("a look counts each colour by itself, whatever the texts quote, and leaves accepted findings out of the count", () => {
    // Two colours, turn about, and one text that quotes a contrast finding's own words.
    const mixed = rows.flatMap((row) => [pale(row), pale(`${row}" has 9:1 contrast (#000000 on #ffffff); text this size needs 3:1. "`, "#999999")]);
    const text = lookText(whole(mixed));
    assert.match(text, /\n24 findings\n/u);
    assert.equal(contrastLines(text).length, 20, text);
    assert.equal(text.split("2 more texts have the same colours.").length - 1, 2, text);
    // An accepted finding is printed as accepted, and is not one of the ten.
    const accepted = lookText(whole(rows.slice(0, 11).map((row, index) => (index === 0 ? { ...pale(row), accepted: "Decorative." } : pale(row)))));
    assert.match(accepted, /\n10 findings\n/u);
    assert.equal(contrastLines(accepted).length, 10, accepted);
    assert.doesNotMatch(accepted, /the same colours/u);
    assert.match(accepted, / {2}accepted contrast: "Row one" has 3\.5:1 contrast .* \(Decorative\.\)/u);
  });

  test("a check report names ten texts of one colour for each set of views, and counts every finding", () => {
    const states = [{ name: "list", url: "/list" }] as never;
    const receipt = { executable: "/x/chromium-1/chrome", version: "1.0", playwright: "1.0.0", disabledFeatures: [], muted: true as const };
    const options = { origin: "http://127.0.0.1:1", live: false, ms: 1000, receipt, notes: [], skipped: [], unused: [] };
    // Twelve texts at both views, and twelve more that are pale only at phone.
    const everywhere = rows.map((row) => pale(row));
    const phoneOnly = rows.map((row) => pale(`${row}, small`));
    const summary = checkText(states, [look("list", "desktop", everywhere), look("list", "phone", [...everywhere, ...phoneOnly])], options);
    assert.equal(summary.ok, false);
    assert.equal(summary.findings, 24);
    assert.equal(contrastLines(summary.text).length, 20, summary.text);
    assert.ok(
      summary.text.includes('  contrast  "Row ten" has 3.5:1 contrast (#828282 on #f6f6ef); text this size needs 4.5:1.\n            at span.row "Row ten"\n            2 more texts have the same colours. --json lists every one.\n'),
      summary.text,
    );
    assert.ok(
      summary.text.includes('  contrast  "Row ten, small" has 3.5:1 contrast (#828282 on #f6f6ef); text this size needs 4.5:1. [phone]\n            at span.row "Row ten, small"\n            2 more texts have the same colours. --json lists every one. [phone]\n'),
      summary.text,
    );
    assert.match(summary.text, /24 findings in 1 of 1 state\. Look closer: ra look list --at desktop/u);
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

  test("a check report prints every state's notes, counts them, and shows a failing state whole", () => {
    const states = [{ name: "home", url: "/" }, { name: "long", url: "/long" }] as never;
    const receipt = { executable: "/x/chromium-1/chrome", version: "1.0", playwright: "1.0.0", disabledFeatures: [], muted: true as const };
    const accepted = { ...finding("contrast", "Faint text on the hero"), accepted: "The hero is decorative." };
    const options = { origin: "http://127.0.0.1:1", live: false, ms: 1000, receipt, notes: [], skipped: [], unused: [] };
    const long = { ...look("long", "desktop", []), notes: ["The page is very long."] } as Observation;
    const failing = checkText(states, [look("home", "desktop", [finding("console", "The console logged an error: boom"), accepted]), long], options);
    assert.match(failing.text, /✗ home {2}\/\n {2}console {2}The console logged an error: boom\n {2}accepted contrast: Faint text on the hero \(The hero is decorative\.\)\n/u);
    assert.match(failing.text, /✓ long\n {2}note: The page is very long\.\n/u);
    assert.match(failing.text, /1 finding in 1 of 2 states, with 1 note\. Look closer/u);
    const passing = checkText(states, [look("home", "desktop", [accepted]), long], options);
    assert.match(passing.text, /✓ home {2}\(1 accepted\)\n✓ long\n {2}note: The page is very long\.\n\nAll 2 states look right, with 1 note\.\n/u);
  });
});

describe("docs", () => {
  test("the README installs and verifies the release that package.json names", () => {
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    const { version } = JSON.parse(read("../package.json")) as { version: string };
    const readme = read("../README.md");
    const tarball = `https://github.com/hraness/ra/releases/download/v${version}/hraness-ra-${version}.tgz`;
    for (const line of [`npm install -D ${tarball} playwright-core\n`, `bun add -d ${tarball} playwright-core\n`, `gh release verify-asset v${version} hraness-ra-${version}.tgz -R hraness/ra\n`]) {
      assert.ok(readme.includes(line), `README.md should have this line for ${version}: ${line}`);
    }
    const named = [...readme.matchAll(/\bv(\d+\.\d+\.\d+)\b|hraness-ra-(\d+\.\d+\.\d+)\.tgz/gu)].map((match) => match[1] ?? match[2]);
    assert.deepEqual([...new Set(named)], [version], "README.md names a release other than the one in package.json");
  });
});
