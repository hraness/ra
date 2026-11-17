/**
 * What changed between two looks at the same state, said in words: which
 * elements moved or resized, which outline lines came and went, which
 * findings are new, and where the pixels differ.
 */
import type { Box } from "./inspect.ts";
import type { Finding, Observation } from "./observe.ts";
import { comparePixels, type Image, type Rect } from "./png.ts";

export interface Change {
  state: string;
  view: string;
  /** Whether anything differs. */
  changed: boolean;
  /** What differs, a line each. */
  lines: string[];
  /** Share of the picture that changed, from 0 to 1. */
  pixels: number;
  /** Where the pixels changed, largest first, in page pixels. */
  areas: Rect[];
}

/** Lines that are only in one of two lists, keeping their order. */
export function lineChanges(before: readonly string[], after: readonly string[]): { removed: string[]; added: string[] } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  if (a.length === 0 || b.length === 0) return { removed: a, added: b };
  if (a.length * b.length > 4_000_000) {
    // Too long to align; fall back to what each side has that the other lacks.
    const inA = new Set(a);
    const inB = new Set(b);
    return { removed: a.filter((line) => !inB.has(line)), added: b.filter((line) => !inA.has(line)) };
  }
  // Longest common subsequence, then everything outside it.
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      removed.push(a[i++]!);
    } else {
      added.push(b[j++]!);
    }
  }
  removed.push(...a.slice(i));
  added.push(...b.slice(j));
  return { removed, added };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function listed(items: readonly string[], limit: number): string {
  return items.length <= limit ? items.join(", ") : `${items.slice(0, limit).join(", ")} and ${items.length - limit} more`;
}

function direction(dx: number, dy: number): string {
  const parts: string[] = [];
  if (dy !== 0) parts.push(`${Math.abs(dy)}px ${dy > 0 ? "down" : "up"}`);
  if (dx !== 0) parts.push(`${Math.abs(dx)}px ${dx > 0 ? "right" : "left"}`);
  return parts.join(" and ");
}

function growth(dw: number, dh: number): string {
  const parts: string[] = [];
  if (dw !== 0) parts.push(`${Math.abs(dw)}px ${dw > 0 ? "wider" : "narrower"}`);
  if (dh !== 0) parts.push(`${Math.abs(dh)}px ${dh > 0 ? "taller" : "shorter"}`);
  return parts.join(" and ");
}

/** Describes how the notable elements of a page moved, resized, appeared or went away. */
export function boxChanges(before: readonly Box[], after: readonly Box[]): string[] {
  const earlier = new Map(before.map((box) => [box.key, box]));
  const later = new Map(after.map((box) => [box.key, box]));
  const moved = new Map<string, Box[]>();
  const resized = new Map<string, Array<{ from: Box; to: Box }>>();
  const gone: string[] = [];
  for (const from of before) {
    const to = later.get(from.key);
    if (to === undefined) {
      gone.push(from.key);
      continue;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dw = to.width - from.width;
    const dh = to.height - from.height;
    if (Math.abs(dw) > 1 || Math.abs(dh) > 1) {
      const key = `${Math.abs(dw) > 1 ? dw : 0},${Math.abs(dh) > 1 ? dh : 0}`;
      resized.set(key, [...(resized.get(key) ?? []), { from, to }]);
    } else if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      const key = `${Math.abs(dx) > 1 ? dx : 0},${Math.abs(dy) > 1 ? dy : 0}`;
      moved.set(key, [...(moved.get(key) ?? []), to]);
    }
  }
  const appeared = after.filter((box) => !earlier.has(box.key)).map((box) => box.key);

  const lines: string[] = [];
  const size = (box: Box) => `${box.width}×${box.height}`;
  const resizes = [...resized.entries()].sort((a, b) => a[1].length - b[1].length);
  let shown = 0;
  for (const [key, list] of resizes) {
    if (shown >= 8) {
      lines.push(`resized: ${plural(resizes.length - shown, "more group")} of elements changed size`);
      break;
    }
    const [dw = 0, dh = 0] = key.split(",").map(Number);
    const first = list[0]!;
    lines.push(
      list.length === 1
        ? `resized: ${first.from.key} ${size(first.from)} → ${size(first.to)}`
        : `resized: ${list.length} elements are ${growth(dw, dh)}, starting with ${first.from.key} (${size(first.from)} → ${size(first.to)})`,
    );
    shown++;
  }
  const moves = [...moved.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [index, [key, list]] of moves.entries()) {
    if (index >= 4) {
      lines.push(`moved: ${plural(moves.length - index, "more group")} of elements moved`);
      break;
    }
    const [dx = 0, dy = 0] = key.split(",").map(Number);
    const first = [...list].sort((a, b) => a.y - b.y || a.x - b.x)[0]!;
    lines.push(list.length === 1 ? `moved: ${first.key} ${direction(dx, dy)}` : `moved: ${list.length} elements ${direction(dx, dy)}, from ${first.key} on`);
  }
  if (appeared.length > 0) lines.push(`appeared: ${listed(appeared, 6)}`);
  if (gone.length > 0) lines.push(`gone: ${listed(gone, 6)}`);
  return lines;
}

