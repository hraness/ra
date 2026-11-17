/**
 * What a project tells ra: how to run the app, which states exist, what the
 * outside world answers, and which views to look through.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "playwright-core";
import { replyProblem, ruleProblem } from "./world.ts";

/** A request as a reply function sees it, whether it came from the page or from the app's server. */
export interface RequestInfo {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | null;
}

export interface Reply {
  /** Defaults to 200. */
  status?: number;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as is: text, or bytes such as an image read from disk. */
  body?: string | Uint8Array;
  /** The content type for `body`. Defaults to text/plain, or application/octet-stream for bytes. */
  type?: string;
  headers?: Record<string, string>;
}

export type Replier = Reply | ((request: RequestInfo) => Reply | Promise<Reply>);

/** Rules such as `"GET /api/items"` or `"https://api.example.com/v1/**"`, each with its answer. */
export type Replies = Record<string, Replier>;

/** Everything outside the app, as the app will meet it. */
export interface World {
  /** Answers for requests the page makes. */
  replies?: Replies;
  /** Outside addresses the page may really reach. */
  allow?: string[];
  /** Outside addresses to drop quietly, such as analytics. */
  block?: string[];
  /**
   * Stand-in servers for what the app's own server calls. Each name gets a
   * loopback address, handed to the app as `{upstream.NAME}` in `app.command`
   * and `app.env`.
   */
  upstreams?: Record<string, Replies>;
}

/** A request that left the app, and what became of it. */
export interface Call {
  /** `page`, or `upstream:NAME` for a request the app's server made. */
  from: string;
  /** What asked for it: document, script, stylesheet, image, font, fetch, xhr, websocket and so on; `server` for the app's own server. */
  type: string;
  method: string;
  url: string;
  body: string | null;
  outcome: "replied" | "allowed" | "blocked" | "unexpected";
  /** For a later hop of a redirect, which the browser follows by itself: the address that started it. */
  via?: string;
  /** True for a redirect hop outside the world that the browser let through anyway, by its host, whether or not anything answered. */
  reached?: boolean;
}

/** What `steps` and `expect` are told about the state they run in. */
export interface Reached {
  state: string;
  view: string;
  /** The address the app is served from. */
  origin: string;
  /** Requests that left the app so far. */
  calls: Call[];
}

export interface Accept {
  /** The kind of finding, such as `contrast`. */
  finding: string;
  /** Text or a pattern the finding must contain. Without it, every finding of the kind is accepted. */
  match?: string | RegExp;
  /** Why this is fine. Shown wherever the finding is listed. */
  why: string;
}

export interface StateSpec {
  /** A path in the app, or a full address. */
  url: string;
  /** One line on what this state is for. */
  note?: string;
  /** Laid over the project's world for this state. */
  world?: World;
  /** localStorage to start with. */
  storage?: Record<string, string>;
  /** sessionStorage to start with. */
  session?: Record<string, string>;
  /** Cookies to start with. */
  cookies?: Record<string, string>;
  /** What time the page believes it is. */
  clock?: string | number | Date;
  /** A selector that must be visible before the page counts as ready. */
  ready?: string;
  /** Actions that reach the state after the page loads. */
  steps?: (page: Page, reached: Reached) => Promise<void> | void;
  /** Text that must be visible once the state is reached. */
  see?: Array<string | RegExp>;
  /** Anything else that must hold. Throw to fail. */
  expect?: (page: Page, reached: Reached) => Promise<void> | void;
  /** The response status this state is meant to have, when not a success. */
  status?: number;
  /** Views for this state, instead of the project's. */
  views?: string[];
  accept?: Accept[];
  /** Set false to keep ra from scrolling through the page. States with `steps` are never scrolled. */
  scroll?: boolean;
  /** Whether this state can also be looked at on a deployment. States with a world or steps are local unless marked. */
  live?: boolean;
}

