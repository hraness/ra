/**
 * The closed world: every request that leaves the app is answered by a fake,
 * let through by name, dropped quietly by name, or stopped and reported.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext, Request } from "playwright-core";
import type { Call, Replier, Replies, Reply, RequestInfo, World } from "./config.ts";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

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
  const parts = /^(?:([A-Z]+)\s+)?(\S+)$/u.exec(text.trim());
  if (parts === null) throw new Error(`Cannot read the rule "${text}". Write it like "GET /api/items" or "https://api.example.com/**".`);
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

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

async function answer(replier: Replier, request: RequestInfo): Promise<Answer> {
  const reply: Reply = typeof replier === "function" ? await replier(request) : replier;
  const isJson = reply.json !== undefined;
  return {
    status: reply.status ?? 200,
    headers: { "content-type": isJson ? "application/json" : (reply.type ?? "text/plain; charset=utf-8"), ...reply.headers },
    body: isJson ? JSON.stringify(reply.json) : (reply.body ?? ""),
  };
}

function shorten(body: string | null): string | null {
  return body === null || body.length <= 20_000 ? body : `${body.slice(0, 20_000)}…`;
}

export type Verdict = "replied" | "blocked" | "app" | "allowed" | "unexpected";

/** Decides what becomes of a request: a reply wins, then a block, then the app itself, then an allow. */
export function judge(world: World, origin: string, method: string, url: URL): Verdict {
  if (findReply(world.replies ?? {}, method, url, origin) !== undefined) return "replied";
  if (matchesAny(world.block ?? [], method, url, origin)) return "blocked";
  if (sameApp(url, origin)) return "app";
  if (matchesAny(world.allow ?? [], method, url, origin)) return "allowed";
  return "unexpected";
}

/**
 * The outside hosts these worlds let the browser really reach, as host
 * patterns. Returns null when a world lets every host through.
 */
export function reachableHosts(worlds: readonly World[]): string[] | null {
  const hosts = new Set<string>();
  for (const world of worlds) {
    for (const text of world.allow ?? []) {
      const pattern = text.trim().replace(/^[A-Z]+\s+/u, "");
      if (pattern.startsWith("/")) continue;
      const host = pattern.replace(/^[a-z*]+:\/\//u, "").split("/")[0]!.replace(/:\d+$/u, "").replaceAll(/\*+/gu, "*");
      if (host === "*") return null;
      if (host !== "") hosts.add(host);
    }
  }
  return [...hosts];
}

/**
 * The Chromium switch that makes every host name fail to resolve except
 * loopback and the ones given. This is what stops requests that routing never
 * sees, such as the later hops of a redirect.
 */
export function resolverSwitch(hosts: readonly string[]): string {
  const open = [...new Set(["localhost", "*.localhost", "127.0.0.1", ...hosts])];
  return `--host-resolver-rules=MAP * ~NOTFOUND , ${open.map((host) => `EXCLUDE ${host}`).join(" , ")}`;
}

export interface WorldOptions {
  world: World;
  /** The address the app is served from. */
  origin: string;
  /** Receives every request that left the app. */
  calls: Call[];
  /** Hears about a reply function that threw; the page gets a 500 instead. */
  onReplyError?: (message: string) => void;
}

/**
 * Puts a browser context inside the world. Requests to the app pass. Anything
 * else needs a reply, an allow or a block; the rest is stopped and recorded as
 * unexpected.
 */
export async function closeWorld(context: BrowserContext, options: WorldOptions): Promise<void> {
  const { world, origin, calls } = options;
  const replies = world.replies ?? {};
  const record = (request: Request, outcome: Call["outcome"]) => {
    calls.push({ from: "page", type: request.resourceType(), method: request.method(), url: request.url(), body: shorten(request.postData()), outcome });
  };
  await context.route("**/*", async (route) => {
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
    if (method === "OPTIONS" && asked !== undefined && findReply(replies, asked, url, origin) !== undefined) {
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
    const verdict = judge(world, origin, method, url);
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
        const message = `The world's reply for ${method} ${url.pathname} threw: ${error instanceof Error ? error.message : String(error)}`;
        options.onReplyError?.(message);
        await route.fulfill({ status: 500, headers: { ...cors, "content-type": "text/plain; charset=utf-8" }, body: `ra: ${message}` });
      }
    } else if (verdict === "allowed") {
      await route.continue();
    } else {
      await route.abort("blockedbyclient");
    }
  });
  if (typeof context.routeWebSocket === "function") {
    await context.routeWebSocket(/.*/u, (socket) => {
      const url = new URL(socket.url());
      const verdict = judge({ allow: world.allow ?? [], block: world.block ?? [] }, origin, "GET", new URL(url.href.replace(/^ws/u, "http")));
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
            response.writeHead(500, { "content-type": "text/plain" });
            response.end(`ra: the reply for ${method} ${url.pathname} threw: ${error instanceof Error ? error.message : String(error)}`);
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
