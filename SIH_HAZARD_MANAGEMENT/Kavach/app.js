/* ================================================================
   KAVACH — SIH Disaster Response Prototype
   app.js — Complete Application Logic
   ================================================================ */

'use strict';

// ──────────────────────────────────────────────────────────────
//  CONFIG
// ──────────────────────────────────────────────────────────────
const GOOGLE_MAPS_API_KEY = (typeof window !== 'undefined' && window.RESQNET_GOOGLE_MAPS_KEY) || 'YOUR_GOOGLE_MAPS_API_KEY';
// Azure Maps key comes from ../config.js (window.RESQNET_AZURE_MAPS_KEY).
const AZURE_MAPS_KEY = (typeof window !== 'undefined' && window.RESQNET_AZURE_MAPS_KEY)
  || 'YOUR_AZURE_MAPS_SUBSCRIPTION_KEY';
const AZURE_WEATHER_URL = 'https://atlas.microsoft.com/weather/currentConditions/json';

// SACHET NDMA RSS feed
const SACHET_RSS = 'https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml';

// SACHET origin — used to rewrite CAP/RSS URLs onto our own proxy.
const SACHET_ORIGIN = 'https://sachet.ndma.gov.in';
// Dedicated SACHET proxy (Cloudflare Worker) from ../config.js. Tried
// FIRST — it forwards with the right Origin/Referer headers and adds
// CORS, so it is far more reliable than public CORS proxies.
const SACHET_PROXY = (typeof window !== 'undefined' && window.RESQNET_SACHET_PROXY || '').replace(/\/+$/, '');
// Public CORS proxies — fallback only, tried in order if the Worker
// is not configured or is unreachable.
const CORS_PROXY = 'https://api.allorigins.win/raw?url=';
const CORS_PROXY_FALLBACK = 'https://corsproxy.io/?url=';
const CORS_PROXIES_EXTRA = [
  'https://test.cors.workers.dev/?',
  'https://api.codetabs.com/v1/proxy/?quest=',
  'https://thingproxy.freeboard.io/fetch/',
];

// Odisha city config — maps to MockDB.weatherData ids
const CITY_CFG = [
  { id:'w1', city:'Bhubaneswar',   lat:20.2961, lng:85.8245 },
  { id:'w2', city:'Cuttack',       lat:20.4625, lng:85.8828 },
  { id:'w3', city:'Puri',          lat:19.8135, lng:85.8312 },
  { id:'w4', city:'Khordha',       lat:20.1826, lng:85.6215 },
  { id:'w5', city:'Jagatsinghpur', lat:20.2578, lng:86.1675 },
  { id:'w6', city:'Balasore',      lat:21.4942, lng:86.9299 },
  { id:'w7', city:'Brahmapur',     lat:19.3150, lng:84.7941 },
  { id:'w8', city:'Sambalpur',     lat:21.4669, lng:83.9812 },
];

// ──────────────────────────────────────────────────────────────
//  MOCK DATA STORE
// ──────────────────────────────────────────────────────────────
const MockDB = {
  users: [
    { id: 'U001', name: 'Vyom', mobile: '9876543210', password: 'demo123', lang: 'hinglish', location: 'Bhubaneswar, Odisha' }
  ],

  alerts: [
    {
      id: 'AL001',
      type: 'WEATHER',
      title: 'Live weather update',
      area: 'Bhubaneswar and surrounding regions',
      severity: 'MODERATE',
      validUntil: '18:00',
      detail: 'Current weather conditions are being refreshed from Azure Maps live data for the selected region.',
      issued: 'Azure Maps / IMD' 
    }
  ],

  requests: [],
  messages: [],
  citizenReports: [],

  // FIX: this array was previously missing entirely. Nearly every weather
  // feature in the app (nearestCity, dashboard card, map markers/heatmap,
  // popups, flood demo, Azure zone lookups) reads MockDB.weatherData, so
  // its absence was the root cause of most "Cannot read properties of
  // undefined" errors in the console. Seeded from CITY_CFG's coordinates
  // plus the same default severity/rainfall/condition values resetDemo()
  // already expected to restore.
  weatherData: [
    { id:'w1', city:'Bhubaneswar',   lat:20.2961, lng:85.8245, severity:'high',     rainfall:82, temp:29, wind:34, humidity:88, condition:'Heavy Rain',     icon:'🌧️' },
    { id:'w2', city:'Cuttack',       lat:20.4625, lng:85.8828, severity:'severe',   rainfall:95, temp:28, wind:42, humidity:92, condition:'Very Heavy Rain', icon:'⛈️' },
    { id:'w3', city:'Puri',          lat:19.8135, lng:85.8312, severity:'severe',   rainfall:67, temp:27, wind:55, humidity:90, condition:'Cyclonic Rain',   icon:'🌀' },
    { id:'w4', city:'Khordha',       lat:20.1826, lng:85.6215, severity:'high',     rainfall:58, temp:29, wind:30, humidity:85, condition:'Moderate Rain',   icon:'🌧️' },
    { id:'w5', city:'Jagatsinghpur', lat:20.2578, lng:86.1675, severity:'severe',   rainfall:72, temp:28, wind:40, humidity:89, condition:'Heavy Rain',      icon:'⛈️' },
    { id:'w6', city:'Balasore',      lat:21.4942, lng:86.9299, severity:'moderate', rainfall:44, temp:30, wind:22, humidity:78, condition:'Light Rain',      icon:'🌦️' },
    { id:'w7', city:'Brahmapur',     lat:19.3150, lng:84.7941, severity:'low',      rainfall:22, temp:31, wind:14, humidity:65, condition:'Partly Cloudy',   icon:'⛅' },
    { id:'w8', city:'Sambalpur',     lat:21.4669, lng:83.9812, severity:'low',      rainfall:18, temp:33, wind:10, humidity:55, condition:'Clear',           icon:'🌤️' },
  ],
};

// ──────────────────────────────────────────────────────────────
//  APP STATE
// ──────────────────────────────────────────────────────────────
const AppState = {
  currentScreen: 'home',
  currentUser: null,
  userLocation: { lat: null, lng: null, name: 'Location not set', exact: null },
  googleMapLoaded: false,
  googleMap: null,
  emergencyData: {
    needs: [],
    people: 1,
    injured: null,
    trapped: null,
    step: 1,
  },
  smsState: {
    lang: 'english',
    aiMode: false,
    engine: null,
  },
  ivrState: {
    active: false,
    lang: 'english',
    engine: null,
    timer: null,
    seconds: 0,
  },
  currentRequestId: null,
  sachetAlerts:    [],     // live SACHET NDMA alerts
  sachetUnavailable: false, // true when SACHET could not be fetched
  weatherSource:   'Live - Azure',
  weatherLoaded:   false,
  sachetBroadcast: { active: false, severity: 'high', generated: null, smsInjected: false },
  citizenRegForm:  {},
};

// ──────────────────────────────────────────────────────────────
//  INITIALIZATION
// ──────────────────────────────────────────────────────────────
function initializeApp() {
  // FIX: defensive guard — if MockDB.weatherData is ever missing or
  // corrupted (e.g. by future code changes), fall back to an empty array
  // instead of letting every downstream .map()/.find()/.findIndex() call
  // throw "Cannot read properties of undefined".
  if (!Array.isArray(MockDB.weatherData)) {
    MockDB.weatherData = [];
  }

  updateStatusTime();
  setInterval(updateStatusTime, 30000);
  updateHomeClock();
  setInterval(updateHomeClock, 1000);

  const savedLocation = JSON.parse(localStorage.getItem('kavach_user_location') || 'null');
  if (savedLocation) {
    AppState.userLocation = { ...AppState.userLocation, ...savedLocation, lat: Number(savedLocation.lat), lng: Number(savedLocation.lng) };
  }

  // Load saved user if any
  const savedUser = localStorage.getItem('kavach_user');
  if (savedUser) {
    AppState.currentUser = JSON.parse(savedUser);
    if (AppState.currentUser.location && !savedLocation) {
      AppState.userLocation.name = AppState.currentUser.location;
    }
  }

  // Pre-resolve the citizen's city so the map can lock onto it as soon
  // as it initialises (no flash of the all-India view).
  try {
    let d = (AppState.currentUser && AppState.currentUser.district) || localStorage.getItem('kavach_district') || '';
    let s = (AppState.currentUser && AppState.currentUser.state) || localStorage.getItem('kavach_state') || '';
    if (d && !(savedLocation && Number.isFinite(Number(savedLocation.lat)))) {
      if (typeof kavachApplyLocation === 'function') kavachApplyLocation(s, d);
    } else if (d && savedLocation) {
      // have coords already — still set bounds for the lock
      const lt = Number(savedLocation.lat), lg = Number(savedLocation.lng);
      if (Number.isFinite(lt) && Number.isFinite(lg)) _kavachCityBounds = [lg - 0.4, lt - 0.4, lg + 0.4, lt + 0.4];
    }
  } catch (_) {}

  // Simple-login screen + UI language
  try { initSimpleLoginScreen(); } catch (_) {}
  try {
    applyUiLang(
      localStorage.getItem('kavach_ui_lang')
      || (AppState.currentUser && AppState.currentUser.lang)
      || 'english'
    );
  } catch (_) {}

  requestUserLocation({ silent: true });

  // Load demo requests
  const savedRequests = localStorage.getItem('kavach_requests');
  if (savedRequests) {
    MockDB.requests = JSON.parse(savedRequests);
  }

  // Set greeting
  updateGreeting();

  // Init SMS engine
  AppState.smsState.engine = new ResponseEngine('SMS', 'english');
  AppState.ivrState.engine = new ResponseEngine('IVR', 'english');

  // ── Fetch live data asynchronously ──
  fetchRealWeatherData();
  if (window.atlas) {
    setTimeout(() => initAzureWeatherMap(), 250);
  }
  fetchSACHETAlerts();

  console.log('[Kavach] App initialized');
}

// ──────────────────────────────────────────────────────────────
//  SCREEN ROUTER
// ──────────────────────────────────────────────────────────────
function showScreen(screenId) {
  const allScreens = document.querySelectorAll('.screen');
  const target = document.getElementById(`screen-${screenId}`);
  if (!target) return;

  allScreens.forEach(s => {
    s.classList.remove('active');
    s.style.display = '';
  });

  target.classList.add('active');
  target.classList.add('screen-enter');
  setTimeout(() => target.classList.remove('screen-enter'), 350);

  AppState.currentScreen = screenId;

  // Side effects per screen
  if (screenId === 'dashboard') {
    updateDashboard();
  }
  if (screenId === 'sms-chat') {
    initSMSConversation();
  }
  if (screenId === 'weather') {
    renderNearbyWeather();
  }
  if (screenId === 'broadcast-chat') {
    initBroadcastChatScreen();
  }
  if (screenId === 'profile') {
    try { initProfileScreen(); } catch (_) {}
  }
  if (screenId === 'requests') {
    try { renderRequestsList(); } catch (_) {}
  }
  // Live location + map while a report form is open; stop the GPS
  // watch as soon as the citizen leaves it.
  if (screenId === 'emergency') {
    try { startFormLocationWatch('emg'); } catch (_) {}
  } else {
    try { stopFormLocationWatch('emg'); } catch (_) {}
  }
  if (screenId === 'citizen-register') {
    try { startFormLocationWatch('creg'); } catch (_) {}
  } else {
    try { stopFormLocationWatch('creg'); } catch (_) {}
  }

  if (screenId === 'alert-history') {
    try { renderAlertHistory(); } catch (_) {}
  }

  // keep the chosen UI language applied to freshly-shown / re-rendered screens
  if (AppState.uiLang && AppState.uiLang !== 'english') {
    try { applyUiLang(AppState.uiLang); } catch (_) {}
  }
}

function goHome() {
  showScreen('home');
}

// ──────────────────────────────────────────────────────────────
//  APP LAUNCHER
// ──────────────────────────────────────────────────────────────
function openApp(appName) {
  switch (appName) {
    case 'kavach':
      if (AppState.currentUser) {
        showScreen('dashboard');
      } else {
        openKavach();
      }
      break;
    case 'sms':
      showScreen('sms-inbox');
      break;
    case 'maps':
      showScreen('dashboard'); // Map is inside dashboard
      showToast('Opening maps — weather heatmap visible on dashboard', 'success');
      break;
    case 'phone':
    case 'ivr':
      showScreen('ivr');
      break;
    case 'weather':
      showWeatherDetail();
      break;
    case 'camera':
      showToast('Camera app — not part of this simulation', 'warning');
      break;
    case 'settings':
      showToast('Settings — not part of this simulation', 'warning');
      break;
    case 'news':
      showToast('News app — not part of this simulation', 'warning');
      break;
    default:
      showToast('App not available in simulation', 'warning');
  }
}

function openKavach() {
  showScreen('splash');
  setTimeout(() => {
    showScreen('login');
  }, 1800);
}

// ──────────────────────────────────────────────────────────────
//  TIME & CLOCK
// ──────────────────────────────────────────────────────────────
function updateStatusTime() {
  const now = new Date();
  const h = now.getHours().toString().padStart(2, '0');
  const m = now.getMinutes().toString().padStart(2, '0');
  const el = document.getElementById('status-time');
  if (el) el.textContent = `${h}:${m}`;
}

function updateHomeClock() {
  const now = new Date();
  const h = now.getHours().toString().padStart(2, '0');
  const m = now.getMinutes().toString().padStart(2, '0');
  const clockEl = document.getElementById('home-clock');
  const dateEl  = document.getElementById('home-date');
  if (clockEl) clockEl.textContent = `${h}:${m}`;

  if (dateEl) {
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    dateEl.textContent = `${days[now.getDay()]}, ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
  }
}

function updateGreeting() {
  const h = new Date().getHours();
  let greeting = 'Morning';
  if (h >= 12 && h < 17) greeting = 'Afternoon';
  else if (h >= 17) greeting = 'Evening';
  const el = document.getElementById('greeting-time');
  if (el) el.textContent = greeting;
}

// ──────────────────────────────────────────────────────────────
//  AUTHENTICATION
// ──────────────────────────────────────────────────────────────
function loginUser() {
  const mobile = document.getElementById('login-mobile').value.trim();
  const pass   = document.getElementById('login-pass').value.trim();
  let valid = true;

  document.getElementById('login-mobile-err').classList.remove('show');
  document.getElementById('login-pass-err').classList.remove('show');
  document.getElementById('login-mobile').classList.remove('error');
  document.getElementById('login-pass').classList.remove('error');

  if (!/^\d{10}$/.test(mobile)) {
    document.getElementById('login-mobile-err').classList.add('show');
    document.getElementById('login-mobile').classList.add('error');
    valid = false;
  }

  if (!pass) {
    document.getElementById('login-pass-err').classList.add('show');
    document.getElementById('login-pass').classList.add('error');
    valid = false;
  }

  if (!valid) return;

  // Check mock DB
  const user = MockDB.users.find(u => u.mobile === mobile && u.password === pass);
  if (user) {
    setCurrentUser(user);
  } else {
    showToast('Invalid credentials. Try Demo User.', 'error');
  }
}

function demoLogin() {
  const demo = MockDB.users[0];
  setCurrentUser(demo);
}

function setCurrentUser(user) {
  AppState.currentUser = user;
  localStorage.setItem('kavach_user', JSON.stringify(user));

  if (user.location) {
    AppState.userLocation.name = user.location;
  }

  showToast(`Welcome back, ${user.name}! 🛡️`, 'success');
  showScreen('dashboard');
}

function formatLocationLabel(lat, lng, fallbackName) {
  const name = fallbackName || nearestCity(lat, lng);
  const exact = `${Number(lat).toFixed(4)}°N, ${Number(lng).toFixed(4)}°E`;
  return { name, exact };
}

function saveUserLocation(location) {
  const payload = {
    lat: Number(location.lat),
    lng: Number(location.lng),
    name: location.name,
    exact: location.exact || `${Number(location.lat).toFixed(4)}°N, ${Number(location.lng).toFixed(4)}°E`
  };

  AppState.userLocation = { ...AppState.userLocation, ...payload, isExact: !!location.isExact };

  if (AppState.currentUser) {
    AppState.currentUser.location = payload.name;
    localStorage.setItem('kavach_user', JSON.stringify(AppState.currentUser));
  }

  localStorage.setItem('kavach_user_location', JSON.stringify(payload));
}

async function updateLocationUI(lat, lng, label, isExact = false) {
  const { name, exact } = formatLocationLabel(lat, lng, label || nearestCity(lat, lng));
  AppState.userLocation = { lat, lng, name, exact, isExact };
  saveUserLocation({ lat, lng, name, exact, isExact });

  // The registered district always wins as the displayed place name;
  // GPS only contributes the precise coordinates beside it.
  const homeLabel = kavachHomeLabel();

  const dashLoc = document.getElementById('dash-location');
  if (dashLoc) {
    dashLoc.textContent = isExact ? `${homeLabel} • ${exact}` : homeLabel;
  }

  const regInput = document.getElementById('reg-location');
  if (regInput) regInput.value = name;

  const statusEl = document.getElementById('location-status');
  if (statusEl) {
    statusEl.textContent = isExact ? `✅ Exact location updated: ${name} • ${exact}` : `📍 Location set: ${name}`;
  }

  const weatherLoc = document.getElementById('wc-location-name');
  if (weatherLoc) weatherLoc.textContent = kavachDisplayCity();

  try {
    // Fetch Azure weather for the location we just detected/set, and cross-check
    // it against live SACHET/IMD alert zones for that same location.
    await fetchExactWeatherForLocation(lat, lng, name || label || 'Current location');
  } catch (error) {
    // Azure weather failed for this exact location. Do NOT substitute
    // MockDB.weatherData (nearest predefined city) — that would silently
    // show weather for the wrong place and misrepresent it as live data.
    console.warn('[Kavach] Live weather unavailable for exact location:', error.message);

    setText('wc-location-name', kavachDisplayCity());
    setText('wc-condition', 'Weather data unavailable');
    setText('wc-rainfall', 'N/A');
    setText('wc-temp', 'N/A');
    setText('wc-wind', 'N/A');
    setText('wc-humidity', 'N/A');
    const badge = document.getElementById('wc-severity');
    if (badge) {
      badge.textContent = 'UNAVAILABLE';
      badge.className = 'wc-badge';
    }

    const bannerTitle = document.getElementById('banner-title');
    if (bannerTitle) {
      bannerTitle.textContent = 'Weather data unavailable';
    }

    const bannerSub = document.getElementById('banner-sub');
    if (bannerSub) {
      bannerSub.textContent = `Live Azure weather could not be retrieved for ${name}. Showing no data instead of an estimate.`;
    }

    AppState.weatherLoaded = false;
    AppState.weatherSource = 'Azure unavailable';
    updateDataSourceBadges();
  }

  // Same exact coordinates used for weather must also be checked against
  // official disaster/warning alert zones (SACHET/IMD).
  refreshCurrentLocationZone();
}

async function reverseGeocodeLocation(lat, lng) {
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1`, {
      headers: { 'Accept-Language': 'en' }
    });
    if (!response.ok) return null;
    const data = await response.json();
    const parts = [];
    if (data.address?.city) parts.push(data.address.city);
    else if (data.address?.town) parts.push(data.address.town);
    else if (data.address?.village) parts.push(data.address.village);
    if (data.address?.state) parts.push(data.address.state);
    return parts.length ? parts.join(', ') : null;
  } catch (error) {
    return null;
  }
}

function requestUserLocation({ silent = false } = {}) {
  const statusEl = document.getElementById('location-status');
  if (statusEl && !silent) statusEl.textContent = '📍 Detecting your exact location...';

  if (!navigator.geolocation) {
    if (statusEl && !silent) statusEl.textContent = '📍 Geolocation unavailable. Please enable location access.';
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const reverseName = await reverseGeocodeLocation(lat, lng);
        const locationName = reverseName || nearestCity(lat, lng);
        // updateLocationUI() already calls fetchExactWeatherForLocation()
        // internally for this exact lat/lng — awaiting it here (instead of a
        // second separate call) means we fetch Azure weather for the
        // detected location exactly once, and the UI only updates after
        // that fetch actually resolves.
        await updateLocationUI(lat, lng, locationName, true);
        if (statusEl && !silent) {
          statusEl.textContent = `✅ Exact location updated: ${locationName}`;
        }
        resolve(true);
      },
      () => {
        const saved = JSON.parse(localStorage.getItem('kavach_user_location') || 'null');
        if (saved && saved.lat && saved.lng) {
          AppState.userLocation = { ...AppState.userLocation, ...saved, lat: Number(saved.lat), lng: Number(saved.lng) };
          if (statusEl && !silent) statusEl.textContent = `📍 Using last saved location: ${saved.name}`;
          if (document.getElementById('dash-location')) document.getElementById('dash-location').textContent = saved.name;
          resolve(true);
          return;
        }
        // FIX: previously this left AppState.userLocation.lat/lng as null
        // when permission was denied and no saved location existed. Any
        // later map/marker code (Google Maps, Azure Maps) that read those
        // nulls directly would throw "Expected value to be of type
        // number, but found null instead." Fall back to the first known
        // city (Bhubaneswar) so downstream map code always has real
        // numeric coordinates to work with.
        const fallback = (Array.isArray(MockDB.weatherData) && MockDB.weatherData[0]) || CITY_CFG[0];
        AppState.userLocation = {
          ...AppState.userLocation,
          lat: fallback.lat,
          lng: fallback.lng,
          name: `${fallback.city}, Odisha (default)`,
        };
        if (statusEl && !silent) statusEl.textContent = '📍 Location permission denied. Using a default location — enable location access to personalize the app.';
        resolve(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 300000 }
    );
  });
}

function refreshUserLocation() {
  requestUserLocation({ silent: false });
  if (AppState.currentScreen === 'dashboard') {
    updateDashboard();
  }
}

function registerUser() {
  const name  = document.getElementById('reg-name').value.trim();
  const mobile= document.getElementById('reg-mobile').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const pass  = document.getElementById('reg-pass').value.trim();
  const cpass = document.getElementById('reg-cpass').value.trim();
  const lang  = document.getElementById('reg-lang').value;
  const loc   = document.getElementById('reg-location').value.trim();

  document.getElementById('reg-pass-err').classList.remove('show');

  if (!name || !mobile || !pass) {
    showToast('Please fill all required fields.', 'error');
    return;
  }
  if (!/^\d{10}$/.test(mobile)) {
    showToast('Please enter a valid 10-digit mobile number.', 'error');
    return;
  }
  if (pass !== cpass) {
    document.getElementById('reg-pass-err').classList.add('show');
    return;
  }

  const newUser = {
    id: 'U' + Date.now(),
    name, mobile, email, password: pass, lang,
    location: loc || 'Bhubaneswar, Odisha'
  };

  MockDB.users.push(newUser);
  setCurrentUser(newUser);
  showToast('Account created successfully! Welcome to Kavach 🛡️', 'success');
}

function detectLocation() {
  const statusEl = document.getElementById('location-status');
  statusEl.textContent = 'Detecting location...';

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        AppState.userLocation.lat = latitude;
        AppState.userLocation.lng = longitude;
        // Reverse geocode (mock — just show coordinates)
        const locName = nearestCity(latitude, longitude);
        AppState.userLocation.name = locName;
        document.getElementById('reg-location').value = locName;
        statusEl.textContent = `✅ Location detected: ${locName}`;
      },
      () => {
        statusEl.textContent = 'Location permission unavailable. Using the default Bhubaneswar location.';
        document.getElementById('reg-location').value = 'Bhubaneswar, Odisha';
      }
    );
  } else {
    statusEl.textContent = 'Geolocation not supported. Using the default Bhubaneswar location.';
    document.getElementById('reg-location').value = 'Bhubaneswar, Odisha';
  }
}

function nearestCity(lat, lng) {
  // The citizen's registered state is the correct suffix — this used to
  // hardcode ", Odisha", which is why the dashboard card kept flipping
  // back to Odisha no matter what district the profile was set to.
  const state = (kavachUserArea().state || '').trim();
  const suffix = state ? `, ${state}` : '';

  // FIX: guard against MockDB.weatherData being empty/undefined so this
  // never throws — it's called from several places during startup before
  // any async data has necessarily loaded.
  if (!Array.isArray(MockDB.weatherData) || !MockDB.weatherData.length) {
    return kavachHomeLabel();
  }
  let nearest = MockDB.weatherData[0];
  let minDist = Infinity;
  MockDB.weatherData.forEach(w => {
    const d = Math.sqrt((lat - w.lat) ** 2 + (lng - w.lng) ** 2);
    if (d < minDist) { minDist = d; nearest = w; }
  });
  return `${nearest.city}${suffix}`;
}

// ══════════════════════════════════════════════════════════════
//  IDENTITY OF "HERE"
//
//  The district the citizen picked at login / in their profile is the
//  authoritative answer to "where am I?". GPS and reverse-geocoding
//  only fill in when no district has been chosen. Everything that
//  renders a place name goes through these two helpers, so the app can
//  never drift back to a hardcoded default city.
// ══════════════════════════════════════════════════════════════

// "Kanpur Nagar, Uttar Pradesh" — used for headlines and broadcasts.
function kavachHomeLabel() {
  const area = kavachUserArea();
  if (area.district && area.state) return `${area.district}, ${area.state}`;
  if (area.district) return area.district;

  const saved = (AppState.currentUser && AppState.currentUser.location || '').trim();
  if (saved) return saved;

  if (area.state) return area.state;
  return (AppState.userLocation && AppState.userLocation.name) || 'Bhubaneswar, Odisha';
}

// "Kanpur Nagar" — the short city/district name for compact UI slots.
function kavachDisplayCity() {
  const area = kavachUserArea();
  if (area.district) return area.district;

  const label = kavachHomeLabel();
  return (label.split(',')[0] || label).trim();
}

// The safety-response deep link. Built from window.location explicitly:
// a bare `location.origin` inside a function that declares its own
// `location` variable silently produced "https://undefined/...".
function kavachReportUrl() {
  try {
    const origin = (window.location && window.location.origin) || '';
    if (origin && origin !== 'null' && !/^file:/i.test(origin)) {
      const dir = (window.location.pathname || '').replace(/[^/]*$/, '');
      return `${origin}${dir}kavach.html#report`;
    }
  } catch (_) { /* fall through */ }
  return 'kavach.gov.in/report';
}

window.kavachHomeLabel = kavachHomeLabel;
window.kavachDisplayCity = kavachDisplayCity;
window.kavachReportUrl = kavachReportUrl;

// ══════════════════════════════════════════════════════════════
//  PER-DISASTER MESSAGE LIBRARY
//
//  A flood, a cyclone and an earthquake require completely different
//  things from a citizen in the first sixty seconds — "stay indoors"
//  is correct advice for a cyclone and dangerous advice for an
//  earthquake. Every citizen-facing string is therefore keyed by
//  hazard type rather than by severity alone: the wellness check, the
//  dashboard advisory, the alert card and the SMS broadcast all read
//  from here.
//
//  Each entry: icon, accent colour, and per-language {name, ask,
//  line, action, tips[]}. `ask` is the wellness question, `line` is
//  the situation statement ({where} is substituted), `action` is the
//  single most important immediate instruction.
// ══════════════════════════════════════════════════════════════
const DISASTER_PROFILES = {
  flood: {
    icon: '🌊', color: '#0369a1', helpline: '1070',
    english: {
      name: 'Flood',
      ask: 'Is everyone safe from the rising water?',
      line: 'Flood water is rising in {where}.',
      action: 'Move to the highest floor or higher ground now. Never walk or drive through floodwater.',
      tips: ['Switch off the mains before water reaches sockets', 'Carry drinking water, medicines and ID upstairs', 'Do not touch submerged wiring or appliances'],
    },
    hindi: {
      name: 'बाढ़',
      ask: 'क्या सभी पानी से सुरक्षित हैं?',
      line: '{where} में बाढ़ का पानी बढ़ रहा है।',
      action: 'तुरंत ऊपरी मंज़िल या ऊँची जगह पर जाएँ। बाढ़ के पानी में कभी न चलें और न वाहन चलाएँ।',
      tips: ['पानी सॉकेट तक पहुँचने से पहले मेन स्विच बंद करें', 'पीने का पानी, दवाइयाँ और पहचान पत्र ऊपर ले जाएँ', 'डूबे हुए तार या उपकरण को न छुएँ'],
    },
    hinglish: {
      name: 'Baadh (Flood)',
      ask: 'Kya sab log paani se safe hain?',
      line: '{where} mein baadh ka paani badh raha hai.',
      action: 'Turant upri manzil ya unchi jagah par jaayein. Flood water mein kabhi na chalein na gaadi chalayein.',
      tips: ['Paani socket tak pahunchne se pehle main switch band karein', 'Peene ka paani, dawai aur ID upar le jaayein', 'Doobe hue wire ya appliance ko na chhuein'],
    },
  },

  cyclone: {
    icon: '🌀', color: '#7c3aed', helpline: '1800-180-1717',
    english: {
      name: 'Cyclone',
      ask: 'Have you reached a cyclone shelter safely?',
      line: 'A cyclone is approaching {where}.',
      action: 'Evacuate coastal and low-lying areas now and move to the nearest cyclone shelter.',
      tips: ['Board up windows and secure loose objects outside', 'Keep torch, power bank, water and dry food ready', 'Stay away from the coast even after winds drop — the calm may be the eye'],
    },
    hindi: {
      name: 'चक्रवात',
      ask: 'क्या आप सुरक्षित रूप से चक्रवात आश्रय तक पहुँच गए हैं?',
      line: '{where} की ओर चक्रवात बढ़ रहा है।',
      action: 'तटीय और निचले इलाके तुरंत खाली करें और नज़दीकी चक्रवात आश्रय में जाएँ।',
      tips: ['खिड़कियाँ बंद करें और बाहर रखी चीज़ें सुरक्षित करें', 'टॉर्च, पावर बैंक, पानी और सूखा भोजन तैयार रखें', 'हवा रुकने पर भी तट से दूर रहें — यह तूफ़ान की आँख हो सकती है'],
    },
    hinglish: {
      name: 'Cyclone',
      ask: 'Kya aap safely cyclone shelter tak pahunch gaye hain?',
      line: '{where} ki taraf cyclone badh raha hai.',
      action: 'Coastal aur nichle ilaake turant khaali karein, nazdeeki cyclone shelter jaayein.',
      tips: ['Khidkiyan band karein, bahar ka saamaan secure karein', 'Torch, power bank, paani aur sookha khana ready rakhein', 'Hawa rukne par bhi coast se door rahein — wo toofan ki aankh ho sakti hai'],
    },
  },

  earthquake: {
    icon: '🏚️', color: '#b45309', helpline: '1078',
    english: {
      name: 'Earthquake',
      ask: 'Is everyone out of the building and unhurt?',
      line: 'An earthquake has been reported near {where}. Aftershocks are possible.',
      action: 'Drop, cover and hold on. Once shaking stops, evacuate by the stairs — never use a lift.',
      tips: ['Stay clear of walls, balconies and parked vehicles outside', 'Check for gas leaks and cracks before re-entering', 'Do not re-enter a damaged building until it is cleared'],
    },
    hindi: {
      name: 'भूकंप',
      ask: 'क्या सभी लोग इमारत से बाहर और सुरक्षित हैं?',
      line: '{where} के पास भूकंप की सूचना है। झटके दोबारा आ सकते हैं।',
      action: 'झुकें, ढकें और पकड़ें। कंपन रुकने पर सीढ़ियों से बाहर निकलें — लिफ्ट का प्रयोग न करें।',
      tips: ['बाहर दीवारों, बालकनी और खड़े वाहनों से दूर रहें', 'वापस जाने से पहले गैस रिसाव और दरारें जाँचें', 'क्षतिग्रस्त इमारत में जाँच से पहले न लौटें'],
    },
    hinglish: {
      name: 'Bhukamp (Earthquake)',
      ask: 'Kya sab log building se bahar aur safe hain?',
      line: '{where} ke paas bhukamp aaya hai. Aftershocks aa sakte hain.',
      action: 'Jhukein, dhakein aur pakdein. Jhatke rukne par seedhiyon se bahar niklein — lift use na karein.',
      tips: ['Bahar deewaron, balcony aur khadi gaadiyon se door rahein', 'Wapas jaane se pehle gas leak aur daraarein check karein', 'Damaged building mein clearance se pehle na jaayein'],
    },
  },

  heavyrain: {
    icon: '🌧️', color: '#0284c7', helpline: '1078',
    english: {
      name: 'Heavy Rain',
      ask: 'Is everyone home safely?',
      line: 'Heavy to very heavy rain is expected in {where}.',
      action: 'Avoid unnecessary travel. Do not cross waterlogged roads or underpasses.',
      tips: ['Keep your phone charged and emergency numbers handy', 'Park vehicles away from low-lying spots and trees', 'Watch for waterlogging near drains and underpasses'],
    },
    hindi: {
      name: 'भारी वर्षा',
      ask: 'क्या सभी सुरक्षित घर पहुँच गए हैं?',
      line: '{where} में भारी से अति भारी वर्षा की संभावना है।',
      action: 'अनावश्यक यात्रा से बचें। जलभराव वाली सड़कों और अंडरपास से न गुज़रें।',
      tips: ['फ़ोन चार्ज रखें और आपात नंबर पास रखें', 'वाहन निचली जगह और पेड़ों से दूर खड़ा करें', 'नालों और अंडरपास के पास जलभराव पर ध्यान दें'],
    },
    hinglish: {
      name: 'Heavy Rain',
      ask: 'Kya sab log safely ghar pahunch gaye hain?',
      line: '{where} mein bhaari se ati-bhaari barish ho sakti hai.',
      action: 'Bina zaroorat bahar na niklein. Waterlogged sadak ya underpass cross na karein.',
      tips: ['Phone charge rakhein aur emergency number paas rakhein', 'Gaadi nichli jagah aur pedon se door khadi karein', 'Naalon aur underpass ke paas waterlogging dekhein'],
    },
  },

  thunderstorm: {
    icon: '⛈️', color: '#4338ca', helpline: '1078',
    english: {
      name: 'Thunderstorm',
      ask: 'Is everyone indoors and away from open ground?',
      line: 'A severe thunderstorm with lightning is expected in {where}.',
      action: 'Move indoors immediately. Do not shelter under trees or stand in open fields.',
      tips: ['Unplug appliances and avoid corded phones', 'Stay away from metal railings, poles and wet walls', 'Wait 30 minutes after the last thunder before going out'],
    },
    hindi: {
      name: 'आंधी-तूफ़ान',
      ask: 'क्या सभी घर के अंदर और खुले मैदान से दूर हैं?',
      line: '{where} में बिजली के साथ तेज़ आंधी-तूफ़ान की संभावना है।',
      action: 'तुरंत घर के अंदर जाएँ। पेड़ के नीचे या खुले मैदान में न रुकें।',
      tips: ['उपकरण अनप्लग करें, तार वाले फ़ोन से बचें', 'धातु की रेलिंग, खंभों और गीली दीवारों से दूर रहें', 'आख़िरी गड़गड़ाहट के 30 मिनट बाद ही बाहर जाएँ'],
    },
    hinglish: {
      name: 'Toofan / Bijli',
      ask: 'Kya sab log ghar ke andar aur khule maidan se door hain?',
      line: '{where} mein bijli ke saath tez toofan ho sakta hai.',
      action: 'Turant ghar ke andar jaayein. Ped ke neeche ya khule maidan mein na rukein.',
      tips: ['Appliances unplug karein, corded phone avoid karein', 'Metal railing, khambe aur geeli deewar se door rahein', 'Aakhri garaj ke 30 minute baad hi bahar jaayein'],
    },
  },

  landslide: {
    icon: '⛰️', color: '#78350f', helpline: '1078',
    english: {
      name: 'Landslide',
      ask: 'Is everyone away from the slope and safe?',
      line: 'Landslide risk is high in {where}.',
      action: 'Move away from slopes, cuttings and hill roads immediately, sideways out of the debris path.',
      tips: ['Listen for cracking trees or shifting rocks', 'Avoid river valleys and stream channels below slopes', 'Do not return for belongings once you have moved out'],
    },
    hindi: {
      name: 'भूस्खलन',
      ask: 'क्या सभी ढलान से दूर और सुरक्षित हैं?',
      line: '{where} में भूस्खलन का ख़तरा अधिक है।',
      action: 'ढलानों, कटान और पहाड़ी सड़कों से तुरंत दूर हटें — मलबे के रास्ते से बगल की ओर जाएँ।',
      tips: ['पेड़ चटकने या पत्थर खिसकने की आवाज़ पर ध्यान दें', 'ढलान के नीचे नदी घाटी और नालों से बचें', 'बाहर निकलने के बाद सामान लेने वापस न जाएँ'],
    },
    hinglish: {
      name: 'Landslide',
      ask: 'Kya sab log dhalaan se door aur safe hain?',
      line: '{where} mein landslide ka khatra zyada hai.',
      action: 'Dhalaan, cutting aur pahaadi sadak se turant hatein — malbe ke raaste se bagal ki taraf jaayein.',
      tips: ['Ped chatakne ya patthar khisakne ki aawaz par dhyan dein', 'Dhalaan ke neeche nadi ghaati aur naalon se bachein', 'Bahar nikalne ke baad saamaan lene wapas na jaayein'],
    },
  },

  heatwave: {
    icon: '🌡️', color: '#dc2626', helpline: '104',
    english: {
      name: 'Heatwave',
      ask: 'Is everyone hydrated and out of the sun?',
      line: 'Heatwave conditions are affecting {where}.',
      action: 'Stay indoors between 11 AM and 4 PM and drink water frequently, even without thirst.',
      tips: ['Check on elderly people, children and outdoor workers', 'Wear light cotton clothing and cover your head outside', 'Watch for dizziness, cramps or stopped sweating — call 108'],
    },
    hindi: {
      name: 'लू',
      ask: 'क्या सभी ने पर्याप्त पानी पिया है और धूप से दूर हैं?',
      line: '{where} में लू का प्रकोप है।',
      action: 'सुबह 11 से शाम 4 बजे तक घर के अंदर रहें और बार-बार पानी पिएँ।',
      tips: ['बुज़ुर्गों, बच्चों और बाहर काम करने वालों का ध्यान रखें', 'हल्के सूती कपड़े पहनें, बाहर सिर ढकें', 'चक्कर, ऐंठन या पसीना रुकने पर 108 पर कॉल करें'],
    },
    hinglish: {
      name: 'Loo (Heatwave)',
      ask: 'Kya sab log hydrated hain aur dhoop se door hain?',
      line: '{where} mein loo ka prakop hai.',
      action: '11 baje se 4 baje tak ghar ke andar rahein aur baar-baar paani piyein.',
      tips: ['Buzurgon, bachchon aur bahar kaam karne walon ka dhyan rakhein', 'Halke cotton kapde pehnein, bahar sar dhakein', 'Chakkar, ainthan ya paseena rukne par 108 par call karein'],
    },
  },

  fire: {
    icon: '🔥', color: '#ea580c', helpline: '101',
    english: {
      name: 'Fire',
      ask: 'Is everyone out of the building?',
      line: 'A fire emergency has been reported in {where}.',
      action: 'Evacuate immediately by the stairs, stay low under the smoke, and call 101.',
      tips: ['Do not use lifts, and do not go back for belongings', 'Close doors behind you to slow the fire', 'Feel a door with the back of your hand before opening it'],
    },
    hindi: {
      name: 'आग',
      ask: 'क्या सभी लोग इमारत से बाहर निकल गए हैं?',
      line: '{where} में आग की आपात स्थिति है।',
      action: 'तुरंत सीढ़ियों से बाहर निकलें, धुएँ के नीचे झुककर चलें, और 101 पर कॉल करें।',
      tips: ['लिफ्ट का प्रयोग न करें, सामान के लिए वापस न जाएँ', 'पीछे के दरवाज़े बंद करें ताकि आग धीमी हो', 'दरवाज़ा खोलने से पहले हाथ के पिछले हिस्से से गर्मी जाँचें'],
    },
    hinglish: {
      name: 'Aag (Fire)',
      ask: 'Kya sab log building se bahar nikal gaye hain?',
      line: '{where} mein aag ki emergency hai.',
      action: 'Turant seedhiyon se bahar niklein, dhuen ke neeche jhuk kar chalein, aur 101 par call karein.',
      tips: ['Lift use na karein, saamaan ke liye wapas na jaayein', 'Peeche ke darwaze band karein taaki aag dheemi ho', 'Darwaza kholne se pehle haath ke peeche se garmi check karein'],
    },
  },

  tsunami: {
    icon: '🌊', color: '#0f766e', helpline: '1078',
    english: {
      name: 'Tsunami',
      ask: 'Have you reached high ground away from the shore?',
      line: 'A tsunami warning is in force for {where}.',
      action: 'Move inland and to high ground immediately. Do not wait to see the wave.',
      tips: ['Go on foot if roads are jammed — do not wait in traffic', 'Stay high for several hours; later waves are often larger', 'Return only when officially told it is safe'],
    },
    hindi: {
      name: 'सुनामी',
      ask: 'क्या आप तट से दूर ऊँचे स्थान पर पहुँच गए हैं?',
      line: '{where} के लिए सुनामी चेतावनी जारी है।',
      action: 'तुरंत अंदर की ओर और ऊँची जगह जाएँ। लहर देखने के लिए रुकें नहीं।',
      tips: ['सड़क जाम हो तो पैदल जाएँ — ट्रैफ़िक में न रुकें', 'कई घंटे ऊँचाई पर रहें; बाद की लहरें बड़ी हो सकती हैं', 'आधिकारिक सूचना पर ही लौटें'],
    },
    hinglish: {
      name: 'Tsunami',
      ask: 'Kya aap coast se door unchi jagah pahunch gaye hain?',
      line: '{where} ke liye tsunami warning hai.',
      action: 'Turant andar ki taraf aur unchi jagah jaayein. Lehar dekhne ke liye na rukein.',
      tips: ['Sadak jam ho to paidal jaayein — traffic mein na rukein', 'Kai ghante unchai par rahein; baad ki lehrein badi hoti hain', 'Official clearance par hi wapas aayein'],
    },
  },

  coldwave: {
    icon: '❄️', color: '#0e7490', helpline: '1078',
    english: {
      name: 'Cold Wave',
      ask: 'Is everyone warm and indoors?',
      line: 'Cold wave conditions are affecting {where}.',
      action: 'Stay indoors, wear layers, and check on anyone sleeping outside.',
      tips: ['Never burn coal in a closed room — carbon monoxide kills', 'Cover head, hands and feet; drink warm fluids', 'Look in on elderly neighbours and the homeless'],
    },
    hindi: {
      name: 'शीत लहर',
      ask: 'क्या सभी गर्म कपड़ों में और घर के अंदर हैं?',
      line: '{where} में शीत लहर का प्रकोप है।',
      action: 'घर के अंदर रहें, परतों में कपड़े पहनें, और बाहर सोने वालों का ध्यान रखें।',
      tips: ['बंद कमरे में कोयला न जलाएँ — कार्बन मोनोऑक्साइड जानलेवा है', 'सिर, हाथ और पैर ढकें; गर्म पेय लें', 'बुज़ुर्ग पड़ोसियों और बेघर लोगों का हाल लें'],
    },
    hinglish: {
      name: 'Sheet Lehar (Cold Wave)',
      ask: 'Kya sab log garam kapdon mein aur ghar ke andar hain?',
      line: '{where} mein sheet lehar chal rahi hai.',
      action: 'Ghar ke andar rahein, layers mein kapde pehnein, bahar sone walon ka dhyan rakhein.',
      tips: ['Band kamre mein koyla na jalayein — carbon monoxide jaanleva hai', 'Sar, haath aur pair dhakein; garam pey lein', 'Buzurg padosiyon aur beghar logon ka haal lein'],
    },
  },

  default: {
    icon: '⚠️', color: '#f05a28', helpline: '1078',
    english: {
      name: 'Emergency Alert',
      ask: 'Is everyone safe?',
      line: 'An official alert is active for {where}.',
      action: 'Stay alert and follow instructions from local authorities.',
      tips: ['Keep your phone charged and emergency numbers handy', 'Keep ID, medicines and drinking water ready', 'Follow only official SACHET / IMD updates'],
    },
    hindi: {
      name: 'आपातकालीन चेतावनी',
      ask: 'क्या सभी सुरक्षित हैं?',
      line: '{where} के लिए आधिकारिक चेतावनी सक्रिय है।',
      action: 'सतर्क रहें और स्थानीय प्रशासन के निर्देशों का पालन करें।',
      tips: ['फ़ोन चार्ज रखें और आपात नंबर पास रखें', 'पहचान पत्र, दवाइयाँ और पीने का पानी तैयार रखें', 'केवल आधिकारिक SACHET / IMD सूचना मानें'],
    },
    hinglish: {
      name: 'Emergency Alert',
      ask: 'Kya sab safe hain?',
      line: '{where} ke liye official alert active hai.',
      action: 'Satark rahein aur local authority ke nirdeshon ka paalan karein.',
      tips: ['Phone charge rakhein aur emergency number paas rakhein', 'ID, dawai aur peene ka paani ready rakhein', 'Sirf official SACHET / IMD update follow karein'],
    },
  },
};