export interface ViewSpec {
  name: string;
  width: number;
  height: number;
  /** A touch screen: taps instead of clicks, and tap targets are checked. */
  touch?: boolean;
  /** Device pixels per CSS pixel. */
  scale?: number;
}

export type AppSpec =
  | {
      /** A shell command that serves the app. `{port}` is a free port, also set as PORT. */
      command: string;
      /** A path that answers once the app is up. Defaults to "/". */
      ready?: string;
      env?: Record<string, string>;
      /** Seconds to wait for the app. Defaults to 120. */
      timeout?: number;
    }
  | {
      /** A directory of built files to serve. */
      static: string;
    }
  | {
      /** An app that is already running. */
      url: string;
    };

export interface Config {
  app?: AppSpec;
  /** Views to look through, such as `["desktop", "phone", "phone.dark"]`. */
  views?: Array<string | ViewSpec>;
  world?: World;
  states: Record<string, string | StateSpec>;
  accept?: Accept[];
  /** The smallest tap target on touch views, in pixels. Defaults to 24. */
  tapTarget?: number;
  /** Milliseconds to wait for a page to load. Defaults to 30000. */
  timeout?: number;
  /** Milliseconds to wait for a page to go quiet. Defaults to 5000. */
  settle?: number;
  /** Defaults to en-US. */
  locale?: string;
  /** Defaults to UTC. */
  timezone?: string;
}

/** Gives a config file its types. Returns what it is given. */
export function defineConfig(config: Config): Config {
  return config;
}

/** The config was written wrongly. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface View {
  name: string;
  width: number;
  height: number;
  touch: boolean;
  scale: number;
  scheme: "light" | "dark";
  /** Whether animations are left running. */
  motion: boolean;
}

export interface State extends Omit<StateSpec, "world" | "views" | "accept"> {
  name: string;
  /** Whether the state only makes sense on this machine: it brings its own world or steps, or says so. */
  local: boolean;
  world: Required<World>;
  views: View[];
  accept: Accept[];
}

export interface Project {
  /** The directory that holds the config, or the working directory without one. */
  root: string;
  /** The config file, when there is one. */
  file: string | null;
  app: AppSpec | undefined;
  views: View[];
  /** The views the project defined itself, for reading names such as `kiosk.dark`. */
  customViews: ViewSpec[];
  states: State[];
  world: Required<World>;
  tapTarget: number;
  timeout: number;
  settle: number;
  locale: string;
  timezone: string;
}

const BUILT_IN: Record<string, Omit<ViewSpec, "name">> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180, touch: true, scale: 2 },
  phone: { width: 390, height: 844, touch: true, scale: 2 },
  narrow: { width: 320, height: 640, touch: true, scale: 2 },
};

/** The names of the built-in views. */
export const VIEW_NAMES: readonly string[] = Object.keys(BUILT_IN);

/**
 * Reads a view name: a built-in or project view, or a size like `1024x768`,
 * followed by any of `.dark`, `.light`, `.touch`, `.motion`.
 */
export function resolveView(name: string, custom: readonly ViewSpec[] = []): View {
  const [base = "", ...modifiers] = name.split(".");
  const size = /^(\d{2,5})x(\d{2,5})$/u.exec(base);
  const spec: Omit<ViewSpec, "name"> | undefined =
    custom.find((view) => view.name === base)
    ?? BUILT_IN[base]
    ?? (size === null ? undefined : { width: Number(size[1]), height: Number(size[2]) });
  if (spec === undefined) {
    const known = [...custom.map((view) => view.name), ...VIEW_NAMES].join(", ");
    throw new ConfigError(`Unknown view "${name}". Use one of ${known}, or a size such as 1024x768, optionally followed by .dark.`);
  }
  const view: View = {
    name,
    width: spec.width,
    height: spec.height,
    touch: spec.touch ?? false,
    scale: spec.scale ?? 1,
    scheme: "light",
    motion: false,
  };
  for (const modifier of modifiers) {
    if (modifier === "dark" || modifier === "light") view.scheme = modifier;
    else if (modifier === "touch") view.touch = true;
    else if (modifier === "motion") view.motion = true;
    else throw new ConfigError(`Unknown view modifier ".${modifier}" in "${name}". Use .dark, .light, .touch or .motion.`);
  }
  return view;
}

