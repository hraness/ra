/**
 * The website, built from the README, docs/ and the skill into a temporary folder, then read the way a visitor's browser
 * and an agent would read it. The build itself stops on a README section that site/pages.ts does not place.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

const repo = fileURLToPath(new URL("..", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "ra-site-"));
after(() => rmSync(out, { recursive: true, force: true }));

// The build reads Markdown with Bun, so Bun runs it; the checks here run in Node like the other tests.
const build = spawnSync("bun", ["site/build.ts", out], { cwd: repo, encoding: "utf8" });
if (build.error) throw new Error(`could not start bun to build the site: ${build.error.message}`);
if (build.status !== 0) throw new Error(`the site did not build:\n${build.stdout}${build.stderr}`);

const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { homepage: string; description: string };
const site = new URL(pkg.homepage);
const read = (file: string) => readFileSync(file, "utf8");
const name = (file: string) => relative(out, file).split(sep).join("/");
const files = readdirSync(out, { recursive: true, encoding: "utf8" })
  .map((file) => join(out, file))
  .filter((file) => statSync(file).isFile());
const pages = new Map(files.filter((file) => file.endsWith(".html")).map((file) => [file, read(file)]));

const decode = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
/** A page's text: its tags removed until none is left, then its entities decoded. */
function plain(html: string): string {
  let before: string;
  do {
    before = html;
    html = html.replace(/<[^>]+>/g, "");
  } while (html !== before);
  return decode(html).replace(/\s+/g, " ").trim();
}
const ids = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => decode(match[1]!));

/** Every address a page points at: links, pictures and their sources, and the site's own addresses in its meta tags. */
function addresses(html: string): string[] {
  const found: string[] = [];
  for (const [, attribute, value] of html.matchAll(/\s(href|src|srcset|content)="([^"]*)"/g)) {
    const text = decode(value!);
    if (attribute === "srcset") found.push(...text.split(",").map((candidate) => candidate.trim().split(/\s+/)[0]!));
    else if (attribute !== "content" || text.startsWith(site.href)) found.push(text);
  }
  return found;
}

/** The file an address on the site serves, with its fragment, or nothing for an address elsewhere. */
function served(from: string, address: string): { file: string; hash: string } | undefined {
  const url = new URL(address, new URL(name(from), site));
  if (url.origin !== site.origin || !url.pathname.startsWith(site.pathname)) return undefined;
  let path = decodeURIComponent(url.pathname.slice(site.pathname.length));
  if (path === "" || path.endsWith("/")) path += "index.html";
  return { file: join(out, path), hash: decodeURIComponent(url.hash.slice(1)) };
}

