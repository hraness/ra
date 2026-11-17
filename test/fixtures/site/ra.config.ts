import { defineConfig } from "../../../src/index.ts";

export default defineConfig({
  app: { static: "." },
  views: ["desktop", "phone", "phone.dark"],
  states: {
    home: { url: "/", note: "The control: nothing is wrong here." },
    tricky: { url: "/tricky", note: "Deliberate clipping, scrolling and hiding that must not be reported." },
    broken: { url: "/broken", note: "One of every problem." },
    untitled: { url: "/untitled", views: ["phone"] },
    // The world answers 503 on purpose: the error state is the subject, not a finding.
    outage: {
      url: "/outage",
      views: ["desktop"],
      world: { replies: { "GET /api/status": { status: 503, json: { error: "down" } } } },
      see: ["Something went wrong"],
    },
    // A reply that throws is a broken world, and is reported.
    faulty: {
      url: "/outage",
      views: ["desktop"],
      world: {
        replies: {
          "GET /api/status": () => {
            throw new Error("no answer written for this");
          },
        },
      },
    },
    // example.com is real and reachable. If the closed world leaked, this look
    // would load it; it must end in a failed load instead.
    leave: {
      url: "/leave",
      note: "A redirect to a real outside site, which must never be reached.",
      views: ["desktop"],
      world: { replies: { "GET /leave": { status: 302, headers: { location: "https://example.com/" } } } },
    },
  },
});
