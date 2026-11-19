// The copy keys, and the current heading in a docs page's contents. Every page works without this file.

for (const key of document.querySelectorAll("[data-copy], [data-copy-page]")) key.hidden = false;

/** Says on the key what happened, then puts its own words back. */
function report(key, words) {
  const label = key.getAttribute("aria-label");
  const text = key.textContent;
  key.textContent = words;
  if (label) key.setAttribute("aria-label", words);
  setTimeout(() => {
    key.textContent = text;
    if (label) key.setAttribute("aria-label", label);
  }, 1500);
}

async function copyWell(key) {
  const code = key.closest(".well").querySelector("code").cloneNode(true);
  for (const prompt of code.querySelectorAll(".p")) prompt.remove();
  await navigator.clipboard.writeText(code.textContent);
}

async function copyPage(key) {
  const text = fetch(key.dataset.copyPage).then((response) => {
    if (!response.ok) throw new Error(`${response.status}`);
    return response.text();
  });
  // Safari copies only inside the click itself, so the clipboard gets a promise of the text, not the text.
  if (typeof ClipboardItem === "function") {
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((page) => new Blob([page], { type: "text/plain" })) })]);
  } else {
    await navigator.clipboard.writeText(await text);
  }
}

document.addEventListener("click", async (event) => {
  const key = event.target instanceof Element ? event.target.closest("[data-copy], [data-copy-page]") : null;
  if (!key) return;
  try {
    await (key.hasAttribute("data-copy") ? copyWell(key) : copyPage(key));
    report(key, "Copied");
  } catch {
    report(key, "Not copied");
  }
});

const entries = [...document.querySelectorAll(".toc a")];
const headings = entries.map((entry) => document.getElementById(decodeURIComponent(entry.hash.slice(1))));
if (entries.length > 0) {
  const mark = () => {
    const line = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) + 1 || 1;
    let current = 0;
    headings.forEach((heading, n) => {
      if (heading && heading.getBoundingClientRect().top <= line) current = n;
    });
    entries.forEach((entry, n) => (n === current ? entry.setAttribute("aria-current", "true") : entry.removeAttribute("aria-current")));
  };
  addEventListener("scroll", mark, { passive: true });
  mark();
}
