/**
 * The checks that run inside the page.
 *
 * `inspectPage` is sent to the browser as source text, so it must stand
 * alone: no imports, no names from this module. It only reads the page, with
 * one exception: it may scroll through it once and return to the top.
 *
 * Every check prefers silence to a guess. A finding should be something a
 * person looking at the screen would agree is wrong.
 */
import type { TextSample } from "./contrast.ts";

export interface InspectOptions {
  /** A selector; only problems inside its first match are reported. */
  scope: string | null;
  /** Whether this view is used by touch, which turns on the tap target check. */
  touch: boolean;
  /** The smallest acceptable tap target, in pixels. */
  tapTarget: number;
  /** Whether the page may be scrolled through to load and test what is below the first screen. */
  scroll: boolean;
  /**
   * Whether the page's scripts run. Defaults to true. With scripts off, the
   * page calls back nothing, not even ra's own timers and animation frames,
   * so ra must never wait on it.
   */
  scripts?: boolean;
}

export interface PageFinding {
  kind: string;
  message: string;
  /** A short description of the element, when there is one. */
  where: string;
  /** A CSS selector for the element, when there is one. */
  selector: string;
}

/** A notable element and where it sits on the page. */
export interface Box {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One line of the layout sketch. */
export interface Region {
  depth: number;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  note: string;
}

export interface Inspection {
  title: string;
  page: { width: number; height: number };
  viewport: { width: number; height: number };
  scroll: { left: number; top: number };
  findings: PageFinding[];
  texts: TextSample[];
  boxes: Box[];
  regions: Region[];
  notes: string[];
}

export async function inspectPage(options: InspectOptions): Promise<Inspection> {
  const doc = document;
  const root = doc.documentElement;
  const body = doc.body;
  // The size the page is laid out at. Not innerWidth: on a touch view, a page
  // wider than the screen makes Chromium report its zoomed-out size there.
  const sizer = doc.compatMode === "BackCompat" && body ? body : root;
  const vw = sizer.clientWidth || window.innerWidth;
  const vh = sizer.clientHeight || window.innerHeight;
  const findings: PageFinding[] = [];
  const notes: string[] = [];
  if (!body) {
    return { title: doc.title, page: { width: vw, height: vh }, viewport: { width: vw, height: vh }, scroll: { left: window.scrollX, top: window.scrollY }, findings, texts: [], boxes: [], regions: [], notes };
  }

  // With scripts off, a timer or an animation frame never comes back. Layout is
  // still read on demand, so the checks run without waiting.
  const scripts = options.scripts !== false;
  const frame = () => (scripts ? new Promise<void>((resolve) => requestAnimationFrame(() => resolve())) : Promise.resolve());
  const pause = (ms: number) => (scripts ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
  const squash = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
  const cut = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text);
  const px = (value: number) => `${Math.round(value)}px`;

  const styles = new Map<Element, CSSStyleDeclaration>();
  const cs = (el: Element): CSSStyleDeclaration => {
    let style = styles.get(el);
    if (style === undefined) {
      style = getComputedStyle(el);
      styles.set(el, style);
    }
    return style;
  };
  const parentOf = (el: Element): Element | null => {
    if (el.parentElement) return el.parentElement;
    const host = (el.getRootNode() as ShadowRoot).host;
    return host ?? null;
  };
  const within = (outer: Element, inner: Element | null): boolean => {
    for (let node = inner; node; node = parentOf(node)) if (node === outer) return true;
    return false;
  };

  // ---- describing elements -------------------------------------------------

  const UTILITY =
    /^(?:flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|static|container|group|peer|isolate|invisible|visible|truncate|underline|italic|uppercase|lowercase|capitalize|antialiased|transition|transform|grow|shrink|table|contents|prose|sr-only|not-sr-only)$|^-?(?:w|h|p[xytblrse]?|m[xytblrse]?|text|bg|border|rounded|shadow|font|leading|tracking|items|justify|gap|space|overflow|z|top|left|right|bottom|inset|min|max|opacity|duration|ease|delay|cursor|select|whitespace|break|col|row|order|object|aspect|ring|outline|fill|stroke|size|basis|place|self|content|float|clear|list|line|backdrop|blur|scale|rotate|translate|origin|animate|will|pointer|resize|scroll|snap|touch|appearance|accent|caret|decoration|indent|align|divide|from|via|to|flex|grid|inline|table|box|mix|grow|shrink|columns|auto|start|end)-/;
  const readableClass = (name: string): string | null => {
    if (/[^\w-]/.test(name)) return null;
    if (/^x[a-z0-9]{5,8}$/.test(name)) return null;
    if (/^(?:css|sc|jsx|svelte|astro|emotion|chakra|mui|tw)-/i.test(name) && /\d/.test(name)) return null;
    if (UTILITY.test(name)) return null;
    const nextModule = /^([A-Za-z][\w-]*?)__[\w-]{5,}$/.exec(name);
    if (nextModule) return nextModule[1]!;
    const viteModule = /^_([A-Za-z][\w-]*?)_[a-z0-9]{4,}_\d+$/.exec(name);
    if (viteModule) return viteModule[1]!;
    return name;
  };
  const typeName = (type: any): string => {
    if (typeof type === "function") return type.displayName || type.name || "";
    if (type && typeof type === "object") {
      return type.displayName || type.render?.displayName || type.render?.name || type.type?.displayName || type.type?.name || "";
    }
    return "";
  };
  const sourceOf = (el: Element): string => {
    const astro = el.closest("[data-astro-source-file]");
    if (astro) {
      const file = astro.getAttribute("data-astro-source-file") ?? "";
      const line = (astro.getAttribute("data-astro-source-loc") ?? "").split(":")[0];
      const short = file.replace(/^.*?\/(src\/)/, "$1");
      return line ? `${short}:${line}` : short;
    }
    const fiberKey = Object.keys(el).find((key) => key.startsWith("__reactFiber$"));
    if (fiberKey) {
      let fiber = (el as any)[fiberKey];
      fiber = fiber?._debugOwner ?? fiber?.return;
      for (let hops = 0; fiber && hops < 40; hops++) {
        const name = typeName(fiber.type) || (typeof fiber.name === "string" ? fiber.name : "");
        if (name.length > 2 && /^[A-Z]/.test(name)) return `<${name}>`;
        fiber = fiber._debugOwner ?? fiber.return;
      }
    }
    const vue = (el as any).__vueParentComponent?.type;
    if (vue && (vue.__name || vue.name)) return `<${vue.__name || vue.name}>`;
    const svelte = (el as any).__svelte_meta?.loc?.file;
    if (typeof svelte === "string") return svelte.replace(/^.*?\/(src\/)/, "$1");
    return "";
  };
  const tagOf = (el: Element): string => {
    let out = el.localName;
    const id = el.id;
    if (id && id.length < 40 && !/\d{3,}|^:|^(?:radix|headlessui|react-aria|mui|base-ui)-/.test(id)) out += `#${id}`;
    const testId = el.getAttribute("data-testid") ?? el.getAttribute("data-test");
    if (testId) {
      out += `[data-testid="${testId}"]`;
    } else {
      const classes: string[] = [];
      for (const name of Array.from(el.classList)) {
        const readable = readableClass(name);
        if (readable && !classes.includes(readable)) classes.push(readable);
        if (classes.length === 2) break;
      }
      out += classes.map((name) => `.${name}`).join("");
    }
    return out;
  };
  const nameOf = (el: Element): string => {
    const ids = el.getAttribute("aria-labelledby");
    if (ids) {
      const text = squash(ids.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? "").join(" "));
      if (text) return text;
    }
    const aria = squash(el.getAttribute("aria-label"));
    if (aria) return aria;
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      const labels = squash(Array.from(el.labels ?? []).map((label) => label.textContent).join(" "));
      if (labels) return labels;
      if (el instanceof HTMLInputElement) {
        if (/^(?:submit|button|reset)$/.test(el.type)) return squash(el.value) || (el.type === "button" ? "" : el.type);
        if (el.type === "image") return squash(el.alt);
      }
      return squash(el.getAttribute("title")) || squash(el.getAttribute("placeholder"));
    }
    if (el instanceof HTMLImageElement) return squash(el.alt) || squash(el.title);
    const text = squash(el.textContent);
    if (text) return text;
    for (const inner of Array.from(el.querySelectorAll("img[alt], [aria-label], svg title, [title]"))) {
      const found = squash(
        inner.getAttribute("alt") ?? inner.getAttribute("aria-label") ?? (inner.localName === "title" ? inner.textContent : inner.getAttribute("title")),
      );
      if (found) return found;
    }
    return squash(el.getAttribute("title"));
  };
  const describe = (el: Element): string => {
    if (el === body || el === root) return "the page";
    let out = tagOf(el);
    const own = squash(el.getAttribute("aria-label")) || (el instanceof HTMLImageElement ? squash(el.alt) : "");
    const text = own || (el.childElementCount <= 3 ? squash(el.textContent) : "");
    if (text && text.length <= 120) out += ` "${cut(text, 40)}"`;
    const source = sourceOf(el);
    if (source) out += ` in ${source}`;
    return out;
  };
  const selectorFor = (el: Element): string => {
    const parts: string[] = [];
    for (let node: Element | null = el; node && node !== root; node = node.parentElement) {
      if (node === body) {
        parts.unshift("body");
        break;
      }
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && doc.querySelectorAll(`#${node.id}`).length === 1) {
        parts.unshift(`#${node.id}`);
        break;
      }
      const tag = node.localName;
      const twins = node.parentElement ? Array.from(node.parentElement.children).filter((child) => child.localName === tag) : [];
      parts.unshift(twins.length > 1 ? `${tag}:nth-of-type(${twins.indexOf(node) + 1})` : tag);
    }
    return parts.join(" > ");
  };
  const report = (kind: string, message: string, el: Element | null) => {
    findings.push({ kind, message, where: el ? describe(el) : "", selector: el && el !== body && el !== root ? selectorFor(el) : "" });
  };

  // ---- what is on the page ---------------------------------------------------

  const shown = new Map<Element, boolean>();
  const visible = (el: Element): boolean => {
    let result = shown.get(el);
    if (result === undefined) {
      const check = (el as any).checkVisibility;
      result =
        typeof check === "function"
          ? Boolean(check.call(el, { checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }))
          : true;
      if (result) {
        const rect = el.getBoundingClientRect();
        result = rect.width > 0 && rect.height > 0;
      }
      shown.set(el, result);
    }
    return result;
  };
  const length = (value: string | undefined, whole: number): number => {
    if (value === undefined || value === "auto") return NaN;
    return value.endsWith("%") ? (parseFloat(value) / 100) * whole : /^-?[\d.]+(?:px)?$/.test(value) ? parseFloat(value) : NaN;
  };
  /**
   * Whether `clip` or `clip-path` leaves nothing of the box to see, at any size:
   * a skip link clipped to an empty rectangle until it has focus, say.
   */
  const clippedAway = (style: CSSStyleDeclaration, width: number, height: number): boolean => {
    const rect = /^rect\((.*)\)$/.exec(style.clip);
    if (rect && (style.position === "absolute" || style.position === "fixed")) {
      const [top, right, bottom, left] = rect[1]!.split(/\s*,\s*|\s+/).map((side, index) => {
        const value = length(side, 0);
        return Number.isNaN(value) ? [0, width, height, 0][index]! : value;
      });
      if (right! - left! <= 0 || bottom! - top! <= 0) return true;
    }
    const path = style.clipPath;
    const inset = /^inset\(([^)]*)\)/.exec(path);
    if (inset) {
      const sides = inset[1]!.split(/\s+round\s+/)[0]!.trim().split(/\s+/);
      const [top, right = top, bottom = top, left = right] = sides;
      const vertical = length(top, height) + length(bottom, height);
      const sideways = length(left, width) + length(right, width);
      if (vertical >= height - 0.5 || sideways >= width - 0.5) return true;
    }
    const round = /^(circle|ellipse)\(\s*([^\s)]+)(?:\s+([^\s)]+))?/.exec(path);
    if (round && round[2] !== "at") {
      if (length(round[2], width) === 0 || (round[1] === "ellipse" && round[3] !== "at" && length(round[3], height) === 0)) return true;
    }
    return false;
  };
  const readerOnly = new Map<Element, boolean>();
  /** True for text kept on the page for screen readers and hidden from sight. */
  const forReadersOnly = (el: Element | null): boolean => {
    if (!el || el === body || el === root) return false;
    let result = readerOnly.get(el);
    if (result === undefined) {
      const style = cs(el);
      const rect = el.getBoundingClientRect();
      const clipped = style.overflowX !== "visible" || style.clipPath !== "none" || (style.clip !== "auto" && style.clip !== "");
      // A clip is given in the box's own pixels, before any transform scales it.
      const own = el as HTMLElement;
      const width = typeof own.offsetWidth === "number" ? own.offsetWidth : rect.width;
      const height = typeof own.offsetHeight === "number" ? own.offsetHeight : rect.height;
      result =
        ((rect.width <= 2 || rect.height <= 2) && clipped)
        || /inset\(\s*(?:50|100)%/.test(style.clipPath)
        || (clipped && clippedAway(style, width, height))
        || forReadersOnly(parentOf(el));
      readerOnly.set(el, result);
    }
    return result;
  };

  const collect = (): Element[] => {
    const list: Element[] = [body];
    const walk = (from: Node) => {
      const walker = doc.createTreeWalker(from, NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode() as Element | null; node && list.length < 30_000; node = walker.nextNode() as Element | null) {
        list.push(node);
        if (node.shadowRoot) walk(node.shadowRoot);
      }
    };
    walk(body);
    return list;
  };

  const CONTROLS =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"]';
  const usable = (el: Element): boolean =>
    visible(el)
    && !forReadersOnly(el)
    && !el.matches(':disabled, [aria-disabled="true"]')
    && !el.closest("[inert]")
    && cs(el).pointerEvents !== "none";
  const controlName = (el: Element): string => {
    const role = el.getAttribute("role") ?? (el.localName === "a" ? "link" : el.localName === "summary" ? "button" : el.localName);
    const name = nameOf(el);
    return name ? `${role} "${cut(name, 40)}"` : describe(el);
  };

  // ---- scrolling through the page once ----------------------------------------

  const pageScroller = doc.scrollingElement ?? root;
  let inner: Element | null = null;
  if (pageScroller.scrollHeight <= vh + 1) {
    let best = 0;
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      if (el.scrollHeight <= el.clientHeight + 50 || el.clientHeight * el.clientWidth < vw * vh * 0.3) continue;
      const overflow = cs(el).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && el.clientHeight * el.clientWidth > best) {
        best = el.clientHeight * el.clientWidth;
        inner = el;
      }
    }
  }
  const scroller = inner ?? pageScroller;
  const limit = () => Math.max(0, scroller.scrollHeight - (inner ? inner.clientHeight : vh));
  const scrollTo = (top: number) => scroller.scrollTo({ top, left: 0, behavior: "instant" as ScrollBehavior });
  if (inner) notes.push(`The page scrolls inside ${describe(inner)}; pictures show its first screen.`);

  const topAt = (x: number, y: number): Element | null => {
    let el = doc.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const deeper = el.shadowRoot.elementFromPoint(x, y);
      if (!deeper || deeper === el) break;
      el = deeper;
    }
    return el;
  };
  /** Whether a box is where the fixed layers inside it are placed, so they move with it. */
  const holdsFixed = (style: CSSStyleDeclaration) =>
    style.transform !== "none" || style.filter !== "none" || style.perspective !== "none" || /paint|layout|strict|content/.test(style.contain);
  /** Whether a point inside a control lies past the edge of a box around it that hides what overflows. */
  const outOfSight = (el: Element, x: number, y: number): boolean => {
    // Only the boxes that contain it can hide it: a fixed control escapes every box but one that holds fixed
    // layers, and a positioned one escapes the unpositioned boxes between it and the box it is placed in.
    let escape = cs(el).position;
    for (let node = parentOf(el); node && node !== body && node !== root; node = parentOf(node)) {
      const style = cs(node);
      const holds = holdsFixed(style);
      if (escape === "fixed" && !holds) continue;
      if (escape === "absolute" && style.position === "static" && !holds) continue;
      escape = style.position;
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const box = node.getBoundingClientRect();
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) return true;
    }
    return false;
  };
  /**
   * Whether a box that scrolls a control can move its middle out from under what covers it: the cover stays
   * where it is while the box scrolls, such as a sticky header or a bar laid over a list, and the box has the
   * room to scroll it clear.
   */
  const scrollsClear = (el: Element, cover: Element, y: number): boolean => {
    const over = cover.getBoundingClientRect();
    const pinned = (node: Element, upTo: Element | null) => {
      for (let up: Element | null = node; up && up !== upTo; up = parentOf(up)) {
        const position = cs(up).position;
        if (position === "sticky") return true;
        if (position === "fixed") {
          // Fixed inside a box that holds fixed layers, such as a transformed wrapper, it moves with that box.
          for (let holder = parentOf(up); holder && holder !== upTo && holder !== root; holder = parentOf(holder)) {
            if (holdsFixed(cs(holder))) return false;
          }
          return true;
        }
      }
      return false;
    };
    const boxes: Element[] = [];
    for (let node = parentOf(el); node && node !== body && node !== root; node = parentOf(node)) {
      const overflow = cs(node).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight + 1) boxes.push(node);
    }
    // A page that hides its overflow, as one does under an open dialog, cannot be scrolled by its user.
    // The page's own overflow is the root's, or the body's when the root leaves it visible.
    const viewport = cs(root).overflowY !== "visible" ? cs(root).overflowY : cs(body).overflowY;
    if (viewport !== "hidden" && viewport !== "clip" && pageScroller.scrollHeight > vh + 1) boxes.push(pageScroller);
    return boxes.some((box) => {
      const page = box === pageScroller;
      // A control that stays put while the box scrolls, such as a fixed chat button, is never scrolled clear.
      if (pinned(el, page ? null : box)) return false;
      if (page ? !pinned(cover, null) : within(box, cover) && !pinned(cover, box)) return false;
      const sight = page ? { top: 0, bottom: vh } : box.getBoundingClientRect();
      const up = box.scrollTop;
      const down = box.scrollHeight - box.clientHeight - box.scrollTop;
      // Scrolling the box on moves the control up, and back moves it down.
      const rise = y - over.top + 1;
      const fall = over.bottom - y + 1;
      return (rise <= down && y - rise >= sight.top) || (fall <= up && y + fall <= sight.bottom);
    });
  };
  /** What sits over the centre of each control, for controls that are not on top there. */
  const coveredBy = new Map<Element, Element>();
  const tested = new Set<Element>();
  // A look that is not scrolled tests each control where it is; one that a scroller could move clear of its
  // cover is not covered, as it would not be in a look that scrolls.
  const testControls = (from: number, to: number, still = false) => {
    for (const el of Array.from(doc.querySelectorAll(CONTROLS))) {
      if (tested.has(el) || !usable(el)) continue;
      if (el instanceof HTMLInputElement && /^(?:checkbox|radio|file|range)$/.test(el.type)) continue;
      if (Number(cs(el).opacity) < 0.1) continue;
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (y < from || y > to || x < 0 || x > vw) continue;
      // Scrolled out of sight inside a box: the box hides it, and nothing past the box's edge covers it.
      if (outOfSight(el, x, y)) continue;
      tested.add(el);
      const top = topAt(x, y);
      if (!top || within(el, top) || within(top, el)) continue;
      const label = top.closest("label");
      if (label && el instanceof HTMLInputElement && Array.from(el.labels ?? []).includes(label)) continue;
      if (still && scrollsClear(el, top, y)) continue;
      coveredBy.set(el, top);
    }
  };

  if (options.scroll && limit() > 0) {
    // Both passes go 40 screens down at most.
    const half = Math.max(100, Math.floor(vh / 2));
    const reach = 79 * half;
    // First pass: bring everything into view once so lazy content starts loading. One frame at each place
    // is enough: each scroll happens inside an animation frame, so that frame lays the page out there and
    // tells its observers, which is what lazy images and an IntersectionObserver wait for.
    const stride = Math.max(200, Math.floor(vh * 0.9));
    for (let top = 0; top < Math.min(limit(), reach); top += stride) {
      scrollTo(top);
      await frame();
    }
    scrollTo(limit());
    await frame();
    await frame();
    scrollTo(0);
    await frame();
    const deadline = performance.now() + 3000;
    while (scripts && performance.now() < deadline && Array.from(doc.images).some((image) => !image.complete)) await pause(50);
    await frame();
    // Second pass: test each control while it sits near the middle of the screen,
    // where a sticky header or footer has no business covering it.
    const end = limit();
    let at = 0;
    for (let top = 0; ; top += half) {
      at = Math.min(top, end);
      scrollTo(at);
      await frame();
      testControls(at === 0 ? 0 : vh * 0.25, at >= end ? vh : vh * 0.75);
      if (at >= end || top >= reach) break;
    }
    if (at < end) notes.push(`The page is ${px(scroller.scrollHeight)} tall; ra scrolled through its first 40 screens, so no control below them was tested for being covered.`);
    scrollTo(0);
    await frame();
    await frame();
  } else {
    testControls(0, vh, true);
  }

  // Finish what is still moving, so measurements and pictures agree.
  for (const animation of doc.getAnimations()) {
    try {
      const end = animation.effect?.getComputedTiming().endTime;
      if (typeof end === "number" && Number.isFinite(end)) animation.finish();
      else animation.cancel();
    } catch {
      // Some animations cannot be finished; they are left alone.
    }
  }
  await frame();
  styles.clear();

  const all = collect();
  const scope = options.scope ? doc.querySelector(options.scope) : null;
  let modal: Element | null = null;
  for (const el of Array.from(doc.querySelectorAll('dialog[open], [aria-modal="true"]'))) {
    if (!visible(el)) continue;
    if (el.localName === "dialog" && !el.matches(":modal")) continue;
    modal = el;
  }
  // Some libraries leave `aria-modal` off a modal dialog, for Safari's sake, and shut the rest of the page out
  // with `inert` or `aria-hidden` instead. While a dialog is open over a page shut out like that, what is shut
  // out lies behind it. What the shutting leaves alone, such as a toast, is still judged. It is the page that
  // is shut out, so the part shut out beside the dialog covers a good share of the screen, unlike an icon
  // hidden from screen readers.
  const shut = (el: Element): boolean => el.hasAttribute("inert") || el.getAttribute("aria-hidden") === "true";
  const coversScreen = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    const width = Math.min(rect.right, vw) - Math.max(rect.left, 0);
    const height = Math.min(rect.bottom, vh) - Math.max(rect.top, 0);
    return width > 0 && height > 0 && width * height >= (vw * vh) / 4;
  };
  const shutOut = new Map<Element, boolean>();
  const isShutOut = (el: Element | null): boolean => {
    if (!el || el === body || el === root) return false;
    let result = shutOut.get(el);
    if (result === undefined) {
      result = shut(el) || isShutOut(parentOf(el));
      shutOut.set(el, result);
    }
    return result;
  };
  let behindDialog = false;
  if (!modal) {
    for (const dialog of Array.from(doc.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]'))) {
      if (!visible(dialog) || isShutOut(dialog)) continue;
      for (let node: Element | null = dialog; node && node !== body && node !== root && !behindDialog; node = parentOf(node)) {
        const siblings = Array.from((node.parentNode as ParentNode | null)?.children ?? []);
        behindDialog = siblings.some((sibling) => sibling !== node && shut(sibling) && visible(sibling) && coversScreen(sibling));
      }
      if (behindDialog) break;
    }
  }
  /** Whether problems with this element are worth reporting: inside the scope, and not behind an open dialog. */
  const subject = (el: Element): boolean =>
    (!scope || within(scope, el)) && (!modal || within(modal, el)) && !(behindDialog && isShutOut(el));
  /**
   * What is open on top of the page: menus, listboxes, dialogs, popovers and
   * whatever an expanded control has opened. Covering what lies beneath is what
   * they are for, so neither the controls nor the text under them are judged.
   */
  const popups: Element[] = [];
  const addPopup = (el: Element | null) => {
    if (el && el !== body && el !== root && !popups.includes(el) && visible(el)) popups.push(el);
  };
  const positioned = (el: Element) => /^(?:absolute|fixed)$/.test(cs(el).position);
  for (const el of Array.from(doc.querySelectorAll('dialog[open], [aria-modal="true"], [popover], [role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]'))) {
    if (el.hasAttribute("popover")) {
      let open = false;
      try {
        open = el.matches(":popover-open");
      } catch {
        open = false;
      }
      if (!open) continue;
    } else if (!el.matches('dialog[open], [aria-modal="true"]') && !positioned(el)) {
      // A menu bar, a list or a panel that is part of the page is not open over it; one that floats out of the flow is.
      continue;
    }
    addPopup(el);
  }
  for (const control of Array.from(doc.querySelectorAll('[aria-expanded="true"], details[open] > summary'))) {
    const home = control.getRootNode() as Document | ShadowRoot;
    const ids = `${control.getAttribute("aria-controls") ?? ""} ${control.getAttribute("aria-owns") ?? ""}`.split(/\s+/).filter(Boolean);
    const targets = ids.map((id) => home.getElementById(id)).filter((el): el is HTMLElement => el !== null);
    // A panel that holds its own control is one that control collapses, not one it opened over the page.
    for (const target of targets) if (!within(target, control)) addPopup(target);
    if (targets.length > 0) continue;
    // Nothing named: the panel it opened is a positioned box beside it.
    for (let sibling = control.nextElementSibling; sibling; sibling = sibling.nextElementSibling) if (positioned(sibling)) addPopup(sibling);
  }
  const inPopupOver = (el: Element, top: Element): boolean => popups.some((popup) => within(popup, top) && !within(popup, el));

  // ---- where content is clipped -------------------------------------------------

  interface Clip {
    l: number;
    r: number;
    t: number;
    b: number;
    ol: Element | null;
    or: Element | null;
    ot: Element | null;
    ob: Element | null;
    /**
     * What lies past that edge can be scrolled into view, so being out of sight there is not being cut off.
     * Each edge has its own: a box that hides its overflow cuts only at the edges where it is the tighter one.
     */
    sl: boolean;
    sr: boolean;
    st: boolean;
    sb: boolean;
    /** What can be seen right now: the edges of every box that does not show its overflow, scrollers included. */
    vl: number;
    vr: number;
    vt: number;
    vb: number;
  }
  const OPEN: Clip = {
    l: -Infinity, r: Infinity, t: -Infinity, b: Infinity, ol: null, or: null, ot: null, ob: null, sl: false, sr: false, st: false, sb: false,
    vl: -Infinity, vr: Infinity, vt: -Infinity, vb: Infinity,
  };
  const SCREEN: Clip = { l: 0, r: vw, t: 0, b: vh, ol: root, or: root, ot: root, ob: root, sl: false, sr: false, st: false, sb: false, vl: 0, vr: vw, vt: 0, vb: vh };
  const clips = new Map<Element, Clip>();
  /** The clip applied to an element's own box by what contains it. */
  const clipOn = (el: Element): Clip => {
    const position = cs(el).position;
    let ancestor = parentOf(el);
    if (position === "fixed") {
      while (ancestor && !holdsFixed(cs(ancestor))) ancestor = parentOf(ancestor);
      return ancestor ? clipWithin(ancestor) : SCREEN;
    }
    if (position === "absolute") {
      while (ancestor && ancestor !== body && cs(ancestor).position === "static" && !holdsFixed(cs(ancestor))) ancestor = parentOf(ancestor);
    }
    return ancestor ? clipWithin(ancestor) : OPEN;
  };
  /** The clip applied to whatever an element contains. */
  const clipWithin = (el: Element): Clip => {
    const known = clips.get(el);
    if (known) return known;
    let clip: Clip;
    if (el === root) {
      clip = OPEN;
    } else if (el === body) {
      clip = { ...OPEN };
      const refuses = (value: string) => value === "hidden" || value === "clip";
      // A page that refuses to scroll sideways cuts off whatever is wider than the screen.
      if (!inner && (refuses(cs(body).overflowX) || refuses(cs(root).overflowX))) {
        clip.l = clip.vl = 0;
        clip.ol = body;
        clip.r = clip.vr = vw;
        clip.or = body;
      }
    } else {
      clip = { ...clipOn(el) };
      const style = cs(el);
      const x = style.overflowX;
      const y = style.overflowY;
      if (x !== "visible" || y !== "visible") {
        // The inside of the box, in the same coordinates as the text in it:
        // a transform here or further up scales both.
        const rect = el.getBoundingClientRect();
        const width = (el as HTMLElement).offsetWidth;
        const height = (el as HTMLElement).offsetHeight;
        const scaleX = width > 0 ? rect.width / width : 1;
        const scaleY = height > 0 ? rect.height / height : 1;
        const left = rect.left + el.clientLeft * scaleX;
        const top = rect.top + el.clientTop * scaleY;
        const right = left + el.clientWidth * scaleX;
        const bottom = top + el.clientHeight * scaleY;
        if (x !== "visible") {
          clip.vl = Math.max(clip.vl, left);
          clip.vr = Math.min(clip.vr, right);
        }
        if (y !== "visible") {
          clip.vt = Math.max(clip.vt, top);
          clip.vb = Math.min(clip.vb, bottom);
        }
        // A box that hides overflow inside a scrolling one cuts for real, so it
        // clears the "can be scrolled into view" mark the scroller set.
        if (x === "hidden" || x === "clip") {
          if (right < clip.r) {
            clip.r = right;
            clip.or = el;
            clip.sr = false;
          }
          if (left > clip.l) {
            clip.l = left;
            clip.ol = el;
            clip.sl = false;
          }
        } else if (x !== "visible" && el.scrollWidth > el.clientWidth + 1) {
          clip.sl = clip.sr = true;
        }
        if (y === "hidden" || y === "clip") {
          if (bottom < clip.b) {
            clip.b = bottom;
            clip.ob = el;
            clip.sb = false;
          }
          if (top > clip.t) {
            clip.t = top;
            clip.ot = el;
            clip.st = false;
          }
        } else if (y !== "visible" && el.scrollHeight > el.clientHeight + 1) {
          clip.st = clip.sb = true;
        }
      }
    }
    clips.set(el, clip);
    return clip;
  };

  // ---- text --------------------------------------------------------------------

  interface Run {
    el: Element;
    node: Text;
    text: string;
    rects: DOMRect[];
  }
  const runs: Run[] = [];
  const pictures = new Map<Element, boolean>();
  /** True for text that is part of a picture (`role="img"`), which is read as one image and named by its label. */
  const inPicture = (el: Element | null): boolean => {
    if (!el || el === body || el === root) return false;
    let result = pictures.get(el);
    if (result === undefined) {
      const role = (el.getAttribute("role") ?? "").trim().toLowerCase().split(/\s+/)[0];
      // One that holds something to Tab to is more than a picture, and its text is read as text. Tab passes over
      // what is disabled, inert or hidden, and over a link with nowhere to go.
      const reachable = () =>
        Array.from(el.querySelectorAll("*")).some(
          (inner) => (inner as HTMLElement).tabIndex >= 0 && !inner.matches("a:not([href]), area:not([href])") && usable(inner),
        );
      result = ((role === "img" || role === "image") && !reachable()) || inPicture(parentOf(el));
      pictures.set(el, result);
    }
    return result;
  };
  const NOT_TEXT = new Set(["script", "style", "noscript", "template", "textarea", "option", "select", "title"]);
  // With scripts off, what a page puts in <noscript> is what the reader sees.
  if (!scripts) NOT_TEXT.delete("noscript");
  const range = doc.createRange();
  const readText = (from: Node) => {
    const walker = doc.createTreeWalker(from, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && runs.length < 6000; node = walker.nextNode()) {
      const el = node.parentElement ?? ((node.parentNode as ShadowRoot | null)?.host ?? null);
      if (!el || NOT_TEXT.has(el.localName)) continue;
      const text = squash(node.nodeValue);
      if (!text || !visible(el) || forReadersOnly(el)) continue;
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0.5 && rect.height > 0.5);
      if (rects.length > 0) runs.push({ el, node: node as Text, text, rects });
    }
  };
  readText(body);
  for (const el of all) if (el.shadowRoot) readText(el.shadowRoot);

  /** Whether this element's text keeps its spaces, as `pre-wrap` does, rather than dropping them at the ends of lines. */
  const keepsSpaces = (el: Element): boolean => {
    const style = cs(el);
    return /^(?:preserve|preserve-spaces|break-spaces)$/.test(style.getPropertyValue("white-space-collapse")) || /^(?:pre|pre-wrap|break-spaces)\b/.test(style.whiteSpace);
  };
  const inks = new Map<Run, DOMRect[] | null>();
  /**
   * The inked part of a line: from its first letter to its last. Where text keeps its spaces, those at the end
   * of a wrapped line hang past it, taking room there and drawing nothing, so they cannot spill or be cut off.
   * Null for a line of nothing but spaces. A run too long to measure word by word keeps its line boxes.
   */
  const inkOn = (run: Run, line: DOMRect): DOMRect | null => {
    if (!keepsSpaces(run.el)) return line;
    let words = inks.get(run);
    if (words === undefined) {
      const found: DOMRect[] = [];
      let measured = true;
      const word = doc.createRange();
      for (const match of (run.node.nodeValue ?? "").matchAll(/\S+/gu)) {
        if (found.length >= 2000) {
          measured = false;
          break;
        }
        word.setStart(run.node, match.index);
        word.setEnd(run.node, match.index + match[0].length);
        for (const rect of Array.from(word.getClientRects())) if (rect.width > 0.5 && rect.height > 0.5) found.push(rect);
      }
      words = measured ? found : null;
      inks.set(run, words);
    }
    if (words === null) return line;
    let left = Infinity;
    let right = -Infinity;
    for (const rect of words) {
      // A word on this line, not on the one above or below, which can overlap it a little.
      if (Math.min(rect.bottom, line.bottom) - Math.max(rect.top, line.top) <= Math.min(rect.height, line.height) / 2) continue;
      left = Math.min(left, rect.left);
      right = Math.max(right, rect.right);
    }
    return right > left ? new DOMRect(left, line.top, right - left, line.height) : null;
  };

  const edgeName = (owner: Element) => (owner === root ? "the edge of the screen" : owner === body ? "the edge of the page" : describe(owner));
  type Side = "right" | "left" | "bottom" | "top";
  interface Cut {
    owner: Element;
    side: Side;
    first: Element;
    text: string;
    amount: string;
    count: number;
  }
  const cuts = new Map<string, Cut>();
  const ownerIds = new Map<Element, number>();
  const cutBy = (owner: Element, side: Side, el: Element, text: string, amount: string) => {
    if (!ownerIds.has(owner)) ownerIds.set(owner, ownerIds.size);
    const key = `${ownerIds.get(owner)}:${side}`;
    const known = cuts.get(key);
    if (known) {
      if (known.first !== el) known.count++;
    } else {
      cuts.set(key, { owner, side, first: el, text, amount, count: 1 });
    }
  };
  const trims = (owner: Element | null) => Boolean(owner) && cs(owner!).textOverflow !== "clip";
  const clamps = (owner: Element | null) => {
    if (!owner) return false;
    const value = cs(owner).getPropertyValue("-webkit-line-clamp");
    return value !== "" && value !== "none";
  };

  interface Spill {
    box: Element;
    side: Side;
    el: Element;
    text: string;
    by: number;
    count: number;
  }
  const spills = new Map<string, Spill>();
  let painter: CanvasRenderingContext2D | null | undefined;
  const alphaOf = (color: string): number => {
    if (color === "transparent") return 0;
    // An sRGB color is computed as rgb(r, g, b) or rgba(r, g, b, a).
    const legacy = /^rgba?\(([^()/]+)\)$/u.exec(color);
    if (legacy) {
      const parts = legacy[1]!.split(/[\s,]+/).filter(Boolean);
      return parts.length >= 4 ? Number(parts[3]) : 1;
    }
    // Any other space keeps its own syntax, with the alpha after a slash: oklch(), oklab(), color(),
    // and what color-mix() resolves to.
    const slash = /^[a-z-]+\([^()]*\/\s*([\d.]+)(%?)\s*\)$/u.exec(color);
    if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
    if (/^[a-z-]+\([^()/]*\)$/u.test(color)) return 1;
    // Anything else, such as a color-mix() left unresolved: paint it, and read how much was painted.
    painter ??= doc.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!painter) return 1;
    painter.clearRect(0, 0, 1, 1);
    painter.fillStyle = "#000000";
    painter.fillStyle = color;
    painter.fillRect(0, 0, 1, 1);
    return painter.getImageData(0, 0, 1, 1).data[3]! / 255;
  };
  const hasSurface = (style: CSSStyleDeclaration) =>
    alphaOf(style.backgroundColor) > 0.05
    || style.backgroundImage !== "none"
    || style.boxShadow !== "none"
    || (style.borderTopStyle !== "none" && parseFloat(style.borderTopWidth) > 0 && alphaOf(style.borderTopColor) > 0.05)
    || (style.borderRightStyle !== "none" && parseFloat(style.borderRightWidth) > 0 && alphaOf(style.borderRightColor) > 0.05);
  /** The nearest box a reader would see this text sitting in, or null when the text was placed on purpose. */
  const boxAround = (el: Element): Element | null => {
    for (let node: Element | null = el; node && node !== body && node !== root; node = parentOf(node)) {
      const style = cs(node);
      if (style.display !== "inline" && hasSurface(style)) return node;
      if (style.position === "absolute" || style.position === "fixed" || style.transform !== "none" || style.float !== "none") return null;
    }
    return null;
  };

  for (const run of runs) {
    if (!subject(run.el) || inPicture(run.el)) continue;
    const clip = clipWithin(run.el);
    let below = 0;
    let inSight = 0;
    for (const rect of run.rects) {
      // Past a side, only ink counts.
      const ink = rect.right > clip.r + 2 || rect.left < clip.l - 2 ? inkOn(run, rect) : rect;
      if (ink && !clip.sr && clip.or && ink.right > clip.r + 2 && ink.left < clip.r - 2 && !trims(clip.or)) {
        cutBy(clip.or, "right", run.el, run.text, `${px(ink.right - clip.r)} hidden`);
      }
      if (ink && !clip.sl && clip.ol && ink.left < clip.l - 2 && ink.right > clip.l + 2 && !trims(clip.ol)) {
        cutBy(clip.ol, "left", run.el, run.text, `${px(clip.l - ink.left)} hidden`);
      }
      const enough = Math.max(3, rect.height * 0.25);
      if (!clip.sb && clip.ob && rect.top >= clip.b - 1) {
        below++;
      } else if (!clip.sb && clip.ob && rect.bottom > clip.b + enough && !clamps(clip.ob)) {
        cutBy(clip.ob, "bottom", run.el, run.text, `${px(rect.bottom - clip.b)} hidden`);
      } else if (!clip.st && clip.ot && rect.top < clip.t - enough && rect.bottom > clip.t + 2) {
        cutBy(clip.ot, "top", run.el, run.text, `${px(clip.t - rect.top)} hidden`);
      } else if (!clip.sb && rect.bottom > clip.t && rect.left < clip.r && rect.right > clip.l) {
        inSight++;
      }
    }
    if (below > 0 && inSight > 0 && clip.ob && clip.ob !== body && clip.ob !== root && !clamps(clip.ob)) {
      cutBy(clip.ob, "bottom", run.el, run.text, `${below} line${below === 1 ? "" : "s"} hidden`);
    }

    const box = boxAround(run.el);
    if (box) {
      const edge = box.getBoundingClientRect();
      // Text in a box that scrolls is not spilling out of it; text in one that
      // hides its overflow is clipped, which the cut-off check reports.
      let freeX = true;
      let freeY = true;
      for (let node: Element | null = run.el; node; node = parentOf(node)) {
        const style = cs(node);
        if (style.overflowX !== "visible") freeX = false;
        if (style.overflowY !== "visible") freeY = false;
        if (node === box) break;
      }
      for (const line of run.rects) {
        // Past a side, only ink counts.
        const rect = line.right > edge.right + 3 || line.left < edge.left - 3 ? inkOn(run, line) : line;
        if (!rect || rect.left >= edge.right || rect.right <= edge.left) continue;
        let side: Side | null = null;
        let by = 0;
        if (freeX && rect.right > edge.right + 3 && clip.r > edge.right + 1) {
          side = "right";
          by = rect.right - edge.right;
        } else if (freeX && rect.left < edge.left - 3 && clip.l < edge.left - 1) {
          side = "left";
          by = edge.left - rect.left;
        } else if (freeY && rect.bottom > edge.bottom + Math.max(4, rect.height * 0.3) && rect.top < edge.bottom && clip.b > edge.bottom + 1) {
          side = "bottom";
          by = rect.bottom - edge.bottom;
        }
        if (!side) continue;
        if (!ownerIds.has(box)) ownerIds.set(box, ownerIds.size);
        const key = `${ownerIds.get(box)}:${side}`;
        const known = spills.get(key);
        if (known) {
          if (known.el !== run.el) known.count++;
          known.by = Math.max(known.by, by);
        } else {
          spills.set(key, { box, side, el: run.el, text: run.text, by, count: 1 });
        }
        break;
      }
    }
  }

  // Controls cut off by what contains them. Pushed past a side that does not scroll, a control is cut off
  // however little of it still shows, such as an icon whose last pixels are all that is left of it.
  for (const el of Array.from(doc.querySelectorAll(CONTROLS))) {
    if (!usable(el) || !subject(el)) continue;
    const clip = clipOn(el);
    const rect = el.getBoundingClientRect();
    if (!clip.sr && clip.or && rect.right > clip.r + 4 && rect.left < clip.r - 1) {
      cutBy(clip.or, "right", el, nameOf(el) || tagOf(el), `${px(rect.right - clip.r)} hidden`);
    } else if (!clip.sl && clip.ol && rect.left < clip.l - 4 && rect.right > clip.l + 1) {
      cutBy(clip.ol, "left", el, nameOf(el) || tagOf(el), `${px(clip.l - rect.left)} hidden`);
    } else if (!clip.sb && clip.ob && clip.ob !== root && rect.bottom > clip.b + 4 && rect.top < clip.b - 4) {
      cutBy(clip.ob, "bottom", el, nameOf(el) || tagOf(el), `${px(rect.bottom - clip.b)} hidden`);
    } else if (!clip.st && clip.ot && clip.ot !== root && rect.top < clip.t - 4 && rect.bottom > clip.t + 4) {
      // The top edge too: a control there is out of sight for `covered`, so this is where it is reported.
      cutBy(clip.ot, "top", el, nameOf(el) || tagOf(el), `${px(clip.t - rect.top)} hidden`);
    }
  }
  for (const item of cuts.values()) {
    const edge = { right: "on the right", left: "on the left", bottom: "at the bottom", top: "at the top" }[item.side];
    const by = item.owner === item.first ? "its own box" : edgeName(item.owner);
    const what = `"${cut(item.text, 40)}"`;
    report(
      "cut-off",
      item.count === 1
        ? `${what} is cut off ${edge} by ${by} (${item.amount}).`
        : `${item.count} pieces of text are cut off ${edge} by ${by}, starting with ${what} (${item.amount}).`,
      item.first,
    );
  }
  for (const item of spills.values()) {
    const edge = { right: "past the right edge", left: "past the left edge", bottom: "below the bottom", top: "above the top" }[item.side];
    const more = item.count > 1 ? ` (and ${item.count - 1} more)` : "";
    // A box holding nothing but this text is named by its tag alone, not by the text again.
    const boxName = squash(item.box.textContent) === item.text ? `its box, ${tagOf(item.box)}` : describe(item.box);
    report("spill", `"${cut(item.text, 40)}" runs ${px(item.by)} ${edge} of ${boxName}${more}.`, item.el);
  }

  // Text lying over other text on the same surface.
  const layerOf = (el: Element): Element => {
    for (let node: Element | null = el; node && node !== body; node = parentOf(node)) {
      const style = cs(node);
      if (alphaOf(style.backgroundColor) > 0.5 || style.backgroundImage !== "none" || style.position === "absolute" || style.position === "fixed" || style.transform !== "none") {
        return node;
      }
    }
    return body;
  };
  // Only what its boxes leave of a line can lie over other text: a box that hides its overflow ends the rest,
  // an ellipsis included. A scroller hides only for now. Two lines in the same scroller move together, so the
  // reader meets the clash wherever it is; a line in another one is compared by what its scroller shows.
  const lines: Array<{ el: Element; text: string; rect: DOMRect; seen: DOMRect | null; scroller: Element | null; layer: Element }> = [];
  const scrollerOf = (el: Element): Element | null => {
    for (let node = parentOf(el); node && node !== body && node !== root; node = parentOf(node)) {
      const s = cs(node);
      if (/^(?:auto|scroll)$/.test(s.overflowX) || /^(?:auto|scroll)$/.test(s.overflowY)) return node;
    }
    return null;
  };
  for (const run of runs) {
    if (!subject(run.el) || inPicture(run.el)) continue;
    const clip = clipWithin(run.el);
    const layer = layerOf(run.el);
    const scroller = scrollerOf(run.el);
    for (const rect of run.rects) {
      const left = Math.max(rect.left, clip.l);
      const right = Math.min(rect.right, clip.r);
      const top = Math.max(rect.top, clip.t);
      const bottom = Math.min(rect.bottom, clip.b);
      if (right <= left || bottom <= top) continue;
      const sl = Math.max(left, clip.vl);
      const sr = Math.min(right, clip.vr);
      const st = Math.max(top, clip.vt);
      const sb = Math.min(bottom, clip.vb);
      const seen = sr > sl && sb > st ? new DOMRect(sl, st, sr - sl, sb - st) : null;
      lines.push({ el: run.el, text: run.text, rect: new DOMRect(left, top, right - left, bottom - top), seen, scroller, layer });
    }
  }
  lines.sort((a, b) => a.rect.top - b.rect.top);
  const clashes = new Set<Element>();
  let clashCount = 0;
  for (let i = 0; i < lines.length && clashCount < 5; i++) {
    const a = lines[i]!;
    for (let j = i + 1; j < lines.length && lines[j]!.rect.top < a.rect.bottom; j++) {
      const b = lines[j]!;
      if (a.el === b.el || a.layer !== b.layer || within(a.el, b.el) || within(b.el, a.el)) continue;
      if (clashes.has(a.el) || clashes.has(b.el)) continue;
      const same = a.scroller === b.scroller;
      const ar = same ? a.rect : a.seen;
      const br = same ? b.rect : b.seen;
      if (!ar || !br) continue;
      const width = Math.min(ar.right, br.right) - Math.max(ar.left, br.left);
      const height = Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top);
      if (width < 4 || height < 4) continue;
      const smaller = Math.min(ar.width * ar.height, br.width * br.height);
      if (width * height < smaller * 0.4) continue;
      clashes.add(a.el);
      clashes.add(b.el);
      clashCount++;
      report("overlap", `"${cut(a.text, 30)}" and "${cut(b.text, 30)}" are drawn on top of each other.`, b.el);
    }
  }

  // ---- the page scrolling sideways -------------------------------------------

  const pageWidth = Math.max(root.scrollWidth, body.scrollWidth);
  const sideways = pageScroller.scrollWidth - vw;
  if (sideways > 1 && !scope) {
    const out = new Set<Element>();
    for (const el of all) {
      if (el === body || !visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.right <= vw + 1 || rect.left >= pageScroller.scrollWidth) continue;
      const clip = clipOn(el);
      if (clip.r <= vw + 1 || clip.sr) continue;
      let pinned = false;
      for (let node: Element | null = el; node && node !== body; node = parentOf(node)) {
        if (cs(node).position === "fixed") {
          pinned = true;
          break;
        }
      }
      if (!pinned) out.add(el);
    }
    const outer = Array.from(out).filter((el) => {
      const parent = parentOf(el);
      return !parent || !out.has(parent);
    });
    const parts = outer.slice(0, 3).map((el) => {
      let deepest = el;
      for (;;) {
        const next: Element | undefined = Array.from(deepest.children).filter((child) => out.has(child)).sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
        if (!next) break;
        deepest = next;
      }
      const rect = deepest.getBoundingClientRect();
      const inside = deepest === el ? "" : ` inside ${tagOf(el)}`;
      return `${describe(deepest)}${inside} (${px(rect.width)} wide, ends ${px(rect.right - vw)} past the edge)`;
    });
    report(
      "page-scroll",
      `The page scrolls sideways by ${px(sideways)}.${parts.length > 0 ? ` Sticking out: ${parts.join("; ")}.` : ""}`,
      outer[0] ?? null,
    );
  }

  // ---- controls -------------------------------------------------------------------

  const controls = Array.from(doc.querySelectorAll(CONTROLS)).filter((el) => usable(el) && subject(el));

  // An editable picker often keeps DOM focus in its input while its list lives
  // in a portal. Follow the accessibility relationships across that boundary.
  const references = (el: Element, attr: "aria-controls" | "aria-owns"): Element[] => {
    const reflected = attr === "aria-controls" ? el.ariaControlsElements : el.ariaOwnsElements;
    if (reflected?.length) return Array.from(reflected);
    const tree = el.getRootNode() as Document | ShadowRoot;
    return (el.getAttribute(attr) ?? "").split(/\s+/u).flatMap((id) => {
      const target = id && tree.getElementById(id);
      return target ? [target] : [];
    });
  };
  const exposed = (el: Element): boolean => {
    if (isShutOut(el) || ["hidden", "collapse"].includes(cs(el).visibility)) return false;
    for (let node: Element | null = el; node; node = parentOf(node)) {
      if (cs(node).display === "none" || cs(node).contentVisibility === "hidden") return false;
    }
    return true;
  };
  // An option can itself be portalled under a listbox or a group via aria-owns.
  const ownsOption = (list: Element, option: Element, seen = new Set<Element>()): boolean => {
    if (within(list, option)) return true;
    if (seen.has(list)) return false;
    seen.add(list);
    return [list, ...list.querySelectorAll("[aria-owns]")].some((owner) =>
      references(owner, "aria-owns").some((owned) => ownsOption(owned, option, seen))
    );
  };
  for (const combo of all) {
    if (!combo.matches('[role="combobox"][aria-expanded="true"]') || !subject(combo) || !visible(combo) || !exposed(combo)) continue;
    if (combo instanceof HTMLSelectElement || (combo instanceof HTMLInputElement && combo.list)) continue;
    if (combo.hasAttribute("aria-haspopup") && combo.getAttribute("aria-haspopup") !== "listbox") continue;
    const declared = [...references(combo, "aria-controls"), ...references(combo, "aria-owns")];
    // Older wrapper-style comboboxes may contain the list directly.
    const candidates = declared.length || combo.hasAttribute("aria-controls") || combo.hasAttribute("aria-owns")
      ? declared : Array.from(combo.querySelectorAll('[role="listbox"], select'));
    const lists = candidates.filter((el) => exposed(el) && (el.getAttribute("role") === "listbox" || (el instanceof HTMLSelectElement && (el.multiple || el.size > 1))));
    if (!lists.length) {
      report("combobox", `${controlName(combo)} is expanded, but its list of choices is missing or hidden from assistive technology.`, combo);
      continue;
    }
    const input = combo.querySelector('[aria-activedescendant]') ?? combo;
    const activeId = input.getAttribute("aria-activedescendant")?.trim();
    const active = input.ariaActiveDescendantElement ?? (activeId ? (input.getRootNode() as Document | ShadowRoot).getElementById(activeId) : null);
    if (!activeId && !active) continue; // Opening or empty results need no highlighted option.
    if (!active || !active.matches('[role="option"], option') || !exposed(active) || !lists.some((list) => ownsOption(list, active))) {
      report("combobox", `${controlName(combo)} identifies a keyboard choice that is missing, hidden, or outside its list.`, combo);
    }
  }

  const coverers = new Map<Element, Element[]>();
  for (const [el, top] of coveredBy) {
    if (!subject(el) || !el.isConnected || !top.isConnected || inPopupOver(el, top)) continue;
    let surface = top;
    // Name the whole overlay, not the paragraph inside it that happened to be hit.
    for (let node = parentOf(top); node && node !== body && !within(node, el); node = parentOf(node)) {
      const position = cs(node).position;
      if (position === "fixed" || position === "sticky" || position === "absolute") surface = node;
    }
    coverers.set(surface, [...(coverers.get(surface) ?? []), el]);
  }
  for (const [surface, hidden] of coverers) {
    const names = hidden.slice(0, 3).map(controlName).join(", ");
    report(
      "covered",
      hidden.length === 1
        ? `${names} is covered by ${describe(surface)}; a click or tap on it would land on that instead.`
        : `${describe(surface)} covers ${hidden.length} controls: ${names}${hidden.length > 3 ? ", …" : ""}.`,
      hidden[0]!,
    );
  }

  if (options.touch) {
    const least = options.tapTarget;
    // A control on a layer that does not scroll, moved off the screen, such as a skip link until it has focus,
    // cannot be tapped at all.
    const offScreen = (el: Element) => {
      const rect = el.getBoundingClientRect();
      if (rect.right > 0 && rect.left < vw && rect.bottom > 0 && rect.top < vh) return false;
      for (let node: Element | null = el; node && node !== body; node = parentOf(node)) {
        const s = cs(node);
        // A scroller between it and the fixed layer, such as a full-screen menu, can bring it onto the screen.
        if (node !== el && (/^(?:auto|scroll)$/.test(s.overflowY) || /^(?:auto|scroll)$/.test(s.overflowX))) return false;
        if (s.position === "fixed") return true;
      }
      return false;
    };
    // WCAG 2.5.8's inline exception: a link in a sentence is as tall as its line, even inside spans of its own.
    const inSentence = (el: Element): boolean => {
      if (cs(el).display !== "inline") return false;
      for (let node = el.parentNode; node; node = node.parentNode) {
        if (Array.from(node.childNodes).some((child) => child.nodeType === 3 && squash(child.nodeValue).length > 1)) return true;
        if (!(node instanceof Element) || node === body || cs(node).display !== "inline") return false;
      }
      return false;
    };
    const targets = controls
      .filter((el) => !(el instanceof HTMLInputElement && Number(cs(el).opacity) < 0.1) && !offScreen(el))
      .map((el) => {
        let { left, top, right, bottom } = el.getBoundingClientRect();
        // A tap on anything a control holds reaches it, such as a transparent input laid over a small label,
        // unless the control hides what overflows it.
        const own = cs(el);
        if (own.overflowX === "visible" && own.overflowY === "visible") {
          const self = el.getBoundingClientRect();
          for (const inner of Array.from(el.querySelectorAll("*"))) {
            const style = cs(inner);
            // Not text kept for screen readers, not the part a box inside hides, and not what floats clear of
            // the control, such as a tooltip: none of those is a place to tap it.
            if (style.pointerEvents === "none" || style.visibility === "hidden" || style.display === "none" || forReadersOnly(inner)) continue;
            let { left: l, top: t, right: r, bottom: b } = inner.getBoundingClientRect();
            for (let up = parentOf(inner); up && up !== el; up = parentOf(up)) {
              const s = cs(up);
              if (s.overflowX === "visible" && s.overflowY === "visible") continue;
              const box = up.getBoundingClientRect();
              l = Math.max(l, box.left);
              t = Math.max(t, box.top);
              r = Math.min(r, box.right);
              b = Math.min(b, box.bottom);
            }
            if (r - l <= 0 || b - t <= 0) continue;
            if (r < self.left || l > self.right || b < self.top || t > self.bottom) continue;
            left = Math.min(left, l);
            top = Math.min(top, t);
            right = Math.max(right, r);
            bottom = Math.max(bottom, b);
          }
        }
        if (el instanceof HTMLInputElement) {
          for (const label of Array.from(el.labels ?? [])) {
            const rect = label.getBoundingClientRect();
            if (rect.width === 0) continue;
            left = Math.min(left, rect.left);
            top = Math.min(top, rect.top);
            right = Math.max(right, rect.right);
            bottom = Math.max(bottom, rect.bottom);
          }
        }
        return { el, left, top, right, bottom };
      });
    const grown = targets.map((target) => {
      const cx = (target.left + target.right) / 2;
      const cy = (target.top + target.bottom) / 2;
      const halfWidth = Math.max(least, target.right - target.left) / 2;
      const halfHeight = Math.max(least, target.bottom - target.top) / 2;
      return { left: cx - halfWidth, right: cx + halfWidth, top: cy - halfHeight, bottom: cy + halfHeight };
    });
    const small = new Map<Element, Array<{ el: Element; size: string }>>();
    targets.forEach((target, index) => {
      const width = target.right - target.left;
      const height = target.bottom - target.top;
      if (width >= least - 0.5 && height >= least - 0.5) return;
      const el = target.el;
      if (inSentence(el)) return;
      // Small is fine when nothing else is near enough to hit by mistake.
      const mine = grown[index]!;
      const crowded = grown.some((other, at) => {
        if (at === index || within(targets[at]!.el, el) || within(el, targets[at]!.el)) return false;
        return other.left < mine.right && other.right > mine.left && other.top < mine.bottom && other.bottom > mine.top;
      });
      if (!crowded) return;
      const group = el.closest("nav, footer, header, form, ul, ol, table, section, aside, main") ?? body;
      small.set(group, [...(small.get(group) ?? []), { el, size: `${Math.round(width)}×${Math.round(height)}` }]);
    });
    for (const [group, items] of small) {
      const first = items[0]!;
      report(
        "small-target",
        items.length === 1
          ? `${controlName(first.el)} is ${first.size}, smaller than a ${least}px tap target with another control close by.`
          : `${items.length} tap targets in ${group === body ? "the page" : tagOf(group)} are smaller than ${least}px with other controls close by, starting with ${controlName(first.el)} (${first.size}).`,
        first.el,
      );
    }
  }

  // A control hidden from assistive technology and out of the tab order is never announced, so it needs no name; the
  // outline leaves it out too. One that Tab still reaches is announced with nothing to say.
  const nameless = controls.filter(
    (el) =>
      !(el.closest('[aria-hidden="true"]') && (el as HTMLElement).tabIndex < 0)
      && !el.shadowRoot
      && !el.querySelector("slot")
      && !Array.from(el.querySelectorAll("*")).some((inner) => inner.shadowRoot)
      && nameOf(el) === "",
  );
  if (nameless.length > 0) {
    const first = nameless[0]!;
    report(
      "no-name",
      nameless.length === 1
        ? `${describe(first)} has no accessible name, so a screen reader cannot say what it does.`
        : `${nameless.length} controls have no accessible name, starting with ${describe(first)}.`,
      first,
    );
  }

  // ---- images ---------------------------------------------------------------------

  const images = all.filter((el): el is HTMLImageElement => el instanceof HTMLImageElement && visible(el) && subject(el));
  const noAlt: HTMLImageElement[] = [];
  const short = (address: string) => {
    if (address.startsWith("data:")) return "an inline image";
    try {
      const url = new URL(address, location.href);
      return url.origin === location.origin ? url.pathname : `${url.host}${url.pathname}`;
    } catch {
      return address;
    }
  };
  for (const image of images) {
    const address = image.currentSrc || image.src;
    if (image.complete && image.naturalWidth === 0 && address) {
      report("image", `An image did not load: ${cut(short(address), 80)}.`, image);
      continue;
    }
    if (image.naturalWidth > 0 && cs(image).objectFit === "fill" && !/\.svg(?:$|[?#])|^data:image\/svg/.test(address)) {
      const style = cs(image);
      const rect = image.getBoundingClientRect();
      const width = rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
      const height = rect.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
      if (width > 24 && height > 24) {
        const drift = width / height / (image.naturalWidth / image.naturalHeight);
        if (drift > 1.08 || drift < 0.92) {
          report(
            "image",
            `An image is stretched: ${cut(short(address), 60)} is ${image.naturalWidth}×${image.naturalHeight} and is shown at ${Math.round(width)}×${Math.round(height)}.`,
            image,
          );
        }
      }
    }
    if (!image.hasAttribute("alt") && !/^(?:presentation|none)$/.test(image.getAttribute("role") ?? "") && !image.closest('[aria-hidden="true"]')) {
      noAlt.push(image);
    }
  }
  if (noAlt.length > 0) {
    const first = noAlt[0]!;
    const which = cut(short(first.currentSrc || first.src), 60);
    report(
      "no-name",
      noAlt.length === 1
        ? `An image has no alt attribute: ${which}. Give it a description, or alt="" if it is decoration.`
        : `${noAlt.length} images have no alt attribute, starting with ${which}. Describe them, or use alt="" for decoration.`,
      first,
    );
  }

  // ---- the document as a whole --------------------------------------------------

  if (!scope) {
    const media = all.some((el) => /^(?:img|svg|canvas|video|iframe|input|button|select|textarea)$/.test(el.localName) && visible(el));
    if (runs.length === 0 && !media) report("blank", "The page shows nothing: no text, picture or control is visible.", null);
    // A title and a viewport belong to HTML. A page served as plain text, JSON
    // or a picture has neither to give, so their absence is not a finding,
    // unless the plain text is a web page served with the wrong type.
    if (doc.contentType !== "text/html" && doc.contentType !== "application/xhtml+xml") {
      const start = (body.textContent ?? "").trimStart().slice(0, 64);
      if (doc.contentType === "text/plain" && /^<(?:!doctype\s+html|html|head|body)[\s>]/iu.test(start)) {
        report("document", "The page is HTML served as text/plain, so the browser shows its markup as text. Serve it as text/html.", null);
      } else {
        notes.push(`The page is ${doc.contentType}, not HTML, so ra did not look for a title or a viewport.`);
      }
    } else {
      if (squash(doc.title) === "") report("document", "The page has no title.", null);
      if (options.touch && !doc.querySelector('meta[name="viewport"]')) {
        report("document", 'The page has no <meta name="viewport">, so phones lay it out at desktop width and shrink it.', null);
      }
    }
    const vite = doc.querySelector("vite-error-overlay");
    const next = doc.querySelector("nextjs-portal")?.shadowRoot?.querySelector('[data-nextjs-dialog], [role="dialog"]');
    const webpack = doc.querySelector("#webpack-dev-server-client-overlay");
    const overlay = vite ?? next ?? webpack;
    if (overlay) {
      const text = squash(vite ? (vite.shadowRoot?.querySelector(".message")?.textContent ?? vite.shadowRoot?.textContent) : overlay.textContent);
      report("error-overlay", `The dev server is showing an error over the page${text ? `: ${cut(text, 240)}` : "."}`, null);
    }
  }

  // ---- text to measure contrast for -----------------------------------------------

  const canvas = doc.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const pen = canvas.getContext("2d", { willReadFrequently: true });
  const colors = new Map<string, [number, number, number, number]>();
  const colorOf = (value: string): [number, number, number, number] | null => {
    const known = colors.get(value);
    if (known) return known;
    if (!pen) return null;
    pen.clearRect(0, 0, 1, 1);
    pen.fillStyle = "#000";
    pen.fillStyle = value;
    pen.fillRect(0, 0, 1, 1);
    const data = pen.getImageData(0, 0, 1, 1).data;
    const color: [number, number, number, number] = [data[0]!, data[1]!, data[2]!, data[3]! / 255];
    colors.set(value, color);
    return color;
  };
  const faded = new Map<Element, number>();
  const opacityOf = (el: Element | null): number => {
    if (!el || el === root) return 1;
    let value = faded.get(el);
    if (value === undefined) {
      value = Number(cs(el).opacity) * opacityOf(parentOf(el));
      faded.set(el, value);
    }
    return value;
  };
  /**
   * Whether something else is painted over this piece of text, such as an open
   * menu or a nearly opaque panel, so that what the picture shows there is not
   * this text. Anything fainter lets the text show, and is part of what a
   * reader sees.
   */
  const hiddenUnder = (el: Element, left: number, top: number, right: number, bottom: number): boolean => {
    for (const popup of popups) {
      // A popup counts where it paints: a clear wrapper round a small bar covers nothing.
      if (within(popup, el) || !hasSurface(cs(popup))) continue;
      const box = popup.getBoundingClientRect();
      if (box.left < right && box.right > left && box.top < bottom && box.bottom > top) return true;
    }
    // Hit-testing reaches only what is on the screen, and passes through text that ignores the pointer.
    const y = (top + bottom) / 2;
    if (y < 0 || y >= vh || cs(el).pointerEvents === "none") return false;
    for (const share of [0.2, 0.5, 0.8]) {
      const x = left + (right - left) * share;
      if (x < 0 || x >= vw) continue;
      const hit = topAt(x, y);
      if (!hit || within(el, hit) || within(hit, el)) continue;
      for (let node: Element | null = hit; node && !within(node, el); node = parentOf(node)) {
        // A box paints only inside itself; the hit may be a positioned child that reaches out of it.
        const box = node.getBoundingClientRect();
        if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
        if (alphaOf(cs(node).backgroundColor) * opacityOf(node) >= 0.9) return true;
      }
    }
    return false;
  };
  const texts: TextSample[] = [];
  const sampled = new Set<Element>();
  const offsetX = window.scrollX;
  const offsetY = window.scrollY;
  // The full picture paints a layer that does not scroll where it is at the current scroll offset, and
  // there it can lie over text scrolled out of sight, which it never covers on the screen.
  const pinned = all.filter((el) => cs(el).position === "fixed" && visible(el)).map((el) => ({ el, box: el.getBoundingClientRect() }));
  for (const run of runs) {
    if (texts.length >= 2500) break;
    if (sampled.has(run.el) || !subject(run.el) || inPicture(run.el) || !/[\p{L}\p{N}]/u.test(run.text)) continue;
    sampled.add(run.el);
    if (run.el.closest(':disabled, [aria-disabled="true"]')) continue;
    const style = cs(run.el);
    if (style.backgroundClip === "text" || style.getPropertyValue("-webkit-background-clip") === "text") continue;
    if (style.mixBlendMode !== "normal" || style.textShadow !== "none") continue;
    const color = colorOf(style.getPropertyValue("-webkit-text-fill-color") || style.color);
    if (!color) continue;
    const clip = clipWithin(run.el);
    const rect = run.rects[0]!;
    // Only the part that can be seen: a line scrolled out of its frame is not painted at all.
    const left = Math.max(rect.left, clip.l, clip.vl);
    const top = Math.max(rect.top, clip.t, clip.vt);
    const right = Math.min(rect.right, clip.r, clip.vr);
    const bottom = Math.min(rect.bottom, clip.b, clip.vb);
    if (right - left < 3 || bottom - top < 3 || hiddenUnder(run.el, left, top, right, bottom)) continue;
    const offScreen = top < 0 || bottom > vh || left < 0 || right > vw;
    if (offScreen && pinned.some(({ el, box }) => !within(el, run.el) && box.left < right && box.right > left && box.top < bottom && box.bottom > top)) continue;
    texts.push({
      where: describe(run.el),
      text: cut(run.text, 40),
      box: { x: left + offsetX, y: top + offsetY, width: right - left, height: bottom - top },
      color: [color[0], color[1], color[2], color[3] * opacityOf(run.el)],
      size: parseFloat(style.fontSize),
      weight: Number(style.fontWeight) || 400,
    });
  }

  // ---- what to compare between two looks, and the sketch of the layout ----------------

  const boxes: Box[] = [];
  const keys = new Map<string, number>();
  const addBox = (kind: string, name: string, el: Element) => {
    if (boxes.length >= 800) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const base = name ? `${kind} "${cut(name, 40)}"` : kind;
    const count = (keys.get(base) ?? 0) + 1;
    keys.set(base, count);
    boxes.push({
      key: count === 1 ? base : `${base} #${count}`,
      x: Math.round(rect.left + offsetX),
      y: Math.round(rect.top + offsetY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  };
  const LANDMARKS = 'header, nav, main, aside, footer, section, article, form, dialog, [role="banner"], [role="navigation"], [role="main"], [role="complementary"], [role="contentinfo"], [role="region"], [role="dialog"], [role="search"]';
  const headingIn = (el: Element) => squash(el.getAttribute("aria-label")) || squash(el.querySelector("h1, h2, h3, h4, h5, h6")?.textContent);
  const blocks = new Set<Element>();
  for (const el of all) {
    if (!visible(el) || forReadersOnly(el) || (scope && !within(scope, el))) continue;
    if (el.matches(LANDMARKS)) addBox(el.localName, headingIn(el), el);
    else if (/^h[1-6]$/.test(el.localName)) addBox(el.localName, squash(el.textContent), el);
    else if (el.matches(CONTROLS)) addBox(el.getAttribute("role") ?? (el.localName === "a" ? "link" : el.localName), nameOf(el), el);
    else if (el instanceof HTMLImageElement) addBox("img", squash(el.alt) || short(el.currentSrc || el.src), el);
  }
  for (const run of runs) {
    let block: Element | null = run.el;
    while (block && block !== body && cs(block).display === "inline") block = parentOf(block);
    if (!block || block === body || blocks.has(block) || (scope && !within(scope, block))) continue;
    if (/^h[1-6]$/.test(block.localName) || block.matches(CONTROLS) || block.closest(CONTROLS)) continue;
    blocks.add(block);
    addBox("text", squash(block.textContent), block);
  }

  const arrangement = (el: Element): string => {
    let best: Element[] = [];
    let holder = el;
    const queue: Array<{ node: Element; depth: number }> = [{ node: el, depth: 0 }];
    for (let seenCount = 0; queue.length > 0 && seenCount < 150; seenCount++) {
      const { node, depth } = queue.shift()!;
      const children = Array.from(node.children).filter((child) => {
        if (!visible(child)) return false;
        const position = cs(child).position;
        return position !== "absolute" && position !== "fixed" && child.getBoundingClientRect().height >= 16;
      });
      if (children.length >= 3 && children.length > best.length) {
        const tags = new Set(children.map((child) => child.localName));
        if (tags.size <= 2) {
          best = children;
          holder = node;
        }
      }
      if (depth < 4) for (const child of children) if (!child.matches(LANDMARKS) || depth === 0) queue.push({ node: child, depth: depth + 1 });
    }
    if (best.length < 3) return "";
    const firstTop = best[0]!.getBoundingClientRect().top;
    const across = best.filter((child) => Math.abs(child.getBoundingClientRect().top - firstTop) < 8).length;
    const items = `${best.length} items${holder === el ? "" : ` in ${tagOf(holder)}`}`;
    return across <= 1 ? `${items} stacked` : `${items}, ${across} across`;
  };
  let regions: Region[] = [];
  const chosen: Element[] = [];
  for (const el of all) {
    if (!el.matches(LANDMARKS) || !visible(el) || forReadersOnly(el) || (scope && !within(scope, el))) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width * rect.height < 2000) continue;
    const depth = chosen.filter((other) => within(other, el)).length;
    chosen.push(el);
    const position = cs(el).position;
    const name = headingIn(el);
    const notesHere = [position === "sticky" || position === "fixed" ? position : "", arrangement(el)].filter(Boolean).join(", ");
    regions.push({
      depth,
      label: `${tagOf(el)}${name ? ` "${cut(name, 36)}"` : ""}`,
      x: Math.round(rect.left + offsetX),
      y: Math.round(rect.top + offsetY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      note: notesHere,
    });
  }
  for (const deepest of [3, 2, 1]) {
    if (regions.length <= 24) break;
    regions = regions.filter((region) => region.depth < deepest);
  }
  regions = regions.slice(0, 24);

  return {
    title: doc.title,
    page: { width: Math.max(pageWidth, vw), height: Math.max(root.scrollHeight, body.scrollHeight, vh) },
    viewport: { width: vw, height: vh },
    scroll: { left: offsetX, top: offsetY },
    findings,
    texts,
    boxes,
    regions,
    notes,
  };
}
