// Builds the site from README.md, docs/, the skill and package.json:
//
//   bun site/build.ts [out]      (out defaults to site/dist, and must be empty or missing)
//
// The copy lives in those files. This script places it (see pages.ts), turns code blocks into wells, and points each
// link at the page that holds its target. It stops on anything it cannot place.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { well } from "./highlight.ts";
import { documentation, groups, landing, skipped, type Page } from "./pages.ts";

declare const Bun: { markdown: { html(source: string, options?: { headings?: { ids?: boolean } }): string } };

const repo = join(import.meta.dirname, "..");
const out = process.argv[2] ?? join(repo, "site", "dist");

function fail(message: string): never {
  console.error(`site: ${message}`);
  process.exit(1);
}

if (existsSync(out) && readdirSync(out).length > 0) fail(`${out} is not empty; remove it first`);

const read = (path: string) => readFileSync(join(repo, path), "utf8");
const render = (markdown: string) => Bun.markdown.html(markdown, { headings: { ids: true } });

// ---- package.json: the address, the version and what the package needs

const pkg = JSON.parse(read("package.json")) as {
  version: string;
  homepage: string;
  engines: { node: string };
  repository: { url: string };
};
const site = pkg.homepage;
if (!/^https:\/\/[^/]+\/(?:[^/]+\/)*$/.test(site)) fail(`package.json's homepage should be the site's address, ending in a slash: ${site}`);
const base = new URL(site).pathname;
const github = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
const node =
  /^>=\s*(\d+(?:\.\d+)*)$/.exec(pkg.engines.node)?.[1] ?? fail(`package.json's engines.node should read ">=X.Y": ${pkg.engines.node}`);

// ---- Text

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (html: string) =>
  html.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, name: string) =>
    name.startsWith("#x") || name.startsWith("#X")
      ? String.fromCodePoint(parseInt(name.slice(2), 16))
      : name.startsWith("#")
        ? String.fromCodePoint(Number(name.slice(1)))
        : (entities[name.toLowerCase()] ?? whole),
  );
const plain = (html: string) => decode(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const firstSentence = (text: string) => /^(.+?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text;
/** A description taken from after a colon, as a sentence of its own. ra keeps its small letter. */
const capital = (text: string) => (/^ra\b/.test(text) ? text : text.charAt(0).toUpperCase() + text.slice(1));

const voids = new Set(["area", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "wbr"]);

/** The top-level blocks of rendered Markdown, each from its opening tag to the tag that closes it. */
function blocks(fragment: string): string[] {
  const list: string[] = [];
  const space = /\s*/y;
  const open = /<([a-z][a-z\d]*)\b[^>]*>/iy;
  let at = 0;
  for (;;) {
    space.lastIndex = at;
    space.exec(fragment);
    at = space.lastIndex;
    if (at >= fragment.length) return list;
    open.lastIndex = at;
    const start = open.exec(fragment) ?? fail(`text outside any block in rendered Markdown: ${fragment.slice(at, at + 60)}`);
    const tag = start[1]!.toLowerCase();
    let end = open.lastIndex;
    if (!voids.has(tag) && !start[0].endsWith("/>")) {
      const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
      tags.lastIndex = end;
      for (let depth = 1; depth > 0; ) {
        const next = tags.exec(fragment) ?? fail(`<${tag}> never closes in rendered Markdown`);
        depth += next[1] ? -1 : 1;
        end = next.index + next[0].length;
      }
    }
    list.push(fragment.slice(at, end));
    at = end;
  }
}

/** Each line of Markdown, with whether it is part of a fenced code block. */
function* lines(markdown: string): Generator<[line: string, code: boolean]> {
  let fence = "";
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!fence) {
      const opening = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
      if (opening) fence = opening;
      yield [line, Boolean(opening)];
    } else {
      if (trimmed.length >= fence.length && trimmed === fence.charAt(0).repeat(trimmed.length)) fence = "";
      yield [line, true];
    }
  }
}

