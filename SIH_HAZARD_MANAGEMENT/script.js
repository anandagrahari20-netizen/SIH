// Firebase is initialised once in firebase-bridge.js (shared with
// relocation-sim.js and the Kavach app). `db` is the Firestore
// instance; collection/onSnapshot are still imported directly.
import { db } from "./firebase-bridge.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
// FIX: Define MockDB so the weather marker function doesn't crash the script
const MockDB = {
  weatherData: [],
  citizenReports: [],
  requests: []
};// FIX: Define the missing escapeHtml helper function
function escapeHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
window.MockDB = MockDB;

// Full live view of the incidents collection, for the header stat
// counters. Keyed by Firestore doc id.
const liveIncidents = new Map();

function incidentInDistrict(inc) {
  const d = window.resqnetDistrict;
  if (!d) return true;
  const lat = Number(inc.latitude);
  const lng = Number(inc.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return true; // no coords -> don't exclude
  if (typeof window.resqnetPointInDistrict === 'function') {
    return window.resqnetPointInDistrict(lat, lng);
  }
  return true;
}

function recomputeIncidentStats() {
  let critical = 0, high = 0, medium = 0, resolved = 0;
  for (const inc of liveIncidents.values()) {
    if (!incidentInDistrict(inc)) continue;
    const status = (inc.status || '').toUpperCase();
    if (status === 'RESOLVED') { resolved += 1; continue; }
    const level = (inc.priority?.level || '').toUpperCase();
    if (level === 'CRITICAL') critical += 1;
    else if (level === 'HIGH') high += 1;
    else if (level === 'MEDIUM') medium += 1;
  }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
  set('stat-critical', critical);
  set('stat-high', high);
  set('stat-medium', medium);
  set('stat-resolved', resolved);

  renderDispatchBoard();
  // Complaint-density dots follow the same live set.
  try { renderIncidentMarkers(); } catch (_) {}
}

/* ============================================================
   DISPATCH BOARD — every live incident with a status control.
   Operator changes status here → written to Firestore → the
   Kavach citizen sees "Assigned / En route / Resolved" live.
   Also the fast-decision view: sorted by urgency + age, need tags.
   ============================================================ */
const STATUS_FLOW = ['UNASSIGNED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED'];
const STATUS_LABEL = { UNASSIGNED: 'Unassigned', ASSIGNED: 'Assigned', IN_PROGRESS: 'En route', RESOLVED: 'Resolved' };
const PRIO_RANK = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };

async function setIncidentStatus(id, status) {
  const inc = liveIncidents.get(id) || [...liveIncidents.values()].find((x) => x.incident_id === id);
  if (inc) inc.status = status;                 // optimistic
  renderDispatchBoard();
  try {
    const fs = window.resqnetFirestore, fdb = window.resqnetDb;
    if (fs && fdb) {
      const key = inc && inc.__docId ? inc.__docId : id;
      await fs.setDoc(fs.doc(fdb, 'incidents', key), { status, updated_at: new Date().toISOString() }, { merge: true });
    }
  } catch (e) { console.warn('[dispatch] status write failed', e && e.message); }
}
window.setIncidentStatus = setIncidentStatus;