/** The README's top: its tagline in bold and its definition, the first plain paragraph. */
function readmeTop(): { tagline: string; definition: string } {
  const readme = read(join(repo, "README.md"));
  const top = readme.slice(0, readme.indexOf("\n## ")).split(/\n\s*\n/).map((paragraph) => paragraph.trim());
  const tagline = top.map((paragraph) => /^\*\*([^*]+)\*\*$/.exec(paragraph)?.[1]).find((text) => text !== undefined);
  const definition = top.find((paragraph) => /^[^#*[<!\s]/.test(paragraph));
  assert.ok(tagline && definition, "the README should open with a tagline in bold and a definition");
  const markdown = (text: string) => text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*`]/g, "").replace(/\s+/g, " ");
  return { tagline: markdown(tagline), definition: markdown(definition) };
}

describe("site", () => {
  test("every link and picture reaches a file, and every fragment an id on the page it names", () => {
    const broken: string[] = [];
    let checked = 0;
    for (const [file, html] of pages) {
      for (const address of addresses(html)) {
        const target = served(file, address);
        if (!target) continue;
        checked++;
        if (!existsSync(target.file)) broken.push(`${name(file)}: ${address}`);
        else if (target.hash && target.file.endsWith(".html") && !ids(pages.get(target.file) ?? "").includes(target.hash)) {
          broken.push(`${name(file)}: ${address} (no #${target.hash} there)`);
        }
      }
    }
    assert.deepEqual(broken, []);
    assert.ok(checked > 500, `only ${checked} addresses on the site were checked`);
  });

  test("each page has one h1 and uses each id once", () => {
    for (const [file, html] of pages) {
      assert.equal(html.match(/<h1\b/g)?.length, 1, `${name(file)} should have one h1`);
      const seen = ids(html);
      assert.deepEqual(
        seen.filter((id, n) => seen.indexOf(id) !== n),
        [],
        `${name(file)} uses these ids twice`,
      );
    }
  });

  test("the landing page opens with the README's tagline and definition, and package.json says the same", () => {
    const { tagline, definition } = readmeTop();
    const home = pages.get(join(out, "index.html"))!;
    assert.equal(plain(/<h1>([\s\S]*?)<\/h1>/.exec(home)![1]!), tagline);
    assert.equal(plain(/<p class="lead">([\s\S]*?)<\/p>/.exec(home)![1]!), definition);
    assert.equal(decode(/<meta name="description" content="([^"]*)">/.exec(home)![1]!), definition);
    assert.equal(pkg.description, definition);
  });

  test("the sitemap lists the canonical HTML pages, with their own search metadata", () => {
    const sitemap = read(join(out, "sitemap.xml"));
    const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => decode(match[1]!));
    const publicPages: string[] = [];
    const titles = new Set<string>();
    for (const [file, html] of pages) {
      if (name(file) === "404.html") {
        assert.match(html, /<meta name="robots" content="noindex">/);
        assert.doesNotMatch(html, /rel="canonical"/);
        continue;
      }
      const url = new URL(name(file).replace(/index\.html$/, ""), site).href;
      const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
      const title = /<title>([^<]+)<\/title>/.exec(html)?.[1];
      const description = /<meta name="description" content="([^"]+)"/.exec(html)?.[1];
      assert.equal(canonical, url);
      assert.ok(title && description && !titles.has(title), `${name(file)} needs a distinct title and a description`);
      titles.add(title);
      publicPages.push(url);
    }
    assert.deepEqual(listed.sort(), publicPages.sort());
  });

  test("llms.txt lists every docs page's Markdown copy, and the full text and the 404 page exist", () => {
    const llms = read(join(out, "llms.txt"));
    const listed = [...llms.matchAll(/\]\((https:[^)\s]+)\)/g)].map((match) => match[1]!);
    const docs = [...pages.keys()].filter((file) => name(file).startsWith("docs/"));
    assert.ok(docs.length > 10, "the docs pages should be built");
    for (const file of docs) {
      const copy = /<link rel="alternate" type="text\/markdown" href="([^"]+)">/.exec(pages.get(file)!)?.[1];
      assert.ok(copy, `${name(file)} should point at its Markdown copy`);
      const address = new URL(copy, new URL(name(file), site)).href;
      assert.ok(listed.includes(address), `llms.txt should list ${address}`);
      assert.ok(existsSync(served(file, copy)!.file), `${address} should be built`);
    }
    for (const file of ["llms-full.txt", "404.html"]) assert.ok(existsSync(join(out, file)), `${file} should be built`);
  });

  test("text set in capitals never holds the name ra, which is always written in lower case", () => {
    const capitals = /<(\w+)\b[^>]*\sclass="(?:[^"]*\s)?(?:label|key-label|key|flow-kicker)(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/\1>/g;
    let checked = 0;
    for (const [file, html] of pages) {
      for (const [, , inner] of html.matchAll(capitals)) {
        checked++;
        assert.doesNotMatch(plain(inner!), /\bra\b/i, `${name(file)}: “${plain(inner!)}” would show in capitals`);
      }
    }
    assert.ok(checked > 100, `only ${checked} pieces of text in capitals were checked`);
  });
});
