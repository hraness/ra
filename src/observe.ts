/**
 * Looking at one state through one view: reach it inside its world, wait for
 * it to hold still, then write down what is there and what is wrong with it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page, Request } from "playwright-core";
import type { Accept, Call, Project, Reached, State, View } from "./config.ts";
import { findLowContrast } from "./contrast.ts";
import { inspectPage, type Box, type InspectOptions, type Region } from "./inspect.ts";
import { outlineOf } from "./outline.ts";
import { decodePng } from "./png.ts";
import { allowsHost, closeWorld, isOwnAddress, judge, sameApp, type Verdict } from "./world.ts";

export interface Finding {
  /** What sort of problem this is, such as `cut-off` or `contrast`. */
  kind: string;
  /** The problem, in a sentence. */
  message: string;
  /** A short description of the element, when there is one. */
  where: string;
  /** A CSS selector for the element, when there is one. */
  selector: string;
  /** Why the project accepts this finding, when it does. */
  accepted?: string;
}

export interface Observation {
  state: string;
  view: string;
  /** When the look was taken. */
  at: string;
  /** Where the page ended up. */
  url: string;
  title: string;
  status: number | null;
  viewport: { width: number; height: number };
  page: { width: number; height: number };
  /** The accessibility outline, shortened. */
  outline: string[];
  /** How many lines the outline has in full. */
  outlineFull: number;
  regions: Region[];
  boxes: Box[];
  findings: Finding[];
  notes: string[];
  requests: { total: number; replied: number; allowed: number; blocked: number; unexpected: number };
  calls: Call[];
  /** Milliseconds from opening the page to having looked. */
  ms: number;
  /** The picture of the first screen, or of the scoped element. */
  picture: string | null;
  /** The picture of the whole page. */
  fullPicture: string | null;
  /** What the `then` code returned, when it returned something. */
  returned?: string;
}

export interface ObserveOptions {
  browser: Browser;
  project: Project;
  /** Where the app answers. */
  origin: string;
  /** The app is a deployment, which answers its own requests. */
  live?: boolean;
  state: State;
  view: View;
  /** Where pictures are written. Without it, no pictures are kept. */
  directory?: string;
  /** A selector to narrow the outline, the picture and the findings to. */
  scope?: string;
  /** Code to run once the state is reached, with `page` in scope. */
  then?: string;
  /** The most outline lines to keep. */
  lines?: number;
  /** Requests the app's own server made while this state was open. */
  upstreamCalls?: () => Call[];
  /** Told which accept entries matched a finding. */
  accepted?: (used: Accept[]) => void;
}

const BACKGROUND = new Set(["websocket", "eventsource", "media", "ping"]);
const BARE =
  "*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; -webkit-text-stroke-color: transparent !important; text-decoration-color: transparent !important; }";
const TALLEST = 12_000;

function firstLine(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\u001b\[[0-9;]*m/gu, "");
  // Playwright follows its message with a call log; the message is enough.
  const message = text.split(/\n\s*Call log:/u)[0]!;
  return message.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 3).join(" ");
}

function brief(url: string, origin: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + (parsed.search.length > 40 ? `${parsed.search.slice(0, 40)}…` : parsed.search);
    return sameApp(parsed, origin) ? path : parsed.origin + path;
  } catch {
    return url;
  }
}

/** Marks findings the project has decided to live with, and returns the accept entries that were used. */
export function applyAccepts(findings: Finding[], accept: readonly Accept[]): Accept[] {
  const used = new Set<Accept>();
  for (const finding of findings) {
    const rule = accept.find((entry) => {
      if (entry.finding !== finding.kind) return false;
      if (entry.match === undefined) return true;
      const text = `${finding.message} ${finding.where}`;
      return typeof entry.match === "string" ? text.includes(entry.match) : entry.match.test(text);
    });
    if (rule === undefined) continue;
    finding.accepted = rule.why;
    used.add(rule);
  }
  return [...used];
}

const ASKED_FOR: Record<string, string> = {
  script: "a script",
  stylesheet: "a stylesheet",
  image: "an image",
  font: "a font",
  media: "media",
  fetch: "data",
  xhr: "data",
  websocket: "a socket",
  eventsource: "an event stream",
  manifest: "a manifest",
};