function renderDispatchBoard() {
  const host = document.getElementById('dispatch-board');
  if (!host) return;

  // Ordering: anything RESOLVED sinks to the bottom of the board no
  // matter how severe it was, so the operator's live queue only ever
  // shows work that still needs a decision. Open incidents above are
  // ranked CRITICAL -> HIGH -> MEDIUM -> LOW, oldest first within a
  // level; resolved ones are listed most-recently-closed first.
  const isDone = (inc) => (inc.status || '').toUpperCase() === 'RESOLVED';

  const rows = [...liveIncidents.entries()]
    .map(([docId, inc]) => ({ docId, inc }))
    .filter(({ inc }) => incidentInDistrict(inc))
    .sort((a, a2) => {
      const done = Number(isDone(a.inc)) - Number(isDone(a2.inc));
      if (done) return done;                       // resolved -> bottom

      if (isDone(a.inc)) {                          // both resolved
        return String(a2.inc.updated_at || a2.inc.created_at || '')
          .localeCompare(String(a.inc.updated_at || a.inc.created_at || ''));
      }

      const s = (PRIO_RANK[(a2.inc.priority?.level || '').toUpperCase()] || 0) - (PRIO_RANK[(a.inc.priority?.level || '').toUpperCase()] || 0);
      if (s) return s;
      return String(a.inc.created_at || '').localeCompare(String(a2.inc.created_at || ''));
    });

  const summ = document.getElementById('dispatch-summary');
  if (summ) {
    const unassigned = rows.filter((r) => (r.inc.status || 'UNASSIGNED').toUpperCase() === 'UNASSIGNED' && (r.inc.status || '').toUpperCase() !== 'RESOLVED').length;
    const enroute = rows.filter((r) => ['ASSIGNED', 'IN_PROGRESS'].includes((r.inc.status || '').toUpperCase())).length;
    summ.textContent = resqnetLang() === 'hi'
      ? `${unassigned} अनिर्दिष्ट · ${enroute} सक्रिय`
      : `${unassigned} unassigned · ${enroute} active`;
    summ.className = unassigned ? 'text-brand-red font-bold' : 'text-gray-500';
  }

  if (!rows.length) {
    host.innerHTML = '<div class="p-6 text-center text-gray-400 text-sm"><i class="fa-solid fa-inbox text-2xl mb-2 block"></i>No live incidents in this district.</div>';
    return;
  }

  const _hi = resqnetLang() === 'hi';

  host.innerHTML = rows.map(({ docId, inc }) => {
    inc.__docId = docId;
    const lvl = (inc.priority?.level || 'HIGH').toUpperCase();
    const st = (inc.status || 'UNASSIGNED').toUpperCase();
    const lc = { CRITICAL: 'bg-brand-red', HIGH: 'bg-brand-orange', MEDIUM: 'bg-brand-yellow', LOW: 'bg-gray-400' }[lvl] || 'bg-brand-orange';
    const needs = (inc.facts?.needs || []).map((n) => `<span class="text-[9px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded uppercase font-bold">${escapeHtml(n)}</span>`).join(' ');
    const ageMin = inc.created_at ? Math.max(0, Math.round((Date.now() - new Date(inc.created_at).getTime()) / 60000)) : null;
    const age = ageMin == null || isNaN(ageMin) ? '' : (ageMin > 90 ? `${Math.round(ageMin / 60)}h` : `${ageMin}m`);
    const opts = STATUS_FLOW.map((s) => `<option value="${s}" ${s === st ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('');
    return `<div class="rounded-lg border ${st === 'RESOLVED' ? 'border-gray-100 opacity-60' : 'border-gray-200'} p-3 bg-white">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <span class="w-2 h-2 rounded-full ${lc} flex-shrink-0"></span>
          <span class="text-xs font-bold text-gray-900 truncate">${escapeHtml(inc.incident_id || docId)}</span>
          <span class="text-[9px] font-bold text-white ${lc} px-1.5 py-0.5 rounded uppercase">${lvl}</span>
        </div>
        <div class="flex items-center gap-1.5 flex-shrink-0">
          ${age ? `<span class="text-[10px] ${ageMin > 30 ? 'text-brand-red font-bold' : 'text-gray-400'}">${age}</span>` : ''}
          <select onchange="setIncidentStatus('${escapeHtml(inc.incident_id || docId)}', this.value)" class="text-[10px] font-bold border border-gray-200 rounded px-1 py-0.5 bg-gray-50 ${st === 'UNASSIGNED' ? 'text-brand-red' : 'text-brand-blue'}">${opts}</select>
        </div>
      </div>
      <div class="text-[11px] text-gray-600 mt-1 truncate">${escapeHtml((inc.text || '').slice(0, 80) || '—')}</div>
      <div class="flex items-center gap-1.5 mt-1.5 flex-wrap">
        <span class="text-[10px] text-gray-500 font-semibold">${inc.facts?.people_count || '?'} ${_hi ? 'लोग' : 'ppl'}${inc.facts?.trapped ? (_hi ? ' · फँसे' : ' · trapped') : ''}${inc.facts?.injured ? (_hi ? ' · घायल' : ' · injured') : ''}</span>
        ${needs}
      </div>
    </div>`;
  }).join('');
}

function recomputeResourceStat() {
  const list = window.resqnetDistrictResources;
  const el = document.getElementById('stat-resources');
  if (el && Array.isArray(list)) el.textContent = String(list.length);
  const sub = document.getElementById('stat-resources-sub');
  if (sub && window.resqnetDistrict) sub.textContent = `in ${window.resqnetDistrict.district}`;
}

window.addEventListener('resqnet:resources-ready', recomputeResourceStat);
window.addEventListener('resqnet:district-ready', () => { recomputeIncidentStats(); recomputeResourceStat(); });

// Guard so the Firestore subscriptions start exactly once, whether
// that's from DOMContentLoaded (map-independent) or the map 'ready'
// handler. Previously these were ONLY started on map 'ready', so a
// bad/referrer-restricted Azure key meant no live incidents at all.
let _fbListenersStarted = false;
function startRealtimeListeners() {
  if (_fbListenersStarted) return;
  _fbListenersStarted = true;
  try { initFirebaseIncidentListener(); } catch (e) { console.warn('[ResqNet] incident listener failed', e); }
  try { initCallerLocationsListener(); } catch (e) { console.warn('[ResqNet] caller-locations listener failed', e); }
}

function initFirebaseIncidentListener() {
  const q = collection(db, "incidents");

  onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "removed") {
        liveIncidents.delete(change.doc.id);
        return;
      }
      liveIncidents.set(change.doc.id, change.doc.data());

      if (change.type === "added" || change.type === "modified") {
        const incident = change.doc.data();
        console.log("🔥 Live Incident Received from Firebase:", incident);
        
        // 1. Drop the map pin
        addLiveIncidentMarker(incident);

        // 2. Add to Top Grid
        const grid = document.getElementById("incidents-grid");
        if (grid) {
            const level = incident.priority?.level || 'HIGH';
            const isCritical = level === 'CRITICAL';
            const colorClass = isCritical ? 'bg-brand-red' : 'bg-brand-orange';
            const borderClass = isCritical ? 'border-brand-red/30' : 'border-brand-orange/30';
            const textClass = isCritical ? 'text-brand-red' : 'text-brand-orange';
            const bgLightClass = isCritical ? 'bg-brand-redLight' : 'bg-brand-orangeLight';
            
            const card = document.createElement("div");
            card.className = `rounded-2xl border ${borderClass} p-6 flex flex-col gap-4 hover:shadow-lg transition-shadow shadow-sm bg-white`;
            card.innerHTML = `
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <span class="w-2.5 h-2.5 rounded-full ${colorClass}"></span>
                  <span class="text-base font-bold text-gray-900">${incident.incident_id || 'NEW INCIDENT'}</span>
                  <span class="text-[10px] font-bold text-white ${colorClass} uppercase px-2 py-1 rounded-full tracking-wide">${level}</span>
                </div>
                <span class="text-[11px] font-bold ${textClass} ${bgLightClass} px-3 py-1 rounded-full whitespace-nowrap">Score: ${incident.priority?.score || 0}</span>
              </div>
              <div>
                <div class="text-base font-bold text-gray-900">${incident.facts?.people_count || 'Unknown'} people affected</div>
                <div class="text-sm text-gray-500 mt-1">${incident.text || 'No message provided'}</div>
              </div>
            `;
            grid.prepend(card);
        }

        // 3. Add to Sidebar Feed
        const feed = document.getElementById("kavach-emergency-feed");
        if (feed) {
            const feedCard = document.createElement("div");
            feedCard.className = "p-4 rounded-lg border border-gray-100 hover:bg-gray-50 transition-colors flex items-start gap-4 mb-2 bg-white";
            feedCard.innerHTML = `
              <div class="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center text-red-600 flex-shrink-0 mt-1">
                <i class="fa-solid fa-bell text-lg"></i>
              </div>
              <div class="flex-grow">
                <div class="flex justify-between items-start mb-1">
                  <div class="flex items-center gap-2">
                    <span class="font-bold text-gray-900 text-sm">${incident.incident_id || 'NEW'}</span>
                    <span class="bg-red-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-sm uppercase tracking-wider">${incident.priority?.level || 'HIGH'}</span>
                  </div>
                </div>
                <p class="text-sm text-gray-700 mt-2">${incident.text}</p>
              </div>
            `;
            feed.prepend(feedCard);
        }
      }
    });

    recomputeIncidentStats();
  });
}

function addLiveIncidentMarker(incident) {
  if (!window.map || !window.atlas) {
     console.error("Map not ready yet!");
     return;
  }

  const lat = Number(incident.latitude || 20.2961);
  const lng = Number(incident.longitude || 85.8245);
  console.log(`📍 Dropping marker at [${lng}, ${lat}]`);

  const level = incident.priority?.level || 'CRITICAL';
  const color = level === 'CRITICAL' ? '#d32f2f' : '#e65100';

  const marker = new atlas.HtmlMarker({
    position: [lng, lat],
    html: `<div style="width:36px;height:36px;border-radius:50%;background:${color};border:3px solid #fff;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:16px;box-shadow:0 4px 14px rgba(0,0,0,.4);cursor:pointer;z-index:9999;">🚨</div>`
  });

  // 👇 ADDED: Click listener to open the data popup
  marker.getElement?.().addEventListener('click', () => {
    if (!window.weatherPopup) {
      window.weatherPopup = new atlas.Popup({ closeButton: true });
    }

    const title = incident.incident_id || 'NEW INCIDENT';
    const text = incident.text || 'No description provided';
    const needs = incident.facts?.needs?.join(', ') || 'None specified';
    
    window.weatherPopup.setOptions({
      position: [lng, lat],
      content: `
        <div style="font-family:Inter,sans-serif;padding:8px;min-width:200px">
          <strong style="color:${color};">${escapeHtml(title)} - ${level}</strong>
          <div style="margin-top:8px;font-size:13px;color:#333;">${escapeHtml(text)}</div>
          <div style="margin-top:6px;font-size:11px;color:#666;">
            <strong>Needs:</strong> ${escapeHtml(needs)}
          </div>
        </div>
      `
    });

    window.weatherPopup.open(window.map);
  });

  window.map.markers.add(marker);
  window.map.setCamera({ center: [lng, lat], zoom: 12 });
}

/* ============================================================
   LIVE CALLER GPS  (from Kavach helpline / SOS)
   ------------------------------------------------------------
   The Kavach app streams a citizen's device GPS to Firestore
   `caller_locations/{incidentId}` for the duration of a helpline
   call / SOS. Here we subscribe and show a live, moving pin +
   accuracy + a "Navigate" link on the control-room map — the
   working equivalent of a 112 call handing your location to the
   responder. Scoped to the selected district.
   ============================================================ */
const callerMarkers = new Map();   // incidentId -> atlas.HtmlMarker

function initCallerLocationsListener() {
  const q = collection(db, 'caller_locations');
  onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      const id = change.doc.id;
      const d = change.doc.data() || {};

      const drop = change.type === 'removed' || d.active === false;
      const lat = Number(d.latitude), lng = Number(d.longitude);
      const inScope = (!window.resqnetDistrict) ||
        (typeof window.resqnetPointInDistrict !== 'function') ||
        (Number.isFinite(lat) && Number.isFinite(lng) && window.resqnetPointInDistrict(lat, lng));

      if (drop || !inScope || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        const m = callerMarkers.get(id);
        if (m && window.map) { try { window.map.markers.remove(m); } catch (_) {} }
        callerMarkers.delete(id);
        renderCallerPanel();
        return;
      }

      const label = `${d.name || 'Caller'}`;
      const gmapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
      const html = `<div style="position:relative;width:20px;height:20px">
          <div style="position:absolute;inset:0;border-radius:50%;background:#1565c0;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.4)"></div>
          <div style="position:absolute;inset:-6px;border-radius:50%;border:2px solid #1565c0;animation:callerPulse 1.6s infinite"></div>
        </div>`;

      let m = callerMarkers.get(id);
      if (!m && window.atlas && window.map) {
        m = new atlas.HtmlMarker({ position: [lng, lat], htmlContent: html });
        window.map.markers.add(m);
        m.getElement?.().addEventListener('click', () => {
          if (!window.weatherPopup) window.weatherPopup = new atlas.Popup({ closeButton: true });
          window.weatherPopup.setOptions({
            position: [lng, lat],
            content: `<div style="font-family:Inter,sans-serif;padding:8px;min-width:200px">
              <strong style="color:#1565c0">📍 ${escapeHtml(label)} — live location</strong>
              <div style="margin-top:6px;font-size:12px;color:#333">Incident ${escapeHtml(id)}</div>
              <div style="font-size:11px;color:#666;margin-top:4px">±${d.accuracy_m || '?'} m &nbsp;·&nbsp; ${new Date(d.updated_at).toLocaleTimeString('en-IN')}</div>
              <a href="${gmapsUrl}" target="_blank" style="display:inline-block;margin-top:8px;font-size:12px;font-weight:700;color:#1565c0">Navigate &rarr;</a>
            </div>`,
          });
          window.weatherPopup.open(window.map);
        });
        callerMarkers.set(id, m);
      } else if (m) {
        m.setOptions({ position: [lng, lat] });
      }
      m._callerData = { id, ...d, gmapsUrl };
      renderCallerPanel();
    });
  }, (err) => console.warn('[caller-gps] listener error', err));
}

function renderCallerPanel() {
  let panel = document.getElementById('caller-gps-panel');
  const host = document.getElementById('alerts') || document.getElementById('kavach-emergency-feed');
  if (!panel && host && host.parentElement) {
    panel = document.createElement('div');
    panel.id = 'caller-gps-panel';
    panel.className = 'bg-white rounded-xl shadow-sm border border-brand-blue/30 p-4 mb-4';
    host.parentElement.insertBefore(panel, host);
  }
  if (!panel) return;

  const rows = [...callerMarkers.values()].map((m) => m._callerData).filter(Boolean);
  if (!rows.length) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  panel.innerHTML = `<div class="text-xs font-bold uppercase tracking-wide text-brand-blue mb-2">
      <i class="fa-solid fa-location-crosshairs"></i> ${resqnetLang() === 'hi' ? 'लाइव कॉलर स्थान' : 'Live Caller Locations'} (${rows.length})</div>` +
    rows.map((d) => `<div class="flex items-center justify-between text-xs py-1 border-t border-gray-50">
        <span><b>${escapeHtml(d.name || 'Caller')}</b> · ${escapeHtml(d.id)} · ±${d.accuracy_m || '?'}m</span>
        <a href="${d.gmapsUrl}" target="_blank" class="text-brand-blue font-bold">Navigate &rarr;</a>
      </div>`).join('');
}
const translations = {
  en: {
    emergencyLabel: 'Emergency:',
    globalPortal: 'Global Portal',
    navHome: 'Home',
    navEmergencies: 'Emergencies',
    navMap: 'Map',
    navAlerts: 'Alerts',
    navResponses: 'Responses',
    navResources: 'Resources',
    heroKicker: 'Your Safety, Our Mission',
    heroTitle: 'BUILDING A RESILIENT <br><span class="text-[#ff671f]">AND SAFER INDIA</span>',
    heroCopy:
      'ResqNet is an integrated platform for disaster response, resource coordination and real-time situational awareness across the nation.',
    heroPrimary: 'View Live Situation',
    heroSecondary: 'Explore Resources',
    quickHeading: 'Incidents Requiring Immediate Attention',
    quickCopy: 'Incidents requiring immediate attention',
    emergencyListTitle: 'Latest Emergencies',
    viewAllEmergencies: 'View All Emergencies',
    liveSituation: 'Live Situation Overview',
    mapLink: 'View Full Map',
    resourceReadiness: 'Resource Readiness',
    resourceCopy: 'Current availability, deployment and operational demand.',
    viewAllResources: 'View All Resources',
    responseImpact: 'Response Impact',
    officialResources: 'Official Resources',
    whatWeDo: 'What We Do',
    whatWeDoCopy: 'Integrated system for effective disaster management and response'
  },
  hi: {
    emergencyLabel: 'आपातकाल:',
    globalPortal: 'वैश्विक पोर्टल',
    navHome: 'होम',
    navEmergencies: 'आपात स्थितियां',
    navMap: 'मानचित्र',
    navAlerts: 'अलर्ट',
    navResponses: 'प्रतिक्रियाएं',
    navResources: 'संसाधन',
    heroKicker: 'आपकी सुरक्षा, हमारा मिशन',
    heroTitle: 'एक मजबूत <br><span class="text-[#ff671f]">और सुरक्षित भारत</span>',
    heroCopy:
      'ResqNet आपदा प्रतिक्रिया, संसाधन समन्वय और देश भर में वास्तविक समय की स्थिति जागरूकता के लिए एक एकीकृत प्लेटफॉर्म है।',
    heroPrimary: 'लाइव स्थिति देखें',
    heroSecondary: 'संसाधन देखें',
    quickHeading: 'तुरंत ध्यान देने योग्य घटनाएं',
    quickCopy: 'जिन घटनाओं पर तुरंत ध्यान देने की जरूरत है',
    emergencyListTitle: 'नवीनतम आपात स्थितियां',
    viewAllEmergencies: 'सभी आपात स्थितियां देखें',
    liveSituation: 'लाइव स्थिति अवलोकन',
    mapLink: 'पूरा मानचित्र देखें',
    resourceReadiness: 'संसाधन तैयारी',
    resourceCopy: 'वर्तमान उपलब्धता, तैनाती और संचालन मांग।',
    viewAllResources: 'सभी संसाधन देखें',
    responseImpact: 'प्रतिक्रिया प्रभाव',
    officialResources: 'आधिकारिक संसाधन',
    whatWeDo: 'हम क्या करते हैं',
    whatWeDoCopy: 'प्रभावी आपदा प्रबंधन और प्रतिक्रिया के लिए एकीकृत प्रणाली'
  }
};

const themeStorageKey = 'resqnet-theme';
const languageStorageKey = 'resqnet-language';

/* ============================================================
   i18n / THEME / NAV (unchanged core site behaviour)
   ============================================================ */
function setTextFromTranslations(language) {
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    const key = element.getAttribute('data-i18n');
    if (translations[language] && translations[language][key] !== undefined) {
      element.textContent = translations[language][key];
    }
  });

  document.querySelectorAll('[data-i18n-html]').forEach((element) => {
    const key = element.getAttribute('data-i18n-html');
    if (translations[language] && translations[language][key] !== undefined) {
      element.innerHTML = translations[language][key];
    }
  });

  document.documentElement.lang = language === 'hi' ? 'hi' : 'en';
  document.querySelectorAll('[data-lang-label]').forEach((element) => {
    element.textContent = language === 'hi' ? 'हिं' : 'EN';
  });

  // Most of the console UI (and everything rendered dynamically) has no
  // data-i18n hook. Do a safe exact-match text-node sweep so Hindi
  // actually covers the whole page, and keep it live via an observer.
  // Panels whose text is BUILT in JS (dispatch rows, caller list,
  // summary counters) must be re-rendered FIRST so their generators
  // emit the new language — otherwise the sweep below runs against
  // stale DOM and the fresh rows come back in English.
  try { renderDispatchBoard(); } catch (_) {}
  try { renderCallerPanel(); } catch (_) {}
  try { renderResourceReadinessI18n(); } catch (_) {}

  applyPhraseSweep(language);
}

/* ============================================================
   BROAD HINDI SWEEP  — exact-match on text nodes only, so live
   data (names, counts, coordinates) is never mangled.
   ============================================================ */
const RESQNET_PHRASES_HI = {
  // header / status
  'National Disaster Response & Coordination — Command Centre': 'राष्ट्रीय आपदा प्रतिक्रिया एवं समन्वय — कमांड सेंटर',
  'Select district': 'ज़िला चुनें', 'Simulator': 'सिम्युलेटर',
  'AI': 'AI', 'SACHET': 'सचेत',
  // quick stats
  'Critical': 'गंभीर', 'High': 'उच्च', 'Medium': 'मध्यम', 'Resolved': 'हल हो गया',
  'Low': 'न्यून', 'Complaint severity': 'शिकायत गंभीरता',
  'by road': 'सड़क मार्ग से', 'est.': 'अनुमानित',
  'size = reports': 'आकार = रिपोर्ट',
  'Emergencies': 'आपात स्थितियां', 'Resources': 'संसाधन', 'Available': 'उपलब्ध',
  'in district': 'ज़िले में', 'live': 'लाइव', 'discovering…': 'खोज हो रही है…',
  // map panel
  'Live Situation Overview': 'लाइव स्थिति अवलोकन',
  'Click map to select area · broadcast target': 'क्षेत्र चुनने हेतु मानचित्र पर क्लिक करें · ब्रॉडकास्ट लक्ष्य',
  'Critical Incident': 'गंभीर घटना', 'High Incident': 'उच्च घटना', 'Medium Incident': 'मध्यम घटना',
  'Resource': 'संसाधन', 'Shelter': 'आश्रय',
  'Click the map': 'मानचित्र पर क्लिक करें', 'Click anywhere on the map to select an area': 'क्षेत्र चुनने के लिए मानचित्र पर कहीं भी क्लिक करें',
  'View Full Map': 'पूरा मानचित्र देखें',
  // broadcast panel
  'Selected Area & Weather': 'चयनित क्षेत्र एवं मौसम',
  'Click a point on the map, review its live weather, then broadcast an IMD alert to that area.':
    'मानचित्र पर एक बिंदु चुनें, उसका लाइव मौसम देखें, फिर उस क्षेत्र में IMD अलर्ट प्रसारित करें।',
  'Selected Area': 'चयनित क्षेत्र', 'Loading weather…': 'मौसम लोड हो रहा है…',
  'Fetching live conditions': 'लाइव स्थिति प्राप्त की जा रही है', 'Hazard': 'ख़तरा',
  'MODERATE': 'मध्यम', 'HIGH': 'उच्च', 'SEVERE': 'गंभीर',
  'Send SACHET Broadcast': 'सचेत ब्रॉडकास्ट भेजें',
  // incidents & dispatch
  'Incidents & Dispatch': 'घटनाएं एवं डिस्पैच', 'LIVE': 'लाइव',
  'No live incidents. Citizen reports from Kavach appear here for triage.':
    'कोई लाइव घटना नहीं। कवच से नागरिक रिपोर्ट यहाँ ट्राइएज के लिए दिखेंगी।',
  'Unassigned': 'अनिर्दिष्ट', 'Assigned': 'सौंपा गया', 'En route': 'रास्ते में',
  // ops console
  'Resource Readiness': 'संसाधन तैयारी', 'SACHET Alerts': 'सचेत अलर्ट', 'AI Relocation': 'AI पुनर्आवंटन',
  'Official Alerts — SACHET / IMD / NDMA': 'आधिकारिक अलर्ट — सचेत / IMD / NDMA',
  'Live CAP warnings pulled directly from the government SACHET feed. These are the same zones drawn as polygons on the map above.':
    'सरकारी सचेत फ़ीड से सीधे ली गई लाइव CAP चेतावनियाँ। ये वही ज़ोन हैं जो ऊपर मानचित्र पर पॉलीगॉन के रूप में दिखाए गए हैं।',
  'Refresh': 'रिफ़्रेश', 'Loading official alerts…': 'आधिकारिक अलर्ट लोड हो रहे हैं…',
  'AI Resource Relocation — Simulation': 'AI संसाधन पुनर्आवंटन — सिमुलेशन',
  'Runs the AI allocator on live incidents in this district and animates which unit moves to which cluster. Each run is pushed to the Kavach app.':
    'इस ज़िले की लाइव घटनाओं पर AI आवंटक चलाता है और दिखाता है कि कौन-सी इकाई किस क्लस्टर में जाती है। हर रन कवच ऐप को भेजा जाता है।',
  'Run AI Allocation': 'AI आवंटन चलाएं',
  'Select a district to load the relocation map': 'पुनर्आवंटन मानचित्र लोड करने हेतु ज़िला चुनें',
  'No allocation run yet.': 'अभी तक कोई आवंटन नहीं चला।', 'Idle.': 'निष्क्रिय।',
  'Current availability, deployment and operational demand.': 'वर्तमान उपलब्धता, तैनाती और परिचालन मांग।',
  'View All Resources': 'सभी संसाधन देखें',
  'Select a district to load live resources…': 'लाइव संसाधन लोड करने हेतु ज़िला चुनें…',
  // footer
  'Quick Links': 'त्वरित लिंक', 'Support': 'सहायता', 'Emergency Helpline': 'आपातकालीन हेल्पलाइन',
  'National Emergency': 'राष्ट्रीय आपातकाल', 'All India Emergency': 'अखिल भारतीय आपातकाल',
  'Privacy Policy': 'गोपनीयता नीति', 'Terms of Use': 'उपयोग की शर्तें',
  'Accessibility': 'सुगम्यता', 'Sitemap': 'साइटमैप', 'Help Center': 'सहायता केंद्र',
  'System Status': 'सिस्टम स्थिति', 'Feedback': 'प्रतिक्रिया', 'Guidelines': 'दिशानिर्देश',
  'About Us': 'हमारे बारे में', 'Careers': 'करियर', 'Media Center': 'मीडिया केंद्र', 'Contact Us': 'संपर्क करें',
  'Wind -- km/h': 'हवा -- कि.मी./घं.', 'Wind — km/h': 'हवा — कि.मी./घं.',
  '© 2025 RESQNET · Prototype — Smart India Hackathon': '© 2025 RESQNET · प्रोटोटाइप — स्मार्ट इंडिया हैकाथॉन',
  // district gate overlay
  'Select Your District': 'अपना ज़िला चुनें',
  'This dashboard, the map, alerts and resource data will all be scoped to the district you choose.':
    'यह डैशबोर्ड, मानचित्र, अलर्ट और संसाधन डेटा — सब आपके चुने ज़िले तक सीमित रहेंगे।',
  'State / UT': 'राज्य / केंद्रशासित प्रदेश', 'District': 'ज़िला',
  'Select state...': 'राज्य चुनें...', 'Select district...': 'ज़िला चुनें...',
  'Select state first...': 'पहले राज्य चुनें...', 'Loading districts...': 'ज़िले लोड हो रहे हैं...',
  'Continue': 'आगे बढ़ें', 'Loading...': 'लोड हो रहा है...',
  'Locating district...': 'ज़िला खोजा जा रहा है...',
  'Fetching precise boundary...': 'सटीक सीमा प्राप्त की जा रही है...',
  'Using approximate location...': 'अनुमानित स्थान का उपयोग...',
  // caller panel
  'Navigate →': 'रास्ता देखें →',
  // need tags (dispatch board)
  'rescue': 'बचाव', 'medical': 'चिकित्सा', 'food': 'भोजन', 'water': 'पानी',
  'shelter': 'आश्रय', 'evacuation': 'निकासी', 'other': 'अन्य',
  'CRITICAL': 'गंभीर', 'LOW': 'कम',
  // map layer switcher
  'Map layers': 'मानचित्र परतें', 'Complaints': 'शिकायतें', 'Weather / rain': 'मौसम / वर्षा',
  'SACHET zones': 'सचेत ज़ोन', 'Facilities': 'सुविधाएं', 'Complaint severity': 'शिकायत गंभीरता',
  'size = reports': 'आकार = रिपोर्ट', 'size = no. of reports': 'आकार = रिपोर्ट की संख्या',
  'Double-click the map to retarget the broadcast': 'ब्रॉडकास्ट लक्ष्य बदलने हेतु मानचित्र पर डबल-क्लिक करें',
  'Double-click to set the broadcast target': 'ब्रॉडकास्ट लक्ष्य सेट करने हेतु डबल-क्लिक करें',
  // footer + header
  'Report': 'रिपोर्ट', 'National Emergency': 'राष्ट्रीय आपातकाल',
  'All India Emergency': 'अखिल भारतीय आपातकाल',
  'National Disaster Response & Coordination System': 'राष्ट्रीय आपदा प्रतिक्रिया एवं समन्वय प्रणाली',
  'Prototype — Smart India Hackathon': 'प्रोटोटाइप — स्मार्ट इंडिया हैकाथॉन',
  // dispatch / relocation extras
  'In progress': 'प्रगति पर', 'En route': 'रास्ते में', 'Responding to:': 'प्रतिक्रिया हेतु:',
  'Run AI Allocation': 'AI आवंटन चलाएं',
  'Allocator returned no relocations for this district.': 'इस ज़िले के लिए कोई पुनर्आवंटन नहीं मिला।',
  'Working together for a safer, stronger and disaster-resilient India.':
    'एक सुरक्षित, मज़बूत और आपदा-सहनशील भारत के लिए मिलकर काम।',
  // header status chips
  'AI online': 'AI ऑनलाइन', 'AI offline': 'AI ऑफ़लाइन',
  'SACHET live': 'सचेत लाइव', 'SACHET offline': 'सचेत ऑफ़लाइन',
  'No district': 'कोई ज़िला नहीं', 'Report': 'रिपोर्ट',
  'Change state / district': 'राज्य / ज़िला बदलें',
  // quick-stat sub-labels
  'Rescue': 'बचाव', 'Medical': 'चिकित्सा', 'Fire & Rescue': 'अग्नि एवं बचाव',
  'Police / Security': 'पुलिस / सुरक्षा', 'Police': 'पुलिस', 'Hospitals': 'अस्पताल',
  'Ambulance': 'एम्बुलेंस', 'Fire': 'अग्निशमन',
  'Deployed': 'तैनात', 'Busy': 'व्यस्त', 'Readiness': 'तैयारी', 'Facilities': 'सुविधाएं',
  'Available': 'उपलब्ध',
  'None found in this district.': 'इस ज़िले में कोई नहीं मिला।',
  'Demand vs Supply': 'मांग बनाम आपूर्ति',
  // dispatch board
  'In progress': 'प्रगति पर', 'RESOLVED': 'हल हो गया',
  'No live incidents in this district.': 'इस ज़िले में कोई लाइव घटना नहीं।',
  'unassigned': 'अनिर्दिष्ट', 'active': 'सक्रिय', 'ppl': 'लोग', 'trapped': 'फँसे',
  'injured': 'घायल', 'Score': 'स्कोर', 'people affected': 'लोग प्रभावित',
  // SACHET alert cards / panel
  'No active official alerts.': 'कोई सक्रिय आधिकारिक अलर्ट नहीं।',
  'No official alerts for this district.': 'इस ज़िले के लिए कोई आधिकारिक अलर्ट नहीं।',
  'Affected area:': 'प्रभावित क्षेत्र:', 'Source:': 'स्रोत:', 'Expires:': 'समाप्ति:',
  'Effective:': 'प्रभावी:', 'Instructions:': 'निर्देश:', 'Severity:': 'गंभीरता:',
  'View official alert →': 'आधिकारिक अलर्ट देखें →',
  // broadcast panel + history
  'Recent broadcasts': 'हाल के ब्रॉडकास्ट',
  'Select a district first.': 'पहले एक ज़िला चुनें।',
  // relocation
  'Running AI allocation…': 'AI आवंटन चल रहा है…',
  'Facilities mapped': 'सुविधाएं मानचित्रित',
  'ETA': 'अनुमानित समय', 'units': 'इकाइयाँ', 'km': 'कि.मी.', 'min': 'मिनट',
  // generic
  'Loading…': 'लोड हो रहा है…', 'Loading...': 'लोड हो रहा है...',
  'Live': 'लाइव', 'Offline': 'ऑफ़लाइन', 'Online': 'ऑनलाइन',
};


// Current UI language, for generators that must emit Hindi directly
// (dynamic strings like "8 ppl · trapped" can't be dictionary-matched).

// The readiness cards are drawn by district-gate.js; re-drawing them
// lets the phrase sweep pick the new language up.
function renderResourceReadinessI18n() {
  if (typeof window.renderResourceReadiness === 'function' &&
      Array.isArray(window.resqnetDistrictResources)) {
    window.renderResourceReadiness(window.resqnetDistrictResources, [], false);
  }
}

function resqnetLang() {
  // _langMem is the in-flight choice; it is authoritative during a
  // language switch, before/while storage is being updated.
  return (_langMem || _lsGet(languageStorageKey) || 'en');
}
window.resqnetLang = resqnetLang;

let _phraseObserver = null;
let _phraseSweepQueued = false;

function _phraseSkip(node) {
  let p = node.parentElement;
  while (p && p !== document.body) {
    const tag = p.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'INPUT' || tag === 'TEXTAREA') return true;
    if (p.id === 'live-map' || p.id === 'relocation-map' || p.hasAttribute('data-i18n') ||
        p.hasAttribute('data-no-i18n')) return true;
    p = p.parentElement;
  }
  return false;
}

function applyPhraseSweep(language) {
  const root = document.body;
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  if (language === 'hi') {
    for (const n of nodes) {
      const t = (n.nodeValue || '').trim();
      if (!t) continue;
      const hit = RESQNET_PHRASES_HI[t];
      if (!hit || _phraseSkip(n)) continue;
      if (n.__i18nBase == null) n.__i18nBase = n.nodeValue;
      n.nodeValue = n.nodeValue.replace(t, hit);
    }
    _ensurePhraseObserver();
  } else {
    for (const n of nodes) {
      if (n.__i18nBase != null) { n.nodeValue = n.__i18nBase; n.__i18nBase = null; }
    }
  }
}

function _ensurePhraseObserver() {
  if (_phraseObserver) return;
  _phraseObserver = new MutationObserver(() => {
    const lang = _lsGet(languageStorageKey) || _langMem || 'en';
    if (lang !== 'hi' || _phraseSweepQueued) return;
    _phraseSweepQueued = true;
    requestAnimationFrame(() => {
      _phraseSweepQueued = false;
      applyPhraseSweep('hi');
    });
  });
  // Whole document — header status chips, dispatch board, SACHET cards,
  // resource readiness and relocation panels all re-render dynamically.
  _phraseObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function setTheme(theme) {
  const isDark = theme === 'dark';
  document.body.classList.toggle('dark-mode', isDark);

  document.querySelectorAll('[data-theme-icon]').forEach((icon) => {
    icon.className = isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
  });

  document.querySelectorAll('[data-theme-label]').forEach((label) => {
    label.textContent = isDark ? 'Light' : 'Dark';
  });

  // Swap the Azure basemap style so the map itself isn't a bright slab
  // in dark mode (labels/pins/polygons were washing out).
  try {
    const m = window.azureMapInstance || (typeof map !== 'undefined' ? map : null);
    if (m && typeof m.setStyle === 'function') {
      m.setStyle({ style: isDark ? 'night' : 'road_shaded_relief' });
    }
  } catch (_) { /* map not ready yet — constructor already picks the right style */ }
}

function scrollToTarget(targetId) {
  const target = document.getElementById(targetId);
  if (!target) {
    return;
  }

  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function initNavigation() {
  document.querySelectorAll('[data-scroll-to]').forEach((trigger) => {
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      scrollToTarget(trigger.getAttribute('data-scroll-to'));
    });
  });
}

const _lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const _lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
let _langMem = 'en';

function initThemeToggle() {
  document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextTheme = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
      setTheme(nextTheme);
      _lsSet(themeStorageKey, nextTheme);
    });
  });
}

function initLanguageToggle() {
  document.querySelectorAll('[data-lang-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const currentLanguage = _lsGet(languageStorageKey) || _langMem || 'en';
      const nextLanguage = currentLanguage === 'en' ? 'hi' : 'en';
      // Persist BEFORE rendering: the dynamic panels below read the
      // stored language, and would otherwise render the previous one.
      _langMem = nextLanguage;
      _lsSet(languageStorageKey, nextLanguage);
      setTextFromTranslations(nextLanguage);
    });
  });
}

function initNavActiveState() {
  const links = Array.from(document.querySelectorAll('[data-nav-link]'));
  if (links.length === 0) {
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }

        const currentId = entry.target.id;
        links.forEach((link) => {
          const isActive = link.getAttribute('data-scroll-to') === currentId;
          link.classList.toggle('border-brand-orange', isActive);
          link.classList.toggle('text-brand-orange', isActive);
          link.classList.toggle('border-b-4', isActive);
          link.classList.toggle('text-brand-blue', !isActive);
        });
      });
    },
    { rootMargin: '-45% 0px -45% 0px', threshold: 0.1 }
  );

  ['hero', 'emergencies', 'map-section', 'alerts', 'responses', 'resources'].forEach((sectionId) => {
    const section = document.getElementById(sectionId);
    if (section) {
      observer.observe(section);
    }
  });
}

/* ============================================================
   AREA ZONES — reference point used to classify a map click
   ============================================================ */
const BHUBANESWAR_ZONE = { lat: 20.2961, lng: 85.8245, zoom: 12 };
const ACTIVE_ALERT_RADIUS_KM = 60; // clicks within this radius of Bhubaneswar count as "Bhubaneswar"

let selectedArea = 'Bhubaneswar';
let selectedCoords = { lat: BHUBANESWAR_ZONE.lat, lng: BHUBANESWAR_ZONE.lng };

// Haversine distance between two lat/lng points, in kilometres
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function classifyArea(lat, lng) {
  // Once a district is selected everything on this page is scoped to
  // it, so a map click is always "<district>" -- never "Other Area".
  const d = window.resqnetDistrict;
  if (d && d.district) return d.district;

  const distance = distanceKm(lat, lng, BHUBANESWAR_ZONE.lat, BHUBANESWAR_ZONE.lng);
  return distance <= ACTIVE_ALERT_RADIUS_KM ? 'Bhubaneswar' : 'Selected Area';
}


/* ============================================================
   AZURE MAPS — COMPLETE INDIA DISASTER MAP ECOSYSTEM
   ------------------------------------------------------------
   Layers:
     1. Azure basemap
     2. Official Survey of India boundary overlay
     3. Azure live weather radar
     4. Official SACHET / IMD alert polygons
     5. Incident / resource / weather HTML markers

   IMPORTANT:
   The political outline is explicitly sourced from the Survey
   of India official India boundary dataset (converted to GeoJSON
   by a third party from the SOI-published shapefile). The Azure
   basemap is only the geographic basemap; the India boundary
   shown for political accuracy is the SOI boundary overlay.
   ============================================================ */

const AZURE_MAPS_KEY =
  window.RESQNET_AZURE_MAPS_KEY ||
  'YOUR_AZURE_MAPS_SUBSCRIPTION_KEY';

const AZURE_WEATHER_CURRENT_URL =
  'https://atlas.microsoft.com/weather/currentConditions/json';

const AZURE_RADAR_TILE_URL = () =>
  `https://atlas.microsoft.com/map/tile?api-version=2.0` +
  `&tilesetId=microsoft.weather.radar.main` +
  `&zoom={z}&x={x}&y={y}` +
  `&subscription-key=${encodeURIComponent(AZURE_MAPS_KEY)}`;

/*
 * This GeoJSON was generated from the Survey of India official
 * international-boundary shapefile. For production/hackathon
 * deployment, you can replace this URL with a local copy of the
 * same SOI-derived GeoJSON, e.g. ./data/india-official-boundary.geojson.
 */
const SOI_INDIA_BOUNDARY_SCRIPT =
  'https://gist.githubusercontent.com/answerquest/1674c24200b7afd734ad8e8829ecf6a6/raw/5d24fc76d4e43034cc9f1d78c6ed0bb2f28ef234/India_Outline_Map.js';

let map = null;
let weatherMarker = null;
let weatherPopup = null;
let mapSearchMarker = null;

let azureRadarLayer = null;
let indiaOfficialSource = null;
let indiaOfficialLineLayer = null;
let officialAlertSource = null;
let officialAlertPolygonLayer = null;
let officialAlertLineLayer = null;

// (complaint pins are now a data-driven BubbleLayer, see
//  renderIncidentMarkers / complaintSource — no HtmlMarker array needed)
let weatherMarkers = [];

let lastWeatherReading = null;
let azureMapReady = false;
let azureBoundaryReady = false;
let azureWeatherRadarReady = false;

function loadExternalScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-resqnet-src="${src}"]`)) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.resqnetSrc = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

function loadAzureMapsSdk() {
  if (window.atlas) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-resqnet-azure-sdk]');
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }

    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://atlas.microsoft.com/sdk/javascript/mapcontrol/3/atlas.min.css';
    document.head.appendChild(css);

    const script = document.createElement('script');
    script.src = 'https://atlas.microsoft.com/sdk/javascript/mapcontrol/3/atlas.min.js';
    script.async = true;
    script.defer = true;
    script.dataset.resqnetAzureSdk = '1';

    script.onload = resolve;
    script.onerror = () => reject(new Error('Azure Maps SDK failed to load'));

    document.head.appendChild(script);
  });
}

// Zone colour tokens — used by updateSeverityUI, renderSACHETPanel, and the SACHET feed cards.
// Keyed on the zone strings returned by sachetSeverityToZone().
const ZONE_STYLES = {
  severe:   { bg: 'bg-red-100',    text: 'text-red-700',    label: 'SEVERE',   border: '#C62828' },
  high:     { bg: 'bg-orange-100', text: 'text-orange-700', label: 'HIGH',     border: '#E65100' },
  moderate: { bg: 'bg-yellow-100', text: 'text-yellow-700', label: 'MODERATE', border: '#F9A825' },
  low:      { bg: 'bg-green-100',  text: 'text-green-700',  label: 'LOW',      border: '#43A047' },
  extreme:  { bg: 'bg-red-200',    text: 'text-red-900',    label: 'EXTREME',  border: '#8E0000' },
  minor:    { bg: 'bg-green-50',   text: 'text-green-600',  label: 'MINOR',    border: '#66BB6A' },
};

function sevColor(sev) {
  return {
    low: '#43A047',
    moderate: '#F9A825',
    high: '#E65100',
    severe: '#C62828',
    extreme: '#8E0000',
    minor: '#43A047'
  }[String(sev || '').toLowerCase()] || '#607D8B';
}

function azureWeatherSeverity(data) {
  const condition = String(
    data?.weatherText ||
    data?.condition?.text ||
    data?.weatherCondition?.description?.text ||
    ''
  ).toLowerCase();

  const temp =
    Number(data?.temperature?.value ?? data?.tempC ?? NaN);

  const precip =
    Number(data?.precipitationSummary?.pastHour?.value ??
           data?.precipMm ??
           NaN);

  if (
    condition.includes('thunder') ||
    condition.includes('storm') ||
    condition.includes('cyclone') ||
    precip >= 45 ||
    temp >= 42
  ) return 'severe';

  if (
    condition.includes('heavy rain') ||
    condition.includes('rain') ||
    condition.includes('shower') ||
    condition.includes('fog') ||
    condition.includes('mist') ||
    precip >= 15 ||
    temp >= 38
  ) return 'high';

  if (
    condition.includes('cloud') ||
    condition.includes('overcast') ||
    condition.includes('wind') ||
    precip >= 4 ||
    temp >= 34
  ) return 'moderate';

  return 'low';
}

function setWeatherText(data, label) {
  const weatherText =
    data?.weatherText ||
    data?.condition?.text ||
    data?.weatherCondition?.description?.text ||
    'Current conditions';

  const temp =
    data?.temperature?.value ??
    data?.tempC ??
    null;

  const wind =
    data?.wind?.speed?.value ??
    data?.windKph ??
    null;

  const humidity =
    data?.relativeHumidity ??
    data?.humidity ??
    null;

  const rain =
    data?.precipitationSummary?.pastHour?.value ??
    data?.precipMm ??
    null;

  const values = {
    'area-weather-location': label,
    'area-weather-condition': weatherText,
    'area-weather-temp': temp == null ? 'N/A' : `${Math.round(temp)}°C`,
    'area-weather-wind': wind == null ? 'Wind N/A' : `Wind ${Math.round(wind)} km/h`,
    'area-weather-rainfall': rain == null ? 'Rain N/A' : `Rain ${rain} mm`,
    'area-weather-humidity': humidity == null ? 'Humidity N/A' : `Humidity ${Math.round(humidity)}%`,
    'map-weather-temp': temp == null ? 'N/A' : `${Math.round(temp)}°C`,
    'map-weather-condition': weatherText
  };

  Object.entries(values).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  });

  // Update icon elements — use FontAwesome classes, never raw emoji (avoids encoding issues)
  const condLower = (weatherText || '').toLowerCase();
  let iconClass = 'fa-cloud-sun-rain';
  if (condLower.includes('thunder') || condLower.includes('storm')) iconClass = 'fa-cloud-bolt';
  else if (condLower.includes('snow')) iconClass = 'fa-snowflake';
  else if (condLower.includes('fog') || condLower.includes('mist')) iconClass = 'fa-smog';
  else if (condLower.includes('heavy rain') || condLower.includes('pour')) iconClass = 'fa-cloud-showers-heavy';
  else if (condLower.includes('rain') || condLower.includes('drizzle') || condLower.includes('shower')) iconClass = 'fa-cloud-rain';
  else if (condLower.includes('cloud') || condLower.includes('overcast')) iconClass = 'fa-cloud';
  else if (condLower.includes('clear') || condLower.includes('sunny')) iconClass = 'fa-sun';
  else if (condLower.includes('partly')) iconClass = 'fa-cloud-sun';
  else if (condLower.includes('wind')) iconClass = 'fa-wind';

  ['area-weather-icon', 'map-weather-icon'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
  });
}

async function fetchAzureWeather(lat, lng, label = 'Selected location') {

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  if (!AZURE_MAPS_KEY) {
    console.warn('[ResqNet] Azure Maps key is not configured.');
    setWeatherText({}, label);
    return null;
  }

  try {
    const url =
      `${AZURE_WEATHER_CURRENT_URL}?api-version=1.1` +
      `&query=${encodeURIComponent(`${lat},${lng}`)}` +
      `&subscription-key=${encodeURIComponent(AZURE_MAPS_KEY)}`;

    const response = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(`Azure Weather HTTP ${response.status}`);
    }

    const payload = await response.json();
    const data =
      Array.isArray(payload?.results)
        ? payload.results[0]
        : payload?.currentConditions?.[0] || payload;

    if (!data) throw new Error('Azure Weather returned no conditions');

    lastWeatherReading = { lat, lng, label, data };

    setWeatherText(data, label);
    updateSeverityUI();

    return data;
  } catch (error) {
    console.warn('[ResqNet] Azure Weather unavailable:', error.message);
    setWeatherText({}, label);
    lastWeatherReading = null;
    clearSeverityUI();
    return null;
  }
}

function clearSeverityUI() {
  ['area-weather-severity', 'map-weather-severity'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = '—';
    el.className =
      'text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-gray-100 text-gray-400';
  });

  ['area-weather-source', 'map-weather-source'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = '';
  });
}

function updateSeverityUI() {
  if (!lastWeatherReading) return;

  const { lat, lng, label, data } = lastWeatherReading;

  const official =
    typeof findOfficialZoneForPoint === 'function'
      ? findOfficialZoneForPoint(lat, lng, label)
      : null;

  const estimatedSeverity = azureWeatherSeverity(data);
  const zone = official ? official.zone : estimatedSeverity;
  const style = ZONE_STYLES[zone] || ZONE_STYLES.low;

  const badgeText = official
    ? severityLabel(official.alert.severity)
    : style.label;

  const sourceText = official
    ? `Official: ${official.alert.sender || 'SACHET / IMD'}`
    : 'Estimated from live Azure weather';

  ['area-weather-severity', 'map-weather-severity'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = badgeText;
    el.className =
      `text-[10px] font-extrabold px-2 py-0.5 rounded-full ${style.bg} ${style.text}`;
  });

  ['area-weather-source', 'map-weather-source'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = sourceText;
  });
}

/* ---------- Official Survey of India boundary ---------- */

async function loadOfficialIndiaBoundary() {
  if (!map || !window.atlas || azureBoundaryReady) return;

  try {
    /*
     * The script exposes `india_outline`, a GeoJSON FeatureCollection
     * converted from the Survey of India official boundary shapefile.
     */
    await loadExternalScript(SOI_INDIA_BOUNDARY_SCRIPT);

    if (!window.india_outline && typeof india_outline !== 'undefined') {
      window.india_outline = india_outline;
    }

    if (!window.india_outline) {
      throw new Error('SOI India boundary GeoJSON was not exposed');
    }

    indiaOfficialSource = new atlas.source.DataSource('soi-official-india-boundary');
    map.sources.add(indiaOfficialSource);

    indiaOfficialSource.add(window.india_outline);

    indiaOfficialLineLayer = new atlas.layer.LineLayer(
      indiaOfficialSource,
      'soi-official-india-boundary-line',
      {
        strokeColor: '#0B3D91',
        strokeWidth: 3,
        strokeOpacity: 1
      }
    );

    map.layers.add(indiaOfficialLineLayer);
    azureBoundaryReady = true;

    console.info('[ResqNet] Survey of India official boundary overlay loaded.');
  } catch (error) {
    console.error('[ResqNet] Official India boundary could not be loaded:', error);

    /*
     * Do not silently substitute another political boundary.
     * The basemap remains usable, but this warning makes it explicit
     * that the official SOI political outline is unavailable.
     */
    // The Azure basemap is already rendered with view:'IN', so India's
    // official boundaries are correct without this optional overlay.
    // Log it for diagnostics instead of putting a red banner on the map.
    console.info('[ResqNet] Optional SOI boundary overlay unavailable — ' +
                 'basemap already uses the India (view:IN) boundary set.');
  }
}

/* ---------- Azure weather radar ---------- */

function initAzureRadarLayer() {
  if (!map || !window.atlas || azureWeatherRadarReady) return;

  try {
    azureRadarLayer = new atlas.layer.TileLayer(
      {
        tileUrl: AZURE_RADAR_TILE_URL(),
        opacity: 0.72,
        tileSize: 256
      },
      'azure-live-weather-radar'
    );

    map.layers.add(azureRadarLayer);
    azureWeatherRadarReady = true;
  } catch (error) {
    console.warn('[ResqNet] Azure radar layer failed:', error.message);
  }
}

/* ---------- Weather markers ---------- */

function makeWeatherMarker(w) {
  const color = sevColor(w.severity || 'low');

  return new atlas.HtmlMarker({
    position: [Number(w.lng), Number(w.lat)],
    html: `
      <div
        title="${escapeHtml(w.city || 'Weather')}"
        style="
          padding:5px 8px;
          border-radius:999px;
          border:2px solid rgba(255,255,255,.95);
          background:${color};
          color:#fff;
          font-size:10px;
          font-weight:800;
          line-height:1;
          box-shadow:0 6px 18px rgba(15,23,42,.25);
          white-space:nowrap;
          min-width:28px;
          text-align:center;
          cursor:pointer;
        "
      >${escapeHtml(w.icon || '•')}</div>
    `
  });
}

function renderAzureWeatherMarkers() {
  if (!map?.markers || !Array.isArray(MockDB.weatherData)) return;

  weatherMarkers.forEach((marker) => {
    try { map.markers.remove(marker); } catch (_) {}
  });
  weatherMarkers = [];

  MockDB.weatherData
    .filter((w) => Number.isFinite(Number(w.lat)) && Number.isFinite(Number(w.lng)))
    .forEach((w) => {
      const marker = makeWeatherMarker(w);

      marker.getElement?.().addEventListener('click', () => {
        const content = `
          <div style="font-family:Inter,sans-serif;padding:4px;min-width:180px">
            <strong>${escapeHtml(w.city || 'Weather')}</strong>
            <div style="margin-top:5px">${escapeHtml(w.icon || '')} ${escapeHtml(w.condition || 'Current weather')}</div>
            <div style="margin-top:4px">
              🌧 ${w.rainfall ?? 'N/A'} mm · 🌡 ${w.temp ?? 'N/A'}°C
            </div>
            <div style="margin-top:2px">
              💨 ${w.wind ?? 'N/A'} km/h · 💧 ${w.humidity ?? 'N/A'}%
            </div>
            <div style="margin-top:5px;font-weight:800;color:${sevColor(w.severity)}">
              ${escapeHtml(String(w.severity || 'low').toUpperCase())}
            </div>
          </div>
        `;

        if (!weatherPopup) {
          weatherPopup = new atlas.Popup({
            pixelOffset: [0, -18],
            closeButton: true
          });
        }

        weatherPopup.setOptions({
          position: [Number(w.lng), Number(w.lat)],
          content
        });
        weatherPopup.open(map);
      });

      map.markers.add(marker);
      weatherMarkers.push(marker);
    });
}

/* ---------- Incident / resource markers ---------- */

/* ============================================================
   COMPLAINT DENSITY LAYER
   Every citizen complaint is a small dot on the map. Reports coming
   from the same spot are merged into ONE dot whose radius grows with
   how many complaints it represents, so a street generating 12 calls
   reads instantly as a hotspot instead of 12 overlapping pins.
   Colour follows the worst priority in the group.
   ============================================================ */

// ~550 m grid. Complaints inside one cell are treated as "same place".
const COMPLAINT_GRID_DEG = 0.005;

let complaintSource = null;

// Standard triage palette: red / orange / amber / green. The old LOW
// and fallback colour was slate-blue, which read as "informational"
// rather than "least urgent" and, while every incident was scoring
// LOW, turned the whole map blue.
const COMPLAINT_LEVEL_COLORS = {
  CRITICAL: '#c62828',
  HIGH: '#ef6c00',
  MEDIUM: '#f9a825',
  LOW: '#2e7d32',
  UNKNOWN: '#78716c',
};

function _complaintColorExpr() {
  return [
    'match', ['get', 'level'],
    'CRITICAL', COMPLAINT_LEVEL_COLORS.CRITICAL,
    'HIGH', COMPLAINT_LEVEL_COLORS.HIGH,
    'MEDIUM', COMPLAINT_LEVEL_COLORS.MEDIUM,
    'LOW', COMPLAINT_LEVEL_COLORS.LOW,
    COMPLAINT_LEVEL_COLORS.UNKNOWN,
  ];
}

// Darker rim of the same hue, so a dot stays legible on both the light
// and the dark basemap without a white halo washing the colour out.
function _complaintStrokeExpr() {
  return [
    'match', ['get', 'level'],
    'CRITICAL', '#7f1d1d',
    'HIGH', '#9a3412',
    'MEDIUM', '#a16207',
    'LOW', '#14532d',
    '#44403c',
  ];
}

function renderIncidentMarkers() {
  if (!map || !window.atlas || !azureMapReady) return;

  if (!complaintSource) {
    complaintSource = new atlas.source.DataSource('complaint-density');
    map.sources.add(complaintSource);

    // Dot: radius scales with the number of complaints in the cell.
    map.layers.add(
      new atlas.layer.BubbleLayer(complaintSource, 'complaint-density-dot', {
        radius: [
          'interpolate', ['linear'], ['get', 'count'],
          1, 5,
          2, 8,
          5, 13,
          10, 18,
          25, 26,
        ],
        color: _complaintColorExpr(),
        strokeColor: _complaintStrokeExpr(),
        strokeWidth: 2,
        opacity: 0.9,
      })
    );

    // Count label, only once a cell holds more than one complaint.
    map.layers.add(
      new atlas.layer.SymbolLayer(complaintSource, 'complaint-density-count', {
        iconOptions: { image: 'none' },
        textOptions: {
          textField: [
            'case',
            ['>', ['get', 'count'], 1],
            ['to-string', ['get', 'count']],
            '',
          ],
          color: '#ffffff',
          size: 11,
          font: ['SegoeUi-Bold'],
          offset: [0, 0.1],
          allowOverlap: true,
        },
      })
    );

    map.events.add('click', 'complaint-density-dot', (event) => {
      const shape = event?.shapes?.[0];
      if (!shape) return;
      const p = shape.getProperties?.() || {};
      if (!weatherPopup) weatherPopup = new atlas.Popup({ closeButton: true });
      weatherPopup.setOptions({
        position: shape.getCoordinates?.() || event.position,
        content: `
          <div style="font-family:Inter,sans-serif;padding:8px;min-width:200px">
            <div style="font-weight:800;color:${sevColor((p.level || 'low').toLowerCase())}">
              ${escapeHtml(String(p.count))} complaint${p.count > 1 ? 's' : ''} from this location
            </div>
            <div style="margin-top:4px;font-size:12px;color:#333">
              ${escapeHtml(String(p.people || 0))} people affected${p.trapped ? ' · trapped reported' : ''}${p.injured ? ' · injuries reported' : ''}
            </div>
            <div style="margin-top:4px;font-size:11px;color:#666">
              Worst priority: <strong>${escapeHtml(p.level || 'LOW')}</strong>
            </div>
            <div style="margin-top:6px;font-size:10px;color:#888">${escapeHtml(p.ids || '')}</div>
          </div>`,
      });
      weatherPopup.open(map);
    });
  }

  // ---- group live incidents into grid cells ----
  const cells = new Map();

  liveIncidents.forEach((inc, docId) => {
    if ((inc.status || '').toUpperCase() === 'RESOLVED') return;
    if (!incidentInDistrict(inc)) return;

    const lat = Number(inc.latitude);
    const lng = Number(inc.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const key =
      Math.round(lat / COMPLAINT_GRID_DEG) + ':' +
      Math.round(lng / COMPLAINT_GRID_DEG);

    let cell = cells.get(key);
    if (!cell) {
      cell = { lat: 0, lng: 0, count: 0, people: 0, trapped: false, injured: false, rank: 0, level: 'LOW', ids: [] };
      cells.set(key, cell);
    }

    cell.lat += lat;
    cell.lng += lng;
    cell.count += 1;
    cell.people += Number(inc.facts?.people_count) || 1;
    if (inc.facts?.trapped) cell.trapped = true;
    if (inc.facts?.injured) cell.injured = true;
    cell.ids.push(inc.incident_id || docId);

    const level = (inc.priority?.level || 'HIGH').toUpperCase();
    const rank = PRIO_RANK[level] || 0;
    if (rank >= cell.rank) { cell.rank = rank; cell.level = level; }
  });

  complaintSource.clear();

  cells.forEach((cell) => {
    complaintSource.add(
      new atlas.data.Feature(
        new atlas.data.Point([cell.lng / cell.count, cell.lat / cell.count]),
        {
          count: cell.count,
          people: cell.people,
          trapped: cell.trapped,
          injured: cell.injured,
          level: cell.level,
          ids: cell.ids.slice(0, 6).join(', ') + (cell.ids.length > 6 ? ` +${cell.ids.length - 6} more` : ''),
        }
      )
    );
  });

  try { applyMapLayerState(); } catch (_) {}
}

/* ============================================================
   MAP LAYER SWITCHER
   Complaints / weather radar / SACHET zones / facilities can each be
   turned off so the operator can isolate what they need to read.
   State is remembered so a district switch or redraw keeps it.
   ============================================================ */
const mapLayerState = { complaints: true, weather: true, sachet: true, facilities: true };

function _setAzureLayerVisible(layerId, visible) {
  if (!map || !map.layers) return;
  try {
    const layer = map.layers.getLayers().find(
      (l) => l.getId && l.getId() === layerId
    );
    if (layer && layer.setOptions) layer.setOptions({ visible: !!visible });
  } catch (err) {
    console.warn('[ResqNet] layer toggle failed for', layerId, err);
  }
}

function applyMapLayerState() {
  _setAzureLayerVisible('complaint-density-dot', mapLayerState.complaints);
  _setAzureLayerVisible('complaint-density-count', mapLayerState.complaints);

  _setAzureLayerVisible('azure-live-weather-radar', mapLayerState.weather);

  _setAzureLayerVisible('official-sachet-alert-fill', mapLayerState.sachet);
  _setAzureLayerVisible('official-sachet-alert-outline', mapLayerState.sachet);

  // Facility pins are HtmlMarkers, handled by district-gate.js.
  window.resqnetShowFacilities = mapLayerState.facilities;
  if (typeof window.applyFacilityVisibility === 'function') {
    window.applyFacilityVisibility();
  }
}

function setMapLayer(name, visible) {
  if (!(name in mapLayerState)) return;
  mapLayerState[name] = !!visible;
  applyMapLayerState();
}

window.setMapLayer = setMapLayer;
window.applyMapLayerState = applyMapLayerState;

/* ---------- Map search ---------- */

async function searchMapLocation() {
  const input = document.getElementById('map-search-input');
  const query = (input?.value || '').trim();

  if (!query || !map) {
    if (query === '') showToast?.('Enter a location name to search', 'warning');
    return;
  }

  try {
    /*
     * Azure Search is intentionally used for geocoding so the map,
     * weather and camera all remain inside the Azure Maps ecosystem.
     */
    const url =
      `https://atlas.microsoft.com/search/address/json?api-version=1.0` +
      `&countrySet=IN&limit=1&query=${encodeURIComponent(query)}` +
      `&subscription-key=${encodeURIComponent(AZURE_MAPS_KEY)}`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Azure Search HTTP ${response.status}`);

    const data = await response.json();
    const result = data?.results?.[0];

    if (!result?.position) {
      showToast?.('No location found in India.', 'warning');
      return;
    }

    const lat = Number(result.position.lat);
    const lon = Number(result.position.lon);
    const label =
      result.address?.freeformAddress ||
      result.poi?.name ||
      query;

    map.setCamera({
      center: [lon, lat],
      zoom: 8,
      pitch: 0,
      bearing: 0
    });

    if (map.markers) {
      if (mapSearchMarker) {
        try { map.markers.remove(mapSearchMarker); } catch (_) {}
      }

      mapSearchMarker = new atlas.HtmlMarker({
        position: [lon, lat],
        html: `
          <div style="
            padding:6px 10px;
            border-radius:999px;
            background:#1565C0;
            border:2px solid rgba(255,255,255,.95);
            color:#fff;
            font-size:11px;
            font-weight:800;
            box-shadow:0 5px 16px rgba(0,0,0,.25);
          ">${escapeHtml(label)}</div>
        `
      });

      map.markers.add(mapSearchMarker);
    }

    await selectAreaFromMap(lat, lon, label);
  } catch (error) {
    console.error('[ResqNet] Azure map search failed:', error);
    showToast?.('Location search failed.', 'warning');
  }
}

/* ---------- GPS / exact location ---------- */

async function requestUserLocation({ silent = false } = {}) {
  const statusEl = document.getElementById('location-status');

  if (!navigator.geolocation) {
    if (!silent && statusEl) {
      statusEl.textContent = 'Geolocation is not available in this browser.';
    }
    return null;
  }

  if (!silent && statusEl) {
    statusEl.textContent = '📍 Detecting your exact location…';
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;

        try {
          const reverseUrl =
            `https://atlas.microsoft.com/search/address/reverse/json?api-version=1.0` +
            `&query=${lat},${lng}` +
            `&subscription-key=${encodeURIComponent(AZURE_MAPS_KEY)}`;

          const res = await fetch(reverseUrl);
          const json = res.ok ? await res.json() : null;
          const result = json?.addresses?.[0];
          const label =
            result?.address?.freeformAddress ||
            `${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E`;

          selectedArea = label;
          selectedCoords = { lat, lng };

          map?.setCamera({
            center: [lng, lat],
            zoom: 11,
            pitch: 0,
            bearing: 0
          });

          await fetchAzureWeather(lat, lng, label);

          if (statusEl) {
            statusEl.textContent =
              `✅ Exact location: ${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E`;
          }

          resolve({ lat, lng, label });
        } catch (error) {
          console.warn('[ResqNet] Reverse geocoding failed:', error);

          await fetchAzureWeather(
            lat,
            lng,
            `${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E`
          );

          resolve({
            lat,
            lng,
            label: `${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E`
          });
        }
      },
      (error) => {
        if (statusEl) {
          statusEl.textContent =
            error.code === 1
              ? 'Location permission denied.'
              : 'Could not determine your location.';
        }
        resolve(null);
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 60000
      }
    );
  });
}

