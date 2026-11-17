/**
 * The one place that starts a browser.
 *
 * ra only drives the Chromium that the project's own pinned Playwright
 * installed. It refuses an installed, auto-updating Chrome, launches with one
 * merged `--disable-features` switch, checks the command line the browser is
 * really running with, and hands back a receipt.
 */
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Browser, BrowserType } from "playwright-core";

/** Features every owned launch turns off, on top of Playwright's own list. */
export const REQUIRED_DISABLED_FEATURES: readonly string[] = ["PaintHolding", "MacAppCodeSignClone"];

const FEATURES = "--disable-features=";
const REVISION = /[/\\]((?:chromium|chromium_headless_shell|chrome-headless-shell)-\d+)[/\\]/u;

/** The browser could not be started the way the policy requires. */
export class BrowserPolicyError extends Error {
  override name = "BrowserPolicyError";
}

export interface BrowserReceipt {
  /** The executable that ran, with symlinks resolved. */
  executable: string;
  /** The running browser's own version. */
  version: string;
  /** The playwright-core version that provisioned it. */
  playwright: string;
  /** Every feature named by the single `--disable-features` switch. */
  disabledFeatures: string[];
  muted: true;
}

export interface OwnedBrowser {
  browser: Browser;
  receipt: BrowserReceipt;
  /** Closes every context, then the browser. Safe to call twice. */
  close(): Promise<void>;
}

export interface OpenBrowserOptions {
  /** A directory inside the project whose Playwright pin picks the browser. Defaults to the working directory. */
  from?: string;
  /** Extra Chromium switches. `--disable-features=` values are merged into the one switch. */
  args?: readonly string[];
  /** Milliseconds to wait for the browser to start. */
  timeout?: number;
}

export interface Playwright {
  chromium: BrowserType;
  version: string;
  /** The playwright-core package directory. */
  root: string;
}

/** Finds playwright-core's manifest from a directory: directly, or as part of `playwright` or `@playwright/test`. */
function findCore(base: string): string | null {
  const from = (directory: string) => createRequire(join(directory, "ra-resolve.cjs"));
  const attempt = (directory: string, name: string): string | null => {
    try {
      return from(directory).resolve(`${name}/package.json`);
    } catch {
      return null;
    }
  };
  const direct = attempt(base, "playwright-core");
  if (direct !== null) return direct;
  const test = attempt(base, "@playwright/test");
  const full = attempt(base, "playwright") ?? (test === null ? null : attempt(dirname(test), "playwright"));
  for (const manifest of [full, test]) {
    const core = manifest === null ? null : attempt(dirname(manifest), "playwright-core");
    if (core !== null) return core;
  }
  return null;
}

/**
 * Loads the project's own Playwright, so the browser that runs is the one the
 * project pinned. Falls back to a copy installed next to ra.
 */
