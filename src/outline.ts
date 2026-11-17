/**
 * Turns Playwright's accessibility snapshot into a short outline.
 *
 * The snapshot is the authority on roles and names, so an outline line maps
 * straight onto `page.getByRole(role, { name })`. This module only makes it
 * cheaper to read: links carry their address, wrappers that add nothing are
 * dropped, text is shortened, and long runs of similar items are folded.
 */

export interface OutlineNode {
  role: string;
  name: string;
  /** States such as `level=2`, `checked`, `disabled`. */
  attributes: string[];
  text: string;
  url: string;
  children: OutlineNode[];
}

export interface OutlineOptions {
  /** The most lines to print. Defaults to 80. Use Infinity for everything. */
  lines?: number;
  /** An origin to leave off link addresses. */
  origin?: string;
}

export interface Outline {
  lines: string[];
  /** How many lines the outline would take untrimmed. */
  full: number;
}

const PROSE = new Set([
  "text", "paragraph", "emphasis", "strong", "generic", "code", "mark", "insertion", "deletion",
  "subscript", "superscript", "time", "term", "definition", "blockquote", "caption",
]);
const WRAPPERS = new Set(["generic", "rowgroup", "presentation", "none"]);
const HIDDEN_ATTRIBUTES = /^(?:ref|cursor)=/u;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return String(JSON.parse(trimmed));
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function parseItem(content: string): OutlineNode {
  let key = content;
  let value = "";
  if (content.startsWith("'")) {
    let index = 1;
    let out = "";
    while (index < content.length) {
      if (content[index] === "'") {
        if (content[index + 1] !== "'") break;
        out += "'";
        index += 2;
        continue;
      }
      out += content[index];
      index++;
    }
    key = out;
    const rest = content.slice(index + 1);
    value = rest.startsWith(":") ? rest.slice(1) : "";
  } else {
    let inName = false;
    for (let index = 0; index < content.length; index++) {
      const character = content[index];
      if (character === "\\" && inName) {
        index++;
      } else if (character === '"') {
        inName = !inName;
      } else if (character === ":" && !inName && (index + 1 === content.length || content[index + 1] === " ")) {
        key = content.slice(0, index);
        value = content.slice(index + 1);
        break;
      }
    }
  }
  const role = /^\S+/u.exec(key)?.[0] ?? "generic";
  let rest = key.slice(role.length).trim();
  let name = "";
  const quoted = /^"((?:[^"\\]|\\.)*)"/u.exec(rest);
  if (quoted !== null) {
    name = unquote(quoted[0]);
    rest = rest.slice(quoted[0].length);
  }
  const attributes = [...rest.matchAll(/\[([^\]]+)\]/gu)].map((match) => match[1]!).filter((attribute) => !HIDDEN_ATTRIBUTES.test(attribute));
  return { role, name, attributes, text: unquote(value), url: "", children: [] };
}

/** Reads the YAML-like text `locator.ariaSnapshot()` returns. */
export function parseOutline(snapshot: string): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const open: Array<{ indent: number; node: OutlineNode }> = [];
  for (const line of snapshot.split("\n")) {
    const match = /^(\s*)- (.*)$/u.exec(line);
    if (match === null) continue;
    const indent = match[1]!.length;
    const content = match[2]!;
    while (open.length > 0 && open.at(-1)!.indent >= indent) open.pop();
    const parent = open.at(-1)?.node;
    if (content.startsWith("/")) {
      const property = /^\/(\w+):\s*(.*)$/u.exec(content);
      if (property?.[1] === "url" && parent !== undefined) parent.url = unquote(property[2]!);
      continue;
    }
    const node = parseItem(content);
    (parent?.children ?? roots).push(node);
    open.push({ indent, node });
  }
  return roots;
}

function allProse(node: OutlineNode): boolean {
  return PROSE.has(node.role) && node.url === "" && node.children.every(allProse);
}

function inlineText(node: OutlineNode): string {
  return [node.name || node.text, ...(node.name === "" ? node.children.map(inlineText) : [])].filter(Boolean).join(" ");
}

