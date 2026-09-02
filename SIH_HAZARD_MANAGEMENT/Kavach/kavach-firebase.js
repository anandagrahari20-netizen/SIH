/* ============================================================
   KAVACH ⇄ FIRESTORE
   ------------------------------------------------------------
   Subscribes to the same Firestore project the RESQNET dashboard
   writes to, so AI relocation decisions and incident updates show
   up live in the Kavach app (cross-device — not just same browser
   like the BroadcastChannel bridge in app.js).
   Loaded as a module from kavach.html; app.js stays a classic script.
   ============================================================ */

import { db, collection, onSnapshot } from "../firebase-bridge.js";

// District scoping — read LIVE every time (the citizen may sign in or
// change their district long after this module first loaded, so a
// captured constant would be stale and leak every broadcast).
function kavachDistrict() {
  try {
    const u = window.AppState && window.AppState.currentUser;
    return (u && u.district) || localStorage.getItem("kavach_district") || null;
  } catch (_) { return null; }
}
function kavachState() {
  try {
    const u = window.AppState && window.AppState.currentUser;
    return (u && u.state) || localStorage.getItem("kavach_state") || null;
  } catch (_) { return null; }
}

const TYPE_ICON = {
  ambulance: "🚑", medical_team: "🚑", fire_brigade: "🚒", ndrf_team: "🛟",
  boat: "🛥️", police: "🚓", water_tanker: "🚚", food_supply: "🚚",
  shelter_unit: "🏕️", generic: "📦",
};

function toast(msg, kind = "info") {
  if (typeof window.showToast === "function") window.showToast(msg, kind);
  else console.info("[kavach-firebase]", msg);
}

function shortSiren() {
  try {
    if (typeof window.startContinuousSiren === "function" && typeof window.stopContinuousSiren === "function") {
      window.startContinuousSiren();
      setTimeout(() => window.stopContinuousSiren(), 2500);
    }
  } catch (_) {}
}

function _norm(s) { return String(s || "").toLowerCase().replace(/\s+(nagar|district|dist\.?|rural|urban)\b/g, "").trim(); }

function matchesDistrict(data) {
  const kd = kavachDistrict();
  if (!kd) return true;
  const a = _norm(kd);
  const b = _norm(data.district || data.area || "");
  if (!b) return true;
  return a === b || a.includes(b) || b.includes(a);
}

// Great-circle distance in km.
function _havKm(la1, lo1, la2, lo2) {
  const R = 6371, r = Math.PI / 180;
  const dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2 +
    Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// City-scoped delivery: a broadcast reaches this citizen only if
//   • it names their district/city, OR
//   • their GPS point is inside the broadcast footprint, OR
//   • they have NO location set at all (can't scope → show).
// A Kanpur broadcast must NOT reach a citizen registered elsewhere.
function broadcastReachesUser(d) {
  const kd = kavachDistrict();
  const ks = kavachState();

  // Name match on district / area / state.
  if (kd) {
    const a = _norm(kd);
    const hay = _norm(`${d.district || ""} ${d.area || ""} ${d.headline || ""} ${d.description || ""}`);
    if (hay && (hay.includes(a) || a.includes(_norm(d.district || d.area || "")))) return true;
  }
  if (ks && d.state && _norm(ks) === _norm(d.state) && !kd) return true;

  // Geometry match — user's last known point inside the footprint.
  try {
    const loc = (window.AppState && window.AppState.userLocation) || {};
    const la = Number(loc.lat), lo = Number(loc.lng);
    if (Number.isFinite(la) && Number.isFinite(lo)) {
      if (Number.isFinite(d.lat) && Number.isFinite(d.lng)) {
        if (_havKm(la, lo, d.lat, d.lng) <= (Number(d.radius_km) || 15) + 10) return true;
      }
      if (Array.isArray(d.polygon) && d.polygon.length >= 3 && _pointInPoly(la, lo, d.polygon)) return true;
      // We DO have a point and it's not inside → this broadcast is for
      // another area. Hide it.
      return false;
    }
  } catch (_) {}

  // No district AND no point → nothing to scope against → show it.
  return !kd;
}

function _pointInPoly(lat, lng, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// ── authority broadcasts ──────────────────────────────────────
function subscribeBroadcasts() {
  const col = collection(db, "broadcasts");
  let primed = false;
  let lastTs = 0;
  try { lastTs = Number(localStorage.getItem("kavach_bcast_last_ts")) || 0; } catch (_) {}

  onSnapshot(col, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type !== "added" && change.type !== "modified") return;
      const d = change.doc.data() || {};
      const ts = Number(d.timestamp) || 0;
      if (ts <= lastTs) return;
      if ((d.expires_at && Date.now() > d.expires_at) || !broadcastReachesUser(d)) return;

      lastTs = ts;
      try { localStorage.setItem("kavach_bcast_last_ts", String(ts)); } catch (_) {}
      if (!primed) return;   // initial replay — ingest silently below

      if (typeof window.kavachIngestBroadcast === "function") {
        window.kavachIngestBroadcast(d, { alert: true });
      }
    });

    // On the first snapshot, replay everything still-valid into the
    // alert list without sirens so the feed is correct after a reload.
    if (!primed) {
      snap.forEach((doc) => {
        const d = doc.data() || {};
        if (d.expires_at && Date.now() > d.expires_at) return;
        if (!broadcastReachesUser(d)) return;
        if (typeof window.kavachIngestBroadcast === "function") {
          window.kavachIngestBroadcast(d, { alert: false });
        }
      });
      primed = true;
    }
  }, (err) => console.warn("[kavach-firebase] broadcasts listener error", err));
}

