import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
test("an agent discovers a journey without loading the app and replays its fixture once", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ra-journey-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "ra.config.ts"), 'throw Error("map discovery ran the app")');
  const journey = {
    title: "Move a meeting", start: "Example week", cwd: "tests", sources: ["tests/replay.mjs"],
    run: [process.execPath, "replay.mjs", "Tuesday at 10"],
    steps: [{ action: "Choose Tuesday", expect: "Meeting at 10", image: "week.png" }],
  };
  const script = join(root, "tests/replay.mjs");
  writeFileSync(script, 'import {writeFileSync} from "node:fs"; if(process.argv[2]!=="Tuesday at 10")process.exit(4); writeFileSync(process.env.RA_WALK_DIR+"/week.png","example bytes");');
  const map = { version: 1, journeys: { move: journey } };
  const file = join(root, "ra.journeys.json");
  writeFileSync(file, JSON.stringify(map));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args, "--json"], { cwd: join(root, "tests"), encoding: "utf8" });
  assert.deepEqual(JSON.parse(run("map").stdout), map);
  assert.ok(!existsSync(join(root, ".ra")));
  assert.equal(run("walk", "missing").status, 2);
  const first = run("walk", "move");
  assert.equal(first.status, 0, first.stderr);
  const receipt = JSON.parse(first.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(root, receipt.directory, "walk.json"), "utf8")), receipt);
  assert.equal(receipt.passed, true);

  writeFileSync(script, 'console.log("no image in this run")');
  const missing = run("walk", "move");
  assert.equal(missing.status, 1);
  assert.match(JSON.parse(missing.stdout).error, /week.png/);
  const second = JSON.parse(missing.stdout);
  assert.notEqual(second.directory, receipt.directory);
  assert.match(readFileSync(join(root, second.directory, "replay.log"), "utf8"), /no image in this run/);
  writeFileSync(script, 'process.exit(7)');
  assert.match(JSON.parse(run("walk", "move").stdout).error, /exit 7/);

  journey.sources[0] = "missing.mjs";
  writeFileSync(file, JSON.stringify(map));
  assert.equal(run("map").status, 2);
});
