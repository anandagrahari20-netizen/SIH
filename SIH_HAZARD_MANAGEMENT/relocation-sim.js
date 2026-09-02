/* ============================================================
   AI RESOURCE RELOCATION — SIMULATION PANEL (Google Maps)
   ------------------------------------------------------------
   - Loads Google Maps JS API (key from config.js)
   - Scopes the map to window.resqnetDistrict (set by district-gate.js)
   - "Run AI Allocation" -> GET {AI_API_BASE}/allocate + /resources
     then animates each resource -> cluster move on the map
   - Every animated move is written to Firestore ("relocations")
     via window.resqnetWriteRelocation so the Kavach app sees it live
   ============================================================ */

import "./firebase-bridge.js"; // ensures window.resqnetWriteRelocation exists

// Default "/api" — Firebase Hosting rewrites it to the resqnet-ai Cloud Run service.
const AI_API_BASE = (window.RESQNET_AI_API_BASE || "/api").replace(/\/+$/, "");
const GMAPS_KEY = window.RESQNET_GOOGLE_MAPS_KEY || "";

const TYPE_ICON = {
  ambulance: "🚑", medical_team: "🚑", fire_brigade: "🚒", ndrf_team: "🛟",
  boat: "🛥️", police: "🚓", water_tanker: "🚚", food_supply: "🚚",
  shelter_unit: "🏕️", generic: "📦",
};

let gmap = null;
let districtPolygon = null;
let gmapsReady = false;
let animatables = []; // active markers/lines to clear between runs

// ---------------------------------------------------------------
// Google Maps loader (shared, defined in config.js)
// ---------------------------------------------------------------
function loadGoogleMaps() {
  if (typeof window.resqnetLoadGoogleMaps === "function") {
    return window.resqnetLoadGoogleMaps("places,geometry");
  }
  if (!GMAPS_KEY) return Promise.reject(new Error("RESQNET_GOOGLE_MAPS_KEY not set in config.js"));
  return Promise.reject(new Error("resqnetLoadGoogleMaps unavailable (config.js not loaded?)"));
}

let facilityMarkers = [];

// Drops hospital / police / fire markers (discovered by district-gate.js
// via Google Places) onto the relocation map.
function drawFacilityMarkers(resources) {
  if (!gmap || !window.google) return;
  const g = window.google.maps;

  for (const m of facilityMarkers) { try { m.setMap(null); } catch (_) {} }
  facilityMarkers = [];

  const STYLE = {
    medical_team: { color: "#d32f2f", label: "H" },
    police:       { color: "#1565c0", label: "P" },
    fire_brigade: { color: "#e65100", label: "F" },
  };

  for (const r of resources || []) {
    if (r.latitude == null || r.longitude == null) continue;
    const s = STYLE[r.type] || { color: "#455a64", label: "?" };
    const marker = new g.Marker({
      position: { lat: Number(r.latitude), lng: Number(r.longitude) },
      map: gmap,
      title: `${r.name || ""}${r.address ? " — " + r.address : ""}`,
      label: { text: s.label, color: "#fff", fontSize: "10px", fontWeight: "700" },
      icon: {
        path: g.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: s.color,
        fillOpacity: 1,
        strokeColor: "#fff",
        strokeWeight: 2,
      },
    });
    facilityMarkers.push(marker);
  }
}

// ---------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);
function setStatus(msg) { const el = $("relocation-status"); if (el) el.textContent = msg; }
function setHint(msg) { const el = $("relocation-map-hint"); if (el) el.textContent = msg; }

