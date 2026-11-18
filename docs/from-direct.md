# From Direct to ra

[Direct](https://github.com/hraness/direct) gave each state of an app its own URL, with the real interface running on fixture data behind a port the app owned. A browser agent could open the signed-in, empty or mid-error state and get the same page every time. It reached version 0.7.29 and has since been retired.

ra keeps Direct's core idea and drops nearly everything built around it. This page records the judgement, so that the next tool does not grow back what was cut.

## What Direct got right

- **The real interface.** It used no component sandbox and no screenshots of a design file. The app's own code rendered its own pages.
- **A fixture world.** It replaced only what lies outside the app, so a state is reproducible.
- **States you open by URL.** Hard-to-reach states (empty, failed, overflowing) became one navigation away.
- **Fail closed.** Its fetch firewall stopped requests the scenario did not expect, so a fixture run could not quietly reach a live system.
- **Stated limits.** Coverage claims said whether a check touched fixtures or the real system, and the docs said that a fixture run does not test what the fixtures replace.

ra keeps all five.

## What it got wrong

**Adoption was a project.** An app had to route its external calls through a port, write adapters for it and ship a second, development-only build. That design is good architecture in the abstract, but it is a lot to ask before the first useful look. Direct had one consuming app, and the retired repository gives no other reason for stopping.

**It stopped short of the answer.** Direct served the state and a readiness probe. The verifier was left to the consumer: what to look at, what counts as wrong, and how to say it. Its one consumer still wrote roughly a thousand lines of its own verification on top. Every product that adopted it would have written its own again.

**It was general in the wrong places.** It carried 18,445 lines of source and 15,786 lines of tests, an Effect runtime, property-based exploration and a versioned in-page API. All of that served flexibility that one consumer never used.

**Its output was evidence, not feedback.** Coverage claims and archived evidence suit an audit. An agent in the middle of an edit loop needs one sentence instead: "the Subscribe button is cut off on the right by its own box at 390px".

## What ra does instead

| Direct | ra |
| --- | --- |
| An app-owned port, adapters and a second build | Nothing in the app. The world is faked at the network edge: browser requests are routed, and server-side calls go to loopback stand-ins whose addresses the app gets from its start command. |
| A scenario registry inside the app | `states` in `ra.config.ts`, each a URL plus a world. |
| `window.__direct` readiness probe | ra waits for the page to go quiet, plus an optional `ready` selector. |
| A verifier per consumer | Built-in findings: layout, contrast measured from pixels, covered and small targets, names, images, console, requests, the world. |
| Coverage claims and evidence archives | Sentences, an outline, a layout sketch and picture paths. `--json` when a tool wants data. |
| A fetch firewall inside the page | Context-level routing. Beneath it, a proxy that refuses whatever routing never sees, such as redirect hops, IP addresses and WebRTC, and `ra doctor` to prove it holds. It also holds against deployments. |
| Any browser tool | One provisioned Chromium, launched one way, verified over CDP, with a receipt. |

ra is about 5,000 lines.

## What ra gives up

- **Setup that is not HTTP.** Direct's port could fake device permissions or native modules. ra fakes what crosses the network, plus storage, cookies and the clock. If a state depends on something else, the app has to offer a browser-reachable way to set it, or the state has to reach it with `steps`.
- **Arbitrary browser tools.** Direct served pages to whatever drove the browser. ra drives Chromium itself, so that it can say what is wrong. Other tools can still open the same URLs with `ra look --then`, or with the library exports.
- **Coverage as a ledger.** ra does not keep a record of what was exercised. `ra check` passes or fails on what is wrong now. Bookkeeping about tests is not the same as knowing the interface works.