async function selectAreaFromMap(lat, lng, label = classifyArea(lat, lng)) {
  selectedArea = label;
  selectedCoords = { lat, lng };

  const nameEl = document.getElementById('selected-area-name');
  if (nameEl) nameEl.textContent = label;

  const statusEl = document.getElementById('broadcast-status');
  if (statusEl) statusEl.classList.add('hidden');

  const weatherData = await fetchAzureWeather(lat, lng, label);

  if (map) {
    if (!weatherMarker) {
      weatherMarker = new atlas.HtmlMarker({
        position: [lng, lat],
        html: `
          <div style="
            width:38px;height:38px;border-radius:50%;
            background:#1565C0;border:3px solid #fff;
            display:flex;align-items:center;justify-content:center;
            color:#fff;font-size:17px;font-weight:900;
            box-shadow:0 5px 16px rgba(0,0,0,.3);
          ">☁</div>
        `
      });
      map.markers.add(weatherMarker);
    } else {
      weatherMarker.setOptions({ position: [lng, lat] });
    }

    if (weatherData) {
      if (!weatherPopup) {
        weatherPopup = new atlas.Popup({
          pixelOffset: [0, -22],
          closeButton: true
        });
      }

      const condition =
        weatherData.weatherText ||
        weatherData.condition?.text ||
        'Current conditions';

      const temp =
        weatherData.temperature?.value ??
        weatherData.tempC ??
        'N/A';

      const wind =
        weatherData.wind?.speed?.value ??
        weatherData.windKph ??
        'N/A';

      weatherPopup.setOptions({
        position: [lng, lat],
        content: `
          <div style="font-family:sans-serif;font-size:13px;min-width:170px;padding:3px">
            <strong>${escapeHtml(label)}</strong><br/>
            ${escapeHtml(condition)}<br/>
            ${temp === 'N/A' ? 'Temp N/A' : `${Math.round(temp)}°C`}
            · Wind ${wind === 'N/A' ? 'N/A' : `${Math.round(wind)} km/h`}
          </div>
        `
      });

      weatherPopup.open(map);
    }
  }
}

