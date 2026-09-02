# SACHET CORS Proxy — Cloudflare Worker

Serverless replacement for `../sachet-proxy.js`. The hosted dashboard calls
this Worker instead of running a Node proxy on `localhost:3001`.

## Deploy (free, no credit card)

```bash
cd SIH_HAZARD_MANAGEMENT/sachet-worker
npx wrangler login          # opens browser once
npx wrangler deploy
```

First time, wrangler asks: **"Would you like to register a workers.dev
subdomain now?"** → answer **Y**, pick a short name (e.g. `vyom`).

⚠ **Wait for the deploy to actually finish.** The LAST line it prints is the
live URL — use *that exact one*, not a guess:

```
Deployed sachet-proxy triggers (0.34 sec)
  https://sachet-proxy.<whatever-subdomain-it-shows>.workers.dev
```

If `resqnet` (or whatever you typed) was taken, wrangler assigns a different
subdomain — so the URL may not be `sachet-proxy.resqnet.workers.dev`.

Put the **exact** URL in `../config.js`:

```js
RESQNET_SACHET_PROXY: "https://sachet-proxy.<that-subdomain>.workers.dev",
```

then `firebase deploy --only hosting`.

## Verify (do this before touching config.js)

1. Open in a browser: `https://sachet-proxy.<sub>.workers.dev/health`
   → must show `{"ok":true,"proxy":"SACHET Cloudflare Worker"}`.
   *TLS error / "can't reach" / 404 here = the worker isn't deployed at that
   URL. Re-run `npx wrangler deploy` and copy the printed URL.*
2. Then: `https://sachet-proxy.<sub>.workers.dev/cap_public_website/rss/rss_india.xml`
   → RSS XML, `access-control-allow-origin: *`, header `X-Upstream-Status: 200`.
   *If you get `X-Upstream-Status: 403/5xx`, SACHET is blocking Cloudflare's IP
   from your region — rare; retry later or run the local `node sachet-proxy.js`.*

You can also check https://dash.cloudflare.com → Workers & Pages → `sachet-proxy`
→ it shows the exact `*.workers.dev` route.

## What it does

- Forwards only the three SACHET CAP paths (`rss_india.xml`, `FetchXMLFile`,
  `FetchPolygonXMLFile`) to `https://sachet.ndma.gov.in`.
- Sends the `Origin` / `Referer` / `User-Agent` headers SACHET requires.
- Adds `Access-Control-Allow-Origin: *` and a ~120s edge cache.

`script.js` tries this Worker first, then the local Node proxy, then public
CORS proxies (see `fetchSachetUrl`).
