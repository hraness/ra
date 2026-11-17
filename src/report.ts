/**
 * What ra prints. Everything here is written to be read by an agent in a
 * terminal: plain text, findings first, no decoration that costs tokens.
 */
import { homedir } from "node:os";
import { relative } from "node:path";
import type { BrowserReceipt } from "./browser.ts";
import type { Accept, Project, State } from "./config.ts";
import type { Change } from "./diff.ts";
import type { Finding, Observation } from "./observe.ts";

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function near(path: string): string {
  const here = relative(process.cwd(), path);
  return here.startsWith("..") ? path.replace(homedir(), "~") : here;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** One line saying which browser ran. */
export function receiptLine(receipt: BrowserReceipt): string {
  return `browser: Chromium ${receipt.version}, playwright-core ${receipt.playwright}, ${receipt.executable.replace(homedir(), "~")}`;
}

function findingLines(finding: Finding, label: string, width: number, suffix = ""): string[] {
  const lines = [`  ${label.padEnd(width)}  ${finding.message}${suffix}`];
  if (finding.where !== "" && !finding.message.includes(finding.where)) lines.push(`  ${"".padEnd(width)}  at ${finding.where}`);
  return lines;
}

function requestsLine(observation: Observation): string {
  const { total, replied, allowed, blocked, unexpected } = observation.requests;
  const parts = [plural(total, "request")];
  if (replied > 0) parts.push(`${replied} answered by the world`);
  if (allowed > 0) parts.push(`${allowed} let out`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  if (unexpected > 0) parts.push(`${unexpected} stopped`);
  return parts.join(", ");
}

export interface LookTextOptions {
  /** Leave the outline out, as when another view already showed the same one. */
  sameOutlineAs?: string;
}

/** The digest of one look. */
export function lookText(observation: Observation, options: LookTextOptions = {}): string {
  const out: string[] = [];
  const status = observation.status === null ? "no response" : String(observation.status);
  out.push(`${observation.state} at ${observation.view} (${observation.viewport.width}×${observation.viewport.height})`);
  out.push(`${observation.url} — ${status}${observation.title === "" ? "" : ` — ${JSON.stringify(observation.title)}`}`);
  out.push(`page ${observation.page.width}×${observation.page.height}, ${requestsLine(observation)}, ${seconds(observation.ms)}`);

  const open = observation.findings.filter((finding) => finding.accepted === undefined);
  const accepted = observation.findings.filter((finding) => finding.accepted !== undefined);
  out.push("");
  if (open.length === 0) {
    out.push(accepted.length === 0 ? "no findings" : `no findings (${accepted.length} accepted)`);
  } else {
    out.push(plural(open.length, "finding"));
    const width = Math.max(...open.map((finding) => finding.kind.length));
    for (const finding of open) out.push(...findingLines(finding, finding.kind, width));
  }
  for (const finding of accepted) out.push(`  accepted ${finding.kind}: ${finding.message} (${finding.accepted})`);
  for (const note of observation.notes) out.push(`note: ${note}`);

  if (observation.returned !== undefined) {
    out.push("", "returned");
    for (const line of observation.returned.split("\n")) out.push(`  ${line}`);
  }

  if (options.sameOutlineAs !== undefined) {
    out.push("", `outline: the same as at ${options.sameOutlineAs}`);
  } else if (observation.outline.length > 0) {
    const cut = observation.outlineFull > observation.outline.length;
    out.push("", cut ? `outline (${observation.outline.length} of ${observation.outlineFull} lines; --full shows all)` : "outline");
    for (const line of observation.outline) out.push(`  ${line}`);
  }

  if (observation.regions.length > 0) {
    out.push("", "layout");
    const labels = observation.regions.map((region) => `${"  ".repeat(region.depth)}${region.label}`);
    const width = Math.min(44, Math.max(...labels.map((label) => label.length)));
    observation.regions.forEach((region, index) => {
      const place = `${region.width}×${region.height} at ${region.x},${region.y}`;
      out.push(`  ${labels[index]!.padEnd(width)}  ${place}${region.note === "" ? "" : `  ${region.note}`}`);
    });
  }

  const pictures: string[] = [];
  if (observation.picture !== null) pictures.push(`${near(observation.picture)} (first screen)`);
  if (observation.fullPicture !== null) pictures.push(`${near(observation.fullPicture)} (whole page)`);
  if (pictures.length > 0) out.push("", `pictures: ${pictures.join(", ")}`);
  return out.join("\n");
}

/** Several looks, one after another. A view whose outline matches an earlier one of the same state says so instead of repeating it. */
export function looksText(observations: readonly Observation[]): string {
  const parts: string[] = [];
  const seen = new Map<string, string>();
  for (const observation of observations) {
    const key = `${observation.state}\n${observation.outline.join("\n")}`;
    const same = observation.outline.length > 6 ? seen.get(key) : undefined;
    parts.push(lookText(observation, same === undefined ? {} : { sameOutlineAs: same }));
    if (!seen.has(key)) seen.set(key, observation.view);
  }
  return parts.join("\n\n———\n\n");
}

interface Grouped {
  finding: Finding;
  views: string[];
}

function groupFindings(observations: readonly Observation[], accepted: boolean): Grouped[] {
  const groups = new Map<string, Grouped>();
  for (const observation of observations) {
    for (const finding of observation.findings) {
      if ((finding.accepted !== undefined) !== accepted) continue;
      // The same problem at two widths differs only in its numbers.
      const key = `${finding.kind} ${finding.message.replaceAll(/\d+(?:\.\d+)?/gu, "#")}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { finding, views: [observation.view] });
      else if (!group.views.includes(observation.view)) group.views.push(observation.view);
    }
  }
  return [...groups.values()];
}

export interface CheckSummary {
  /** Whether every look came back without an open finding. */
  ok: boolean;
  findings: number;
  text: string;
}

export interface CheckTextOptions {
  origin: string;
  live: boolean;
  ms: number;
  receipt: BrowserReceipt;
  notes: readonly string[];
  /** States left out, with the reason. */
  skipped: ReadonlyArray<{ state: string; why: string }>;
  /** Accept entries that matched nothing, when every state was checked. */
  unused: readonly Accept[];
}

/** The result of checking many states: failing states first, each finding once with the views it shows at. */
export function checkText(states: readonly State[], observations: readonly Observation[], options: CheckTextOptions): CheckSummary {
  const out: string[] = [];
  const byState = new Map<string, Observation[]>();
  for (const observation of observations) byState.set(observation.state, [...(byState.get(observation.state) ?? []), observation]);
  out.push(
    `ra check — ${plural(byState.size, "state")}, ${plural(observations.length, "look")} in ${seconds(options.ms)} — ${options.origin}${options.live ? " (a deployment)" : ""}`,
    "",
  );

  let findings = 0;
  const failing: string[] = [];
  const passing: string[] = [];
  let firstFailure: { state: string; view: string } | undefined;
  for (const state of states) {
    const looks = byState.get(state.name);
    if (looks === undefined) continue;
    const open = groupFindings(looks, false);
    const accepted = groupFindings(looks, true);
    const everyView = looks.map((look) => look.view);
    if (open.length === 0) {
      passing.push(`✓ ${state.name}${accepted.length === 0 ? "" : `  (${accepted.length} accepted)`}`);
      continue;
    }
    findings += open.length;
    firstFailure ??= { state: state.name, view: open[0]!.views[0]! };
    failing.push(`✗ ${state.name}  ${state.url}`);
    // Views are named only for a finding that shows at some of them.
    const width = Math.max(...open.map((group) => group.finding.kind.length));
    for (const group of open) {
      const some = group.views.length < everyView.length ? ` [${group.views.join(", ")}]` : "";
      failing.push(...findingLines(group.finding, group.finding.kind, width, some));
    }
    for (const note of new Set(looks.flatMap((look) => look.notes))) failing.push(`  note: ${note}`);
  }
  out.push(...failing);
  if (failing.length > 0 && passing.length > 0) out.push("");
  out.push(...passing);
  for (const { state, why } of options.skipped) out.push(`- ${state}  skipped: ${why}`);

  out.push("");
  const failed = failing.filter((line) => line.startsWith("✗ ")).length;
  if (findings === 0) {
    out.push(`All ${plural(byState.size, "state")} look right.`);
  } else {
    out.push(`${plural(findings, "finding")} in ${failed} of ${plural(byState.size, "state")}. Look closer: ra look ${firstFailure!.state} --at ${firstFailure!.view}`);
  }
  for (const rule of options.unused) {
    out.push(`note: the accept entry for ${rule.finding}${rule.match === undefined ? "" : ` matching ${String(rule.match)}`} matched nothing; it can go.`);
  }
  for (const note of options.notes) out.push(`note: ${note}`);
  out.push(receiptLine(options.receipt));
  return { ok: findings === 0, findings, text: out.join("\n") };
}

/** The list of states a project has. */
export function statesText(project: Project): string {
  if (project.states.length === 0) {
    return project.file === null
      ? 'No ra.config.ts here. ra can still look at any address: ra look http://127.0.0.1:3000/ --at phone\nTo name states, add ra.config.ts:\n\n  import { defineConfig } from "@hraness/ra";\n  export default defineConfig({ app: { command: "bun run dev --port {port}" }, states: { home: "/" } });'
      : `${near(project.file)} has no states yet. Add some: states: { home: "/" }`;
  }
  const out: string[] = [];
  const app = project.app === undefined ? "no app configured (pass --url)" : "command" in project.app ? project.app.command : "static" in project.app ? `static files in ${project.app.static}` : project.app.url;
  out.push(`${plural(project.states.length, "state")} in ${near(project.file ?? project.root)} — app: ${app} — views: ${project.views.map((view) => view.name).join(", ")}`, "");
  const names = Math.max(...project.states.map((state) => state.name.length));
  const urls = Math.min(40, Math.max(...project.states.map((state) => state.url.length)));
  const sameViews = (state: State) => state.views.length === project.views.length && state.views.every((view, index) => view.name === project.views[index]!.name);
  for (const state of project.states) {
    const marks: string[] = [];
    if (Object.keys(state.world.upstreams).length > 0) marks.push("upstream replies");
    if (state.steps !== undefined) marks.push("steps");
    if (state.see !== undefined || state.expect !== undefined) marks.push("expectations");
    if (!sameViews(state)) marks.push(`only at ${state.views.map((view) => view.name).join(", ")}`);
    if (state.local) marks.push("local only");
    const tail = [state.note ?? "", marks.length === 0 ? "" : `[${marks.join("; ")}]`].filter(Boolean).join("  ");
    out.push(`${state.name.padEnd(names)}  ${state.url.padEnd(urls)}  ${tail}`.trimEnd());
  }
  return out.join("\n");
}

/** What changed since the snapshot. */
export function diffText(changes: readonly Change[], pictures: ReadonlyMap<Change, string>, missing: readonly string[], taken: string | null): string {
  const out: string[] = [];
  const changed = changes.filter((change) => change.changed);
  const same = changes.filter((change) => !change.changed);
  const when = taken === null ? "" : ` since the snapshot of ${taken.replace("T", " ").replace(/\.\d+Z$/u, " UTC")}`;
  out.push(`ra diff — ${changed.length} of ${plural(changes.length, "look")} changed${when}`, "");
  for (const change of changed) {
    out.push(`${change.state} at ${change.view}`);
    for (const line of change.lines) out.push(`  ${line}`);
    const picture = pictures.get(change);
    if (picture !== undefined) out.push(`  picture: ${near(picture)} (changes framed)`);
    out.push("");
  }
  if (same.length > 0) {
    const byState = new Map<string, string[]>();
    for (const change of same) byState.set(change.state, [...(byState.get(change.state) ?? []), change.view]);
    out.push(`unchanged: ${[...byState.entries()].map(([state, views]) => `${state} (${views.join(", ")})`).join(", ")}`);
  }
  if (missing.length > 0) out.push(`no snapshot yet for: ${missing.join(", ")}. Take one with ra snap.`);
  return out.join("\n").trimEnd();
}
