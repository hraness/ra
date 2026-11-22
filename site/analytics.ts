import { createAnalytics } from "@hraness/analytics/browser";

if (location.pathname.startsWith("/ra/")) {
  createAnalytics({
    token: "phc_xqEpQgmKxZDYda3DvForfnKDuVL6urqD2YTtqDPmUL4u",
    hosts: ["hraness.github.io"],
    siteId: "ra",
    preset: "traffic",
    apiHost: "https://us.i.posthog.com",
    regionUrl: false,
    clean: { allowProps: [] },
  });
}