/** Lays one world over another. Rules with the same text are replaced; lists are joined. */
export function mergeWorlds(base: World | undefined, over: World | undefined): Required<World> {
  const upstreams: Record<string, Replies> = {};
  for (const world of [base, over]) {
    for (const [name, replies] of Object.entries(world?.upstreams ?? {})) {
      upstreams[name] = { ...upstreams[name], ...replies };
    }
  }
  return {
    replies: { ...base?.replies, ...over?.replies },
    allow: [...(base?.allow ?? []), ...(over?.allow ?? [])],
    block: [...(base?.block ?? []), ...(over?.block ?? [])],
    upstreams,
  };
}

const CONFIG_KEYS = ["app", "views", "world", "states", "accept", "tapTarget", "timeout", "settle", "locale", "timezone"];
const STATE_KEYS = [
  "url", "note", "world", "storage", "session", "cookies", "clock", "ready", "steps", "see", "expect", "status", "views", "accept", "scroll", "live",
];
const WORLD_KEYS = ["replies", "allow", "block", "upstreams"];

function checkKeys(value: object, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ConfigError(`${what} has an unknown setting "${key}". Known settings: ${allowed.join(", ")}.`);
  }
}

function checkReplies(replies: unknown, what: string, pathsOnly: boolean): void {
  if (replies === undefined) return;
  if (replies === null || typeof replies !== "object" || Array.isArray(replies)) {
    throw new ConfigError(`${what} maps rules to answers, such as { "GET /api/me": { json: { name: "Ada" } } }.`);
  }
  for (const [rule, reply] of Object.entries(replies)) {
    const problem = ruleProblem(rule);
    if (problem !== null) throw new ConfigError(`${what}: ${problem}.`);
    if (pathsOnly && !/^(?:[A-Z]+\s+)?\//u.test(rule.trim())) {
      throw new ConfigError(`${what}: "${rule}" is not a path. A stand-in answers paths on itself, such as "GET /articles".`);
    }
    const wrong = typeof reply === "function" ? null : replyProblem(reply);
    if (wrong !== null) throw new ConfigError(`${what}: the answer for "${rule}" ${wrong}.`);
  }
}

function checkWorld(world: World | undefined, what: string): void {
  if (world === undefined) return;
  if (world === null || typeof world !== "object" || Array.isArray(world)) throw new ConfigError(`${what} is an object with replies, allow, block or upstreams.`);
  checkKeys(world, WORLD_KEYS, what);
  checkReplies(world.replies, `${what}.replies`, false);
  for (const [name, list] of [["allow", world.allow], ["block", world.block]] as const) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new ConfigError(`${what}.${name} is a list of address patterns, such as ["fonts.gstatic.com"].`);
    for (const rule of list) {
      const problem = ruleProblem(rule);
      if (problem !== null) throw new ConfigError(`${what}.${name}: ${problem}.`);
    }
  }
  if (world.upstreams === undefined) return;
  if (world.upstreams === null || typeof world.upstreams !== "object" || Array.isArray(world.upstreams)) {
    throw new ConfigError(`${what}.upstreams maps each stand-in's name to its replies, such as { content: { "GET /articles": { json: [] } } }.`);
  }
  for (const [name, replies] of Object.entries(world.upstreams)) {
    if (!/^[\w-]+$/u.test(name)) throw new ConfigError(`${what}.upstreams: "${name}" cannot be used as {upstream.${name}}; use letters, digits, - and _.`);
    checkReplies(replies, `${what}.upstreams.${name}`, true);
  }
}

function checkAccept(list: Accept[] | undefined, what: string): Accept[] {
  if (list === undefined) return [];
  for (const rule of list) {
    if (typeof rule?.finding !== "string" || typeof rule.why !== "string" || rule.why.trim() === "") {
      throw new ConfigError(`${what}: each accept entry needs a finding and a why, such as { finding: "contrast", match: "footer", why: "decorative" }.`);
    }
  }
  return list;
}