/* ---------- Azure map initialization ---------- */

async function initMap() {
  const mapElement = document.getElementById('live-map');
  if (!mapElement) return;

  try {
    await loadAzureMapsSdk();

    if (!window.atlas) {
      throw new Error('Azure Maps SDK is unavailable');
    }

    map = new atlas.Map(mapElement, {
      center: [78.9629, 22.5937],
      zoom: 4.4,
      pitch: 0,
      bearing: 0,
      style: document.body.classList.contains('dark-mode') ? 'night' : 'road_shaded_relief',
      // Render India's official international boundaries (J&K, Ladakh,
      // Arunachal Pradesh) as per the Government of India.
      view: 'IN',
      authOptions: {
        authType: 'subscriptionKey',
        subscriptionKey: AZURE_MAPS_KEY
      }
    });

    window.azureMapInstance = map;
    window.map = map;

    map.events.add('ready', async () => {
      azureMapReady = true;

      /*
       * Required render order:
       * Azure basemap
       * → official SOI India boundary
       * → Azure radar
       * → SACHET/IMD official polygons
       * → weather + incident/resource HTML markers
       */
      await loadOfficialIndiaBoundary();
      initAzureRadarLayer();

      renderOfficialAlertZones();
      renderAzureWeatherMarkers();
      renderIncidentMarkers();
      applyMapLayerState();
      startRealtimeListeners();
      // markers for incidents that arrived before the map was ready
      liveIncidents.forEach((inc) => { try { addLiveIncidentMarker(inc); } catch (_) {} });

      // If a district is already chosen, centre + select on it;
      // otherwise fall back to the national view + Bhubaneswar.
      const d = window.resqnetDistrict;
      if (d && d.center) {
        await selectAreaFromMap(d.center.lat, d.center.lon, d.district);
      } else {
        map.setCamera({ center: [78.9629, 22.5937], zoom: 4.4, pitch: 0, bearing: 0 });
        await selectAreaFromMap(BHUBANESWAR_ZONE.lat, BHUBANESWAR_ZONE.lng, 'Bhubaneswar');
      }
    });

    // DOUBLE-click (not single) retargets the broadcast. A single click
    // was firing on every incidental pan/inspect, dropping a marker and
    // silently moving the broadcast target.
    map.events.add('dblclick', (event) => {
      const pos = event.position;
      if (!pos) return;

      const lng = Number(pos[0]);
      const lat = Number(pos[1]);

      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        selectAreaFromMap(lat, lng, classifyArea(lat, lng));
      }
    });
  } catch (error) {
    console.error('[ResqNet] Azure Maps initialization failed:', error);

    mapElement.innerHTML = `
      <div style="
        display:flex;align-items:center;justify-content:center;
        height:100%;background:#f3f4f6;color:#1f2937;
        padding:24px;text-align:center;
      ">
        <div>
          <div style="font-size:20px;font-weight:700;margin-bottom:8px;">
            Azure Maps unavailable
          </div>
          <div style="font-size:14px;opacity:.8;">
            Configure a valid Azure Maps subscription key.
          </div>
        </div>
      </div>
    `;
  }
}

