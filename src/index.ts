/**
 * ra as a library. Most projects only need `defineConfig`; the rest is for
 * scripts that drive a browser themselves and want ra's launch policy, closed
 * world or looks without the command.
 */
export { defineConfig, loadProject, readConfig, resolveView, ConfigError } from "./config.ts";
export type {
  Accept,
  AppSpec,
  Call,
  Config,
  Project,
  Reached,
  Replier,
  Replies,
  Reply,
  RequestInfo,
  State,
  StateSpec,
  View,
  ViewSpec,
  World,
} from "./config.ts";

export { openBrowser, BrowserPolicyError, REQUIRED_DISABLED_FEATURES } from "./browser.ts";
export type { BrowserReceipt, OpenBrowserOptions, OwnedBrowser } from "./browser.ts";

export { closeWorld, closedWorldSwitches, judge, reachableHosts, ruleProblem, startUpstreams } from "./world.ts";
export type { JudgeOptions, Upstreams, Verdict, WorldOptions } from "./world.ts";

export { startApp, serveStatic, AppError } from "./app.ts";
export type { RunningApp } from "./app.ts";

export { closeSessions, openSession } from "./run.ts";
export type { Job, LookOptions, Session, SessionOptions } from "./run.ts";

export { observe } from "./observe.ts";
export type { Finding, Observation, ObserveOptions } from "./observe.ts";

export { inspectPage } from "./inspect.ts";
export type { Box, InspectOptions, Inspection, PageFinding, Region } from "./inspect.ts";

export { compareLooks } from "./diff.ts";
export type { Change } from "./diff.ts";