/* v8 ignore next 30 -- runs in the page */
async function holdStill(cap: number): Promise<boolean> {
  const started = performance.now();
  const left = () => cap - (performance.now() - started);
  await Promise.race([document.fonts.ready, new Promise((done) => setTimeout(done, Math.max(0, left())))]);
  await new Promise<void>((done) => {
    let timer = setTimeout(finish, 120);
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      if (left() <= 0) finish();
      else timer = setTimeout(finish, 120);
    });
    function finish() {
      observer.disconnect();
      done();
    }
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    setTimeout(finish, Math.max(0, left()));
  });
  await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  return left() <= 0;
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...names: string[]) => (
  ...values: unknown[]
) => Promise<unknown>;

/** Looks at one state through one view. Never throws for a page that misbehaves; that becomes a finding. */
export async function observe(options: ObserveOptions): Promise<Observation> {
  const { browser, project, origin, state, view } = options;
  const started = performance.now();
  const calls: Call[] = [];
  const findings: Finding[] = [];
  const notes: string[] = [];
  const add = (kind: string, message: string, where = "", selector = "") => findings.push({ kind, message, where, selector });
  const address = new URL(state.url, `${origin}/`).href;
  const host = new URL(origin).hostname;

  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: view.scale,
    isMobile: view.touch,
    hasTouch: view.touch,
    colorScheme: view.scheme,
    reducedMotion: view.motion ? "no-preference" : "reduce",
    serviceWorkers: "block",
    locale: project.locale,
    timezoneId: project.timezone,
    storageState: {
      cookies: Object.entries(state.cookies ?? {}).map(([name, value]) => ({
        name,
        value,
        domain: host,
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: "Lax" as const,
      })),
      origins:
        state.storage === undefined
          ? []
          : [{ origin, localStorage: Object.entries(state.storage).map(([name, value]) => ({ name, value })) }],
    },
  });
  const observation: Observation = {
    state: state.name,
    view: view.name,
    at: new Date().toISOString(),
    url: address,
    title: "",
    status: null,
    viewport: { width: view.width, height: view.height },
    page: { width: view.width, height: view.height },
    outline: [],
    outlineFull: 0,
    regions: [],
    boxes: [],
    findings,
    notes,
    requests: { total: 0, replied: 0, allowed: 0, blocked: 0, unexpected: 0 },
    calls,
    ms: 0,
    picture: null,
    fullPicture: null,
  };

  try {
    if (state.session !== undefined) {
      await context.addInitScript(
        ({ entries }) => {
          for (const [key, value] of entries) if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, value);
        },
        { entries: Object.entries(state.session) },
      );
    }
    const refused: string[] = [];
    const live = options.live === true;
    const verdictOf = (request: Request): Verdict | null => {
      try {
        const url = new URL(request.url());
        return url.protocol === "http:" || url.protocol === "https:" ? judge(state.world, origin, request.method(), url, { live }) : null;
      } catch {
        return null;
      }
    };
    const onApp = (url: string): boolean => {
      try {
        return sameApp(new URL(url), origin);
      } catch {
        return false;
      }
    };
    // A deployment answers its own paths, so no reply can stand in for one of them.
    const replyable = (url: string): boolean => !(live && onApp(url));
    await closeWorld(context, { world: state.world, origin, live, calls, onReplyError: (message) => refused.push(message) });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(project.timeout);
    page.setDefaultTimeout(Math.min(project.timeout, 10_000));

    const pending = new Set<Request>();
    let lastActivity = performance.now();
    const consoleErrors = new Map<string, number>();
    let document: Request | null = null;
    // The browser follows a redirect by itself, so routing never sees its
    // later hops. The closed world's proxy stops a hop that leaves the app and
    // its allowed hosts; each hop is judged here so that it can be reported.
    const hops = new Map<Request, Verdict>();
    const startOf = (request: Request): string => {
      let first = request;
      while (first.redirectedFrom() !== null) first = first.redirectedFrom()!;
      return first.url();
    };
    // A hop was answered, stopped by the closed world's proxy, or let through
    // and then failed some other way, such as a refused connection.
    const settleHop = (request: Request, fate: "answered" | "stopped" | "failed"): boolean => {
      const verdict = hops.get(request);
      if (verdict === undefined) return false;
      hops.delete(request);
      const via = startOf(request);
      const from = brief(via, origin);
      const call: Call = { from: "page", type: request.resourceType(), method: request.method(), url: request.url(), body: null, outcome: "unexpected", via };
      if (verdict === "replied") {
        const fix = replyable(via)
          ? `Give ${from} the reply instead`
          : `No reply stands in for ${from} on a deployment, so block ${from}, or look at the app on this machine, where ${from} can have the reply`;
        refused.push(
          `${request.method()} ${brief(request.url(), origin)} has a reply, but the page reached it through a redirect from ${from}, which the browser follows by itself, so ${fate === "answered" ? "the real address answered" : "the request failed"}. ${fix}`,
        );
      } else if (verdict === "blocked" && fate === "stopped") {
        calls.push({ ...call, outcome: "blocked" });
      } else {
        calls.push(fate === "stopped" ? call : { ...call, reached: true });
      }
      return true;
    };
    page.on("request", (request) => {
      observation.requests.total++;
      lastActivity = performance.now();
      if (!BACKGROUND.has(request.resourceType())) pending.add(request);
      if (request.redirectedFrom() === null) return;
      const verdict = verdictOf(request);
      if (verdict === "allowed") calls.push({ from: "page", type: request.resourceType(), method: request.method(), url: request.url(), body: null, outcome: "allowed", via: startOf(request) });
      else if (verdict !== null && verdict !== "app") hops.set(request, verdict);
    });
    page.on("requestfinished", (request) => {
      pending.delete(request);
      lastActivity = performance.now();
    });
    page.on("requestfailed", (request) => {
      pending.delete(request);
      lastActivity = performance.now();
      const reason = request.failure()?.errorText ?? "";
      // A hop counts as stopped only when the closed world's proxy refused it.
      // That refusal comes at once, so a hop that failed some other way had
      // been let through; when in doubt, a false alarm beats false comfort.
      if (settleHop(request, /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/u.test(reason) ? "stopped" : "failed")) return;
      if (/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/u.test(reason)) return;
      if (/ERR_NAME_NOT_RESOLVED|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/u.test(reason) && verdictOf(request) === "unexpected") {
        // Routing never saw this one, and the closed world stopped it.
        calls.push({ from: "page", type: request.resourceType(), method: request.method(), url: request.url(), body: null, outcome: "unexpected" });
        return;
      }
      refused.push(`${request.method()} ${brief(request.url(), origin)} failed (${reason.replace(/^net::/u, "")})`);
    });
    page.on("response", (response) => {
      const request = response.request();
      settleHop(request, "answered");
      if (request === document || response.status() < 400) return;
      // An error the world was told to give is the state, not a problem.
      if (verdictOf(request) === "replied" && request.redirectedFrom() === null) return;
      refused.push(`${request.method()} ${brief(response.url(), origin)} answered ${response.status()}`);
    });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (/^Failed to load resource/u.test(text)) return;
      consoleErrors.set(text, (consoleErrors.get(text) ?? 0) + 1);
    });
    page.on("pageerror", (error) => {
      const text = `Uncaught ${error.name}: ${error.message}`;
      consoleErrors.set(text, (consoleErrors.get(text) ?? 0) + 1);
    });

    let stillLoading: string[] = [];
    let stillChanging = false;
    const settle = async () => {
      const deadline = performance.now() + project.settle;
      for (let round = 0; round < 2; round++) {
        for (;;) {
          if (pending.size === 0 && performance.now() - lastActivity >= 200) break;
          if (performance.now() > deadline) {
            stillLoading = [...pending].slice(0, 3).map((request) => `${request.method()} ${brief(request.url(), origin)}`);
            break;
          }
          await new Promise((done) => setTimeout(done, 40));
        }
        stillChanging = await page.evaluate(holdStill, Math.max(300, Math.min(2500, deadline - performance.now()))).catch(() => false);
        if (pending.size === 0) break;
      }
    };

    if (state.clock !== undefined) await page.clock.setFixedTime(state.clock);
    const reached: Reached = { state: state.name, view: view.name, origin, calls };
    let loaded = false;
    try {
      page.once("request", (request) => {
        document = request;
      });
      const response = await page.goto(address, { waitUntil: "load" });
      observation.status = response?.status() ?? null;
      loaded = true;
    } catch (error) {
      const reason = firstLine(error).replace(/^page\.goto: /u, "");
      // When the closed world stopped a redirect of the page itself, say where it led and which finding says more.
      let last = document as Request | null;
      while (last?.redirectedTo() != null) last = last.redirectedTo();
      const stopped = /ERR_NAME_NOT_RESOLVED|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/u.test(reason) && last?.redirectedFrom() != null;
      if (!stopped || last === null) {
        add("load", `The page did not load: ${reason}`);
      } else {
        const from = brief(startOf(last), origin);
        const to = brief(last.url(), origin);
        const verdict = verdictOf(last);
        add(
          "load",
          verdict === "blocked"
            ? `The page did not load, because a redirect from ${from} took it to ${to}, which its world blocks (${reason}).`
            : verdict === "replied"
              ? `The page did not load, because a redirect from ${from} took it to ${to}, which has a reply that the browser could not use, since it follows redirects by itself (${reason}). The request finding says more.`
              : verdict === "unexpected"
                ? `The page did not load, because a redirect from ${from} sent it outside its world, to ${to} (${reason}). The outside finding says more.`
                : `The page did not load, because a redirect from ${from} to ${to} failed (${reason}).`,
        );
      }
    }

    if (loaded) {
      await settle();
      if (state.ready !== undefined) {
        try {
          await page.locator(state.ready).first().waitFor({ state: "visible", timeout: project.timeout });
        } catch {
          add("expect", `The page never showed its ready mark, ${state.ready}.`);
        }
      }
      if (state.steps !== undefined) {
        try {
          await state.steps(page, reached);
        } catch (error) {
          add("steps", `The steps for this state failed: ${firstLine(error)}`);
        }
        await settle();
      }
      if (options.then !== undefined) {
        try {
          const returned = await new AsyncFunction("page", "reached", options.then)(page, reached);
          if (returned !== undefined) observation.returned = typeof returned === "string" ? returned : JSON.stringify(returned, null, 2);
        } catch (error) {
          add("steps", `The --then code failed: ${firstLine(error)}`);
        }
        await settle();
      }
      observation.url = page.url();

      const target = options.scope === undefined ? page.locator("body") : page.locator(options.scope).first();
      if (options.scope !== undefined && (await target.count()) === 0) {
        add("expect", `Nothing on the page matches ${options.scope}.`);
      } else {
        try {
          const outline = outlineOf(await target.ariaSnapshot({ timeout: 10_000 }), { origin, ...(options.lines === undefined ? {} : { lines: options.lines }) });
          observation.outline = outline.lines;
          observation.outlineFull = outline.full;
        } catch (error) {
          notes.push(`The outline could not be read: ${firstLine(error)}`);
        }
      }
      const picture = options.directory === undefined ? null : join(options.directory, `${state.name}.${view.name}.png`);
      if (options.directory !== undefined) mkdirSync(options.directory, { recursive: true });
      if (picture !== null) {
        try {
          if (options.scope === undefined) await page.screenshot({ path: picture, scale: "css", animations: "disabled", caret: "hide" });
          else await target.screenshot({ path: picture, scale: "css", animations: "disabled", caret: "hide", timeout: 10_000 });
          observation.picture = picture;
        } catch (error) {
          notes.push(`No picture was taken: ${firstLine(error)}`);
        }
      }

      for (const wanted of state.see ?? []) {
        try {
          await page.getByText(wanted).first().waitFor({ state: "visible", timeout: 3000 });
        } catch {
          add("expect", `Expected to see ${typeof wanted === "string" ? JSON.stringify(wanted) : String(wanted)}, and it is not visible.`);
        }
      }
      if (state.expect !== undefined) {
        try {
          await state.expect(page, reached);
        } catch (error) {
          add("expect", firstLine(error));
        }
      }

      const inspectOptions: InspectOptions = {
        scope: options.scope ?? null,
        touch: view.touch,
        tapTarget: project.tapTarget,
        scroll: state.scroll ?? (state.steps === undefined && options.then === undefined),
      };
      try {
        const inspection = await page.evaluate(inspectPage, inspectOptions);
        await settle();
        observation.title = inspection.title;
        observation.page = inspection.page;
        observation.regions = inspection.regions;
        observation.boxes = inspection.boxes;
        findings.push(...inspection.findings);
        notes.push(...inspection.notes);

        const height = Math.min(inspection.page.height, TALLEST);
        if (inspection.page.height > TALLEST) notes.push(`The page is ${inspection.page.height}px tall; pictures and contrast cover its first ${TALLEST}px.`);
        const shot = { fullPage: true, scale: "css", animations: "disabled", caret: "hide", clip: { x: 0, y: 0, width: inspection.page.width, height } } as const;
        const painted = await page.screenshot(shot);
        if (options.directory !== undefined) {
          observation.fullPicture = join(options.directory, `${state.name}.${view.name}.full.png`);
          writeFileSync(observation.fullPicture, painted);
        }
        if (inspection.texts.length > 0) {
          const bare = await page.screenshot({ ...shot, style: BARE });
          for (const problem of findLowContrast(inspection.texts, decodePng(painted), decodePng(bare))) {
            add(
              "contrast",
              `"${problem.sample.text}" has ${problem.ratio}:1 contrast (${problem.text} on ${problem.background}); text this size needs ${problem.needs}:1.`,
              problem.sample.where,
            );
          }
        }
      } catch (error) {
        notes.push(`The page could not be inspected: ${firstLine(error)}`);
      }

      const expected = state.status;
      if (observation.status !== null && (expected === undefined ? observation.status >= 400 : observation.status !== expected)) {
        add("document", `The page answered ${observation.status}${expected === undefined ? "." : `; this state expects ${expected}.`}`);
      }
      if (stillLoading.length > 0) add("busy", `The page was still loading after ${project.settle / 1000}s: ${stillLoading.join(", ")}.`);
      else if (stillChanging) notes.push("The page never stopped changing; it was looked at while still moving.");
    }

    for (const [text, count] of consoleErrors) {
      const flat = text.replaceAll(/\s+/gu, " ");
      add("console", `The console logged an error${count > 1 ? ` ${count} times` : ""}: ${flat.length > 300 ? `${flat.slice(0, 300)}…` : flat}`);
    }
    if (refused.length > 0) {
      const unique = [...new Set(refused)];
      add("request", `${unique.slice(0, 4).join("; ")}${unique.length > 4 ? `; and ${unique.length - 4} more` : ""}.`);
    }
    calls.push(...(options.upstreamCalls?.() ?? []));
    // One sentence per host and per fate: hops that went through come first,
    // since there the world did not hold, then hops that were stopped, then
    // everything else.
    const strays = new Map<string, { key: string; fate: number; list: Call[] }>();
    for (const call of calls) {
      observation.requests[call.outcome]++;
      if (call.outcome !== "unexpected") continue;
      const key = call.from === "page" ? new URL(call.url).host : call.from;
      const fate = call.via === undefined ? 2 : call.reached === true ? 0 : 1;
      const group = strays.get(`${fate} ${key}`) ?? { key, fate, list: [] };
      group.list.push(call);
      strays.set(`${fate} ${key}`, group);
    }
    for (const { key, list } of [...strays.values()].sort((a, b) => a.fate - b.fate)) {
      const first = list[0]!;
      const more = list.length > 1 ? `, and ${list.length - 1} more from there` : "";
      if (first.from !== "page") {
        add("outside", `The app's server asked its "${key.replace("upstream:", "")}" upstream for ${first.method} ${first.url}${more}; this world has no reply for it.`);
      } else if (first.via !== undefined) {
        // A hop that went through, or one that was stopped. A redirect can move the page itself or one thing it asked for.
        const from = brief(first.via, origin);
        const what = first.type === "document" ? "the page" : `the page's request for ${ASKED_FOR[first.type] ?? "something"}`;
        if (first.reached !== true) {
          const fix = replyable(first.via)
            ? `Give ${from} a reply that does not redirect there, or list ${key} under block to stop it quietly, or under allow to let it through.`
            : `List ${key} under block to stop it quietly, or under allow to let it through; no reply stands in for ${from} on a deployment.`;
          add(
            "outside",
            `A redirect from ${from} tried to take ${what} to ${brief(first.url, origin)}${more}, which is not in its world, and was stopped. The browser follows redirects by itself, so a reply for ${key} cannot answer it. ${fix}`,
          );
          continue;
        }
        const target = new URL(first.url);
        const blocked = judge(state.world, origin, first.method, target, { live }) === "blocked";
        const why = isOwnAddress(target, origin)
          ? "it is on the app's own address"
          : allowsHost(state.world, target)
            ? `${key} is allowed`
            : `${key} is allowed in another state's world, and the states share one browser`;
        const fix = blocked
          ? replyable(first.via)
            ? `Give ${from} a reply that does not redirect there, or block ${from} too.`
            : `Block ${from} too.`
          : replyable(first.via)
            ? `Give ${from} a reply that does not redirect there, or allow that address too.`
            : `Allow that address too, or block ${from}.`;
        add(
          "outside",
          `A redirect from ${from} took ${what} to ${brief(first.url, origin)}${more}, which its world ${blocked ? "blocks" : "does not allow"}, and the request went through, because ${why}, and ra can stop a redirect only by its host. ${fix}`,
        );
      } else if (first.type === "document") {
        add("outside", `The page tried to leave for ${brief(first.url, origin)}, which is not in its world. Give ${key} a reply, or list it under allow or block.`);
      } else {
        add(
          "outside",
          `The page asked ${key} for ${ASKED_FOR[first.type] ?? "something"} (${first.method} ${brief(first.url, origin)})${more}; nothing in its world answers. Give ${key} a reply, or list it under allow or block.`,
        );
      }
    }
    options.accepted?.(applyAccepts(findings, state.accept));
  } finally {
    await context.close().catch(() => undefined);
  }
  observation.ms = Math.round(performance.now() - started);
  return observation;
}