// Keyword -> hazard, checked in order (most specific first).
const _HAZARD_PATTERNS = [
  ['tsunami',      /tsunami/i],
  ['cyclone',      /cyclon|hurricane|typhoon|depression|gale\s*warning/i],
  ['earthquake',   /earthquake|seismic|tremor|bhukamp/i],
  ['landslide',    /landslide|land\s*slide|mudslide|rockfall|bhooskhalan/i],
  ['fire',         /\bfire\b|wildfire|blaze|\baag\b/i],
  ['flood',        /flood|inundat|baadh|deluge|water\s*logg|urban\s*flood/i],
  ['thunderstorm', /thunder|lightning|squall|hailstorm|nowcast/i],
  ['heatwave',     /heat\s*wave|heatwave|\bheat\b|loo\b|warm\s*night/i],
  ['coldwave',     /cold\s*wave|coldwave|cold\s*day|frost|sheet\s*lehar/i],
  ['heavyrain',    /rain|shower|precipitat|barish|monsoon/i],
];

// Classify a hazard from an official alert, a weather reading, or a
// plain string. Official CAP event text always wins over the local
// weather heuristic.
function kavachHazardType(source) {
  if (!source) return 'default';

  if (typeof source === 'string') {
    for (const [key, re] of _HAZARD_PATTERNS) if (re.test(source)) return key;
    return 'default';
  }

  // A CAP alert / broadcast.
  const text = [
    source.event, source.headline, source.title,
    source.description, source.instruction, source.areaDesc,
  ].filter(Boolean).join(' ');
  if (text) {
    for (const [key, re] of _HAZARD_PATTERNS) if (re.test(text)) return key;
  }

  // A weather reading — fall back to the existing numeric heuristic.
  if (source.condition || source.rainfall != null || source.wind != null) {
    try {
      const wt = detectWeatherType(source);
      if (wt && wt !== 'default') {
        return ({ storm: 'thunderstorm', fog: 'heavyrain' })[wt] || wt;
      }
    } catch (_) { /* detectWeatherType not ready yet */ }
  }

  return 'default';
}

// Resolve the localized copy for a hazard. `where` is substituted into
// the situation line.
function kavachDisasterCopy(hazard, where, lang) {
  const profile = DISASTER_PROFILES[hazard] || DISASTER_PROFILES.default;
  const language = lang || AppState.uiLang || 'english';
  const copy = profile[language] || profile.english;

  return {
    hazard,
    icon: profile.icon,
    color: profile.color,
    helpline: profile.helpline,
    name: copy.name,
    ask: copy.ask,
    line: copy.line.replace('{where}', where || kavachDisplayCity()),
    action: copy.action,
    tips: copy.tips || [],
  };
}

window.DISASTER_PROFILES = DISASTER_PROFILES;
window.kavachHazardType = kavachHazardType;
window.kavachDisasterCopy = kavachDisasterCopy;

// ══════════════════════════════════════════════════════════════
//  DARK MODE
//
//  Three settings: 'light', 'dark', 'auto' (follow the device).
//  'auto' is resolved to a concrete value here rather than in a
//  media query, so the stylesheet only needs one dark block and the
//  resolved theme is always readable from the DOM.
// ══════════════════════════════════════════════════════════════
const KV_THEME_KEY = 'kavach_theme';

function kavachPreferredTheme() {
  try { return localStorage.getItem(KV_THEME_KEY) || 'auto'; }
  catch (_) { return 'auto'; }
}

function kavachResolveTheme(setting) {
  if (setting === 'dark' || setting === 'light') return setting;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch (_) { return 'light'; }
}

function kavachApplyTheme(setting) {
  const pref = setting || kavachPreferredTheme();
  const resolved = kavachResolveTheme(pref);

  document.documentElement.setAttribute('data-kv-theme', resolved);
  AppState.theme = pref;
  AppState.resolvedTheme = resolved;

  // Keep the phone's status bar / browser chrome in step.
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = resolved === 'dark' ? '#0E1420' : '#1565C0';

  // Refresh the toggle's icon + label wherever it is rendered.
  const icon = resolved === 'dark' ? '☀️' : '🌙';
  document.querySelectorAll('[data-kv-theme-btn]').forEach((b) => {
    b.textContent = icon;
    b.title = resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  });
  const select = document.getElementById('prof-theme');
  if (select && select.value !== pref) select.value = pref;

  return resolved;
}

function kavachSetTheme(setting) {
  try { localStorage.setItem(KV_THEME_KEY, setting); } catch (_) {}
  const resolved = kavachApplyTheme(setting);
  if (typeof showToast === 'function' && setting !== 'auto') {
    showToast(resolved === 'dark' ? '🌙 Dark mode on' : '☀️ Light mode on', 'success');
  }
  return resolved;
}

// Header button: straight light <-> dark flip.
function kavachToggleTheme() {
  return kavachSetTheme(AppState.resolvedTheme === 'dark' ? 'light' : 'dark');
}

window.kavachApplyTheme = kavachApplyTheme;
window.kavachSetTheme = kavachSetTheme;
window.kavachToggleTheme = kavachToggleTheme;

// Apply before first paint so the app never flashes light-then-dark.
kavachApplyTheme();

// Follow the device while the citizen is on "auto".
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (kavachPreferredTheme() === 'auto') kavachApplyTheme('auto');
  });
} catch (_) { /* older browsers */ }

// ──────────────────────────────────────────────────────────────
//  DASHBOARD
// ──────────────────────────────────────────────────────────────
function updateDashboard() {
  if (AppState.currentUser) {
    const el = document.getElementById('dash-user-name');
    if (el) el.textContent = AppState.currentUser.name || 'Vyom';
  }

  // Always the district the citizen registered with — never a
  // reverse-geocoded state name or a hardcoded default.
  const locEl = document.getElementById('dash-location');
  if (locEl) locEl.textContent = kavachHomeLabel();

  // Update the live weather card using the current-location entry produced
  // by fetchExactWeatherForLocation() — NOT the nearest predefined city.
  updateWeatherCardUI();

  updateGreeting();
  renderCitizenReportsPanel();

  // Hazard-specific advisory on the dashboard card. An active official
  // alert for this district decides the hazard; otherwise the local
  // weather reading does. Either way the advice is the one that
  // matches the actual disaster, not a generic "stay indoors".
  const adv = document.getElementById('safety-advisory-text');
  if (adv) {
    const officialAlert = (AppState.sachetAlerts || []).find(a => {
      try { return isAlertActive(a) && alertCoversKavachAreaStrict(a); } catch (_) { return false; }
    });

    const w = getNearestWeather();
    const sev = (w && w.severity || 'low').toLowerCase();

    if (officialAlert) {
      const copy = kavachDisasterCopy(kavachHazardType(officialAlert), kavachDisplayCity());
      adv.textContent = `${copy.icon} ${copy.line} ${copy.action}`;
    } else if (sev === 'severe' || sev === 'high') {
      const copy = kavachDisasterCopy(kavachHazardType(w), kavachDisplayCity());
      adv.textContent = `${copy.icon} ${copy.line} ${copy.action}`;
    } else if (sev === 'moderate') {
      adv.textContent = 'Unsettled weather expected. Keep your phone charged, avoid low-lying roads, and watch for official SACHET / IMD alerts.';
    } else {
      adv.textContent = 'Conditions are normal. Keep an emergency kit, know your nearest shelter, and follow only official alerts.';
    }
  }

  try { updateNotifyPrompt(); } catch (_) {}
  try { updateBellDot(); } catch (_) {}
  try { maybeAskWellnessCheck(); } catch (_) {}
}

// ══════════════════════════════════════════════════════════════
//  ALERTS  —  notifications, alert history, broadcast ingest,
//  and the "are you safe?" wellness check
// ══════════════════════════════════════════════════════════════

// ---- Notification enable prompt ----
function updateNotifyPrompt() {
  const card = document.getElementById('notify-prompt');
  if (!card) return;
  const st = (typeof kavachNotifyState === 'function') ? kavachNotifyState() : 'unsupported';
  card.style.display = (st === 'default') ? 'flex' : 'none';
}
async function kavachEnableAlerts() {
  const res = await kavachEnsureNotifyPermission(true);
  if (res === 'granted') showToast('Emergency alerts enabled', 'success');
  else if (res === 'denied') showToast('Notifications are blocked in your browser settings.', 'warning');
  updateNotifyPrompt();
}
window.kavachEnableAlerts = kavachEnableAlerts;

function updateBellDot() {
  const dot = document.getElementById('dash-bell-dot');
  if (!dot) return;
  const n = (AppState.sachetAlerts || []).filter(a => { try { return isAlertActive(a) && alertTouchesKavachArea(a); } catch (_) { return false; } }).length;
  dot.style.display = n > 0 ? 'block' : 'none';
}

// ---- "Are you safe?" wellness check ----
// When the app is opened and there is an ACTIVE alert / authority
// broadcast covering the city the user signed in with, ask them once
// whether they are OK. "No" opens the safety-status form; "Yes"
// continues into the app. Re-asked only for a new alert.
function _wellnessAsked() {
  try { return new Set(JSON.parse(sessionStorage.getItem('kavach_wellness_asked') || '[]')); }
  catch (_) { return new Set(); }
}
function _markWellnessAsked(id) {
  const s = _wellnessAsked(); s.add(id);
  try { sessionStorage.setItem('kavach_wellness_asked', JSON.stringify([...s])); } catch (_) {}
}
// STRICT area test for the wellness prompt.
//
// alertTouchesKavachArea() is deliberately permissive — with no
// district set it shows everything, so the alerts list is never empty.
// That is wrong for an interrupting modal: "Is everyone safe?" must
// only ever appear when an official SACHET / IMD warning genuinely
// covers this citizen's area. This version requires a POSITIVE match
// (inside the alert geometry, or the area named in the alert text) and
// returns false whenever there is nothing to match against.
function alertCoversKavachAreaStrict(alert) {
  if (!alert) return false;

  const area = kavachUserArea();

  // Geometry test — the citizen's point inside the CAP polygon/circle.
  if (area.lat != null && area.lng != null) {
    if (Array.isArray(alert.polygon) && alert.polygon.length >= 3 &&
        pointInPolygon(area.lat, area.lng, alert.polygon)) return true;
    if (alert.circle &&
        haversineKm(area.lat, area.lng, alert.circle.lat, alert.circle.lng) <= alert.circle.radiusKm) return true;
  }

  // Name test — the alert explicitly names the registered district.
  const hay = _kvNorm(`${alert.areaDesc || ''} ${alert.headline || ''} ${alert.description || ''} ${alert.event || ''} ${alert.title || ''}`);
  const district = _kvNorm(area.district);
  if (district && hay.includes(district)) return true;

  // A command-centre broadcast addressed to this district by name.
  if (alert.source === 'BROADCAST' && district) {
    const target = _kvNorm(alert.district || alert.area || '');
    if (target && (target.includes(district) || district.includes(target))) return true;
  }

  return false;
}
window.alertCoversKavachAreaStrict = alertCoversKavachAreaStrict;

function maybeAskWellnessCheck() {
  if (AppState.currentScreen !== 'dashboard') return;
  if (document.getElementById('modal-overlay')?.classList.contains('show')) return;

  // Only ever prompted by a real, active, in-area official warning.
  const hits = (AppState.sachetAlerts || [])
    .filter(a => { try { return isAlertActive(a) && alertCoversKavachAreaStrict(a); } catch (_) { return false; } });
  if (!hits.length) return;

  // most severe first
  const rank = { extreme: 4, severe: 3, high: 3, moderate: 2, minor: 1, unknown: 0 };
  hits.sort((x, y) => (y.source === 'BROADCAST') - (x.source === 'BROADCAST') || (rank[y.severity] || 0) - (rank[x.severity] || 0));
  const a = hits[0];
  const key = a.id || a.link || (a.event + '|' + (a.effective || a.pubDate || ''));
  if (!key || _wellnessAsked().has(key)) return;
  _markWellnessAsked(key);

  const area = kavachUserArea();
  const where = area.district || area.state || (a.areaDesc || 'your area').split(',')[0];
  const lang = AppState.uiLang || 'english';

  // The question and the advice are specific to THIS hazard — a flood
  // and an earthquake need opposite instructions.
  const hazard = kavachHazardType(a);
  const copy = kavachDisasterCopy(hazard, where, lang);

  const BTN = {
    english:  { safe: '✅ Yes, we are safe', help: '🆘 No, we need help' },
    hindi:    { safe: '✅ हाँ, हम सुरक्षित हैं', help: '🆘 नहीं, हमें मदद चाहिए' },
    hinglish: { safe: '✅ Haan, hum safe hain', help: '🆘 Nahi, madad chahiye' },
  };
  const B = BTN[lang] || BTN.english;

  const mc = document.getElementById('modal-content');
  if (!mc) return;
  mc.innerHTML = `<div class="wc-modal">
    <div class="wc-ic" style="color:${copy.color}">${copy.icon}</div>
    <div style="font-size:11px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:${copy.color};margin-bottom:4px;">
      ${escapeHtml(severityLabel(a.severity))} · ${escapeHtml(copy.name)}
    </div>
    <h3>${escapeHtml(copy.ask)}</h3>
    <p>${escapeHtml(copy.line)}
      <br><span style="display:block;margin-top:8px;font-size:12px;color:#334155;font-weight:600;">${escapeHtml(copy.action)}</span>
    </p>
    <div class="wc-btns">
      <button class="wc-btn safe" onclick="wellnessRespond(true)">${B.safe}</button>
      <button class="wc-btn help" onclick="wellnessRespond(false)">${B.help}</button>
    </div>
  </div>`;
  document.getElementById('modal-overlay')?.classList.add('show');
}
function wellnessRespond(safe) {
  document.getElementById('modal-overlay')?.classList.remove('show');
  if (safe) {
    if (typeof showToast === 'function') showToast('Stay alert and follow official instructions.', 'success');
  } else if (typeof openCitizenRegister === 'function') {
    openCitizenRegister();
  } else if (typeof openEmergencyForm === 'function') {
    openEmergencyForm();
  }
}
window.maybeAskWellnessCheck = maybeAskWellnessCheck;
window.wellnessRespond = wellnessRespond;

// ---- Alert history ----
function renderAlertHistory() {
  const el = document.getElementById('alert-history-list');
  if (!el) return;
  const items = [...(AppState.sachetAlerts || [])];
  // include expired-but-recent broadcasts from storage too
  try {
    const stored = _loadPersistedBroadcasts();
    for (const p of stored) {
      const a = _broadcastToAlert(p);
      if (!items.some(x => x.id === a.id)) items.push(a);
    }
  } catch (_) {}
  if (!items.length) {
    el.innerHTML = '<div class="ah-empty">📭<br>No alerts or broadcasts yet.<br><span style="font-size:11px;">Official warnings for your area will appear here.</span></div>';
    return;
  }
  items.sort((x, y) => new Date(y.effective || y.pubDate || 0) - new Date(x.effective || x.pubDate || 0));
  el.innerHTML = items.map(a => {
    const sev = a.severity || 'unknown';
    const isBc = a.source === 'BROADCAST';
    const active = (function(){ try { return isAlertActive(a); } catch (_) { return false; } })();
    const when = relativeTime(a.effective || a.pubDate);
    return `<div class="ah-card ${sev}">
      <div class="ah-top">
        <span class="ah-badge ${isBc ? 'broadcast' : ''}">${isBc ? '📡 BROADCAST' : severityLabel(sev)}</span>
        <span class="ah-badge" style="background:${active ? '#e8f5e9' : '#f1f5f9'};color:${active ? '#2e7d32' : '#94a3b8'};">${active ? 'ACTIVE' : 'ENDED'}</span>
      </div>
      <div class="ah-event">${escapeHtml((a.event || a.title || 'Alert').slice(0, 80))}</div>
      <div class="ah-area">${escapeHtml((a.areaDesc || '').slice(0, 120))}</div>
      ${a.instruction ? `<div class="ah-area" style="font-style:italic;color:#9a3412;margin-top:4px;">${escapeHtml(a.instruction.slice(0, 140))}</div>` : ''}
      <div class="ah-meta"><span>${escapeHtml(isBc ? 'RESQNET Command Centre' : (a.sender || 'IMD / NDMA'))}</span><span>${when}</span></div>
    </div>`;
  }).join('');
}
window.renderAlertHistory = renderAlertHistory;

function getNearestWeather() {
  // FIX: guard — return null instead of throwing when weatherData is
  // empty; every caller of this function already checks for a falsy
  // result before using it.
  if (!Array.isArray(MockDB.weatherData) || !MockDB.weatherData.length) return null;
  const { lat, lng } = AppState.userLocation;
  let nearest = MockDB.weatherData[0];
  let minDist = Infinity;
  MockDB.weatherData.forEach(w => {
    const d = Math.sqrt((lat - w.lat) ** 2 + (lng - w.lng) ** 2);
    if (d < minDist) { minDist = d; nearest = w; }
  });
  return nearest;
}