export function loadPlaywright(from: string = process.cwd()): Playwright {
  for (const base of [from, import.meta.dirname]) {
    const manifest = findCore(base);
    if (manifest === null) continue;
    const version = (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
    const { chromium } = createRequire(manifest)(dirname(manifest)) as { chromium: BrowserType };
    return { chromium, version, root: dirname(manifest) };
  }
  throw new BrowserPolicyError(
    "No Playwright is installed in this project. Add playwright-core (bun add -d playwright-core), then install its browser (bunx --no-install playwright-core install chromium).",
  );
}

/** Throws when a path points into an installed Google Chrome. */
export function rejectInstalledChrome(path: string): void {
  const normal = path.replaceAll("\\", "/").toLowerCase();
  if (
    /\/google chrome(?: beta| dev| canary)?\.app\//u.test(normal)
    || /\/opt\/google\/chrome(?:-beta|-unstable)?\//u.test(normal)
    || /\/google\/chrome(?: beta| dev| sxs)?\/application\//u.test(normal)
  ) {
    throw new BrowserPolicyError(`Refusing the installed Google Chrome at ${path}. ra only runs the browser Playwright provisioned.`);
  }
}

/**
 * Resolves the provisioned executable before anything is launched: follows
 * symlinks, refuses an installed Chrome at either end, and requires the
 * resolved file to still sit in Playwright's versioned browser directory.
 */
export function resolveExecutable(pinned: string, playwrightVersion = "this project's"): string {
  if (!isAbsolute(pinned)) throw new BrowserPolicyError(`Playwright named a browser path that is not absolute: ${pinned}`);
  rejectInstalledChrome(pinned);
  const revision = REVISION.exec(pinned)?.[1];
  if (revision === undefined) {
    throw new BrowserPolicyError(`Playwright named a browser outside its versioned installation: ${pinned}`);
  }
  if (!existsSync(pinned)) {
    throw new BrowserPolicyError(
      `Chromium for playwright-core ${playwrightVersion} is not installed (looked for ${pinned}). Install it with the project's own Playwright: bunx --no-install playwright-core install chromium`,
    );
  }
  const executable = realpathSync(pinned);
  rejectInstalledChrome(executable);
  if (REVISION.exec(executable)?.[1] !== revision) {
    throw new BrowserPolicyError(`The provisioned browser resolves outside its pinned revision ${revision}: ${executable}`);
  }
  if (!statSync(executable).isFile()) throw new BrowserPolicyError(`The provisioned browser is not a regular file: ${executable}`);
  accessSync(executable, constants.X_OK);
  return executable;
}

export interface LaunchPlan {
  /** Playwright default switches to drop because the merged one replaces them. */
  ignore: string[];
  /** Switches to add. */
  args: string[];
  /** Every feature the merged switch turns off. */
  features: string[];
}

/**
 * Chromium honours one `--disable-features` switch, so Playwright's own list,
 * the caller's and the required names become a single value.
 */
export function planLaunch(defaults: readonly string[], extra: readonly string[] = []): LaunchPlan {
  if (extra.includes("--disable-features")) {
    throw new BrowserPolicyError("Write --disable-features=Name,Other as one argument.");
  }
  const split = (args: readonly string[]) =>
    args
      .filter((arg) => arg.startsWith(FEATURES))
      .flatMap((arg) => arg.slice(FEATURES.length).split(","))
      .map((name) => name.trim())
      .filter(Boolean);
  const defaultSwitches = defaults.filter((arg) => arg.startsWith(FEATURES));
  const features = [...new Set([...split(defaults), ...split(extra), ...REQUIRED_DISABLED_FEATURES])];
  const enabled = [...defaults, ...extra]
    .filter((arg) => arg.startsWith("--enable-features="))
    .flatMap((arg) => arg.slice("--enable-features=".length).split(","));
  const conflict = REQUIRED_DISABLED_FEATURES.find((name) => enabled.includes(name));
  if (conflict !== undefined) throw new BrowserPolicyError(`${conflict} must stay disabled; remove it from --enable-features.`);
  const merged = FEATURES + features.join(",");
  const unchanged = defaultSwitches.length === 1 && defaultSwitches[0] === merged;
  const has = (flag: string) => defaults.includes(flag);
  return {
    ignore: unchanged ? [] : defaultSwitches,
    args: [
      ...extra.filter((arg) => !arg.startsWith(FEATURES) && arg !== "--mute-audio" && arg !== "--enable-automation"),
      ...(has("--mute-audio") ? [] : ["--mute-audio"]),
      // Chromium only reports its command line to an automation client.
      ...(has("--enable-automation") ? [] : ["--enable-automation"]),
      ...(unchanged ? [] : [merged]),
    ],
    features,
  };
}

/**
 * Says what is wrong with a running browser's command line. Empty when it
 * follows the policy and carries every switch in `expected`.
 */
export function checkCommandLine(argv: readonly string[], executable: string, features: readonly string[], expected: readonly string[] = []): string[] {
  const problems: string[] = [];
  const running = argv[0];
  let resolved = running;
  try {
    if (running !== undefined) resolved = realpathSync(running);
  } catch {
    // Reported below as a mismatch.
  }
  if (resolved !== executable) problems.push(`The browser is running ${String(running)}, not the resolved ${executable}.`);
  const switches = argv.filter((arg) => arg.startsWith(FEATURES));
  if (switches.length !== 1) {
    problems.push(`Expected one --disable-features switch and found ${switches.length}.`);
  } else {
    const names = new Set(switches[0]!.slice(FEATURES.length).split(","));
    const missing = [...REQUIRED_DISABLED_FEATURES, ...features].filter((name) => !names.has(name));
    if (missing.length > 0) problems.push(`--disable-features is missing ${[...new Set(missing)].join(", ")}.`);
  }
  if (!argv.includes("--mute-audio")) problems.push("The browser is not muted.");
  const absent = expected.filter((arg) => !arg.startsWith(FEATURES) && !argv.includes(arg));
  if (absent.length > 0) problems.push(`The browser is running without ${absent.join(" ")}.`);
  return problems;
}

/**
 * Learns the switches this Playwright version would pass, without starting a
 * browser: Playwright is pointed at a script that writes down its arguments
 * and exits. Hardcoded lists go stale with every Playwright release.
 */
export async function defaultArguments(playwright: Playwright, options: { fresh?: boolean } = {}): Promise<string[]> {
  const cacheFile = join(playwright.root, "..", ".cache", "ra", `chromium-arguments-${playwright.version}.json`);
  if (options.fresh !== true) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as unknown;
      if (Array.isArray(cached) && cached.every((arg) => typeof arg === "string")) return cached as string[];
    } catch {
      // No cache yet.
    }
  }
  const directory = mkdtempSync(join(tmpdir(), "ra-arguments-"));
  try {
    const script = join(directory, "write-arguments");
    const output = join(directory, "arguments");
    writeFileSync(script, '#!/bin/sh\nfor argument in "$@"; do printf \'%s\\n\' "$argument"; done > "$RA_ARGUMENTS"\n');
    chmodSync(script, 0o700);
    try {
      const browser = await playwright.chromium.launch({
        executablePath: script,
        headless: true,
        ...OWN_SIGNALS,
        timeout: 10_000,
        env: { ...(process.env as Record<string, string>), RA_ARGUMENTS: output },
      });
      await browser.close();
    } catch {
      // Expected: the script is not a browser. Its arguments are what we came for.
    }
    if (!existsSync(output)) throw new BrowserPolicyError("Could not read the arguments Playwright passes to Chromium.");
    const profile = /^--user-data-dir=/u;
    const defaults = readFileSync(output, "utf8").split("\n").filter((arg) => arg.startsWith("--") && !profile.test(arg));
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(defaults));
    } catch {
      // A read-only install just asks again next time.
    }
    return defaults;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Playwright would otherwise close its browsers and exit on Ctrl-C by itself,
 * before ra has stopped the app. ra handles these signals and closes
 * everything in order.
 */