// ── relocations ────────────────────────────────────────────────
function subscribeRelocations() {
  const col = collection(db, "relocations");
  let primed = false;

  onSnapshot(col, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type !== "added" && change.type !== "modified") return;
      const d = change.doc.data() || {};
      if (!matchesDistrict(d)) return;

      // First delivery replays the whole collection — don't spam toasts.
      if (!primed) return;

      const icon = TYPE_ICON[d.resource_type] || "📦";
      toast(
        `${icon} ${d.resource_name || "Unit"} en route to cluster ${d.cluster_id || "?"} — ETA ${d.eta_minutes ?? "?"} min`,
        "warning"
      );
      shortSiren();
      window.dispatchEvent(new CustomEvent("kavach:relocation", { detail: d }));
    });
    primed = true;
  }, (err) => console.warn("[kavach-firebase] relocations listener error", err));
}

function myIncidentIds() {
  try { return new Set(JSON.parse(localStorage.getItem("kavach_my_incidents") || "[]")); }
  catch (_) { return new Set(); }
}

// ── incidents ─────────────────────────────────────────────────
function subscribeIncidents() {
  const col = collection(db, "incidents");
  let primed = false;

  onSnapshot(col, (snap) => {
    const mine = myIncidentIds();

    snap.docChanges().forEach((change) => {
      const d = change.doc.data() || {};
      const isMine = mine.has(d.incident_id) || mine.has(d.request_id);

      if (!primed) return;

      if (change.type === "added" && !isMine) {
        const lvl = d.priority?.level || "HIGH";
        toast(`🚨 New incident ${d.incident_id || ""} (${lvl}) — ${(d.text || "").slice(0, 60)}`, "danger");
      }

      // The citizen's own request — surface status / team updates.
      if (isMine && (change.type === "added" || change.type === "modified")) {
        const status = d.status || "UNASSIGNED";
        const team = d.assigned_team || d.assigned_resource;
        const label = { UNASSIGNED: "received", ASSIGNED: "assigned to a team", IN_PROGRESS: "responders en route", RESOLVED: "resolved" }[status] || status;
        toast(`Your request ${d.incident_id || ""} is ${label}${team ? " — " + team : ""}.`, status === "RESOLVED" ? "success" : "info");
        window.dispatchEvent(new CustomEvent("kavach:my-incident-update", { detail: d }));
      }

      window.dispatchEvent(new CustomEvent("kavach:incident", { detail: d }));
    });
    primed = true;
  }, (err) => console.warn("[kavach-firebase] incidents listener error", err));
}

subscribeRelocations();
subscribeIncidents();
subscribeBroadcasts();
console.info("[kavach-firebase] live Firestore bridge active", kavachDistrict() ? `(district: ${kavachDistrict()})` : "(no district yet)");