// ──────────────────────────────────────────────────────────────
//  MAP RENDERING (kept for dashboard fallback)
// ──────────────────────────────────────────────────────────────
function renderSimulatedMap() {
  const container = document.getElementById('sim-map-container');
  if (!container) return;
  if (!Array.isArray(MockDB.weatherData)) return;

  // Odisha bounding box approx: lat 17.8–22.6, lng 81.4–87.5
  const bounds = { minLat: 18.5, maxLat: 22.2, minLng: 81.5, maxLng: 87.5 };
  const W = 362, H = 200;

  function toXY(lat, lng) {
    const x = ((lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * W;
    const y = ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * H;
    return { x, y };
  }

  const severityColor = { low: '#43A047', moderate: '#F9A825', high: '#E65100', severe: '#C62828' };

  // Keep defs and circles separated — no regex needed
  let gradientDefs = '';
  let heatBlobs    = '';
  let markers      = '';
  let labels       = '';

  MockDB.weatherData.forEach(w => {
    const { x, y } = toXY(w.lat, w.lng);
    const color = severityColor[w.severity] || '#999';
    const r = w.severity === 'severe' ? 38 : w.severity === 'high' ? 30 : w.severity === 'moderate' ? 22 : 16;

    // Gradient def
    gradientDefs += `<radialGradient id="hg_${w.id}" cx="50%" cy="50%">
      <stop offset="0%"   style="stop-color:${color};stop-opacity:0.55"/>
      <stop offset="70%"  style="stop-color:${color};stop-opacity:0.25"/>
      <stop offset="100%" style="stop-color:${color};stop-opacity:0"/>
    </radialGradient>`;

    // Heatmap blob
    heatBlobs += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="url(#hg_${w.id})"/>`;

    // City dot — clickable
    markers += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${color}" stroke="white" stroke-width="1.5" style="cursor:pointer;" onclick="showWeatherPopup('${w.id}')"/>`;

    // Label
    labels += `<text x="${x.toFixed(1)}" y="${(y-8).toFixed(1)}" text-anchor="middle" font-size="8" fill="#1A1F2E" font-family="Inter,sans-serif" font-weight="600" style="pointer-events:none;">${w.city}</text>`;
  });

  // User location marker
  // FIX: guard against userLocation still being null (e.g. before
  // geolocation resolves) so toXY() doesn't get fed non-finite values.
  const hasUserLoc = Number.isFinite(AppState.userLocation.lat) && Number.isFinite(AppState.userLocation.lng);
  let userMarker = '';
  if (hasUserLoc) {
    const up = toXY(AppState.userLocation.lat, AppState.userLocation.lng);
    userMarker = `
      <circle cx="${up.x.toFixed(1)}" cy="${up.y.toFixed(1)}" r="9" fill="rgba(21,101,192,0.25)" stroke="none">
        <animate attributeName="r" values="9;14;9" dur="2s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.8;0.3;0.8" dur="2s" repeatCount="indefinite"/>
      </circle>
      <circle cx="${up.x.toFixed(1)}" cy="${up.y.toFixed(1)}" r="5" fill="#1565C0" stroke="white" stroke-width="2"/>
      <text x="${up.x.toFixed(1)}" y="${(up.y-10).toFixed(1)}" text-anchor="middle" font-size="8" fill="#1565C0" font-family="Inter,sans-serif" font-weight="700">📍 You</text>
    `;
  }

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;background:linear-gradient(135deg,#E3F2FD,#E8EAF6);">
      <defs>${gradientDefs}</defs>
      <line x1="0" y1="66" x2="${W}" y2="66" stroke="#DDE" stroke-width="0.5" stroke-dasharray="4,4"/>
      <line x1="0" y1="133" x2="${W}" y2="133" stroke="#DDE" stroke-width="0.5" stroke-dasharray="4,4"/>
      <line x1="${(W*0.33).toFixed(0)}" y1="0" x2="${(W*0.33).toFixed(0)}" y2="${H}" stroke="#DDE" stroke-width="0.5" stroke-dasharray="4,4"/>
      <line x1="${(W*0.66).toFixed(0)}" y1="0" x2="${(W*0.66).toFixed(0)}" y2="${H}" stroke="#DDE" stroke-width="0.5" stroke-dasharray="4,4"/>
      ${heatBlobs}
      ${markers}
      ${labels}
      ${userMarker}
      <rect x="4" y="4" width="120" height="14" rx="3" fill="rgba(255,255,255,0.8)"/>
      <text x="8" y="14" font-size="8" fill="#1565C0" font-family="Inter,sans-serif" font-weight="700">ODISHA — LIVE HEATMAP</text>
      <rect x="${W-90}" y="4" width="86" height="14" rx="3" fill="rgba(230,81,0,0.12)" stroke="rgba(230,81,0,0.3)" stroke-width="0.5"/>
      <text x="${W-86}" y="14" font-size="7.5" fill="#E65100" font-family="Inter,sans-serif" font-weight="700">⚠ FLOOD ALERT ACTIVE</text>
    </svg>
  `;
}

function showWeatherPopup(weatherId) {
  if (!Array.isArray(MockDB.weatherData)) return;
  const w = MockDB.weatherData.find(x => x.id === weatherId);
  if (!w) return;

  const severityLabel = { low: 'LOW', moderate: 'MODERATE', high: 'HIGH', severe: 'SEVERE' };
  const severityColor = { low: 'var(--sev-low)', moderate: 'var(--sev-moderate)', high: 'var(--sev-high)', severe: 'var(--sev-severe)' };

  document.getElementById('modal-content').innerHTML = `
    <div style="text-align:center;margin-bottom:16px;">
      <div style="font-size:32px;margin-bottom:8px;">${w.icon}</div>
      <div style="font-size:18px;font-weight:700;color:var(--text);">${w.city}</div>
      <div style="font-size:13px;color:var(--text-secondary);margin-top:4px;">${w.condition}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
      <div class="weather-detail-card"><div class="wd-label">Rainfall</div><div class="wd-value">${w.rainfall} <span class="wd-unit">mm</span></div></div>
      <div class="weather-detail-card"><div class="wd-label">Temperature</div><div class="wd-value">${w.temp} <span class="wd-unit">°C</span></div></div>
      <div class="weather-detail-card"><div class="wd-label">Wind</div><div class="wd-value">${w.wind} <span class="wd-unit">km/h</span></div></div>
      <div class="weather-detail-card"><div class="wd-label">Humidity</div><div class="wd-value">${w.humidity} <span class="wd-unit">%</span></div></div>
    </div>
    <div style="text-align:center;padding:12px;background:rgba(0,0,0,0.04);border-radius:var(--r-md);">
      <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Hazard Level</div>
      <div style="font-size:22px;font-weight:800;color:${severityColor[w.severity]};">${severityLabel[w.severity]}</div>
    </div>
    <button class="btn-primary mt-12" onclick="closeModal();showWeatherDetail('${w.id}')">View Full Details →</button>
  `;
  document.getElementById('modal-overlay').classList.add('show');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('show');
}

// ──────────────────────────────────────────────────────────────
//  WEATHER DETAIL SCREEN
// ──────────────────────────────────────────────────────────────
function showWeatherDetail(weatherId) {
  const w = weatherId
    ? (Array.isArray(MockDB.weatherData) ? MockDB.weatherData.find(x => x.id === weatherId) : null)
    : getNearestWeather();
  if (!w) return;

  setText('wd-location',  kavachHomeLabel());
  setText('wd-condition', `${w.icon} ${w.condition} — Monsoon Low Pressure System`);
  setText('wd-temp',      `${w.temp}°`);
  setText('wd-hazard',    `${w.severity.toUpperCase()} RISK`);
  setText('wd-rainfall',  `${w.rainfall} <span class="wd-unit">mm</span>`);
  setText('wd-wind',      `${w.wind} <span class="wd-unit">km/h</span>`);
  setText('wd-humidity',  `${w.humidity} <span class="wd-unit">%</span>`);
  setText('wd-visibility', '1.2 <span class="wd-unit">km</span>');
  setText('wd-pressure',  '998 <span class="wd-unit">hPa</span>');
  setText('wd-valid',     'Until 18:00');

  renderWeatherExtras(w);
  showScreen('weather');
}

// 5-day forecast strip + condition-aware safety tips (derived from the
// current reading — a lightweight "government weather app" touch).
function renderWeatherExtras(w) {
  const strip = document.getElementById('weather-forecast-strip');
  if (strip) {
    const days = ['Today', 'Tue', 'Wed', 'Thu', 'Fri'];
    const baseT = Number(w.temp) || 28;
    const baseR = Number(w.rainfall) || 10;
    strip.innerHTML = days.map((d, i) => {
      const t = Math.round(baseT + (i === 0 ? 0 : (Math.sin(i) * 3 - 1)));
      const r = Math.max(0, Math.round(baseR * (i === 0 ? 1 : (1 - i * 0.18)) + (i % 2 ? 4 : -3)));
      const ic = r > 60 ? '⛈️' : r > 25 ? '🌧️' : r > 8 ? '🌦️' : '⛅';
      return `<div class="weather-card" style="min-width:74px;text-align:center;padding:10px 8px;">
        <div style="font-size:11px;color:var(--text-muted);font-weight:700;">${d}</div>
        <div style="font-size:22px;margin:4px 0;">${ic}</div>
        <div style="font-size:14px;font-weight:800;">${t}°</div>
        <div style="font-size:10px;color:var(--text-muted);">${r} mm</div>
      </div>`;
    }).join('');
  }

  const tips = document.getElementById('weather-safety-tips');
  if (tips) {
    const sev = (w.severity || 'low').toLowerCase();
    const rain = Number(w.rainfall) || 0;
    const list = [];
    if (sev === 'severe' || sev === 'high') list.push('Avoid non-essential travel. Do not cross flooded roads or bridges.');
    if (rain > 40) list.push('Move valuables and documents to a higher floor. Keep an emergency kit ready.');
    list.push('Keep your phone charged and note your nearest cyclone/flood shelter.');
    list.push('Follow only official SACHET / IMD updates. Do not rely on rumours.');
    if ((Number(w.wind) || 0) > 40) list.push('Secure loose outdoor objects. Stay away from windows and old trees.');
    list.push('Elderly, children and the sick should move to safety early.');
    tips.innerHTML = list.map((t) => `• ${t}`).join('<br>');
  }
}
window.renderWeatherExtras = renderWeatherExtras;

function renderNearbyWeather() {
  const el = document.getElementById('nearby-weather-list');
  if (!el) return;
  if (!Array.isArray(MockDB.weatherData)) { el.innerHTML = ''; return; }

  const severityColor = { low: 'var(--sev-low)', moderate: 'var(--sev-moderate)', high: 'var(--sev-high)', severe: 'var(--sev-severe)' };

  el.innerHTML = MockDB.weatherData.map(w => `
    <div class="weather-card mb-8" style="cursor:pointer;" onclick="showWeatherDetail('${w.id}')">
      <div class="wc-top">
        <div>
          <div style="font-size:11px;color:var(--text-muted);">${w.icon} ${w.condition}</div>
          <div class="wc-location">${w.city}</div>
        </div>
        <div class="wc-badge ${w.severity}" style="font-size:11px;">${w.severity.toUpperCase()}</div>
      </div>
      <div class="weather-stats" style="margin-top:8px;">
        <div class="ws-item"><div class="ws-label">Rain</div><div class="ws-value" style="font-size:13px;">${w.rainfall}mm</div></div>
        <div class="ws-item"><div class="ws-label">Temp</div><div class="ws-value" style="font-size:13px;">${w.temp}°C</div></div>
      </div>
    </div>
  `).join('');
}

// ──────────────────────────────────────────────────────────────
//  EMERGENCY FORM
// ──────────────────────────────────────────────────────────────
function openEmergencyForm() {
  // Reset state
  AppState.emergencyData = { needs: [], people: 1, injured: null, trapped: null, step: 1 };
  document.querySelectorAll('.need-option').forEach(el => el.classList.remove('selected'));
  document.getElementById('people-count').textContent = '1';

  // Reset steps
  document.querySelectorAll('.emg-step').forEach(el => el.classList.remove('active'));
  document.getElementById('emg-step-1').classList.add('active');
  updateStepIndicator(1);

  showScreen('emergency');
}

function toggleNeed(el) {
  el.classList.toggle('selected');
  const need = el.dataset.need;
  if (el.classList.contains('selected')) {
    if (!AppState.emergencyData.needs.includes(need)) AppState.emergencyData.needs.push(need);
  } else {
    AppState.emergencyData.needs = AppState.emergencyData.needs.filter(n => n !== need);
  }
}

function changeCount(delta) {
  AppState.emergencyData.people = Math.max(1, Math.min(50, AppState.emergencyData.people + delta));
  document.getElementById('people-count').textContent = AppState.emergencyData.people;
}

function setInjured(val) {
  AppState.emergencyData.injured = val;
  emgNextStep(3);
}

function setTrapped(val) {
  AppState.emergencyData.trapped = val;
  // Update location display
  setText('emg-loc-name', AppState.userLocation.name);
  // FIX: userLocation.lat/lng can legitimately be null (permission
  // denied, no fallback yet) — guard the toFixed() calls instead of
  // throwing when the user reaches this screen before location is known.
  const latTxt = Number.isFinite(AppState.userLocation.lat) ? AppState.userLocation.lat.toFixed(4) : 'N/A';
  const lngTxt = Number.isFinite(AppState.userLocation.lng) ? AppState.userLocation.lng.toFixed(4) : 'N/A';
  setText('emg-loc-coords', `Lat: ${latTxt}° N, Lng: ${lngTxt}° E`);
  emgNextStep(4);
}

function emgNextStep(current) {
  if (current === 1 && AppState.emergencyData.needs.length === 0) {
    showToast('Please select at least one type of help needed.', 'error');
    return;
  }

  const next = current + 1;
  document.getElementById(`emg-step-${current}`).classList.remove('active');
  const nextEl = document.getElementById(`emg-step-${next}`);
  if (nextEl) {
    nextEl.classList.add('active');
    updateStepIndicator(next);
    AppState.emergencyData.step = next;
  }
}

function updateStepIndicator(current) {
  for (let i = 1; i <= 5; i++) {
    const dot  = document.getElementById(`sdot-${i}`);
    const line = document.getElementById(`sline-${i}`);
    if (!dot) continue;
    if (i < current) {
      dot.classList.remove('active'); dot.classList.add('done'); dot.textContent = '✓';
      if (line) line.classList.add('done');
    } else if (i === current) {
      dot.classList.add('active'); dot.classList.remove('done'); dot.textContent = i;
    } else {
      dot.classList.remove('active','done'); dot.textContent = i;
      if (line) line.classList.remove('done');
    }
  }
}

function submitEmergencyRequest() {
  const req = createRequest('APP');
  AppState.currentRequestId = req.id;

  // Save
  MockDB.requests.push(req);
  localStorage.setItem('kavach_requests', JSON.stringify(MockDB.requests));

  // Push to the RESQNET command centre (AI backend -> Firestore, with a
  // direct-to-Firestore fallback) so it shows on the main dashboard and
  // the AI can triage it.
  pushRequestToCommandCentre(req);

  // Show confirmation
  setText('confirm-req-id', `REQUEST #${req.id}`);
  const badge = document.getElementById('confirm-priority');
  badge.textContent = req.priority;
  badge.className = `priority-badge ${req.priority.toLowerCase()}`;

  // Set timeline time
  setText('tl-time-1', new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));

  showScreen('confirmation');
  runSyncAnimation();
}

function showRequestTracking() {
  showScreen('requests');
}
window.showRequestTracking = showRequestTracking;

// ── Live request tracking ─────────────────────────────────────
const REQ_STAGES_EN = ['Received', 'Assigned', 'En route', 'Resolved'];
const REQ_STAGES_HI = ['प्राप्त', 'नियुक्त', 'रास्ते में', 'हल हुआ'];

function _reqStage(status) {
  const s = (status || '').toUpperCase();
  return { UNASSIGNED: 0, DISPATCHED: 0, ASSIGNED: 1, IN_PROGRESS: 2, EN_ROUTE: 2, RESOLVED: 3 }[s] ?? 0;
}

// Icon for the kind of unit dispatched to the citizen.
function _unitIcon(type) {
  return ({
    ambulance: '🚑', medical_team: '🚑', fire_brigade: '🚒', ndrf_team: '🛟',
    boat: '🛥️', police: '🚓', water_tanker: '🚚', food_supply: '🚚',
    shelter_unit: '🏕️',
  })[type] || '🚨';
}

function renderRequestsList() {
  const host = document.getElementById('requests-list');
  if (!host) return;
  const hi = AppState.uiLang === 'hindi';
  // Newest first, but anything already RESOLVED sinks to the bottom —
  // the citizen's open requests are what they actually need to see.
  const done = (r) => _reqStage(r.status) >= REQ_STAGES_EN.length - 1;
  const reqs = (MockDB.requests || [])
    .slice()
    .reverse()
    .sort((a, b) => Number(done(a)) - Number(done(b)));
  if (!reqs.length) {
    host.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:36px 12px;font-size:13px;line-height:1.7;">
      ${hi ? 'अभी कोई अनुरोध नहीं।<br>आपातकाल दर्ज करें या हेल्पलाइन पर कॉल करें।' : 'No requests yet.<br>File an emergency or call the helpline to begin.'}</div>`;
    return;
  }
  const stages = hi ? REQ_STAGES_HI : REQ_STAGES_EN;
  host.innerHTML = reqs.map((r) => {
    const st = _reqStage(r.status);
    const pr = (r.priority || 'LOW');
    const needs = (r.needs || []).join(', ') || '—';
    const track = stages.map((s, i) =>
      `<div class="rq-step ${i <= st ? 'done' : ''}"><span class="rq-dot"></span><span class="rq-lbl">${s}</span></div>`
    ).join('');
    return `<div class="rq-card">
      <div class="rq-head"><span class="rq-id">#${escapeHtml(r.id)}</span><span class="rq-pr ${pr.toLowerCase()}">${pr}</span></div>
      <div class="rq-meta">${escapeHtml(needs)} · ${r.people || 1} ${hi ? 'लोग' : 'people'}${r.injured ? ' · ' + (hi ? 'घायल' : 'injured') : ''}${r.trapped ? ' · ' + (hi ? 'फँसे' : 'trapped') : ''}</div>
      <div class="rq-track">${track}</div>
      ${r.assigned_team ? `<div class="rq-dispatch">
        <div class="rq-dispatch-ic">${_unitIcon(r.assigned_resource_type)}</div>
        <div class="rq-dispatch-body">
          <div class="rq-dispatch-title">${escapeHtml(r.assigned_team)}</div>
          <div class="rq-dispatch-sub">${
            r.assigned_eta_minutes != null
              ? (hi ? `पहुँचने में ~${Math.round(r.assigned_eta_minutes)} मिनट` : `arriving in ~${Math.round(r.assigned_eta_minutes)} min`) +
                (r.assigned_distance_km != null ? ` · ${r.assigned_distance_km} km` : '')
              : (hi ? 'आपके लिए भेजा गया' : 'dispatched to you')
          }</div>
        </div>
        <div class="rq-dispatch-live">${hi ? 'रास्ते में' : 'EN ROUTE'}</div>
      </div>` : ''}
      <div class="rq-time">${r.timestamp ? new Date(r.timestamp).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''} · ${escapeHtml(r.source || 'APP')}</div>
    </div>`;
  }).join('');
}
window.renderRequestsList = renderRequestsList;

// Status updates pushed from the command centre (via kavach-firebase.js).
window.addEventListener('kavach:my-incident-update', (e) => {
  const d = e.detail || {};
  const id = d.incident_id || d.request_id;
  const r = (MockDB.requests || []).find((x) => x.id === id);
  if (!r) return;
  r.status = d.status || r.status;
  r.assigned_team = d.assigned_team || d.assigned_resource || r.assigned_team;
  if (d.assigned_resource_type) r.assigned_resource_type = d.assigned_resource_type;
  if (d.assigned_eta_minutes != null) r.assigned_eta_minutes = d.assigned_eta_minutes;
  if (d.assigned_distance_km != null) r.assigned_distance_km = d.assigned_distance_km;
  try { localStorage.setItem('kavach_requests', JSON.stringify(MockDB.requests)); } catch (_) {}
  if (AppState.currentScreen === 'requests') renderRequestsList();
  const hi = AppState.uiLang === 'hindi';
  const map = { ASSIGNED: hi ? 'टीम नियुक्त' : 'team assigned', IN_PROGRESS: hi ? 'रास्ते में' : 'responders en route', RESOLVED: hi ? 'हल हो गया' : 'resolved' };
  if (typeof showToast === 'function' && map[(r.status || '').toUpperCase()]) {
    showToast(`${id}: ${map[r.status.toUpperCase()]}`, r.status === 'RESOLVED' ? 'success' : 'info');
  }
});

// A dispatched relocation -> bump the citizen's most recent open request to "En route".
window.addEventListener('kavach:relocation', () => {
  const open = (MockDB.requests || []).slice().reverse().find((r) => _reqStage(r.status) < 2);
  if (!open) return;
  open.status = 'IN_PROGRESS';
  try { localStorage.setItem('kavach_requests', JSON.stringify(MockDB.requests)); } catch (_) {}
  if (AppState.currentScreen === 'requests') renderRequestsList();
});

function runSyncAnimation() {
  const steps = ['sync-1','sync-2','sync-3','sync-4','sync-5'];
  steps.forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('visible'); el.classList.remove('done'); }
  });

  steps.forEach((id, idx) => {
    setTimeout(() => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('visible');
        if (id === 'sync-5') el.classList.add('done');
      }
    }, idx * 500);
  });
}

// ──────────────────────────────────────────────────────────────
//  SHARED RESPONSE ENGINE
// ──────────────────────────────────────────────────────────────
class ResponseEngine {
  constructor(channel = 'SMS', lang = 'english') {
    this.channel = channel;
    this.lang = lang;
    this.reset();
  }

  reset() {
    this.state = 'LANG_SELECT';
    this.data = {
      channel: this.channel,
      lang: this.lang,
      needs: [],
      people: null,
      injured: null,
      trapped: null,
      shelterNeeded: null,
      foodPeople: null,
      foodSufficient: null,
      injuredCount: null,
      evacuationTrapped: null,
    };
    this.pendingNeeds = [];
    this.currentNeedIndex = 0;
  }

  setLang(lang) {
    this.lang = lang;
    this.data.lang = lang;
  }

  T(key) {
    return TRANSLATIONS[this.lang]?.[key] || TRANSLATIONS.english[key] || key;
  }

  getInitialMessage() {
    this.state = 'SAFETY_CHECK';
    return this.T('safety_check');
  }

  process(input) {
    input = input.trim();
    const responses = [];

    switch (this.state) {
      case 'SAFETY_CHECK':
        return this.handleSafetyCheck(input);

      case 'NEED_SELECT':
        return this.handleNeedSelect(input);

      case 'FOOD_PEOPLE':
        return this.handleFoodPeople(input);

      case 'FOOD_SUFFICIENT':
        return this.handleFoodSufficient(input);

      case 'MEDICAL_INJURED':
        return this.handleMedicalInjured(input);

      case 'MEDICAL_INJURED_COUNT':
        return this.handleMedicalInjuredCount(input);

      case 'EVAC_TRAPPED':
        return this.handleEvacTrapped(input);

      case 'EVAC_TRAPPED_COUNT':
        return this.handleEvacTrapCount(input);

      case 'SHELTER_NEED':
        return this.handleShelterNeed(input);

      case 'TRAPPED_PEOPLE':
        return this.handleTrappedPeople(input);

      case 'TRAPPED_INJURED':
        return this.handleTrappedInjured(input);

      case 'TRAPPED_EXIT':
        return this.handleTrappedExit(input);

      case 'DONE':
        return [this.T('already_done')];

      default:
        return [this.T('invalid')];
    }
  }

  handleSafetyCheck(input) {
    if (input === '1') {
      this.state = 'DONE';
      this.data.needs = ['none'];
      return [this.T('safe_response')];
    } else if (input === '2') {
      this.state = 'NEED_SELECT';
      return [this.T('need_select')];
    } else if (input === '3') {
      this.state = 'TRAPPED_PEOPLE';
      this.data.needs.push('rescue');
      return [this.T('trapped_people')];
    }
    return [this.T('invalid') + '\n\n' + this.T('safety_check')];
  }

  handleNeedSelect(input) {
    const parts = input.split(',').map(s => s.trim());
    const valid = ['1','2','3','4'];
    const needMap = { '1':'food','2':'medical','3':'evacuation','4':'shelter' };
    const selected = parts.filter(p => valid.includes(p));

    if (selected.length === 0) {
      return [this.T('invalid') + '\n\n' + this.T('need_select')];
    }

    this.data.needs = selected.map(s => needMap[s]);
    this.pendingNeeds = [...this.data.needs];
    this.currentNeedIndex = 0;
    return this.processNextNeed();
  }

  processNextNeed() {
    while (this.currentNeedIndex < this.pendingNeeds.length) {
      const need = this.pendingNeeds[this.currentNeedIndex++];
      if (need === 'food') {
        this.state = 'FOOD_PEOPLE';
        return [this.T('food_people')];
      } else if (need === 'medical') {
        this.state = 'MEDICAL_INJURED';
        return [this.T('medical_injured')];
      } else if (need === 'evacuation') {
        this.state = 'EVAC_TRAPPED';
        return [this.T('evac_trapped')];
      } else if (need === 'shelter') {
        this.state = 'SHELTER_NEED';
        return [this.T('shelter_need')];
      }
    }
    return this.finalizeRequest();
  }

  handleFoodPeople(input) {
    const n = parseInt(input);
    if (isNaN(n) || n < 1) return [this.T('invalid_num')];
    this.data.foodPeople = n;
    if (!this.data.people) this.data.people = n;
    this.state = 'FOOD_SUFFICIENT';
    return [this.T('food_sufficient')];
  }

  handleFoodSufficient(input) {
    this.data.foodSufficient = input === '1';
    return this.processNextNeed();
  }

  handleMedicalInjured(input) {
    if (input === '1') {
      this.data.injured = true;
      this.state = 'MEDICAL_INJURED_COUNT';
      return [this.T('injured_count')];
    } else if (input === '2') {
      this.data.injured = false;
      return this.processNextNeed();
    }
    return [this.T('invalid')];
  }

  handleMedicalInjuredCount(input) {
    const n = parseInt(input);
    if (isNaN(n) || n < 1) return [this.T('invalid_num')];
    this.data.injuredCount = n;
    if (!this.data.people) this.data.people = n;
    return this.processNextNeed();
  }

  handleEvacTrapped(input) {
    if (input === '1') {
      this.data.trapped = true;
      this.state = 'EVAC_TRAPPED_COUNT';
      return [this.T('trapped_count')];
    } else if (input === '2') {
      this.data.trapped = false;
      return this.processNextNeed();
    }
    return [this.T('invalid')];
  }

  handleEvacTrapCount(input) {
    const n = parseInt(input);
    if (isNaN(n) || n < 1) return [this.T('invalid_num')];
    this.data.people = n;
    return this.processNextNeed();
  }

  handleShelterNeed(input) {
    this.data.shelterNeeded = input === '1';
    return this.processNextNeed();
  }

  handleTrappedPeople(input) {
    const n = parseInt(input);
    if (isNaN(n) || n < 1) return [this.T('invalid_num')];
    this.data.people = n;
    this.state = 'TRAPPED_INJURED';
    return [this.T('trapped_injured')];
  }

  handleTrappedInjured(input) {
    this.data.injured = input === '1';
    this.data.trapped = true;
    this.state = 'TRAPPED_EXIT';
    return [this.T('trapped_exit')];
  }

  handleTrappedExit(input) {
    this.data.canExit = input === '1';
    return this.finalizeRequest();
  }

  finalizeRequest() {
    const req = createRequest(this.channel, this.data);
    MockDB.requests.push(req);
    localStorage.setItem('kavach_requests', JSON.stringify(MockDB.requests));
    this.state = 'DONE';

    const msg = this.T('request_created')
      .replace('{ID}', req.id)
      .replace('{PRIORITY}', req.priority);
    return [msg];
  }
}

// ──────────────────────────────────────────────────────────────
//  TRANSLATIONS
// ──────────────────────────────────────────────────────────────
const TRANSLATIONS = {
  english: {
    safety_check:     "KAVACH DISASTER ALERT\n\nAre you safe?\n\n1 - Safe\n2 - Need Assistance\n3 - Trapped\n\nReply with 1, 2 or 3.",
    safe_response:    "KAVACH:\n\nThank you for confirming. Please stay safe and monitor official alerts.\n\nReply HELP if your situation changes.",
    need_select:      "KAVACH:\n\nWhat assistance do you need?\n\n1 - Food / Water\n2 - Medical\n3 - Evacuation\n4 - Shelter\n\nYou may select multiple options.\nExample: 1,3",
    food_people:      "KAVACH:\n\nHow many people need food/water?\n\nReply with a number.",
    food_sufficient:  "KAVACH:\n\nIs your current supply sufficient?\n\n1 - Yes\n2 - No",
    medical_injured:  "KAVACH:\n\nIs anyone injured?\n\n1 - Yes\n2 - No",
    injured_count:    "KAVACH:\n\nHow many people are injured?\n\nReply with a number.",
    evac_trapped:     "KAVACH:\n\nAre you currently trapped?\n\n1 - Yes\n2 - No",
    trapped_count:    "KAVACH:\n\nHow many people are trapped?\n\nReply with a number.",
    shelter_need:     "KAVACH:\n\nDo you need emergency shelter?\n\n1 - Yes\n2 - No",
    trapped_people:   "KAVACH:\n\nHow many people are trapped?\n\nReply with a number.",
    trapped_injured:  "KAVACH:\n\nIs anyone injured?\n\n1 - Yes\n2 - No",
    trapped_exit:     "KAVACH:\n\nCan you safely leave your location?\n\n1 - Yes\n2 - No",
    request_created:  "KAVACH:\n\nEmergency request created.\n\nRequest ID: {ID}\nStatus: {PRIORITY}\n\nYour location has been shared with emergency response services.\n\nHelp is on the way.",
    already_done:     "KAVACH:\n\nYour request has been registered. Reply HELP to create a new request.",
    invalid:          "KAVACH:\n\nSorry, I didn't understand that. Please reply with one of the valid options.",
    invalid_num:      "KAVACH:\n\nPlease reply with a valid number.",
  },
  hindi: {
    safety_check:     "KAVACH आपदा अलर्ट\n\nक्या आप सुरक्षित हैं?\n\n1 - सुरक्षित\n2 - सहायता चाहिए\n3 - फंसे हुए हैं\n\n1, 2 या 3 में से जवाब दें।",
    safe_response:    "KAVACH:\n\nपुष्टि के लिए धन्यवाद। कृपया सुरक्षित रहें और आधिकारिक अलर्ट देखते रहें।\n\nस्थिति बदलने पर HELP लिखें।",
    need_select:      "KAVACH:\n\nआपको किस सहायता की जरूरत है?\n\n1 - भोजन / पानी\n2 - चिकित्सा\n3 - निकासी\n4 - आश्रय\n\nआप कई विकल्प चुन सकते हैं।\nउदाहरण: 1,3",
    food_people:      "KAVACH:\n\nकितने लोगों को भोजन/पानी चाहिए?\n\nसंख्या में जवाब दें।",
    food_sufficient:  "KAVACH:\n\nक्या आपके पास पर्याप्त आपूर्ति है?\n\n1 - हाँ\n2 - नहीं",
    medical_injured:  "KAVACH:\n\nक्या कोई घायल है?\n\n1 - हाँ\n2 - नहीं",
    injured_count:    "KAVACH:\n\nकितने लोग घायल हैं?\n\nसंख्या में जवाब दें।",
    evac_trapped:     "KAVACH:\n\nक्या आप फंसे हुए हैं?\n\n1 - हाँ\n2 - नहीं",
    trapped_count:    "KAVACH:\n\nकितने लोग फंसे हैं?\n\nसंख्या में जवाब दें।",
    shelter_need:     "KAVACH:\n\nक्या आपको आपातकालीन आश्रय चाहिए?\n\n1 - हाँ\n2 - नहीं",
    trapped_people:   "KAVACH:\n\nकितने लोग फंसे हुए हैं?\n\nसंख्या में जवाब दें।",
    trapped_injured:  "KAVACH:\n\nक्या कोई घायल है?\n\n1 - हाँ\n2 - नहीं",
    trapped_exit:     "KAVACH:\n\nक्या आप सुरक्षित रूप से अपनी जगह छोड़ सकते हैं?\n\n1 - हाँ\n2 - नहीं",
    request_created:  "KAVACH:\n\nआपातकालीन अनुरोध दर्ज किया गया।\n\nअनुरोध ID: {ID}\nस्थिति: {PRIORITY}\n\nआपका स्थान आपातकालीन सेवाओं के साथ साझा किया गया है।",
    already_done:     "KAVACH:\n\nआपका अनुरोध दर्ज है। नया अनुरोध बनाने के लिए HELP लिखें।",
    invalid:          "KAVACH:\n\nखेद है, मैं यह नहीं समझ सका। कृपया मान्य विकल्प से जवाब दें।",
    invalid_num:      "KAVACH:\n\nकृपया एक वैध संख्या दर्ज करें।",
  },
  hinglish: {
    safety_check:     "KAVACH Disaster Alert\n\nKya aap safe hain?\n\n1 - Haan, Safe\n2 - Help chahiye\n3 - Phanse hue hain\n\nReply 1, 2 ya 3.",
    safe_response:    "KAVACH:\n\nConfirm karne ke liye shukriya. Safe rahein aur official alerts dekhte rahein.\n\nHELP reply karein agar situation change ho.",
    need_select:      "KAVACH:\n\nKis tarah ki madad chahiye?\n\n1 - Khana / Paani\n2 - Medical\n3 - Evacuation\n4 - Shelter\n\nEk se zyada select kar sakte hain.\nExample: 1,3",
    food_people:      "KAVACH:\n\nKitne logon ko khana/paani chahiye?\n\nNumber mein jawab dein.",
    food_sufficient:  "KAVACH:\n\nKya abhi thoda supply hai?\n\n1 - Haan\n2 - Nahi",
    medical_injured:  "KAVACH:\n\nKya koi injured hai?\n\n1 - Haan\n2 - Nahi",
    injured_count:    "KAVACH:\n\nKitne log injured hain?\n\nNumber mein jawab dein.",
    evac_trapped:     "KAVACH:\n\nKya aap phanse hue hain?\n\n1 - Haan\n2 - Nahi",
    trapped_count:    "KAVACH:\n\nKitne log phanse hain?\n\nNumber mein jawab dein.",
    shelter_need:     "KAVACH:\n\nKya aapko emergency shelter chahiye?\n\n1 - Haan\n2 - Nahi",
    trapped_people:   "KAVACH:\n\nKitne log phanse hue hain?\n\nNumber mein jawab dein.",
    trapped_injured:  "KAVACH:\n\nKya koi injured hai?\n\n1 - Haan\n2 - Nahi",
    trapped_exit:     "KAVACH:\n\nKya aap safely apni jagah chhod sakte hain?\n\n1 - Haan\n2 - Nahi",
    request_created:  "KAVACH:\n\nEmergency request create ho gayi.\n\nRequest ID: {ID}\nStatus: {PRIORITY}\n\nAapki location emergency services ke saath share ho gayi hai.\n\nMadad aa rahi hai.",
    already_done:     "KAVACH:\n\nAapka request register ho gaya. Naya request ke liye HELP reply karein.",
    invalid:          "KAVACH:\n\nSorry, yeh samajh nahi aaya. Valid option se reply karein.",
    invalid_num:      "KAVACH:\n\nKripya ek valid number reply karein.",
  },
};

// ──────────────────────────────────────────────────────────────
//  SMS CONVERSATION
// ──────────────────────────────────────────────────────────────
let smsInitialized = false;

function openSMSConversation() {
  showScreen('sms-chat');
}

function initSMSConversation() {
  if (smsInitialized) return;
  smsInitialized = true;

  AppState.smsState.engine = new ResponseEngine('SMS', AppState.smsState.lang);
  const firstMsg = AppState.smsState.engine.getInitialMessage();
  appendSMSMessage(firstMsg, 'incoming');

  // Enter key
  const input = document.getElementById('chat-input');
  if (input) {
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendSMSMessage();
    });
  }
}

function resetSMSChat() {
  smsInitialized = false;
  const container = document.getElementById('chat-messages');
  // Keep typing indicator
  container.innerHTML = `<div class="typing-indicator" id="typing-indicator">
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
  </div>`;
  AppState.smsState.engine = new ResponseEngine('SMS', AppState.smsState.lang);
  AppState.smsState.aiMode = false;
  document.getElementById('ai-mode-toggle').classList.remove('active');

  setTimeout(() => {
    smsInitialized = true;
    const firstMsg = AppState.smsState.engine.getInitialMessage();
    appendSMSMessage(firstMsg, 'incoming');
  }, 600);
}

function setSMSLang(lang, el) {
  AppState.smsState.lang = lang;
  document.querySelectorAll('#screen-sms-chat .lang-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');

  // Reset with new language
  smsInitialized = false;
  const container = document.getElementById('chat-messages');
  container.innerHTML = `<div class="typing-indicator" id="typing-indicator">
    <div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>
  </div>`;
  AppState.smsState.engine = new ResponseEngine('SMS', lang);
  setTimeout(() => {
    smsInitialized = true;
    appendSMSMessage(AppState.smsState.engine.getInitialMessage(), 'incoming');
  }, 400);
}

function toggleAIMode() {
  AppState.smsState.aiMode = !AppState.smsState.aiMode;
  const btn = document.getElementById('ai-mode-toggle');
  btn.classList.toggle('active', AppState.smsState.aiMode);
  const input = document.getElementById('chat-input');
  if (AppState.smsState.aiMode) {
    input.placeholder = 'Type free text (e.g. "Ghar mein paani aa gaya...")';
    appendSMSMessage('🤖 AI TRIAGE SIMULATION MODE\n\nType a natural language message describing your situation.\n\nExample:\n"Ghar mein paani aa gaya hai, hum 6 log hain aur papa injured hain."', 'incoming');
  } else {
    input.placeholder = 'Type a message...';
  }
}

function sendSMSMessage() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  appendSMSMessage(text, 'outgoing');

  showTyping(true);

  setTimeout(() => {
    showTyping(false);
    if (AppState.smsState.aiMode) {
      handleAIMessage(text);
    } else {
      const responses = AppState.smsState.engine.process(text);
      responses.forEach(r => appendSMSMessage(r, 'incoming'));
    }
  }, 1200 + Math.random() * 600);
}

function handleAIMessage(text) {
  // Mock rule-based AI extraction
  const lower = text.toLowerCase();
  const extracted = {
    people:      extractNumber(text),
    medical:     /injur|hurt|ghayil|bimar|medical|doctor/.test(lower),
    injured:     /injur|hurt|ghayil|papa|maa|dad|mom/.test(lower),
    waterlogging:/paani|water|flood|baadh|baarish|flood|logged/.test(lower),
    rescue:      /phan|trapped|phanse|stuck|nikal/.test(lower),
    food:        /khana|food|hungry|bhukha|pyaas|thirsty/.test(lower),
    shelter:     /ghar|home|shelter|rahne|safe place/.test(lower),
  };

  const score = (extracted.injured ? 30 : 0) + (extracted.rescue ? 40 : 0) + (extracted.waterlogging ? 10 : 0) + (extracted.food ? 5 : 0);
  const priority = score >= 50 ? 'CRITICAL' : score >= 30 ? 'HIGH' : 'MODERATE';
  extracted.priority = priority;
  extracted.people = extracted.people || 1;

  const card = `
    <div class="ai-triage-card">
      <div class="ai-triage-title">🤖 AI Extracted Information</div>
      <div class="ai-row"><span class="ai-key">People</span><span class="ai-val">${extracted.people}</span></div>
      <div class="ai-row"><span class="ai-key">Medical</span><span class="ai-val ${extracted.medical?'yes':'no'}">${extracted.medical?'YES':'NO'}</span></div>
      <div class="ai-row"><span class="ai-key">Injured</span><span class="ai-val ${extracted.injured?'yes':'no'}">${extracted.injured?'YES':'NO'}</span></div>
      <div class="ai-row"><span class="ai-key">Waterlogging</span><span class="ai-val ${extracted.waterlogging?'yes':'no'}">${extracted.waterlogging?'YES':'NO'}</span></div>
      <div class="ai-row"><span class="ai-key">Rescue Needed</span><span class="ai-val ${extracted.rescue?'yes':'no'}">${extracted.rescue?'YES':'NO'}</span></div>
      <div class="ai-row"><span class="ai-key">Food/Shelter</span><span class="ai-val ${extracted.food||extracted.shelter?'yes':'no'}">${extracted.food||extracted.shelter?'YES':'NO'}</span></div>
      <div class="ai-row"><span class="ai-key">Priority</span><span class="ai-val ${priority.toLowerCase()}">${priority}</span></div>
    </div>
  `;

  const container = document.getElementById('chat-messages');
  if (container) {
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('msg-bubble', 'incoming');
    msgDiv.innerHTML = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">AI Triage Simulation</div>${card}<div class="msg-time">${getTime()}</div>`;
    const typingEl = document.getElementById('typing-indicator');
    container.insertBefore(msgDiv, typingEl);
    container.scrollTop = container.scrollHeight;
  }

  // Generate request
  const req = createRequest('SMS_AI', { needs: Object.keys(extracted).filter(k=>extracted[k]===true), people: extracted.people, injured: extracted.injured, trapped: extracted.rescue, priority });
  MockDB.requests.push(req);
  localStorage.setItem('kavach_requests', JSON.stringify(MockDB.requests));
  pushRequestToCommandCentre(req);

  setTimeout(() => {
    if (document.getElementById('chat-messages')) {
      appendSMSMessage(`Emergency request auto-created.\n\nRequest ID: ${req.id}\nPriority: ${priority}\n\nHelp is on the way.`, 'incoming');
    }
  }, 800);
}

function extractNumber(text) {
  const m = text.match(/\b(\d+)\b/);
  return m ? parseInt(m[1]) : null;
}

function appendSMSMessage(text, direction) {
  const container = document.getElementById('chat-messages');
  const typingEl  = document.getElementById('typing-indicator');
  if (!container) return;

  const div = document.createElement('div');
  div.classList.add('msg-bubble', direction);
  div.innerHTML = `${escapeHtml(text).replace(/\n/g, '<br>')}<div class="msg-time">${getTime()} ${direction === 'outgoing' ? '✓✓' : ''}</div>`;
  container.insertBefore(div, typingEl);
  container.scrollTop = container.scrollHeight;
}

function showTyping(show) {
  const el = document.getElementById('typing-indicator');
  if (el) el.classList.toggle('show', show);
}

// ──────────────────────────────────────────────────────────────
//  IVR SIMULATOR
// ──────────────────────────────────────────────────────────────
function startIVRCall() {
  AppState.ivrState.active = true;
  AppState.ivrState.seconds = 0;
  AppState.ivrState.engine = new ResponseEngine('IVR', AppState.ivrState.lang);

  const callScreen = document.getElementById('ivr-call-screen');
  callScreen.classList.add('active');

  // Timer
  if (AppState.ivrState.timer) clearInterval(AppState.ivrState.timer);
  AppState.ivrState.timer = setInterval(() => {
    AppState.ivrState.seconds++;
    const m = Math.floor(AppState.ivrState.seconds / 60).toString().padStart(2, '0');
    const s = (AppState.ivrState.seconds % 60).toString().padStart(2, '0');
    const el = document.getElementById('ivr-timer');
    if (el) el.textContent = `${m}:${s}`;
  }, 1000);

  // First IVR prompt — lang select
  setIVRState('LANG_SELECT');
  setIVRPrompt(`Welcome to Kavach Emergency Services.\n\nPress 1 for English.\nPress 2 for Hindi.\nPress 3 for Hinglish.`);
}

function endIVRCall() {
  AppState.ivrState.active = false;
  clearInterval(AppState.ivrState.timer);
  document.getElementById('ivr-call-screen').classList.remove('active');
  setIVRState('IDLE');
  setIVRPrompt('Press START CALL above to begin the IVR simulation.\n\nUse the keypad below to navigate the menu system.\n\nThis demonstrates the same response collection logic as SMS, through voice/DTMF interaction.');
  document.getElementById('ivr-timer').textContent = '00:00';
}

function ivrKeyPress(key) {
  if (!AppState.ivrState.active) {
    showToast('Please start the call first.', 'warning');
    return;
  }

  // Flash key
  animateKeyPress(key);

  const state = AppState.ivrState;

  // Language select phase (before engine)
  if (state.engine.state === 'LANG_SELECT' || document.getElementById('ivr-state-label').textContent.includes('LANG_SELECT')) {
    if (key === '1') {
      setIVRLang('english', null);
      state.engine.state = 'SAFETY_CHECK';
      setIVRState('SAFETY_CHECK');
      setIVRPrompt(state.engine.T('safety_check'));
    } else if (key === '2') {
      setIVRLang('hindi', null);
      state.engine.state = 'SAFETY_CHECK';
      setIVRState('SAFETY_CHECK');
      setIVRPrompt(state.engine.T('safety_check'));
    } else if (key === '3') {
      setIVRLang('hinglish', null);
      state.engine.state = 'SAFETY_CHECK';
      setIVRState('SAFETY_CHECK');
      setIVRPrompt(state.engine.T('safety_check'));
    } else {
      setIVRPrompt('Invalid input. Press 1 for English, 2 for Hindi, 3 for Hinglish.');
    }
    return;
  }

  // Pass to engine
  const responses = state.engine.process(key);
  if (responses && responses.length > 0) {
    setIVRPrompt(responses.join('\n\n'));
    setIVRState(state.engine.state);
  }
}

function setIVRLang(lang, el) {
  AppState.ivrState.lang = lang;
  if (AppState.ivrState.engine) {
    AppState.ivrState.engine.setLang(lang);
  }
  if (el) {
    document.querySelectorAll('#screen-ivr .lang-tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
  } else {
    // Update UI tab
    const tabs = document.querySelectorAll('#screen-ivr .lang-tab');
    tabs.forEach(t => {
      t.classList.remove('active');
      if ((lang === 'english' && t.textContent === 'EN') ||
          (lang === 'hindi'   && t.textContent === 'हि') ||
          (lang === 'hinglish' && t.textContent === 'HG')) {
        t.classList.add('active');
      }
    });
  }
}

function setIVRPrompt(text) {
  const el = document.getElementById('ivr-prompt');
  if (el) el.textContent = text;
}

function setIVRState(state) {
  const el = document.getElementById('ivr-state-label');
  if (el) el.textContent = `State: ${state}`;
}

function animateKeyPress(key) {
  const keyBtns = document.querySelectorAll('.key-btn');
  keyBtns.forEach(btn => {
    if (btn.querySelector('.key-num')?.textContent === key) {
      btn.style.background = 'rgba(21,101,192,0.2)';
      btn.style.borderColor = 'var(--primary)';
      setTimeout(() => {
        btn.style.background = '';
        btn.style.borderColor = '';
      }, 300);
    }
  });
}

// ──────────────────────────────────────────────────────────────
//  REQUEST CREATION
// ──────────────────────────────────────────────────────────────
function createRequest(source, data) {
  const reqData = data || AppState.emergencyData;
  const priority = calculatePriority(reqData);
  const id = generateRequestId();

  return {
    id,
    source,
    citizen: AppState.currentUser?.name || 'Demo User',
    userId:  AppState.currentUser?.id || 'U001',
    lang:    AppState.smsState.lang,
    location: {
      lat:  AppState.userLocation.lat,
      lng:  AppState.userLocation.lng,
      name: AppState.userLocation.name,
    },
    needs:    reqData.needs || [],
    people:   reqData.people || 1,
    injured:  reqData.injured || false,
    trapped:  reqData.trapped || false,
    priority,
    status:   'DISPATCHED',
    timestamp: new Date().toISOString(),
  };
}

function calculatePriority(data) {
  let score = 0;
  if (data.trapped)  score += 40;
  if (data.injured)  score += 30;
  if (data.people > 5) score += 15;
  if (data.people > 10) score += 10;
  if (data.needs?.includes('medical'))   score += 20;
  if (data.needs?.includes('rescue'))    score += 25;
  if (data.needs?.includes('food'))      score += 5;
  if (data.needs?.includes('shelter'))   score += 5;
  if (data.needs?.includes('water'))     score += 5;

  if (score >= 60) return 'CRITICAL';
  if (score >= 35) return 'HIGH';
  if (score >= 15) return 'MODERATE';
  return 'LOW';
}

function generateRequestId() {
  return 'KV-' + (1000 + MockDB.requests.length + Math.floor(Math.random() * 99));
}

// ──────────────────────────────────────────────────────────────
//  COMMAND-CENTRE BRIDGE (Kavach app -> RESQNET main dashboard)
// ──────────────────────────────────────────────────────────────
function buildIncidentText(req) {
  // A description already produced by an analyzer (the AI helpline)
  // wins — it was built from the caller's own words.
  if (req.description) return req.description;

  const parts = [];
  if (req.needs && req.needs.length) parts.push('Needs: ' + req.needs.join(', '));
  parts.push(`${req.people || 1} people affected`);

  // Counts matter for triage — "8 people trapped" must not collapse to
  // the same text as "1 person trapped".
  if (req.trapped) {
    parts.push(req.trappedCount > 1 ? `${req.trappedCount} people trapped` : 'people trapped');
  }
  if (req.injured) {
    parts.push(req.injuredCount > 1 ? `${req.injuredCount} people injured` : 'injuries reported');
  }
  if (req.additional) parts.push(String(req.additional).slice(0, 200));

  const loc = req.location && req.location.name ? ` near ${req.location.name}` : '';
  const kind = req.type === 'CITIZEN_SAFETY_REPORT'
    ? 'Citizen safety report via Kavach app'
    : 'Citizen emergency via Kavach app';
  return `${kind}${loc}. ` + parts.join('. ') + '.';
}

function rememberMyIncident(id) {
  try {
    const key = 'kavach_my_incidents';
    const set = new Set(JSON.parse(localStorage.getItem(key) || '[]'));
    set.add(id);
    localStorage.setItem(key, JSON.stringify(Array.from(set)));
  } catch (_) { /* ignore */ }
}

async function pushRequestToCommandCentre(req) {
  const base = (window.RESQNET_AI_API_BASE || '').replace(/\/+$/, '');
  const text = buildIncidentText(req);
  // The citizen's registered district travels with EVERY report. The
  // allocator hard-partitions on it, so without this a Kanpur unit
  // could be matched to a Bhubaneswar incident.
  const area = (typeof kavachUserArea === 'function') ? kavachUserArea() : {};

  const body = {
    request_id: req.id,
    text,
    latitude: req.location ? req.location.lat : null,
    longitude: req.location ? req.location.lng : null,
    timestamp: req.timestamp,
    source: 'kavach_app',
    state: area.state || null,
    district: area.district || null,
  };

  // 1. Preferred: AI backend analyses the message + writes to Firestore.
  if (base) {
    try {
      const res = await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        const inc = await res.json();
        const id = inc.incident_id || req.id;
        rememberMyIncident(id);
        showToast(`Sent to Command Centre — ${id}`, 'success');
        // Start streaming live GPS to the responder for this incident.
        try { startCallerLocationShare(id, req); } catch (_) {}
        return id;
      }
    } catch (e) {
      console.warn('[kavach] AI /incidents failed, falling back to Firestore', e.message);
    }
  }

  // 2. Fallback: write a minimal incident straight to Firestore so the
  //    main dashboard still receives it live.
  try {
    const fs = window.resqnetFirestore;
    const fdb = window.resqnetDb;
    if (fs && fdb) {
      const level = { CRITICAL: 'CRITICAL', HIGH: 'HIGH', MODERATE: 'MEDIUM', LOW: 'LOW' }[req.priority] || 'HIGH';
      await fs.addDoc(fs.collection(fdb, 'incidents'), {
        incident_id: req.id,
        request_id: req.id,
        created_at: req.timestamp,
        latitude: body.latitude,
        longitude: body.longitude,
        state: body.state,
        district: body.district,
        text,
        status: 'UNASSIGNED',
        priority: { level, score: 0, reasons: ['Submitted from Kavach app'] },
        facts: {
          needs: req.needs || [],
          people_count: req.people || 1,
          trapped: !!req.trapped,
          injured: !!req.injured,
        },
        source: 'kavach_app',
      });
      rememberMyIncident(req.id);
      showToast(`Sent to Command Centre — ${req.id}`, 'success');
      try { startCallerLocationShare(req.id, req); } catch (_) {}
      return req.id;
    }
  } catch (e) {
    console.warn('[kavach] Firestore incident write failed', e);
  }

  showToast('Could not reach Command Centre — saved on this device.', 'warning');
  return null;
}

window.pushRequestToCommandCentre = pushRequestToCommandCentre;

// ──────────────────────────────────────────────────────────────
//  LIVE CALLER GPS  ("call police -> your location goes to them")
//  ------------------------------------------------------------
//  Real 112/ERSS gets the caller's location from the telecom carrier
//  (AML / NG-112) — a web app can't tap that. This is the working
//  functional equivalent: once the citizen contacts the helpline /
//  files an SOS we stream their device GPS to Firestore
//  `caller_locations/{incidentId}`, and the control-room dashboard
//  subscribes and shows a live, moving pin with an accuracy circle.
//  Sharing is per-incident and stops when the call ends.
// ──────────────────────────────────────────────────────────────
let _callerGeoWatch = null;
let _callerGeoIncident = null;
let _callerGeoLastWrite = 0;
let _callerManualWrite = null;

function startCallerLocationShare(incidentId, req) {
  if (!incidentId || !navigator.geolocation) return;
  const fs = window.resqnetFirestore;
  const fdb = window.resqnetDb;
  if (!fs || !fdb) return;

  stopCallerLocationShare();
  _callerGeoIncident = incidentId;

  const user = AppState.currentUser || {};
  const writePos = (pos, force) => {
    const now = Date.now();
    if (!force && now - _callerGeoLastWrite < 8000) return; // throttle ~8s
    _callerGeoLastWrite = now;
    const c = pos.coords;
    fs.setDoc(
      fs.doc(fdb, 'caller_locations', incidentId),
      {
        incident_id: incidentId,
        name: user.name || (req && req.citizen) || 'Citizen',
        mobile: user.mobile || null,
        district: user.district || (localStorage.getItem('kavach_district') || null),
        latitude: c.latitude,
        longitude: c.longitude,
        accuracy_m: Math.round(c.accuracy || 0),
        heading: c.heading == null ? null : Math.round(c.heading),
        speed_mps: c.speed == null ? null : Math.round(c.speed * 10) / 10,
        active: true,
        updated_at: new Date().toISOString(),
      },
      { merge: true }
    ).catch((e) => console.warn('[kavach] caller_location write failed', e && e.message));
  };

  // Fallback: write the citizen's chosen/last-known point so the
  // responder always has SOMETHING to navigate to, even without GPS.
  const writeManual = () => {
    const loc = AppState.userLocation || {};
    const la = Number(loc.lat), lo = Number(loc.lng);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
    _callerGeoLastWrite = Date.now();
    fs.setDoc(
      fs.doc(fdb, 'caller_locations', incidentId),
      {
        incident_id: incidentId,
        name: user.name || (req && req.citizen) || 'Citizen',
        mobile: user.mobile || null,
        district: user.district || (localStorage.getItem('kavach_district') || null),
        latitude: la, longitude: lo,
        accuracy_m: null, heading: null, speed_mps: null,
        source: 'chosen_location',
        active: true,
        updated_at: new Date().toISOString(),
      },
      { merge: true }
    ).catch((e) => console.warn('[kavach] caller_location manual write failed', e && e.message));
  };
  _callerManualWrite = writeManual;
  writeManual();   // immediately, so the pin appears without waiting for GPS

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (p) => writePos(p, true),
      (e) => { console.warn('[kavach] geolocation error', e && e.message); writeManual(); },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 }
    );
    _callerGeoWatch = navigator.geolocation.watchPosition(
      (p) => writePos(p, false),
      (e) => console.warn('[kavach] geolocation watch error', e && e.message),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 4000 }
    );
  }

  if (typeof showToast === 'function') {
    showToast('📍 Sharing your location with responders', 'success');
  }
}
window.startCallerLocationShare = startCallerLocationShare;

