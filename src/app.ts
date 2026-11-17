/**
 * Getting the app to answer on a loopback address: run its command, serve its
 * built files, or use one that is already running.
 */
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createSocket, type AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import type { AppSpec } from "./config.ts";

/** The app could not be started or reached. */
export class AppError extends Error {
  override name = "AppError";
}

export interface RunningApp {
  /** Where the app answers, without a trailing slash. */
  origin: string;
  /** Whether ra started it, and so stops it. */
  owned: boolean;
  stop(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
};

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const socket = createSocket();
    socket.once("error", fail);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address() as AddressInfo;
      socket.close(() => done(port));
    });
  });
}

async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    return response.status < 500;
  } catch {
    return false;
  }
}

/** Serves a directory of built files the way a static host would. */
export async function serveStatic(directory: string): Promise<RunningApp> {
  const root = resolve(directory);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new AppError(`There is no directory at ${root} to serve. Build the app first.`);
  }
  const find = (path: string): string | null => {
    const target = resolve(root, `.${path}`);
    if (target !== root && !target.startsWith(root + sep)) return null;
    for (const candidate of [target, `${target}.html`, join(target, "index.html")]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  const server = createServer((request, response) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url ?? "/", "http://app").pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const file = find(path);
    const missing = file === null ? find("/404") : null;
    const send = file ?? missing;
    if (send === null) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    response.writeHead(file === null ? 404 : 200, {
      "content-type": TYPES[extname(send).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(send).on("error", () => response.destroy()).pipe(response);
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    owned: true,
    stop: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

/** How long the app's processes get to stop after SIGTERM before SIGKILL. */
const GRACE_MS = 8000;

/**
 * Runs in a Node process of its own between ra and the app's command. It
 * starts the command in a new process group and ends that whole group, with
 * SIGTERM and then SIGKILL, when its standard input closes. That happens when
 * ra stops the app, and also when ra dies however it dies, because the system
 * closes the pipe. When the command exits by itself, the rest of its group is
 * ended too, so nothing it left in the background outlives it.
 */
const KEEPER = `
const { spawn } = require("node:child_process");
const env = { ...process.env };
if (env.RA_APP_NODE_OPTIONS === undefined) delete env.NODE_OPTIONS;
else env.NODE_OPTIONS = env.RA_APP_NODE_OPTIONS;
delete env.RA_APP_NODE_OPTIONS;
const child = spawn(process.argv[1], { shell: true, detached: true, env, stdio: ["ignore", "inherit", "inherit"] });
let code = null;
let ending = false;
const group = (signal) => {
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
};
const end = () => {
  if (ending) return;
  ending = true;
  group("SIGTERM");
  const since = Date.now();
  const poll = setInterval(() => {
    if (group(0) && Date.now() - since < ${GRACE_MS}) return;
    group("SIGKILL");
    clearInterval(poll);
    process.exit(code ?? 0);
  }, 50);
};
child.on("exit", (status) => {
  code = status ?? 1;
  end();
});
child.on("error", () => {
  code = 127;
  end();
});
process.stdin.on("end", end);
process.stdin.on("error", end);
process.stdin.resume();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, end);
`;

export interface StartOptions {
  /** The project directory; commands run here and static paths start here. */
  root: string;
  /** The address of each stand-in server, for `{upstream.NAME}`. */
  upstreams?: Record<string, string>;
  /** Use this running app instead of the configured one. */
  url?: string;
  /** Where the app's output goes while it starts. */
  log?: (line: string) => void;
}

/** Starts the app, or finds it running, and waits until it answers. */
export async function startApp(spec: AppSpec | undefined, options: StartOptions): Promise<RunningApp> {
  const given = options.url ?? (spec !== undefined && "url" in spec ? spec.url : undefined);
  if (given !== undefined) {
    let origin: string;
    try {
      origin = new URL(given).origin;
    } catch {
      throw new AppError(`"${given}" is not an address. Use one such as http://127.0.0.1:3000.`);
    }
    if (!(await answers(origin))) throw new AppError(`Nothing answers at ${origin}. Start the app, or check the address.`);
    return { origin, owned: false, stop: async () => undefined };
  }
  if (spec === undefined) {
    throw new AppError('ra does not know how to run the app. Add app to ra.config.ts, such as app: { command: "bun run dev --port {port}" }, or pass --url.');
  }
  if ("static" in spec) return serveStatic(resolve(options.root, spec.static));
  if (!("command" in spec)) throw new AppError("app needs one of command, static or url.");

  const port = await freePort();
  const fill = (text: string) =>
    text.replaceAll("{port}", String(port)).replaceAll(/\{upstream\.([\w-]+)\}/gu, (whole, name: string) => {
      const url = options.upstreams?.[name];
      if (url === undefined) throw new AppError(`${whole} is used, but no upstream named "${name}" is in the world.`);
      return url;
    });
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(port) };
  for (const [key, value] of Object.entries(spec.env ?? {})) env[key] = fill(value);
  const command = fill(spec.command);
  // The keeper is plain Node; the app's NODE_OPTIONS are kept for the app alone.
  const keeperEnv: Record<string, string | undefined> = { ...env, NODE_OPTIONS: undefined, RA_APP_NODE_OPTIONS: env["NODE_OPTIONS"] };
  const child = spawn(process.execPath, ["-e", KEEPER, command], { cwd: options.root, env: keeperEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => undefined);
  let output = "";
  const keep = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    output = (output + text).slice(-6000);
    for (const line of text.split("\n")) if (line.trim() !== "") options.log?.(line);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  let exited: number | null | undefined;
  const gone = new Promise<void>((done) => {
    child.once("exit", (code) => {
      exited = code;
      done();
    });
    child.once("error", (error) => {
      output += `\n${error.message}`;
      exited = -1;
      done();
    });
  });
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      if (exited === undefined) {
        // Closing its input tells the keeper to end the app's group and exit.
        child.stdin.end();
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        }, GRACE_MS + 4000);
        await gone;
        clearTimeout(timer);
      }
      // Something that left the group may still hold the output open.
      child.stdout.destroy();
      child.stderr.destroy();
    })();
    return stopping;
  };

  const ready = spec.ready ?? "/";
  const deadline = Date.now() + (spec.timeout ?? 120) * 1000;
  const tail = () => (output.trim() === "" ? "It printed nothing." : `Its last output:\n${output.trim().split("\n").slice(-15).join("\n")}`);
  for (;;) {
    if (exited !== undefined) {
      await stop();
      throw new AppError(`The app stopped before it answered (${command}). ${tail()}`);
    }
    for (const host of ["127.0.0.1", "localhost"]) {
      if (await answers(`http://${host}:${port}${ready}`)) return { origin: `http://${host}:${port}`, owned: true, stop };
    }
    if (Date.now() > deadline) {
      await stop();
      throw new AppError(`The app did not answer on port ${port} in time (${command}). It must listen on the port it is given. ${tail()}`);
    }
    await new Promise((done) => setTimeout(done, 150));
  }
}
