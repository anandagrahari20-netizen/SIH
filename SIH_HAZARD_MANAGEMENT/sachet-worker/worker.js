/**
 * SACHET NDMA CORS Proxy — Cloudflare Worker
 * ------------------------------------------------------------
 * Serverless replacement for sachet-proxy.js so the hosted
 * dashboard no longer needs `node sachet-proxy.js` on localhost.
 *
 * sachet.ndma.gov.in blocks generic third-party CORS proxies and
 * requires specific Origin / Referer headers on FetchPolygonXMLFile,
 * so we forward with those headers and add permissive CORS.
 *
 * Deploy:  cd sachet-worker && npx wrangler deploy
 * Then put the printed URL in ../config.js -> RESQNET_SACHET_PROXY
 */

const SACHET_ORIGIN = "https://sachet.ndma.gov.in";

const ALLOWED_PREFIXES = [
  "/cap_public_website/rss/rss_india.xml",
  "/cap_public_website/FetchXMLFile",
  "/cap_public_website/FetchPolygonXMLFile",
];

const CACHE_TTL_SECONDS = 120;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const UPSTREAM_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,hi;q=0.8",
  Referer: "https://sachet.ndma.gov.in/cap_public_website/AlertView.html",
  Origin: "https://sachet.ndma.gov.in",
};

function isAllowed(pathname) {
  return ALLOWED_PREFIXES.some((p) => pathname.startsWith(p));
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
    }

    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(
        JSON.stringify({ ok: true, proxy: "SACHET Cloudflare Worker" }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    if (!isAllowed(url.pathname)) {
      return new Response("Forbidden path", { status: 403, headers: CORS_HEADERS });
    }

    const targetUrl = SACHET_ORIGIN + url.pathname + url.search;
    const cache = caches.default;
    const cacheKey = new Request(targetUrl, { method: "GET" });

    let cached = await cache.match(cacheKey);
    if (cached) {
      const out = new Response(cached.body, cached);
      for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
      out.headers.set("X-Cache", "HIT");
      return out;
    }

    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        method: "GET",
        headers: UPSTREAM_HEADERS,
        cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
      });
    } catch (err) {
      return new Response("Bad Gateway (upstream fetch failed): " + err.message, {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "text/plain" },
      });
    }

    const body = await upstream.arrayBuffer();
    const headers = new Headers(CORS_HEADERS);
    headers.set(
      "Content-Type",
      upstream.headers.get("content-type") || "application/xml"
    );
    headers.set("Cache-Control", `public, max-age=${CACHE_TTL_SECONDS}`);
    headers.set("X-Cache", "MISS");
    headers.set("X-Upstream-Status", String(upstream.status));

    // Always pass the upstream body through (even on 4xx/5xx) so the
    // client can see what SACHET actually said.
    const response = new Response(body, { status: upstream.status, headers });

    if (upstream.status === 200 && body.byteLength > 0) {
      try {
        await cache.put(
          cacheKey,
          new Response(body, {
            status: 200,
            headers: {
              "Content-Type": headers.get("Content-Type"),
              "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
            },
          })
        );
      } catch (_) {
        /* edge cache write is best-effort — never fail the request over it */
      }
    }

    return response;
  },
};