function stopCallerLocationShare() {
  if (_callerGeoWatch != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(_callerGeoWatch);
  }
  const fs = window.resqnetFirestore;
  const fdb = window.resqnetDb;
  if (_callerGeoIncident && fs && fdb) {
    fs.setDoc(
      fs.doc(fdb, 'caller_locations', _callerGeoIncident),
      { active: false, ended_at: new Date().toISOString() },
      { merge: true }
    ).catch(() => {});
  }
  _callerGeoWatch = null;
  _callerGeoIncident = null;
}
window.stopCallerLocationShare = stopCallerLocationShare;

// ──────────────────────────────────────────────────────────────
//  SIMPLE LOGIN (name + mobile + state/district + location)
// ──────────────────────────────────────────────────────────────
function initSimpleLoginScreen() {
  const stateSel = document.getElementById('slog-state');
  const distSel = document.getElementById('slog-district');
  if (!stateSel || !distSel || !window.INDIA_DISTRICTS) return;

  if (stateSel.options.length <= 1) {
    for (const s of Object.keys(window.INDIA_DISTRICTS).sort()) {
      stateSel.add(new Option(s, s));
    }
  }
  stateSel.onchange = () => {
    distSel.innerHTML = '<option value="">Select district…</option>';
    const list = window.INDIA_DISTRICTS[stateSel.value] || [];
    for (const d of list) distSel.add(new Option(d, d));
    distSel.disabled = !list.length;
  };

  // Prefill if returning
  try {
    const u = JSON.parse(localStorage.getItem('kavach_user') || 'null');
    if (u) {
      const n = document.getElementById('slog-name'); if (n) n.value = u.name || '';
      const m = document.getElementById('slog-mobile'); if (m) m.value = u.mobile || '';
    }
  } catch (_) {}
}

function simpleLogin() {
  const name = (document.getElementById('slog-name') || {}).value?.trim();
  const mobile = (document.getElementById('slog-mobile') || {}).value?.trim();
  const state = (document.getElementById('slog-state') || {}).value;
  const district = (document.getElementById('slog-district') || {}).value;
  const location = (document.getElementById('slog-location') || {}).value?.trim();
  const lang = (document.getElementById('slog-lang') || {}).value || 'english';
  const err = document.getElementById('slog-err');

  if (!name || !/^\d{10}$/.test(mobile || '')) {
    if (err) { err.textContent = 'Enter your name and a valid 10-digit mobile number.'; err.style.display = 'block'; }
    return;
  }

  AppState.currentUser = {
    id: 'U-' + mobile.slice(-4),
    name, mobile, state, district,
    lang,
  };
  if (state && district) {
    AppState.userLocation = {
      ...(AppState.userLocation || {}),
      name: location || `${district}, ${state}`,
    };
    try {
      localStorage.setItem('kavach_district', district);
      localStorage.setItem('kavach_state', state);
    } catch (_) {}
  }
  try { localStorage.setItem('kavach_user', JSON.stringify(AppState.currentUser)); } catch (_) {}

  applyUiLang(lang);
  if (AppState.smsState) AppState.smsState.lang = lang;

  // Geocode + lock the map to the chosen city, then re-scope SACHET.
  try { kavachApplyLocation(state, district, location); } catch (_) {}

  showScreen('home');
  if (typeof showToast === 'function') showToast(`Welcome, ${name.split(' ')[0]}`, 'success');
}
window.simpleLogin = simpleLogin;
window.initSimpleLoginScreen = initSimpleLoginScreen;

// ──────────────────────────────────────────────────────────────
//  LIGHT UI LANGUAGE LAYER  (English / हिंदी / Hinglish)
// ──────────────────────────────────────────────────────────────
const KAVACH_I18N = {
  english: {},
  hindi: {
    'btn.continue': 'आगे बढ़ें', 'btn.login': 'लॉगिन',
    'login.title': 'कवच में आपका स्वागत है', 'login.name': 'पूरा नाम',
    'login.mobile': 'मोबाइल नंबर', 'login.state': 'राज्य', 'login.district': 'ज़िला',
    'login.location': 'वर्तमान स्थान', 'login.lang': 'भाषा',
    'dash.quick': 'त्वरित कार्य', 'dash.advisory': 'सुरक्षा सलाह',
    'qa.emergency': 'आपातकाल', 'qa.emergency.sub': 'तुरंत मदद माँगें',
    'qa.call': 'कॉल', 'qa.requests': 'अनुरोध', 'qa.weather': 'मौसम', 'qa.profile': 'प्रोफ़ाइल',
    'advisory.default': 'आधिकारिक चेतावनियों से अपडेट रहें। आपातकालीन किट रखें, फ़ोन चार्ज रखें और अपने निकटतम आश्रय को जानें।',
    'ivr.title': 'कवच आपातकालीन हेल्पलाइन', 'ivr.sub': 'टोल-फ्री • 24x7 • भारत सरकार',
    'ivr.start': '☎ कॉल शुरू करें', 'ivr.panel': 'AI आपातकालीन हेल्पलाइन', 'ivr.hangup': '📵 कॉल समाप्त करें',
    'ivr.hint': 'कॉल शुरू करें दबाएँ और बोलें। AI हेल्पलाइन अधिकारी आपसे बात करेगा, आपकी स्थिति समझेगा और मदद भेजेगा। कॉल के दौरान आपकी लाइव लोकेशन साझा की जाती है।',
    'profile.title': 'मेरी प्रोफ़ाइल', 'profile.verified': 'आधार-लिंक्ड (सिम्युलेटेड)',
    'profile.personal': 'व्यक्तिगत विवरण', 'profile.location': 'स्थान', 'profile.prefs': 'ऐप सेटिंग्स',
    'profile.blood': 'ब्लड ग्रुप', 'profile.emergency': 'आपातकालीन संपर्क',
    'profile.address': 'पता / पहचान', 'profile.notif': 'आपातकालीन सूचनाएँ',
    'profile.share': 'कॉल के दौरान लाइव लोकेशन साझा करें',
    'profile.lang.hint': 'पूरा ऐप इस भाषा में बदल जाएगा।',
    'profile.theme': 'रूप-रंग', 'profile.theme.hint': 'डार्क मोड रात में पढ़ने में आसान है और बिजली जाने पर बैटरी बचाता है।',
    'profile.save': 'प्रोफ़ाइल सहेजें', 'profile.logout': 'लॉग आउट',
    'req.title': 'मेरे अनुरोध',
    'wx.forecast': '5-दिन का पूर्वानुमान', 'wx.tips': 'सुरक्षा सुझाव',
    'wx.helplines': 'हेल्पलाइन नंबर', 'wx.nearby': 'आस-पास के क्षेत्र',
    'dash.watch': 'लाइव मौसम निगरानी', 'dash.viewWeather': 'मौसम विवरण देखें →',
    'notif.title': 'आपातकालीन अलर्ट चालू करें',
    'notif.sub': 'जैसे ही कोई आधिकारिक चेतावनी या ब्रॉडकास्ट आपके क्षेत्र को कवर करे, फ़ोन पर सूचना पाएं।',
    'notif.enable': 'चालू करें',
    'tools.history': 'इतिहास', 'hist.title': 'अलर्ट व ब्रॉडकास्ट',
  },
  hinglish: {
    'btn.continue': 'Aage badhein', 'btn.login': 'Login',
    'login.title': 'Kavach mein aapka swagat hai', 'login.name': 'Pura naam',
    'login.mobile': 'Mobile number', 'login.state': 'State', 'login.district': 'District',
    'login.location': 'Current location', 'login.lang': 'Bhasha',
    'dash.quick': 'Quick Actions', 'dash.advisory': 'Safety Advisory',
    'qa.emergency': 'Emergency', 'qa.emergency.sub': 'Turant madad maangein',
    'qa.call': 'Call', 'qa.requests': 'Requests', 'qa.weather': 'Mausam', 'qa.profile': 'Profile',
    'advisory.default': 'Official alerts se updated rahein. Emergency kit rakhein, phone charge rakhein, aur apna nearest shelter jaanein.',
    'ivr.title': 'Kavach Emergency Helpline', 'ivr.sub': 'Toll-Free • 24x7 • Government of India',
    'ivr.start': '☎ Call shuru karein', 'ivr.panel': 'AI Emergency Helpline', 'ivr.hangup': '📵 Call band karein',
    'ivr.hint': 'START CALL dabaiye aur boliye. AI helpline officer aapse baat karega, situation samjhega aur madad bhejega. Call ke dauraan aapki live location responders ke saath share hoti hai.',
    'profile.title': 'Meri Profile', 'profile.verified': 'Aadhaar-linked (simulated)',
    'profile.personal': 'Personal Details', 'profile.location': 'Location', 'profile.prefs': 'App Preferences',
    'profile.blood': 'Blood Group', 'profile.emergency': 'Emergency Contact',
    'profile.address': 'Address / Landmark', 'profile.notif': 'Emergency notifications',
    'profile.share': 'Call ke dauraan live location share karein',
    'profile.lang.hint': 'Pura app is bhasha mein switch ho jayega.',
    'profile.theme': 'Appearance', 'profile.theme.hint': 'Dark mode raat mein padhne mein aasan hai aur bijli jaane par battery bachata hai.',
    'profile.save': 'Profile save karein', 'profile.logout': 'Log out',
    'req.title': 'Mere Requests',
    'wx.forecast': '5-Day Forecast', 'wx.tips': 'Safety Tips',
    'wx.helplines': 'Helpline Numbers', 'wx.nearby': 'Aas-paas ke area',
    'dash.watch': 'Live Weather Watch', 'dash.viewWeather': 'Mausam detail dekhein →',
    'notif.title': 'Emergency alerts on karein',
    'notif.sub': 'Jaise hi koi official warning ya broadcast aapke area ko cover kare, phone par notification paayein.',
    'notif.enable': 'Enable',
    'tools.history': 'History', 'hist.title': 'Alerts & Broadcasts',
  },
};

// Broad phrase-level translation for static UI text that isn't tagged
// with data-i18n. Exact-match only (safe): a text node is replaced
// only if its trimmed content is exactly a key. Dynamic panels are
// skipped.
const KAVACH_PHRASES = {
  hindi: {
    'Rain radar': 'वर्षा रडार', 'SACHET zones': 'सचेत क्षेत्र',
    'QUICK ACTIONS': 'त्वरित कार्य', 'SAFETY ADVISORY': 'सुरक्षा सलाह',
    'SACHET NDMA ALERTS': 'सचेत NDMA अलर्ट', '🔄 Refresh': '🔄 रिफ़्रेश',
    '🔴 SACHET NDMA ALERTS': '🔴 सचेत NDMA अलर्ट',
    'YOUR LOCATION': 'आपका स्थान', 'WEATHER & DISASTER MAP': 'मौसम व आपदा मानचित्र',
    'NEARBY AREAS': 'आस-पास के क्षेत्र', '5-DAY FORECAST': '5-दिन का पूर्वानुमान',
    'SAFETY TIPS': 'सुरक्षा सुझाव', 'HELPLINES': 'हेल्पलाइन नंबर',
    'India Weather Map': 'भारत मौसम मानचित्र', 'Search': 'खोजें',
    'Current Location': 'वर्तमान स्थान', 'Rainfall': 'वर्षा', 'Temperature': 'तापमान',
    'Wind': 'हवा', 'Humidity': 'नमी', 'Wind Speed': 'हवा की गति', 'Visibility': 'दृश्यता',
    'Pressure': 'दबाव', 'Alert Valid': 'अलर्ट मान्य', 'Hazard Level': 'खतरे का स्तर',
    'Weather Details': 'मौसम विवरण', 'Emergency Assistance': 'आपातकालीन सहायता',
    'What help do you need?': 'आपको क्या मदद चाहिए?', 'Select all that apply': 'जो लागू हो चुनें',
    'How many people are affected?': 'कितने लोग प्रभावित हैं?',
    'Is anyone injured?': 'क्या कोई घायल है?', 'Are you trapped?': 'क्या आप फँसे हैं?',
    'Confirm Your Location': 'अपना स्थान पुष्टि करें',
    'NEXT →': 'आगे →', 'YES': 'हाँ', 'NO': 'नहीं', 'Medical': 'चिकित्सा', 'Rescue': 'बचाव',
    'Food': 'भोजन', 'Water': 'पानी', 'Shelter': 'आश्रय', 'Other': 'अन्य',
    'My Requests': 'मेरे अनुरोध', 'Track status': 'स्थिति देखें',
    'No new notifications': 'कोई नई सूचना नहीं',
    'Please provide details so we can help you quickly.': 'कृपया विवरण दें ताकि हम शीघ्र मदद कर सकें।',
    'Good': 'नमस्ते,', 'Morning': '', 'Afternoon': '', 'Evening': '',
    // dashboard + navigation
    'RESPONSE TIMELINE': 'प्रतिक्रिया समयरेखा', 'Continue': 'आगे बढ़ें',
    'Continue as Demo User': 'डेमो उपयोगकर्ता के रूप में जारी रखें',
    'CREATE ACCOUNT': 'खाता बनाएं', '← Back to Login': '← लॉगिन पर वापस',
    'Request help now': 'अभी मदद माँगें', 'Emergency': 'आपातकाल',
    'Call': 'कॉल', 'Requests': 'अनुरोध', 'Weather': 'मौसम', 'Profile': 'प्रोफ़ाइल',
    'View all': 'सभी देखें', 'Refresh': 'रिफ़्रेश',
    // request tracker
    'Received': 'प्राप्त हुआ', 'Assigned': 'सौंपा गया', 'En route': 'रास्ते में',
    'Resolved': 'हल हो गया', 'No requests yet': 'अभी कोई अनुरोध नहीं',
    'Team assigned': 'टीम सौंपी गई', 'Help is on the way': 'मदद रास्ते में है',
    // IVR / helpline
    'Kavach Emergency Helpline': 'कवच आपातकालीन हेल्पलाइन',
    'Start Call': 'कॉल शुरू करें', 'Hang Up': 'कॉल समाप्त करें',
    'Toll-Free': 'टोल-फ्री', 'Government of India': 'भारत सरकार',
    'Officer': 'अधिकारी', 'You': 'आप', 'Listening…': 'सुन रहे हैं…',
    'Tap to speak': 'बोलने के लिए टैप करें', 'Processing…': 'प्रोसेस हो रहा है…',
    // emergency form
    'How many people are affected?': 'कितने लोग प्रभावित हैं?',
    'Describe your situation': 'अपनी स्थिति बताएं',
    'Submit Request': 'अनुरोध भेजें', 'BACK': 'पीछे', 'Back': 'पीछे',
    // weather screen
    'Feels like': 'महसूस होता है', 'Forecast': 'पूर्वानुमान',
    'Humidity': 'नमी', 'Wind': 'हवा', 'Rainfall': 'वर्षा', 'Temperature': 'तापमान',
    'Today': 'आज', 'Tomorrow': 'कल',
    // misc
    'Logout': 'लॉग आउट', 'Save': 'सहेजें', 'Cancel': 'रद्द करें',
    'OK — Dismiss Alert': 'ठीक है — अलर्ट हटाएं',
    'Live location shared with responders': 'रेस्पॉन्डर्स के साथ लाइव लोकेशन साझा',
    // status badges + greeting + weather conditions
    'Morning': 'सुबह', 'Afternoon': 'दोपहर', 'Evening': 'शाम', 'Night': 'रात',
    '🔄 Retry': '🔄 पुनः प्रयास', '🔄 Refresh': '🔄 रिफ़्रेश',
    '● LOADING AZURE': '● लोड हो रहा है', '● LIVE — Azure': '● लाइव — Azure',
    '📍 Current Location': '📍 वर्तमान स्थान',
    '📍 Update Exact Location': '📍 सटीक स्थान अपडेट करें',
    'HIGH': 'उच्च', 'SEVERE': 'गंभीर', 'MODERATE': 'मध्यम', 'LOW': 'कम',
    'YOUR EXACT LOCATION': 'आपका सटीक स्थान',
    'Shared live with responders': 'रेस्पॉन्डर्स के साथ लाइव साझा',
    '⟳ Update': '⟳ अपडेट', 'Locating…': 'स्थान खोजा जा रहा है…',
    'Using last known location': 'अंतिम ज्ञात स्थान का उपयोग',
    'Mostly cloudy': 'अधिकतर बादल', 'Partly cloudy': 'आंशिक बादल',
    'Clear': 'साफ़', 'Sunny': 'धूप', 'Cloudy': 'बादल', 'Rain': 'वर्षा',
    'Light rain': 'हल्की वर्षा', 'Heavy rain': 'भारी वर्षा',
    'Thunderstorms': 'गरज के साथ तूफ़ान', 'Fog': 'कोहरा', 'Haze': 'धुंध',
    'Showers': 'बौछारें', 'Overcast': 'घने बादल',
    '⏳ Loading…': '⏳ लोड हो रहा है…', 'LIVE WEATHER': 'लाइव मौसम',
    'No active official alerts at this time.': 'इस समय कोई सक्रिय आधिकारिक अलर्ट नहीं।',
    '⚠ Official disaster alert data unavailable.': '⚠ आधिकारिक आपदा अलर्ट डेटा उपलब्ध नहीं।',
    '⏳ Fetching from SACHET NDMA...': '⏳ सचेत NDMA से लाया जा रहा है...',
    '⏳ Loading live alerts from SACHET NDMA...': '⏳ सचेत NDMA से लाइव अलर्ट लोड हो रहे हैं...',
  },
  hinglish: {
    'QUICK ACTIONS': 'Quick Actions', 'SAFETY ADVISORY': 'Safety Advisory',
    'SACHET NDMA ALERTS': 'SACHET NDMA Alerts', '🔄 Refresh': '🔄 Refresh',
    'YOUR LOCATION': 'Aapka sthaan', 'WEATHER & DISASTER MAP': 'Mausam aur Aapda Map',
    'NEARBY AREAS': 'Aas-paas ke area', '5-DAY FORECAST': '5-Day Forecast',
    'SAFETY TIPS': 'Safety Tips', 'HELPLINES': 'Helpline Numbers',
    'India Weather Map': 'India Weather Map', 'Search': 'Khojein',
    'Current Location': 'Current Location', 'Rainfall': 'Barish', 'Temperature': 'Taapmaan',
    'Wind': 'Hawa', 'Humidity': 'Nami', 'Wind Speed': 'Hawa speed', 'Visibility': 'Visibility',
    'Pressure': 'Pressure', 'Alert Valid': 'Alert valid', 'Hazard Level': 'Khatre ka level',
    'Weather Details': 'Mausam details', 'Emergency Assistance': 'Emergency Sahayata',
    'What help do you need?': 'Aapko kya madad chahiye?', 'Select all that apply': 'Jo lागू ho chunein',
    'How many people are affected?': 'Kitne log affected hain?',
    'Is anyone injured?': 'Koi ghayal hai?', 'Are you trapped?': 'Aap phanse hain?',
    'Confirm Your Location': 'Apni location confirm karein',
    'NEXT →': 'Aage →', 'YES': 'Haan', 'NO': 'Nahi', 'Medical': 'Medical', 'Rescue': 'Rescue',
    'Food': 'Khana', 'Water': 'Paani', 'Shelter': 'Shelter', 'Other': 'Anya',
    'My Requests': 'Mere Requests', 'Track status': 'Status dekhein',
    'RESPONSE TIMELINE': 'Response Timeline', 'Continue': 'Aage badhein',
    'Continue as Demo User': 'Demo user ke roop mein continue karein',
    'CREATE ACCOUNT': 'Account banayein', '← Back to Login': '← Login par wapas',
    'Request help now': 'Abhi madad maangein',
    'View all': 'Sabhi dekhein', 'Refresh': 'Refresh',
    'Received': 'Mila', 'Assigned': 'Assign hua', 'En route': 'Raaste mein',
    'Resolved': 'Resolve hua', 'No requests yet': 'Abhi koi request nahi',
    'Team assigned': 'Team assign hui', 'Help is on the way': 'Madad raaste mein hai',
    'Kavach Emergency Helpline': 'Kavach Emergency Helpline',
    'Start Call': 'Call shuru karein', 'Hang Up': 'Call band karein',
    'Officer': 'Officer', 'You': 'Aap', 'Listening…': 'Sun rahe hain…',
    'Tap to speak': 'Bolne ke liye tap karein', 'Processing…': 'Process ho raha hai…',
    'Describe your situation': 'Apni situation batayein',
    'Submit Request': 'Request bhejein', 'BACK': 'Peeche', 'Back': 'Peeche',
    'Feels like': 'Mehsoos hota hai', 'Forecast': 'Forecast',
    'Today': 'Aaj', 'Tomorrow': 'Kal',
    'Logout': 'Log out', 'Save': 'Save karein', 'Cancel': 'Cancel',
    'OK — Dismiss Alert': 'OK — Alert hatayein',
    'No new notifications': 'Koi nayi notification nahi',
    'Please provide details so we can help you quickly.': 'Kripya details dein taki hum jaldi madad kar sakein.',
    'Good': 'Namaste,', 'Morning': '', 'Afternoon': '', 'Evening': '',
  },
};

function translateTextNodes(lang) {
  const map = KAVACH_PHRASES[lang];
  const root = document.getElementById('phone-screen');
  if (!map || !root) return;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'INPUT', 'TEXTAREA', 'SELECT']);
  const SKIP_IDS = new Set([
    'status-bar', 'android-nav', 'helpline-log', 'chat-messages',
    'helpline-agent-line', 'helpline-you-line',
    'broadcast-chat-messages', 'creg-city',
  ]);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const t = (n.nodeValue || '').trim();
      if (!t || !map[t]) return NodeFilter.FILTER_REJECT;
      let p = n.parentElement;
      while (p && p !== root) {
        if (SKIP.has(p.tagName) || SKIP_IDS.has(p.id) || p.hasAttribute('data-i18n') || p.hasAttribute('data-no-i18n')) {
          return NodeFilter.FILTER_REJECT;
        }
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const t = n.nodeValue.trim();
    if (!n.__i18nBase) n.__i18nBase = n.nodeValue;
    n.nodeValue = n.nodeValue.replace(t, map[t]);
  }
}

// keys that translate a placeholder / attribute rather than textContent
function initProfileScreen() {
  const u = AppState.currentUser || (() => {
    try { return JSON.parse(localStorage.getItem('kavach_user') || 'null'); } catch (_) { return null; }
  })() || {};

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  set('prof-name', u.name);
  set('prof-mobile', u.mobile);
  set('prof-blood', u.blood);
  set('prof-emergency', u.emergency_contact);
  set('prof-address', u.address || (u.location && u.location.name) || '');
  set('prof-lang', AppState.uiLang || u.lang || 'english');

  const nd = document.getElementById('profile-name-display');
  if (nd) nd.textContent = u.name || 'Citizen';
  const idd = document.getElementById('profile-id-display');
  if (idd) idd.textContent = 'Kavach ID — ' + (u.id || (u.mobile ? 'U-' + u.mobile.slice(-4) : '—'));
  const av = document.getElementById('profile-avatar');
  if (av) av.textContent = (u.name || 'U').trim().charAt(0).toUpperCase();

  // state / district dropdowns from the bundled dataset
  const st = document.getElementById('prof-state');
  const di = document.getElementById('prof-district');
  if (st && di && window.INDIA_DISTRICTS) {
    if (st.options.length <= 1) {
      for (const s of Object.keys(window.INDIA_DISTRICTS).sort()) st.add(new Option(s, s));
    }
    const fillDistricts = (state, pick) => {
      di.innerHTML = '<option value="">—</option>';
      for (const d of (window.INDIA_DISTRICTS[state] || [])) di.add(new Option(d, d));
      di.disabled = !(window.INDIA_DISTRICTS[state] || []).length;
      if (pick) di.value = pick;
    };
    st.onchange = () => fillDistricts(st.value);
    if (u.state) { st.value = u.state; fillDistricts(u.state, u.district); }
  }

  const notif = document.getElementById('prof-notif');
  if (notif) notif.checked = u.notif !== false;
  const share = document.getElementById('prof-share');
  if (share) share.checked = u.share_location !== false;

  const theme = document.getElementById('prof-theme');
  if (theme) theme.value = kavachPreferredTheme();

  applyUiLang(AppState.uiLang || u.lang || 'english');
}
window.initProfileScreen = initProfileScreen;

// ──────────────────────────────────────────────────────────────
//  APPLY A CHOSEN CITY  —  geocode it, move + LOCK the Kavach map
//  to that city, persist, and re-scope every SACHET view.
// ──────────────────────────────────────────────────────────────
let _kavachCityBounds = null;   // [W, S, E, N] for the current city

