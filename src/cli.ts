#!/usr/bin/env node
/**
 * The ra command.
 *
 * Exit codes: 0 fine, 1 `ra check` found something, 2 the command or config
 * was written wrongly, 3 the app or browser could not be run.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AppError } from "./app.ts";
import { BrowserPolicyError, loadPlaywright, openBrowser } from "./browser.ts";
import { ConfigError, loadProject, resolveView, type Accept, type Project, type State, type View } from "./config.ts";
import { compareLooks, type Change } from "./diff.ts";
import type { Observation } from "./observe.ts";
import { decodePng, encodePng, frame } from "./png.ts";
import { checkText, diffText, looksText, receiptLine, statesText } from "./report.ts";
import { openSession, workDirectory, type Job, type Session } from "./run.ts";

const HELP = `ra — look at an app's interface the way a person would, and say what is wrong with it.

  ra look <state | /path | address>   What is there, what is wrong, where the pictures are.
      --at phone,desktop.dark         Views to look through. Default: the state's first view. "all" for every one.
      --in "<selector>"               Only this part of the page.
      --then "<code>"                 Playwright code to run first, with page in scope; what it returns is printed.
                                      "@file.js" reads the code from a file.
      --full                          The whole outline, however long.
  ra check [state…]                   Every state through every view. Exits 1 when something is wrong.
  ra snap [state…]                    Remember how the states look now.
  ra diff [state…]                    What changed since the snapshot.
  ra states                           The states this project names.
  ra doctor                           Which browser ra runs, and whether it starts.

Everywhere:
  --url <origin>      Use an app that is already running, or a deployment, instead of starting one.
  --allow <host>      Let the page reach this outside host during this run. Repeatable.
  --json              Print data instead of text.
  --config <file>     Use this config instead of the nearest ra.config.ts.
  --jobs <n>          How many looks run at once. Default 4; 1 when upstream stand-ins are in use.

Views: desktop, tablet, phone, narrow, or a size such as 1024x768. Add .dark, .touch or .motion.
`;

/** The command was used wrongly. */
class UsageError extends Error {
  override name = "UsageError";
}

interface Flags {
  at?: string;
  in?: string;
  then?: string;
  full?: boolean;
  json?: boolean;
  url?: string;
  allow?: string[];
  config?: string;
  jobs?: string;
  help?: boolean;
  version?: boolean;
}

function version(): string {
  return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
}

let active: Session | undefined;

async function withSession<T>(project: Project, flags: Flags, extra: { url?: string; states?: State[] }, run: (session: Session) => Promise<T>): Promise<T> {
  const url = extra.url ?? flags.url;
  const session = await openSession(project, {
    ...(url === undefined ? {} : { url }),
    ...(flags.allow === undefined ? {} : { allow: flags.allow }),
    ...(extra.states === undefined ? {} : { states: extra.states }),
  });
  active = session;
  try {
    return await run(session);
  } finally {
    active = undefined;
    await session.close();
  }
}

function findState(project: Project, name: string): State {
  const state = project.states.find((candidate) => candidate.name === name);
  if (state !== undefined) return state;
  const known = project.states.map((candidate) => candidate.name);
  throw new UsageError(
    known.length === 0
      ? `There is no state named "${name}"; this project names none. Give a path or an address instead, such as ra look /pricing.`
      : `There is no state named "${name}". The states are: ${known.join(", ")}. A path such as /pricing or a full address works too.`,
  );
}