window.initMap = initMap;
window.searchMapLocation = searchMapLocation;
window.requestUserLocation = requestUserLocation;
window.selectAreaFromMap = selectAreaFromMap;
window.fetchAzureWeather = fetchAzureWeather;

/* ============================================================
   SACHET / NDMA OFFICIAL ALERT ZONES
   Fetches https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml
   then loads the CAP XML for every item to extract polygon coordinates
   and overlays them on the Azure map coloured by severity.
   ============================================================ */
// SACHET NDMA base URL
const SACHET_BASE   = 'https://sachet.ndma.gov.in';
const SACHET_RSS    = SACHET_BASE + '/cap_public_website/rss/rss_india.xml';

// Cloudflare Worker proxy — preferred once deployed (always-on, no
// local server). See sachet-worker/ and config.js.
const SACHET_PROXY  = (window.RESQNET_SACHET_PROXY || '').replace(/\/+$/, '');

// Local proxy (run: node sachet-proxy.js) — checked at startup
const LOCAL_PROXY   = 'http://localhost:3001';
let   localProxyOK  = false;   // set to true if health-check passes

// Public CORS proxy fallbacks (tried if local proxy is unavailable)
const CORS_PROXIES = [
  'https://test.cors.workers.dev/?',        // Cloudflare-hosted, reliable
  'https://api.allorigins.win/raw?url=',
  'https://api.codetabs.com/v1/proxy/?quest=',
  'https://corsproxy.io/?url=',
  'https://thingproxy.freeboard.io/fetch/',
];

let sachetAlerts = [];     // populated by fetchSACHETAlerts
let sachetUnavailable = false;
let officialAlertPolygons = [];   // legacy – kept for compat
let officialAlertInfoWindow = null;

// Check once at startup whether the local proxy is running
async function detectLocalProxy() {
  try {
    const r = await fetch(`${LOCAL_PROXY}/health`, { signal: AbortSignal.timeout(1500) });
    localProxyOK = r.ok;
    if (localProxyOK) console.info('[SACHET] Local proxy detected on port 3001 ✓');
  } catch (_) {
    localProxyOK = false;
  }
}


function normSeverity(raw) {
  const s = (raw || '').toLowerCase();
  if (s.includes('extreme'))  return 'extreme';
  if (s.includes('severe'))   return 'severe';
  if (s.includes('moderate')) return 'moderate';
  if (s.includes('minor'))    return 'minor';
  if (s.includes('red'))      return 'extreme';
  if (s.includes('orange'))   return 'severe';
  if (s.includes('yellow'))   return 'moderate';
  if (s.includes('green'))    return 'minor';
  return 'unknown';
}

function severityLabel(key) {
  return ({ extreme: 'EXTREME', severe: 'SEVERE', moderate: 'MODERATE', minor: 'MINOR', unknown: 'UNKNOWN' })[key] || (key || '').toUpperCase();
}

// Maps SACHET/CAP severity vocabulary onto the zone colours used below.
function sachetSeverityToZone(sachetSeverity) {
  return {
    extreme:  'severe',
    severe:   'high',
    moderate: 'moderate',
    minor:    'low',
  }[sachetSeverity] || null;
}

function relativeTime(dateStr) {
  if (!dateStr) return '';
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.round(diff / 60000);
    if (mins < 2)   return 'Just now';
    if (mins < 60)  return mins + 'm ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 24)   return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  } catch (_) { return ''; }
}

// CAP <polygon> is a space-separated list of "lat,lon" pairs.
function parseCapPolygon(text) {
  try {
    const points = text.trim().split(/\s+/).map((pair) => {
      const [latStr, lngStr] = pair.split(',');
      const lat = Number(latStr), lng = Number(lngStr);
      return (Number.isFinite(lat) && Number.isFinite(lng)) ? { lat, lng } : null;
    }).filter(Boolean);
    return points.length >= 3 ? points : null;
  } catch (_) {
    return null;
  }
}