async function kavachApplyLocation(state, district, freeText) {
  district = (district || '').trim();
  state = (state || '').trim();
  try {
    if (district) localStorage.setItem('kavach_district', district);
    if (state) localStorage.setItem('kavach_state', state);
  } catch (_) {}

  const label = freeText || [district, state].filter(Boolean).join(', ') || 'India';
  AppState.userLocation = { ...(AppState.userLocation || {}), name: label };

  // Geocode the city so the map can centre + lock on it.
  const q = [district || freeText, state, 'India'].filter(Boolean).join(', ');
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(q)}`,
      { headers: { 'Accept-Language': 'en' }, signal: AbortSignal.timeout(8000) }
    );
    const j = r.ok ? await r.json() : [];
    if (j && j[0]) {
      const lat = Number(j[0].lat), lng = Number(j[0].lon);
      AppState.userLocation = { ...AppState.userLocation, lat, lng, name: label };
      try {
        localStorage.setItem('kavach_user_location', JSON.stringify({ lat, lng, name: label }));
      } catch (_) {}
      if (Array.isArray(j[0].boundingbox) && j[0].boundingbox.length === 4) {
        const bb = j[0].boundingbox.map(Number);           // [S, N, W, E]
        // pad a little so the city isn't flush against the frame
        const padLat = Math.max(0.08, (bb[1] - bb[0]) * 0.25);
        const padLng = Math.max(0.08, (bb[3] - bb[2]) * 0.25);
        _kavachCityBounds = [bb[2] - padLng, bb[0] - padLat, bb[3] + padLng, bb[1] + padLat];
      } else {
        _kavachCityBounds = [lng - 0.4, lat - 0.4, lng + 0.4, lat + 0.4];
      }
    }
  } catch (e) {
    console.warn('[Kavach] city geocode failed', e && e.message);
  }

  kavachLockMapToCity();

  // Pull live weather for the NEW district, otherwise the card keeps
  // showing the previous city's reading under the new city's name.
  const lat = Number(AppState.userLocation && AppState.userLocation.lat);
  const lng = Number(AppState.userLocation && AppState.userLocation.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    try {
      await fetchExactWeatherForLocation(lat, lng, label);
      AppState.weatherLoaded = true;
      AppState.weatherSource = 'Live - Azure';
    } catch (e) {
      console.warn('[Kavach] weather for new city failed', e && e.message);
      AppState.weatherLoaded = false;
      AppState.weatherSource = 'Azure unavailable';
    }
    try { updateWeatherCardUI(); updateDataSourceBadges(); } catch (_) {}
  }

  try { renderSACHETPanel(AppState.sachetUnavailable); } catch (_) {}
  try { renderOfficialAlertZones(); } catch (_) {}
  try { updateHomeAlertFromSACHET(); } catch (_) {}
  try { updateBellDot(); } catch (_) {}
  try { if (typeof updateDashboard === 'function') updateDashboard(); } catch (_) {}
  // If a request is live, push the responder the citizen's new location.
  try { if (_callerGeoIncident && typeof _callerManualWrite === 'function') _callerManualWrite(); } catch (_) {}
}
window.kavachApplyLocation = kavachApplyLocation;

// Centre the Kavach Azure map on the citizen's city and keep it there
// (they only care about their own area). Re-applied on map 'ready'.
function kavachLockMapToCity() {
  const map = window.azureMapInstance;
  const loc = AppState.userLocation || {};
  const lat = Number(loc.lat), lng = Number(loc.lng);
  if (!map || !map.setCamera) return;
  try {
    if (_kavachCityBounds) {
      map.setCamera({
        bounds: _kavachCityBounds,
        padding: 24,
        maxBounds: _kavachCityBounds,     // hard lock — can't pan away
        minZoom: 8,
      });
    } else if (Number.isFinite(lat) && Number.isFinite(lng)) {
      map.setCamera({ center: [lng, lat], zoom: 10, minZoom: 8 });
    }
  } catch (e) { console.warn('[Kavach] lock map failed', e && e.message); }
}
window.kavachLockMapToCity = kavachLockMapToCity;

function saveProfile() {
  const val = (id) => (document.getElementById(id) || {}).value || '';
  const chk = (id) => !!(document.getElementById(id) || {}).checked;
  const name = val('prof-name').trim();
  const mobile = val('prof-mobile').trim();
  if (!name || !/^\d{10}$/.test(mobile)) {
    showToast('Enter your name and a valid 10-digit mobile number.', 'warning');
    return;
  }
  const district = val('prof-district');
  AppState.currentUser = Object.assign({}, AppState.currentUser, {
    id: (AppState.currentUser && AppState.currentUser.id) || 'U-' + mobile.slice(-4),
    name, mobile,
    blood: val('prof-blood'),
    emergency_contact: val('prof-emergency'),
    state: val('prof-state'),
    district,
    address: val('prof-address'),
    lang: val('prof-lang'),
    notif: chk('prof-notif'),
    share_location: chk('prof-share'),
  });
  try { localStorage.setItem('kavach_user', JSON.stringify(AppState.currentUser)); } catch (_) {}
  if (val('prof-address')) {
    AppState.userLocation = Object.assign({}, AppState.userLocation, { name: val('prof-address') });
  }
  applyUiLang(val('prof-lang'));
  // Re-geocode + re-lock the map if the city changed.
  try { kavachApplyLocation(val('prof-state'), district, val('prof-address')); } catch (_) {}
  if (typeof updateDashboard === 'function') updateDashboard();
  showToast('Profile saved', 'success');
  showScreen('dashboard');
}
window.saveProfile = saveProfile;

function logoutUser() {
  try {
    localStorage.removeItem('kavach_user');
    localStorage.removeItem('kavach_district');
    localStorage.removeItem('kavach_state');
  } catch (_) {}
  _kavachCityBounds = null;
  AppState.currentUser = null;
  showScreen('login');
}
window.logoutUser = logoutUser;

function applyUiLang(lang) {
  AppState.uiLang = lang;
  try { localStorage.setItem('kavach_ui_lang', lang); } catch (_) {}
  const dict = KAVACH_I18N[lang] || {};
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const base = el.getAttribute('data-i18n-base') || el.textContent;
    if (!el.getAttribute('data-i18n-base')) el.setAttribute('data-i18n-base', base);
    el.textContent = dict[key] || base;
  });
  document.querySelectorAll('.kv-lang-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.lang === lang);
  });

  // Broad text-node sweep for untagged static labels.
  if (lang === 'english') {
    // restore originals
    const root = document.getElementById('phone-screen');
    if (root) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      while (w.nextNode()) { if (w.currentNode.__i18nBase) w.currentNode.nodeValue = w.currentNode.__i18nBase; }
    }
  } else {
    try { translateTextNodes(lang); } catch (_) {}
  }

  _ensureI18nObserver();
}
window.applyUiLang = applyUiLang;

// Re-sweep the DOM whenever a screen re-renders (SACHET cards, weather,
// request tracker, toasts) so a non-English UI stays fully translated
// instead of snapping back to English on every dynamic update.
let _i18nObserver = null;
let _i18nSweepQueued = false;
function _ensureI18nObserver() {
  const root = document.getElementById('phone-screen');
  if (!root || _i18nObserver) return;
  _i18nObserver = new MutationObserver(() => {
    const lang = AppState.uiLang || 'english';
    if (lang === 'english' || _i18nSweepQueued) return;
    _i18nSweepQueued = true;
    requestAnimationFrame(() => {
      _i18nSweepQueued = false;
      try { translateTextNodes(lang); } catch (_) {}
      document.querySelectorAll('[data-i18n]').forEach((el) => {
        const dict = KAVACH_I18N[lang] || {};
        const key = el.getAttribute('data-i18n');
        const base = el.getAttribute('data-i18n-base');
        if (base && dict[key]) el.textContent = dict[key];
      });
    });
  });
  _i18nObserver.observe(root, { childList: true, subtree: true, characterData: true });
}

// ──────────────────────────────────────────────────────────────
//  SPEECH-TO-TEXT  (Hindi / English / Hinglish) for call + SMS AI
// ──────────────────────────────────────────────────────────────
const SPEECH_LANG = { english: 'en-IN', hindi: 'hi-IN', hinglish: 'en-IN' };
let _kavachRec = null;
let _kavachRecTarget = null;

function kavachStartSpeech(target) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    if (typeof showToast === 'function') showToast('Speech recognition not supported in this browser.', 'warning');
    return;
  }
  const lang = SPEECH_LANG[(AppState.uiLang || AppState.smsState?.lang || 'english')] || 'en-IN';

  if (_kavachRec) { try { _kavachRec.stop(); } catch (_) {} }
  _kavachRec = new SR();
  _kavachRecTarget = target;
  _kavachRec.lang = lang;
  _kavachRec.interimResults = true;
  _kavachRec.continuous = false;

  const box = document.getElementById(target === 'ivr' ? 'ivr-speech-text' : 'chat-input');
  const micBtn = document.getElementById(target === 'ivr' ? 'ivr-mic-btn' : 'sms-mic-btn');
  if (micBtn) micBtn.classList.add('listening');

  let finalText = '';
  _kavachRec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t + ' ';
      else interim += t;
    }
    if (box) {
      if (box.tagName === 'INPUT' || box.tagName === 'TEXTAREA') box.value = (finalText + interim).trim();
      else box.textContent = (finalText + interim).trim();
    }
  };
  _kavachRec.onerror = (e) => {
    if (typeof showToast === 'function') showToast('Mic error: ' + e.error, 'warning');
  };
  _kavachRec.onend = () => {
    if (micBtn) micBtn.classList.remove('listening');
    const text = (finalText || (box ? (box.value || box.textContent) : '')).trim();
    if (!text) return;
    if (target === 'ivr') {
      const promptEl = document.getElementById('ivr-prompt');
      if (promptEl) promptEl.textContent = 'You said: "' + text + '"\n\nProcessing your emergency…';
      // Route the spoken emergency through the same AI triage as SMS.
      if (typeof handleAIMessage === 'function') handleAIMessage(text);
      if (typeof showToast === 'function') showToast('Emergency captured from voice — request created.', 'success');
    } else if (target === 'sms') {
      // Force AI-triage mode and send the spoken message.
      if (AppState.smsState && !AppState.smsState.aiMode && typeof toggleAIMode === 'function') {
        AppState.smsState.aiMode = true;
        const t = document.getElementById('ai-mode-toggle'); if (t) t.classList.add('active');
      }
      if (typeof sendSMSMessage === 'function') sendSMSMessage();
    }
  };

  try { _kavachRec.start(); } catch (_) {}
}
window.kavachStartSpeech = kavachStartSpeech;

// ──────────────────────────────────────────────────────────────
//  FORM LOCATION MAP  (emergency form + safety-report form)
//  ------------------------------------------------------------
//  Every report form ends with a map of the citizen's EXACT
//  location, and keeps a live GPS watch running while the form is
//  open, so what the responder receives is what the citizen sees.
// ──────────────────────────────────────────────────────────────
const FORM_MAP_IDS = { emg: 'emg-mini-map-canvas', creg: 'creg-mini-map-canvas' };
const _formMaps = {};          // key -> { map, marker }
let _formGeoWatch = null;
let _formGeoKeys = new Set();  // forms currently on screen

function _formMapPlaceholder(el, msg, key) {
  if (!el) return;
  // Tear the failed map down first — the Azure SDK leaves screen-reader
  // help text ("Map shortcuts: Zoom out: hyphen…") behind, which then
  // bleeds through and overlaps the card.
  if (key && _formMaps[key] && _formMaps[key].map) {
    try { _formMaps[key].map.dispose(); } catch (_) {}
    _formMaps[key] = null;
  }
  el.innerHTML = '<div class="fmm-placeholder">' + escapeHtml(msg) + '</div>';
}

function _formLocLine(loc, lat, lng) {
  return (loc.name || 'Your location') + '\n' +
    lat.toFixed(5) + '°N, ' + lng.toFixed(5) + '°E';
}

// Renders (or re-centres) the mini map for one form.
function renderFormLocationMap(key) {
  const el = document.getElementById(FORM_MAP_IDS[key]);
  if (!el) return;

  const loc = AppState.userLocation || {};
  const lat = Number(loc.lat), lng = Number(loc.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    _formMapPlaceholder(el, 'Waiting for your location… tap Update to retry.', key);
    return;
  }

  if (!window.atlas) {
    _formMapPlaceholder(el, _formLocLine(loc, lat, lng), key);
    return;
  }

  const existing = _formMaps[key];
  if (existing && existing.map) {
    try {
      existing.map.setCamera({ center: [lng, lat], zoom: 15 });
      if (existing.marker) existing.marker.setOptions({ position: [lng, lat] });
      return;
    } catch (_) { /* fall through and rebuild */ }
  }

  try {
    el.innerHTML = '';
    const map = new atlas.Map(el, {
      center: [lng, lat], zoom: 15, pitch: 0, bearing: 0,
      style: 'road', view: 'IN',
      showLogo: false, showFeedbackLink: false,
      dragRotateInteraction: false, pitchInteraction: false,
      authOptions: { authType: 'subscriptionKey', subscriptionKey: AZURE_MAPS_KEY },
    });

    map.events.add('error', function () {
      _formMapPlaceholder(el, _formLocLine(loc, lat, lng), key);
    });

    // If the basemap never paints (bad/blocked key, offline, quota),
    // fall back to a readable coordinate card instead of a white box.
    let painted = false;
    setTimeout(function () {
      if (!painted) _formMapPlaceholder(el, _formLocLine(loc, lat, lng), key);
    }, 4500);

    map.events.add('ready', function () {
      painted = true;
      const marker = new atlas.HtmlMarker({
        position: [lng, lat],
        htmlContent:
          '<div style="position:relative;width:20px;height:20px">' +
          '<div style="position:absolute;inset:0;border-radius:50%;background:#d32f2f;' +
          'border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.4)"></div>' +
          '<div style="position:absolute;inset:-7px;border-radius:50%;border:2px solid #d32f2f;' +
          'animation:kvpulse 1.6s infinite"></div></div>',
      });
      map.markers.add(marker);
      _formMaps[key] = { map: map, marker: marker };
    });

    _formMaps[key] = { map: map, marker: null };
  } catch (err) {
    console.warn('[kavach] form map failed', err);
    _formMapPlaceholder(el, _formLocLine(loc, lat, lng), key);
  }
}

// Live GPS while a report form is open. Every fix updates the map, the
// on-form readouts and AppState, so the submitted report carries the
// freshest position and the responder's pin stays in step.
function startFormLocationWatch(key) {
  _formGeoKeys.add(key);
  renderFormLocationMap(key);
  updateFormLocationReadouts();

  if (_formGeoWatch !== null || !navigator.geolocation) return;

  const onFix = function (pos) {
    const c = pos.coords;
    AppState.userLocation = Object.assign({}, AppState.userLocation, {
      lat: c.latitude,
      lng: c.longitude,
      isExact: true,
      exact: c.latitude.toFixed(5) + '°N, ' + c.longitude.toFixed(5) + '°E',
      accuracy_m: Math.round(c.accuracy || 0),
    });
    try { saveUserLocation(AppState.userLocation); } catch (_) {}

    _formGeoKeys.forEach(function (k) { renderFormLocationMap(k); });
    try { updateFormLocationReadouts(); } catch (_) {}
    try {
      if (typeof _callerManualWrite === 'function' && _callerGeoIncident) _callerManualWrite();
    } catch (_) {}
  };

  const onErr = function (err) {
    console.warn('[kavach] form geolocation error', err && err.message);
    document.querySelectorAll('.fmm-live').forEach(function (n) {
      n.classList.add('stale');
      n.innerHTML = '<span class="fmm-dot"></span> Using last known location';
    });
  };

  navigator.geolocation.getCurrentPosition(onFix, onErr,
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 });
  _formGeoWatch = navigator.geolocation.watchPosition(onFix, onErr,
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 4000 });
}

function stopFormLocationWatch(key) {
  if (key) _formGeoKeys.delete(key); else _formGeoKeys.clear();
  if (_formGeoKeys.size === 0 && _formGeoWatch !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(_formGeoWatch);
    _formGeoWatch = null;
  }
}

// Mirrors the live position into whichever form readouts are on screen.
function updateFormLocationReadouts() {
  const loc = AppState.userLocation || {};
  const lat = Number(loc.lat), lng = Number(loc.lng);
  const set = function (id, v) { const e = document.getElementById(id); if (e) e.textContent = v; };

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  set('emg-loc-name', loc.name || 'Current location');
  set('emg-loc-coords', 'Lat: ' + lat.toFixed(5) + '° N, Lng: ' + lng.toFixed(5) + '° E');
  set('creg-city', loc.name || 'Current location');
  set('creg-lat', lat.toFixed(5) + '° N');
  set('creg-lng', lng.toFixed(5) + '° E');
  set('creg-accuracy', loc.accuracy_m ? ('±' + loc.accuracy_m + ' m (GPS)') : (loc.isExact ? 'GPS' : 'Approximate'));

  // Address strip under each form map.
  const addr = (loc.name || 'Current location') +
    '<small>' + lat.toFixed(5) + '° N, ' + lng.toFixed(5) + '° E' +
    (loc.accuracy_m ? '  ·  ±' + loc.accuracy_m + ' m' : '') + '</small>';
  ['emg-mini-map-addr', 'creg-mini-map-addr'].forEach(function (id) {
    const e = document.getElementById(id);
    if (e) e.innerHTML = addr;
  });

  const st = document.getElementById('creg-geo-status');
  if (st) { st.textContent = '✅ Location locked and shared live'; st.style.color = 'var(--success)'; }
}

function refreshFormLocation(key) {
  if (!navigator.geolocation) {
    showToast('Location is not available on this device.', 'warning');
    return;
  }
  showToast('Updating your location…', 'info');
  navigator.geolocation.getCurrentPosition(
    function (pos) {
      const c = pos.coords;
      AppState.userLocation = Object.assign({}, AppState.userLocation, {
        lat: c.latitude, lng: c.longitude, isExact: true,
        exact: c.latitude.toFixed(5) + '°N, ' + c.longitude.toFixed(5) + '°E',
        accuracy_m: Math.round(c.accuracy || 0),
      });
      try { saveUserLocation(AppState.userLocation); } catch (_) {}
      renderFormLocationMap(key);
      updateFormLocationReadouts();
      showToast('Location updated', 'success');
    },
    function () { showToast('Could not get a fresh fix — using last known location.', 'warning'); },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
  );
}

window.renderFormLocationMap = renderFormLocationMap;
window.startFormLocationWatch = startFormLocationWatch;
window.stopFormLocationWatch = stopFormLocationWatch;
window.refreshFormLocation = refreshFormLocation;
window.updateFormLocationReadouts = updateFormLocationReadouts;

// ──────────────────────────────────────────────────────────────
//  AI EMERGENCY HELPLINE  (spoken two-way conversation)
//  ------------------------------------------------------------
//  STT (browser) -> POST {AI_API_BASE}/helpline/turn -> the reply is
//  spoken back with the browser's speech synthesiser. The backend
//  picks the LLM (local Ollama -> free Groq/Gemini -> scripted) and
//  returns a live, deterministic severity/priority each turn. When the
//  backend is unreachable a local script + keyword severity keeps it
//  working offline. On completion an incident is filed (which also
//  starts live GPS sharing with responders).
// ──────────────────────────────────────────────────────────────
const HELPLINE_SCRIPT_JS = {
  english: [
    'Kavach emergency helpline. Please tell me what has happened.',
    'How many people are with you right now?',
    'Is anyone injured or unwell?',
    'Is anyone trapped or unable to reach safety?',
    'What is your location or a nearby landmark?',
    'A response team is being dispatched to your location. Please stay safe and keep your phone with you.',
  ],
  hindi: [
    'कवच आपातकालीन हेल्पलाइन। कृपया बताइए क्या हुआ है।',
    'इस समय आपके साथ कितने लोग हैं?',
    'क्या कोई घायल या बीमार है?',
    'क्या कोई फँसा हुआ है?',
    'आपका स्थान या पास की कोई पहचान बताइए।',
    'एक राहत टीम आपके स्थान पर भेजी जा रही है। कृपया सुरक्षित रहें और फ़ोन अपने पास रखें।',
  ],
  hinglish: [
    'Kavach emergency helpline. Kripya bataiye kya hua hai.',
    'Is samay aapke saath kitne log hain?',
    'Kya koi ghayal ya bimaar hai?',
    'Kya koi phansa hua hai?',
    'Aapki location ya paas ki koi pehchaan bataiye.',
    'Ek response team aapki location par bheji ja rahi hai. Kripya safe rahein aur phone paas rakhein.',
  ],
};

const HelplineState = { active: false, phase: 'idle', history: [], lang: 'english',
  facts: {}, priority: 'LOW', score: 0, transcript: '', description: '', sessionId: null,
  // Set when the BACKEND files the geo-tagged incident itself, so
  // helplineFinish() doesn't file a duplicate.
  filedIncidentId: null };
let _hlRec = null;        // persistent SpeechRecognition instance
let _hlRecBusy = false;   // true while a recognition session is running
let _hlFinal = '';

function _helplineEl(id) { return document.getElementById(id); }
function _speechLangCode(lang) { return lang === 'hindi' ? 'hi-IN' : 'en-IN'; }
function _hlT(hi, en) { return HelplineState.lang === 'hindi' ? hi : en; }
function _helplineStatus(txt) { const el = _helplineEl('helpline-status'); if (el) el.textContent = txt || ''; }
function _hlWave(on) { const w = _helplineEl('helpline-wave'); if (w) w.classList.toggle('active', !!on); }

function _hlMicBtn(mode) {
  const b = _helplineEl('helpline-mic-btn');
  if (!b) return;
  b.classList.toggle('listening', mode === 'listening');
  b.disabled = mode === 'speaking' || mode === 'processing' || mode === 'done';
  b.textContent =
    mode === 'listening' ? '🎙️ ' + _hlT('सुन रहा है… (रोकने के लिए दबाएँ)', 'Listening… (tap to stop)')
    : mode === 'processing' ? '⏳ ' + _hlT('प्रोसेस हो रहा है', 'Processing')
    : mode === 'speaking' ? '🔊 ' + _hlT('अधिकारी बोल रहा है', 'Officer speaking')
    : mode === 'done' ? '✔ ' + _hlT('कॉल पूरी हुई', 'Call complete')
    : '🎤 ' + _hlT('बोलने के लिए दबाएँ', 'Tap to speak');
}

// Low-level TTS with an explicit language code (used by the language menu).
function _speakRaw(text, langCode, onDone) {
  if (!('speechSynthesis' in window)) { if (onDone) setTimeout(onDone, 500); return; }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = langCode || 'en-IN';
  const voices = window.speechSynthesis.getVoices() || [];
  const v = voices.find((x) => x.lang === u.lang) ||
            voices.find((x) => x.lang && x.lang.startsWith((u.lang || 'en').slice(0, 2)));
  if (v) u.voice = v;
  u.rate = 0.97;
  u.onend = () => onDone && onDone();
  u.onerror = () => onDone && onDone();
  try { window.speechSynthesis.cancel(); window.speechSynthesis.speak(u); }
  catch (_) { if (onDone) onDone(); }
}

function helplineSpeak(text, onDone) {
  const box = _helplineEl('helpline-agent-line');
  if (box) box.textContent = text;
  // stop the mic so the recogniser doesn't hear the officer
  try { _hlRec && _hlRec.abort(); } catch (_) {}
  _hlRecBusy = false;
  _hlMicBtn('speaking');
  _helplineStatus(_hlT('🔊 अधिकारी बोल रहा है…', '🔊 Officer speaking…'));
  _speakRaw(text, _speechLangCode(HelplineState.lang), () => {
    // small gap before re-opening the mic avoids Chrome start() races
    setTimeout(() => onDone && onDone(), 280);
  });
}

// Build (once) and return the recognition instance.
function _hlEnsureRec() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  if (_hlRec) return _hlRec;
  const rec = new SR();
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.continuous = false;
  _hlRec = rec;
  return rec;
}

function _hlShowTextInput() {
  const inp = _helplineEl('helpline-text');
  if (inp) inp.style.display = 'flex';
}

// Start one listening session. `auto` = re-armed automatically after the
// officer spoke; false = the citizen tapped the mic button.
function helplineListen(auto) {
  if (!HelplineState.active || HelplineState.phase !== 'talking') return;
  const rec = _hlEnsureRec();
  if (!rec) { _hlShowTextInput(); _helplineStatus(_hlT('माइक उपलब्ध नहीं — नीचे टाइप करें', 'Mic unavailable — type below')); return; }
  if (_hlRecBusy) return;

  rec.lang = _speechLangCode(HelplineState.lang);
  _hlFinal = '';
  _hlRecBusy = true;
  _hlWave(true);
  _hlMicBtn('listening');
  _helplineStatus(_hlT('🎤 सुन रहा है… अभी बोलिए', '🎤 Listening… speak now'));

  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) _hlFinal += t + ' ';
      else interim += t;
    }
    const you = _helplineEl('helpline-you-line');
    if (you) you.textContent = (_hlFinal + interim).trim();
  };
  rec.onerror = (ev) => {
    _hlRecBusy = false; _hlWave(false);
    const err = ev && ev.error;
    if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture') {
      _helplineStatus(_hlT('माइक की अनुमति नहीं — कृपया नीचे टाइप करें', 'Microphone blocked — please type below'));
      _hlShowTextInput();
      _hlMicBtn('idle');
    } else if (err === 'no-speech') {
      _helplineStatus(_hlT('सुनाई नहीं दिया — दोबारा दबाकर बोलिए', "Didn't catch that — tap the mic and try again"));
      _hlMicBtn('idle');
    } else {
      _hlMicBtn('idle');
    }
  };
  rec.onend = () => {
    _hlRecBusy = false; _hlWave(false);
    if (!HelplineState.active) return;
    const text = _hlFinal.trim();
    if (text) {
      _hlMicBtn('processing');
      _helplineStatus(_hlT('⏳ प्रोसेस हो रहा है…', '⏳ Processing…'));
      helplineSubmit(text);
    } else {
      // heard nothing: on an auto re-arm, retry ONCE; otherwise wait for a tap
      _hlMicBtn('idle');
      if (auto && !HelplineState._retried) {
        HelplineState._retried = true;
        setTimeout(() => helplineListen(true), 350);
      } else {
        HelplineState._retried = false;
        _helplineStatus(_hlT('माइक बटन दबाकर बोलिए', 'Tap the mic button to speak'));
      }
    }
  };
  try { rec.start(); }
  catch (_) { _hlRecBusy = false; setTimeout(() => helplineListen(auto), 350); }
}
window.helplineListen = helplineListen;

// Citizen tapped the big mic button.
function helplineMicTap() {
  if (HelplineState.phase !== 'talking') return;
  if (_hlRecBusy) { try { _hlRec.stop(); } catch (_) {} return; }
  HelplineState._retried = false;
  helplineListen(false);
}
window.helplineMicTap = helplineMicTap;

// Mid-call language switch.
function helplineSetLang(lang) {
  HelplineState.lang = (lang === 'hindi') ? 'hindi' : 'english';
  document.querySelectorAll('.hl-lang-opt').forEach((b) => b.classList.toggle('active', b.dataset.lang === HelplineState.lang));
  const menu = _helplineEl('helpline-langmenu');
  if (menu && menu.style.display !== 'none') {
    menu.style.display = 'none';
    document.removeEventListener('keydown', _hlLangKey);
    _helplineBeginConversation();
  } else {
    _hlMicBtn('idle');
  }
}
window.helplineSetLang = helplineSetLang;

function _hlLangKey(e) {
  if (e.key === '1') helplineSetLang('hindi');
  else if (e.key === '2') helplineSetLang('english');
}

function _helplineBeginConversation() {
  HelplineState.phase = 'talking';
  HelplineState._retried = false;
  const greeting = (HELPLINE_SCRIPT_JS[HelplineState.lang] || HELPLINE_SCRIPT_JS.english)[0];
  HelplineState.history.push({ role: 'assistant', text: greeting });
  _renderHelplineLog();
  helplineSpeak(greeting, () => helplineListen(true));
}

async function helplineSubmit(userText) {
  HelplineState.history.push({ role: 'user', text: userText });
  _renderHelplineLog();

  const base = (window.RESQNET_AI_API_BASE || '').replace(/\/+$/, '');
  let data = null;
  if (base) {
    try {
      const res = await fetch(`${base}/helpline/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: HelplineState.lang,
          history: HelplineState.history.slice(0, -1),
          user_text: userText,
          // Live caller context. When the conversation completes the
          // backend files a fully GEO-TAGGED emergency report from the
          // call itself — coordinates, district and everything the
          // analyzer extracted from the whole transcript.
          session_id: HelplineState.sessionId || null,
          latitude: Number(AppState.userLocation?.lat) || null,
          longitude: Number(AppState.userLocation?.lng) || null,
          state: (typeof kavachUserArea === 'function' ? kavachUserArea().state : null) || null,
          district: (typeof kavachUserArea === 'function' ? kavachUserArea().district : null) || null,
          caller_name: (AppState.currentUser && AppState.currentUser.name) || null,
          caller_mobile: (AppState.currentUser && AppState.currentUser.mobile) || null,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        data = await res.json();
        // The backend files the geo-tagged report itself on the final
        // turn — record it so we don't create a second incident.
        if (data && data.incident_filed && data.incident_id) {
          HelplineState.filedIncidentId = data.incident_id;
        }
      }
    } catch (e) {
      console.warn('[helpline] backend turn failed, using local script', e.message);
    }
  }

  if (!data) {
    // Offline fallback: fixed script + local keyword severity.
    const asked = HelplineState.history.filter((t) => t.role === 'assistant').length;
    const lines = HELPLINE_SCRIPT_JS[HelplineState.lang] || HELPLINE_SCRIPT_JS.english;
    const allUser = HelplineState.history.filter((t) => t.role === 'user').map((t) => t.text).join(' ').toLowerCase();
    const local = _localTriage(allUser);
    data = {
      reply: lines[Math.min(asked, lines.length - 1)],
      priority: { level: local.priority, score: local.score },
      facts: local.facts,
      transcript: allUser,
      description: local.description,
      done: HelplineState.history.filter((t) => t.role === 'user').length >= 5,
      provider: 'local-AI',
    };
  }

  HelplineState.history.push({ role: 'assistant', text: data.reply });

  // ---- severity: never UNDER-triage -------------------------------
  // The backend's regex extractor is English-leaning and scores e.g.
  // "8 log phanse hain" as LOW. The on-device analyzer understands
  // Devanagari + Hinglish, so take whichever assessment is HIGHER.
  // Under-triaging a real emergency is the one failure mode that is
  // never acceptable here.
  const _allSaid = HelplineState.history
    .filter((t) => t.role === 'user').map((t) => t.text).join(' ');
  let _local = null;
  try { _local = _localTriage(_allSaid); } catch (_) {}

  const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
  const beLevel = (data.priority && data.priority.level) || 'LOW';
  const beScore = (data.priority && typeof data.priority.score === 'number')
    ? data.priority.score : 0;
  const loLevel = (_local && _local.priority) || 'LOW';
  const loScore = (_local && _local.score) || 0;

  HelplineState.priority = (RANK[loLevel] > RANK[beLevel]) ? loLevel : beLevel;
  HelplineState.score = Math.max(beScore, loScore);

  // Merge facts too — keep whichever side actually found something.
  const bf = data.facts || {};
  const lf = (_local && _local.facts) || {};
  HelplineState.facts = {
    needs: (bf.needs && bf.needs.length) ? bf.needs : (lf.needs || []),
    people_count: bf.people_count != null ? bf.people_count : (lf.people_count ?? null),
    injured: bf.injured || lf.injured || null,
    trapped: bf.trapped || lf.trapped || null,
    injury_count: bf.injury_count || lf.injury_count || 0,
    vulnerable_people: (bf.vulnerable_people && bf.vulnerable_people.length)
      ? bf.vulnerable_people : (lf.vulnerable_people || []),
    environmental_conditions: (bf.environmental_conditions && bf.environmental_conditions.length)
      ? bf.environmental_conditions : (lf.environmental_conditions || []),
  };
  // Description always comes from an analyzer (backend, or the local
  // one) over the WHOLE transcript — never a hand-written stub.
  HelplineState.transcript = data.transcript || HelplineState.transcript || '';
  HelplineState.description = data.description
    || (_local && _local.description)
    || HelplineState.description;
  _renderHelplineLog();
  _renderHelplineSeverity(data.provider);

  HelplineState._retried = false;
  helplineSpeak(data.reply, () => {
    if (data.done) helplineFinish();
    else helplineListen(true);
  });
}

// ──────────────────────────────────────────────────────────────
//  LOCAL TRIAGE ANALYZER  (on-device mirror of the backend)
//  ------------------------------------------------------------
//  Turns everything the caller has said into structured facts, a
//  human-readable DESCRIPTION and a real severity score — in
//  Devanagari Hindi, Hinglish and English.
//
//  The previous version only matched English/Hinglish, so a caller
//  speaking Hindi ("मैं फँस गया हूँ") scored 0 and every call showed
//  LOW. Tiering mirrors the backend's priority.py exactly:
//  trapped OR injured => CRITICAL, regardless of headcount, with a
//  graded magnitude score on top.
// ──────────────────────────────────────────────────────────────

// Hindi number words -> digits (spoken counts are rarely numerals).
const HI_NUMBERS = {
  'ek': 1, 'एक': 1, 'do': 2, 'दो': 2, 'teen': 3, 'तीन': 3, 'char': 4, 'चार': 4,
  'paanch': 5, 'panch': 5, 'पांच': 5, 'पाँच': 5, 'chah': 6, 'chhah': 6, 'छह': 6,
  'saat': 7, 'सात': 7, 'aath': 8, 'आठ': 8, 'nau': 9, 'नौ': 9, 'das': 10, 'दस': 10,
  'gyarah': 11, 'ग्यारह': 11, 'barah': 12, 'बारह': 12, 'pandrah': 15, 'पंद्रह': 15,
  'bees': 20, 'बीस': 20, 'pachas': 50, 'पचास': 50, 'sau': 100, 'सौ': 100,
};

const TRIAGE_PATTERNS = {
  trapped: /\b(trap|trapped|stuck|phans|phanse|phasa|fase|dabe|daba|band ho|locked|buried|malbe|rubble)\b|फँस|फंस|दब[ीेा]|मलबे|अंदर बंद/i,
  injured: /\b(injur|injured|hurt|wound|bleed|bleeding|fracture|ghayal|khoon|blood|unconscious|behosh|behoshi)\b|घायल|चोट|खून|फ्रैक्चर|बेहोश|बेहोशी|लहूलुहान/i,
  medical: /\b(medical|doctor|ambulance|hospital|dawa|dawai|bimar|beemar|saans|breath|heart|attack|pregnan|delivery)\b|डॉक्टर|एम्बुलेंस|अस्पताल|दवा|बीमार|साँस|सांस|दिल का दौरा|गर्भवती|प्रसव/i,
  // Strong flood evidence — unambiguous.
  floodStrong: /\b(flood|flooded|flooding|baadh|badh|doob|doobe|drown|waterlog|waterlogged|jalbharav)\b|बाढ़|डूब|जलभराव|बह गय|पानी भर/i,
  // Weak: a bare mention of water — also how someone asks for
  // DRINKING water. Only counts as flooding when that sense is absent.
  floodWeak: /\b(water|paani|pani)\b|पानी/i,
  fire: /\b(fire|aag|jal raha|jalra|smoke|dhuan|dhuaan|burn)\b|आग|धुआँ|धुआं|जल रह|जलन/i,
  earthquake: /\b(earthquake|bhukamp|tremor|hil raha)\b|भूकंप|भूकम्प|हिल रह/i,
  collapse: /\b(collapse|gir gaya|girgaya|building fell|makan gir|dhah)\b|गिर गय|ढह|इमारत गिर/i,
  food: /\b(food|khana|khaana|bhookh|bhukh|hungry|ration)\b|खाना|भूख|राशन/i,
  water_need: /\b(drinking water|peene ka pani|peene ka paani|thirsty|pyaas)\b|पीने का पानी|प्यास/i,
  shelter: /\b(shelter|ghar|makan|rehne|homeless|chhat|roof)\b|आश्रय|घर|मकान|रहने|छत|बेघर/i,
  evacuation: /\b(evacuat|nikal|nikalo|rescue us|bahar|escape|safe place)\b|निकाल|बाहर निकल|सुरक्षित जगह/i,
  rescue: /\b(rescue|bachao|bacha|help|madad|sos|save)\b|बचाओ|बचाइए|मदद|सहायता/i,
  elderly: /\b(elderly|old|budhe|buzurg|budha|grandmother|grandfather|dadi|dada|nana|nani)\b|बुज़ुर्ग|बुजुर्ग|बूढ़|दादी|दादा|नानी/i,
  child: /\b(child|children|baby|bacche|baccha|bachcha|infant|newborn)\b|बच्च|शिशु|नवजात/i,
  pregnant: /\b(pregnan|garbhvati|garbhwati)\b|गर्भवती|प्रेग्नेंट/i,
  disabled: /\b(disabled|handicap|viklang|apahij|wheelchair)\b|विकलांग|अपाहिज|व्हीलचेयर/i,
};

// Headcount for the GROUP, from digits or Hindi/Hinglish number words.
//
// A sentence often carries several numbers ("चार लोग हैं और दो घायल हैं").
// A number sitting next to a people-word is the group size, so those win;
// otherwise take the largest plausible number rather than the first one
// encountered, which previously turned "4 people, 2 injured" into 2.
const PEOPLE_WORD = '(?:log|logo|logon|people|persons?|aadmi|admi|vyakti|jan|लोग|लोगों|व्यक्ति|आदमी|जन)';

function _triageCount(text) {
  const t = String(text || '');

  // 1. digits directly beside a people-word — either order.
  const near = t.match(new RegExp('(\\d{1,3})\\s*' + PEOPLE_WORD, 'i'))
            || t.match(new RegExp(PEOPLE_WORD + '\\s*(\\d{1,3})', 'i'));
  if (near) {
    const n = parseInt(near[1], 10);
    if (n > 0 && n < 1000) return n;
  }

  // 2. a number WORD beside a people-word.
  for (const [word, n] of Object.entries(HI_NUMBERS)) {
    if (new RegExp('(?:^|\\s)' + word + '\\s*' + PEOPLE_WORD, 'i').test(t)) return n;
  }

  // 3. fall back to the largest number mentioned anywhere.
  const candidates = [];
  for (const m of t.matchAll(/\b(\d{1,3})\b/g)) {
    const n = parseInt(m[1], 10);
    if (n > 0 && n < 1000) candidates.push(n);
  }
  for (const [word, n] of Object.entries(HI_NUMBERS)) {
    if (new RegExp('(?:^|\\s)' + word + '(?=\\s|$|,|।)', 'i').test(t)) candidates.push(n);
  }
  return candidates.length ? Math.max(...candidates) : null;
}

// Full local analysis: facts + description + graded severity.
function _localTriage(text) {
  const t = String(text || '');
  const P = TRIAGE_PATTERNS;

  const needs = [];
  const push = (n) => { if (!needs.includes(n)) needs.push(n); };

  const trapped = P.trapped.test(t) || null;
  const injured = P.injured.test(t) || null;
  const people = _triageCount(t);

  // "पीने का पानी" is a relief request, not a flood — a bare water
  // mention only counts as flooding when the drinking sense is absent.
  const wantsDrinkingWater = P.water_need.test(t);
  const isFlood = P.floodStrong.test(t) || (P.floodWeak.test(t) && !wantsDrinkingWater);

  if (trapped || P.rescue.test(t) || P.collapse.test(t)) push('rescue');
  if (injured || P.medical.test(t)) push('medical');
  if (isFlood || P.fire.test(t) || P.earthquake.test(t)) push('rescue');
  if (P.evacuation.test(t)) push('evacuation');
  if (P.food.test(t)) push('food');
  if (P.water_need.test(t)) push('water');
  if (P.shelter.test(t)) push('shelter');

  const vulnerable = [];
  if (P.elderly.test(t)) vulnerable.push('elderly');
  if (P.child.test(t)) vulnerable.push('child');
  if (P.pregnant.test(t)) vulnerable.push('pregnant');
  if (P.disabled.test(t)) vulnerable.push('disabled');

  const env = [];
  if (isFlood) env.push('flooding');
  if (P.fire.test(t)) env.push('fire');
  if (P.earthquake.test(t)) env.push('earthquake');

  const facts = {
    needs,
    people_count: people,
    injured,
    trapped,
    injury_count: injured ? (people || 1) : 0,
    vulnerable_people: vulnerable,
    environmental_conditions: env,
  };

  // ---- graded magnitude, mirroring the backend's priority.py ----
  const headcount = people || 1;
  const sat = (n, ref) => (n <= 1 ? 0 : Math.min(1, Math.log1p(n - 1) / Math.log1p(ref - 1)));

  let score = 0;
  if (trapped) score += 30 + 16 * sat(headcount, 20);
  else if (needs.includes('rescue')) score += 18;

  if (injured) score += 26 + 14 * sat(headcount, 15);
  else if (needs.includes('medical')) score += 20;

  if (headcount > 1) score += 10 * sat(headcount, 25);
  if (headcount >= 10) score += 8;
  if (vulnerable.length) score += 9;
  if (env.length) score += 7;
  if (!trapped && !injured && (needs.includes('food') || needs.includes('water') || needs.includes('shelter'))) {
    score += 16;
  }
  score = Math.min(100, Math.round(score));

  // Tier from the FACTS, exactly like the backend.
  let priority;
  if (trapped || injured) priority = 'CRITICAL';
  else if (needs.includes('medical') || needs.includes('rescue')) priority = 'HIGH';
  else if (vulnerable.length && env.length) priority = 'HIGH';
  else if (needs.length || env.length) priority = 'MEDIUM';
  else priority = 'LOW';

  return { facts, priority, score, description: _triageDescription(facts, t) };
}

// Builds the incident DESCRIPTION the control room reads, from what
// the caller actually said.
function _triageDescription(facts, transcript) {
  const bits = [];
  const n = facts.people_count || 1;

  if (facts.trapped) bits.push(n > 1 ? `${n} people trapped` : 'caller trapped');
  if (facts.injured) bits.push(n > 1 ? `${n} people injured` : 'injury reported');
  if (!facts.trapped && !facts.injured && n > 1) bits.push(`${n} people affected`);

  if (facts.environmental_conditions.length) {
    bits.push(facts.environmental_conditions.join(', '));
  }
  if (facts.needs.length) bits.push('needs ' + facts.needs.join(', '));
  if (facts.vulnerable_people.length) {
    bits.push('vulnerable: ' + facts.vulnerable_people.join(', '));
  }

  const said = String(transcript || '').trim().replace(/\s+/g, ' ').slice(0, 220);
  const head = bits.length ? bits.join('; ') : 'assistance requested';
  return `AI helpline call — ${head}.` + (said ? ` Caller said: "${said}"` : '');
}