// ---------------------------------------------------------------
// Map setup / district scoping
// ---------------------------------------------------------------
async function ensureMapForDistrict(district) {
  const mapEl = $("relocation-map");
  if (!mapEl) return;

  if (!gmapsReady) {
    try {
      await loadGoogleMaps();
      gmapsReady = true;
    } catch (err) {
      console.warn("[relocation-sim]", err);
      mapEl.innerHTML = `<div style="display:flex;height:100%;align-items:center;justify-content:center;padding:24px;text-align:center;color:#374151;font:600 14px sans-serif">Google Maps unavailable.<br><span style="font-weight:400;opacity:.8">${err.message}</span></div>`;
      return;
    }
  }

  const g = window.google.maps;
  const center = district?.center
    ? { lat: district.center.lat, lng: district.center.lon }
    : { lat: 22.5937, lng: 78.9629 };

  if (!gmap) {
    gmap = new g.Map(mapEl, {
      center, zoom: 10, mapTypeControl: false, streetViewControl: false,
    });
  }

  // Fit to district bbox and lock the camera to it — the operator
  // cannot pan or zoom out of their allotted district.
  if (district?.bbox) {
    const b = district.bbox;
    const mLat = (b.maxLat - b.minLat) * 0.08 || 0.05;
    const mLon = (b.maxLon - b.minLon) * 0.08 || 0.05;
    const bounds = new g.LatLngBounds(
      { lat: b.minLat, lng: b.minLon },
      { lat: b.maxLat, lng: b.maxLon },
    );
    gmap.fitBounds(bounds);
    gmap.setOptions({
      restriction: {
        latLngBounds: {
          south: b.minLat - mLat, west: b.minLon - mLon,
          north: b.maxLat + mLat, east: b.maxLon + mLon,
        },
        strictBounds: true,
      },
    });
    g.event.addListenerOnce(gmap, 'idle', () => {
      const z = gmap.getZoom();
      if (z != null) gmap.setOptions({ minZoom: Math.max(3, z - 1) });
    });
  } else {
    gmap.setCenter(center);
  }

  // (Re)draw district outline
  if (districtPolygon) { districtPolygon.setMap(null); districtPolygon = null; }
  const pts = district?.polygonPoints || [];
  if (pts.length >= 3) {
    districtPolygon = new g.Polygon({
      paths: pts.map(([lat, lon]) => ({ lat: Number(lat), lng: Number(lon) })),
      strokeColor: "#1c3655", strokeWeight: 2, strokeOpacity: 0.9,
      fillColor: "#1c3655", fillOpacity: 0.05, clickable: false,
    });
    districtPolygon.setMap(gmap);
  }

  // Facilities discovered by district-gate.js (may already be ready,
  // or arrive later via resqnet:resources-ready).
  if (Array.isArray(window.resqnetDistrictResources) && window.resqnetDistrictResources.length) {
    drawFacilityMarkers(window.resqnetDistrictResources);
  }

  setHint(`${district?.district || "District"} — press "Run AI Allocation"`);
}

// ---------------------------------------------------------------
// Allocation run
// ---------------------------------------------------------------
function clearAnimatables() {
  for (const a of animatables) { try { a.setMap(null); } catch (_) {} }
  animatables = [];
}