function simplify(node: OutlineNode): OutlineNode[] {
  let children = node.children.flatMap(simplify);
  let { name, text } = node;
  if (name !== "") {
    // The name already says what plain text inside would repeat.
    children = children.every(allProse) ? [] : children.filter((child) => child.role !== "text");
    if (node.role === "row" && children.length > 0) name = "";
  } else if (children.length > 0 && children.some((child) => child.role === "text")) {
    // Loose text around links reads better as one line. Other controls keep
    // their own lines, and text that only repeats a control's name is its label.
    if (text === "") {
      const inline = (child: OutlineNode) => allProse(child) || child.role === "link";
      text = children.filter(inline).map(inlineText).filter(Boolean).join(" ");
      if (children.some((child) => !inline(child) && child.name === text.trim())) text = "";
    }
    children = children.filter((child) => !allProse(child));
  }
  if (name === "" && text === "" && node.url === "" && node.attributes.length === 0) {
    if (WRAPPERS.has(node.role) || node.role === "paragraph") return children;
    if (node.role === "listitem" && children.length === 1) return children;
  }
  return [{ ...node, name, text, children }];
}

function clip(text: string, limit: number): string {
  const flat = text.replaceAll(/\s+/gu, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

function label(node: OutlineNode, origin: string): string {
  let line = node.role === "text" ? "text" : node.role;
  if (node.name !== "") line += ` ${JSON.stringify(clip(node.name, 90))}`;
  for (const attribute of node.attributes) line += ` [${attribute}]`;
  if (node.text !== "") line += `: ${clip(node.text, 110)}`;
  if (node.url !== "") {
    const address = origin !== "" && node.url.startsWith(origin) ? node.url.slice(origin.length) || "/" : node.url;
    line += ` → ${clip(address, 70)}`;
  }
  return line;
}

interface Row {
  depth: number;
  text: string;
}

function countRows(node: OutlineNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countRows(child), 0);
}

function render(nodes: readonly OutlineNode[], depth: number, origin: string, keep: number, rows: Row[]): void {
  let index = 0;
  while (index < nodes.length) {
    let end = index + 1;
    while (end < nodes.length && nodes[end]!.role === nodes[index]!.role) end++;
    const run = nodes.slice(index, end);
    const shown = run.length > keep + 1 ? run.slice(0, keep) : run;
    for (const node of shown) {
      rows.push({ depth, text: label(node, origin) });
      render(node.children, depth + 1, origin, keep, rows);
    }
    if (shown.length < run.length) {
      const rest = run.slice(shown.length);
      const names = rest.map((node) => node.name).filter(Boolean);
      let line = `… ${rest.length} more ${run[0]!.role}`;
      if (names.length > 0) {
        let list = "";
        let listed = 0;
        for (const name of names) {
          const next = `${list === "" ? "" : ", "}${JSON.stringify(clip(name, 30))}`;
          if (list.length + next.length > 90) break;
          list += next;
          listed++;
        }
        if (listed > 0) line += `: ${list}${listed < names.length ? ", …" : ""}`;
      }
      rows.push({ depth, text: line });
    }
    index = end;
  }
}

/** Shortens a parsed snapshot to at most `lines` lines. */
export function compactOutline(roots: readonly OutlineNode[], options: OutlineOptions = {}): Outline {
  const limit = options.lines ?? 80;
  const origin = options.origin ?? "";
  const nodes = roots.flatMap(simplify);
  const full = nodes.reduce((sum, node) => sum + countRows(node), 0);
  let rows: Row[] = [];
  // Fold long runs of alike siblings harder until it fits.
  for (const keep of [Infinity, 12, 6, 3, 2]) {
    rows = [];
    render(nodes, 0, origin, keep, rows);
    if (rows.length <= limit) break;
  }
  // Still too long: cut the deepest levels first.
  while (rows.length > limit) {
    const deepest = rows.reduce((depth, row) => Math.max(depth, row.depth), 0);
    if (deepest === 0) break;
    const trimmed: Row[] = [];
    let hidden = 0;
    const flush = () => {
      if (hidden > 0) trimmed.push({ depth: deepest, text: `… ${hidden} more line${hidden === 1 ? "" : "s"}` });
      hidden = 0;
    };
    for (const row of rows) {
      if (row.depth >= deepest) {
        hidden += row.text.startsWith("… ") ? Number(/^… (\d+)/u.exec(row.text)?.[1] ?? 1) : 1;
      } else {
        flush();
        trimmed.push(row);
      }
    }
    flush();
    if (trimmed.length >= rows.length) break;
    rows = trimmed;
  }
  if (rows.length > limit) {
    const cut = rows.length - limit + 1;
    rows = [...rows.slice(0, limit - 1), { depth: 0, text: `… ${cut} more lines` }];
  }
  return { lines: rows.map((row) => "  ".repeat(row.depth) + row.text), full };
}

/** Parses and shortens in one step. */
export function outlineOf(snapshot: string, options: OutlineOptions = {}): Outline {
  return compactOutline(parseOutline(snapshot), options);
}