function _renderHelplineLog() {
  const log = _helplineEl('helpline-log');
  if (!log) return;
  const A = _hlT('अधिकारी', 'Officer'), Y = _hlT('आप', 'You');
  log.innerHTML = HelplineState.history.map((t) =>
    `<div class="hl-turn ${t.role}"><b>${t.role === 'assistant' ? '🤖 ' + A : '🧑 ' + Y}:</b> ${escapeHtml(t.text)}</div>`
  ).join('');
  log.scrollTop = log.scrollHeight;
}

function _renderHelplineSeverity(provider) {
  const el = _helplineEl('helpline-severity');
  if (!el) return;
  const p = HelplineState.priority || 'LOW';
  const sc = (typeof HelplineState.score === 'number') ? ` ${HelplineState.score}/100` : '';
  el.textContent = _hlT('लाइव गंभीरता: ', 'Live severity: ') + p + sc +
    (provider ? `  ·  ${provider}` : '');
  el.className = 'helpline-sev ' + p.toLowerCase();
}

function startAIHelpline() {
  HelplineState.sessionId = 'HL-' + Date.now();
  HelplineState.filedIncidentId = null;
  HelplineState.active = true;
  HelplineState.phase = 'lang';
  HelplineState.history = [];
  HelplineState.facts = {};
  HelplineState.priority = 'LOW';
  HelplineState._retried = false;
  // default guess; the caller picks explicitly on the menu
  HelplineState.lang = (AppState.uiLang === 'hindi' || (AppState.currentUser && AppState.currentUser.lang === 'hindi')) ? 'hindi' : 'english';

  const panel = _helplineEl('helpline-panel');
  if (panel) panel.style.display = 'block';
  const hint = _helplineEl('ivr-idle-hint');
  if (hint) hint.style.display = 'none';
  const startBtn = _helplineEl('ivr-start-btn');
  if (startBtn) { startBtn.textContent = '● ' + _hlT('कॉल जारी है', 'Call in progress'); startBtn.disabled = true; }
  const hangup = _helplineEl('helpline-hangup-bar');
  if (hangup) hangup.style.display = 'block';
  _renderHelplineLog();
  _renderHelplineSeverity();
  _hlMicBtn('idle');

  // Language menu first: "press 1 for Hindi, press 2 for English".
  const menu = _helplineEl('helpline-langmenu');
  if (menu) menu.style.display = 'block';
  const line = _helplineEl('helpline-agent-line');
  if (line) line.textContent = 'हिंदी के लिए 1 दबाएँ  ·  Press 2 for English';
  _helplineStatus('');
  document.addEventListener('keydown', _hlLangKey);
  _speakRaw('हिंदी के लिए एक दबाइए। Press two for English.', 'hi-IN');
}
window.startAIHelpline = startAIHelpline;

function helplineSubmitText() {
  const inp = _helplineEl('helpline-text-input');
  if (!inp || !inp.value.trim()) return;
  const v = inp.value.trim();
  inp.value = '';
  helplineSubmit(v);
}
window.helplineSubmitText = helplineSubmitText;

async function helplineFinish() {
  HelplineState.phase = 'done';
  try { _hlRec && _hlRec.abort(); } catch (_) {}
  _hlMicBtn('done');
  const f = HelplineState.facts || {};
  const req = createRequest('HELPLINE', {
    needs: f.needs || [],
    people: f.people_count || 1,
    injured: !!f.injured,
    trapped: !!f.trapped,
    injuredCount: f.injury_count || (f.injured ? (f.people_count || 1) : 0),
    trappedCount: f.trapped ? (f.people_count || 1) : 0,
    priority: HelplineState.priority,
  });
  // The description the control room reads is generated by the
  // analyzer from the WHOLE call, not a canned string.
  req.type = 'HELPLINE_CALL';
  req.description = HelplineState.description || '';
  req.transcript = HelplineState.transcript || '';
  req.severityScore = HelplineState.score || 0;
  MockDB.requests.push(req);
  localStorage.setItem('kavach_requests', JSON.stringify(MockDB.requests));

  if (HelplineState.filedIncidentId) {
    // The backend already filed a fully geo-tagged incident from the
    // call (coordinates + district + everything the analyzer extracted
    // from the transcript). Just adopt its id and start GPS sharing.
    req.id = HelplineState.filedIncidentId;
    localStorage.setItem('kavach_requests', JSON.stringify(MockDB.requests));
    rememberMyIncident(req.id);
    try { startCallerLocationShare(req.id, req); } catch (_) {}
  } else {
    await pushRequestToCommandCentre(req);   // also starts live GPS sharing
  }

  const closing = (HELPLINE_SCRIPT_JS[HelplineState.lang] || HELPLINE_SCRIPT_JS.english)[5];
  helplineSpeak(closing);
  if (typeof showToast === 'function') {
    showToast(`Helpline call logged — ${req.id} (${HelplineState.priority})`, 'success');
  }
}

function endAIHelpline() {
  HelplineState.active = false;
  HelplineState.phase = 'idle';
  try { _hlRec && _hlRec.abort(); } catch (_) {}
  _hlRecBusy = false;
  document.removeEventListener('keydown', _hlLangKey);
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (_) {}
  const panel = _helplineEl('helpline-panel');
  if (panel) panel.style.display = 'none';
  const menu = _helplineEl('helpline-langmenu');
  if (menu) menu.style.display = 'none';
  const hint = _helplineEl('ivr-idle-hint');
  if (hint) hint.style.display = 'block';
  const startBtn = _helplineEl('ivr-start-btn');
  if (startBtn) { startBtn.textContent = (KAVACH_I18N[AppState.uiLang] || {})['ivr.start'] || '☎ START CALL'; startBtn.disabled = false; }
  const hangup = _helplineEl('helpline-hangup-bar');
  if (hangup) hangup.style.display = 'none';
  _helplineStatus('');
  stopCallerLocationShare();
}
window.endAIHelpline = endAIHelpline;

// Preload speech-synthesis voices (they load async on first use).
if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
}

// ──────────────────────────────────────────────────────────────
//  DEMO CONTROLS
// ──────────────────────────────────────────────────────────────
function loadFloodScenario() {
  // Set severe weather data
  MockDB.weatherData.forEach(w => {
    if (['Bhubaneswar','Cuttack','Puri','Jagatsinghpur'].includes(w.city)) {
      w.severity = 'severe';
      w.rainfall = Math.max(w.rainfall, 90);
      w.condition = 'Very Heavy Rain';
      w.icon = '⛈️';
    }
  });

  // Update banner
  setText('banner-title', '⛈️ Severe Flood Warning — RED Alert');
  setText('banner-sub', 'Multiple districts affected. Evacuation advised for low-lying areas.');

  // Auto-login demo user
  if (!AppState.currentUser) {
    AppState.currentUser = MockDB.users[0];
    localStorage.setItem('kavach_user', JSON.stringify(AppState.currentUser));
  }

  // Pre-load requests
  const floodReq = createRequest('DEMO', {
    needs: ['rescue','medical','shelter'],
    people: 8,
    injured: true,
    trapped: true,
  });
  MockDB.requests.push(floodReq);
  localStorage.setItem('kavach_requests', JSON.stringify(MockDB.requests));

  renderSimulatedMap();
  showScreen('dashboard');
  updateDashboard();
  showToast('🌊 Flood scenario loaded! Dashboard updated with severe alert.', 'warning');
}

function resetDemo() {
  localStorage.removeItem('kavach_user');
  localStorage.removeItem('kavach_requests');
  AppState.currentUser = null;
  AppState.currentRequestId = null;
  MockDB.requests = [];
  smsInitialized = false;

  // Reset weather data
  MockDB.weatherData.forEach((w, i) => {
    const orig = [
      { severity: 'high',     rainfall: 82, condition: 'Heavy Rain',      icon: '🌧️' },
      { severity: 'severe',   rainfall: 95, condition: 'Very Heavy Rain',  icon: '⛈️' },
      { severity: 'severe',   rainfall: 67, condition: 'Cyclonic Rain',    icon: '🌀' },
      { severity: 'high',     rainfall: 58, condition: 'Moderate Rain',    icon: '🌧️' },
      { severity: 'severe',   rainfall: 72, condition: 'Heavy Rain',       icon: '⛈️' },
      { severity: 'moderate', rainfall: 44, condition: 'Light Rain',       icon: '🌦️' },
      { severity: 'low',      rainfall: 22, condition: 'Partly Cloudy',    icon: '⛅' },
      { severity: 'low',      rainfall: 18, condition: 'Clear',            icon: '🌤️' },
    ];
    if (orig[i]) { w.severity = orig[i].severity; w.rainfall = orig[i].rainfall; w.condition = orig[i].condition; w.icon = orig[i].icon; }
  });

  AppState.ivrState.active = false;
  clearInterval(AppState.ivrState.timer);

  goHome();
  showToast('Demo reset complete.', 'success');
}

// ──────────────────────────────────────────────────────────────
//  TOAST SYSTEM
// ──────────────────────────────────────────────────────────────
function showToast(message, type = '') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.classList.add('toast');
  if (type) toast.classList.add(type);
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3200);
}

// ──────────────────────────────────────────────────────────────
//  GOOGLE MAPS (optional)
// ──────────────────────────────────────────────────────────────
function onGoogleMapsReady() {
  AppState.googleMapLoaded = true;

  if (AppState.currentScreen === 'dashboard') {
    initGoogleMap();
  }
}

function initGoogleMap() {
  if (!AppState.googleMapLoaded || !window.google) return;

  const { lat, lng } = AppState.userLocation;
  const mapEl = document.getElementById('map-canvas');
  if (!mapEl) return;

  // FIX: Google Maps throws "Expected value to be of type number, but
  // found null instead" if center.lat/lng are null (e.g. called before
  // geolocation has resolved). Bail out gracefully and let the next
  // updateLocationUI() call retry once real coordinates exist.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  // Remove fallback
  const fallback = document.getElementById('map-fallback');
  if (fallback) fallback.style.display = 'none';

  AppState.googleMap = new google.maps.Map(mapEl, {
    center: { lat, lng },
    zoom: 9,
    mapTypeId: 'roadmap',
    disableDefaultUI: true,
    zoomControl: true,
    styles: [{featureType:'poi',stylers:[{visibility:'off'}]}],
  });

  // User marker
  new google.maps.Marker({
    position: { lat, lng },
    map: AppState.googleMap,
    title: 'Your Location',
    icon: { url: 'http://maps.google.com/mapfiles/ms/icons/blue-dot.png' },
  });

  // FIX: filter out any weather entries without finite coordinates before
  // building the heatmap / markers, so a bad entry can't throw here either.
  const validWeather = Array.isArray(MockDB.weatherData)
    ? MockDB.weatherData.filter(w => Number.isFinite(w.lat) && Number.isFinite(w.lng))
    : [];

  // Weather markers + heatmap
  if (google.maps.visualization) {
    const heatmapData = validWeather.map(w => ({
      location: new google.maps.LatLng(w.lat, w.lng),
      weight: w.severity === 'severe' ? 4 : w.severity === 'high' ? 3 : w.severity === 'moderate' ? 2 : 1,
    }));

    new google.maps.visualization.HeatmapLayer({
      data: heatmapData,
      radius: 60,
      opacity: 0.7,
      map: AppState.googleMap,
    });
  }

  // City markers with info windows
  validWeather.forEach(w => {
    const marker = new google.maps.Marker({
      position: { lat: w.lat, lng: w.lng },
      map: AppState.googleMap,
      title: w.city,
    });

    const iw = new google.maps.InfoWindow({
      content: `<div style="font-family:Inter;padding:8px;min-width:150px;">
        <strong style="font-size:14px;">${w.city}</strong>
        <div style="font-size:12px;color:#666;margin:4px 0;">${w.icon} ${w.condition}</div>
        <div style="font-size:12px;">🌧 ${w.rainfall}mm &nbsp; 🌡 ${w.temp}°C</div>
        <div style="font-size:12px;">💨 ${w.wind}km/h &nbsp; 💧 ${w.humidity}%</div>
        <div style="margin-top:6px;font-weight:700;color:${sevColor(w.severity)};">${w.severity.toUpperCase()}</div>
      </div>`,
    });

    marker.addListener('click', () => iw.open(AppState.googleMap, marker));
  });
}

// ──────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────
function setText(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function escapeHtml(text) {
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function getTime() {
  const now = new Date();
  let h = now.getHours(), ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const m = now.getMinutes().toString().padStart(2,'0');
  return `${h}:${m} ${ampm}`;
}

window.AppState = AppState;
window.MockDB = MockDB;
window.AZURE_MAPS_KEY = AZURE_MAPS_KEY;
window.AZURE_WEATHER_URL = AZURE_WEATHER_URL;

// Expose app methods for inline HTML handlers
window.initializeApp = initializeApp;
window.openApp = openApp;
window.openKavach = openKavach;
window.showScreen = showScreen;
window.goHome = goHome;
window.loginUser = loginUser;
window.registerUser = registerUser;
window.demoLogin = demoLogin;
window.detectLocation = detectLocation;
window.updateStatusTime = updateStatusTime;
window.updateHomeClock = updateHomeClock;
window.updateGreeting = updateGreeting;
window.showToast = showToast;
window.showWeatherDetail = showWeatherDetail;
window.closeModal = closeModal;
window.fetchSACHETAlerts = fetchSACHETAlerts;
window.fetchRealWeatherData = fetchRealWeatherData;
window.submitEmergencyRequest = submitEmergencyRequest;
window.openEmergencyForm = openEmergencyForm;
window.resetDemo = resetDemo;
window.loadFloodScenario = loadFloodScenario;
window.toggleNeed = toggleNeed;
window.setInjured = setInjured;
window.setTrapped = setTrapped;
window.emgNextStep = emgNextStep;
window.changeCount = changeCount;
window.showRequestTracking = showRequestTracking;
window.requestUserLocation = requestUserLocation;
window.refreshUserLocation = refreshUserLocation;
window.initAzureWeatherMap = initAzureWeatherMap;
window.searchMapLocation = searchMapLocation;
window.renderOfficialAlertZones = renderOfficialAlertZones;
// SACHET broadcast → citizen response exports
window.triggerEmergencyBroadcast  = triggerEmergencyBroadcast;
window.selectBroadcastSeverity    = selectBroadcastSeverity;
window.openBroadcastSMSConvo      = openBroadcastSMSConvo;
window.openCitizenRegister        = openCitizenRegister;
window.submitCitizenReport        = submitCitizenReport;
window.setCitizenStatus           = setCitizenStatus;
window.setCitizenInjured          = setCitizenInjured;
window.setCitizenTrapped          = setCitizenTrapped;
window.toggleCitizenNeed          = toggleCitizenNeed;
window.renderCitizenReportsPanel  = renderCitizenReportsPanel;

function safeInitializeApp() {
  try {
    initializeApp();
  } catch (error) {
    console.error('[Kavach] Initialization failed:', error);
    window.__kavachInitError = String(error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', safeInitializeApp);
} else {
  safeInitializeApp();
}

// ══════════════════════════════════════════════════════════════
//  LIVE WEATHER — AZURE MAPS WEATHER API
// ══════════════════════════════════════════════════════════════

function sevColor(sev) {
  return { low:'#43A047', moderate:'#F9A825', high:'#E65100', severe:'#C62828' }[sev] || '#999';
}

async function fetchRealWeatherData() {
  try {
    const place = AppState.userLocation && Number.isFinite(AppState.userLocation.lat) && Number.isFinite(AppState.userLocation.lng)
      ? AppState.userLocation
      : { lat: 20.2961, lng: 85.8245, name: 'Bhubaneswar, Odisha' };

    await fetchExactWeatherForLocation(place.lat, place.lng, place.name || 'Current location');
    AppState.weatherLoaded = true;
    AppState.weatherSource = 'Live - Azure';
    updateWeatherCardUI();
    updateDataSourceBadges();
    showToast('🌤 Live weather updated from Azure Maps', 'success');
  } catch (err) {
    console.warn('[Azure Weather]', err.message);
    AppState.weatherLoaded = false;
    AppState.weatherSource = 'Azure unavailable';
    updateDataSourceBadges();
  }
}

async function fetchExactWeatherForLocation(lat, lng, label = 'Current location') {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('Location coordinates are not available');
  }

  const url = `${AZURE_WEATHER_URL}?api-version=1.1&query=${lat},${lng}&subscription-key=${AZURE_MAPS_KEY}`;
  const res = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) {
    throw new Error('HTTP ' + res.status);
  }

  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  const current = results[0] || data?.currentConditions?.[0] || data || {};

  // Read only the fields Azure actually returned. Do NOT invent fallback
  // numbers (e.g. 25°C, 70% humidity, 0mm precip) — a missing field must
  // stay missing (null) so the UI can show "N/A" instead of a fake value.
  const rawTemp = current.temperature && current.temperature.value !== undefined
    ? current.temperature.value
    : (current.tempC ?? current.temperature);
  const rawPrecip = current.precipitation && current.precipitation.value !== undefined
    ? current.precipitation.value
    : (current.precipitationProbability ?? current.rainProbability ?? current.precipitation);
  const rawWind = current.wind && current.wind.speed && current.wind.speed.value !== undefined
    ? current.wind.speed.value
    : current.windSpeed;
  const rawHumidity = current.relativeHumidity ?? current.humidity;
  const rawObsTime = current.dateTime || current.observationTime || null;

  const condition = current.weatherText || current.phrase || current.conditionText || null;
  const temp        = numOrNull(rawTemp);
  const precipitation = numOrNull(rawPrecip);
  const wind         = numOrNull(rawWind);
  const humidity     = numOrNull(rawHumidity);

  // Internal (non-official) heuristic — used ONLY as a fallback badge color
  // when no official SACHET/IMD alert covers this location. This must never
  // be presented to the user as an official red/orange/yellow warning.
  const info = azureToInfo(temp, precipitation, condition);

  // If NDMA/IMD (via SACHET) has an active alert covering this location,
  // that official zone takes priority over the Azure-only heuristic —
  // the badge should show what SACHET/IMD says is the real hazard zone.
  const officialZone = findOfficialZoneForLocation(lat, lng, label);
  const zoneIcons = { severe: '🔴', high: '🟠', moderate: '🟡', low: '🟢' };
  const severity  = officialZone ? officialZone.severity  : info.severity;
  const zoneCondition = officialZone ? officialZone.event : (condition || info.condition);
  const zoneIcon  = officialZone ? (zoneIcons[severity] || info.icon) : info.icon;

  const locationEntry = {
    id: 'current-location',
    city: label.split(',')[0].trim() || 'Current location',
    lat,
    lng,
    rainfall: precipitation === null ? null : Number(precipitation.toFixed(1)),
    temp: temp === null ? null : Math.round(temp),
    wind: wind === null ? null : Math.round(wind),
    humidity: humidity === null ? null : Math.round(humidity),
    observedAt: rawObsTime,
    condition: zoneCondition || 'Condition unavailable',
    severity: severity,
    icon: zoneIcon,
    color: sevColor(severity),
    isLive: true,
    // isOfficial distinguishes a real SACHET/IMD warning from our own
    // internal Azure-based heuristic, so the UI never presents an
    // arbitrary-threshold estimate as an official alert.
    isOfficial: !!officialZone,
    zoneSource: officialZone ? 'SACHET/IMD' : 'Azure (unofficial estimate)',
    zoneSender: officialZone ? officialZone.sender : 'Azure Maps Weather'
  };

  // FIX: guard against MockDB.weatherData being missing (shouldn't happen
  // now that it's always seeded, but keeps this function self-contained).
  if (!Array.isArray(MockDB.weatherData)) MockDB.weatherData = [];
  const idx = MockDB.weatherData.findIndex(w => w.id === 'current-location');
  if (idx >= 0) {
    MockDB.weatherData[idx] = { ...MockDB.weatherData[idx], ...locationEntry };
  } else {
    MockDB.weatherData.unshift(locationEntry);
  }

  const bannerTitle = document.getElementById('banner-title');
  if (bannerTitle) bannerTitle.textContent = `Current conditions in ${locationEntry.city}`;

  const bannerSub = document.getElementById('banner-sub');
  if (bannerSub) bannerSub.textContent = `${locationEntry.city} is being refreshed from live Azure weather data.`;

  const weatherCardName = document.getElementById('wc-location-name');
  if (weatherCardName) weatherCardName.textContent = locationEntry.city;

  const weatherCondition = document.getElementById('wc-condition');
  if (weatherCondition) weatherCondition.textContent = locationEntry.condition;

  const weatherRain = document.getElementById('wc-rainfall');
  if (weatherRain) weatherRain.textContent = locationEntry.rainfall === null ? 'N/A' : `${locationEntry.rainfall} mm`;

  const weatherTemp = document.getElementById('wc-temp');
  if (weatherTemp) weatherTemp.textContent = locationEntry.temp === null ? 'N/A' : `${locationEntry.temp}°C`;

  const weatherWind = document.getElementById('wc-wind');
  if (weatherWind) weatherWind.textContent = locationEntry.wind === null ? 'N/A' : `${locationEntry.wind} km/h`;

  const weatherHumidity = document.getElementById('wc-humidity');
  if (weatherHumidity) weatherHumidity.textContent = locationEntry.humidity === null ? 'N/A' : `${locationEntry.humidity}%`;

  const weatherIcon = document.getElementById('wc-icon');
  if (weatherIcon) weatherIcon.textContent = locationEntry.icon;

  const weatherBadge = document.getElementById('wc-severity');
  if (weatherBadge) {
    weatherBadge.textContent = (locationEntry.severity || 'LOW').toUpperCase();
    weatherBadge.className = 'wc-badge ' + (locationEntry.severity || 'low');
    weatherBadge.title = `Zone source: ${locationEntry.zoneSource} (${locationEntry.zoneSender})`;
  }

  const dashLoc = document.getElementById('dash-location');
  if (dashLoc) dashLoc.textContent = label;

  return locationEntry;
}

// Converts a raw value to a Number, or null if it is missing/not finite.
// Used so that a field Azure did not return stays null (displayed as
// "N/A") instead of silently becoming 0 or some other fake number.
function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Internal, non-official heuristic used only to color the badge when no
// SACHET/IMD alert applies. temp/precip may be null if Azure did not
// return them — treated as 0 for this heuristic only, never displayed.
function azureToInfo(temp, precip, condition) {
  const text = (condition || '').toLowerCase();
  const t = temp === null ? 0 : temp;
  const p = precip === null ? 0 : precip;
  if (text.includes('storm') || text.includes('thunder') || text.includes('heavy rain') || p >= 45 || t >= 38) {
    return { severity: 'severe', condition: text.includes('storm') ? 'Severe Thunderstorm' : 'Extreme Rainfall', icon: '⛈️' };
  }
  if (text.includes('rain') || text.includes('cloud') || text.includes('fog') || p >= 20 || t >= 34) {
    return { severity: 'high', condition: text.includes('cloud') ? 'Cloudy with Rain' : (text.includes('fog') ? 'Foggy Conditions' : 'Heavy Rain'), icon: '🌧️' };
  }
  if (text.includes('wind') || p >= 8 || t >= 30) {
    return { severity: 'moderate', condition: 'Moderate Weather', icon: '🌦️' };
  }
  return { severity: 'low', condition: condition || 'Clear Conditions', icon: '☀️' };
}

// Map SACHET/CAP severity vocabulary (extreme/severe/moderate/minor — i.e.
// red/orange/yellow/green) onto the app's own weather-card severity scale
// (severe/high/moderate/low) so both systems use one shared zone value.
function sachetSeverityToZone(sachetSeverity) {
  return {
    extreme:  'severe',
    severe:   'high',
    moderate: 'moderate',
    minor:    'low',
  }[sachetSeverity] || null;
}

// Look through the live, currently-ACTIVE SACHET/NDMA alerts for one that
// geographically covers this exact location, and return its zone in the
// app's severity scale. Matching priority (per the official CAP data):
//   1. polygon  — real point-in-polygon check against the exact coordinates
//   2. circle   — distance from the exact coordinates to the circle center
//   3. geocode / district-state text — matched against the alert's areaDesc
// Text-only matching against areaDesc is used only as a last resort, and
// only against the location's own name — never invented boundaries.
// Returns null if SACHET has nothing loaded, nothing is active, or nothing
// matches this location.
function findOfficialZoneForLocation(lat, lng, locationName) {
  if (!AppState.sachetAlerts || !AppState.sachetAlerts.length) return null;

  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  const cityPart = (locationName || '').split(',')[0].trim().toLowerCase();

  const activeAlerts = AppState.sachetAlerts.filter(isAlertActive);

  const match = activeAlerts.find(a => {
    // 1. Polygon — exact point-in-polygon test.
    if (hasCoords && a.polygon && a.polygon.length >= 3) {
      return pointInPolygon(lat, lng, a.polygon);
    }
    return false;
  }) || activeAlerts.find(a => {
    // 2. Circle — distance from the point to the circle center.
    if (hasCoords && a.circle) {
      return haversineKm(lat, lng, a.circle.lat, a.circle.lng) <= a.circle.radiusKm;
    }
    return false;
  }) || activeAlerts.find(a => {
    // 3. Fallback: district/state or free-text area description matching
    // against the location's own name. We never invent geographic
    // boundaries here — this is purely a text containment check.
    if (!cityPart) return false;
    const area = (a.areaDesc || '').toLowerCase();
    return area.includes(cityPart) || (area && cityPart.includes(area));
  });

  if (!match) return null;

  const severity = sachetSeverityToZone(match.severity);
  if (!severity) return null;

  return {
    severity,                                   // low | moderate | high | severe
    event: match.event || match.title || 'Weather Alert',
    sender: match.sender || 'IMD / NDMA (SACHET)',
    alert: match,
  };
}

// Called once fresh SACHET alerts arrive — re-checks the live "current
// location" weather entry against them and refreshes the UI if an official
// zone now applies (this covers the case where the Azure fetch resolved
// before the SACHET feed did).
function refreshCurrentLocationZone() {
  const idx = Array.isArray(MockDB.weatherData) ? MockDB.weatherData.findIndex(w => w.id === 'current-location') : -1;
  if (idx < 0) return;

  const entry = MockDB.weatherData[idx];
  const officialZone = findOfficialZoneForLocation(entry.lat, entry.lng, entry.city);

  if (!officialZone) {
    // No official zone (any more) covers this point — if we were
    // previously showing one, fall back to the non-official Azure
    // heuristic rather than leaving a stale official badge in place.
    if (entry.isOfficial) {
      const info = azureToInfo(entry.temp, entry.rainfall, entry.condition);
      entry.severity   = info.severity;
      entry.condition  = info.condition;
      entry.icon       = info.icon;
      entry.color      = sevColor(info.severity);
      entry.isOfficial = false;
      entry.zoneSource = 'Azure (unofficial estimate)';
      entry.zoneSender = 'Azure Maps Weather';
      updateWeatherCardUI();
      if (AppState.currentScreen === 'dashboard') updateDashboard();
    }
    return;
  }
  if (entry.isOfficial && entry.severity === officialZone.severity) return;

  const zoneIcons = { severe: '🔴', high: '🟠', moderate: '🟡', low: '🟢' };
  entry.severity   = officialZone.severity;
  entry.condition  = officialZone.event;
  entry.icon       = zoneIcons[officialZone.severity] || entry.icon;
  entry.color      = sevColor(officialZone.severity);
  entry.isOfficial = true;
  entry.zoneSource = 'SACHET/IMD';
  entry.zoneSender = officialZone.sender;

  updateWeatherCardUI();
  if (AppState.currentScreen === 'dashboard') updateDashboard();
  renderOfficialAlertZones();
}

function updateDataSourceBadges() {
  const live = AppState.weatherSource && AppState.weatherSource.includes('Live');
  const badge = document.getElementById('data-source-badge');
  const wlbl = document.getElementById('weather-source-label');
  if (badge) {
    badge.textContent = live ? '● LIVE — Azure' : '⚠ AZURE UNAVAILABLE';
    badge.className = 'data-source-badge' + (live ? ' live' : '');
  }
  if (wlbl) {
    wlbl.textContent = live ? '● LIVE — Azure' : '⚠ Azure unavailable';
    wlbl.className = 'data-source-badge' + (live ? ' live' : '');
  }
}

function updateWeatherCardUI() {
  // FIX: bail out early instead of throwing "Cannot read properties of
  // undefined (reading 'find')" when MockDB.weatherData isn't ready yet.
  if (!Array.isArray(MockDB.weatherData) || !MockDB.weatherData.length) return;

  const exactLocationName = AppState.userLocation && AppState.userLocation.name ? AppState.userLocation.name : ((AppState.currentUser && AppState.currentUser.location) || 'Bhubaneswar, Odisha');
  const city = exactLocationName.split(',')[0].trim();
  const liveExact = MockDB.weatherData.find(d => d.id === 'current-location');
  const w = liveExact && liveExact.city === city
    ? liveExact
    : MockDB.weatherData.find(d => d.city === city) || liveExact || MockDB.weatherData[0];

  if (!w) return;

  const setEl = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  const fmt = (v, unit) => (v === null || v === undefined) ? 'N/A' : `${v}${unit}`;
  // Label the card with the district from the profile. Reverse
  // geocoding sometimes returns only a state ("Odisha"), which is what
  // made this card flip back to the wrong place.
  setEl('wc-location-name', kavachDisplayCity() || w.city || city);
  setEl('wc-condition',     w.condition || 'Current conditions');
  setEl('wc-rainfall',      fmt(w.rainfall, ' mm'));
  setEl('wc-temp',          fmt(w.temp, '°C'));
  setEl('wc-wind',          fmt(w.wind, ' km/h'));
  setEl('wc-humidity',      fmt(w.humidity, '%'));

  const iconEl = document.getElementById('wc-icon');
  if (iconEl) iconEl.textContent = w.icon || '🌤️';

  const sevEl = document.getElementById('wc-severity');
  if (sevEl) {
    const severity = w.severity || 'low';
    const labels = { low:'LOW', moderate:'MODERATE', high:'HIGH', severe:'SEVERE' };
    sevEl.textContent = labels[severity] || severity.toUpperCase();
    sevEl.className   = 'wc-badge ' + severity;
  }
}

function renderAzureWeatherZones() {
  if (!window.azureMapInstance || typeof window.azureMapInstance.markers === 'undefined') return;
  // FIX: this previously called MockDB.weatherData.map(...) directly,
  // which threw when weatherData was undefined. Now guarded, and entries
  // without finite coordinates are filtered out before building markers.
  if (!Array.isArray(MockDB.weatherData)) return;

  const map = window.azureMapInstance;
  if (map.markers && map.markers.clear) {
    map.markers.clear();
  }

  const markers = MockDB.weatherData
    .filter(w => Number.isFinite(w.lat) && Number.isFinite(w.lng))
    .map((w) => {
      const color = sevColor(w.severity || 'low');
      const html = `
        <div style="
          padding: 5px 8px; border-radius: 999px; border: 2px solid rgba(255,255,255,0.9);
          background: ${color}; color: #fff; font-size: 10px; font-weight: 700; line-height: 1;
          box-shadow: 0 6px 18px rgba(15,23,42,0.18); white-space: nowrap; min-width: 26px; text-align: center;
        ">${w.icon || '•'}</div>
      `;
      return new atlas.HtmlMarker({ position: [w.lng, w.lat], html });
    });

  markers.forEach(marker => map.markers.add(marker));
  window.azureWeatherMarkers = markers;
}

// ── LIVE WEATHER RADAR (Azure raster tiles) ─────────────────────
// This is visually distinct from, and rendered independently of, the
// official disaster/warning polygons below. Radar tiles show current
// precipitation/weather imagery; they are never used to draw or infer
// an official alert zone.
// ── MAP OVERLAY SWITCHER ────────────────────────────────────────
// Both overlays already existed but had no control, so a citizen had
// no way to clear the rain imagery to read the alert polygons under
// it (or the reverse). Choice is remembered per device.
const KAVACH_LAYER_STATE = { weather: true, sachet: true };

function kavachLoadLayerState() {
  try {
    const raw = localStorage.getItem('kavach_map_layers');
    if (raw) Object.assign(KAVACH_LAYER_STATE, JSON.parse(raw));
  } catch (_) {}
  ['weather', 'sachet'].forEach((k) => {
    const box = document.getElementById('kv-layer-' + k);
    if (box) box.checked = !!KAVACH_LAYER_STATE[k];
  });
  applyKavachLayerState();
}

function applyKavachLayerState() {
  const vis = (on) => (on ? 'visible' : 'none');
  try {
    if (window.azureRadarLayer) {
      window.azureRadarLayer.setOptions({ visible: !!KAVACH_LAYER_STATE.weather });
    }
  } catch (_) {}
  try {
    if (window.azureAlertLayer) {
      window.azureAlertLayer.setOptions({ visible: !!KAVACH_LAYER_STATE.sachet });
    }
  } catch (_) {}
  // Alert-zone centre pins belong to the SACHET overlay.
  try {
    (window.__kavachAlertPins || []).forEach((m) => {
      const el = m.getOptions && m.getOptions().htmlContent;
      const node = (m.getElement && m.getElement()) || null;
      if (node) node.style.display = KAVACH_LAYER_STATE.sachet ? '' : 'none';
    });
  } catch (_) {}
  void vis;
}

function kavachSetLayer(name, on) {
  KAVACH_LAYER_STATE[name] = !!on;
  try { localStorage.setItem('kavach_map_layers', JSON.stringify(KAVACH_LAYER_STATE)); } catch (_) {}
  applyKavachLayerState();
}
window.kavachSetLayer = kavachSetLayer;
window.applyKavachLayerState = applyKavachLayerState;
window.kavachLoadLayerState = kavachLoadLayerState;

function initAzureRadarLayer(map) {
  if (window.azureRadarLayer) return;
  try {
    const radarLayer = new atlas.layer.TileLayer({
      tileUrl: `https://atlas.microsoft.com/map/tile?api-version=2.0&tilesetId=microsoft.weather.radar.main&zoom={z}&x={x}&y={y}&subscription-key=${AZURE_MAPS_KEY}`,
      opacity: 0.75,
      tileSize: 256,
    }, 'azure-weather-radar');
    map.layers.add(radarLayer);
    window.azureRadarLayer = radarLayer;
  } catch (err) {
    console.warn('[Azure Radar]', err.message);
  }
}

// ── OFFICIAL DISASTER / WARNING ZONES (SACHET / IMD polygons) ───
// Separate DataSource + PolygonLayer, drawn from official CAP alert
// geometry only (never from the radar imagery, never invented).
function renderOfficialAlertZones() {
  const map = window.azureMapInstance;
  if (!map || !window.atlas) return;
  // Normally the map's 'ready' event gates this (adding a source
  // earlier throws). If 'ready' is just slow we still try — wrapped in
  // try/catch — so the polygons appear as soon as the map can take them.
  try {
    _renderOfficialAlertZonesImpl(map);
  } catch (err) {
    if (window.__kavachMapReady) console.warn('[SACHET] alert-zone render failed:', err && err.message);
  }
}

function _renderOfficialAlertZonesImpl(map) {
  if (!window.azureAlertSource) {
    window.azureAlertSource = new atlas.source.DataSource('official-alert-zones');
    map.sources.add(window.azureAlertSource);

    const zoneFillColors = { severe: 'rgba(198,40,40,0.35)', high: 'rgba(230,81,0,0.30)', moderate: 'rgba(249,168,37,0.28)', low: 'rgba(67,160,71,0.22)' };
    const zoneStrokeColors = { severe: '#C62828', high: '#E65100', moderate: '#F9A825', low: '#43A047' };

    window.azureAlertLayer = new atlas.layer.PolygonLayer(window.azureAlertSource, 'official-alert-zones-layer', {
      fillColor: ['match', ['get', 'zone'],
        'severe', zoneFillColors.severe,
        'high',   zoneFillColors.high,
        'moderate', zoneFillColors.moderate,
        'low', zoneFillColors.low,
        'rgba(120,120,120,0.2)'],
      fillOpacity: ['case', ['get', 'mine'], 0.42, 0.12],
      strokeColor: ['match', ['get', 'zone'],
        'severe', zoneStrokeColors.severe,
        'high',   zoneStrokeColors.high,
        'moderate', zoneStrokeColors.moderate,
        'low', zoneStrokeColors.low,
        '#777'],
      strokeWidth: ['case', ['get', 'mine'], 3.5, 1.4],
    });
    // Alert polygons render above the radar imagery but below the
    // HtmlMarkers (markers are DOM elements and always sit on top).
    map.layers.add(window.azureAlertLayer);

    map.events.add('click', window.azureAlertLayer, (e) => {
      if (!e.shapes || !e.shapes.length) return;
      const props = e.shapes[0].getProperties();
      showOfficialAlertPopup(props, e.position);
    });
  }

  try { applyKavachLayerState(); } catch (_) {}

  window.azureAlertSource.clear();

  // Draw every active CAP polygon so the map is never empty; the
  // citizen's own area is bold, the rest faint. (The alert LIST below
  // the map stays scoped to the citizen's city.)
  const activeAlerts = (AppState.sachetAlerts || [])
    .filter(isAlertActive)
    .filter(a => a.polygon && a.polygon.length >= 3);
  activeAlerts.forEach(a => {
    const ring = a.polygon.map(([lat, lng]) => [lng, lat]); // atlas expects [lng,lat]
    // Close the ring if needed
    const first = ring[0], last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    let mine = true;
    try { mine = alertTouchesKavachArea(a); } catch (_) {}

    window.azureAlertSource.add(new atlas.data.Feature(new atlas.data.Polygon([ring]), {
      mine,
      zone: sachetSeverityToZone(a.severity) || 'low',
      event: a.event || a.title || 'Weather Alert',
      severityLabel: severityLabel(a.severity),
      areaDesc: a.areaDesc || '',
      sender: a.sender || 'IMD / NDMA',
      effective: a.effective || a.onset || '',
      expires: a.expires || '',
      headline: a.headline || '',
      instruction: a.instruction || '',
    }));
  });
}

function showOfficialAlertPopup(props, position) {
  const map = window.azureMapInstance;
  if (!map) return;
  if (!window.azureAlertPopup) {
    window.azureAlertPopup = new atlas.Popup();
  }
  const sourceLabel = /ndma|sachet/i.test(props.sender || '') ? 'SACHET / NDMA' : (/imd/i.test(props.sender || '') ? 'IMD' : (props.sender || 'Official source'));
  const html = `
    <div style="font-family:Inter,sans-serif;padding:10px;max-width:240px;">
      <div style="font-weight:700;font-size:13px;margin-bottom:4px;">${escapeHtml(props.event || 'Weather Alert')}</div>
      <div style="font-size:11px;color:#666;margin-bottom:6px;">Severity: <strong>${escapeHtml(props.severityLabel || '')}</strong></div>
      ${props.headline ? `<div style="font-size:11px;margin-bottom:6px;">${escapeHtml(props.headline)}</div>` : ''}
      <div style="font-size:11px;margin-bottom:6px;">Affected area: ${escapeHtml(props.areaDesc || 'N/A')}</div>
      ${props.instruction ? `<div style="font-size:11px;margin-bottom:6px;"><em>${escapeHtml(props.instruction)}</em></div>` : ''}
      <div style="font-size:10px;color:#888;">Effective: ${escapeHtml(props.effective || 'N/A')}</div>
      <div style="font-size:10px;color:#888;margin-bottom:6px;">Expires: ${escapeHtml(props.expires || 'N/A')}</div>
      <div style="font-size:10px;font-weight:700;color:#1565C0;">Source: ${escapeHtml(sourceLabel)}</div>
    </div>
  `;
  window.azureAlertPopup.setOptions({ content: html, position });
  window.azureAlertPopup.open(map);
}

function initAzureWeatherMap() {
  if (!window.atlas || !document.getElementById('azureMap')) return;
  if (window.azureMapInstance) {
    renderAzureWeatherZones();
    renderOfficialAlertZones();
    return;
  }

  const mapEl = document.getElementById('azureMap');
  const map = new atlas.Map(mapEl, {
    center: [78.9629, 22.5937],
    zoom: 4.5,
    pitch: 0,
    bearing: 0,
    style: 'road_shaded_relief',
    // Render India's official international boundaries (J&K, Ladakh,
    // Arunachal Pradesh) as per the Government of India.
    view: 'IN',
    authOptions: {
      authType: 'subscriptionKey',
      subscriptionKey: AZURE_MAPS_KEY
    }
  });

  window.azureMapInstance = map;

  // If the map auth / tiles fail (bad key, referrer restriction,
  // offline) the citizen must still get the SACHET alert cards +
  // notifications. Surface a clear note instead of a dead grey box.
  map.events.add('error', (e) => {
    console.warn('[Kavach] Azure Maps error', e && e.error);
    const badge = document.getElementById('azureWeatherStatus');
    if (badge) { badge.textContent = '● MAP OFFLINE'; badge.classList.remove('live'); }
    const fb = document.getElementById('map-fallback');
    if (fb && !document.getElementById('map-offline-note')) {
      const n = document.createElement('div');
      n.id = 'map-offline-note';
      n.style.cssText = 'position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:16px;background:#eef2f8;color:#64748b;font-size:12px;border-radius:12px;';
      n.innerHTML = '🗺️ Live map unavailable right now.<br>Official alerts for your area are still shown below.';
      fb.appendChild(n);
    }
  });

  // Safety net: if 'ready' never fires within 8s, still try to draw the
  // alert polygons (source/layer add can succeed without tiles).
  setTimeout(() => {
    if (!window.__kavachMapReady) {
      try { renderOfficialAlertZones(); } catch (_) {}
    }
  }, 8000);

  map.events.add('ready', () => {
    window.__kavachMapReady = true;
    const note = document.getElementById('map-offline-note');
    if (note) note.remove();
    // Layer order: 1. Azure basemap (already rendered by the map itself)
    // 2. Azure weather radar  3. official disaster/warning polygons
    // 4. existing incident/resource HtmlMarkers (always render on top).
    initAzureRadarLayer(map);
    renderOfficialAlertZones();
    try { kavachLoadLayerState(); } catch (_) {}
    renderAzureWeatherZones();

    // Centre + LOCK the map on the citizen's registered city. If we
    // don't have a geocode yet, run it now from the saved district.
    const loc = AppState.userLocation || {};
    if (Number.isFinite(Number(loc.lat)) || _kavachCityBounds) {
      kavachLockMapToCity();
    } else {
      let d = '', s = '';
      try { d = localStorage.getItem('kavach_district') || ''; s = localStorage.getItem('kavach_state') || ''; } catch (_) {}
      if (d) kavachApplyLocation(s, d);
      else {
        const dc = (Array.isArray(MockDB.weatherData) && (MockDB.weatherData.find(w => w.city === 'Bhubaneswar') || MockDB.weatherData[0])) || null;
        if (dc && Number.isFinite(dc.lat)) map.setCamera({ center: [dc.lng, dc.lat], zoom: 6 });
      }
    }
  });
}

async function searchMapLocation() {
  const input = document.getElementById('map-search-input');
  const query = (input ? input.value : '').trim();
  if (!query) {
    showToast('Enter a location name to search', 'warning');
    return;
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!response.ok) throw new Error('Location lookup failed');
    const results = await response.json();
    if (!results || !results.length) {
      showToast('No location found for that search in India.', 'warning');
      return;
    }

    const item = results[0];
    const lat = Number(item.lat);
    const lon = Number(item.lon);
    const cityName = (item.display_name || query).split(',')[0].trim() || query;

    // 1 & 2. Move the map camera to the searched location.
    if (window.azureMapInstance && window.azureMapInstance.setCamera) {
      window.azureMapInstance.setCamera({ center: [lon, lat], zoom: 7, pitch: 0, bearing: 0 });
    }

    if (window.azureMapInstance && window.azureMapInstance.markers) {
      if (window.mapSearchMarker) {
        try { window.azureMapInstance.markers.remove(window.mapSearchMarker); } catch (error) {}
      }
      window.mapSearchMarker = new atlas.HtmlMarker({
        position: [lon, lat],
        html: '<div style="padding:6px 10px;border-radius:999px;background:#1565C0;border:2px solid rgba(255,255,255,0.9);color:#fff;font-size:11px;font-weight:700;box-shadow:0 6px 18px rgba(0,0,0,0.18);">📍</div>'
      });
      window.azureMapInstance.markers.add(window.mapSearchMarker);
    }

    // 3-7. updateLocationUI() updates AppState.userLocation, saves it,
    // fetches Azure weather for these exact coordinates, updates the
    // weather UI, and (via refreshCurrentLocationZone) checks official
    // disaster alerts for the same coordinates — the single shared flow
    // used everywhere a location changes.
    await updateLocationUI(lat, lon, cityName, true);
    if (AppState.currentScreen === 'dashboard') updateDashboard();

    showToast(`Showing weather for ${cityName}`, 'success');
  } catch (error) {
    console.warn('[Map Search]', error);
    showToast('Unable to search that location right now.', 'error');
  }
}

// ══════════════════════════════════════════════════════════════
//  SACHET NDMA ALERTS — RSS + CAP XML
// ══════════════════════════════════════════════════════════════

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
  return ({ extreme:'EXTREME', severe:'SEVERE', moderate:'MODERATE', minor:'MINOR', unknown:'UNKNOWN' })[key] || (key || '').toUpperCase();
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

// FIX: the primary CORS proxy (allorigins.win) was timing out ("signal
// timed out") in the console. This helper tries a proxy and, if it fails
// or times out, falls back to a second proxy before giving up — and the
// per-request timeout is bumped from 12s to 20s to tolerate a slow proxy.
async function fetchViaCorsProxy(targetUrl, timeoutMs = 20000) {
  const attempts = [];

  // 1. Dedicated Worker proxy — rewrite the SACHET origin onto it and
  //    call it directly (it already sends CORS + the right headers).
  if (SACHET_PROXY && targetUrl.startsWith(SACHET_ORIGIN)) {
    attempts.push(SACHET_PROXY + targetUrl.slice(SACHET_ORIGIN.length));
  }

  // 2. Public CORS proxies (URL-encoded query style).
  for (const p of [CORS_PROXY, CORS_PROXY_FALLBACK, ...CORS_PROXIES_EXTRA]) {
    attempts.push(p + encodeURIComponent(targetUrl));
  }

  let lastErr = null;
  for (const url of attempts) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue; }
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All SACHET proxies failed');
}

