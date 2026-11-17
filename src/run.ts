/**
 * One run of ra: the app answering, its upstream stand-ins, and one owned
 * browser, opened together and closed together.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { openBrowser, type BrowserReceipt, type OwnedBrowser } from "./browser.ts";
import type { Accept, Project, State, View } from "./config.ts";
import { observe, type Observation } from "./observe.ts";
import { closedWorldSwitches, reachableHosts, startUpstreams, type Upstreams } from "./world.ts";

export interface SessionOptions {
  /** Look at this running app or deployment instead of starting the configured one. */
  url?: string;
  /** Outside hosts to let through for this run, on top of each state's world. */
  allow?: readonly string[];
  /** States to prepare for besides the project's, such as an address given on the command line. */
  states?: readonly State[];
  /** Receives the app's output while it starts. */
  log?: (line: string) => void;
}

export interface Job {
  state: State;
  view: View;
}

export interface LookOptions {
  /** Where pictures are written. Without it, no pictures are kept. */
  directory?: string;
  /** A selector to narrow the look to. */
  scope?: string;
  /** Code to run once the state is reached, with `page` in scope. */
  then?: string;
  /** The most outline lines to keep. */
  lines?: number;
}

export interface Session {
  project: Project;
  /** Where the app answers. */
  origin: string;
  /** True when the app is a deployment rather than something on this machine. */
  live: boolean;
  /** Which browser ran, and how it was started. */
  receipt: BrowserReceipt;
  /** Things worth telling the reader about this run. */
  notes: string[];
  /** Accept entries that matched a finding so far. */
  accepted: Set<Accept>;
  look(job: Job, options?: LookOptions): Promise<Observation>;
  /** Looks at every job, a few at a time, and returns the looks in the order given. */
  lookAll(jobs: readonly Job[], options?: LookOptions & { jobs?: number; done?: (observation: Observation) => void }): Promise<Observation[]>;
  close(): Promise<void>;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/** Every session that has started to open and is not closed yet. */
const open = new Set<() => Promise<void>>();

/** Closes every session still open, such as when ra is interrupted. */
export async function closeSessions(): Promise<void> {
  await Promise.allSettled([...open].map((close) => close()));
}

/**
 * The directory ra keeps its pictures and snapshots in: `.ra` next to the
 * config, or a temporary directory when there is no config. It ignores
 * itself, so nothing in it is committed.
 */
export function workDirectory(project: Project, name: string): string {
  const base = project.file === null ? join(tmpdir(), "ra") : join(project.root, ".ra");
  if (!existsSync(join(base, ".gitignore"))) {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, ".gitignore"), "*\n");
  }
  const directory = join(base, name);
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** Starts what a run needs. Whatever was started is stopped again if any part fails. */
export async function openSession(project: Project, options: SessionOptions = {}): Promise<Session> {
  const states = [...project.states, ...(options.states ?? [])];
  const names = [...new Set(states.flatMap((state) => Object.keys(state.world.upstreams)))];
  const external = options.url !== undefined || (project.app !== undefined && "url" in project.app);
  const notes: string[] = [];
  let upstreams: Upstreams | undefined;
  let app: RunningApp | undefined;
  let owned: OwnedBrowser | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      await owned?.close().catch(() => undefined);
      await app?.stop().catch(() => undefined);
      await upstreams?.close().catch(() => undefined);
      open.delete(close);
    })();
    return closing;
  };
  open.add(close);

  try {
    if (names.length > 0 && external) {
      notes.push(`ra did not start this app, so its upstream stand-ins (${names.join(", ")}) are not in use; the app's server talks to whatever it is configured for.`);
    } else if (names.length > 0) {
      upstreams = await startUpstreams(names);
    }
    app = await startApp(project.app, {
      root: project.root,
      ...(upstreams === undefined ? {} : { upstreams: upstreams.urls }),
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    const origin = app.origin;
    const live = !LOOPBACK.has(new URL(origin).hostname);
    const extra = [...(options.allow ?? [])];
    const hosts = reachableHosts([...states.map((state) => state.world), { allow: extra }]);
    if (hosts === null) notes.push("This run lets every outside host through, so nothing stops a request that leaves the app.");
    owned = await openBrowser({ from: project.root, args: hosts === null ? [] : closedWorldSwitches(origin, hosts) });
    const browser = owned.browser;
    const accepted = new Set<Accept>();

    const prepare = (state: State): State => (extra.length === 0 ? state : { ...state, world: { ...state.world, allow: [...state.world.allow, ...extra] } });
    const look = async (job: Job, lookOptions: LookOptions = {}): Promise<Observation> => {
      const state = prepare(job.state);
      upstreams?.use(state.world);
      upstreams?.drain();
      return observe({
        browser,
        project,
        origin,
        live,
        state,
        view: job.view,
        ...lookOptions,
        ...(upstreams === undefined ? {} : { upstreamCalls: () => upstreams!.drain() }),
        accepted: (used) => {
          for (const rule of used) accepted.add(rule);
        },
      });
    };
    return {
      project,
      origin,
      live,
      receipt: owned.receipt,
      notes,
      accepted,
      look,
      async lookAll(jobs, allOptions = {}) {
        const { jobs: asked, done, ...lookOptions } = allOptions;
        // Stand-ins answer for one state at a time, so with them every look takes its turn.
        const width = upstreams === undefined ? Math.max(1, Math.min(asked ?? 4, jobs.length)) : 1;
        const results = new Array<Observation>(jobs.length);
        let next = 0;
        await Promise.all(
          Array.from({ length: width }, async () => {
            for (let index = next++; index < jobs.length; index = next++) {
              const observation = await look(jobs[index]!, lookOptions);
              results[index] = observation;
              done?.(observation);
            }
          }),
        );
        return results;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
