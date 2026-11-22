import { arrivalOf, channelOf, referrerHost } from "@hraness/analytics/attribution";

const host = "hraness.github.io";
const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
const privacy = navigator as Navigator & { globalPrivacyControl?: boolean };
if (location.origin === `https://${host}` && canonical?.startsWith(`https://${host}/ra/`) &&
    !privacy.globalPrivacyControl && navigator.doNotTrack !== "1" &&
    !navigator.webdriver && typeof globalThis.crypto?.randomUUID === "function") {
  const path = new URL(canonical).pathname;
  const arrival = arrivalOf(path, location.search, document.referrer);
  const referrer = referrerHost(arrival.referrer);
  const { channel } = channelOf(arrival.referrer, arrival.search, { ownHosts: [host] });
  void fetch("https://us.i.posthog.com/i/v0/e/", {
    method: "POST",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: "phc_xqEpQgmKxZDYda3DvForfnKDuVL6urqD2YTtqDPmUL4u",
      event: "$pageview",
      properties: {
        distinct_id: crypto.randomUUID(),
        $process_person_profile: false,
        $geoip_disable: true,
        $host: host,
        $pathname: arrival.path,
        $current_url: `https://${host}${arrival.path}`,
        ...(referrer && referrer !== host ? { $referrer: arrival.referrer, $referring_domain: referrer } : {}),
        ...(channel === "paid" ? { utm_medium: "cpc" } : {}),
        channel,
        site_id: "ra",
        consent_mode: "cookieless",
      },
    }),
  }).catch(() => {});
}