/** Reads what `ra look` was pointed at: a named state, a path in the app, or a full address. */
function target(project: Project, given: string): { state: State; url?: string } {
  const adHoc = (name: string, url: string): State => ({ name, url, local: false, world: project.world, views: project.views, accept: [] });
  const slug = (path: string) => path.replaceAll(/[^A-Za-z0-9]+/gu, "-").replaceAll(/^-+|-+$/gu, "").slice(0, 40) || "page";
  if (/^https?:\/\//u.test(given)) {
    let address: URL;
    try {
      address = new URL(given);
    } catch {
      throw new UsageError(`"${given}" is not an address.`);
    }
    return { state: adHoc(slug(address.pathname), address.pathname + address.search + address.hash), url: address.origin };
  }
  if (given.startsWith("/")) return { state: adHoc(slug(given.split(/[?#]/u)[0]!), given) };
  return { state: findState(project, given) };
}

function views(project: Project, state: State, at: string | undefined, otherwise: "first" | "all"): View[] {
  if (at === undefined) return otherwise === "all" ? state.views : state.views.slice(0, 1);
  if (at === "all") return state.views;
  return at.split(",").map((name) => resolveView(name.trim(), project.customViews));
}

function code(given: string | undefined): string | undefined {
  if (given === undefined || !given.startsWith("@")) return given;
  const file = given.slice(1);
  if (!existsSync(file)) throw new UsageError(`--then points at ${file}, which does not exist.`);
  return readFileSync(file, "utf8");
}

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function look(project: Project, flags: Flags, names: string[]): Promise<number> {
  if (names.length !== 1) throw new UsageError("ra look takes one state, path or address, such as: ra look home --at phone");
  const { state, url } = target(project, names[0]!);
  const then = code(flags.then);
  const jobs: Job[] = views(project, state, flags.at, "first").map((view) => ({ state, view }));
  return withSession(project, flags, { ...(url === undefined ? {} : { url }), states: [state] }, async (session) => {
    const observations = await session.lookAll(jobs, {
      directory: workDirectory(project, "look"),
      lines: flags.full === true ? Infinity : 60,
      ...(flags.in === undefined ? {} : { scope: flags.in }),
      ...(then === undefined ? {} : { then }),
    });
    if (flags.json === true) {
      print(JSON.stringify({ origin: session.origin, receipt: session.receipt, notes: session.notes, looks: observations }, null, 2));
    } else {
      print(looksText(observations));
      for (const note of session.notes) print(`note: ${note}`);
      print(receiptLine(session.receipt));
    }
    return 0;
  });
}

function selected(project: Project, names: string[]): State[] {
  if (project.states.length === 0) {
    throw new UsageError('This project names no states. Add some to ra.config.ts, such as states: { home: "/" }, or look at one address with ra look.');
  }
  return names.length === 0 ? project.states : names.map((name) => findState(project, name));
}

function plan(project: Project, session: Session, states: State[], at: string | undefined): { jobs: Job[]; skipped: Array<{ state: string; why: string }> } {
  const jobs: Job[] = [];
  const skipped: Array<{ state: string; why: string }> = [];
  for (const state of states) {
    if (session.live && state.local) {
      skipped.push({ state: state.name, why: "it needs its own world or steps, which a deployment does not get" });
      continue;
    }
    for (const view of views(project, state, at, "all")) jobs.push({ state, view });
  }
  return { jobs, skipped };
}

async function check(project: Project, flags: Flags, names: string[]): Promise<number> {
  const states = selected(project, names);
  return withSession(project, flags, {}, async (session) => {
    const { jobs, skipped } = plan(project, session, states, flags.at);
    const started = performance.now();
    const observations = await session.lookAll(jobs, {
      directory: workDirectory(project, "check"),
      lines: 60,
      ...(flags.jobs === undefined ? {} : { jobs: Number(flags.jobs) }),
    });
    const whole = names.length === 0 && flags.at === undefined && skipped.length === 0;
    const rules = new Set<Accept>(project.states.flatMap((state) => state.accept));
    const unused = whole ? [...rules].filter((rule) => !session.accepted.has(rule)) : [];
    const summary = checkText(states, observations, {
      origin: session.origin,
      live: session.live,
      ms: performance.now() - started,
      receipt: session.receipt,
      notes: session.notes,
      skipped,
      unused,
    });
    if (flags.json === true) {
      print(JSON.stringify({ ok: summary.ok, origin: session.origin, live: session.live, receipt: session.receipt, notes: session.notes, skipped, looks: observations }, null, 2));
    } else {
      print(summary.text);
    }
    return summary.ok ? 0 : 1;
  });
}

async function snap(project: Project, flags: Flags, names: string[]): Promise<number> {
  const states = selected(project, names);
  return withSession(project, flags, {}, async (session) => {
    const { jobs, skipped } = plan(project, session, states, flags.at);
    const directory = workDirectory(project, "base");
    const observations = await session.lookAll(jobs, { directory, lines: 2000 });
    for (const observation of observations) {
      writeFileSync(join(directory, `${observation.state}.${observation.view}.json`), JSON.stringify(observation));
    }
    const withFindings = observations.filter((observation) => observation.findings.some((finding) => finding.accepted === undefined)).length;
    if (flags.json === true) {
      print(JSON.stringify({ kept: observations.length, directory, skipped }, null, 2));
    } else {
      print(
        `Kept ${observations.length} look${observations.length === 1 ? "" : "s"} as the snapshot`
          + `${withFindings === 0 ? "" : ` (${withFindings} already have findings; ra check lists them)`}. Make the change, then: ra diff`,
      );
      for (const { state, why } of skipped) print(`- ${state}  skipped: ${why}`);
    }
    return 0;
  });
}

async function diff(project: Project, flags: Flags, names: string[]): Promise<number> {
  const states = selected(project, names);
  return withSession(project, flags, {}, async (session) => {
    const base = workDirectory(project, "base");
    const planned = plan(project, session, states, flags.at);
    const missing: string[] = [];
    const jobs = planned.jobs.filter((job) => {
      const kept = existsSync(join(base, `${job.state.name}.${job.view.name}.json`));
      if (!kept) missing.push(`${job.state.name} at ${job.view.name}`);
      return kept;
    });
    const observations = await session.lookAll(jobs, { directory: workDirectory(project, "now"), lines: 2000 });
    const changes: Change[] = [];
    const pictures = new Map<Change, string>();
    let taken: string | null = null;
    for (const after of observations) {
      const before = JSON.parse(readFileSync(join(base, `${after.state}.${after.view}.json`), "utf8")) as Observation;
      if (taken === null || before.at < taken) taken = before.at;
      const both = before.fullPicture !== null && after.fullPicture !== null && existsSync(before.fullPicture);
      const afterPicture = both ? decodePng(readFileSync(after.fullPicture!)) : undefined;
      const change = compareLooks(before, after, both ? { before: decodePng(readFileSync(before.fullPicture!)), after: afterPicture! } : undefined);
      changes.push(change);
      if (change.areas.length > 0 && afterPicture !== undefined) {
        frame(afterPicture, change.areas.slice(0, 12));
        const file = join(workDirectory(project, "diff"), `${after.state}.${after.view}.png`);
        writeFileSync(file, encodePng(afterPicture));
        pictures.set(change, file);
      }
    }
    if (flags.json === true) {
      print(JSON.stringify({ taken, missing, changes: changes.map((change) => ({ ...change, picture: pictures.get(change) ?? null })) }, null, 2));
    } else {
      print(diffText(changes, pictures, missing, taken));
    }
    return 0;
  });
}

async function doctor(project: Project, flags: Flags): Promise<number> {
  const lines = [`ra ${version()} — node ${process.versions.node} — ${process.platform} ${process.arch}`];
  lines.push(project.file === null ? "config: none found from here (ra can still look at any address)" : `config: ${project.file} (${project.states.length} states)`);
  let receipt: Awaited<ReturnType<typeof openBrowser>>["receipt"] | undefined;
  let problem: string | undefined;
  try {
    const playwright = loadPlaywright(project.root);
    lines.push(`playwright-core: ${playwright.version} at ${playwright.root}`);
    const owned = await openBrowser({ from: project.root });
    receipt = owned.receipt;
    await owned.close();
    lines.push(`browser: Chromium ${receipt.version}, headless, started and closed cleanly`);
    lines.push(`executable: ${receipt.executable}`);
    lines.push(`policy: audio muted; one --disable-features switch holding ${receipt.disabledFeatures.join(", ")}`);
    lines.push("closed world: outside hosts do not resolve unless a world allows them");
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
    lines.push(`problem: ${problem}`);
  }
  if (flags.json === true) print(JSON.stringify({ ok: problem === undefined, version: version(), node: process.versions.node, config: project.file, receipt: receipt ?? null, problem: problem ?? null }, null, 2));
  else print(lines.join("\n"));
  return problem === undefined ? 0 : 3;
}

async function main(argv: string[]): Promise<number> {
  let parsed: { values: Flags; positionals: string[] };
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        at: { type: "string" },
        in: { type: "string" },
        then: { type: "string" },
        full: { type: "boolean" },
        json: { type: "boolean" },
        url: { type: "string" },
        allow: { type: "string", multiple: true },
        config: { type: "string" },
        jobs: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values: flags, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (flags.version === true) {
    print(version());
    return 0;
  }
  if (flags.help === true || command === undefined || command === "help") {
    print(HELP);
    return 0;
  }
  const project = await loadProject(process.cwd(), flags.config);
  switch (command) {
    case "look":
      return look(project, flags, rest);
    case "check":
      return check(project, flags, rest);
    case "snap":
      return snap(project, flags, rest);
    case "diff":
      return diff(project, flags, rest);
    case "states":
      print(flags.json === true ? JSON.stringify(project.states.map(({ name, url, note, local, views: at }) => ({ name, url, note: note ?? null, local, views: at.map((view) => view.name) })), null, 2) : statesText(project));
      return 0;
    case "doctor":
      return doctor(project, flags);
    default:
      throw new UsageError(`ra has no command "${command}". Run ra help.`);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (active?.close() ?? Promise.resolve()).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

if (process.versions.bun !== undefined) {
  // playwright-core's connection to the browser stalls under Bun.
  process.stderr.write("ra: run ra with Node, not Bun. bunx ra and bun run use Node already unless given --bun.\n");
  process.exit(2);
}

main(process.argv.slice(2)).then(
  (status) => {
    process.exitCode = status;
  },
  (error: unknown) => {
    const usage = error instanceof UsageError || error instanceof ConfigError;
    const known = usage || error instanceof AppError || error instanceof BrowserPolicyError;
    process.stderr.write(`ra: ${known ? (error as Error).message : error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = usage ? 2 : 3;
  },
);
