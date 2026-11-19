// Code blocks for the site: a labelled well with a few token colours, and no library. Each function takes a block's
// plain text and returns HTML.

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const span = (kind: string, text: string) => `<span class="${kind}">${escape(text)}</span>`;
const prompt = `<span class="p" aria-hidden="true">$ </span>`;

/**
 * A code block as a well. `file` names the file the block belongs in, when the sentence before it says so. Command
 * lines get a prompt that is not copied; output gets no copy key.
 */
export function well(lang: string, code: string, file?: string): string {
  const source = code.replace(/\n$/, "");
  let label: string;
  let body: string;
  let copy = true;
  if (/^(sh|bash|shell|zsh)$/.test(lang)) {
    label = "Terminal";
    body = shell(source);
  } else if (/^(ts|typescript|js|javascript)$/.test(lang)) {
    label = file ?? (lang.startsWith("t") ? "TypeScript" : "JavaScript");
    body = script(source);
  } else if (/^ya?ml$/.test(lang)) {
    label = file ?? "YAML";
    body = yaml(source);
  } else if (lang === "") {
    label = source.startsWith("$ ") ? "Terminal" : "Output";
    body = output(source);
    copy = false;
  } else {
    label = file ?? lang.toUpperCase();
    body = escape(source);
  }
  const key = copy
    ? `<button class="key-label" type="button" data-copy aria-label="Copy the ${label === "Terminal" ? "commands" : "code"}" hidden>Copy</button>`
    : "";
  // A file's name keeps its own letters; the other labels are the site's own words, set in capitals.
  const name = file ? `<span class="file">${escape(file)}</span>` : `<span class="label">${escape(label)}</span>`;
  const kind = /^(sh|bash|shell|zsh)$/.test(lang) ? "well terminal" : "well";
  return `<div class="${kind}"><div class="well-head">${name}${key}</div><pre><code>${body}</code></pre></div>`;
}

function shell(source: string): string {
  let continued = false;
  return source
    .split("\n")
    .map((line) => {
      const continuation = continued;
      continued = line.endsWith("\\");
      if (line.trim() === "") return "";
      if (/^\s*#/.test(line)) return span("c", line);
      return (continuation ? "" : prompt) + words(line);
    })
    .join("\n");
}

function words(line: string): string {
  let html = "";
  let command = true;
  for (const [, space, comment, quoted, operator, variable, word] of line.matchAll(
    /(\s+)|(#.*$)|("(?:[^"\\]|\\.)*"|'[^']*')|(&&|\|\||[|;])|(\$\w+|\$\{[^}]*\})|(\S+)/g,
  )) {
    if (space) html += space;
    else if (comment) html += span("c", comment);
    else if (operator) {
      html += span("u", operator);
      command = true;
    } else {
      if (quoted) html += span("s", quoted);
      else if (variable) html += span("n", variable);
      else if (word && !command && /^--?[A-Za-z]/.test(word)) html += span("k", word);
      else if (word) html += escape(word);
      command = false;
    }
  }
  return html;
}

const keywords = new Set(
  "as async await break case catch class const continue default else export extends false finally for from function if import in instanceof interface let new null of return switch throw true try type typeof undefined var void while".split(
    " ",
  ),
);

function script(source: string): string {
  let html = "";
  for (const [, comment, quoted, number, name, punctuation, other] of source.matchAll(
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.:=<>+\-*/?!&|%^~@]+)|([\s\S])/g,
  )) {
    if (comment) html += span("c", comment);
    else if (quoted) html += span("s", quoted);
    else if (number) html += span("n", number);
    else if (name) html += keywords.has(name) ? span("k", name) : escape(name);
    else if (punctuation) html += span("u", punctuation);
    else html += escape(other ?? "");
  }
  return html;
}

function yaml(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const [, indent = "", dash, key, rest = ""] = /^(\s*)(- )?(?:([\w.-]+):(?=\s|$))?(.*)$/.exec(line) ?? [];
      let html = indent;
      if (dash) html += `${span("u", "-")} `;
      if (key) html += `${span("k", key)}${span("u", ":")}`;
      const value = rest.trim();
      if (value.startsWith("#")) html += span("c", rest);
      else if (/^(["']).*\1$/.test(value)) html += span("s", rest);
      else if (/^-?\d+(\.\d+)?$/.test(value)) html += span("n", rest);
      else html += escape(rest);
      return html;
    })
    .join("\n");
}

function output(source: string): string {
  return source
    .split("\n")
    .map((line, n) => {
      if (n === 0 && line.startsWith("$ ")) return prompt + escape(line.slice(2));
      const mark = /^(\s*)(✗|✓)/.exec(line);
      if (!mark) return escape(line);
      return `${mark[1]}${span(mark[2] === "✗" ? "x" : "s", mark[2]!)}${escape(line.slice(mark[0].length))}`;
    })
    .join("\n");
}