/** Markdown with each heading one level higher, for a README section that becomes a page of its own. */
const promote = (markdown: string) =>
  [...lines(markdown)].map(([line, code]) => (code ? line : line.replace(/^#(#+ )/, "$1"))).join("\n");

// ---- The README

const readme = read("README.md");
const rendered = render(readme);
const marks = [...rendered.matchAll(/^<h2 id="([^"]+)">(.*)<\/h2>$/gm)];
if (marks.length === 0) fail("the README has no ## sections");

const split = { top: [] as string[], sections: [] as { title: string; lines: string[] }[] };
for (const [line, code] of lines(readme)) {
  const heading = code ? null : /^## (.+?)\s*$/.exec(line);
  if (heading) split.sections.push({ title: heading[1]!.replace(/[`*_]/g, ""), lines: [] });
  else (split.sections.at(-1)?.lines ?? split.top).push(line);
}
if (split.sections.length !== marks.length) fail(`the README has ${split.sections.length} ## headings, but ${marks.length} rendered`);

interface Section {
  id: string;
  title: string;
  html: string;
  markdown: string;
}
const sections = new Map<string, Section>();
for (const [n, mark] of marks.entries()) {
  const id = mark[1]!;
  const title = plain(mark[2]!);
  const source = split.sections[n]!;
  if (source.title !== title) fail(`the README's heading “${source.title}” rendered as “${title}”`);
  const end = marks[n + 1]?.index ?? rendered.length;
  sections.set(id, { id, title, html: rendered.slice(mark.index + mark[0].length, end).trim(), markdown: source.lines.join("\n").trim() });
}

// The README's first screen: a bold tagline under the title, a definition, and a picture.
const top = blocks(rendered.slice(0, marks[0]!.index));
const tagline =
  top.map((block) => /^<p><strong>([^<]+)<\/strong><\/p>$/.exec(block)?.[1]).find((text) => text !== undefined) ??
  fail("the README needs its tagline: a line in bold under the title");
const definition = top.find((block) => /^<p>(?!<strong>|<a )/.test(block)) ?? fail("the README needs its definition: a paragraph under the badges");
const flow = top.find((block) => block.startsWith("<picture>")) ?? fail("the README needs a picture under its definition");
const topMarkdown = split.top.join("\n").split(/\n\s*\n/).map((paragraph) => paragraph.trim());
const definitionMarkdown = topMarkdown.find((paragraph) => /^[^#*[<!\s]/.test(paragraph)) ?? fail("the README's definition is missing");
const flowMarkdown = topMarkdown.find((paragraph) => paragraph.startsWith("<picture>")) ?? fail("the README's first picture is missing");
const summary = plain(definition);

// The site draws that picture from its HTML source, so that it reflows on a phone. The README's PNGs are rendered from the
// same file (`bun run figures`), and the README's alt text stays the figure's description.
const figureSource = "site/figures/flow.html";
const flowImage = /<img\b[^>]*\ssrc="([^"]+)"/.exec(flow)?.[1];
if (flowImage !== ".github/media/ra-flow.png") fail(`the README's first picture is ${flowImage}, but ${figureSource} draws .github/media/ra-flow.png`);
const flowAlt = decode(/\salt="([^"]*)"/.exec(flow)?.[1] ?? fail("the README's first picture needs its alt text"));
const flowMarkup =
  /<!-- figure -->\n([\s\S]*?)\n<!-- \/figure -->/.exec(readFileSync(join(repo, figureSource), "utf8"))?.[1] ??
  fail(`${figureSource} needs its figure between <!-- figure --> and <!-- /figure -->`);
const diagram = `<figure class="diagram" role="img" aria-label="${escape(flowAlt)}">\n${flowMarkup}\n</figure>`;

const placed = groups.flatMap((group) => group.pages.flatMap((page) => ("readme" in page ? [page.readme] : [])));
for (const id of sections.keys()) {
  if (!placed.includes(id) && !skipped.includes(id)) fail(`the README's section #${id} is neither a page nor skipped in site/pages.ts`);
}
for (const id of [...placed, ...skipped, ...landing.map((row) => row.readme), documentation]) {
  if (!sections.has(id)) fail(`site/pages.ts names #${id}, which is not a section of the README`);
}

// The README's documentation list names each file the site makes a page of, and says what it holds.
const listed = new Map<string, { title: string; description: string }>();
for (const [, link, title, description] of sections.get(documentation)!.html.matchAll(/<li><a href="([^"]+)">([\s\S]*?)<\/a>:\s*([\s\S]*?)<\/li>/g)) {
  listed.set(decode(link!), { title: plain(title!), description: capital(plain(description!)) });
}

// ---- Pages

interface Built {
  slug: string;
  title: string;
  description: string;
  /** The repository file the copy comes from. */
  source: string;
  /** The README heading the page starts at, if it comes from the README. */
  anchor: string;
  /** Rendered Markdown, with links as written. */
  body: string;
  /** The page as Markdown, with links as written and without its title. */
  markdown: string;
  ids: Set<string>;
  toc: { id: string; title: string }[];
}

const idsIn = (html: string) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => decode(match[1]!)));
const headings = (html: string, level: number) =>
  [...html.matchAll(new RegExp(`<h${level} id="([^"]+)">(.*?)</h${level}>`, "g"))].map((match) => ({ id: decode(match[1]!), title: plain(match[2]!) }));

function fromReadme(page: Extract<Page, { readme: string }>): Built {
  const section = sections.get(page.readme)!;
  const first = blocks(section.html)[0] ?? "";
  // A summary stands alone, so a link in brackets that points elsewhere in the README is left out of it.
  const opening = first.startsWith("<p>") ? firstSentence(plain(first.replace(/\s*\(<a href="#[^"]*">[^<]*<\/a>\)/g, ""))) : "";
  let body = section.html;
  let markdown = promote(section.markdown);
  if (page.opens === "definition") {
    body = `${definition.replace(/^<p>/, '<p class="lead">')}\n${body}`;
    markdown = `${definitionMarkdown}\n\n${markdown}`;
  } else if (page.opens === "picture") {
    body = `${diagram}\n${body}`;
    markdown = `${flowMarkdown}\n\n${markdown}`;
  }
  return {
    slug: page.slug,
    title: section.title,
    description: page.opens === "definition" || opening.length < 40 ? summary : opening,
    source: "README.md",
    anchor: section.id,
    body,
    markdown,
    ids: new Set([...idsIn(body), section.id]),
    toc: headings(body, 3),
  };
}

function fromFile(page: Extract<Page, { file: string }>): Built {
  const known = listed.get(page.file) ?? fail(`the README's documentation list does not name ${page.file}`);
  const source = read(page.file).replace(/^---\n[\s\S]*?\n---\n+/, "");
  const html = render(source);
  const body = html.replace(/^<h1 id="[^"]*">.*<\/h1>\n?/m, "");
  return {
    slug: page.slug,
    title: known.title,
    description: known.description,
    source: page.file,
    anchor: "",
    body,
    markdown: source.replace(/^# .*\n+/m, "").trim(),
    ids: idsIn(body),
    toc: headings(body, 2),
  };
}

const tree = groups.map((group) => ({ label: group.label, pages: group.pages.map((page) => ("readme" in page ? fromReadme(page) : fromFile(page))) }));
const pages = tree.flatMap((group) => group.pages);
const bySource = new Map(pages.filter((page) => !page.anchor).map((page) => [page.source, page]));
const readmeAnchors = new Map<string, Built>();
for (const page of pages) if (page.anchor) for (const id of page.ids) readmeAnchors.set(id, page);
const markdownName = (page: Built) => `${page.slug || page.anchor || "index"}.md`;

// ---- Links

interface Context {
  /** The repository file the copy comes from. */
  from: string;
  /** The way from the file being written to the site's root. */
  root: string;
  /** The page being written. */
  page?: Built;
  /** Anchors the page being written holds itself, which README links use before any other page. */
  local?: Set<string>;
}

const media = new Set<string>([".github/media/social-preview.png"]);

function pageLink(page: Built, hash: string, context: Context): string {
  const fragment = hash && hash !== page.anchor ? `#${encodeURIComponent(hash)}` : "";
  if (context.page === page) return fragment || "./";
  return `${context.root}docs/${page.slug ? `${page.slug}/` : ""}${fragment}`;
}

/** Where a link in the copy should lead from the file being written. */
function target(url: string, context: Context): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith("//")) return url;
  const at = url.indexOf("#");
  const path = at < 0 ? url : url.slice(0, at);
  const hash = at < 0 ? "" : decodeURIComponent(url.slice(at + 1));
  const file = path ? posix.normalize(posix.join(posix.dirname(context.from), decodeURIComponent(path))) : context.from;
  if (file === "README.md") {
    if (!hash) return context.root || "./";
    if (context.local?.has(hash)) return `#${encodeURIComponent(hash)}`;
    return pageLink(readmeAnchors.get(hash) ?? fail(`${context.from} links to the README's #${hash}, which no page holds`), hash, context);
  }
  const page = bySource.get(file);
  if (page) {
    if (hash && !page.ids.has(hash)) fail(`${context.from} links to ${url}, but ${file} has no #${hash}`);
    return pageLink(page, hash, context);
  }
  if (file.startsWith(".github/media/")) {
    if (!existsSync(join(repo, file))) fail(`${context.from} shows ${url}, which is not in the repository`);
    media.add(file);
    return `${context.root}media/${posix.basename(file)}`;
  }
  if (!existsSync(join(repo, file))) fail(`${context.from} links to ${url}, which is not in the repository`);
  const kind = statSync(join(repo, file)).isDirectory() ? "tree" : "blob";
  return `${github}/${kind}/main/${file}${hash ? `#${hash}` : ""}`;
}

function attribute(name: string, value: string, context: Context): string {
  if (name !== "srcset") return target(value, context);
  return value
    .split(",")
    .map((candidate) => {
      const [url = "", ...descriptors] = candidate.trim().split(/\s+/);
      return [target(url, context), ...descriptors].join(" ");
    })
    .join(", ");
}

const relink = (html: string, context: Context) =>
  html.replace(/\s(href|src|srcset)="([^"]*)"/g, (_, name: string, value: string) => ` ${name}="${escape(attribute(name, decode(value), context))}"`);

/** Markdown with every link made a full address, for the Markdown copies of each page. */
function absolute(markdown: string, from: string): string {
  const context: Context = { from, root: site };
  return [...lines(markdown)]
    .map(([line, code]) =>
      code
        ? line
        : line
            .split(/(`[^`]*`)/)
            .map((part, n) =>
              n % 2
                ? part
                : part
                    .replace(/\]\(([^)\s]+)\)/g, (_, url: string) => `](${target(url, context)})`)
                    .replace(/\s(href|src|srcset)="([^"]*)"/g, (_, name: string, value: string) => ` ${name}="${attribute(name, value, context)}"`),
            )
            .join(""),
    )
    .join("\n");
}

// ---- Blocks the site draws its own way

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(join(repo, file));
  if (bytes.toString("latin1", 1, 4) !== "PNG") fail(`${file} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Pictures get their height, so that nothing moves while they load. */
function pictures(html: string, from: string): string {
  return html.replace(/<picture>([\s\S]*?)<\/picture>/g, (_, inner: string) => {
    const img = /<img\b([^>]*?)\s*\/?>/.exec(inner) ?? fail(`a <picture> in ${from} has no <img>`);
    const attributes = img[1]!;
    const src = /\ssrc="([^"]+)"/.exec(attributes)?.[1] ?? fail(`an <img> in ${from} has no src`);
    const size = pngSize(posix.normalize(posix.join(posix.dirname(from), decode(src))));
    const width = Number(/\swidth="(\d+)"/.exec(attributes)?.[1] ?? size.width / 2);
    const height = Math.round((size.height * width) / size.width);
    const rest = attributes.replace(/\s(?:width|height)="\d+"/g, "");
    return `<figure class="shot"><picture>${inner.replace(img[0], `<img${rest} width="${width}" height="${height}" loading="lazy" decoding="async">`)}</picture></figure>`;
  });
}

/** Tables scroll inside their own box, and a table of three or more columns stacks its rows on a phone. */
function tables(html: string): string {
  return html.replace(/<table>([\s\S]*?)<\/table>/g, (_, inner: string) => {
    const heads = [...(/<thead>([\s\S]*?)<\/thead>/.exec(inner)?.[1] ?? "").matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((match) =>
      plain(match[1]!),
    );
    const ra = heads.indexOf("ra");
    const stack = heads.length >= 3;
    let column = 0;
    const marked = inner
      .replace(/<th\b([^>]*)>/g, (whole, rest: string) => (column++ === ra ? `<th${rest} class="ra">` : whole))
      .replace(/<tr>([\s\S]*?)<\/tr>/g, (row: string, cells: string) => {
        if (!cells.includes("<td")) return row;
        let n = 0;
        return `<tr>${cells.replace(/<td\b([^>]*)>/g, (_cell, rest: string) => {
          const i = n++;
          const label = stack && i > 0 && heads[i] ? ` data-label="${escape(heads[i]!)}"` : "";
          return `<td${rest}${i === ra ? ' class="ra"' : ""}${label}>`;
        })}</tr>`;
      });
    return `<div class="table"><table${stack ? ' class="stack"' : ""}>${marked}</table></div>`;
  });
}

const extensions: Record<string, RegExp> = {
  ts: /\.[cm]?tsx?$/,
  typescript: /\.[cm]?tsx?$/,
  js: /\.[cm]?jsx?$/,
  javascript: /\.[cm]?jsx?$/,
  yaml: /\.ya?ml$/,
  yml: /\.ya?ml$/,
};

/** Code blocks become wells. A block is labelled with its file when the sentence before it names one. */
function wells(html: string): string {
  return html.replace(
    /<pre><code(?: class="language-([\w-]+)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_, lang: string | undefined, code: string, offset: number) => {
      const before = html.slice(0, offset).trimEnd();
      const pattern = lang ? extensions[lang] : undefined;
      let file: string | undefined;
      if (pattern && before.endsWith(":</p>")) {
        const intro = before.slice(before.lastIndexOf("<p>"));
        file = [...intro.matchAll(/<code>([^<]+)<\/code>/g)].map((match) => decode(match[1]!)).filter((name) => pattern.test(name)).at(-1);
      }
      return well(lang ?? "", decode(code), file);
    },
  );
}

/** Inline code without a space in it, such as a flag or a file name, stays on one line. */
const unbroken = (html: string) => html.replace(/(?<!<pre>)<code>([^<\s]{1,32})<\/code>/g, '<code class="word">$1</code>');

const draw = (html: string, from: string, context: Context) => relink(unbroken(wells(tables(pictures(grouped(led(html)), from)))), context);

// ---- The landing page's own shapes

/** The opening paragraphs, then each `###` heading with its first paragraph and the list or table it introduces. */
function intro(html: string): string {
  const list = blocks(html);
  const kept: string[] = [];
  let i = 0;
  while (i < list.length && !list[i]!.startsWith("<h3")) kept.push(list[i++]!);
  while (i < list.length) {
    kept.push(list[i++]!);
    const paragraph = list[i];
    if (paragraph?.startsWith("<p>")) {
      kept.push(paragraph);
      i++;
      const next = list[i];
      if (plain(paragraph).endsWith(":") && next && !next.startsWith("<h3")) kept.push(next);
    }
    while (i < list.length && !list[i]!.startsWith("<h3")) i++;
  }
  return kept.join("\n");
}

/** The opening paragraphs, then each list under a bold title as a column of its items' bold leads. */
function leads(html: string): string {
  const list = blocks(html);
  const kept: string[] = [];
  const columns: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const block = list[i]!;
    const title = /^<p><strong>([^<]+?):?<\/strong><\/p>$/.exec(block)?.[1];
    const next = list[i + 1];
    if (title && next?.startsWith("<ul>")) {
      const items = [...next.matchAll(/<li><strong>([\s\S]*?)<\/strong>/g)].map((match) => `<li>${match[1]}</li>`);
      columns.push(`<div><p class="title">${title}</p><ul>${items.join("")}</ul></div>`);
      i++;
    } else if (columns.length === 0 && block.startsWith("<p>")) kept.push(block);
  }
  return `${kept.join("\n")}\n<div class="columns">${columns.join("")}</div>`;
}

/** A paragraph that opens with a sentence in bold gets a class, so that the sentence can stand as its title. */
const led = (html: string) => html.replace(/<p><strong>([^<]*[.?!”])<\/strong> /g, '<p class="led"><strong>$1</strong> ');

/** A list of bold group names, each over a list of its own, becomes a grid of groups. */
const grouped = (html: string) =>
  blocks(html)
    .map((block) =>
      /^<ul>\s*<li><strong>[^<]+:<\/strong>\s*<ul>/.test(block)
        ? block.replace(/^<ul>/, '<ul class="groups">').replace(/<li><strong>([^<]+):<\/strong>/g, '<li><strong class="title">$1</strong>')
        : block,
    )
    .join("\n");

// ---- Pages around the copy

const stamp = createHash("sha256").update(read("site/style.css")).update(read("site/site.js")).digest("hex").slice(0, 10);

function header(root: string, docs: boolean): string {
  return `<header class="top"><div class="bar">
<a class="mark" href="${root || "./"}">ra</a>
<nav class="links" aria-label="Site">
<a class="key-label" href="${root}docs/"${docs ? ' aria-current="true"' : ""}>Docs</a>
<a class="key-label" href="${github}">GitHub</a>
</nav>
</div></header>`;
}

function footer(root: string): string {
  return `<footer class="foot"><div class="bar">
<nav aria-label="More">
<a href="${root}docs/">Docs</a>
<a href="${github}">GitHub</a>
<a href="${github}/releases">Releases</a>
<a href="${github}/blob/main/LICENSE">MIT licence</a>
<a href="${root}llms.txt">llms.txt</a>
</nav>
<a class="wordmark" href="https://hraness.com">Hraness</a>
</div></footer>`;
}

function document(options: { path: string; title: string; description: string; root: string; body: string; docs: boolean; markdown?: string }): string {
  const { root } = options;
  const canonical = options.path === "404.html" ? "" : `\n<link rel="canonical" href="${site}${options.path.replace(/index\.html$/, "")}">`;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(options.title)}</title>
<meta name="description" content="${escape(options.description)}">${canonical}
<meta property="og:type" content="website">
<meta property="og:site_name" content="ra">
<meta property="og:title" content="${escape(options.title)}">
<meta property="og:description" content="${escape(options.description)}">
<meta property="og:image" content="${site}media/social-preview.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f4f4f1">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0f0f0f">
<link rel="icon" href="${root}favicon.svg" type="image/svg+xml">
<link rel="preload" href="${root}fonts/funnel-display/FunnelDisplay.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${root}style.css?v=${stamp}">${options.markdown ? `\n<link rel="alternate" type="text/markdown" href="${options.markdown}">` : ""}
<script src="${root}site.js?v=${stamp}" defer></script>
</head>
<body class="${options.docs ? "docs-site" : "home-site"}">
<a class="skip" href="#main">Skip to the content</a>
${header(root, options.docs)}
${options.body}
${footer(root)}
</body>
</html>
`;
}

function write(path: string, content: string | Buffer): void {
  const file = join(out, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// ---- The landing page

const rows = landing.map(({ readme: id, show }) => {
  const section = sections.get(id)!;
  const content = show === "intro" ? intro(section.html) : show === "leads" ? leads(section.html) : section.html;
  return { section, show, content };
});
const local = new Set(rows.flatMap(({ section, content }) => [section.id, ...idsIn(content)]));
const home: Context = { from: "README.md", root: "", local };
const version = `v${pkg.version}`;
write(
  "index.html",
  document({
    path: "index.html",
    title: `ra · ${tagline}`,
    description: summary,
    root: "",
    docs: false,
    body: `<main id="main" class="home">
<div class="wrap">
<section class="hero">
<h1>${tagline}</h1>
${definition.replace(/^<p>/, '<p class="lead">')}
<p class="actions"><a class="key" href="docs/">Read the docs</a><a class="key-label" href="${github}">GitHub</a></p>
<p class="meta"><a href="${github}/releases/tag/${version}">Version ${pkg.version}</a> · MIT licence · Node ${node} or later</p>
${diagram}
</section>
${rows
  .map(({ section, show, content }) => {
    const page = pages.find((candidate) => candidate.anchor === section.id);
    const more = show !== "whole" && page ? `\n<p class="more"><a href="${pageLink(page, "", home)}">${escape(section.title)} in full</a></p>` : "";
    return `<section class="row" aria-labelledby="${section.id}">
<h2 id="${section.id}">${escape(section.title)}</h2>
<div class="body prose">
${draw(content, "README.md", home)}${more}
</div>
</section>`;
  })
  .join("\n")}
</div>
</main>`,
  }),
);

// ---- The docs

function sidebar(current: Built, root: string): string {
  return tree
    .map(
      (group) =>
        `<div class="group"><p class="label">${escape(group.label)}</p><ul>${group.pages
          .map((page) =>
            page === current
              ? `<li><a href="./" aria-current="page">${escape(page.title)}</a></li>`
              : `<li><a href="${root}docs/${page.slug ? `${page.slug}/` : ""}">${escape(page.title)}</a></li>`,
          )
          .join("")}</ul></div>`,
    )
    .join("\n");
}

for (const [n, page] of pages.entries()) {
  const root = page.slug ? "../../" : "../";
  const context: Context = { from: page.source, root, page };
  const markdown = page.slug ? `../${markdownName(page)}` : markdownName(page);
  const neighbour = (other: Built | undefined, rel: string, label: string) =>
    other
      ? `<a rel="${rel}" href="${root}docs/${other.slug ? `${other.slug}/` : ""}"><span class="label">${label}</span>${escape(other.title)}</a>`
      : "<span></span>";
  const toc =
    page.toc.length >= 2
      ? `<aside class="toc" aria-label="On this page"><p class="label">On this page</p><ul>${page.toc
          .map((entry) => `<li><a href="#${encodeURIComponent(entry.id)}">${escape(entry.title)}</a></li>`)
          .join("")}</ul></aside>`
      : "";
  write(
    `docs/${page.slug ? `${page.slug}/` : ""}index.html`,
    document({
      path: `docs/${page.slug ? `${page.slug}/` : ""}index.html`,
      title: `${page.title} · ra`,
      description: page.description,
      root,
      docs: true,
      markdown,
      body: `<div class="docs">
<nav class="side" aria-label="Docs">${sidebar(page, root)}</nav>
<main id="main" class="doc">
<details class="pages"><summary class="key-label">All pages</summary><nav aria-label="Docs">${sidebar(page, root)}</nav></details>
<h1>${escape(page.title)}</h1>
<div class="page-actions">
<button class="key-label" type="button" data-copy-page="${markdown}" hidden>Copy page</button>
<a class="key-label" href="${markdown}">View Markdown</a>
<details class="agents"><summary class="key-label">For agents</summary><p>This page is also <a href="${markdown}">Markdown</a>. <a href="${root}llms.txt">llms.txt</a> lists every page, and <a href="${root}llms-full.txt">llms-full.txt</a> holds them all in one file. <a href="${root}docs/skill/">The skill</a> teaches a coding agent to run ra by itself.</p></details>
</div>
<div class="prose">
${draw(page.body, page.source, context)}
</div>
<nav class="pager" aria-label="Previous and next">${neighbour(pages[n - 1], "prev", "Previous")}${neighbour(pages[n + 1], "next", "Next")}</nav>
</main>
${toc}
</div>`,
    }),
  );
  write(`docs/${markdownName(page)}`, `# ${page.title}\n\n${absolute(page.markdown, page.source)}\n`);
}

// ---- For agents: an index of the Markdown pages, and all of them in one file

const llms = [
  "# ra",
  "",
  `> ${summary}`,
  "",
  `${tagline} Each page below is Markdown, and [llms-full.txt](${site}llms-full.txt) holds them all in one file.`,
  ...tree.flatMap((group) => [
    "",
    `## ${group.label}`,
    "",
    ...group.pages.map(
      (page) => `- [${page.title}](${site}docs/${markdownName(page)})${page.description === summary ? "" : `: ${page.description}`}`,
    ),
  ]),
  "",
].join("\n");
write("llms.txt", llms);
write(
  "llms-full.txt",
  [`# ra\n\n> ${summary}\n\n${tagline}`, ...pages.map((page) => `# ${page.title}\n\n${absolute(page.markdown, page.source)}`)].join("\n\n") + "\n",
);

// ---- A page for addresses that hold nothing, served from any depth

write(
  "404.html",
  document({
    path: "404.html",
    title: "Not found · ra",
    description: summary,
    root: base,
    docs: false,
    body: `<main id="main" class="home">
<div class="wrap">
<section class="hero">
<h1>Nothing is here.</h1>
<p class="lead">This address holds no page. <a href="${base}">The home page</a> and <a href="${base}docs/">the docs</a> have everything there is.</p>
</section>
</div>
</main>`,
  }),
);

// ---- Files served as they are

for (const file of ["style.css", "site.js", "favicon.svg"]) copyFileSync(join(repo, "site", file), (mkdirSync(out, { recursive: true }), join(out, file)));
for (const file of readdirSync(join(repo, "site", "fonts", "funnel-display"))) {
  mkdirSync(join(out, "fonts", "funnel-display"), { recursive: true });
  copyFileSync(join(repo, "site", "fonts", "funnel-display", file), join(out, "fonts", "funnel-display", file));
}
mkdirSync(join(out, "media"), { recursive: true });
for (const file of media) copyFileSync(join(repo, file), join(out, "media", posix.basename(file)));

console.log(`site: ${pages.length + 2} pages in ${out}`);