// Zoom the map out so BOTH ends of every dispatch are visible — the
// facility a unit leaves from and the cluster it is heading to. The
// district restriction set in ensureMapForDistrict still applies, so
// this can never frame another city.
function fitToAllocation(points) {
  if (!gmap || !window.google || !points || points.length < 1) return;
  const g = window.google.maps;

  try {
    const bounds = new g.LatLngBounds();
    let added = 0;

    for (const p of points) {
      const lat = Number(p?.lat), lng = Number(p?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      bounds.extend({ lat, lng });
      added += 1;
    }
    if (!added) return;

    // A single point (or two almost on top of each other) would make
    // fitBounds slam to max zoom — pad it into a small box instead.
    if (added === 1 || bounds.getNorthEast().equals(bounds.getSouthWest())) {
      const c = bounds.getCenter();
      const d = 0.02; // ~2 km
      bounds.extend({ lat: c.lat() + d, lng: c.lng() + d });
      bounds.extend({ lat: c.lat() - d, lng: c.lng() - d });
    }

    gmap.fitBounds(bounds, { top: 48, right: 48, bottom: 48, left: 48 });

    // fitBounds can overshoot on a tiny spread; keep it readable.
    g.event.addListenerOnce(gmap, "idle", () => {
      const z = gmap.getZoom();
      if (z != null && z > 15) gmap.setZoom(15);
    });
  } catch (err) {
    console.warn("[relocation-sim] fitToAllocation failed", err);
  }
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000), ...(opts || {}) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function resourceLookup(resources) {
  const byId = new Map();
  for (const r of resources) byId.set(r.resource_id, r);
  return byId;
}

// ---------------------------------------------------------------
// On-page allocator (used when the AI backend is unreachable)
// ---------------------------------------------------------------
function havKm(a, b) {
  const R = 6371, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// need -> compatible resource types (mirrors the backend's
// NEED_RESOURCE_COMPATIBILITY, plus ambulance).
const NEED_TYPES = {
  rescue: ["fire_brigade", "police", "ndrf_team", "boat"],
  medical: ["ambulance", "medical_team"],
  fire: ["fire_brigade"],
  evacuation: ["fire_brigade", "police", "ndrf_team", "boat"],
  food: ["food_supply"],
  water: ["water_tanker", "food_supply"],
  shelter: ["shelter_unit"],
};

// Order in which one incident's needs are served: life-safety first.
const NEED_ORDER = ["rescue", "medical", "evacuation", "water", "food", "shelter"];

// Severity is a HARD tier — every CRITICAL is dispatched before any
// HIGH, HIGH before MEDIUM, MEDIUM before LOW.
const SEVERITY_RANK = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };
const SEVERITY_COLOR = { CRITICAL: "#d32f2f", HIGH: "#f05a28", MEDIUM: "#f9a825", LOW: "#64748b" };

// Same anti-clumping rule as the backend: each extra unit taken from
// a resource makes it less attractive, so one facility never absorbs
// the whole district's response.
const SPREAD_PENALTY = 0.45;
const MAX_UNITS_PER_RESOURCE_PER_NEED = 2;

async function loadDistrictIncidents(district) {
  const fs = window.resqnetFirestore;
  const fdb = window.resqnetDb;
  if (!fs || !fdb || typeof fs.getDocs !== "function") return [];
  const snap = await fs.getDocs(fs.collection(fdb, "incidents"));
  const out = [];
  snap.forEach((docSnap) => {
    const d = docSnap.data() || {};
    if ((d.status || "").toUpperCase() === "RESOLVED") return;
    const lat = Number(d.latitude), lng = Number(d.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (typeof window.resqnetPointInDistrict === "function" &&
        !window.resqnetPointInDistrict(lat, lng)) return;
    const facts = d.facts || {};
    out.push({
      id: d.incident_id || docSnap.id,
      lat, lng,
      priority: ((d.priority && d.priority.level) || "HIGH").toUpperCase(),
      needs: facts.needs || [],
      people: facts.people_count || 1,
      trapped: !!facts.trapped,
      injured: !!facts.injured,
      injuredCount: facts.injury_count || (facts.injured ? 1 : 0),
      trappedCount: facts.trapped ? (facts.people_count || 1) : 0,
    });
  });
  return out;
}

// What each need family of an incident actually has to cover: injured
// people drive medical demand, trapped people drive rescue demand, the
// whole headcount drives relief demand.
function requirementsFor(inc) {
  const needs = new Set(inc.needs || []);
  if (inc.injured) needs.add("medical");
  if (inc.trapped) needs.add("rescue");

  const people = Math.max(1, Number(inc.people) || 1);
  if (!needs.size) return [{ need: "general", heads: people }];

  return NEED_ORDER.filter((n) => needs.has(n)).map((need) => ({
    need,
    heads:
      need === "medical" ? Math.max(1, Math.min(inc.injuredCount || 1, people))
      : need === "rescue" ? Math.max(1, Math.min(inc.trappedCount || people, people))
      : people,
  }));
}

// On-page mirror of the backend allocator, used when the AI backend is
// unreachable. Same three rules: strict severity order, one unit per
// need family, and availability that actually depletes as units are
// committed so later incidents only see what is genuinely still free.
function clientAllocate(incidents, resources) {
  const pool = resources
    .filter((r) => r.latitude != null && r.longitude != null)
    .map((r) => {
      const total = Math.max(1, Number(r.total_units) || 1);
      const avail = r.available_units == null ? total : Number(r.available_units);
      return {
        ...r,
        _total: total,
        _start: Math.max(0, avail),
        _remaining: Math.max(0, avail),
        _load: 0,
        _capacity: Math.max(1, Number(r.capacity_per_unit) || 5),
      };
    });

  const sorted = [...incidents].sort(
    (a, b) =>
      (SEVERITY_RANK[b.priority] || 0) - (SEVERITY_RANK[a.priority] || 0) ||
      (b.trapped ? 1 : 0) - (a.trapped ? 1 : 0) ||
      (b.injured ? 1 : 0) - (a.injured ? 1 : 0) ||
      (b.people || 0) - (a.people || 0),
  );

  const clusters = [];

  sorted.forEach((inc, i) => {
    const decisions = [];

    for (const { need, heads } of requirementsFor(inc)) {
      const allowed = need === "general" ? null : new Set([...(NEED_TYPES[need] || []), "generic"]);

      const candidates = pool
        .filter((r) => r._remaining > 0 && (!allowed || allowed.has(r.type)))
        .map((r) => {
          const km = havKm({ lat: inc.lat, lng: inc.lng }, { lat: r.latitude, lng: r.longitude }) * 1.3;
          const suitability = 1 / (1 + km / 5);
          const spread = 1 / (1 + SPREAD_PENALTY * r._load);
          return { r, km, score: suitability * spread };
        })
        .sort((a, b) => b.score - a.score);

      let covered = 0;
      for (const { r, km } of candidates) {
        if (covered >= heads) break;
        if (r._remaining <= 0) continue;

        const outstanding = heads - covered;
        const units = Math.min(
          r._remaining,
          Math.max(1, Math.ceil(outstanding / r._capacity)),
          MAX_UNITS_PER_RESOURCE_PER_NEED,
        );

        const before = r._remaining;
        r._remaining -= units;
        r._load += units;
        covered += units * r._capacity;

        const eta = (km / 30) * 60;
        decisions.push({
          resource_id: r.resource_id,
          resource_name: r.name,
          resource_type: r.type,
          cluster_id: inc.id,
          need_covered: need,
          units_allocated: units,
          distance_km: Math.round(km * 100) / 100,
          eta_minutes: Math.round(eta * 10) / 10,
          available_before: before,
          available_after: r._remaining,
          reasons: [
            `${need.toUpperCase()} requirement — ${km.toFixed(1)} km away, ETA ${eta.toFixed(0)} min`,
            `Availability ${before} → ${r._remaining} of ${r._total} unit(s)`,
          ],
        });
      }
    }

    clusters.push({
      cluster_id: inc.id,
      priority: inc.priority,
      severity_rank: SEVERITY_RANK[inc.priority] || 0,
      dispatch_order: i + 1,
      latitude: inc.lat,
      longitude: inc.lng,
      people_affected: inc.people,
      needs: inc.needs || [],
      decisions,
    });
  });

  const resource_changes = pool
    .filter((r) => r._remaining !== r._start)
    .map((r) => ({
      resource_id: r.resource_id,
      resource_name: r.name,
      resource_type: r.type,
      units_dispatched: r._start - r._remaining,
      available_before: r._start,
      available_after: r._remaining,
      total_units: r._total,
    }));

  return { clusters, resource_changes, committed: false };
}


// ══════════════════════════════════════════════════════════════
//  ROAD-NETWORK ROUTING (Google Maps)
//  ------------------------------------------------------------
//  The allocator ranks candidates on straight-line distance, which
//  is wrong in exactly the cases that matter: a depot 3 km away
//  across a river can be a 25-minute drive while one 6 km away down
//  a highway takes 8. These helpers replace the crow-flies figures
//  with real driving distance/duration before the operator sees the
//  plan, and draw the unit along the actual road path.
//
//  Google caps Distance Matrix at 25 origins x 25 destinations and
//  100 elements per request, so pairs are batched. Every call is
//  best-effort: if the API is unavailable the straight-line estimate
//  stands and the run continues.
// ══════════════════════════════════════════════════════════════

const ROAD_CACHE = new Map();          // "lat,lng|lat,lng" -> {km, min}
const ROAD_MATRIX_MAX_ELEMENTS = 100;

function _roadKey(from, to) {
  return `${from.lat.toFixed(4)},${from.lng.toFixed(4)}|${to.lat.toFixed(4)},${to.lng.toFixed(4)}`;
}

// Resolves road distance + duration for a list of {from, to} pairs.
// Returns a Map keyed by _roadKey(). Never throws.
async function roadDistances(pairs) {
  const out = new Map();
  if (!pairs.length) return out;

  const pending = [];
  for (const pr of pairs) {
    const k = _roadKey(pr.from, pr.to);
    if (ROAD_CACHE.has(k)) out.set(k, ROAD_CACHE.get(k));
    else if (!pending.some((q) => _roadKey(q.from, q.to) === k)) pending.push(pr);
  }
  if (!pending.length) return out;

  let g;
  try {
    g = window.google && window.google.maps ? window.google.maps
      : await window.resqnetLoadGoogleMaps("places,geometry");
    g = window.google.maps;
  } catch (err) {
    console.warn("[roads] Google Maps unavailable, keeping straight-line estimates:", err.message);
    return out;
  }
  if (!g || !g.DistanceMatrixService) return out;

  const svc = new g.DistanceMatrixService();

  // Pairs are read off the diagonal of an NxN matrix, so a chunk costs
  // N*N elements: N=10 is the largest that fits the 100-element cap.
  const chunkSize = Math.floor(Math.sqrt(ROAD_MATRIX_MAX_ELEMENTS));
  for (let i = 0; i < pending.length; i += chunkSize) {
    const chunk = pending.slice(i, i + chunkSize);
    const res = await new Promise((resolve) => {
      try {
        svc.getDistanceMatrix(
          {
            origins: chunk.map((c) => new g.LatLng(c.from.lat, c.from.lng)),
            destinations: chunk.map((c) => new g.LatLng(c.to.lat, c.to.lng)),
            travelMode: g.TravelMode.DRIVING,
            unitSystem: g.UnitSystem.METRIC,
          },
          (r, status) => resolve(status === "OK" ? r : null),
        );
      } catch (_) { resolve(null); }
    });
    if (!res || !res.rows) continue;

    chunk.forEach((pr, idx) => {
      const cell = res.rows[idx] && res.rows[idx].elements && res.rows[idx].elements[idx];
      if (!cell || cell.status !== "OK") return;
      const val = {
        km: cell.distance.value / 1000,
        min: cell.duration.value / 60,
      };
      const k = _roadKey(pr.from, pr.to);
      ROAD_CACHE.set(k, val);
      out.set(k, val);
    });
  }
  return out;
}

// The drivable path between two points, for the animation. Falls back
// to the straight segment when Directions is unavailable.
async function roadPath(from, to) {
  let g;
  try { g = window.google.maps; } catch (_) { return [from, to]; }
  if (!g || !g.DirectionsService) return [from, to];

  return new Promise((resolve) => {
    try {
      new g.DirectionsService().route(
        {
          origin: new g.LatLng(from.lat, from.lng),
          destination: new g.LatLng(to.lat, to.lng),
          travelMode: g.TravelMode.DRIVING,
        },
        (result, status) => {
          if (status === "OK" && result.routes && result.routes[0]) {
            resolve(result.routes[0].overview_path.map((pt) => ({ lat: pt.lat(), lng: pt.lng() })));
          } else {
            resolve([from, to]);
          }
        },
      );
    } catch (_) { resolve([from, to]); }
  });
}

function animateMove(from, to, label, color, route) {
  const g = window.google.maps;

  // `route` is the real road path when Directions resolved it; the
  // straight segment otherwise. Either way the unit follows the line
  // that is drawn, so the animation never contradicts the map.
  const pts = (Array.isArray(route) && route.length >= 2) ? route : [from, to];

  const path = new g.Polyline({
    path: pts, geodesic: true,
    strokeColor: color, strokeOpacity: 0.9, strokeWeight: 3,
    icons: [{ icon: { path: g.SymbolPath.FORWARD_CLOSED_ARROW }, offset: "100%" }],
  });
  path.setMap(gmap);
  animatables.push(path);

  const marker = new g.Marker({
    position: from, map: gmap, label: { text: label, fontSize: "18px" },
    title: label,
  });
  animatables.push(marker);

  // Walk the polyline at constant speed: cumulative segment lengths so
  // the icon does not sprint through dense turns and crawl on straights.
  const latLngs = pts.map((p) => new g.LatLng(p.lat, p.lng));
  const cum = [0];
  for (let k = 1; k < latLngs.length; k += 1) {
    cum.push(cum[k - 1] + g.geometry.spherical.computeDistanceBetween(latLngs[k - 1], latLngs[k]));
  }
  const total = cum[cum.length - 1] || 1;

  const steps = 120;
  let i = 0;
  const timer = setInterval(() => {
    i += 1;
    const target = (i / steps) * total;
    let seg = 1;
    while (seg < cum.length - 1 && cum[seg] < target) seg += 1;
    const span = cum[seg] - cum[seg - 1];
    const t = span > 0 ? (target - cum[seg - 1]) / span : 0;
    marker.setPosition(g.geometry.spherical.interpolate(latLngs[seg - 1], latLngs[seg], t));
    if (i >= steps) clearInterval(timer);
  }, 20);
}

// Decision list, grouped under a severity heading so the operator can
// see the dispatch order the allocator actually used.
function renderDecisionList(rows) {
  const el = $("relocation-decisions");
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = `<div class="p-4 text-xs text-gray-400">Allocator returned no relocations for this district.</div>`;
    return;
  }

  let html = "";
  let lastSeverity = null;

  for (const r of rows) {
    const sev = (r.priority || "LOW").toUpperCase();
    if (sev !== lastSeverity) {
      lastSeverity = sev;
      const n = rows.filter((x) => (x.priority || "LOW").toUpperCase() === sev).length;
      html += `<div class="px-4 py-2 sticky top-0 bg-white/95 backdrop-blur border-b border-gray-100 flex items-center gap-2 z-10">
        <span class="w-2 h-2 rounded-full" style="background:${SEVERITY_COLOR[sev] || "#64748b"}"></span>
        <span class="text-[11px] font-extrabold tracking-wide" style="color:${SEVERITY_COLOR[sev] || "#64748b"}">${escapeHtml(sev)}</span>
        <span class="text-[10px] text-gray-400">${n} unit(s) dispatched first</span>
      </div>`;
    }

    const avail = r.available_after != null
      ? `<span class="text-[10px] font-bold ${r.available_after === 0 ? "text-brand-red" : "text-gray-500"}">${r.available_before} → ${r.available_after} free</span>`
      : "";

    // The allocator flags when it had to substitute a different kind of
    // unit because the district has none of the right type. That is
    // exactly the kind of thing the operator must see, not bury.
    const note = (r.reasons || []).find((x) => /^No dedicated /.test(x));
    const substituted = note
      ? `<div class="mt-1.5 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">⚠ ${escapeHtml(note)}</div>`
      : "";

    html += `<div class="p-4 border-b border-gray-50">
      <div class="flex items-center justify-between gap-2">
        <span class="font-bold text-brand-blue text-sm">${TYPE_ICON[r.resource_type] || "📦"} ${escapeHtml(r.resource_name)}</span>
        ${r.need_covered ? `<span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full bg-brand-orangeLight text-brand-orange">${escapeHtml(r.need_covered)}</span>` : ""}
      </div>
      <div class="text-xs text-gray-500 mt-1 flex items-center gap-1.5 flex-wrap">
        <span>${r.units} unit(s) &nbsp;·&nbsp; ${r.distance_km} km &nbsp;·&nbsp; ETA ${r.eta_minutes} min</span>
        ${r.route_source === "road"
          ? `<span class="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-green-50 text-green-700 border border-green-200" title="Driving distance and time on the real road network">by road</span>`
          : `<span class="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 border border-gray-200" title="Straight-line estimate — road routing unavailable">est.</span>`}
      </div>
      ${r.serving_summary ? `<div class="mt-1.5 text-[11px] text-gray-700 bg-gray-50 border-l-2 border-brand-orange rounded-r px-2 py-1">
        <span class="font-semibold text-gray-500">Responding to:</span> ${escapeHtml(r.serving_summary)}
      </div>` : ""}
      ${r.serving_incident_ids?.length ? `<div class="mt-1 text-[10px] text-gray-400">Complaint${r.serving_incident_ids.length > 1 ? "s" : ""}: ${escapeHtml(r.serving_incident_ids.slice(0, 4).join(", "))}${r.serving_incident_ids.length > 4 ? ` +${r.serving_incident_ids.length - 4}` : ""}</div>` : ""}
      <div class="flex items-center justify-end gap-2 mt-1">
        ${avail}
      </div>
      ${substituted}
    </div>`;
  }

  el.innerHTML = html;
}

// Live "Resources Available" header stat, reduced by what this run
// committed so the operator sees the district's capacity shrink.
//
// The count comes from the BACKEND's post-commit availability, not from
// the locally discovered facility list — discovery ids and backend ids
// are different, so matching them up locally would silently no-op.
async function applyResourceChanges(changes, district) {
  const list = Array.isArray(changes) ? changes : [];
  const dispatched = list.reduce((n, c) => n + (c.units_dispatched || 0), 0);

  const statEl = document.getElementById("stat-resources");
  const subEl = document.getElementById("stat-resources-sub");

  try {
    const dq = district?.district ? `?district=${encodeURIComponent(district.district)}` : "";
    const resources = await fetchJSON(`${AI_API_BASE}/resources${dq}`);

    const free = resources.reduce((n, r) => n + (Number(r.available_units) || 0), 0);
    if (statEl) statEl.textContent = String(free);
    if (subEl) {
      subEl.textContent = dispatched
        ? `${dispatched} dispatched · ${free} free`
        : `${free} units free`;
    }

    // Keep the local cache in step for the panels that read it.
    const byKey = new Map(
      resources.map((r) => [`${r.type}|${Number(r.latitude).toFixed(4)}|${Number(r.longitude).toFixed(4)}`, r]),
    );
    for (const r of window.resqnetDistrictResources || []) {
      const m = byKey.get(`${r.type}|${Number(r.latitude).toFixed(4)}|${Number(r.longitude).toFixed(4)}`);
      if (m) r.available_units = m.available_units;
    }
  } catch (e) {
    // Backend unreachable (on-page allocator path) — fall back to the
    // local list so the number still moves.
    const byId = new Map(list.map((c) => [c.resource_id, c]));
    for (const r of window.resqnetDistrictResources || []) {
      const c = byId.get(r.resource_id || r.osmId);
      if (c) r.available_units = c.available_after;
    }
    const free = (window.resqnetDistrictResources || [])
      .reduce((n, r) => n + (r.available_units == null ? 1 : Number(r.available_units) || 0), 0);
    if (statEl) statEl.textContent = String(free);
    if (subEl && dispatched) subEl.textContent = `${dispatched} dispatched · ${free} free`;
  }

  // Redraw the Resource Readiness cards from the backend's new numbers.
  if (typeof window.resqnetRefreshReadiness === "function") {
    window.resqnetRefreshReadiness().catch(() => {});
  }

  return dispatched;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeHtml(v) {
  return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function runAllocation() {
  const district = window.resqnetDistrict;
  const btn = $("relocation-run-btn");
  if (btn) btn.disabled = true;

  try {
    if (!gmap) await ensureMapForDistrict(district);
    clearAnimatables();

    // Try the AI backend; fall back to an on-page allocator so the
    // simulation always runs.
    let allocation, resources, allocSource;
    try {
      setStatus("Requesting allocation from AI backend…");
      const dq = district?.district ? `?district=${encodeURIComponent(district.district)}` : "";
      // POST /allocate/commit both plans AND applies the plan: every
      // dispatched unit is deducted from that resource's
      // available_units, so a second run only sees what is still free.
      [allocation, resources] = await Promise.all([
        fetchJSON(`${AI_API_BASE}/allocate/commit${dq}`, { method: "POST" }),
        fetchJSON(`${AI_API_BASE}/resources${dq}`),
      ]);
      allocSource = allocation.committed ? "AI backend (committed)" : "AI backend";
    } catch (beErr) {
      console.warn("[relocation-sim] AI backend allocate failed, using on-page allocator", beErr.message);
      setStatus("AI backend unreachable — running on-page allocator…");
      resources = (window.resqnetDistrictResources || []).map((r) => ({
        ...r, resource_id: r.resource_id || r.osmId,
      }));
      const incidents = await loadDistrictIncidents(district);
      if (!resources.length) throw new Error("No resources discovered for this district yet.");
      if (!incidents.length) throw new Error("No active incidents in this district to allocate to.");
      allocation = clientAllocate(incidents, resources);
      allocSource = "on-page allocator";
    }

    const byId = resourceLookup(resources);
    const rows = [];

    // Every endpoint animated this run — used to zoom the map out so
    // the operator can see WHERE each unit comes from and WHERE it is
    // going, not just the destination.
    const runPoints = [];

    // Client-side twin of the backend's MAX_DISPATCH_KM guard. A unit
    // must never be shown crossing cities, even if an older backend or
    // a stale Firestore record slips one through.
    const MAX_DISPATCH_KM = 120;
    let skippedFarAway = 0;

    // Dispatch in strict severity order: every CRITICAL cluster is
    // animated and pushed before any HIGH, HIGH before MEDIUM, and so
    // on. The backend already returns them in this order; sorting here
    // as well keeps the on-page fallback and any older backend correct.
    const clusters = [...(allocation.clusters || [])]
      .filter((c) => (c.decisions || []).length)
      .sort(
        (a, b) =>
          (b.severity_rank ?? SEVERITY_RANK[(b.priority || "LOW").toUpperCase()] ?? 0) -
            (a.severity_rank ?? SEVERITY_RANK[(a.priority || "LOW").toUpperCase()] ?? 0) ||
          (b.urgency_score || 0) - (a.urgency_score || 0),
      );

    // ---- road-network refinement -------------------------------
    // Resolve real driving distance/time for every planned dispatch in
    // one batch, BEFORE anything is animated or written, so the ETAs
    // the operator acts on are road ETAs rather than crow-flies guesses.
    const pairIndex = [];
    for (const cluster of clusters) {
      if (cluster.latitude == null || cluster.longitude == null) continue;
      const to = { lat: cluster.latitude, lng: cluster.longitude };
      for (const d of cluster.decisions || []) {
        const r = byId.get(d.resource_id);
        if (!r || r.latitude == null) continue;
        pairIndex.push({ from: { lat: r.latitude, lng: r.longitude }, to, decision: d });
      }
    }

    let roads = new Map();
    if (pairIndex.length) {
      setStatus(`Computing road routes for ${pairIndex.length} dispatches…`);
      try {
        roads = await roadDistances(pairIndex.map(({ from, to }) => ({ from, to })));
      } catch (err) {
        console.warn("[relocation-sim] road matrix failed:", err.message);
      }
    }

    let roadResolved = 0;
    for (const pr of pairIndex) {
      const v = roads.get(_roadKey(pr.from, pr.to));
      if (!v) continue;
      pr.decision.distance_km = Math.round(v.km * 10) / 10;
      pr.decision.eta_minutes = Math.max(1, Math.round(v.min));
      pr.decision.route_source = "road";
      roadResolved += 1;
    }
    if (roadResolved) {
      // A closer depot by air can be the slower one by road, so the
      // dispatch order is re-derived from the road ETAs.
      clusters.forEach((c) => {
        (c.decisions || []).sort((a, b) => (a.eta_minutes || 999) - (b.eta_minutes || 999));
      });
    }
    console.info(`[relocation-sim] road ETAs for ${roadResolved}/${pairIndex.length} dispatches`);

    let lastSeverity = null;

    for (const cluster of clusters) {
      const to = (cluster.latitude != null && cluster.longitude != null)
        ? { lat: cluster.latitude, lng: cluster.longitude }
        : null;
      if (!to) continue;

      const sev = (cluster.priority || "LOW").toUpperCase();
      const color = SEVERITY_COLOR[sev] || "#64748b";

      // Pause between severity tiers so the operator can actually see
      // the queue being worked highest-severity-first.
      if (sev !== lastSeverity) {
        if (lastSeverity !== null) await sleep(650);
        lastSeverity = sev;
        const tier = clusters.filter((c) => (c.priority || "LOW").toUpperCase() === sev).length;
        setStatus(`Dispatching ${sev} incidents (${tier})…`);
      }

      for (const d of cluster.decisions || []) {
        const r = byId.get(d.resource_id);
        const from = r && r.latitude != null ? { lat: r.latitude, lng: r.longitude } : null;
        if (!from) continue;

        // Guard: never draw a dispatch across cities.
        if (havKm(from, to) > MAX_DISPATCH_KM) {
          skippedFarAway += 1;
          console.warn(
            `[relocation-sim] skipped ${d.resource_name}: ${Math.round(havKm(from, to))} km ` +
            `from cluster ${d.cluster_id} — outside this district`,
          );
          continue;
        }

        runPoints.push(from, to);

        // Draw the drivable path where we have one; the helper falls
        // back to the straight segment on its own.
        let route = null;
        if (d.route_source === "road") {
          try { route = await roadPath(from, to); } catch (_) {}
        }
        animateMove(from, to, TYPE_ICON[d.resource_type] || "📦", color, route);

        const row = {
          resource_id: d.resource_id,
          resource_name: d.resource_name,
          resource_type: d.resource_type,
          cluster_id: d.cluster_id,
          need_covered: d.need_covered || "",
          serving_summary: d.serving_summary || "",
          serving_incident_ids: d.serving_incident_ids || [],
          units: d.units_allocated,
          distance_km: d.distance_km,
          eta_minutes: d.eta_minutes,
          route_source: d.route_source || "direct",
          available_before: d.available_before,
          available_after: d.available_after,
          priority: sev,
          reasons: d.reasons || [],
        };
        rows.push(row);

        // Push to Firestore -> Kavach
        if (typeof window.resqnetWriteRelocation === "function") {
          window.resqnetWriteRelocation({
            ...row,
            from, to,
            state: district?.state || null,
            district: district?.district || null,
          }).catch((e) => console.warn("[relocation-sim] Firestore write failed", e));
        }
      }

      renderDecisionList(rows);
      await sleep(250);
    }

    renderDecisionList(rows);

    // Zoom out to frame the whole operation: every source facility and
    // every destination cluster in one view.
    fitToAllocation(runPoints);

    const dispatched = await applyResourceChanges(allocation.resource_changes, district);
    const tiers = [...new Set(rows.map((r) => r.priority))].join(" → ") || "—";
    const committed = allocation.committed
      ? ` · ${dispatched} unit(s) deducted from availability`
      : " · availability updated on-page only";

    const outOfArea = skippedFarAway
      ? ` · ${skippedFarAway} out-of-district move(s) blocked`
      : "";

    setStatus(
      `${rows.length} relocation(s) via ${allocSource} at ${new Date().toLocaleTimeString("en-IN")} · order ${tiers}${committed}${outOfArea} · pushed to Kavach.`,
    );
    setHint(`${rows.length} unit(s) en route · ${tiers}`);
  } catch (err) {
    console.error("[relocation-sim]", err);
    setStatus(`Allocation failed: ${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------
// Boot
// ---------------------------------------------------------------
function wire() {
  const btn = $("relocation-run-btn");
  if (btn) btn.addEventListener("click", runAllocation);

  if (window.resqnetDistrict) ensureMapForDistrict(window.resqnetDistrict);
}

window.addEventListener("resqnet:district-ready", (e) => {
  ensureMapForDistrict(e.detail || window.resqnetDistrict);
});

// Facilities (hospitals / police / fire) discovered for the district.
window.addEventListener("resqnet:resources-ready", async (e) => {
  // Ignore a slow discovery that resolves for a district the operator
  // has since navigated away from (stale markers bug).
  const evtDistrict = e.detail?.district?.district || e.detail?.district;
  const curDistrict = window.resqnetDistrict?.district;
  if (evtDistrict && curDistrict && String(evtDistrict).toLowerCase() !== String(curDistrict).toLowerCase()) {
    return;
  }
  const resources = e.detail?.resources || window.resqnetDistrictResources || [];
  if (!gmap) await ensureMapForDistrict(window.resqnetDistrict);
  drawFacilityMarkers(resources);
  const el = $("relocation-map-hint");
  if (el && resources.length) el.textContent = `${resources.length} facilities mapped — press "Run AI Allocation"`;
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wire);
} else {
  wire();
}
