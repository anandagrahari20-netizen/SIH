/* ============================================================
   FIREBASE BRIDGE (shared)
   ------------------------------------------------------------
   Single Firebase init for the RESQNET dashboard. Imported by
   script.js and relocation-sim.js; the Kavach app imports it as
   ../firebase-bridge.js (same origin once hosted).

   Exposes on window for non-module consumers:
     window.resqnetDb                 -> Firestore instance
     window.resqnetFirestore          -> { collection, onSnapshot, addDoc,
                                           doc, setDoc, serverTimestamp, query, where }
     window.resqnetWriteRelocation(p) -> Promise<docRef>  (writes to "relocations")
   ============================================================ */

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getFirestore,
  collection,
  onSnapshot,
  addDoc,
  doc,
  setDoc,
  getDocs,
  serverTimestamp,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Firebase project config comes from config.js (window.RESQNET_FIREBASE_CONFIG)
// so there is ONE place to swap when self-hosting. Fallback kept for safety.
const firebaseConfig = (typeof window !== "undefined" && window.RESQNET_FIREBASE_CONFIG) || {
  apiKey: "YOUR_FIREBASE_WEB_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.firebasestorage.app",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_FIREBASE_APP_ID",
  measurementId: "YOUR_MEASUREMENT_ID",
};

// Reuse an existing app if one was already initialised (e.g. the
// Kavach page also imports this module).
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);

// Google Analytics — optional, best-effort, never blocks the app.
if (typeof window !== "undefined" && firebaseConfig.measurementId) {
  import("https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics.js")
    .then(({ getAnalytics, isSupported }) =>
      isSupported().then((ok) => { if (ok) getAnalytics(app); })
    )
    .catch(() => {});
}

/**
 * Persist one AI relocation decision so the Kavach app (and any
 * other Firestore listener) sees it live.
 *
 * @param {object} payload
 *   { resource_id, resource_name, resource_type, cluster_id,
 *     from: {lat, lng}, to: {lat, lng},
 *     eta_minutes, distance_km, units, state, district }
 */
async function writeRelocation(payload) {
  return addDoc(collection(db, "relocations"), {
    ...payload,
    status: payload.status || "EN_ROUTE",
    created_at: serverTimestamp(),
  });
}

/**
 * Persist an authority SACHET broadcast so every Kavach device in
 * (or near) the target area receives it live — as a real alert card,
 * a map polygon and a push notification, not just a same-browser siren.
 *
 * @param {object} payload
 *   { id, severity, area, state, district, lat, lng, radius_km,
 *     event, headline, message, instruction,
 *     polygon: [[lat,lng], …], timestamp, expires_at }
 */
async function writeBroadcast(payload) {
  return addDoc(collection(db, "broadcasts"), {
    ...payload,
    created_at: serverTimestamp(),
  });
}

const firestoreApi = {
  collection,
  onSnapshot,
  addDoc,
  doc,
  setDoc,
  getDocs,
  serverTimestamp,
  query,
  where,
};

if (typeof window !== "undefined") {
  window.resqnetDb = db;
  window.resqnetFirestore = firestoreApi;
  window.resqnetWriteRelocation = writeRelocation;
  window.resqnetWriteBroadcast = writeBroadcast;
}

export { app, db, firebaseConfig, writeRelocation, writeBroadcast };
export { collection, onSnapshot, addDoc, doc, setDoc, getDocs, serverTimestamp, query, where };
