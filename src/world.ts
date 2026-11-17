/**
 * The closed world: every request that leaves the app is answered by a fake,
 * let through by name, dropped quietly by name, or stopped and reported.
 */
import { createSocket } from "node:dgram";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, BrowserContext, Request, Route } from "playwright-core";
import type { Call, Replier, Replies, Reply, RequestInfo, World } from "./config.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "0.0.0.0"]);

/** Whether an address belongs to the app: the same origin, counting every loopback name as one host. */
export function sameApp(url: URL, origin: string): boolean {
  const app = new URL(origin);
  if (url.protocol.replace(/^ws/u, "http") !== app.protocol) return false;
  if (url.port !== app.port) return false;
  return url.hostname === app.hostname || (LOOPBACK.has(url.hostname) && LOOPBACK.has(app.hostname));
}

function glob(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index++;
      } else {
        source += "[^/]*";
      }
    } else {
      source += character.replace(/[\\^$.|?+()[\]{}]/u, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "u");
}

interface Rule {
  method: string | null;
  /** How much of the rule is literal; the most literal matching rule wins. */
  weight: number;
  matches(url: URL, origin: string | null): boolean;
}

const rules = new Map<string, Rule>();

/** Says what is wrong with a rule, or null when ra can read it. */
export function ruleProblem(text: unknown): string | null {
  if (typeof text !== "string" || text.trim() === "") return `a rule is text such as "GET /api/items", not ${JSON.stringify(text)}`;
  const parts = /^(?:(\S+)\s+)?(\S+)$/u.exec(text.trim());
  if (parts === null) return `"${text}" has more in it than a method and an address; write it like "GET /api/items"`;
  const method = parts[1];
  const pattern = parts[2]!;
  if (method !== undefined && !/^[A-Z]+$/u.test(method)) return `"${text}" needs its method in capitals, as in "${method.toUpperCase()} ${pattern}"`;
  if (pattern.startsWith("/")) return null;
  const address = /^[a-z*]+:\/\/(.*)$/u.exec(pattern);
  if (address === null && pattern.includes("://")) return `"${text}" is not an address ra can read; write it like "https://api.example.com/**"`;
  const host = (address?.[1] ?? pattern).split("/")[0]!;
  if (!/^(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9*._-]+)(?::\d+)?$/u.test(host)) return `"${text}" names no host ra can read; write a host such as "api.example.com", or an address such as "https://api.example.com/**"`;
  if (address === null && host !== "localhost" && !/[.*:[]/u.test(host)) {
    return `"${text}" reads as a host named "${host}"; a path on the app starts with "/", as in "${method === undefined ? "" : `${method} `}/${pattern}"`;
  }
  return null;
}

/**
 * Reads a rule. Forms:
 *   "/api/items"                  a path on the app itself
 *   "https://api.example.com/**"  a full address
 *   "*.example.com"               a host, any path
 * A leading method limits it: "POST /api/items". `*` stays within one path
 * segment, `**` crosses them. The query string only matters when the rule
 * contains a `?`.
 */