// CAP <circle> is "lat,lon radiusKm".
function parseCapCircle(text) {
  try {
    const [center, radiusStr] = text.trim().split(/\s+/);
    const [latStr, lngStr] = (center || '').split(',');
    const lat = Number(latStr), lng = Number(lngStr), radiusKm = Number(radiusStr);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radiusKm)) {
      return { lat, lng, radiusKm };
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Ray-casting point-in-polygon test on {lat,lng} objects.
function pointInPolygon(lat, lng, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = polygon[i].lat, xi = polygon[i].lng;
    const yj = polygon[j].lat, xj = polygon[j].lng;
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// True if a CAP alert is currently active based on effective/onset/expires.
function isAlertActive(alert) {
  const now = Date.now();
  const starts = alert.effective || alert.onset;
  if (starts) {
    const startTime = new Date(starts).getTime();
    if (Number.isFinite(startTime) && startTime > now) return false;
  }
  if (alert.expires) {
    const expiryTime = new Date(alert.expires).getTime();
    if (Number.isFinite(expiryTime) && expiryTime < now) return false;
  }
  return true;
}

// Checks whether a lat/lng point falls inside any active SACHET alert zone
// (polygon → circle → area-text fallback, in that priority order).
function findOfficialZoneForPoint(lat, lng, areaHint) {
  const activeAlerts = sachetAlerts.filter(isAlertActive);
  const hintLower = (areaHint || '').toLowerCase();

  const match = activeAlerts.find((a) => a.polygon && a.polygon.length >= 3 && pointInPolygon(lat, lng, a.polygon))
    || activeAlerts.find((a) => a.circle && distanceKm(lat, lng, a.circle.lat, a.circle.lng) <= a.circle.radiusKm)
    || activeAlerts.find((a) => {
      if (!hintLower) return false;
      const area = (a.areaDesc || '').toLowerCase();
      return area.includes(hintLower) || (area && hintLower.includes(area));
    });

  if (!match) return null;
  const zone = sachetSeverityToZone(match.severity);
  if (!zone) return null;
  return { zone, alert: match };
}

// Fetch a SACHET URL: tries local proxy first, then public CORS proxies.
async function fetchSachetUrl(sachetUrl, timeoutMs = 18000) {
  // 0. Cloudflare Worker proxy (preferred — always-on, no local server)
  if (SACHET_PROXY) {
    try {
      const workerUrl = sachetUrl.replace(SACHET_BASE, SACHET_PROXY);
      const res = await fetch(workerUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) { console.info('[SACHET] via Worker'); return res; }
      const snippet = (await res.clone().text().catch(() => '')).slice(0, 160);
      console.warn(`[SACHET] Worker ${SACHET_PROXY} returned HTTP ${res.status} — ${snippet}`);
    } catch (e) {
      console.warn(`[SACHET] Worker ${SACHET_PROXY} unreachable (${e.name}: ${e.message}). ` +
        'Check the exact URL "wrangler deploy" printed and open <url>/health in a browser.');
    }
  }

  // 1. Local proxy (most reliable in local dev)
  if (localProxyOK) {
    try {
      const localUrl = sachetUrl.replace(SACHET_BASE, LOCAL_PROXY);
      const res = await fetch(localUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return res;
    } catch (e) {
      console.warn('[SACHET] Local proxy failed, falling back to CORS proxies:', e.message);
      localProxyOK = false;
    }
  }

  // 2. Public CORS proxies (flaky — the Worker is the real fix)
  let lastErr = null;
  for (const proxy of CORS_PROXIES) {
    try {
      const proxyUrl = proxy + encodeURIComponent(sachetUrl);
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) { console.info('[SACHET] via CORS proxy', proxy); return res; }
      lastErr = new Error('HTTP ' + res.status + ' (' + proxy + ')');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All SACHET proxies failed for: ' + sachetUrl);
}

// Keep fetchViaCorsProxy as alias for backward compat
const fetchViaCorsProxy = fetchSachetUrl;

// Helper: extract text of a namespaced tag (handles both bare and cap: prefix).
function capText(doc, tag) {
  // Try bare tag first, then cap: prefixed version
  return (doc.querySelector(tag)?.textContent
       || doc.querySelector('cap\\:' + tag)?.textContent
       || doc.getElementsByTagNameNS('urn:oasis:names:tc:emergency:cap:1.2', tag)?.[0]?.textContent
       || '').trim();
}
function capTextEl(el, tag) {
  return (el.querySelector(tag)?.textContent
       || el.querySelector('cap\\:' + tag)?.textContent
       || el.getElementsByTagNameNS('urn:oasis:names:tc:emergency:cap:1.2', tag)?.[0]?.textContent
       || '').trim();
}
function capAll(doc, tag) {
  const bare = Array.from(doc.querySelectorAll(tag));
  if (bare.length) return bare;
  const ns = Array.from(doc.getElementsByTagNameNS('urn:oasis:names:tc:emergency:cap:1.2', tag));
  return ns;
}

// Fetch one CAP XML + its separate FetchPolygonXMLFile and enrich the alert object.
async function loadCAPDetail(alert) {
  if (!alert.link || alert.link === '#') return;
  try {
    const res  = await fetchSachetUrl(alert.link, 14000);
    const text = await res.text();
    const cap  = new DOMParser().parseFromString(text, 'application/xml');
    if (cap.querySelector('parsererror')) return;

    // ── Extract metadata from first <info> (supports cap: namespace) ──
    const infos     = capAll(cap, 'info');
    const firstInfo = infos[0];
    if (firstInfo) {
      const ev = capTextEl(firstInfo, 'event');       if (ev)  alert.event     = ev;
      const sv = capTextEl(firstInfo, 'severity');    if (sv)  alert.severity  = normSeverity(sv);
      const ef = capTextEl(firstInfo, 'effective');   if (ef)  alert.effective = ef;
      const on = capTextEl(firstInfo, 'onset');       if (on)  alert.onset     = on;
      const ex = capTextEl(firstInfo, 'expires');     if (ex)  alert.expires   = ex;
      const hl = capTextEl(firstInfo, 'headline');    if (hl)  alert.headline  = hl;
      const ins= capTextEl(firstInfo, 'instruction'); if (ins) alert.instruction = ins;
      const sn = capTextEl(firstInfo, 'senderName');  if (sn)  alert.sender    = sn;
    }

    // ── Collect area descriptions + look for polygon URL in <parameter> ──
    const allPolygons = [];
    const allCircles  = [];
    const areaDescs   = [];
    let   polygonUrl  = '';

    // Extract Polygon URL from <cap:parameter> where valueName = 'Polygon URL'
    capAll(cap, 'parameter').forEach(param => {
      const vn = capTextEl(param, 'valueName');
      const v  = capTextEl(param, 'value');
      if (vn === 'Polygon URL' && v) polygonUrl = v;
    });

    infos.forEach(info => {
      capAll(info, 'area').forEach(area => {
        const desc = capTextEl(area, 'areaDesc');
        if (desc && !areaDescs.includes(desc)) areaDescs.push(desc);

        // Inline polygon (rare in SACHET but handle anyway)
        capAll(area, 'polygon').forEach(polyEl => {
          const pts = parseCapPolygon(polyEl.textContent);
          if (pts) allPolygons.push(pts);
        });
        capAll(area, 'circle').forEach(circEl => {
          const c = parseCapCircle(circEl.textContent);
          if (c) allCircles.push(c);
        });
      });
    });

    if (areaDescs.length) alert.areaDesc = areaDescs.join(' | ');
    alert.capLoaded = true;

    // ── Fetch the separate Polygon XML file (SACHET stores polygons there) ──
    if (polygonUrl && allPolygons.length === 0) {
      try {
        const polyRes  = await fetchSachetUrl(polygonUrl, 12000);
        const polyText = await polyRes.text();
        const polyDoc  = new DOMParser().parseFromString(polyText, 'application/xml');
        if (!polyDoc.querySelector('parsererror')) {
          capAll(polyDoc, 'polygon').forEach(polyEl => {
            const pts = parseCapPolygon(polyEl.textContent);
            if (pts) allPolygons.push(pts);
          });
        }
      } catch (polyErr) {
        console.warn('[SACHET] Polygon fetch failed for', polygonUrl, polyErr.message);
      }
    }

    if (allPolygons.length) { alert.polygons = allPolygons; alert.polygon = allPolygons[0]; }
    if (allCircles.length)  { alert.circles  = allCircles;  alert.circle  = allCircles[0];  }

    console.info(`[SACHET] ${alert.event || alert.title} | polygons=${allPolygons.length} area='${(alert.areaDesc||'').substring(0,40)}'`);
  } catch (err) {
    console.warn('[SACHET] CAP detail failed for', alert.link, err.message);
  }
}

async function fetchSACHETAlerts() {
  const panel = document.getElementById('sachet-alerts-panel');
  const btn   = document.getElementById('sachet-refresh-btn');
  if (btn)   btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading&hellip;';
  if (panel) panel.innerHTML = '<div class="p-4 text-xs text-gray-400 flex items-center gap-2"><i class="fa-solid fa-spinner fa-spin"></i> Fetching live alerts from SACHET NDMA&hellip;</div>';

  try {
    // ── Step 1: Fetch the master RSS feed ──────────────────────
    const res  = await fetchViaCorsProxy(SACHET_RSS, 25000);
    const text = await res.text();
    const xml  = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('RSS XML parse error');

    // Take ALL items (no artificial cap)
    const items = Array.from(xml.querySelectorAll('item'));
    if (!items.length) throw new Error('RSS feed returned zero items');

    // ── Step 2: Build initial alert objects from RSS ───────────
    sachetAlerts = items.map(item => {
      const title   = (item.querySelector('title')?.textContent   || '').trim();
      const pubDate = (item.querySelector('pubDate')?.textContent || '').trim();
      const desc    = (item.querySelector('description')?.textContent || '').trim();

      // <link> in RSS is a text node AFTER the tag — querySelector alone may miss it
      let link = (item.querySelector('link')?.textContent || '').trim();
      if (!link) {
        // Try nextSibling approach for CDATA-wrapped links
        const linkEl = item.querySelector('link');
        if (linkEl?.nextSibling) link = (linkEl.nextSibling.textContent || '').trim();
      }
      // Also check <guid> which usually contains the CAP XML URL on SACHET
      if (!link || link === '#') {
        link = (item.querySelector('guid')?.textContent || '').trim();
      }

      return {
        title, link, pubDate,
        severity: normSeverity(title + ' ' + desc),
        event:    title,
        areaDesc: desc.substring(0, 200) || 'India',
        sender:   'IMD / NDMA',
        capLoaded: false,
        polygons: [],
        circles:  [],
      };
    });

    console.info(`[SACHET] RSS loaded: ${sachetAlerts.length} items`);

    // ── Step 3: Show RSS-only cards immediately (no waiting for CAP) ──
    sachetUnavailable = false;
    renderSACHETPanel();

    // ── Step 4: Fetch CAP detail for ALL alerts concurrently ──────────
    // We batch to avoid hitting rate limits: groups of 5 at a time
    const batchSize = 5;
    for (let i = 0; i < sachetAlerts.length; i += batchSize) {
      const batch = sachetAlerts.slice(i, i + batchSize);
      await Promise.allSettled(batch.map(a => loadCAPDetail(a)));
      // Re-render after each batch so the user sees polygons appear progressively
      renderSACHETPanel();
      renderOfficialAlertZones();
    }

    updateSeverityUI();
    try { updateBroadcastAvailability(); } catch (_) {}
    try { updateOpStatus(); } catch (_) {}
    if (btn) btn.innerHTML = '<i class="fa-solid fa-rotate"></i> Refresh';
    console.info(`[SACHET] CAP fetch complete. Alerts with polygons: ${sachetAlerts.filter(a => a.polygons?.length).length}`);

  } catch (err) {
    console.error('[SACHET] Fetch failed:', err.message);
    sachetAlerts = [];
    sachetUnavailable = true;
    renderSACHETPanel();
    updateSeverityUI();
    if (btn) btn.innerHTML = '<i class="fa-solid fa-rotate"></i> Retry';
  }
}

// ── District scoping ────────────────────────────────────────────
// STRICT: once a district is chosen, an alert is shown ONLY if it
// actually covers that district — its polygon overlaps the district
// bbox, or its area text names the district itself. State-wide and
// nationwide alerts are NOT shown unless their geometry reaches the
// district.
function alertTouchesDistrict(a) {
  const d = window.resqnetDistrict;
  if (!d) return true;

  const inDistrict = typeof window.resqnetPointInDistrict === 'function'
    ? window.resqnetPointInDistrict
    : null;

  // 1. geometry overlap — any polygon vertex inside the district
  const polys = (a.polygons && a.polygons.length) ? a.polygons
              : (a.polygon ? [a.polygon] : []);
  if (inDistrict) {
    for (const pts of polys) {
      if (!pts) continue;
      for (const pt of pts) {
        if (inDistrict(Number(pt.lat), Number(pt.lng))) return true;
      }
    }
  }
  // Also: a district-bbox corner inside the alert polygon (large alert
  // polygon fully containing a small district).
  if (d.bbox && polys.length && typeof pointInPolygon === 'function') {
    const corners = [
      { lat: d.bbox.minLat, lng: d.bbox.minLon }, { lat: d.bbox.maxLat, lng: d.bbox.maxLon },
      { lat: d.center.lat, lng: d.center.lon },
    ];
    for (const pts of polys) {
      if (!pts || pts.length < 3) continue;
      for (const c of corners) if (pointInPolygon(c.lat, c.lng, pts)) return true;
    }
  }

  // 2. text mention — the DISTRICT name in the alert's area text
  //    (state name alone is not enough).
  const hay = `${a.areaDesc || ''} ${a.headline || ''}`.toLowerCase();
  if (d.district && hay.includes(String(d.district).toLowerCase())) return true;

  return false;
}

// Render the SACHET alert panel — shows alerts for the selected
// district (or all, before a district is chosen), sorted by severity.
function renderSACHETPanel() {
  const panel = document.getElementById('sachet-alerts-panel');
  if (!panel) return;

  if (sachetUnavailable) {
    panel.innerHTML = `
      <div class="p-4 flex items-center gap-3 text-sm">
        <i class="fa-solid fa-triangle-exclamation text-brand-orange text-lg"></i>
        <div>
          <div class="font-bold text-gray-700">Official disaster alert data unavailable right now.</div>
          <div class="text-xs text-gray-400 mt-1">The SACHET NDMA server could not be reached via CORS proxies. Click Retry to try again.</div>
        </div>
      </div>`;
    return;
  }

  if (!sachetAlerts.length) {
    panel.innerHTML = '<div class="p-4 text-xs text-gray-400">No active official alerts at this time.</div>';
    return;
  }

  const scoped = sachetAlerts.filter(alertTouchesDistrict);

  if (!scoped.length) {
    const dName = window.resqnetDistrict?.district;
    panel.innerHTML = `<div class="p-4 text-xs text-gray-400">No official alerts for ${dName ? escapeHtml(dName) : 'this district'} right now (${sachetAlerts.length} active elsewhere in India).</div>`;
    return;
  }

  const order = { extreme: 5, severe: 4, high: 3, moderate: 2, minor: 1, unknown: 0 };
  const sorted = [...scoped].sort((a, b) => (order[b.severity] || 0) - (order[a.severity] || 0));

  const severityColors = {
    extreme:  { bg: '#7f0000', fg: '#fff', ring: '#b71c1c' },
    severe:   { bg: '#b71c1c', fg: '#fff', ring: '#d32f2f' },
    high:     { bg: '#e64a19', fg: '#fff', ring: '#f57c00' },
    moderate: { bg: '#f9a825', fg: '#000', ring: '#fbc02d' },
    minor:    { bg: '#2e7d32', fg: '#fff', ring: '#43a047' },
    unknown:  { bg: '#546e7a', fg: '#fff', ring: '#78909c' },
  };

  const cards = sorted.map(a => {
    const sev    = a.severity || 'unknown';
    const col    = severityColors[sev] || severityColors.unknown;
    const style  = ZONE_STYLES[sachetSeverityToZone(sev) || 'low'] || ZONE_STYLES.low;
    const time   = relativeTime(a.pubDate);
    const event  = escapeHtml((a.event || a.title || 'Weather Alert').substring(0, 80));
    const area   = escapeHtml((a.areaDesc || 'India').substring(0, 160));
    const sender = escapeHtml(a.sender || 'IMD / NDMA');
    const hasPolygon = (a.polygons?.length > 0) || !!a.polygon;
    const hasCircle  = (a.circles?.length > 0)  || !!a.circle;
    const mapIcon    = hasPolygon ? '<i class="fa-solid fa-draw-polygon text-[9px]"></i>' :
                       hasCircle  ? '<i class="fa-solid fa-circle-dot text-[9px]"></i>' : '';
    const clickable  = a.link && a.link !== '#';

    return `<div class="rounded-lg border border-gray-100 overflow-hidden hover:shadow-md transition-shadow ${clickable ? 'cursor-pointer' : ''}" ${clickable ? `onclick="window.open('${a.link.replace(/'/g, '%27')}','_blank')"` : ''}>
      <div class="px-3 py-2 flex items-center justify-between gap-2" style="background:${col.bg};color:${col.fg}">
        <span class="text-[11px] font-extrabold tracking-wide uppercase">${severityLabel(sev)}</span>
        <div class="flex items-center gap-2 text-[10px] opacity-80">
          ${mapIcon}
          <span>${time}</span>
        </div>
      </div>
      <div class="p-3">
        <div class="font-bold text-gray-900 text-sm leading-tight">${event}</div>
        <div class="text-xs text-gray-500 mt-1 leading-snug">${area}</div>
        <div class="flex items-center justify-between mt-2">
          <span class="text-[10px] text-gray-400 font-semibold">${sender}</span>
          ${(a.expires ? `<span class="text-[10px] text-gray-400">Expires: ${new Date(a.expires).toLocaleDateString('en-IN', {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit'})}</span>` : '')}
        </div>
      </div>
    </div>`;
  }).join('');

  const dLabel = window.resqnetDistrict?.district ? ` in ${escapeHtml(window.resqnetDistrict.district)}` : '';
  panel.innerHTML = `<div class="p-4"><div class="text-xs text-gray-400 mb-3">${scoped.length} active alert${scoped.length !== 1 ? 's' : ''}${dLabel} &mdash; ${scoped.filter(a => a.polygons?.length || a.polygon).length} with map polygons</div><div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">${cards}</div></div>`;
}


// Draws ALL active SACHET alert polygons on the Azure map.
// Uses alert.polygons[] (multi-polygon array) from the upgraded loadCAPDetail,
// falling back to the legacy alert.polygon for backward compat.
// Existing radar / SOI boundary / incident layers are not touched.
let _alertZoneRetry = null;
function renderOfficialAlertZones() {
  // The Azure map must be fully 'ready' before a source can be added,
  // otherwise it throws. SACHET data often loads first -- when it does,
  // the map's own 'ready' handler calls this again. If the map is not
  // ready yet, keep retrying so the polygons appear the moment it is.
  if (!map || !window.atlas || !azureMapReady) {
    if (!_alertZoneRetry && Array.isArray(sachetAlerts) && sachetAlerts.length) {
      let n = 0;
      _alertZoneRetry = setInterval(() => {
        n++;
        if (map && window.atlas && azureMapReady) {
          clearInterval(_alertZoneRetry); _alertZoneRetry = null;
          try { renderOfficialAlertZones(); } catch (_) {}
        } else if (n > 60) { clearInterval(_alertZoneRetry); _alertZoneRetry = null; }
      }, 1000);
    }
    return;
  }

  // Initialise the dedicated DataSource + layers once
  if (!officialAlertSource) {
    officialAlertSource = new atlas.source.DataSource('official-sachet-alert-zones');
    map.sources.add(officialAlertSource);

    officialAlertPolygonLayer = new atlas.layer.PolygonLayer(
      officialAlertSource,
      'official-sachet-alert-fill',
      {
        fillColor: [
          'match', ['get', 'zone'],
          'severe',   '#C62828',
          'high',     '#E65100',
          'moderate', '#F9A825',
          'low',      '#43A047',
          'extreme',  '#8E0000',
          '#607D8B'
        ],
        fillOpacity: ['case', ['get', 'inDistrict'], 0.4, 0.12]
      }
    );

    officialAlertLineLayer = new atlas.layer.LineLayer(
      officialAlertSource,
      'official-sachet-alert-outline',
      {
        strokeColor: [
          'match', ['get', 'zone'],
          'severe',   '#C62828',
          'high',     '#E65100',
          'moderate', '#F9A825',
          'low',      '#43A047',
          'extreme',  '#8E0000',
          '#607D8B'
        ],
        strokeWidth: ['case', ['get', 'inDistrict'], 3.5, 1.5],
        strokeOpacity: ['case', ['get', 'inDistrict'], 1, 0.5]
      }
    );

    map.layers.add(officialAlertPolygonLayer);
    map.layers.add(officialAlertLineLayer);

    // Click on a polygon → show popup
    map.events.add('click', officialAlertPolygonLayer, (event) => {
      const shape    = event?.shapes?.[0];
      if (!shape) return;
      const props    = shape.getProperties?.() || {};
      const position = event.position;

      const html = `
        <div style="font-family:Inter,sans-serif;padding:6px;max-width:280px">
          <div style="font-weight:800;font-size:13px;color:${sevColor(props.zone || 'low')};margin-bottom:4px">
            ${escapeHtml(severityLabel(props.sachetSeverity || props.severity || 'unknown'))}
          </div>
          <div style="font-weight:700;font-size:13px;color:#111">${escapeHtml(props.event || props.title || 'Official Disaster Alert')}</div>
          ${props.areaDesc ? `<div style="margin-top:4px;font-size:12px;color:#444">${escapeHtml(props.areaDesc)}</div>` : ''}
          ${props.instruction ? `<div style="margin-top:5px;font-size:11px;font-style:italic;color:#555">${escapeHtml(props.instruction.substring(0, 200))}</div>` : ''}
          <div style="margin-top:6px;font-size:10px;color:#888">
            <strong>Source:</strong> ${escapeHtml(props.sender || 'SACHET / IMD / NDMA')}
            ${props.expires ? ` &nbsp;|&nbsp; <strong>Expires:</strong> ${new Date(props.expires).toLocaleDateString('en-IN', {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit'})}` : ''}
          </div>
          ${props.link ? `<div style="margin-top:6px"><a href="${props.link}" target="_blank" style="font-size:11px;color:#1565C0;font-weight:600">View official alert &rarr;</a></div>` : ''}
        </div>
      `;

      if (!window.resqnetAlertPopup) {
        window.resqnetAlertPopup = new atlas.Popup({ closeButton: true, pixelOffset: [0, -10] });
      }
      window.resqnetAlertPopup.setOptions({ position, content: html });
      window.resqnetAlertPopup.open(map);
    });
  }

  // Clear and repopulate
  officialAlertSource.clear();

  // Draw EVERY active CAP polygon on the map (national situational
  // picture). The district's own alerts are flagged `inDistrict` so
  // they can be styled prominently; the text panel stays district-only.
  const activeAlerts = sachetAlerts.filter(isAlertActive);
  let polygonCount = 0;

  activeAlerts.forEach(a => {
    const zone = sachetSeverityToZone(a.severity) || 'low';
    const inDistrict = (typeof alertTouchesDistrict === 'function') ? alertTouchesDistrict(a) : true;
    const props = {
      zone,
      severity:       zone,
      inDistrict,
      sachetSeverity: a.severity,
      event:          a.event     || a.title || 'Weather Alert',
      title:          a.title     || a.event || 'Official Disaster Alert',
      areaDesc:       a.areaDesc  || '',
      instruction:    a.instruction || '',
      sender:         a.sender    || 'SACHET / IMD / NDMA',
      effective:      a.effective || '',
      expires:        a.expires   || '',
      link:           a.link      || '',
    };

    // Use alert.polygons[] (multi) if present, else fall back to legacy alert.polygon
    const polygonList = (a.polygons && a.polygons.length) ? a.polygons
                        : (a.polygon ? [a.polygon] : []);

    polygonList.forEach(pts => {
      if (!pts || pts.length < 3) return;
      // Azure Maps expects [longitude, latitude]
      const coordinates = pts.map(pt => [Number(pt.lng), Number(pt.lat)]);
      if (coordinates.length < 3) return;

      // Close the ring if not already closed
      const first = coordinates[0], last = coordinates[coordinates.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) coordinates.push(first);

      officialAlertSource.add(
        new atlas.data.Feature(new atlas.data.Polygon([coordinates]), props)
      );
      polygonCount++;
    });
  });

  console.info(`[SACHET] renderOfficialAlertZones: ${polygonCount} polygon(s) drawn from ${activeAlerts.length} alert(s).`);
  // The fill/outline layers are created lazily on the first call, so
  // re-assert the operator's on/off choice afterwards.
  try { applyMapLayerState(); } catch (_) {}
}
/* ============================================================
   ONE-WAY SMS BROADCAST BRIDGE
   Talks to the Kavach mobile simulator over BroadcastChannel,
   with a localStorage fallback for browsers without it.
   Both tabs must be served from the same origin (e.g. Live
   Server) for either channel to reach the other page.
   ============================================================ */

const KAVACH_CHANNEL_NAME = 'kavach_sms_bridge';
const KAVACH_STORAGE_KEY = 'kavach_last_alert';

const kavachChannel = 'BroadcastChannel' in window ? new BroadcastChannel(KAVACH_CHANNEL_NAME) : null;

function pushAlertToSimulator(payload) {
  // Primary channel: instant, same-origin tab-to-tab messaging
  if (kavachChannel) {
    kavachChannel.postMessage(payload);
  }

  // Fallback channel: localStorage fires a 'storage' event in *other*
  // same-origin tabs/windows, which the Kavach simulator listens for.
  try {
    localStorage.setItem(KAVACH_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.error('[ResqNet] Could not write fallback alert to localStorage:', error);
  }
}

function showBroadcastStatus(message, isSuccess) {
  const statusEl = document.getElementById('broadcast-status');
  if (!statusEl) return;

  statusEl.textContent = message;
  statusEl.classList.remove('hidden', 'text-green-700', 'text-gray-500');
  statusEl.classList.add(isSuccess ? 'text-green-700' : 'text-gray-500');
}

// Active SACHET alerts that fall inside / name the selected district.
function districtSachetAlerts() {
  if (typeof sachetAlerts === 'undefined' || !Array.isArray(sachetAlerts)) return [];
  let list = sachetAlerts.filter(isAlertActive);
  if (typeof alertTouchesDistrict === 'function') list = list.filter(alertTouchesDistrict);
  return list;
}


// Pulls the real footprint out of a CAP alert: its polygon if the feed
// carried one, else its circle, else nothing. Used so an authority
// broadcast covers exactly the area the official warning covers.
function _alertFootprint(alert) {
  const out = { polygon: null, lat: null, lng: null, radiusKm: null };
  if (!alert) return out;

  const poly = (Array.isArray(alert.polygon) && alert.polygon.length >= 3) ? alert.polygon : null;
  if (poly) {
    const pts = poly
      .map((pt) => (Array.isArray(pt) ? [Number(pt[0]), Number(pt[1])] : [Number(pt.lat), Number(pt.lng ?? pt.lon)]))
      .filter((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1]));
    if (pts.length >= 3) {
      out.polygon = pts;
      // Centroid, for the map pin and the SMS "near X" wording.
      let sLat = 0, sLng = 0;
      pts.forEach((pt) => { sLat += pt[0]; sLng += pt[1]; });
      out.lat = sLat / pts.length;
      out.lng = sLng / pts.length;
      return out;
    }
  }

  const c = alert.circle;
  if (c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng))) {
    out.lat = Number(c.lat);
    out.lng = Number(c.lng);
    out.radiusKm = Number(c.radiusKm) || 10;
  }
  return out;
}

function sendAreaSMSBroadcast() {
  let activeSev = document.querySelector('.broadcast-sev-tab[data-active="true"]')?.dataset.sev || 'high';
  const district = window.resqnetDistrict;
  const districtAlerts = districtSachetAlerts();

  let areaLabel;
  let targetLat = selectedCoords?.lat ?? null;
  let targetLng = selectedCoords?.lng ?? null;
  let alertContext = '';
  let sachetGeom = null;   // the backing SACHET warning's real footprint

  if (district) {
    const c = selectedCoords;
    const pointInside = c && typeof window.resqnetPointInDistrict === 'function'
      && window.resqnetPointInDistrict(c.lat, c.lng);

    if (pointInside) {
      // Explicit point inside the district -> broadcast to that point.
      areaLabel = district.district;
    } else if (districtAlerts.length) {
      // No point picked, but there IS an active SACHET warning for this
      // district -> broadcast to exactly where that warning is. The
      // alert's own CAP geometry is the footprint; falling back to a
      // circle around the district centre would warn people the IMD
      // never warned and miss people it did.
      areaLabel = district.district;
      const a = districtAlerts[0];
      sachetGeom = _alertFootprint(a);
      targetLat = sachetGeom.lat ?? district.center?.lat ?? null;
      targetLng = sachetGeom.lng ?? district.center?.lon ?? null;
      alertContext = ` (${a.event || a.title || 'active warning'})`;
      // Adopt the alert's severity if the operator hasn't chosen one.
      const sevMap = { extreme: 'severe', severe: 'severe', high: 'high', moderate: 'moderate', minor: 'moderate' };
      if (sevMap[a.severity]) activeSev = sevMap[a.severity];
    } else {
      showBroadcastStatus(
        `No active SACHET warning for ${district.district}. Click a point inside the district to broadcast manually.`,
        false
      );
      return;
    }
  } else if (selectedArea === 'Bhubaneswar') {
    areaLabel = 'Bhubaneswar';
  } else {
    showBroadcastStatus('Select a district first.', false);
    return;
  }

  // Warning footprint: an explicit point → a circle sized by severity;
  // otherwise the district outline itself (so the whole district is
  // covered when the broadcast is backed by a district-wide SACHET
  // warning). Kavach draws this ring as a live alert polygon.
  const radiusKm = { moderate: 6, high: 10, severe: 15 }[activeSev] || 10;
  let polygon = null;
  if (sachetGeom && sachetGeom.polygon) {
    // Warn precisely the area the official CAP alert covers.
    polygon = sachetGeom.polygon;
  } else if (sachetGeom && Number.isFinite(sachetGeom.radiusKm)) {
    polygon = _circleRingLatLng(sachetGeom.lat, sachetGeom.lng, sachetGeom.radiusKm, 40);
  } else if (Number.isFinite(targetLat) && Number.isFinite(targetLng)) {
    polygon = _circleRingLatLng(targetLat, targetLng, radiusKm, 40);
  } else if (district?.polygonPoints?.length >= 3) {
    polygon = district.polygonPoints.map((p) =>
      Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p.lat), Number(p.lon ?? p.lng)]
    );
  }

  // Human-readable description: reuse the district's active SACHET
  // warning text when the broadcast is backed by one, else compose one.
  const sevWord = { moderate: 'moderate', high: 'serious', severe: 'severe / life-threatening' }[activeSev] || 'serious';
  let description;
  if (districtAlerts.length) {
    const a = districtAlerts[0];
    description = `${a.event || a.title || 'Active weather warning'} for ${areaLabel}. ${(a.areaDesc || a.headline || '').slice(0, 180)}`.trim();
  } else {
    description = `A ${sevWord} hazard situation has been flagged for ${areaLabel} by the District Disaster Authority. Residents should stay alert, avoid non-essential travel and follow instructions from local authorities.`;
  }

  // Citizen safety-response form + toll-free helpline — carried in the
  // broadcast AND mentioned as "sent by SMS".
  const tollFree = '1078';
  let formUrl = 'kavach.gov.in/report';
  try { formUrl = window.location.origin + '/Kavach/kavach.html#report'; } catch (_) {}

  const now = Date.now();
  const payload = {
    type:      'SACHET_BROADCAST',
    id:        'BCAST-' + now,
    severity:  activeSev,
    area:      areaLabel,
    state:     district?.state || null,
    district:  district?.district || null,
    lat:       targetLat,
    lng:       targetLng,
    radius_km: (sachetGeom && Number.isFinite(sachetGeom.radiusKm))
      ? sachetGeom.radiusKm
      : (polygon && Number.isFinite(targetLat) ? radiusKm : null),
    polygon,
    event:     'Authority Emergency Broadcast',
    headline:  `${activeSev.toUpperCase()} alert for ${areaLabel}${alertContext}`,
    description,
    instruction: 'Follow instructions from local authorities. Move to safe higher ground / a designated shelter if advised. Keep your phone charged.',
    form_url:  formUrl,
    toll_free: tollFree,
    sachet_backed: districtAlerts.length > 0,
    sachet_event: districtAlerts.length ? (districtAlerts[0].event || districtAlerts[0].title || null) : null,
    sachet_area:  districtAlerts.length ? (districtAlerts[0].areaDesc || null) : null,
    footprint_source: sachetGeom && (sachetGeom.polygon || sachetGeom.radiusKm) ? 'SACHET_CAP' : 'MANUAL',
    message:   `SACHET ${activeSev.toUpperCase()} ALERT for ${areaLabel}${alertContext}. ${description} A safety response form link has been sent to you by SMS. Toll-free helpline: ${tollFree}. — RESQNET Command Centre.`,
    timestamp: now,
    expires_at: now + 6 * 60 * 60 * 1000,
  };

  // 1. Same-browser bridge (instant, offline-capable).
  pushAlertToSimulator(payload);
  try { localStorage.setItem('kavach_sachet_trigger', JSON.stringify(payload)); } catch (e) {}

  // 2. Cross-device: Firestore 'broadcasts' → every Kavach in the area.
  let cloud = false;
  try {
    if (typeof window.resqnetWriteBroadcast === 'function') {
      window.resqnetWriteBroadcast(payload).then(
        () => console.info('[broadcast] written to Firestore'),
        (err) => console.warn('[broadcast] Firestore write failed', err)
      );
      cloud = true;
    }
  } catch (e) { console.warn('[broadcast] Firestore unavailable', e); }

  // 3. Preview the warning footprint on the operator's own map.
  if (polygon) drawBroadcastPreview(polygon, activeSev);

  // 4. Local history log.
  logBroadcast(payload);

  showBroadcastStatus(
    `✅ SACHET ${activeSev.toUpperCase()} broadcast sent for ${areaLabel}${alertContext} → Kavach` +
    (cloud ? ' (all devices in area)' : ' (this browser)') + '. Siren + polygon now live.',
    true
  );
  playSiren(2500);
}

// A closed ring of [lat,lng] points approximating a circle. Latitude
// scaling keeps it round at Indian latitudes.
function _circleRingLatLng(lat, lng, radiusKm, n) {
  const ring = [];
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    ring.push([lat + dLat * Math.sin(a), lng + dLng * Math.cos(a)]);
  }
  return ring;
}

// Orange dashed footprint drawn on the RESQNET Azure map, auto-cleared.
let _bcastPreviewSource = null;
let _bcastPreviewTimer = null;
function drawBroadcastPreview(ringLatLng, severity) {
  try {
    if (!map || !window.atlas || !azureMapReady) return;
    if (!_bcastPreviewSource) {
      _bcastPreviewSource = new atlas.source.DataSource('broadcast-preview');
      map.sources.add(_bcastPreviewSource);
      map.layers.add(new atlas.layer.PolygonLayer(_bcastPreviewSource, 'broadcast-preview-fill', {
        fillColor: 'rgba(240,90,40,0.18)',
      }));
      map.layers.add(new atlas.layer.LineLayer(_bcastPreviewSource, 'broadcast-preview-line', {
        strokeColor: '#f05a28', strokeWidth: 3, strokeDashArray: [3, 2],
      }));
    }
    _bcastPreviewSource.clear();
    const coords = ringLatLng.map(([la, lo]) => [lo, la]);
    if (coords.length >= 3) {
      _bcastPreviewSource.add(new atlas.data.Feature(new atlas.data.Polygon([coords]), { severity }));
    }
    clearTimeout(_bcastPreviewTimer);
    _bcastPreviewTimer = setTimeout(() => { try { _bcastPreviewSource.clear(); } catch (_) {} }, 45000);
  } catch (e) { console.warn('[broadcast] preview draw failed', e); }
}

const BROADCAST_LOG_KEY = 'resqnet_broadcast_log';
function logBroadcast(payload) {
  let log = [];
  try { log = JSON.parse(localStorage.getItem(BROADCAST_LOG_KEY) || '[]'); } catch (_) {}
  log.unshift({
    area: payload.area, severity: payload.severity, district: payload.district,
    sachet_backed: payload.sachet_backed, timestamp: payload.timestamp,
  });
  log = log.slice(0, 8);
  try { localStorage.setItem(BROADCAST_LOG_KEY, JSON.stringify(log)); } catch (_) {}
  renderBroadcastHistory();
}

/* ============================================================
   SITUATION REPORT — one-click printable snapshot for handover
   / logging. Pulls only from state already on the page.
   ============================================================ */
function exportSituationReport() {
  const d = window.resqnetDistrict || {};
  const now = new Date();
  const txt = (id) => (document.getElementById(id)?.textContent || '0').trim();

  const zones = (typeof districtSachetAlerts === 'function') ? districtSachetAlerts() : [];
  const res = Array.isArray(window.resqnetDistrictResources) ? window.resqnetDistrictResources : [];
  const byKind = {};
  res.forEach((r) => { byKind[r.type] = (byKind[r.type] || 0) + 1; });

  let log = [];
  try { log = JSON.parse(localStorage.getItem(BROADCAST_LOG_KEY) || '[]'); } catch (_) {}

  let dispatch = [];
  try {
    dispatch = [...liveIncidents.values()]
      .filter((inc) => (typeof incidentInDistrict !== 'function') || incidentInDistrict(inc))
      .map((inc) => ({
        id: inc.incident_id || inc.__docId || '—',
        text: (inc.text || '').slice(0, 80),
        status: STATUS_LABEL[(inc.status || 'UNASSIGNED').toUpperCase()] || (inc.status || 'Unassigned'),
      }));
  } catch (_) {}

  const rows = (arr, cols) => arr.map((o) =>
    '<tr>' + cols.map((c) => `<td>${escapeHtml(String(o[c] ?? '—'))}</td>`).join('') + '</tr>').join('') ||
    `<tr><td colspan="${cols.length}" style="color:#888">none</td></tr>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>RESQNET Situation Report — ${escapeHtml(d.district || 'Area')}</title>
<style>
 body{font:13px/1.5 'Segoe UI',Arial,sans-serif;color:#111;margin:32px;max-width:820px}
 h1{font-size:20px;margin:0 0 2px} h2{font-size:14px;margin:22px 0 6px;border-bottom:2px solid #1c3655;padding-bottom:3px;color:#1c3655}
 .muted{color:#666;font-size:12px} table{border-collapse:collapse;width:100%;margin-top:4px}
 td,th{border:1px solid #ccc;padding:5px 8px;text-align:left;font-size:12px} th{background:#f0f3f7}
 .kpi{display:inline-block;border:1px solid #ccc;border-radius:8px;padding:8px 14px;margin:4px 8px 4px 0}
 .kpi b{display:block;font-size:20px;color:#1c3655} .sev{font-weight:700}
 @media print{body{margin:12mm}}
</style></head><body>
 <h1>RESQNET — Situation Report</h1>
 <div class="muted">${escapeHtml(d.district || 'No district')}${d.state ? ', ' + escapeHtml(d.state) : ''} &nbsp;·&nbsp; Generated ${now.toLocaleString('en-IN')}</div>

 <h2>Incident load (live)</h2>
 <span class="kpi"><b>${txt('stat-critical')}</b>Critical</span>
 <span class="kpi"><b>${txt('stat-high')}</b>High</span>
 <span class="kpi"><b>${txt('stat-medium')}</b>Medium</span>
 <span class="kpi"><b>${txt('stat-resolved')}</b>Resolved</span>
 <span class="kpi"><b>${txt('stat-resources')}</b>Resources</span>

 <h2>Dispatch board</h2>
 <table><tr><th>ID</th><th>Summary</th><th>Status</th></tr>${rows(dispatch, ['id', 'text', 'status'])}</table>

 <h2>Active SACHET / IMD zones in district (${zones.length})</h2>
 <table><tr><th>Event</th><th>Severity</th><th>Area</th></tr>${
   rows(zones.map((z) => ({ event: z.event || z.title || 'Alert', severity: (z.severity || '').toUpperCase(), area: (z.areaDesc || '').slice(0, 90) })), ['event', 'severity', 'area'])
 }</table>

 <h2>Resource inventory (${res.length})</h2>
 <table><tr><th>Category</th><th>Count</th></tr>${
   rows(Object.keys(byKind).map((k) => ({ k, n: byKind[k] })), ['k', 'n'])
 }</table>

 <h2>Broadcasts issued (recent)</h2>
 <table><tr><th>Time</th><th>Area</th><th>Severity</th><th>SACHET-backed</th></tr>${
   rows(log.map((b) => ({
     t: new Date(b.timestamp).toLocaleString('en-IN'), area: b.area || b.district || '—',
     s: (b.severity || '').toUpperCase(), sb: b.sachet_backed ? 'yes' : 'no',
   })), ['t', 'area', 's', 'sb'])
 }</table>

 <p class="muted" style="margin-top:28px">Auto-generated by RESQNET Command Centre. Figures reflect the dashboard at generation time.</p>
 <script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script>
</body></html>`;

  const w = window.open('', 'resqnet-report', 'width=900,height=1000');
  if (!w) {
    showBroadcastStatus('Allow pop-ups to generate the situation report.', false);
    return;
  }
  w.document.open(); w.document.write(html); w.document.close();
}
window.exportSituationReport = exportSituationReport;

function renderBroadcastHistory() {
  const el = document.getElementById('broadcast-history');
  if (!el) return;
  let log = [];
  try { log = JSON.parse(localStorage.getItem(BROADCAST_LOG_KEY) || '[]'); } catch (_) {}
  if (!log.length) { el.innerHTML = ''; return; }
  const sevDot = { moderate: 'bg-brand-yellow', high: 'bg-brand-orange', severe: 'bg-brand-red' };
  el.innerHTML =
    '<div class="text-[10px] font-bold text-gray-400 uppercase tracking-wide mt-3 mb-1">Recent broadcasts</div>' +
    log.map((b) => {
      const t = new Date(b.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      return `<div class="flex items-center gap-2 text-[11px] py-1 border-b border-gray-50 last:border-0">
        <span class="w-1.5 h-1.5 rounded-full ${sevDot[b.severity] || 'bg-gray-400'}"></span>
        <span class="font-semibold text-gray-700">${escapeHtml(b.area || b.district || '—')}</span>
        <span class="text-gray-400">${(b.severity || '').toUpperCase()}</span>
        ${b.sachet_backed ? '<span class="text-[9px] text-brand-blue font-bold">SACHET</span>' : ''}
        <span class="ml-auto text-gray-400">${t}</span>
      </div>`;
    }).join('');
}

function initBroadcastPanel() {
  const broadcastBtn = document.getElementById('send-broadcast-btn');
  if (broadcastBtn) broadcastBtn.addEventListener('click', sendAreaSMSBroadcast);

  // Severity tab selection — inset ring so it never bleeds past the
  // group's rounded/overflow-hidden edge as a stray coloured line.
  const setActive = (tab) => {
    document.querySelectorAll('.broadcast-sev-tab').forEach(t => {
      t.dataset.active = 'false';
      t.classList.remove('ring-2', 'ring-inset', 'ring-brand-blue', 'font-extrabold', 'z-10');
      t.style.removeProperty('box-shadow');
    });
    tab.dataset.active = 'true';
    tab.classList.add('ring-2', 'ring-inset', 'ring-brand-blue', 'font-extrabold', 'z-10');
  };
  document.querySelectorAll('.broadcast-sev-tab').forEach(tab => {
    tab.classList.remove('ring-2', 'ring-orange-400', 'ring-red-500', 'ring-yellow-400');
    tab.addEventListener('click', () => setActive(tab));
  });

  const defaultTab = document.querySelector('.broadcast-sev-tab[data-sev="high"]');
  if (defaultTab) setActive(defaultTab);
}

// ── Wires the Refresh button on the official-alerts panel ─────────────
function initSachetPanel() {
  const btn = document.getElementById('sachet-refresh-btn');
  if (btn) btn.addEventListener('click', fetchSACHETAlerts);
}

/* ============================================================
   WEB AUDIO SIREN
   ============================================================ */
let _sirenTimeout = null;
function playSiren(durationMs) {
  try {
    const ctx   = new (window.AudioContext || window.webkitAudioContext)();
    const osc   = ctx.createOscillator();
    const gain  = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.35, ctx.currentTime);

    // Alternating hi/lo tone every 0.45s — classic siren effect
    let t   = ctx.currentTime;
    const hi = 1050, lo = 680, step = 0.45;
    const cycles = Math.ceil(durationMs / (step * 1000));
    for (let i = 0; i < cycles; i++) {
      osc.frequency.setValueAtTime(i % 2 === 0 ? hi : lo, t);
      t += step;
    }

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + durationMs / 1000);

    // Flash siren overlay on main website
    const overlay = document.getElementById('siren-overlay');
    if (overlay) {
      overlay.style.display = 'block';
      clearTimeout(_sirenTimeout);
      _sirenTimeout = setTimeout(() => { overlay.style.display = 'none'; }, durationMs);
    }
  } catch (e) {
    console.warn('[ResqNet] Siren audio failed (context policy?):', e);
  }
}

/* ============================================================
   KAVACH LIVE FEED — read MockDB.citizenReports from localStorage
   ============================================================ */
const KAVACH_REQUESTS_KEY  = 'kavach_requests';
const KAVACH_FEED_INTERVAL = 4000; // poll every 4 s

function readKavachReports() {
  try {
    const raw = localStorage.getItem(KAVACH_REQUESTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // Only citizen safety reports from the SACHET broadcast flow
    return arr.filter(r => r && r.source === 'SACHET_CITIZEN').reverse();
  } catch (_) { return []; }
}

function refreshKavachFeed() {
  const reports  = readKavachReports();
  const feed     = document.getElementById('kavach-emergency-feed');
  const grid     = document.getElementById('incidents-grid');
  const countEl  = document.getElementById('kavach-feed-count');
  const feedBadge= document.getElementById('kavach-feed-badge');
  const placeholder = document.getElementById('incidents-placeholder');

  // Update count badge
  if (countEl) countEl.textContent = `${reports.length} report${reports.length !== 1 ? 's' : ''} received`;
  if (feedBadge) {
    feedBadge.textContent = reports.length > 0 ? `● ${reports.length} LIVE` : 'KAVACH LIVE';
    feedBadge.style.color = reports.length > 0 ? '#d32f2f' : '';
  }

  // ── Sidebar panel (#alerts) ─────────────────────────────────
  if (feed) {
    if (!reports.length) {
      feed.innerHTML = `<div class="p-6 text-center text-gray-400 text-sm" id="kavach-feed-placeholder">
        <i class="fa-solid fa-satellite-dish text-2xl mb-2 block"></i>
        Open the Kavach simulator, trigger a broadcast, then citizen responses will appear here.
      </div>`;
    } else {
      const statusColor = { safe: '#2e7d32', 'needs-help': '#f9a825', danger: '#d32f2f' };
      const statusLabel = { safe: 'Safe', 'needs-help': 'Needs Help', danger: 'DANGER' };
      const statusBg    = { safe: '#e8f5e9', 'needs-help': '#fffde7', danger: '#ffebee' };
      const iconMap     = { safe: 'fa-circle-check', 'needs-help': 'fa-triangle-exclamation', danger: 'fa-bell' };

      feed.innerHTML = reports.map(r => {
        const s     = r.safetyStatus || 'unknown';
        const col   = statusColor[s] || '#9e9e9e';
        const bg    = statusBg[s]    || '#f5f5f5';
        const lbl   = statusLabel[s] || s;
        const icon  = iconMap[s]     || 'fa-circle-info';
        const loc   = r.location?.name || 'Unknown';
        const time  = r.timestamp
          ? new Date(r.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
          : '--:--';
        const needs = (r.needs || []).join(', ') || '—';
        const injured = r.injured ? `<span class="text-xs text-orange-600 font-semibold">🤕 Injured: ${r.injuredCount || 1}</span>` : '';
        const trapped = r.trapped ? `<span class="text-xs text-red-600 font-semibold">🚨 Trapped: ${r.trappedCount || 1}</span>` : '';

        return `<div class="p-4 rounded-lg border border-gray-100 hover:bg-gray-50 transition-colors flex items-start gap-4"
                     style="border-left: 3px solid ${col};">
          <div class="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 mt-1"
               style="background:${bg};color:${col};">
            <i class="fa-solid ${icon} text-lg"></i>
          </div>
          <div class="flex-grow">
            <div class="flex justify-between items-start mb-1">
              <div class="flex items-center gap-2">
                <span class="font-bold text-gray-900 text-sm">${escHtml(r.id || 'KVC-???')}</span>
                <span class="text-[10px] font-bold text-white px-2 py-0.5 rounded-sm uppercase tracking-wider"
                      style="background:${col};">${lbl}</span>
              </div>
              <div class="text-right">
                <div class="text-xs text-gray-500">${time}</div>
                <div class="text-[10px] text-gray-400 font-semibold">KAVACH</div>
              </div>
            </div>
            <p class="text-sm font-semibold text-gray-800 mb-1">${escHtml(loc)}</p>
            <div class="flex flex-wrap gap-2 mb-1">${injured}${trapped}</div>
            <div class="text-xs text-gray-400">Needs: ${escHtml(needs)} &nbsp;|&nbsp; ${r.broadcastSeverity?.toUpperCase() || '—'} alert</div>
          </div>
        </div>`;
      }).join('');
    }
  }

  // ── Top grid (#emergencies > #incidents-grid) ─────────────────
  if (grid) {
    if (placeholder) placeholder.style.display = reports.length ? 'none' : '';

    // Remove previously injected Kavach cards
    grid.querySelectorAll('.kavach-live-card').forEach(el => el.remove());

    if (reports.length > 0) {
      // Show up to 3 most recent
      const statusColor = { safe: '#2e7d32', 'needs-help': '#f9a825', danger: '#d32f2f' };
      const borderColor = { safe: 'border-green-200', 'needs-help': 'border-yellow-300', danger: 'border-red-300/50' };
      const statusLabel = { safe: 'Safe', 'needs-help': 'Needs Help', danger: 'DANGER' };
      const bgColor     = { safe: 'bg-green-600', 'needs-help': 'bg-yellow-500', danger: 'bg-red-600' };

      reports.slice(0, 3).forEach(r => {
        const s     = r.safetyStatus || 'unknown';
        const bc    = borderColor[s] || 'border-gray-200';
        const badge = bgColor[s]     || 'bg-gray-500';
        const lbl   = statusLabel[s] || s;
        const loc   = r.location?.name || 'Unknown';
        const time  = r.timestamp
          ? new Date(r.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
          : '--:--';
        const needs = (r.needs || []).join(', ') || 'None';

        const card = document.createElement('div');
        card.className = `kavach-live-card rounded-2xl border ${bc} p-6 flex flex-col gap-4 hover:shadow-lg transition-shadow`;
        card.innerHTML = `
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full" style="background:${statusColor[s] || '#9e9e9e'};"></span>
              <span class="text-base font-bold text-gray-900">${escHtml(r.id || 'KVC-???')}</span>
              <span class="text-[10px] font-bold text-white ${badge} uppercase px-2 py-1 rounded-full tracking-wide">${lbl}</span>
            </div>
            <span class="text-[11px] font-semibold text-gray-400 bg-gray-100 px-3 py-1 rounded-full whitespace-nowrap">${time}</span>
          </div>
          <div>
            <div class="text-base font-bold text-gray-900">${escHtml(r.citizen || 'Citizen')} · ${escHtml(loc)}</div>
            <div class="text-sm text-gray-500 mt-1">Needs: ${escHtml(needs)}</div>
          </div>
          <div class="flex items-center gap-2 text-sm text-gray-500">
            <i class="fa-solid fa-location-dot text-brand-orange"></i>
            <span>SACHET Broadcast Response &nbsp;|&nbsp; ${r.broadcastSeverity?.toUpperCase() || '—'} Alert</span>
          </div>
          <div class="border-t border-gray-100 pt-4 flex items-center gap-3">
            <button class="flex-grow bg-brand-orange hover:bg-[#e55c1b] text-white text-sm font-bold py-3 px-4 rounded-lg transition-colors flex items-center justify-center gap-2">
              RESPOND <i class="fa-solid fa-bolt text-xs"></i>
            </button>
          </div>`;
        grid.appendChild(card);
      });

      if (placeholder) placeholder.style.display = 'none';
    }
  }
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ============================================================
   KAVACH STORAGE LISTENER — picks up new reports in real-time
   ============================================================ */
window.addEventListener('storage', e => {
  if (e.key === KAVACH_REQUESTS_KEY || e.key === 'kavach_citizen_reports') {
    refreshKavachFeed();
  }
});

// district-gate.js fires this once a state/district is chosen (and on
// every "Change district"). Re-scope the SACHET feed + map polygons,
// and make the broadcast panel target this district by default.
window.addEventListener('resqnet:district-ready', (e) => {
  const d = e.detail || window.resqnetDistrict;
  if (d && d.district) {
    selectedArea = d.district;
    if (d.center) {
      selectedCoords = { lat: d.center.lat, lng: d.center.lon };
      // Refresh the "Selected Area & Weather" card for THIS district.
      try { selectAreaFromMap(d.center.lat, d.center.lon, d.district); } catch (_) {}
    }
    const nameEl = document.getElementById('selected-area-name');
    if (nameEl) nameEl.textContent = d.district;
  }
  try { renderSACHETPanel(); } catch (_) {}
  try { renderOfficialAlertZones(); } catch (_) {}
  try { updateBroadcastAvailability(); } catch (_) {}
});

/* ============================================================
   COMMAND-BAR OPERATIONAL STATUS
   A one-line health readout so the operator sees at a glance
   whether the district is set and the AI / SACHET feeds are live.
   ============================================================ */
function _opDot(ok) {
  return ok ? 'bg-green-400' : 'bg-red-400';
}
async function updateOpStatus() {
  const dEl = document.getElementById('op-status-district');
  if (dEl) {
    const d = window.resqnetDistrict;
    dEl.innerHTML = `<i class="fa-solid fa-location-dot text-brand-orange"></i> ${d && d.district ? escapeHtml(d.district) : 'No district'}`;
  }

  const sEl = document.getElementById('op-status-sachet');
  if (sEl) {
    const live = (typeof sachetAlerts !== 'undefined') && Array.isArray(sachetAlerts) && sachetAlerts.length > 0 && !sachetUnavailable;
    const inDistrict = (typeof districtSachetAlerts === 'function') ? districtSachetAlerts().length : 0;
    sEl.innerHTML = `<span class="w-2 h-2 rounded-full ${_opDot(live)}"></span> SACHET ${live ? 'live' : 'offline'}` +
      (inDistrict ? ` <span class="ml-1 px-1.5 rounded bg-brand-orange/90 text-white text-[10px]">${inDistrict} in district</span>` : '');
  }

  const aEl = document.getElementById('op-status-ai');
  if (aEl) {
    const base = (window.RESQNET_AI_API_BASE || '').replace(/\/+$/, '');
    let ok = false;
    if (base) {
      try {
        const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(4000) });
        ok = r.ok;
      } catch (_) { ok = false; }
    }
    aEl.innerHTML = `<span class="w-2 h-2 rounded-full ${_opDot(ok)}"></span> AI ${ok ? 'online' : 'offline'}`;
  }
}
function _opClock() {
  const c = document.getElementById('op-status-clock');
  if (c) c.textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}
setInterval(_opClock, 1000);
setInterval(updateOpStatus, 30000);
window.addEventListener('resqnet:district-ready', updateOpStatus);
document.addEventListener('DOMContentLoaded', () => { _opClock(); updateOpStatus(); });

// Enables the broadcast button + shows a hint when there is an active
// SACHET warning for the selected district.
function updateBroadcastAvailability() {
  const btn = document.getElementById('send-broadcast-btn');
  const statusEl = document.getElementById('broadcast-status');
  if (!btn) return;

  const d = window.resqnetDistrict;
  const alerts = (typeof districtSachetAlerts === 'function') ? districtSachetAlerts() : [];

  if (d && alerts.length) {
    const a = alerts[0];
    btn.classList.add('ring-2', 'ring-brand-red');
    if (statusEl) {
      statusEl.textContent = `⚠ Active SACHET warning for ${d.district}: ${a.event || a.title || 'warning'} — you can broadcast to the district now.`;
      statusEl.classList.remove('hidden', 'text-green-700');
      statusEl.classList.add('text-brand-red');
    }
  } else {
    btn.classList.remove('ring-2', 'ring-brand-red');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const savedTheme    = _lsGet(themeStorageKey)    || 'light';
  const savedLanguage = _lsGet(languageStorageKey) || 'en';
  _langMem = savedLanguage;

  setTheme(savedTheme);
  setTextFromTranslations(savedLanguage);
  initNavigation();
  initThemeToggle();
  initLanguageToggle();
  initNavActiveState();
  initBroadcastPanel();
  initSachetPanel();

  // Live incidents / caller GPS must NOT wait on the Azure map — start
  // them now so citizen complaints reach the dispatch board even if the
  // map fails to initialise.
  startRealtimeListeners();

  // Check for local proxy first, then fetch SACHET data
  detectLocalProxy().then(() => fetchSACHETAlerts());
  initMap();

  // Initial feed load + start polling
  refreshKavachFeed();
  setInterval(refreshKavachFeed, KAVACH_FEED_INTERVAL);
});

