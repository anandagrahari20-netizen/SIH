/**
 * SACHET NDMA Local CORS Proxy
 * Run: node sachet-proxy.js
 * Then open index.html via Live Server — the proxy will handle SACHET requests.
 * 
 * This is needed because sachet.ndma.gov.in blocks third-party CORS proxies
 * AND requires specific Origin/Referer headers for FetchPolygonXMLFile.
 */

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = 3001;
const SACHET_HOST = 'sachet.ndma.gov.in';
const ALLOWED_PATHS = [
  '/cap_public_website/rss/rss_india.xml',
  '/cap_public_website/FetchXMLFile',
  '/cap_public_website/FetchPolygonXMLFile',
];

// Prevent crashes from unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[proxy] uncaughtException:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[proxy] unhandledRejection:', reason);
});

function isSafeRequest(pathname) {
  return ALLOWED_PATHS.some(p => pathname.startsWith(p));
}

// Simple in-memory cache (key=path, value={body, timestamp})
const cache = new Map();
const CACHE_TTL_MS = 120_000; // 2 minutes

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry;
}

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return; }

  const parsed = url.parse(req.url);
  const pathname = parsed.pathname || '/';

  // Health-check
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, proxy: 'SACHET CORS Proxy', port: PORT, cached: cache.size }));
    return;
  }

  if (!isSafeRequest(pathname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden path');
    return;
  }

  // Check cache first
  const cacheKey = req.url;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[proxy] CACHE HIT ${cacheKey} (${cached.body.length} bytes)`);
    res.writeHead(200, {
      'Content-Type': cached.contentType,
      'Access-Control-Allow-Origin': '*',
      'X-Cache': 'HIT',
    });
    res.end(cached.body);
    return;
  }

  const targetUrl = `https://${SACHET_HOST}${req.url}`;
  console.log(`[proxy] GET ${targetUrl}`);

  const options = {
    hostname: SACHET_HOST,
    port: 443,
    path: req.url,
    method: 'GET',
    headers: {
      'Host': SACHET_HOST,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
      'Referer': 'https://sachet.ndma.gov.in/cap_public_website/AlertView.html',
      'Origin': 'https://sachet.ndma.gov.in',
      'Connection': 'keep-alive',
    },
    timeout: 30000,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    const contentType = proxyRes.headers['content-type'] || 'application/xml';

    // Collect body for caching
    const chunks = [];
    proxyRes.on('data', (chunk) => chunks.push(chunk));
    proxyRes.on('end', () => {
      const body = Buffer.concat(chunks);

      // Cache successful responses
      if (proxyRes.statusCode === 200 && body.length > 0) {
        cache.set(cacheKey, { body, contentType, ts: Date.now() });
        console.log(`[proxy] CACHED ${cacheKey} (${body.length} bytes, total cached: ${cache.size})`);
      }

      if (!res.headersSent) {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'X-Cache': 'MISS',
        });
        res.end(body);
      }
    });
    proxyRes.on('error', (e) => {
      console.error('[proxy] response error:', e.message);
      if (!res.headersSent) { res.writeHead(502); res.end('Response error'); }
    });
  });

  proxyReq.on('timeout', () => {
    console.error(`[proxy] TIMEOUT ${req.url}`);
    proxyReq.destroy();
    if (!res.headersSent) { res.writeHead(504); res.end('Gateway Timeout'); }
  });

  proxyReq.on('error', (e) => {
    console.error(`[proxy] ERROR ${req.url}: ${e.message}`);
    if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway: ' + e.message); }
  });

  proxyReq.end();
});

// Increase max concurrent sockets to SACHET
https.globalAgent.maxSockets = 20;

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  SACHET NDMA CORS Proxy — ResqNet');
  console.log(`  Listening on http://localhost:${PORT}`);
  console.log('  Endpoints: /cap_public_website/rss/rss_india.xml');
  console.log('             /cap_public_website/FetchXMLFile');
  console.log('             /cap_public_website/FetchPolygonXMLFile');
  console.log('  Health:    /health');
  console.log('');
});