export function parseRule(text: string): Rule {
  const known = rules.get(text);
  if (known !== undefined) return known;
  const problem = ruleProblem(text);
  if (problem !== null) throw new Error(`ra cannot use this rule: ${problem}.`);
  const parts = /^(?:([A-Z]+)\s+)?(\S+)$/u.exec(text.trim())!;
  const method = parts[1] ?? null;
  const pattern = parts[2]!;
  const withQuery = pattern.includes("?");
  const isPath = pattern.startsWith("/");
  const isAddress = pattern.includes("://");
  const hasPath = isPath || pattern.replace(/^[a-z*]+:\/\//u, "").includes("/");
  const expression = glob(pattern);
  const rule: Rule = {
    method,
    weight: pattern.replaceAll("*", "").length + (method === null ? 0 : 1),
    matches(url, origin) {
      const tail = url.pathname + (withQuery ? url.search : "");
      if (isPath) return (origin === null || sameApp(url, origin)) && expression.test(tail);
      if (isAddress) return expression.test(hasPath ? url.origin + tail : url.origin);
      if (hasPath) return expression.test(url.host + tail);
      return expression.test(url.host) || expression.test(url.hostname);
    },
  };
  rules.set(text, rule);
  return rule;
}

function matchesAny(list: readonly string[], method: string, url: URL, origin: string | null): boolean {
  return list.some((text) => {
    const rule = parseRule(text);
    return (rule.method === null || rule.method === method) && rule.matches(url, origin);
  });
}

/** Picks the reply for a request: the most specific matching rule. */
export function findReply(replies: Replies, method: string, url: URL, origin: string | null): Replier | undefined {
  let best: { rule: Rule; reply: Replier } | undefined;
  for (const [text, reply] of Object.entries(replies)) {
    const rule = parseRule(text);
    if (rule.method !== null && rule.method !== method) continue;
    if (!rule.matches(url, origin)) continue;
    if (best === undefined || rule.weight > best.rule.weight) best = { rule, reply };
  }
  return best?.reply;
}

const REPLY_KEYS = ["status", "json", "body", "type", "headers"];

/** Says what is wrong with an answer, as the end of a sentence about it, or null when it is fine. */
export function replyProblem(reply: unknown): string | null {
  if (reply === null || typeof reply !== "object" || Array.isArray(reply)) return "must be an object such as { json: { id: 1 } }";
  const unknown = Object.keys(reply).find((key) => !REPLY_KEYS.includes(key));
  if (unknown !== undefined) return `has an unknown setting "${unknown}"; the settings are ${REPLY_KEYS.join(", ")}`;
  const { status, json, body, type, headers } = reply as Reply;
  if (status !== undefined && !(Number.isInteger(status) && status >= 100 && status <= 599)) return `has status ${JSON.stringify(status)}, which is not a number from 100 to 599`;
  if (json !== undefined && body !== undefined) return "has both json and body; give one";
  if (body !== undefined && typeof body !== "string" && !(body instanceof Uint8Array)) return "has a body that is neither text nor bytes; use json for data";
  if (type !== undefined && typeof type !== "string") return "has a type that is not text";
  if (headers !== undefined && (headers === null || typeof headers !== "object" || Object.values(headers).some((value) => typeof value !== "string"))) {
    return "has headers that are not names mapped to text";
  }
  return null;
}

/** A reply function gave back something that is not an answer. */
class BadAnswer extends Error {}

/** Says how a reply failed, for a finding or for the response that stands in for it. */
function replyFailure(method: string, path: string, error: unknown): string {
  if (error instanceof BadAnswer) return `The world's reply for ${method} ${path} gave an answer that ${error.message}`;
  return `The world's reply for ${method} ${path} threw: ${error instanceof Error ? error.message : String(error)}`;
}

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

async function answer(replier: Replier, request: RequestInfo): Promise<Answer> {
  const reply: Reply = typeof replier === "function" ? await replier(request) : replier;
  const problem = replyProblem(reply);
  if (problem !== null) throw new BadAnswer(problem);
  const isJson = reply.json !== undefined;
  const body = reply.body;
  return {
    status: reply.status ?? 200,
    headers: { "content-type": isJson ? "application/json" : (reply.type ?? (body instanceof Uint8Array ? "application/octet-stream" : "text/plain; charset=utf-8")), ...reply.headers },
    body: isJson ? JSON.stringify(reply.json) : body instanceof Uint8Array ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : (body ?? ""),
  };
}

function shorten(body: string | null): string | null {
  return body === null || body.length <= 20_000 ? body : `${body.slice(0, 20_000)}…`;
}

export type Verdict = "replied" | "blocked" | "app" | "allowed" | "unexpected";

export interface JudgeOptions {
  /** The app is a deployment, which answers its own requests: no reply stands in for it, though a block still applies. */
  live?: boolean;
}

/** Decides what becomes of a request: a reply wins, then a block, then the app itself, then an allow. */
export function judge(world: World, origin: string, method: string, url: URL, options: JudgeOptions = {}): Verdict {
  if (options.live === true && sameApp(url, origin)) return matchesAny(world.block ?? [], method, url, origin) ? "blocked" : "app";
  if (findReply(world.replies ?? {}, method, url, origin) !== undefined) return "replied";
  if (matchesAny(world.block ?? [], method, url, origin)) return "blocked";
  if (sameApp(url, origin)) return "app";
  if (matchesAny(world.allow ?? [], method, url, origin)) return "allowed";
  return "unexpected";
}

/**
 * The outside hosts these worlds let the browser really reach, as host
 * patterns with any port the rule names. Returns null when a world lets every
 * host through.
 */
export function reachableHosts(worlds: readonly World[]): string[] | null {
  const hosts = new Set<string>();
  for (const world of worlds) {
    for (const text of world.allow ?? []) {
      const pattern = text.trim().replace(/^[A-Z]+\s+/u, "");
      if (pattern.startsWith("/")) continue;
      const host = pattern.replace(/^[a-z*]+:\/\//u, "").split("/")[0]!.replaceAll(/\*+/gu, "*");
      if (host === "*") return null;
      if (host !== "") hosts.add(host);
    }
  }
  return [...hosts];
}

/**
 * Whether a world lets the browser reach this host at all, on any path. The
 * browser's switches tell hosts apart but not paths.
 */
export function allowsHost(world: World, url: URL): boolean {
  const hosts = reachableHosts([world]);
  if (hosts === null) return true;
  // A rule may name the port even when it is the default, which the address leaves out.
  const names = [url.hostname, `${url.hostname}:${portOf(url)}`];
  return hosts.some((host) => names.some((name) => glob(host).test(name)));
}

/** The port an address uses, with the scheme's default filled in. */
function portOf(url: URL): string {
  return url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
}

/**
 * The app's own addresses as the browser's switches name them: its host on
 * its port, or every loopback name on its port for an app on this machine.
 */
function ownAddresses(origin: string): string[] {
  const app = new URL(origin);
  const port = portOf(app);
  return LOOPBACK.has(app.hostname) ? [...LOOPBACK].map((name) => `${name}:${port}`) : [`${app.hostname}:${port}`];
}

/** Whether the browser lets a request through as one to the app itself. It goes by host and port, whatever the scheme. */
export function isOwnAddress(url: URL, origin: string): boolean {
  return ownAddresses(origin).includes(`${url.hostname}:${portOf(url)}`);
}

/** Makes every host name fail to resolve except loopback and the hosts given. */
export function resolverSwitch(hosts: readonly string[]): string {
  // Chromium compares these with the bare host: no port, and no brackets around an IPv6 address.
  const names = hosts.map((host) => host.replace(/:\d+$/u, "").replace(/^\[(.*)\]$/u, "$1")).filter((host) => host !== "");
  const open = [...new Set(["localhost", "*.localhost", "127.0.0.1", ...names])];
  return `--host-resolver-rules=MAP * ~NOTFOUND , ${open.map((host) => `EXCLUDE ${host}`).join(" , ")}`;
}

/** A proxy that nothing answers, so whatever is sent to it fails at once. */
const NOWHERE = "http://127.0.0.1:1";

/**
 * The Chromium switches that close the world beneath routing. The browser
 * follows redirects by itself, so routing never sees their later hops. The
 * browser therefore sends everything to a proxy that refuses it, except the
 * app's own address and the allowed hosts, and no other host name resolves.
 * The proxy switch also replaces any proxy the machine is set up with.
 * WebRTC would still send UDP past both, so it is held to proxied
 * connections, which the proxy refuses.
 */
export function closedWorldSwitches(origin: string, hosts: readonly string[]): string[] {
  // Only the app's own port: a bypass entry without one would let every port and scheme of that host through.
  const own = ownAddresses(origin);
  return [
    resolverSwitch([...own, ...hosts]),
    `--proxy-server=${NOWHERE}`,
    `--proxy-bypass-list=${["<-loopback>", ...own, ...hosts].join(";")}`,
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
}

export interface ClosedWorldTrial {
  /** The throwaway app. Open the browser with `closedWorldSwitches(origin, [])`. */
  origin: string;
  /** Says what got through, or what could not be reached that should have been. Empty when the world held. */
  run(browser: Browser): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * A test of the closed world itself, for `ra doctor`: a throwaway app, and a
 * server on another port that nothing may reach. In a browser opened for the
 * app, the app must answer, and another port on this machine, an IP address
 * and an outside host must each be stopped by the world rather than time out.
 * WebRTC must not reach a STUN server on this machine either.
 */
export async function closedWorldTrial(): Promise<ClosedWorldTrial> {
  const reached: string[] = [];
  let datagrams = 0;
  const stun = createSocket("udp4").on("message", () => datagrams++);
  const app = createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>ra</title>");
  });
  const other = createServer((request, response) => {
    reached.push(request.url ?? "/");
    response.end("reached");
  });
  const listen = (server: Server) =>
    new Promise<number>((done, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => done((server.address() as AddressInfo).port));
    });
  let stunBound = false;
  const close = () =>
    Promise.all([
      ...[app, other].map(
        (server) =>
          new Promise<void>((done) => {
            if (!server.listening) return done();
            server.close(() => done());
            server.closeAllConnections();
          }),
      ),
      new Promise<void>((done) => (stunBound ? stun.close(() => done()) : done())),
    ]).then(() => undefined);
  let origin: string;
  let otherPort: number;
  let stunPort: number;
  try {
    origin = `http://127.0.0.1:${await listen(app)}`;
    otherPort = await listen(other);
    stunPort = await new Promise<number>((done, fail) => {
      stun.once("error", fail);
      stun.bind(0, "127.0.0.1", () => {
        stunBound = true;
        done(stun.address().port);
      });
    });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    origin,
    async run(browser) {
      const problems: string[] = [];
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const go = (url: string) =>
          page.goto(url, { timeout: 5000 }).then(
            () => null,
            (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.replace(/^page\.goto: /u, ""),
          );
        const own = await go(`${origin}/`);
        if (own !== null) problems.push(`the browser could not reach the app on this machine (${own})`);
        await page
          .evaluate(async (server) => {
            const connection = new RTCPeerConnection({ iceServers: [{ urls: server }] });
            connection.createDataChannel("ra");
            await connection.setLocalDescription(await connection.createOffer());
            await new Promise<void>((done) => {
              const timer = setTimeout(done, 3000);
              connection.addEventListener("icegatheringstatechange", () => {
                if (connection.iceGatheringState !== "complete") return;
                clearTimeout(timer);
                done();
              });
            });
            connection.close();
          }, `stun:127.0.0.1:${stunPort}`)
          .catch(() => undefined);
        await new Promise((done) => setTimeout(done, 200));
        if (datagrams > 0) problems.push(`WebRTC sent ${datagrams} UDP packets to a STUN server on this machine`);
        const elsewhere: Array<[string, string]> = [
          ["another port on this machine", `http://127.0.0.1:${otherPort}/by-address`],
          ["another port, by name", `http://localhost:${otherPort}/by-name`],
          ["an IP address", "http://192.0.2.1/"],
          ["an outside host", "https://example.com/"],
        ];
        for (const [what, url] of elsewhere) {
          const failure = await go(url);
          if (failure === null) problems.push(`${what} (${url}) answered`);
          else if (!/ERR_PROXY_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED/u.test(failure)) problems.push(`${what} (${url}) was not stopped by the world: ${failure}`);
        }
        if (reached.length > 0) problems.push(`the server on another port was asked for ${reached.join(", ")}`);
      } finally {
        await context.close().catch(() => undefined);
      }
      return problems;
    },
    close,
  };
}

export interface WorldOptions {
  world: World;
  /** The address the app is served from. */
  origin: string;
  /** The app is a deployment; see `JudgeOptions`. */
  live?: boolean;
  /** Receives every request that left the app. */
  calls: Call[];
  /** Hears about a reply that failed, or a request ra could not decide on; the page gets a 500 or a failed request instead. */
  onReplyError?: (message: string) => void;
}

/**
 * Puts a browser context inside the world. Requests to the app pass. Anything
 * else needs a reply, an allow or a block; the rest is stopped and recorded as
 * unexpected.
 */
export async function closeWorld(context: BrowserContext, options: WorldOptions): Promise<void> {
  const { world, origin, calls } = options;
  const live = options.live === true;
  const replies = world.replies ?? {};
  const record = (request: Request, outcome: Call["outcome"]) => {
    calls.push({ from: "page", type: request.resourceType(), method: request.method(), url: request.url(), body: shorten(request.postData()), outcome });
  };
  const decide = async (route: Route): Promise<void> => {
    const request = route.request();
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      await route.continue();
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      await route.continue();
      return;
    }
    const method = request.method();
    const headers = request.headers();
    const cors: Record<string, string> =
      headers["origin"] === undefined || sameApp(url, origin)
        ? {}
        : { "access-control-allow-origin": headers["origin"], "access-control-allow-credentials": "true", vary: "Origin" };
    const asked = headers["access-control-request-method"];
    if (method === "OPTIONS" && asked !== undefined && judge(world, origin, asked, url, { live }) === "replied") {
      await route.fulfill({
        status: 204,
        headers: {
          ...cors,
          "access-control-allow-methods": asked,
          "access-control-allow-headers": headers["access-control-request-headers"] ?? "*",
        },
      });
      return;
    }
    const verdict = judge(world, origin, method, url, { live });
    if (verdict === "app") {
      await route.continue();
      return;
    }
    record(request, verdict);
    if (verdict === "replied") {
      try {
        const reply = await answer(findReply(replies, method, url, origin)!, { method, url, headers, body: request.postData() });
        await route.fulfill({ status: reply.status, headers: { ...cors, ...reply.headers }, body: reply.body });
      } catch (error) {
        const message = replyFailure(method, url.pathname, error);
        options.onReplyError?.(message);
        await route.fulfill({ status: 500, headers: { ...cors, "content-type": "text/plain; charset=utf-8" }, body: `ra: ${message}` });
      }
    } else if (verdict === "allowed") {
      await route.continue();
    } else {
      await route.abort("blockedbyclient");
    }
  };
  await context.route("**/*", async (route) => {
    try {
      await decide(route);
    } catch (error) {
      // A request ra cannot decide on is stopped, never let through.
      const request = route.request();
      options.onReplyError?.(`ra could not decide on ${request.method()} ${request.url()}: ${error instanceof Error ? error.message : String(error)}`);
      await route.abort("blockedbyclient").catch(() => undefined);
    }
  });
  if (typeof context.routeWebSocket === "function") {
    await context.routeWebSocket(/.*/u, (socket) => {
      const url = new URL(socket.url());
      let verdict: Verdict = "unexpected";
      try {
        verdict = judge({ allow: world.allow ?? [], block: world.block ?? [] }, origin, "GET", new URL(url.href.replace(/^ws/u, "http")));
      } catch (error) {
        options.onReplyError?.(`ra could not decide on the socket ${url.href}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (verdict === "app" || verdict === "allowed") {
        socket.connectToServer();
        return;
      }
      calls.push({ from: "page", type: "websocket", method: "GET", url: url.href, body: null, outcome: verdict === "blocked" ? "blocked" : "unexpected" });
      void socket.close({ code: 1008, reason: "Not part of this world." });
    });
  }
}

export interface Upstreams {
  /** The loopback address of each stand-in, by name. */
  urls: Record<string, string>;
  /** Switches every stand-in to another world's answers. */
  use(world: World): void;
  /** Requests the app's server made since the last `drain`. */
  drain(): Call[];
  close(): Promise<void>;
}

/** Starts one loopback server per name, standing in for what the app's own server calls. */
export async function startUpstreams(names: readonly string[]): Promise<Upstreams> {
  let current: Record<string, Replies> = {};
  let calls: Call[] = [];
  const servers: Server[] = [];
  const urls: Record<string, string> = {};
  for (const name of names) {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        void (async () => {
          const method = request.method ?? "GET";
          const url = new URL(request.url ?? "/", urls[name]);
          const body = chunks.length === 0 ? null : Buffer.concat(chunks).toString("utf8");
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(request.headers)) headers[key] = Array.isArray(value) ? value.join(", ") : (value ?? "");
          const replier = findReply(current[name] ?? {}, method, url, null);
          const call: Call = { from: `upstream:${name}`, type: "server", method, url: url.pathname + url.search, body: shorten(body), outcome: "replied" };
          if (replier === undefined) {
            calls.push({ ...call, outcome: "unexpected" });
            response.writeHead(501, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: `ra: the "${name}" stand-in has no reply for ${method} ${url.pathname}` }));
            return;
          }
          calls.push(call);
          try {
            const reply = await answer(replier, { method, url, headers, body });
            response.writeHead(reply.status, reply.headers);
            response.end(reply.body);
          } catch (error) {
            response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
            response.end(`ra: ${replyFailure(method, url.pathname, error)}`);
          }
        })();
      });
    });
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", done);
    });
    urls[name] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    servers.push(server);
  }
  return {
    urls,
    use(world) {
      current = world.upstreams ?? {};
    },
    drain() {
      const taken = calls;
      calls = [];
      return taken;
    },
    async close() {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((done) => {
              server.close(() => done());
              server.closeAllConnections();
            }),
        ),
      );
    },
  };
}