async function fetchSACHETAlerts() {
  const panel = document.getElementById('sachet-alerts-panel');
  const btn   = document.getElementById('sachet-refresh-btn');
  if (btn) btn.textContent = '⏳ Loading…';
  if (panel) panel.innerHTML = '<div class="sachet-loading">⏳ Fetching from SACHET NDMA...</div>';

  try {
    const res = await fetchViaCorsProxy(SACHET_RSS);

    const text   = await res.text();
    const parser = new DOMParser();
    const xml    = parser.parseFromString(text, 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('XML parse error');

    const items = Array.from(xml.querySelectorAll('item')).slice(0, 16);
    if (!items.length) throw new Error('Empty RSS');

    const liveAlerts = items.map(item => {
      const title   = (item.querySelector('title')?.textContent || '').trim();
      const link    = (item.querySelector('link')?.textContent  || '').trim();
      const pubDate = (item.querySelector('pubDate')?.textContent || '').trim();
      const desc    = (item.querySelector('description')?.textContent || '').trim();
      return {
        title, link, pubDate,
        severity: normSeverity(title + ' ' + desc),
        event:    title,
        areaDesc: desc.substring(0, 150) || 'India',
        sender:   'IMD / NDMA',
        capLoaded: false,
      };
    });
    AppState.sachetAlerts = liveAlerts;

    // CAP detail carries the <polygon>. Prioritise alerts that name /
    // cover the citizen's area (so THEIR zone always gets a polygon),
    // then top up to 10 total. Best-effort, parallel.
    const areaFirst = liveAlerts.filter(a => { try { return alertTouchesKavachArea(a); } catch (_) { return false; } });
    const rest = liveAlerts.filter(a => !areaFirst.includes(a));
    const capTargets = [...areaFirst, ...rest].slice(0, 10);
    await Promise.allSettled(capTargets.map(loadCAPDetail));

    // Merge in any still-valid authority broadcasts (survive reloads).
    mergePersistedBroadcastAlerts();

    AppState.sachetUnavailable = false;
    renderSACHETPanel(false);
    updateHomeAlertFromSACHET();
    refreshCurrentLocationZone();
    renderOfficialAlertZones();
    notifyNewAreaAlerts();
    if (btn) btn.textContent = '🔄 Refresh';

  } catch (err) {
    console.warn('[SACHET] fetch failed:', err.message);

    // SACHET/NDMA is unavailable. Do NOT fall back to MockDB.alerts and
    // present demo data as if it were a real, current official warning —
    // that would fabricate an official alert. Instead, clear live alerts
    // and show a clear "unavailable" state — but authority broadcasts
    // pushed straight from RESQNET are still real and must survive.
    AppState.sachetAlerts = [];
    mergePersistedBroadcastAlerts();
    AppState.sachetUnavailable = AppState.sachetAlerts.length === 0;

    renderSACHETPanel(AppState.sachetUnavailable);
    renderOfficialAlertZones();
    updateHomeAlertFromSACHET();
    refreshCurrentLocationZone();
    if (btn) btn.textContent = AppState.sachetUnavailable ? '🔄 Retry' : '🔄 Refresh';
  }
}

async function loadCAPDetail(alert) {
  if (!alert.link || alert.link === '#') return;
  try {
    const res  = await fetchViaCorsProxy(alert.link, 12000);
    const text = await res.text();
    const cap  = new DOMParser().parseFromString(text, 'application/xml');
    if (cap.querySelector('parsererror')) return;

    const g = tag => (cap.querySelector(tag)?.textContent || '').trim();

    if (g('event'))      alert.event    = g('event');
    if (g('severity'))   alert.severity = normSeverity(g('severity'));
    if (g('urgency'))    alert.urgency  = g('urgency');
    if (g('areaDesc'))   alert.areaDesc = g('areaDesc');
    if (g('effective'))  alert.effective = g('effective');
    if (g('onset'))      alert.onset    = g('onset');
    if (g('expires'))    alert.expires  = g('expires');
    if (g('headline'))   alert.headline = g('headline');
    if (g('description'))alert.desc     = g('description');
    if (g('instruction'))alert.instruction = g('instruction');
    if (g('senderName')) alert.sender   = g('senderName');

    // Geographic info from the CAP <area> block — used for real
    // point-in-polygon / point-in-circle location matching instead of
    // relying only on areaDesc text matching.
    const polygonText = g('polygon');
    if (polygonText) {
      alert.polygon = parseCapPolygon(polygonText);
    }
    const circleText = g('circle');
    if (circleText) {
      alert.circle = parseCapCircle(circleText);
    }
    const geocodeEl = cap.querySelector('geocode value');
    if (geocodeEl && geocodeEl.textContent) {
      alert.geocode = geocodeEl.textContent.trim();
    }

    alert.capLoaded = true;

  } catch (_) { /* keep existing */ }
}

// CAP <polygon> is a space-separated list of "lat,lon" pairs. Returns an
// array of [lat, lng] points, or null if it can't be parsed. We never
// invent coordinates — a malformed or empty polygon yields null.
function parseCapPolygon(text) {
  try {
    const points = text.trim().split(/\s+/).map(pair => {
      const [latStr, lngStr] = pair.split(',');
      const lat = Number(latStr), lng = Number(lngStr);
      return (Number.isFinite(lat) && Number.isFinite(lng)) ? [lat, lng] : null;
    }).filter(Boolean);
    return points.length >= 3 ? points : null;
  } catch (_) {
    return null;
  }
}

// CAP <circle> is "lat,lon radiusKm". Returns {lat,lng,radiusKm} or null.
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

// Standard ray-casting point-in-polygon test on [lat,lng] pairs.
function pointInPolygon(lat, lng, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = polygon[i][0], xi = polygon[i][1];
    const yj = polygon[j][0], xj = polygon[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Haversine distance in km between two lat/lng points.
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// True if a CAP alert is currently active, based on its effective/onset
// and expires timestamps. An alert with no expires is treated as active
// (SACHET does not always populate it); an alert whose expires has
// already passed is excluded so expired zones never show as active.
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

// The citizen only cares about alerts for the location they signed in
// with. An alert is shown if:
//   • no location is known yet (show everything), OR
//   • the user's GPS point falls inside the alert polygon / circle, OR
//   • the alert's area text names the user's district or state.
function kavachUserArea() {
  const u = AppState.currentUser || {};
  let district = u.district || '';
  let state = u.state || '';
  try {
    district = district || localStorage.getItem('kavach_district') || '';
    state = state || localStorage.getItem('kavach_state') || '';
  } catch (_) {}
  const loc = AppState.userLocation || {};
  const lat = Number(loc.lat), lng = Number(loc.lng);
  return {
    district: district.trim(),
    state: state.trim(),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}

function _kvNorm(s) {
  return String(s || '').toLowerCase().replace(/\s+(nagar|district|dist\.?|rural|urban)\b/g, '').trim();
}

// True only if the alert / broadcast genuinely covers the citizen's
// registered city. A Kanpur broadcast must not show for a Bhubaneswar
// citizen — even when it arrives over the same-browser bridge.
function alertTouchesKavachArea(alert) {
  const area = kavachUserArea();
  const isBc = alert && alert.source === 'BROADCAST';

  // Nothing to scope against → show everything.
  if (!area.district && !area.state && area.lat == null) return true;

  const hasGeom = (Array.isArray(alert.polygon) && alert.polygon.length >= 3) || !!alert.circle;

  // Precise geometry test.
  if (area.lat != null && area.lng != null && hasGeom) {
    if (Array.isArray(alert.polygon) && alert.polygon.length >= 3 &&
        pointInPolygon(area.lat, area.lng, alert.polygon)) return true;
    if (alert.circle &&
        haversineKm(area.lat, area.lng, alert.circle.lat, alert.circle.lng) <= alert.circle.radiusKm) return true;
  }

  // Name test (fuzzy — "Kanpur" vs "Kanpur Nagar").
  const hay = _kvNorm(`${alert.areaDesc || ''} ${alert.headline || ''} ${alert.description || ''} ${alert.event || ''} ${alert.title || ''}`);
  const d = _kvNorm(area.district);
  if (d && hay && (hay.includes(d) || d.includes(_kvNorm(alert.areaDesc || alert.district || '')))) return true;
  if (area.state && !area.district && hay.includes(_kvNorm(area.state))) return true;

  // A registered district is an explicit scope: nothing matched → hide,
  // broadcasts included (they are city-targeted by the authority).
  if (area.district) return false;

  // Only a coarse auto-point: hide if the alert has geometry we're
  // outside of; otherwise (no geometry to test) show it.
  if (area.lat != null && hasGeom) return false;
  return true;
}

function renderSACHETPanel(usedFallback) {
  const panel = document.getElementById('sachet-alerts-panel');
  if (!panel) return;

  if (usedFallback || AppState.sachetUnavailable) {
    panel.innerHTML = '<div class="sachet-error">⚠ Official disaster alert data unavailable.</div>';
    return;
  }

  // Only currently-active alerts, scoped to the citizen's own location
  // (district / state / GPS point) — expired or out-of-area alerts are
  // never displayed as active red/orange/yellow zones.
  const activeAlerts = AppState.sachetAlerts.filter(isAlertActive).filter(alertTouchesKavachArea);

  if (!activeAlerts.length) {
    const area = kavachUserArea();
    const where = area.district || area.state;
    panel.innerHTML = '<div class="sachet-error">' +
      (where ? 'No active official alerts for ' + escapeHtml(where) + ' right now.'
             : 'No active official alerts at this time.') + '</div>';
    return;
  }

  const notice = '';

  // Authority broadcasts pinned to the top, then by severity.
  const sevRank = { extreme:4, severe:3, high:3, moderate:2, minor:1, unknown:0 };
  const ordered = [...activeAlerts].sort((x, y) =>
    (y.source === 'BROADCAST') - (x.source === 'BROADCAST') ||
    (sevRank[y.severity] || 0) - (sevRank[x.severity] || 0));

  const cards = ordered.map(a => {
    const sev   = a.severity || 'unknown';
    const label = severityLabel(sev);
    const time  = relativeTime(a.pubDate);
    const event = (a.event  || a.title || '').substring(0, 65);
    const area  = (a.areaDesc || '').substring(0, 110);
    const isBc  = a.source === 'BROADCAST';
    const linkAttr = isBc
      ? 'onclick="openCitizenRegister()" title="Open the safety response form"'
      : (a.link && a.link !== '#'
        ? 'onclick="window.open(\'' + a.link + '\',\'_blank\')" title="View CAP alert"'
        : '');
    const desc = isBc ? (a.description || '') : '';
    return '<div class="sachet-card ' + sev + (isBc ? ' sachet-card--broadcast' : '') + '" ' + linkAttr + '>' +
           '<div class="sachet-badge ' + sev + '">' + (isBc ? '📡 ' : '') + label + '</div>' +
           '<div class="sachet-event">' + escapeHtml(event) + '</div>' +
           (desc ? '<div class="sachet-desc">' + escapeHtml(desc.substring(0, 200)) + '</div>' : '') +
           (isBc && a.instruction ? '<div class="sachet-instruction">' + escapeHtml(a.instruction.substring(0, 130)) + '</div>' : '') +
           '<div class="sachet-area">'  + escapeHtml(area)  + '</div>' +
           (isBc ? '<div class="sachet-formline">📝 Safety form link sent by SMS · ☎ Toll-free ' + escapeHtml(a.tollFree || '1078') + '</div>' : '') +
           '<div class="sachet-meta"><span>' + time + '</span>' +
           '<span class="sachet-source">' + escapeHtml(isBc ? 'RESQNET Command Centre' : (a.sender || 'IMD / NDMA')) + '</span></div>' +
           '</div>';
  }).join('');

  panel.innerHTML = notice + '<div class="sachet-scroll">' + cards + '</div>';
}

function updateHomeAlertFromSACHET() {
  const activeAlerts = (AppState.sachetAlerts || []).filter(isAlertActive);
  if (!activeAlerts.length) return;
  const order = { extreme:4, severe:3, moderate:2, minor:1, unknown:0 };
  const top   = [...activeAlerts].sort((a, b) => (order[b.severity]||0) - (order[a.severity]||0))[0];
  if (!top) return;

  const icons = { extreme:'🔴', severe:'🟠', moderate:'🟡', minor:'🟢', unknown:'⚠' };
  const setEl = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

  setEl('home-alert-tag',   icons[top.severity] + ' ' + severityLabel(top.severity) + ' ALERT');
  setEl('home-alert-title', (top.event || top.title || '').substring(0, 55));
  setEl('home-alert-sub',   (top.areaDesc || '').substring(0, 70) + ' — Tap to open Kavach');
  setEl('banner-title',     (top.headline || top.event || top.title || '').substring(0, 80));
  setEl('banner-sub',       (top.areaDesc || '').substring(0, 100));
}

// ══════════════════════════════════════════════════════════════
//  SACHET BROADCAST → CITIZEN RESPONSE FEATURE
// ══════════════════════════════════════════════════════════════

// ── Broadcast generation ────────────────────────────────────────
// ── Weather-type detection helper ───────────────────────────────────────────
function detectWeatherType(w) {
  if (!w) return 'default';
  const c     = (w.condition || '').toLowerCase();
  const rain  = parseFloat(w.rainfall) || 0;
  const wind  = parseFloat(w.wind)     || 0;
  const temp  = parseFloat(w.temp)     || parseFloat(w.temperature) || 28;
  const vis   = parseFloat(w.visibility) || 10;

  if (c.includes('cyclone') || c.includes('hurricane') || c.includes('typhoon') || wind >= 90) return 'cyclone';
  if (c.includes('earthquake') || c.includes('seismic'))  return 'earthquake';
  if (c.includes('thunder')  || c.includes('lightning'))  return 'thunderstorm';
  if (c.includes('flood')    || rain >= 80)                return 'flood';
  if ((c.includes('storm')   || c.includes('squall')) && wind >= 55) return 'storm';
  if ((c.includes('rain')    || c.includes('shower'))   && rain >= 30) return 'heavyrain';
  if (c.includes('fog')      || c.includes('mist')   || vis <= 0.5)   return 'fog';
  if (temp >= 43             || c.includes('heat'))                    return 'heatwave';
  return 'default';
}

function generateSACHETBroadcast(severity, override) {
  const w        = getNearestWeather() || (Array.isArray(MockDB.weatherData) ? MockDB.weatherData[0] : null);
  // NOTE: never name a local variable `location` in this function — it
  // shadows window.location, and the form link below built
  // "undefined/Kavach/kavach.html#report" as a result.
  const areaLabel = (override && (override.area || override.district))
    ? [override.area || override.district, override.state].filter(Boolean).join(', ')
    : (kavachHomeLabel() || 'Bhubaneswar, Odisha');
  const city     = areaLabel.split(',')[0].trim();
  const state    = (areaLabel.split(',')[1] || kavachUserArea().state || '').trim();
  const now      = new Date();
  const timeStr  = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dateStr  = now.toLocaleDateString('en-IN',  { day: '2-digit', month: '2-digit', year: 'numeric' });

  const rain     = w ? `${w.rainfall} mm`   : '--';
  const wind     = w ? `${w.wind} km/h`     : '--';
  const humidity = w ? `${w.humidity}%`     : '--';
  const temp     = w ? `${w.temp || w.temperature || '--'}°C` : '--';
  const cond     = w ? w.condition          : 'Adverse Conditions';
  const wtype    = detectWeatherType(w);

  // ── Per-disaster templates ───────────────────────────────────
  const TYPES = {
    thunderstorm: {
      cbsLevel:   'Emergency alert: Extreme',
      alertLevel: '⛈️ THUNDERSTORM ALERT',
      headline:   `Severe thunderstorm warning for ${city}, ${state}. Lightning and strong winds expected.`,
      cbsBody:    `This is an OFFICIAL EMERGENCY ALERT issued by the National Disaster Management Authority (NDMA) through the Cell Broadcasting System, Government of India.\n\nSEVERE THUNDERSTORM with lightning, gusty winds (${wind}) and heavy rain (${rain}) is expected in ${city} and nearby areas in the next few hours.\n\nDo NOT shelter under trees. Stay away from metal objects and open grounds. Move indoors immediately.\n\nEmergency Helpline: 1800-180-1253 | NDMA: 1078\nTimestamp: ${dateStr} ${timeStr}`,
      advice:     'Move indoors. Avoid open areas, tall trees, and metal structures. Do not use landline phones.',
      smsLevel:   'THUNDERSTORM ALERT',
    },
    cyclone: {
      cbsLevel:   'Emergency alert: Extreme',
      alertLevel: '🌀 CYCLONE WARNING',
      headline:   `Cyclone warning issued for ${city}, ${state}. Destructive winds approaching.`,
      cbsBody:    `This is an OFFICIAL EMERGENCY ALERT issued by the India Meteorological Department (IMD) through the Cell Broadcasting System, Government of India.\n\nCYCLONE WARNING: A severe cyclonic storm is approaching ${city} and coastal areas of ${state}. Wind speeds up to ${wind} are expected. Storm surge and heavy flooding likely.\n\nEVACUATE COASTAL AND LOW-LYING AREAS IMMEDIATELY. Proceed to the nearest cyclone shelter. Do NOT venture near the coast.\n\nIMD Helpline: 1800-180-1717 | NDMA: 1078\nTimestamp: ${dateStr} ${timeStr}`,
      advice:     'EVACUATE IMMEDIATELY. Move to cyclone shelters. Board up windows. Stock emergency supplies.',
      smsLevel:   'CYCLONE WARNING',
    },
    earthquake: {
      cbsLevel:   'Emergency alert: Extreme',
      alertLevel: '🟠 EARTHQUAKE ALERT',
      headline:   `Earthquake reported near ${city}. Drop, cover and hold on. Check for damage.`,
      cbsBody:    `This is an OFFICIAL EMERGENCY ALERT issued by the National Center for Seismology (NCS) through the Cell Broadcasting System, Government of India.\n\nEARTHQUAKE reported near ${city}, ${state}. Aftershocks are possible in the coming hours.\n\nDROP to hands and knees. Take COVER under a sturdy table or against an interior wall. HOLD ON until shaking stops. After shaking: evacuate carefully and check for gas leaks, structural damage.\n\nDisaster Helpline: 1078 | NCS: 1800-11-2338\nTimestamp: ${dateStr} ${timeStr}`,
      advice:     'Drop, cover and hold. After shaking — evacuate and check for structural damage. Avoid elevators.',
      smsLevel:   'EARTHQUAKE ALERT',
    },
    flood: {
      cbsLevel:   'Emergency alert: Severe',
      alertLevel: '🌊 FLOOD ALERT',
      headline:   `Flash flood warning for ${city}, ${state}. Avoid all water bodies and low-lying roads.`,
      cbsBody:    `This is an OFFICIAL EMERGENCY ALERT issued by the Central Water Commission (CWC) through the Cell Broadcasting System, Government of India.\n\nFLASH FLOOD WARNING: Extremely heavy rainfall (${rain}) has caused dangerous flooding in ${city} and surrounding areas. Rivers and drains are at critical levels.\n\nEVACUATE LOW-LYING AREAS IMMEDIATELY. Do NOT walk, swim, or drive through floodwater. Move to higher ground or upper floors. Keep children and elderly safe.\n\nFlood Helpline: 1070 | NDMA: 1078\nTimestamp: ${dateStr} ${timeStr}`,
      advice:     'Move to higher ground immediately. Do NOT enter flooded roads or waterlogged areas.',
      smsLevel:   'FLOOD ALERT',
    },
    storm: {
      cbsLevel:   'Emergency alert: Severe',
      alertLevel: '🌧️ SEVERE STORM WARNING',
      headline:   `Severe storm warning for ${city}. Winds at ${wind}. Take shelter immediately.`,
      cbsBody:    `This is an OFFICIAL EMERGENCY ALERT issued by IMD through the Cell Broadcasting System, Government of India.\n\nSEVERE STORM warning in effect for ${city}, ${state}. Wind gusts up to ${wind} and heavy downpour expected. Power outages, uprooted trees, and structural damage possible.\n\nStay indoors away from windows. Secure loose outdoor objects. Avoid driving. Keep emergency torch and supplies ready.\n\nIMD: 1800-180-1717 | Emergency: 112\nTimestamp: ${dateStr} ${timeStr}`,
      advice:     'Stay indoors. Secure loose objects. Avoid driving. Keep torch and emergency supplies ready.',
      smsLevel:   'STORM WARNING',
    },
    heavyrain: {
      cbsLevel:   'Emergency alert: Moderate',
      alertLevel: '🌧️ HEAVY RAIN WARNING',
      headline:   `Heavy rain warning for ${city}, ${state}. Rainfall: ${rain}. Avoid travel.`,
      cbsBody:    `This is an OFFICIAL EMERGENCY ALERT issued by IMD through the Cell Broadcasting System, Government of India.\n\nHEAVY TO VERY HEAVY RAINFALL (${rain}) expected in ${city} and surrounding districts of ${state} in the next 24 hours. Roads may be waterlogged. Visibility may be reduced.\n\nAvoid unnecessary travel. Do not cross flooded roads. Keep emergency numbers handy.\n\nIMD: 1800-180-1717 | Emergency: 112\nTimestamp: ${dateStr} ${timeStr}`,
      advice:     'Avoid travel. Stay away from waterlogged roads. Keep emergency contacts ready.',
      smsLevel:   'HEAVY RAIN WARNING',
    },
    fog: {
      cbsLevel:   'Weather advisory',
      alertLevel: '🌫️ DENSE FOG ADVISORY',
      headline:   `Dense fog advisory for ${city}. Visibility severely reduced. Drive with extreme caution.`,
      cbsBody:    `This is a WEATHER ADVISORY issued by IMD through the Cell Broadcasting System, Government of India.\n\nDENSE FOG has been reported in ${city} and surrounding areas. Visibility is very low. Road and rail transport may be affected.\n\nDo NOT drive at high speed. Use fog lights. Maintain safe distance from vehicles ahead. Avoid highway travel if possible.\n\nIMD: 1800-180-1717 | Traffic Helpline: 1095\nTimestamp: ${dateStr} ${timeStr}`,
      advice:     'Drive with fog lights on. Maintain low speed and safe distance. Avoid highway travel.',
      smsLevel:   'FOG ADVISORY',
    },
    heatwave: {
      cbsLevel:   'Emergency alert: Severe',
      alertLevel: '🌡️ HEATWAVE ALERT',
      headline:   `Severe heatwave warning for ${city}. Temperature: ${temp}. Stay hydrated and indoors.`,
      cbsBody:    `This is an OFFICIAL EMERGENCY ALERT issued by IMD through the Cell Broadcasting System, Government of India.\n\nHEATWAVE ALERT: Temperature in ${city}, ${state} has reached dangerous levels (${temp}). Risk of heat stroke and dehydration is HIGH.\n\nSTAY INDOORS during peak hours (11 AM – 4 PM). Drink water frequently. Cover your head when going outside. Check on elderly and children regularly.\n\nHeat Helpline: 104 | Emergency: 112\nTimestamp: ${dateStr} ${timeStr}`,
      advice:     'Stay indoors during peak hours. Drink water frequently. Do not exert in direct sun.',
      smsLevel:   'HEATWAVE ALERT',
    },
    default: {
      cbsLevel:   'Emergency alert',
      alertLevel: '⚠️ EMERGENCY WEATHER ALERT',
      headline:   `Emergency weather alert for ${city}, ${state}. ${cond} detected. Take precautions.`,
      cbsBody:    `This is an OFFICIAL EMERGENCY ALERT issued by the National Disaster Management Authority (NDMA) through the Cell Broadcasting System, Government of India.\n\n${cond.toUpperCase()} has been reported in ${city} and surrounding areas. Rainfall: ${rain} | Wind: ${wind} | Humidity: ${humidity}.\n\nPlease stay alert and follow instructions from local authorities. Monitor official news channels for updates.\n\nNDMA Helpline: 1078 | Emergency: 112\nTimestamp: ${dateStr} ${timeStr}`,
      advice:     'Stay alert. Follow local authority instructions. Monitor official weather updates.',
      smsLevel:   'WEATHER ALERT',
    },
  };

  // Severity overrides (for very extreme conditions regardless of type)
  const sevOverride = {
    severe:   { cbsLevel: 'Emergency alert: Extreme' },
    high:     { cbsLevel: 'Emergency alert: Severe'  },
    moderate: { cbsLevel: 'Emergency alert: Moderate'},
    low:      { cbsLevel: 'Weather advisory'         },
  };

  const base = TYPES[wtype] || TYPES.default;
  const over = sevOverride[severity] || {};

  // Toll-free helpline + safety-response form link — carried in BOTH the
  // CBS popup and the SMS bubble.
  const tollFree  = (override && override.toll_free) || '1078';
  const emergency = '112';
  let formUrl = (override && override.form_url) || '';
  if (!formUrl) formUrl = kavachReportUrl();
  const formDisplay = formUrl.replace(/^https?:\/\//, '');

  let alertLevel = base.alertLevel;
  let headline   = base.headline;
  let advice     = base.advice;
  let smsLevel   = base.smsLevel;
  let description = '';
  let cbsBody;

  if (override) {
    // Authority broadcast for a specific city — use the command centre's
    // own description / instruction, not a local weather template.
    description = (override.description || override.headline || '').trim();
    headline    = override.headline || `${(severity || 'high').toUpperCase()} alert for ${city}, ${state}.`;
    advice      = override.instruction || base.advice;
    smsLevel    = `${(severity || 'high').toUpperCase()} ALERT`;
    alertLevel  = `⚠️ AUTHORITY BROADCAST — ${city.toUpperCase()}`;
    cbsBody =
`OFFICIAL EMERGENCY BROADCAST for ${city}, ${state}.
Issued by RESQNET Command Centre / District Disaster Authority.

${description || 'A hazardous situation has been flagged for your area. Stay alert.'}

${advice}

➜ Safety response form (report your status / request help):
   ${formDisplay}
   This link has also been sent to you by SMS.

Toll-free helpline: ${tollFree}  |  Emergency: ${emergency}
Timestamp: ${dateStr} ${timeStr}`;
  } else {
    cbsBody = base.cbsBody +
`\n\n➜ Safety response form: ${formDisplay} (link also sent by SMS)\nToll-free helpline: ${tollFree}`;
  }

  return {
    severity,
    weatherType:     wtype,
    cbsLevel:        over.cbsLevel || base.cbsLevel,
    alertLevel,
    headline,
    description,
    body:            cbsBody,   // used for SMS bubble
    cbsBody,                    // used for CBS popup
    advice,
    smsLevel,
    location:        city,
    fullLocation:    areaLabel,
    weather:         w,
    isAuthority:     !!override,
    formUrl,
    formDisplay,
    tollFree,
    timestamp:       now.toISOString(),
    timeStr,
    dateStr,
    registrationUrl: formDisplay,
    helpline:        tollFree,
  };
}

function selectBroadcastSeverity(el) {
  document.querySelectorAll('.dbp-sev-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  AppState.sachetBroadcast.severity = el.dataset.sev || 'high';
}

function triggerEmergencyBroadcast(payload) {
  // Auto-login demo user if not already logged in
  if (!AppState.currentUser) {
    AppState.currentUser = MockDB.users[0];
    localStorage.setItem('kavach_user', JSON.stringify(AppState.currentUser));
  }

  const override = (payload && payload.type === 'SACHET_BROADCAST') ? payload : null;
  const severity  = (override && override.severity) || AppState.sachetBroadcast.severity || 'high';
  const broadcast = generateSACHETBroadcast(severity, override);
  AppState.sachetBroadcast.generated   = broadcast;
  AppState.sachetBroadcast.active      = true;
  AppState.sachetBroadcast.smsInjected = false;

  // Render preview card on broadcast screen (for if user opens Messages later)
  renderBroadcastCard(broadcast);

  // Reveal the broadcast convo entry in the SMS inbox
  updateSMSInboxWithBroadcast(broadcast);

  // Auto-inject into SMS chat immediately (don't wait for user to open it)
  setTimeout(() => {
    const container = document.getElementById('broadcast-chat-messages');
    if (container && !AppState.sachetBroadcast.smsInjected) {
      injectBroadcastIntoChat();
      AppState.sachetBroadcast.smsInjected = true;
    }
  }, 400);

  // Show India CBS-style emergency alert popup with continuous siren
  showCBSPopup(broadcast);
}

function renderBroadcastCard(broadcast) {
  const el = document.getElementById('broadcast-card-content');
  if (!el) return;

  el.innerHTML = `
    <div class="broadcast-card">
      <div class="broadcast-card-top">
        <div class="broadcast-card-org">\u26a0 KAVACH EMERGENCY BROADCAST \u2014 SIMULATION ONLY</div>
        <div class="broadcast-card-title">${broadcast.alertLevel}</div>
      </div>
      <div class="broadcast-card-body">
        <div class="broadcast-card-headline">${escapeHtml(broadcast.headline)}</div>
        <div class="broadcast-card-stats">${escapeHtml(broadcast.body).replace(/\n/g,'<br>')}</div>
        <div class="broadcast-card-advice">\u26a0 ${escapeHtml(broadcast.advice)}</div>
        <div class="broadcast-card-link-box">
          <span style="font-size:16px;">\ud83d\udccd</span>
          <div style="flex:1;">
            <div style="font-size:10px;color:rgba(21,101,192,0.7);margin-bottom:2px;">Report your safety status</div>
            <span class="broadcast-card-link" onclick="openCitizenRegister()">https://${broadcast.registrationUrl}</span>
          </div>
        </div>
        <div class="broadcast-card-helpline">\u260e Emergency Helpline: <strong>${broadcast.helpline}</strong></div>
      </div>
      <div class="broadcast-card-footer">
        \u2014 KAVACH Disaster Management Authority &nbsp;|&nbsp; ${broadcast.dateStr}, ${broadcast.timeStr}
      </div>
    </div>
  `;
}

function updateSMSInboxWithBroadcast(broadcast) {
  const convoEl = document.getElementById('kavach-broadcast-convo-item');
  if (convoEl) {
    convoEl.style.display = '';
    const previewEl = document.getElementById('kavach-broadcast-preview');
    if (previewEl) previewEl.textContent = `\u26a0 ${broadcast.smsLevel}: ${broadcast.location} \u2014 Tap to read`;
    const timeEl = document.getElementById('kavach-broadcast-time');
    if (timeEl) timeEl.textContent = broadcast.timeStr;
  }
}

function openBroadcastSMSConvo() {
  // Reset the broadcast chat container so the message re-animates
  const container = document.getElementById('broadcast-chat-messages');
  if (container) {
    container.innerHTML = `<div class="typing-indicator show" id="broadcast-typing">
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
    </div>`;
  }
  AppState.sachetBroadcast.smsInjected = false;
  showScreen('broadcast-chat');
}

function initBroadcastChatScreen() {
  const container = document.getElementById('broadcast-chat-messages');
  if (!container) return;

  if (!AppState.sachetBroadcast.active || !AppState.sachetBroadcast.generated) {
    container.innerHTML = `<div style="text-align:center;padding:40px 20px;color:var(--text-muted);font-size:13px;line-height:1.8;">
      <div style="font-size:36px;margin-bottom:12px;">\ud83d\udce1</div>
      No active emergency broadcast.<br>Use the demo panel to trigger one.
    </div>`;
    return;
  }

  if (AppState.sachetBroadcast.smsInjected) return;

  const typingEl = document.getElementById('broadcast-typing');
  if (typingEl) typingEl.classList.add('show');

  setTimeout(() => {
    if (typingEl) typingEl.classList.remove('show');
    injectBroadcastIntoChat();
    AppState.sachetBroadcast.smsInjected = true;
  }, 900);
}

function injectBroadcastIntoChat() {
  const container = document.getElementById('broadcast-chat-messages');
  const typingEl  = document.getElementById('broadcast-typing');
  if (!container) return;

  const broadcast = AppState.sachetBroadcast.generated;
  if (!broadcast) return;

  const htmlBody   = escapeHtml(broadcast.body).replace(/\n/g, '<br>');
  const htmlAdvice = escapeHtml(broadcast.advice);
  const isAuth     = broadcast.isAuthority;

  const bodyHtml = isAuth
    ? `${escapeHtml(broadcast.headline)}<br><br>${escapeHtml(broadcast.description || '')}<br><br>\u26a0 ${htmlAdvice}`
    : `${escapeHtml(broadcast.headline)}<br><br>${htmlBody}<br><br>\u26a0 ${htmlAdvice}`;

  const bubble = document.createElement('div');
  bubble.className = 'sachet-sms-bubble';
  bubble.innerHTML = `
    <div class="sachet-sms-org">\ud83d\udce1 ${isAuth ? 'RESQNET Command Centre \u2022 Authority Broadcast' : 'KAVACH \u2022 Emergency Broadcast'}</div>
    <div class="sachet-sms-title">${broadcast.alertLevel}</div>
    <div class="sachet-sms-body">${bodyHtml}</div>
    <div class="sachet-link" onclick="openCitizenRegister()">
      \ud83d\udcdd Safety response form (tap to open):<br><span style="text-decoration:underline;">${escapeHtml(broadcast.formDisplay || broadcast.registrationUrl)}</span>
    </div>
    <div class="sachet-helpline">\u260e Toll-free helpline: <strong>${escapeHtml(broadcast.tollFree || broadcast.helpline)}</strong> &nbsp;|&nbsp; Emergency: <strong>112</strong></div>
    <div class="sachet-sms-sim">\u26a0 SIMULATION / DEMO \u2014 Not a real government broadcast</div>
    <div class="sachet-sms-time">${broadcast.timeStr} \u2713</div>
  `;

  container.insertBefore(bubble, typingEl || null);
  container.scrollTop = container.scrollHeight;
}

// ── Citizen Registration ─────────────────────────────────────────
function openCitizenRegister() {
  AppState.citizenRegForm = {
    safetyStatus: null,
    injured:      null,
    injuredCount: 1,
    trapped:      null,
    trappedCount: 1,
    needs:        [],
    additional:   '',
  };

  // Reset all form UI
  document.querySelectorAll('#screen-citizen-register .status-option').forEach(el => el.classList.remove('selected'));
  document.querySelectorAll('#screen-citizen-register .yn-btn').forEach(el => {
    el.classList.remove('selected');
    el.style.opacity = '';
  });
  document.querySelectorAll('#screen-citizen-register .need-option').forEach(el => el.classList.remove('selected'));

  const injuredRow = document.getElementById('creg-injured-count-row');
  const trappedRow = document.getElementById('creg-trapped-count-row');
  if (injuredRow) injuredRow.style.display = 'none';
  if (trappedRow) trappedRow.style.display = 'none';

  const additionalEl = document.getElementById('creg-additional');
  if (additionalEl) additionalEl.value = '';

  // Populate location from existing AppState.userLocation
  populateCitizenRegLocation();

  showScreen('citizen-register');
}

function populateCitizenRegLocation() {
  const loc = AppState.userLocation;

  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setVal('creg-city',     loc.name  || 'Bhubaneswar, Odisha');
  setVal('creg-lat',      Number.isFinite(loc.lat) ? `${Number(loc.lat).toFixed(5)}\u00b0 N` : 'Obtaining...');
  setVal('creg-lng',      Number.isFinite(loc.lng) ? `${Number(loc.lng).toFixed(5)}\u00b0 E` : 'Obtaining...');
  setVal('creg-accuracy', loc.isExact ? '\u2705 GPS (High Accuracy)' : '\ud83d\udccd Approximate (Default)');

  const statusEl = document.getElementById('creg-geo-status');
  if (statusEl) {
    if (Number.isFinite(loc.lat)) {
      statusEl.textContent = '\u2705 Location obtained successfully';
      statusEl.style.color = 'var(--success)';
    } else {
      statusEl.textContent = '\u23f3 Attempting to obtain precise location...';
      statusEl.style.color = 'var(--text-muted)';
      requestUserLocation({ silent: true }).then(() => populateCitizenRegLocation());
    }
  }
}

function setCitizenStatus(el) {
  document.querySelectorAll('#screen-citizen-register .status-option').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
  if (AppState.citizenRegForm) AppState.citizenRegForm.safetyStatus = el.dataset.val;
}

function setCitizenInjured(val) {
  if (AppState.citizenRegForm) AppState.citizenRegForm.injured = val;
  const yesBtn = document.getElementById('creg-injured-yes');
  const noBtn  = document.getElementById('creg-injured-no');
  const row    = document.getElementById('creg-injured-count-row');
  if (yesBtn) yesBtn.style.opacity = val ? '1' : '0.5';
  if (noBtn)  noBtn.style.opacity  = val ? '0.5' : '1';
  if (row)    row.style.display    = val ? 'block' : 'none';
}

function setCitizenTrapped(val) {
  if (AppState.citizenRegForm) AppState.citizenRegForm.trapped = val;
  const yesBtn = document.getElementById('creg-trapped-yes');
  const noBtn  = document.getElementById('creg-trapped-no');
  const row    = document.getElementById('creg-trapped-count-row');
  if (yesBtn) yesBtn.style.opacity = val ? '1' : '0.5';
  if (noBtn)  noBtn.style.opacity  = val ? '0.5' : '1';
  if (row)    row.style.display    = val ? 'block' : 'none';
}

function toggleCitizenNeed(el) {
  el.classList.toggle('selected');
  const need = el.dataset.need;
  if (!AppState.citizenRegForm) return;
  if (el.classList.contains('selected')) {
    if (!AppState.citizenRegForm.needs.includes(need)) AppState.citizenRegForm.needs.push(need);
  } else {
    AppState.citizenRegForm.needs = AppState.citizenRegForm.needs.filter(n => n !== need);
  }
}

function generateCitizenReportId() {
  const year  = new Date().getFullYear();
  const count = Array.isArray(MockDB.citizenReports) ? MockDB.citizenReports.length : 0;
  const num   = String(1001 + count + Math.floor(Math.random() * 9)).padStart(4, '0');
  return `KVC-${year}-${num}`;
}

function submitCitizenReport() {
  const form = AppState.citizenRegForm || {};

  if (!form.safetyStatus) {
    showToast('Please select your safety status first.', 'error');
    return;
  }

  const loc      = AppState.userLocation;
  const reportId = generateCitizenReportId();
  const now      = new Date();

  const injuredCount = form.injured
    ? (parseInt(document.getElementById('creg-injured-count')?.value) || 1)
    : 0;
  const trappedCount = form.trapped
    ? (parseInt(document.getElementById('creg-trapped-count')?.value) || 1)
    : 0;
  const additional = (document.getElementById('creg-additional')?.value || '').trim();

  const statusLabel = { safe: 'Safe', 'needs-help': 'Needs Assistance', danger: 'Immediate Danger' };
  const statusEmoji = { safe: '\ud83d\udfe2', 'needs-help': '\ud83d\udfe1', danger: '\ud83d\udd34' };
  const priorityMap = { safe: 'LOW', 'needs-help': 'HIGH', danger: 'CRITICAL' };

  const report = {
    id:        reportId,
    source:    'SACHET_CITIZEN',
    type:      'CITIZEN_SAFETY_REPORT',
    citizen:   AppState.currentUser?.name || 'Citizen',
    userId:    AppState.currentUser?.id   || 'ANON',
    location: {
      lat:   loc.lat,
      lng:   loc.lng,
      name:  loc.name  || 'Unknown',
      exact: loc.exact || (Number.isFinite(loc.lat)
        ? `${Number(loc.lat).toFixed(4)}\u00b0N, ${Number(loc.lng).toFixed(4)}\u00b0E`
        : 'N/A'),
    },
    safetyStatus:      form.safetyStatus,
    safetyStatusLabel: statusLabel[form.safetyStatus] || form.safetyStatus,
    safetyStatusEmoji: statusEmoji[form.safetyStatus] || '\u26aa',
    injured:           form.injured  || false,
    injuredCount,
    trapped:           form.trapped  || false,
    trappedCount,
    needs:             form.needs    || [],
    additional,
    broadcastSeverity: AppState.sachetBroadcast.generated?.severity || 'unknown',
    priority:          priorityMap[form.safetyStatus] || 'MODERATE',
    status:            'RECEIVED',
    timestamp:         now.toISOString(),
  };

  if (!Array.isArray(MockDB.citizenReports)) MockDB.citizenReports = [];
  MockDB.citizenReports.push(report);
  MockDB.requests.push(report);
  localStorage.setItem('kavach_requests', JSON.stringify(MockDB.requests));

  // Populate confirmation screen
  const confirmIdEl     = document.getElementById('citizen-report-id');
  const confirmTimeEl   = document.getElementById('citizen-confirm-time');
  const confirmStatusEl = document.getElementById('citizen-confirm-status');

  if (confirmIdEl)     confirmIdEl.textContent     = `Report ID: ${reportId}`;
  if (confirmTimeEl)   confirmTimeEl.textContent   = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  if (confirmStatusEl) confirmStatusEl.textContent = `${statusEmoji[form.safetyStatus]} ${statusLabel[form.safetyStatus]}`;

  // Post to the RESQNET command centre. Safety reports were previously
  // stored only in localStorage, so they never reached the dashboard.
  // Everything the citizen reported is carried across, and live GPS
  // sharing starts (pushRequestToCommandCentre does that) for the
  // responder heading to them.
  const needsForCC = [...(form.needs || [])];
  if (form.trapped && !needsForCC.includes('rescue')) needsForCC.push('rescue');
  if (form.injured && !needsForCC.includes('medical')) needsForCC.push('medical');

  Promise.resolve(pushRequestToCommandCentre({
    id: reportId,
    type: 'CITIZEN_SAFETY_REPORT',
    citizen: report.citizen,
    location: report.location,
    needs: needsForCC,
    people: Math.max(1, injuredCount + trappedCount),
    injured: !!form.injured,
    injuredCount,
    trapped: !!form.trapped,
    trappedCount,
    priority: report.priority,
    additional,
    timestamp: now.toISOString(),
  })).catch((e) => console.warn('[kavach] safety report push failed', e));

  showScreen('citizen-confirm');
  showToast(`\u2705 Report ${reportId} submitted to KAVACH Command Centre`, 'success');
}

// ── Command Centre — Citizen Reports Panel ───────────────────────
function renderCitizenReportsPanel() {
  const panel = document.getElementById('citizen-reports-panel');
  if (!panel) return;

  const reports = Array.isArray(MockDB.citizenReports)
    ? MockDB.citizenReports.slice().reverse()
    : [];

  if (!reports.length) {
    panel.innerHTML = `<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:13px;line-height:1.6;">
      No citizen reports yet.<br>Trigger a broadcast to begin the demo flow.
    </div>`;
    return;
  }

  const statusColor = {
    safe:         'var(--success)',
    'needs-help': '#F9A825',
    danger:       'var(--danger)',
  };
  const statusLabel = {
    safe:         'Safe',
    'needs-help': 'Needs Assistance',
    danger:       'Immediate Danger',
  };
  const statusEmoji = {
    safe:         '\ud83d\udfe2',
    'needs-help': '\ud83d\udfe1',
    danger:       '\ud83d\udd34',
  };

  panel.innerHTML = reports.map(r => {
    const time  = r.timestamp
      ? new Date(r.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
      : '--:--';
    const loc   = r.location?.name || 'Unknown';
    const needs = (r.needs || []).join(', ') || 'None specified';
    const s     = r.safetyStatus || 'unknown';
    const emoji = statusEmoji[s]  || '\u26aa';
    const color = statusColor[s]  || '#999';
    const sev   = r.broadcastSeverity || 'unknown';

    return `<div class="report-card" style="border-left:4px solid ${color};">
      <div class="report-card-header">
        <div>
          <div class="report-card-id">${escapeHtml(r.id)}</div>
          <div class="report-card-citizen">${escapeHtml(r.citizen || 'Citizen')}</div>
        </div>
        <div class="report-status-badge" style="background:${color};">${emoji} ${statusLabel[s] || s}</div>
      </div>
      <div class="report-card-row"><span>\ud83d\udccd</span><span>${escapeHtml(loc)}</span></div>
      ${r.injured ? `<div class="report-card-row"><span>\ud83e\udd15</span><span>Injured: ${r.injuredCount || 1} person(s)</span></div>` : ''}
      ${r.trapped ? `<div class="report-card-row"><span>\ud83d\udea8</span><span>Trapped: ${r.trappedCount || 1} person(s)</span></div>` : ''}
      ${needs !== 'None specified' ? `<div class="report-card-row"><span>\ud83c\udd98</span><span>Needs: ${escapeHtml(needs)}</span></div>` : ''}
      <div class="report-card-meta">
        <span>\u23f1 ${time}</span>
        <span class="report-severity-tag ${sev}">${sev.toUpperCase()} ALERT</span>
      </div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════
//  MAIN WEBSITE → KAVACH SIMULATOR BRIDGE
//  Listens for broadcasts triggered from ResqNet (index.html)
//  via localStorage and plays a siren inside the simulator.
// ══════════════════════════════════════════════════════════════

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  INDIA CBS EMERGENCY POPUP + CONTINUOUS SIREN
//
//  Uses HTMLAudioElement with a generated WAV blob.
//  HTMLAudio.play() respects the page's user-activation state —
//  as long as the user has clicked/typed ANYWHERE in the Kavach tab
//  (which they always have), the siren plays automatically.
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

let _sirenAudio  = null;   // single HTMLAudioElement, reused
let _sirenBlobURL= null;   // object URL for the WAV blob
let _sirenActive = false;

// \u2500\u2500 Generate a siren WAV blob entirely in JavaScript \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function _buildSirenWav() {
  const SR  = 22050;           // sample rate
  const DUR = 0.9;             // seconds — one hi+lo sweep cycle
  const N   = Math.floor(SR * DUR);
  const buf = new ArrayBuffer(44 + N * 2);
  const dv  = new DataView(buf);

  // Write WAV header
  const w32 = (o, v) => dv.setUint32(o, v, true);
  const w16 = (o, v) => dv.setUint16(o, v, true);
  const wch = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };

  wch(0, 'RIFF'); w32(4, 36 + N * 2);
  wch(8, 'WAVE'); wch(12, 'fmt ');
  w32(16, 16); w16(20, 1);          // PCM
  w16(22, 1); w32(24, SR);          // mono, sample rate
  w32(28, SR * 2); w16(32, 2);      // byte rate, block align
  w16(34, 16);                       // 16-bit
  wch(36, 'data'); w32(40, N * 2);

  // Two-tone sweep: 1050 Hz for first half, 680 Hz for second half
  const HALF = N / 2;
  let phase = 0;
  for (let i = 0; i < N; i++) {
    const freq = i < HALF ? 1050 : 680;
    phase += (2 * Math.PI * freq) / SR;
    const amp = 0.65;
    // Fade in / fade out at boundaries to avoid clicks
    const fade = Math.min(i, N - i, 200) / 200;
    const s16  = Math.round(Math.sin(phase) * amp * fade * 32767);
    dv.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, s16)), true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// Build and cache the Audio element once
function _getSirenAudio() {
  if (_sirenAudio) return _sirenAudio;
  const blob    = _buildSirenWav();
  _sirenBlobURL = URL.createObjectURL(blob);
  _sirenAudio   = new Audio(_sirenBlobURL);
  _sirenAudio.loop   = true;
  _sirenAudio.volume = 0.75;
  return _sirenAudio;
}

function startContinuousSiren() {
  if (_sirenActive) return;
  _sirenActive = true;

  const audio = _getSirenAudio();
  audio.currentTime = 0;

  const p = audio.play();
  if (p && p.catch) {
    p.catch(err => {
      console.warn('[Kavach] Siren blocked by browser autoplay policy:', err);
      // Show the manual enable button as fallback
      const btn = document.getElementById('cbs-enable-sound-btn');
      if (btn) btn.style.display = 'flex';
    });
  }
}

function stopContinuousSiren() {
  _sirenActive = false;
  if (_sirenAudio) {
    _sirenAudio.pause();
    _sirenAudio.currentTime = 0;
  }
  const btn = document.getElementById('cbs-enable-sound-btn');
  if (btn) btn.style.display = 'none';
}

// \u2500\u2500 CBS Popup show / dismiss \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function showCBSPopup(broadcast) {
  const overlay = document.getElementById('cbs-overlay');
  if (!overlay) return;

  // Populate header
  const levelEl = document.getElementById('cbs-alert-level');
  if (levelEl) levelEl.textContent = broadcast.cbsLevel || 'Emergency alert: Extreme';

  // Populate body
  const bodyEl = document.getElementById('cbs-body-text');
  if (bodyEl) {
    const w    = broadcast.weather;
    const rain = w ? `${w.rainfall} mm` : '--';
    const wind = w ? `${w.wind} km/h`   : '--';
    const hum  = w ? `${w.humidity}%`   : '--';
    const temp = w ? `${w.temp || w.temperature || '--'}\u00b0C` : '--';

    bodyEl.innerHTML = `
      <p style="white-space:pre-line;margin:0;">${escapeHtml(broadcast.cbsBody || broadcast.body)}</p>
      <div class="cbs-stats-row" style="margin-top:14px;">
        <div class="cbs-stat"><span class="cbs-stat-label">Rainfall</span>${escapeHtml(rain)}</div>
        <div class="cbs-stat"><span class="cbs-stat-label">Wind</span>${escapeHtml(wind)}</div>
        <div class="cbs-stat"><span class="cbs-stat-label">Humidity</span>${escapeHtml(hum)}</div>
        <div class="cbs-stat"><span class="cbs-stat-label">Temp</span>${escapeHtml(temp)}</div>
      </div>
    `;
  }

  overlay.classList.add('active');

  // Siren starts automatically — HTMLAudio is allowed as long as
  // the user has ever interacted with this tab (they always have).
  startContinuousSiren();
}

function dismissCBSPopup() {
  const overlay = document.getElementById('cbs-overlay');
  if (overlay) overlay.classList.remove('active');
  stopContinuousSiren();
  if (AppState.sachetBroadcast && AppState.sachetBroadcast.active) {
    showScreen('sachet-broadcast');
  }
}

// Fallback: called if autoplay is still blocked (rare edge case)
function cbsEnableSound() {
  const btn = document.getElementById('cbs-enable-sound-btn');
  if (btn) btn.style.display = 'none';
  const audio = _getSirenAudio();
  audio.currentTime = 0;
  audio.play().catch(() => {});
}

// Expose globally for onclick handlers
window.showCBSPopup    = showCBSPopup;
window.dismissCBSPopup = dismissCBSPopup;
window.cbsEnableSound  = cbsEnableSound;


// ══════════════════════════════════════════════════════════════
//  DEVICE PUSH NOTIFICATIONS  (SACHET alerts + authority broadcasts)
// ══════════════════════════════════════════════════════════════
function kavachNotifySupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}
function kavachNotifyState() {
  return kavachNotifySupported() ? Notification.permission : 'unsupported';
}
async function kavachEnsureNotifyPermission(explicit) {
  if (!kavachNotifySupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  let asked = false;
  try { asked = localStorage.getItem('kavach_notify_asked') === '1'; } catch (_) {}
  if (asked && !explicit) return 'default';
  try { localStorage.setItem('kavach_notify_asked', '1'); } catch (_) {}
  try {
    const res = await Notification.requestPermission();
    if (typeof updateDashboard === 'function') updateDashboard();
    return res;
  } catch (_) { return 'default'; }
}
window.kavachEnsureNotifyPermission = kavachEnsureNotifyPermission;

// Fire a real OS notification when possible; always mirror to an
// in-app toast so nothing is missed.
function kavachNotify(title, body, opts = {}) {
  try {
    if (kavachNotifySupported() && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      const n = new Notification(title, {
        body,
        tag: opts.tag || 'kavach-alert',
        renotify: true,
        requireInteraction: opts.severity === 'severe' || opts.severity === 'extreme',
        silent: false,
      });
      n.onclick = () => { window.focus(); n.close(); if (opts.onClick) opts.onClick(); };
    }
  } catch (_) {}
  if (typeof showToast === 'function') {
    showToast(`${title}${body ? ' — ' + body : ''}`, opts.toast || 'warning');
  }
}
window.kavachNotify = kavachNotify;

// After a SACHET refresh, notify about newly-appeared alerts that
// actually cover the citizen's area (not every alert in India).
let _notifiedAlertKeys = new Set();
function notifyNewAreaAlerts() {
  try {
    const active = (AppState.sachetAlerts || [])
      .filter(isAlertActive).filter(alertTouchesKavachArea);
    for (const a of active) {
      const key = (a.id || a.link || a.event || '') + '|' + (a.effective || a.pubDate || '');
      if (!key || _notifiedAlertKeys.has(key)) continue;
      _notifiedAlertKeys.add(key);
      if (a.source === 'BROADCAST') continue; // broadcast path notifies itself
      kavachNotify(
        `⚠ ${severityLabel(a.severity)} — ${(a.event || 'Weather alert').slice(0, 48)}`,
        (a.areaDesc || '').slice(0, 90),
        { tag: 'sachet-' + key, severity: a.severity, onClick: () => showScreen('alert-history') }
      );
    }
  } catch (_) {}
  // alerts may have arrived after the dashboard opened — ask the
  // "are you safe?" question now if one covers the user's city.
  try { maybeAskWellnessCheck(); } catch (_) {}
}

// ══════════════════════════════════════════════════════════════
//  AUTHORITY BROADCAST  →  local SACHET alert + polygon + push
// ══════════════════════════════════════════════════════════════
const KAVACH_BCAST_KEY = 'kavach_broadcast_alerts';

function _bcastCircleRing(lat, lng, radiusKm, n = 36) {
  const ring = [];
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    ring.push([lat + dLat * Math.sin(a), lng + dLng * Math.cos(a)]);
  }
  return ring;
}

function _broadcastToAlert(p) {
  const now = Date.now();
  let poly = Array.isArray(p.polygon) && p.polygon.length >= 3
    ? p.polygon.map(pt => Array.isArray(pt) ? [Number(pt[0]), Number(pt[1])] : [Number(pt.lat), Number(pt.lng)])
    : null;
  if (!poly && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
    poly = _bcastCircleRing(Number(p.lat), Number(p.lng), Number(p.radius_km) || 10);
  }
  return {
    id: p.id || 'BCAST-' + (p.timestamp || now),
    source: 'BROADCAST',
    isBroadcast: true,
    severity: ({ moderate: 'moderate', high: 'severe', severe: 'extreme', low: 'minor' })[String(p.severity || '').toLowerCase()]
              || normSeverity(p.severity || 'severe'),
    event: p.event || 'Authority Emergency Broadcast',
    title: p.event || 'Authority Emergency Broadcast',
    headline: p.headline || p.message || '',
    description: p.description || p.headline || '',
    areaDesc: p.area || p.district || p.areaDesc || 'Your area',
    instruction: p.instruction || 'Follow instructions from local authorities.',
    formUrl: p.form_url || '',
    tollFree: p.toll_free || '1078',
    sender: 'RESQNET Command Centre',
    effective: new Date(p.timestamp || now).toISOString(),
    onset: new Date(p.timestamp || now).toISOString(),
    expires: new Date(p.expires_at || (now + 6 * 3600 * 1000)).toISOString(),
    pubDate: new Date(p.timestamp || now).toISOString(),
    polygon: poly,
    circle: (!poly && Number.isFinite(p.lat) && Number.isFinite(p.lng))
      ? { lat: Number(p.lat), lng: Number(p.lng), radiusKm: Number(p.radius_km) || 10 } : undefined,
    link: '#',
    capLoaded: true,
  };
}

function _loadPersistedBroadcasts() {
  try {
    const arr = JSON.parse(localStorage.getItem(KAVACH_BCAST_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter(p => !p.expires_at || Date.now() < p.expires_at) : [];
  } catch (_) { return []; }
}
function _savePersistedBroadcasts(list) {
  try { localStorage.setItem(KAVACH_BCAST_KEY, JSON.stringify(list.slice(0, 12))); } catch (_) {}
}

// Merge stored, still-valid authority broadcasts into the alert list
// (called after every SACHET fetch so they are never lost).
function mergePersistedBroadcastAlerts() {
  const stored = _loadPersistedBroadcasts();
  if (!stored.length) return;
  AppState.sachetAlerts = AppState.sachetAlerts || [];
  for (const p of stored) {
    const a = _broadcastToAlert(p);
    if (!AppState.sachetAlerts.some(x => x.id === a.id)) AppState.sachetAlerts.unshift(a);
  }
}

// True only if this broadcast is for the citizen's registered city.
// Used to reject Kanpur broadcasts on a Bhubaneswar phone even when
// they arrive over the same-browser localStorage / BroadcastChannel.
function broadcastForMe(payload) {
  const area = kavachUserArea();
  if (!area.district && !area.state && area.lat == null) return true;

  const d = _kvNorm(area.district);
  const hay = _kvNorm(`${payload.district || ''} ${payload.area || ''} ${payload.headline || ''} ${payload.description || ''}`);
  if (d && hay && (hay.includes(d) || d.includes(_kvNorm(payload.district || payload.area || '')))) return true;
  if (area.state && !area.district && payload.state && _kvNorm(area.state) === _kvNorm(payload.state)) return true;

  if (area.lat != null && area.lng != null) {
    if (Number.isFinite(payload.lat) && Number.isFinite(payload.lng) &&
        haversineKm(area.lat, area.lng, Number(payload.lat), Number(payload.lng)) <= (Number(payload.radius_km) || 15) + 10) return true;
    if (Array.isArray(payload.polygon) && payload.polygon.length >= 3 &&
        pointInPolygon(area.lat, area.lng, payload.polygon)) return true;
    return false;   // have a point, not inside → not for me
  }
  return !area.district;   // district set but no match → not for me
}
window.broadcastForMe = broadcastForMe;

// Entry point used by both the Firestore bridge and the same-browser
// bridge. opts.alert === true means "this just arrived" (siren + push).
function kavachIngestBroadcast(payload, opts = {}) {
  if (!payload) return;
  if (!broadcastForMe(payload)) {
    console.info('[kavach] broadcast ignored — not for this city:', payload.area || payload.district);
    return;
  }

  // persist (dedupe by id)
  const store = _loadPersistedBroadcasts().filter(p => (p.id || '') !== (payload.id || ''));
  store.unshift({
    id: payload.id || 'BCAST-' + (payload.timestamp || Date.now()),
    severity: payload.severity, area: payload.area, district: payload.district,
    state: payload.state, lat: payload.lat, lng: payload.lng, radius_km: payload.radius_km,
    polygon: payload.polygon, event: payload.event, headline: payload.headline,
    message: payload.message, instruction: payload.instruction,
    description: payload.description || payload.headline || '',
    form_url: payload.form_url || '', toll_free: payload.toll_free || '1078',
    timestamp: payload.timestamp || Date.now(),
    expires_at: payload.expires_at || (Date.now() + 6 * 3600 * 1000),
  });
  _savePersistedBroadcasts(store);

  // merge into the live alert list + redraw everything
  const a = _broadcastToAlert(payload);
  AppState.sachetAlerts = (AppState.sachetAlerts || []).filter(x => x.id !== a.id);
  AppState.sachetAlerts.unshift(a);
  AppState.sachetUnavailable = false;
  try { renderSACHETPanel(false); } catch (_) {}
  try { renderOfficialAlertZones(); } catch (_) {}
  try { updateHomeAlertFromSACHET(); } catch (_) {}
  try { updateBellDot(); } catch (_) {}
  try { maybeAskWellnessCheck(); } catch (_) {}

  if (opts.alert !== false) {
    // First real broadcast is a natural moment to ask for push perms.
    try { if (kavachNotifyState() === 'default') kavachEnsureNotifyPermission(true); } catch (_) {}
    const sev = (payload.severity || 'severe').toUpperCase();
    kavachNotify(
      `📡 ${sev} emergency broadcast`,
      `${a.areaDesc} — ${a.instruction}`.slice(0, 120),
      { tag: 'bcast-' + a.id, severity: a.severity, toast: 'warning',
        onClick: () => showScreen('alert-history') }
    );
    // full siren + CBS popup via the existing flow
    try { handleIncomingBroadcast({ ...payload, type: 'SACHET_BROADCAST', _fromIngest: true }); } catch (_) {}
  }
}
window.kavachIngestBroadcast = kavachIngestBroadcast;


// ── Main Website → Kavach Simulator bridge ──────────────────
function handleIncomingBroadcast(payload) {
  if (!payload || payload.type !== 'SACHET_BROADCAST') return;
  // City scope: ignore a broadcast meant for a different city (this is
  // the same-browser bridge path — no upstream reach check).
  if (!payload._fromIngest && typeof broadcastForMe === 'function' && !broadcastForMe(payload)) {
    console.info('[kavach] same-browser broadcast ignored — not for this city');
    return;
  }

  const severity = payload.severity || 'high';

  // Auto-login if no user session
  if (!AppState.currentUser) {
    AppState.currentUser = MockDB.users[0];
    localStorage.setItem('kavach_user', JSON.stringify(AppState.currentUser));
  }

  // Turn the broadcast into a real, persistent SACHET alert + map
  // polygon (unless we were called *from* kavachIngestBroadcast, which
  // already did that — avoid a loop).
  if (!payload._fromIngest && typeof kavachIngestBroadcast === 'function') {
    kavachIngestBroadcast(payload, { alert: false });
  }

  // Set severity on demo panel and trigger full broadcast flow
  AppState.sachetBroadcast.severity = severity;
  const sevTab = document.querySelector(`.dbp-sev-tab[data-sev="${severity}"]`);
  if (sevTab) selectBroadcastSeverity(sevTab);

  triggerEmergencyBroadcast(payload); // CBS popup + siren, using the payload's city/description/form link

  // kavachIngestBroadcast already pushed a notification when it called
  // us — only notify here for the raw same-browser bridge path.
  if (!payload._fromIngest) {
    kavachNotify(
      `📡 SACHET broadcast — ${severity.toUpperCase()}`,
      (payload.area ? payload.area + ' · ' : '') + 'From RESQNET Command Centre',
      { tag: 'bcast-' + (payload.id || payload.timestamp), severity: payload.severity, toast: 'warning' }
    );
  }
}

// ═══════════════════════════════════════════════════════════
//  ROBUST BRIDGE: Polling + storage event + BroadcastChannel
//  Works with file://, Live Server, and any HTTP server.
//  localStorage events do NOT fire in the same tab AND often
//  fail with file:// protocol cross-tab. Polling is reliable.
// ═══════════════════════════════════════════════════════════

let _lastSeenTimestamp = 0;   // tracks the last processed broadcast

function pollForBroadcast() {
  const KEYS = ['kavach_sachet_trigger', 'kavach_last_alert'];
  for (const key of KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const payload = JSON.parse(raw);
      if (!payload || payload.type !== 'SACHET_BROADCAST') continue;
      const ts = payload.timestamp || 0;
      if (ts > _lastSeenTimestamp) {
        _lastSeenTimestamp = ts;
        handleIncomingBroadcast(payload);
        break; // only fire once per poll cycle
      }
    } catch (_) {}
  }
}

// Start polling as soon as DOM is ready (1-second interval is fast enough)
document.addEventListener('DOMContentLoaded', () => {
  setInterval(pollForBroadcast, 1000);
  // Deep link from the broadcast / SMS form link: kavach.html#report
  handleReportDeepLink();
});
window.addEventListener('hashchange', handleReportDeepLink);

function handleReportDeepLink() {
  const h = (window.location.hash || '').toLowerCase();
  if (h !== '#report' && h !== '#form') return;

  // The form link is followed from an SMS/CBS alert, so the app is
  // usually cold: wait for boot, sign the demo user in if nobody is
  // logged in (otherwise the form opens behind the login screen), and
  // retry for a few seconds rather than firing once on a guessed delay.
  let tries = 0;
  const open = () => {
    tries += 1;

    if (!AppState.currentUser) {
      const saved = (() => {
        try { return JSON.parse(localStorage.getItem('kavach_user') || 'null'); }
        catch (_) { return null; }
      })();
      if (saved) AppState.currentUser = saved;
      else if (tries > 6 && Array.isArray(MockDB.users) && MockDB.users[0]) {
        AppState.currentUser = MockDB.users[0];   // demo fallback
      }
    }

    if (AppState.currentUser && typeof openCitizenRegister === 'function') {
      openCitizenRegister();
      try { window.history.replaceState(null, '', window.location.pathname); } catch (_) {}
      return;
    }

    if (tries < 20) { setTimeout(open, 400); return; }

    // Last resort — never leave the citizen on a dead link.
    if (typeof openEmergencyForm === 'function') openEmergencyForm();
    try { window.history.replaceState(null, '', window.location.pathname); } catch (_) {}
  };

  setTimeout(open, AppState.currentUser ? 300 : 1200);
}

// Also listen for storage events (works when served from HTTP)
window.addEventListener('storage', e => {
  if (e.key === 'kavach_sachet_trigger' || e.key === 'kavach_last_alert') {
    try {
      const payload = JSON.parse(e.newValue || 'null');
      if (!payload) return;
      const ts = payload.timestamp || 0;
      if (ts > _lastSeenTimestamp) {
        _lastSeenTimestamp = ts;
        handleIncomingBroadcast(payload);
      }
    } catch (_) {}
  }
});

// Also receive via BroadcastChannel (HTTP same-origin, cross-tab)
try {
  const kavachBC = new BroadcastChannel('kavach_sms_bridge');
  kavachBC.onmessage = evt => {
    const payload = evt.data;
    if (!payload) return;
    const ts = payload.timestamp || 0;
    if (ts > _lastSeenTimestamp) {
      _lastSeenTimestamp = ts;
      handleIncomingBroadcast(payload);
    }
  };
} catch (_) { /* BroadcastChannel not available */ }