function around(area: Rect, boxes: readonly Box[], page: { width: number; height: number }): string {
  if (area.width * area.height > page.width * page.height * 0.6) return "most of the page";
  const size = area.width * area.height;
  const overlap = (box: Box) =>
    Math.max(0, Math.min(area.x + area.width, box.x + box.width) - Math.max(area.x, box.x))
    * Math.max(0, Math.min(area.y + area.height, box.y + box.height) - Math.max(area.y, box.y));
  // The smallest element holding most of the area, when it is not much bigger than the area.
  let holder: Box | undefined;
  for (const box of boxes) {
    const boxSize = box.width * box.height;
    if (overlap(box) >= size * 0.8 && boxSize <= size * 2.5 && (holder === undefined || boxSize < holder.width * holder.height)) holder = box;
  }
  if (holder !== undefined) return holder.key;
  // Otherwise the elements inside the area, first to last.
  const inside = boxes.filter((box) => box.width * box.height > 0 && overlap(box) >= box.width * box.height * 0.5).sort((a, b) => a.y - b.y || a.x - b.x);
  if (inside.length === 1) return inside[0]!.key;
  if (inside.length > 1) return `${inside[0]!.key} to ${inside.at(-1)!.key}`;
  let nearest: Box | undefined;
  let most = 0;
  for (const box of boxes) {
    if (overlap(box) > most) {
      most = overlap(box);
      nearest = box;
    }
  }
  return nearest === undefined ? "a part with nothing named in it" : `part of ${nearest.key}`;
}

function findingKey(finding: Finding): string {
  return `${finding.kind} ${finding.message.replaceAll(/\d+(?:\.\d+)?/gu, "#")}`;
}

/** Compares two looks at the same state through the same view. */
export function compareLooks(before: Observation, after: Observation, pictures?: { before: Image; after: Image }): Change {
  const lines: string[] = [];
  if (before.status !== after.status) lines.push(`status: ${String(before.status)} → ${String(after.status)}`);
  if (before.title !== after.title) lines.push(`title: ${JSON.stringify(before.title)} → ${JSON.stringify(after.title)}`);
  if (before.page.width !== after.page.width || before.page.height !== after.page.height) {
    lines.push(`page: ${before.page.width}×${before.page.height} → ${after.page.width}×${after.page.height}`);
  }

  let pixels = 0;
  let areas: Rect[] = [];
  if (pictures !== undefined) {
    const difference = comparePixels(pictures.before, pictures.after);
    pixels = difference.ratio;
    areas = difference.areas;
    if (areas.length > 0) {
      const percent = pixels * 100;
      const share = percent >= 10 ? Math.round(percent) : percent >= 0.1 ? Math.round(percent * 10) / 10 : "under 0.1";
      const named = areas.slice(0, 4).map((area) => `${around(area, after.boxes, after.page)} (${area.width}×${area.height} at ${area.x},${area.y})`);
      const more = areas.length > 4 ? `; and ${areas.length - 4} smaller` : "";
      lines.push(`pixels: ${share}% changed in ${plural(areas.length, "area")}: ${named.join("; ")}${more}`);
    }
  }

  lines.push(...boxChanges(before.boxes, after.boxes));

  const outline = lineChanges(before.outline.map((line) => line.trim()), after.outline.map((line) => line.trim()));
  if (outline.removed.length > 0 || outline.added.length > 0) {
    lines.push(`outline: ${outline.added.length} added, ${outline.removed.length} removed`);
    for (const line of outline.removed.slice(0, 8)) lines.push(`  - ${line}`);
    if (outline.removed.length > 8) lines.push(`  - … ${outline.removed.length - 8} more`);
    for (const line of outline.added.slice(0, 8)) lines.push(`  + ${line}`);
    if (outline.added.length > 8) lines.push(`  + … ${outline.added.length - 8} more`);
  }

  const had = new Set(before.findings.map(findingKey));
  const has = new Set(after.findings.map(findingKey));
  for (const finding of after.findings) {
    if (!had.has(findingKey(finding))) lines.push(`new finding: ${finding.kind} — ${finding.message}`);
  }
  for (const finding of before.findings) {
    if (!has.has(findingKey(finding))) lines.push(`finding gone: ${finding.kind} — ${finding.message}`);
  }

  return { state: after.state, view: after.view, changed: lines.length > 0, lines, pixels, areas };
}
