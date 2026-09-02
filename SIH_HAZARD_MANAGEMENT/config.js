/* ============================================================
   RESQNET RUNTIME CONFIG  —  THE ONLY FILE YOU EDIT TO DEPLOY
   ------------------------------------------------------------
   Loaded first (before script.js / district-gate.js / the Kavach
   app) so every other file reads its endpoints + Firebase project
   from one place. See DEPLOY.md.

   - RESQNET_FIREBASE_CONFIG : your Firebase project's web config
                            (Firebase console → Project settings →
                            "Your apps" → SDK setup → Config).
   - RESQNET_AI_API_BASE  : where the FastAPI backend (SIH_HAZARD_MANAGEMENT_ai)
                            lives. Default "/api" — Firebase Hosting rewrites
                            /api/** to the "resqnet-ai" Cloud Run service
                            (see firebase.json + DEPLOY.md §4), so it's
                            same-origin and needs no CORS. No trailing slash.
                            Local dev without Firebase: override with an
                            inline <script> before this file, e.g.
                            window.RESQNET_AI_API_BASE = "http://127.0.0.1:8000/api";
   - RESQNET_SACHET_PROXY : proxy for sachet.ndma.gov.in (browser CORS is
                            blocked). Default "/api/sachet" — the FastAPI
                            backend fetches NDMA server-side (no CORS, and
                            Google Cloud egress is rarely blocked by NDMA).
                            The Cloudflare Worker in sachet-worker/ is an
                            alternative. Leave "" to fall back to public
                            CORS proxies.
   - RESQNET_GOOGLE_MAPS_KEY : Maps JavaScript API key.

   SECURITY: restrict RESQNET_GOOGLE_MAPS_KEY in Google Cloud
   Console by HTTP referrer (your *.web.app / *.firebaseapp.com
   domains + http://localhost:*) and enable only Maps JavaScript
   API + Places API (New) + Directions API + Distance Matrix API.
   ============================================================ */

(function () {
  const cfg = {
    // ---- Firebase (swap all 6 values when you host on your own account) ----
    RESQNET_FIREBASE_CONFIG: {
      apiKey: "YOUR_FIREBASE_WEB_API_KEY",
      authDomain: "YOUR_PROJECT.firebaseapp.com",
      projectId: "YOUR_PROJECT_ID",
      storageBucket: "YOUR_PROJECT.firebasestorage.app",
      messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
      appId: "YOUR_FIREBASE_APP_ID",
      measurementId: "YOUR_MEASUREMENT_ID",
    },

    // Firebase Hosting proxies "/api/**" to the resqnet-ai Cloud Run service.
    // Only change this to an absolute URL if you host the AI backend somewhere
    // that ISN'T fronted by this Firebase project (e.g. "https://resqnet-ai.onrender.com").
    RESQNET_AI_API_BASE: "/api",

    // Served by the FastAPI backend's /sachet route (via the /api rewrite).
    // Or point at a Cloudflare Worker: "https://sachet-proxy.<sub>.workers.dev"
    RESQNET_SACHET_PROXY: "/api/sachet",

    RESQNET_GOOGLE_MAPS_KEY: "YOUR_GOOGLE_MAPS_API_KEY",

    // Azure Maps subscription key (client-side — the atlas SDK needs it in the
    // browser). Rotate it in the Azure portal and set a spending cap; it can't
    // be fully hidden in a static site. See SECURITY.md.
    RESQNET_AZURE_MAPS_KEY: "YOUR_AZURE_MAPS_SUBSCRIPTION_KEY",
  };

  // Only set keys that aren't already defined on window, so a
  // deployment can also inject overrides via an inline <script>
  // placed before this file.
  for (const [key, value] of Object.entries(cfg)) {
    if (window[key] === undefined) window[key] = value;
  }

  // ----------------------------------------------------------
  // Shared Google Maps JS API loader.
  // Both district-gate.js (Places lookup for facilities) and
  // relocation-sim.js (relocation map) call this — it injects the
  // <script> at most once and returns the same Promise thereafter.
  //   window.resqnetLoadGoogleMaps("places,geometry") -> Promise<google.maps>
  // ----------------------------------------------------------
  window.resqnetLoadGoogleMaps = function (libraries) {
    libraries = libraries || "places,geometry";

    if (window.__resqnetGmapsPromise) return window.__resqnetGmapsPromise;

    window.__resqnetGmapsPromise = new Promise(function (resolve, reject) {
      // Allow a later retry if this attempt fails.
      var _rej = reject;
      reject = function (err) { window.__resqnetGmapsPromise = null; _rej(err); };
      if (window.google && window.google.maps && window.google.maps.places) {
        return resolve(window.google.maps);
      }
      var key = window.RESQNET_GOOGLE_MAPS_KEY || "";
      if (!key) return reject(new Error("RESQNET_GOOGLE_MAPS_KEY not set in config.js"));

      var cbName = "__resqnetGmapsCb";
      var settled = false;
      window[cbName] = function () { settled = true; resolve(window.google.maps); };

      var s = document.createElement("script");
      s.src =
        "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) +
        "&libraries=" + encodeURIComponent(libraries) +
        // region=IN makes Google serve India's official boundaries
        // (J&K, Ladakh, Arunachal Pradesh) as per Government of India.
        "&region=IN" +
        "&callback=" + cbName;
      s.async = true;
      s.defer = true;
      s.onerror = function () {
        settled = true;
        reject(new Error("Google Maps JS failed to load (check API key / referrer / enabled APIs)"));
      };
      document.head.appendChild(s);

      // Don't hang forever if the network stalls the script request.
      setTimeout(function () {
        if (!settled) {
          settled = true;
          reject(new Error("Google Maps JS load timed out"));
        }
      }, 15000);
    });

    return window.__resqnetGmapsPromise;
  };
})();