const OWN_SIGNALS = { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false } as const;

async function commandLine(browser: Browser): Promise<string[]> {
  const session = await browser.newBrowserCDPSession();
  try {
    const result = (await session.send("Browser.getBrowserCommandLine" as never)) as { arguments: string[] };
    return result.arguments;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** Starts the project's provisioned Chromium, headless, and proves it follows the launch policy. */
export async function openBrowser(options: OpenBrowserOptions = {}): Promise<OwnedBrowser> {
  if (process.platform === "win32") throw new BrowserPolicyError("ra starts browsers on macOS and Linux only.");
  const playwright = loadPlaywright(options.from);
  const executable = resolveExecutable(playwright.chromium.executablePath(), playwright.version);
  let problems: string[] = [];
  // A cached argument list can be stale; the check below notices, and the second pass asks again.
  for (const fresh of [false, true]) {
    const plan = planLaunch(await defaultArguments(playwright, { fresh }), options.args);
    const browser = await playwright.chromium.launch({
      executablePath: executable,
      headless: true,
      ...OWN_SIGNALS,
      ignoreDefaultArgs: plan.ignore,
      args: plan.args,
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    });
    try {
      const argv = await commandLine(browser);
      problems = checkCommandLine(argv, executable, plan.features, options.args);
      if (problems.length === 0) {
        const names = argv.find((arg) => arg.startsWith(FEATURES))!.slice(FEATURES.length).split(",");
        let closed: Promise<void> | undefined;
        return {
          browser,
          receipt: { executable, version: browser.version(), playwright: playwright.version, disabledFeatures: names, muted: true },
          close() {
            closed ??= (async () => {
              for (const context of browser.contexts()) await context.close().catch(() => undefined);
              await browser.close();
            })();
            return closed;
          },
        };
      }
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
    await browser.close();
  }
  throw new BrowserPolicyError(`The browser did not start the way the policy requires. ${problems.join(" ")}`);
}
