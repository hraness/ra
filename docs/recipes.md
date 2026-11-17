# Recipes

ra works the same way for every kind of app: it reaches the app, names states, closes the world and looks. What changes from one kind to the next is how the app is started and where its outside world lives.

## Choosing states and views

Name a state for each **visual risk**, not for each route. Three to five states per screen that matters usually covers it:

- **typical**: realistic data.
- **empty**: no items yet, a new account.
- **overflowing**: long names, many items, long words, large numbers.
- **failed**: an upstream returns an error, or something times out.
- **edge of time or place**: a date near midnight, a different locale, a different `clock`.

Leave out what a unit test already proves, and states nobody will ever see.

For views, use `desktop` and `phone` always. Add `phone.dark` when the app has a dark theme, since dark mode is where contrast breaks. Add `narrow` (320px) when layouts are tight. `tablet` is rarely worth its time.

A look takes about one to four seconds, and four run at once. Thirty states through three views is about a minute.

## A static site

Marketing sites, documentation and landing pages.

```ts
export default defineConfig({
  app: { static: "dist" },
  views: ["desktop", "phone", "phone.dark", "narrow"],
  world: {
    allow: ["fonts.googleapis.com", "fonts.gstatic.com"],
    block: ["*.plausible.io", "*.googletagmanager.com"],
  },
  states: {
    home: "/",
    pricing: "/pricing",
    docs: "/docs/getting-started",
    "not-found": { url: "/no-such-page", status: 404 },
  },
});
```

Build, then `ra check`. These states need no world of their own, so the same config can check the deployment once it is live:

```sh
ra check --url https://example.com
```

The outside world stays closed against a deployment too. A third-party script that the page depends on has to be in `allow` (or passed with `--allow`), and that is how you learn what the page depends on.

## A browser app with an API

A single-page app, or any page that fetches from the browser.

```ts
export default defineConfig({
  app: { command: "bun run dev --port {port}", ready: "/" },
  views: ["desktop", "phone", "phone.dark"],
  world: {
    replies: {
      "GET /api/me": { json: { id: 1, name: "Ada Lovelace", plan: "pro" } },
      "GET /api/projects": { json: [{ id: 1, name: "Analytical Engine", updated: "2026-01-02T10:00:00Z" }] },
    },
  },
  states: {
    projects: "/projects",
    "projects-empty": { url: "/projects", world: { replies: { "GET /api/projects": { json: [] } } } },
    "projects-many": {
      url: "/projects",
      world: {
        replies: {
          "GET /api/projects": { json: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `Project ${i} with a name long enough to wrap twice`, updated: "2026-01-02T10:00:00Z" })) },
        },
      },
    },
    "projects-down": {
      url: "/projects",
      world: { replies: { "GET /api/projects": { status: 503, json: { error: "unavailable" } } } },
      see: ["Try again"],
    },
    "signed-out": { url: "/projects", world: { replies: { "GET /api/me": { status: 401, json: {} } } }, see: ["Sign in"] },
  },
});
```

A reply can be a function of the request, for an API whose answer depends on what was sent:

```ts
"POST /api/search": ({ body }) => ({ json: { results: JSON.parse(body ?? "{}").q === "" ? [] : results } }),
```

An error the world is told to give, such as the 503 above, is the state itself, not a finding. A page that falls over because of it is a finding.

## A server-rendered app whose server calls other services

Next.js server components, Remix loaders, Rails or Django views. The browser never sees these calls, so routing cannot fake them. Give the server stand-ins instead:

```ts
export default defineConfig({
  app: {
    command: "bun run dev --port {port}",
    env: { CONTENT_API_URL: "{upstream.content}", PAYMENTS_API_URL: "{upstream.payments}" },
  },
  world: {
    upstreams: {
      content: { "GET /articles": { json: articles } },
      payments: { "GET /v1/customer": { json: { status: "active" } } },
    },
  },
  states: {
    front: "/",
    "front-empty": { url: "/", world: { upstreams: { content: { "GET /articles": { json: [] } } } } },
    "billing-lapsed": { url: "/account", world: { upstreams: { payments: { "GET /v1/customer": { json: { status: "past_due" } } } } } },
  },
});
```

Each stand-in is a loopback server whose replies change with the state being looked at. Because of that, looks run one at a time when upstreams are in use. A call the server makes that no reply covers becomes an `outside` finding, so you see every service the page touches.

If the app reads its service addresses from constants rather than from the environment, make them configurable. That is the one change ra may ask of an app, and it is usually a single line.

## An app with its own database

ra does not seed databases. You have three options:

- Point the app at a fixture database in `app.command`, such as `DATABASE_URL=file:./fixtures/demo.db bun run dev --port {port}`, and keep that file small and committed.
- Let the app read the data it shows through a service you can stand in for with `upstreams`.
- Reach the state through the interface with `steps`, when that is quick.

## A large web surface

Apps with hundreds of routes, such as dashboards, settings or content sites:

- Name states for each *template*: one list page, one detail page, one settings form and one empty state each. Add a state for every page that has broken before.
- Use `ra look /any/path` freely while working. Ad hoc paths need no config.
- Keep `ra check` to the 20 to 40 states that carry the risk. If it grows slow, check fewer states before reaching for fewer views.

## A desktop or native app's web surfaces

ra looks at what runs in a browser:

- The product's marketing site and documentation.
- Its web renderer, when that renderer can run in a plain browser with a fallback for its native bridge (`window.__TAURI__`, an Electron preload). That fallback is the app's job, and it is usually worth having anyway.

ra does not look at native interfaces built with SwiftUI, AppKit or UIKit. Use the platform's own tools for those.

## Pages drawn on a canvas

Canvas, WebGL and terminal-like interfaces show little to the outline and the layout checks. ra still takes pictures, checks the page around the canvas, and runs `see` and `expect`. If most of the page is canvas, ra is the wrong tool for it.

## A check after deploying

```sh
ra check --url https://staging.example.com
```

`ra check` skips states that bring their own world or steps, and `ra look` refuses them. Mark one `live: true` if it is safe there.

The deployment answers for itself: no reply rule stands in for it, though `block` still applies to its paths. Outside hosts stay closed unless allowed.

This answers "does the deployment look right?". It does not answer "do the services behind it work?": that is what monitoring is for.
