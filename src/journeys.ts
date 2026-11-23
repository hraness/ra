import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ConfigError } from "./config.ts";
import { workDirectory } from "./run.ts";

interface Step { action: string; expect: string; image?: string }
interface Journey { title: string; start: string; steps: Step[]; run: string[]; cwd?: string; sources: string[] }
interface MapFile { version: 1; journeys: Record<string, Journey> }
const name = "ra.journeys.json";

function fail(message: string): never { throw new ConfigError(message); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function words(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.length > 0 && value.every(words); }
function local(path: string): boolean {
  return !isAbsolute(path) && !path.includes("\\") && !path.split("/").includes("..") && !path.includes("\0");
}
function requirePath(root: string, path: string, label: string, directory = false): void {
  if (!local(path)) fail(`${label}: expected a project-relative path, got ${path}.`);
  const stat = statSync(resolve(root, path), { throwIfNoEntry: false });
  if (!(directory ? stat?.isDirectory() : stat?.isFile())) fail(`${label}: missing ${directory ? "directory" : "source"} ${path}.`);
}

/** Discovery never imports or executes the project, including its browser config. */
export function readJourneys(from = process.cwd()): { root: string; file: string; map: MapFile } {
  let root = resolve(from);
  while (!existsSync(join(root, name))) {
    if (dirname(root) === root || existsSync(join(root, ".git"))) fail(`No ${name} in this project. Add a journey with its starting fixture, user actions, expected results and a replay command.`);
    root = dirname(root);
  }
  const file = join(root, name);
  let map: unknown;
  try { map = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { fail(`Cannot read ${file}: ${(error as Error).message}`); }
  if (!object(map) || map.version !== 1 || !object(map.journeys) || !Object.keys(map.journeys).length) fail(`${file} needs version 1 and at least one named journey.`);
  for (const [id, journey] of Object.entries(map.journeys)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) || !object(journey)) fail(`Invalid journey ${JSON.stringify(id)}.`);
    if (!words(journey.title) || !words(journey.start) || !strings(journey.run) || !strings(journey.sources)) {
      fail(`${id} needs a title, starting fixture, replay command as an argument array, and source files.`);
    }
    for (const source of journey.sources) requirePath(root, source, id);
    if (journey.cwd !== undefined) {
      if (!words(journey.cwd)) fail(`${id}: cwd needs a project-relative directory.`);
      requirePath(root, journey.cwd, id, true);
    }
    if (!Array.isArray(journey.steps) || !journey.steps.length) fail(`${id} needs at least one step.`);
    const images = new Set([resolve("/", "walk.json"), resolve("/", "replay.log")]);
    for (const [index, step] of journey.steps.entries()) {
      if (!object(step) || !words(step.action) || !words(step.expect)) fail(`${id} step ${index + 1} needs a user action and observable result.`);
      if (step.image === undefined) continue;
      if (!words(step.image) || !local(step.image) || resolve("/", step.image) === "/" || images.has(resolve("/", step.image))) fail(`${id} step ${index + 1} needs a distinct relative image path.`);
      images.add(resolve("/", step.image));
    }
  }
  return { root, file, map: map as unknown as MapFile };
}

export function describeJourney(id: string, journey: Journey): string {
  const lines = [`${id} — ${journey.title}`, `Start: ${journey.start}`];
  journey.steps.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${step.action}`, `     Expect: ${step.expect}`);
    if (step.image) lines.push(`     Image: ${step.image}`);
  });
  lines.push(`Sources: ${journey.sources.join(", ")}`, `Replay: ra walk ${id}`);
  return lines.join("\n");
}

let active: ChildProcess | undefined;
export function stopWalk(signal: NodeJS.Signals): void {
  if (!active?.pid) return;
  try {
    if (process.platform === "win32") active.kill(signal);
    else process.kill(-active.pid, signal);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

export async function journeyCommand(command: "map" | "walk", names: string[], json: boolean): Promise<number> {
  if (names.length > 1 || (command === "walk" && names.length !== 1)) fail(`Usage: ra ${command} ${command === "map" ? "[journey]" : "<journey>"}`);
  const project = readJourneys();
  const id = names[0];
  const journey = id !== undefined && Object.hasOwn(project.map.journeys, id) ? project.map.journeys[id] : undefined;
  if (id !== undefined && !journey) fail(`No journey ${JSON.stringify(id)}. Choose from ${Object.keys(project.map.journeys).join(", ")}.`);
  if (command === "map") {
    const entries = id && journey ? { [id]: journey } : project.map.journeys;
    console.log(json ? JSON.stringify({ version: 1, journeys: entries }, null, 2) :
      Object.entries(entries).map(([key, value]) => describeJourney(key, value)).join("\n\n"));
    return 0;
  }
  if (!journey || !id) fail("Choose a journey to replay.");
  const output = mkdtempSync(join(workDirectory(project, "walks"), id + "-"));
  const args = journey.run[0] === "ra" ? [process.execPath, process.argv[1]!, ...journey.run.slice(1)] : journey.run;
  if (!json) console.log(describeJourney(id, journey));
  const log = openSync(join(output, "replay.log"), "wx");
  const child = spawn(args[0]!, args.slice(1), {
    cwd: resolve(project.root, journey.cwd ?? "."), env: { ...process.env, RA_WALK_DIR: output },
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  active = child;
  for (const stream of [child.stdout!, child.stderr!]) {
    stream.on("data", (chunk: Buffer) => writeSync(log, chunk));
  }
  child.stdout!.pipe(json ? process.stderr : process.stdout, { end: false });
  child.stderr!.pipe(process.stderr, { end: false });
  const problem = await new Promise<string | null>((done) => {
    child.once("error", (error) => done(error.message));
    child.once("close", (code, signal) => done(code === 0 ? null : `Replay stopped with ${signal ?? `exit ${code}`}.`));
  });
  closeSync(log);
  active = undefined;
  const missing = journey.steps.flatMap((step) => {
    if (!step.image) return [];
    const stat = statSync(join(output, step.image), { throwIfNoEntry: false });
    return stat?.isFile() && stat.size > 0 ? [] : [step.image];
  });
  const error = problem ?? (missing.length ? `Replay did not produce ${missing.join(", ")}.` : null);
  const receipt = { journey: id, passed: error === null, error, directory: relative(project.root, output).split(sep).join("/"), steps: journey.steps };
  writeFileSync(join(output, "walk.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(json ? JSON.stringify(receipt) : `${error ? "Failed" : "Passed"}: ${journey.title}. ${error ?? ""}\nEvidence: ${output}`);
  return error === null ? 0 : 1;
}