/** Checks a config and fills in what it leaves out. */
export function readConfig(config: Config, root: string, file: string | null = null): Project {
  if (config === null || typeof config !== "object") throw new ConfigError("The config must export an object. Wrap it in defineConfig({...}).");
  checkKeys(config, CONFIG_KEYS, "The config");
  checkWorld(config.world, "world");
  const custom = (config.views ?? []).filter((view): view is ViewSpec => typeof view !== "string");
  for (const view of custom) {
    if (!/^[a-z][a-z0-9-]*$/u.test(view.name) || !(view.width > 0) || !(view.height > 0)) {
      throw new ConfigError(`A view needs a lowercase name, a width and a height; got ${JSON.stringify(view)}.`);
    }
  }
  const viewNames = config.views === undefined ? ["desktop", "phone"] : config.views.map((view) => (typeof view === "string" ? view : view.name));
  const views = viewNames.map((name) => resolveView(name, custom));
  const baseAccept = checkAccept(config.accept, "accept");
  if (config.states === null || typeof config.states !== "object") throw new ConfigError('The config needs states, such as states: { home: "/" }.');
  const states: State[] = Object.entries(config.states).map(([name, given]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name)) {
      throw new ConfigError(`State names use letters, digits, - and _; "${name}" does not.`);
    }
    const spec: StateSpec = typeof given === "string" ? { url: given } : given;
    if (spec === null || typeof spec !== "object" || typeof spec.url !== "string" || spec.url === "") {
      throw new ConfigError(`State "${name}" needs a url, such as "/pricing".`);
    }
    checkKeys(spec, STATE_KEYS, `State "${name}"`);
    checkWorld(spec.world, `State "${name}" world`);
    const { world, views: ownViews, accept, ...rest } = spec;
    return {
      ...rest,
      name,
      local: spec.live === undefined ? world !== undefined || spec.steps !== undefined : !spec.live,
      world: mergeWorlds(config.world, world),
      views: ownViews === undefined ? views : ownViews.map((view) => resolveView(view, custom)),
      accept: [...checkAccept(accept, `State "${name}"`), ...baseAccept],
    };
  });
  return {
    root,
    file,
    app: config.app,
    views,
    customViews: custom,
    states,
    world: mergeWorlds(config.world, undefined),
    tapTarget: config.tapTarget ?? 24,
    timeout: config.timeout ?? 30_000,
    settle: config.settle ?? 5_000,
    locale: config.locale ?? "en-US",
    timezone: config.timezone ?? "UTC",
  };
}

const FILES = ["ra.config.ts", "ra.config.mts", "ra.config.mjs", "ra.config.js"];

/** Finds the nearest config file, looking in `from` and then in each directory above it. */
export function findConfig(from: string): string | null {
  for (let directory = resolve(from); ; directory = dirname(directory)) {
    for (const name of FILES) {
      const file = join(directory, name);
      if (existsSync(file)) return file;
    }
    if (dirname(directory) === directory || existsSync(join(directory, ".git"))) return null;
  }
}

/** Loads the project's config. Without a config file, the project has no states and no app. */
export async function loadProject(from: string = process.cwd(), file?: string): Promise<Project> {
  const found = file === undefined ? findConfig(from) : resolve(from, file);
  if (found === null) return readConfig({ states: {} }, resolve(from));
  if (!existsSync(found)) throw new ConfigError(`There is no config at ${found}.`);
  let loaded: { default?: Config };
  try {
    loaded = (await import(pathToFileURL(found).href)) as { default?: Config };
  } catch (error) {
    throw new ConfigError(`Could not load ${found}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (loaded.default === undefined) throw new ConfigError(`${found} must have a default export: export default defineConfig({...}).`);
  return readConfig(loaded.default, dirname(found), found);
}
