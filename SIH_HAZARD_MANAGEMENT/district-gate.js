/* ============================================================
   DISTRICT GATE
   ------------------------------------------------------------
   Gates the RESQNET dashboard behind a state + district choice,
   then scopes the dashboard to that district only:

     - real police stations / hospitals / fire stations for that
       district, fetched live from OpenStreetMap (Overpass API) --
       no bundled dataset, no local server
     - those same resources registered with the AI backend
       (SIH_HAZARD_MANAGEMENT_ai) via POST /resources/bulk, so
       /allocate uses the real locations this page shows
     - the "Resource Readiness" panel rendered from that real data
     - the existing Azure map (untouched -- this only calls its
       already-exposed window.azureMapInstance) recentred to the
       district

   NOT done here yet (next phase, by design):
     - filtering the SACHET/IMD alert feed to only the selected
       district (this module exposes window.resqnetPointInDistrict
       and window.resqnetDistrict for that to hook into later)
     - a dedicated Google Maps relocation-simulation panel
     - pushing AI allocation decisions back into the Kavach
       simulator's live feed
   ============================================================ */

// Default "/api" — Firebase Hosting rewrites it to the resqnet-ai Cloud Run
// service (config.js is the single edit point; this only bites if it failed to load).
const AI_API_BASE = (window.RESQNET_AI_API_BASE || '/api').replace(/\/+$/, '');

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

// Photon (komoot) — free, CORS-enabled OSM geocoder with osm_tag +
// bbox filtering. The most reliable no-key source for facilities.
const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/';

const STORAGE_KEY = 'resqnet_district_selection';

const OVERPASS_TIMEOUT_MS = 15000;

// ------------------------------------------------------------
// localStorage cache — district list, boundary and discovered
// resources rarely change, so cache them and make re-selecting a
// district (and the saved-selection reload on every visit) instant.
// ------------------------------------------------------------
const CACHE_PREFIX = 'resqnet_cache_';
const DAY_MS = 86400000;
const CACHE_TTL = { districts: 30 * DAY_MS, boundary: 30 * DAY_MS, resources: 7 * DAY_MS };

function cacheKey(kind, parts) {
  return CACHE_PREFIX + kind + '_' + parts.join('|').toLowerCase().replace(/\s+/g, '-');
}
function cacheGet(kind, ...parts) {
  try {
    const raw = localStorage.getItem(cacheKey(kind, parts));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.t > (CACHE_TTL[kind] || 7 * DAY_MS)) return null;
    return entry.v;
  } catch (_) {
    return null;
  }
}
function cacheSet(kind, value, ...parts) {
  try {
    localStorage.setItem(cacheKey(kind, parts), JSON.stringify({ v: value, t: Date.now() }));
  } catch (_) {
    /* quota / private mode — cache is best-effort */
  }
}

// ------------------------------------------------------------
// India states + union territories (stable reference list)
// ------------------------------------------------------------
const INDIA_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand',
  'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
  'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
].sort();

// Resource kinds discovered per district. Each kind lists:
//   googleTypes  - Google Places (New) primary types to search
//   keywords     - free-text terms for Photon / Places text search
//   osmTags      - [key, value] pairs to match (Photon osm_tag / Overpass)
//   osmValues    - acceptable osm_value strings for loose matching
//   type         - AI backend resource type (schemas.ResourceTypeLiteral)
const RESOURCE_KINDS = [
  {
    key: 'hospital', type: 'medical_team', capacityPerUnit: 20,
    label: 'Hospitals', icon: 'fa-hospital',
    googleTypes: ['hospital'],
    photonWord: 'hospital',
    keywords: ['hospital', 'nursing home', 'medical college', 'trauma', 'CHC', 'PHC', 'clinic'],
    osmTags: [['amenity', 'hospital'], ['healthcare', 'hospital'], ['amenity', 'clinic'], ['healthcare', 'clinic']],
    osmValues: ['hospital', 'clinic'],
  },
  {
    key: 'ambulance', type: 'ambulance', capacityPerUnit: 4,
    label: 'Ambulance', icon: 'fa-truck-medical',
    googleTypes: [],
    photonWord: 'ambulance',
    keywords: ['ambulance', '108', 'emergency medical'],
    osmTags: [['emergency', 'ambulance_station'], ['amenity', 'ambulance_station'], ['healthcare', 'ambulance_station']],
    osmValues: ['ambulance_station'],
  },
  {
    key: 'police', type: 'police', capacityPerUnit: 6,
    label: 'Police', icon: 'fa-shield-halved',
    googleTypes: ['police'],
    photonWord: 'police',
    keywords: ['police', 'thana', 'chowki', 'chauki', 'outpost'],
    osmTags: [['amenity', 'police'], ['office', 'police'], ['government', 'police']],
    osmValues: ['police'],
  },
  {
    key: 'fire', type: 'fire_brigade', capacityPerUnit: 8,
    label: 'Fire & Rescue', icon: 'fa-fire-extinguisher',
    googleTypes: ['fire_station'],
    photonWord: 'fire',
    keywords: ['fire station', 'fire brigade', 'fire service', 'agnishaman'],
    osmTags: [['amenity', 'fire_station'], ['emergency', 'fire_station']],
    osmValues: ['fire_station'],
  },
];

// ============================================================
// OVERPASS HELPERS
// ============================================================

// Race all Overpass mirrors in parallel; first good response wins.
// A single shared deadline keeps discovery snappy even when a mirror
// hangs (the public instances 504 / stall often).
async function overpassQuery(query, timeoutMs = OVERPASS_TIMEOUT_MS) {
  const attempts = OVERPASS_ENDPOINTS.map((endpoint) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: query,
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Overpass ${response.status} (${endpoint})`);
        return response.json();
      })
      .finally(() => clearTimeout(timer));
  });

  // Promise.any -> first fulfilled; rejects only if all fail.
  return Promise.any(attempts);
}

function escapeOverpassString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function fetchDistrictsForState(stateName) {
  // 1. Bundled reference data (india-districts.js) -- instant, always
  //    populated. This is the normal path.
  const bundled = window.INDIA_DISTRICTS && window.INDIA_DISTRICTS[stateName];
  if (bundled && bundled.length) {
    return { adminLevel: null, districts: bundled.slice() };
  }

  // 2. Cached Overpass result from a previous session.
  const cached = cacheGet('districts', stateName);
  if (cached) return cached;

  // 3. Live Overpass lookup (only if the state isn't in the bundle).
  const escaped = escapeOverpassString(stateName);

  for (const adminLevel of [5, 6]) {
    const query = `
      [out:json][timeout:60];
      area["name"="${escaped}"]["admin_level"="4"]["boundary"="administrative"]->.state;
      relation(area.state)["boundary"="administrative"]["admin_level"="${adminLevel}"];
      out tags;
    `;

    try {
      const data = await overpassQuery(query);
      const names = (data.elements || [])
        .map((el) => el.tags && el.tags.name)
        .filter(Boolean);

      const unique = Array.from(new Set(names)).sort();

      if (unique.length > 0) {
        const result = { adminLevel, districts: unique };
        cacheSet('districts', result, stateName);
        return result;
      }
    } catch (err) {
      console.warn('[district-gate] district list query failed', adminLevel, err);
    }
  }

  return { adminLevel: null, districts: [] };
}

async function fetchDistrictBoundary(stateName, districtName, adminLevel) {
  const escapedState = escapeOverpassString(stateName);
  const escapedDistrict = escapeOverpassString(districtName);
  const levelFilter = adminLevel
    ? `["admin_level"="${adminLevel}"]`
    : `["admin_level"~"^[56]$"]`;

  const query = `
    [out:json][timeout:60];
    area["name"="${escapedState}"]["admin_level"="4"]["boundary"="administrative"]->.state;
    relation(area.state)["boundary"="administrative"]${levelFilter}["name"="${escapedDistrict}"];
    out geom;
  `;

  const data = await overpassQuery(query);
  const relation = (data.elements || []).find((el) => el.type === 'relation');

  if (!relation) {
    throw new Error('District boundary relation not found');
  }

  // Best-effort polygon: concatenate all outer-way points. Good
  // enough for an approximate "is this point in the district"
  // check; not a rigorous multipolygon-with-holes assembly.
  const polygonPoints = [];
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;

  for (const member of relation.members || []) {
    if (member.role !== 'outer' || !member.geometry) continue;
    for (const point of member.geometry) {
      polygonPoints.push([point.lat, point.lon]);
      if (point.lat < minLat) minLat = point.lat;
      if (point.lat > maxLat) maxLat = point.lat;
      if (point.lon < minLon) minLon = point.lon;
      if (point.lon > maxLon) maxLon = point.lon;
    }
  }

  if (relation.bounds) {
    minLat = Math.min(minLat, relation.bounds.minlat);
    maxLat = Math.max(maxLat, relation.bounds.maxlat);
    minLon = Math.min(minLon, relation.bounds.minlon);
    maxLon = Math.max(maxLon, relation.bounds.maxlon);
  }

  if (!isFinite(minLat)) {
    throw new Error('District boundary has no usable geometry');
  }

  return {
    center: { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 },
    bbox: { minLat, maxLat, minLon, maxLon },
    polygonPoints,
  };
}

// Fast boundary lookup (~1-2s): Nominatim returns the bounding box
// always and, for admin areas, a GeoJSON polygon too. Used as the
// primary source so the gate can close quickly; the slower, more
// precise Overpass geometry is only a fallback.
async function fetchDistrictBoundaryFast(stateName, districtName) {
  const q = encodeURIComponent(`${districtName}, ${stateName}, India`);
  const url = `${NOMINATIM_ENDPOINT}?format=jsonv2&limit=1&polygon_geojson=1&q=${q}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Nominatim ${response.status}`);

    const results = await response.json();
    if (!results.length) throw new Error('No Nominatim match');

    const hit = results[0];
    const bb = (hit.boundingbox || []).map(Number); // [south, north, west, east]
    if (bb.length !== 4 || bb.some((n) => !isFinite(n))) {
      throw new Error('Nominatim result has no bounding box');
    }

    const bbox = { minLat: bb[0], maxLat: bb[1], minLon: bb[2], maxLon: bb[3] };
    const center = {
      lat: (bbox.minLat + bbox.maxLat) / 2,
      lon: (bbox.minLon + bbox.maxLon) / 2,
    };

    let polygonPoints = [];
    const gj = hit.geojson;
    if (gj && gj.type === 'Polygon' && gj.coordinates[0]) {
      polygonPoints = gj.coordinates[0].map(([lon, lat]) => [lat, lon]);
    } else if (gj && gj.type === 'MultiPolygon') {
      let largest = [];
      for (const poly of gj.coordinates) {
        const ring = poly[0] || [];
        if (ring.length > largest.length) largest = ring;
      }
      polygonPoints = largest.map(([lon, lat]) => [lat, lon]);
    }

    return { center, bbox, polygonPoints };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// PHOTON DISCOVERY (primary, no key, CORS-enabled)
// ============================================================

async function _photonFetch(params) {
  const url = PHOTON_ENDPOINT + '?' + params.toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(13000) });
  if (!res.ok) throw new Error('Photon ' + res.status);
  const data = await res.json();
  return data.features || [];
}

function _photonFeatureToResource(f, kind, looseOk) {
  const c = f.geometry && f.geometry.coordinates;
  if (!c || c.length < 2) return null;
  const lon = Number(c[0]);
  const lat = Number(c[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const p = f.properties || {};
  const tagMatch = kind.osmTags.some(([k, v]) => p.osm_key === k && p.osm_value === v)
    || (kind.osmValues || []).includes(p.osm_value);
  const nameMatch = p.name && kind.keywords.some((kw) => p.name.toLowerCase().includes(kw.split(' ')[0]));
  if (!tagMatch && !(looseOk && nameMatch)) return null;

  if (typeof window.resqnetPointInDistrict === 'function'
      && !window.resqnetPointInDistrict(lat, lon)) return null;

  return {
    osmId: 'p' + (p.osm_id || `${lat.toFixed(5)},${lon.toFixed(5)}`),
    name: p.name || p.street || `Unnamed ${kind.label}`,
    type: kind.type,
    kindKey: kind.key,
    capacityPerUnit: kind.capacityPerUnit,
    latitude: lat,
    longitude: lon,
    address: [p.street, p.district, p.city, p.state].filter(Boolean).join(', '),
  };
}

async function fetchResourcesOfKindPhoton(district, kind) {
  const b = district.bbox;
  const centre = district.center;
  const results = [];

  const base = () => {
    const q = new URLSearchParams();
    q.set('limit', '50');
    if (centre) { q.set('lat', String(centre.lat)); q.set('lon', String(centre.lon)); }
    if (b) q.set('bbox', `${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}`);
    return q;
  };

  // Photon's text relevance hurts recall, so use ONE short generic
  // word and lean on osm_tag + bbox instead of a descriptive phrase.
  // Pass 1: tag-filtered (strict). Pass 2: no tag filter (loose,
  // catches mistagged POIs, kept only if osm_value/name matches).
  const strict = base();
  strict.set('q', kind.photonWord);
  for (const [k, v] of kind.osmTags) strict.append('osm_tag', `${k}:${v}`);

  const loose = base();
  loose.set('q', kind.photonWord);

  const passes = [_photonFetch(strict), _photonFetch(loose)];
  // Extra keyword pass for kinds where the generic word alone is thin.
  if (kind.keywords.length > 1) {
    const kw = base();
    kw.set('q', kind.keywords.slice(1, 3).join(' '));
    passes.push(_photonFetch(kw));
  }

  const settled = await Promise.allSettled(passes);
  let anyOk = false;
  settled.forEach((s, i) => {
    if (s.status !== 'fulfilled') return;
    anyOk = true;
    for (const f of s.value) {
      const r = _photonFeatureToResource(f, kind, i !== 0);
      if (r) results.push(r);
    }
  });
  if (!anyOk) throw settled[0].reason || new Error('Photon failed');

  return results;
}

async function fetchDistrictResourcesViaPhoton(district) {
  if (!district || !district.bbox) return [];
  const settled = await Promise.allSettled(
    RESOURCE_KINDS.map((kind) => fetchResourcesOfKindPhoton(district, kind))
  );
  const out = [];
  const seen = new Set();
  for (const s of settled) {
    if (s.status !== 'fulfilled') {
      console.warn('[district-gate] Photon kind failed', s.reason && s.reason.message);
      continue;
    }
    for (const r of s.value) {
      if (seen.has(r.osmId)) continue;
      seen.add(r.osmId);
      out.push(r);
    }
  }
  return out;
}

// Overpass discovery, bounded by the district bounding box (much
// lighter and far less 504-prone than an area/map_to_area query),
// then filtered to the district polygon client-side.
async function fetchResourcesOfKind(bbox, kind) {
  const { minLat, minLon, maxLat, maxLon } = bbox;
  const box = `(${minLat},${minLon},${maxLat},${maxLon})`;

  const selectors = kind.osmTags
    .map(([k, v]) => `  nwr["${k}"="${v}"]${box};`)
    .join('\n');

  const query = `[out:json][timeout:45];\n(\n${selectors}\n);\nout center tags;`;

  const data = await overpassQuery(query);
  const out = [];

  for (const el of data.elements || []) {
    const tags = el.tags || {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;

    if (
      typeof window.resqnetPointInDistrict === 'function' &&
      !window.resqnetPointInDistrict(lat, lon)
    ) {
      continue;
    }

    const addr = [tags['addr:street'], tags['addr:city'], tags['addr:district']]
      .filter(Boolean)
      .join(', ');

    out.push({
      osmId: `${el.type[0]}${el.id}`,
      name: tags.name || tags['name:en'] || tags.official_name || `Unnamed ${kind.label}`,
      type: kind.type,
      kindKey: kind.key,
      capacityPerUnit: kind.capacityPerUnit,
      latitude: lat,
      longitude: lon,
      address: addr,
    });
  }

  return out;
}

async function fetchDistrictResources(district) {
  const bbox = district && district.bbox;
  if (!bbox) return [];

  const settled = await Promise.allSettled(
    RESOURCE_KINDS.map((kind) => fetchResourcesOfKind(bbox, kind))
  );

  const resources = [];
  const seen = new Set();
  for (const result of settled) {
    if (result.status !== 'fulfilled') {
      console.warn('[district-gate] resource-kind query failed', result.reason);
      continue;
    }
    for (const r of result.value) {
      if (seen.has(r.osmId)) continue;
      seen.add(r.osmId);
      resources.push(r);
    }
  }

  return resources;
}

// Merge facility lists from different sources, treating two entries
// of the same kind within ~150 m as the same facility. Google entries
// win on name/address; OSM fills gaps.
function mergeResources(primary, secondary) {
  const out = [];

  const near = (a, b) => {
    if (a.type !== b.type) return false;
    const dLat = (a.latitude - b.latitude) * 111000;
    const dLon = (a.longitude - b.longitude) * 111000 * Math.cos((a.latitude * Math.PI) / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon) < 150;
  };

  for (const list of [primary, secondary]) {
    for (const r of list || []) {
      if (r.latitude == null || r.longitude == null) continue;
      const dup = out.find((o) => near(o, r));
      if (dup) {
        if (!dup.address && r.address) dup.address = r.address;
        if (/^Unnamed /.test(dup.name) && !/^Unnamed /.test(r.name)) dup.name = r.name;
        continue;
      }
      out.push({ ...r });
    }
  }

  return out;
}

// Fallback geocoder if the Overpass boundary lookup fails entirely
// (e.g. Overpass is down) -- gives at least a centre point so the
// map can still recentre, even without a boundary/resource list.
async function nominatimFallbackCenter(stateName, districtName) {
  const url = `${NOMINATIM_ENDPOINT}?format=json&limit=1&q=${encodeURIComponent(`${districtName}, ${stateName}, India`)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Nominatim ${response.status}`);
    const results = await response.json();
    if (!results.length) throw new Error('No Nominatim match');
    return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// GOOGLE PLACES DISCOVERY (primary source for facilities)
// ------------------------------------------------------------
// Uses the Places library of the Maps JS API (CORS-free, unlike the
// Places web service). Searches around the district centre for
// hospital / police / fire_station, then keeps only the results that
// fall inside the district boundary.
//
// Prefers the New Places API (google.maps.places.Place.searchNearby)
// because the legacy PlacesService is not available to Google Cloud
// projects created after March 2025. Falls back to legacy, then the
// caller falls back to OpenStreetMap/Overpass.
// ============================================================

function _dedupeById(resources) {
  const seen = new Set();
  return resources.filter((r) => {
    if (seen.has(r.osmId)) return false;
    seen.add(r.osmId);
    return true;
  });
}

function _districtSearchRadius(district, gmaps) {
  let radius = 30000;
  if (district.bbox && gmaps.geometry) {
    const b = district.bbox;
    const diagMeters = gmaps.geometry.spherical.computeDistanceBetween(
      new gmaps.LatLng(b.minLat, b.minLon),
      new gmaps.LatLng(b.maxLat, b.maxLon)
    );
    radius = Math.min(50000, Math.max(5000, Math.round(diagMeters / 2)));
  }
  return radius;
}

function _mapNewPlaces(places) {
  return (places || []).map((p) => {
    const loc = p.location;
    return {
      place_id: p.id,
      name: typeof p.displayName === 'string' ? p.displayName : (p.displayName?.text || ''),
      address: p.formattedAddress || '',
      lat: typeof loc?.lat === 'function' ? loc.lat() : loc?.lat,
      lng: typeof loc?.lng === 'function' ? loc.lng() : loc?.lng,
    };
  });
}

// --- New Places API: Nearby Search -----------------------------------
async function _searchNearbyNew(gmaps, centerLat, centerLng, radius, primaryTypes) {
  const Place = gmaps.places && gmaps.places.Place;
  if (!Place || typeof Place.searchNearby !== 'function') {
    throw new Error('Places API (New) unavailable');
  }
  if (!primaryTypes || !primaryTypes.length) return [];

  const rankPref = gmaps.places.SearchNearbyRankPreference;
  const { places } = await Place.searchNearby({
    fields: ['displayName', 'location', 'formattedAddress'],
    locationRestriction: { center: { lat: centerLat, lng: centerLng }, radius },
    includedPrimaryTypes: primaryTypes,
    maxResultCount: 20,
    rankPreference: rankPref ? rankPref.POPULARITY : undefined,
  });
  return _mapNewPlaces(places);
}

// --- New Places API: Text Search (for kinds with no Places type,
//     e.g. ambulance services, and as a supplement) -----------------
async function _searchByTextNew(gmaps, centerLat, centerLng, radius, textQuery) {
  const Place = gmaps.places && gmaps.places.Place;
  if (!Place || typeof Place.searchByText !== 'function') {
    throw new Error('Places API (New) text search unavailable');
  }
  const { places } = await Place.searchByText({
    fields: ['displayName', 'location', 'formattedAddress'],
    textQuery,
    locationBias: { center: { lat: centerLat, lng: centerLng }, radius },
    maxResultCount: 20,
  });
  return _mapNewPlaces(places);
}

// --- Legacy PlacesService (older projects only) -----------------------
function _searchNearbyLegacy(gmaps, centerLat, centerLng, radius, placeType) {
  return new Promise((resolve) => {
    let service;
    try {
      service = new gmaps.places.PlacesService(document.createElement('div'));
    } catch (_) {
      return resolve([]);
    }
    const acc = [];
    let pages = 0;
    const handle = (results, status, pagination) => {
      if (status === gmaps.places.PlacesServiceStatus.OK && Array.isArray(results)) {
        for (const p of results) {
          const loc = p.geometry && p.geometry.location;
          acc.push({
            place_id: p.place_id,
            name: p.name || '',
            address: p.vicinity || p.formatted_address || '',
            lat: loc ? (typeof loc.lat === 'function' ? loc.lat() : loc.lat) : null,
            lng: loc ? (typeof loc.lng === 'function' ? loc.lng() : loc.lng) : null,
          });
        }
      }
      pages += 1;
      if (pagination && pagination.hasNextPage && pages < 3) {
        setTimeout(() => pagination.nextPage(), 2200);
      } else {
        resolve(acc);
      }
    };
    service.nearbySearch(
      { location: new gmaps.LatLng(centerLat, centerLng), radius, type: placeType },
      handle
    );
  });
}

async function fetchDistrictResourcesViaGoogle(district) {
  if (!district || !district.center) throw new Error('No district centre for Places lookup');
  if (typeof window.resqnetLoadGoogleMaps !== 'function') {
    throw new Error('resqnetLoadGoogleMaps unavailable (config.js not loaded?)');
  }

  const gmaps = await window.resqnetLoadGoogleMaps('places,geometry');
  const centerLat = district.center.lat;
  const centerLng = district.center.lon;
  const radius = _districtSearchRadius(district, gmaps);
  const areaQuery = `${district.district}, ${district.state}, India`;

  const resources = [];

  for (const kind of RESOURCE_KINDS) {
    const hits = [];

    // 1. Nearby Search on the Places types (if any)
    if (kind.googleTypes.length) {
      try {
        hits.push(...await _searchNearbyNew(gmaps, centerLat, centerLng, radius, kind.googleTypes));
      } catch (err) {
        console.warn('[district-gate] Nearby (New) failed for', kind.key, err.message);
        try {
          hits.push(...await _searchNearbyLegacy(gmaps, centerLat, centerLng, radius, kind.googleTypes[0]));
        } catch (_) { /* fall through */ }
      }
    }

    // 2. Text Search — the only route for ambulances, and a useful
    //    supplement for the others (catches places Nearby misses).
    if (kind.keywords && kind.keywords.length) {
      try {
        hits.push(...await _searchByTextNew(gmaps, centerLat, centerLng, radius, `${kind.keywords[0]} in ${areaQuery}`));
      } catch (err) {
        console.warn('[district-gate] Text (New) failed for', kind.key, err.message);
      }
    }

    for (const p of hits) {
      if (p.lat == null || p.lng == null) continue;

      // Keep only facilities actually inside the selected district.
      if (
        typeof window.resqnetPointInDistrict === 'function' &&
        !window.resqnetPointInDistrict(p.lat, p.lng)
      ) {
        continue;
      }

      resources.push({
        osmId: 'g' + (p.place_id || `${p.lat},${p.lng}`),
        name: p.name || `Unnamed ${kind.label}`,
        type: kind.type,
        kindKey: kind.key,
        capacityPerUnit: kind.capacityPerUnit,
        latitude: p.lat,
        longitude: p.lng,
        address: p.address || '',
      });
    }
  }

  return _dedupeById(resources);
}

// ============================================================
// POINT-IN-DISTRICT (best-effort, exposed for future SACHET
// filtering integration)
// ============================================================

function pointInPolygon(lat, lon, polygonPoints) {
  let inside = false;
  for (let i = 0, j = polygonPoints.length - 1; i < polygonPoints.length; j = i++) {
    const [latI, lonI] = polygonPoints[i];
    const [latJ, lonJ] = polygonPoints[j];
    const intersects =
      (lonI > lon) !== (lonJ > lon) &&
      lat < ((latJ - latI) * (lon - lonI)) / (lonJ - lonI) + latI;
    if (intersects) inside = !inside;
  }
  return inside;
}

window.resqnetPointInDistrict = function resqnetPointInDistrict(lat, lon) {
  const district = window.resqnetDistrict;
  if (!district) return true; // no district selected yet -- don't filter anything out

  const { bbox, polygonPoints } = district;
  if (!bbox) return true;

  const inBbox =
    lat >= bbox.minLat && lat <= bbox.maxLat &&
    lon >= bbox.minLon && lon <= bbox.maxLon;

  if (!inBbox) return false;
  if (!polygonPoints || polygonPoints.length < 3) return true; // bbox-only fallback

  return pointInPolygon(lat, lon, polygonPoints);
};

// ============================================================
// AI BACKEND WIRING
// ============================================================

async function postResourcesToBackend(stateName, districtName, resources) {
  const payload = {
    state: stateName,
    district: districtName,
    resources: resources.map((r) => ({
      name: r.name,
      type: r.type,
      latitude: r.latitude,
      longitude: r.longitude,
      total_units: 1,
      available_units: 1,
      capacity_per_unit: r.capacityPerUnit,
      state: stateName,
      district: districtName,
    })),
  };

  const response = await fetch(`${AI_API_BASE}/resources/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`AI backend /resources/bulk responded ${response.status}`);
  }

  return response.json();
}

async function fetchBackendResources(districtName) {
  const response = await fetch(
    `${AI_API_BASE}/resources?district=${encodeURIComponent(districtName)}`
  );
  if (!response.ok) throw new Error(`AI backend /resources responded ${response.status}`);
  return response.json();
}

// ============================================================
// RESOURCE READINESS PANEL
// ============================================================

function renderResourceReadiness(discovered, backendResources, backendReachable) {
  const summaryEl = document.getElementById('resource-readiness-summary');
  const cardsEl = document.getElementById('resource-readiness-cards');
  if (!summaryEl || !cardsEl) return;

  const byType = {};
  for (const kind of RESOURCE_KINDS) byType[kind.type] = [];

  const source = backendReachable && backendResources.length ? backendResources : null;

  if (source) {
    for (const r of source) {
      if (byType[r.type]) byType[r.type].push(r);
    }
  } else {
    for (const r of discovered) {
      if (byType[r.type]) byType[r.type].push({ ...r, available_units: 1, total_units: 1 });
    }
  }

  const totalFacilities = discovered.length;
  const totalAvailable = source
    ? source.reduce((sum, r) => sum + (r.available_units || 0), 0)
    : totalFacilities;

  const srcLabel = window.resqnetDistrictResourceSource || 'Google Maps';
  summaryEl.innerHTML = `
    <span class="flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-brand-green"></span> ${totalAvailable} Available</span>
    <span class="text-gray-300">|</span>
    <span class="flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-white/60"></span> ${totalFacilities} Facilities discovered (${srcLabel})</span>
    ${backendReachable ? '' : '<span class="text-yellow-200 text-[11px]">&#9888; AI backend not reachable -- showing facility data only, no allocation link</span>'}
  `;

  const cards = RESOURCE_KINDS.map((kind, index) => {
    const items = byType[kind.type] || [];
    const available = source
      ? items.reduce((sum, r) => sum + (r.available_units || 0), 0)
      : items.length;
    const total = source
      ? items.reduce((sum, r) => sum + (r.total_units || 0), 0)
      : items.length;
    const deployed = Math.max(0, total - available);
    const readinessPct = total > 0 ? Math.round((available / total) * 100) : 0;

    const namesList = items.map((r) => {
      const addr = r.address ? `<div class="text-[9px] text-gray-400 truncate">${escapeHtml(r.address)}</div>` : '';
      const coords = (r.latitude != null && r.longitude != null)
        ? `<div class="text-[9px] text-gray-300">${Number(r.latitude).toFixed(5)}, ${Number(r.longitude).toFixed(5)}</div>`
        : '';
      const tag = r.synthesized ? ' <span class="text-[8px] text-amber-500 font-bold">DERIVED</span>' : '';
      return `<div class="py-1 border-b border-gray-50 last:border-0">
        <div class="flex justify-between text-[10px]"><span class="text-gray-700 font-medium truncate pr-2">${escapeHtml(r.name)}${tag}</span><span class="text-brand-green font-bold shrink-0">${(r.available_units ?? 1) > 0 ? 'Available' : 'Busy'}</span></div>
        ${addr}${coords}
      </div>`;
    }).join('');

    return `
      <div class="group cursor-pointer p-5 bg-white rounded-xl border-2 border-gray-100 hover:border-brand-orange transition-all shadow-sm relative overflow-hidden">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-10 h-10 rounded-lg bg-brand-orangeLight flex items-center justify-center text-brand-orange"><i class="fa-solid ${kind.icon} text-lg"></i></div>
          <h4 class="font-bold text-brand-blue">${kind.label}</h4>
          <span class="ml-auto text-xs font-bold text-gray-400">${items.length} found</span>
        </div>
        <div class="flex justify-between text-xs mb-4">
          <div><div class="text-gray-400 font-medium">Available</div><div class="text-lg font-bold text-gray-900">${available}</div></div>
          <div><div class="text-gray-400 font-medium text-right">Deployed</div><div class="text-lg font-bold text-gray-900 text-right">${deployed}</div></div>
        </div>
        <div class="space-y-1">
          <div class="flex justify-between text-[10px] font-bold uppercase tracking-tighter"><span class="text-gray-500">Readiness</span><span class="text-brand-green">${readinessPct}%</span></div>
          <div class="w-full bg-gray-100 rounded-full h-1.5"><div class="bg-brand-green h-1.5 rounded-full" style="width: ${readinessPct}%"></div></div>
        </div>
        <div class="mt-4 pt-4 border-t border-gray-50">
          <div class="text-[9px] font-bold uppercase tracking-wide text-gray-400 mb-1">Facilities</div>
          <div class="space-y-1 max-h-40 overflow-y-auto pr-1" style="scrollbar-width:thin">${namesList || '<div class="text-[10px] text-gray-400">None found in this district.</div>'}</div>
        </div>
      </div>
    `;
  });

  cardsEl.innerHTML = cards.join('');
}

window.renderResourceReadiness = renderResourceReadiness;

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

// ============================================================
// AZURE MAP RECENTRE (only touches the already-exposed instance,
// never re-initialises or modifies script.js's own map setup)
// ============================================================

function recenterAzureMapWhenReady(center, bbox, polygonPoints) {
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    const mapInstance = window.azureMapInstance;

    if (mapInstance && typeof mapInstance.setCamera === 'function') {
      clearInterval(timer);
      try {
        if (bbox) {
          // Small margin so the district edges are reachable, then
          // lock the camera to it -- the operator cannot pan or zoom
          // out of their allotted district.
          const mLat = (bbox.maxLat - bbox.minLat) * 0.08 || 0.05;
          const mLon = (bbox.maxLon - bbox.minLon) * 0.08 || 0.05;
          const maxBounds = [
            bbox.minLon - mLon, bbox.minLat - mLat,
            bbox.maxLon + mLon, bbox.maxLat + mLat,
          ];
          mapInstance.setCamera({
            bounds: [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat],
            padding: 40,
          });
          const currentZoom = mapInstance.getCamera && mapInstance.getCamera().zoom;
          mapInstance.setCamera({
            maxBounds,
            minZoom: currentZoom ? Math.max(3, currentZoom - 1.5) : 7,
            maxZoom: 18,
          });
        } else {
          mapInstance.setCamera({ center: [center.lon, center.lat], zoom: 9 });
        }
        drawDistrictBoundaryOnAzure(mapInstance, polygonPoints);
      } catch (err) {
        console.warn('[district-gate] failed to recentre Azure map', err);
      }
      return;
    }

    if (attempts > 60) clearInterval(timer); // ~30s, give up quietly
  }, 500);
}

// Outlines the selected district on the Azure map so the operator
// sees the area everything is scoped to. Reuses one DataSource so a
// "Change district" redraw replaces the previous outline.
function drawDistrictBoundaryOnAzure(mapInstance, polygonPoints) {
  const atlas = window.atlas;
  if (!atlas || !polygonPoints || polygonPoints.length < 3) return;

  try {
    let src = window.resqnetDistrictBoundarySource;
    if (!src) {
      src = new atlas.source.DataSource('resqnet-district-boundary');
      mapInstance.sources.add(src);
      mapInstance.layers.add(
        new atlas.layer.LineLayer(src, 'resqnet-district-boundary-line', {
          strokeColor: '#1c3655',
          strokeWidth: 3,
          strokeDashArray: [3, 2],
        })
      );
      window.resqnetDistrictBoundarySource = src;
    }

    src.clear();
    const ring = polygonPoints.map(([lat, lon]) => [Number(lon), Number(lat)]);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    src.add(new atlas.data.Feature(new atlas.data.LineString(ring)));
  } catch (err) {
    console.warn('[district-gate] failed to draw district boundary', err);
  }
}

// Marker styling per resource type for both the Azure map and the
// relocation-simulation Google map.
const RESOURCE_MARKER_STYLE = {
  medical_team:  { color: '#d32f2f', glyph: 'H', title: 'Hospital' },
  ambulance:     { color: '#00897b', glyph: 'A', title: 'Ambulance service' },
  police:        { color: '#1565c0', glyph: 'P', title: 'Police station' },
  fire_brigade:  { color: '#e65100', glyph: 'F', title: 'Fire station' },
};

// Drops a pin for every discovered hospital / police / fire station on
// the Azure map. Reuses one HtmlMarker array so a "Change district"
// redraw clears the previous set first.
// Bumped on every district switch / discovery run. A slow discovery
// that finishes after the operator moved on must not repaint stale pins.
let _resMarkerGen = 0;
let _resMarkerTimer = null;

// Operator toggle: facility pins are useful context but a district can
// have 60+ of them, which buries the live complaint dots. Off hides
// them without discarding the data.
window.resqnetShowFacilities = window.resqnetShowFacilities !== false;

function applyFacilityVisibility() {
  const show = window.resqnetShowFacilities !== false;
  for (const m of window.resqnetResourceMarkers || []) {
    try {
      const el = m.getElement && m.getElement();
      if (el) el.style.display = show ? '' : 'none';
    } catch (_) {}
  }
  const btn = document.getElementById('facility-toggle');
  if (btn) {
    btn.dataset.on = show ? 'true' : 'false';
    btn.style.opacity = show ? '1' : '.5';
  }
}

function toggleFacilityMarkers() {
  window.resqnetShowFacilities = window.resqnetShowFacilities === false;
  applyFacilityVisibility();
}

window.toggleFacilityMarkers = toggleFacilityMarkers;
window.applyFacilityVisibility = applyFacilityVisibility;

function clearResourceMarkersOnAzure() {
  const map = window.azureMapInstance;
  for (const m of window.resqnetResourceMarkers || []) {
    if (map && map.markers) { try { map.markers.remove(m); } catch (_) {} }
  }
  window.resqnetResourceMarkers = [];
  if (_resMarkerTimer) { clearInterval(_resMarkerTimer); _resMarkerTimer = null; }
}

function drawResourceMarkersOnAzure(resources) {
  const myGen = ++_resMarkerGen;
  clearResourceMarkersOnAzure();       // drop the previous district's pins now
  let attempts = 0;
  _resMarkerTimer = setInterval(() => {
    attempts += 1;
    if (myGen !== _resMarkerGen) { clearInterval(_resMarkerTimer); return; }
    const map = window.azureMapInstance;
    if (map && map.markers && window.atlas) {
      clearInterval(_resMarkerTimer);
      _resMarkerTimer = null;
      try {
        for (const m of window.resqnetResourceMarkers || []) {
          try { map.markers.remove(m); } catch (_) {}
        }
        window.resqnetResourceMarkers = [];

        for (const r of resources || []) {
          if (r.latitude == null || r.longitude == null) continue;
          const s = RESOURCE_MARKER_STYLE[r.type] || { color: '#455a64', glyph: '?', title: 'Facility' };
          // Facilities are static CONTEXT, not the operational signal.
          // They stay small and semi-transparent so the live
          // complaint-density dots underneath stay readable (an
          // HtmlMarker always paints above canvas layers).
          const marker = new window.atlas.HtmlMarker({
            position: [Number(r.longitude), Number(r.latitude)],
            htmlContent:
              `<div class="resqnet-facility-pin" title="${(r.name || s.title).replace(/"/g, '&quot;')}" ` +
              `style="width:13px;height:13px;border-radius:50% 50% 50% 0;` +
              `background:${s.color};border:1.5px solid rgba(255,255,255,.9);transform:rotate(-45deg);` +
              `opacity:.62;box-shadow:0 1px 3px rgba(0,0,0,.25);` +
              `display:flex;align-items:center;justify-content:center">` +
              `<span style="transform:rotate(45deg);color:#fff;font:700 7px sans-serif">${s.glyph}</span></div>`,
          });
          map.markers.add(marker);
          window.resqnetResourceMarkers.push(marker);
        }

        applyFacilityVisibility();
      } catch (err) {
        console.warn('[district-gate] failed to draw resource markers on Azure map', err);
      }
      return;
    }
    if (attempts > 60) { clearInterval(_resMarkerTimer); _resMarkerTimer = null; }
  }, 500);
}

// ============================================================
// GATE UI
// ============================================================

function buildGateOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'district-gate-overlay';
  overlay.className = 'fixed inset-0 z-[9999] bg-brand-dark/95 backdrop-blur-sm flex items-center justify-center p-4';
  overlay.innerHTML = `
    <div class="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8">
      <div class="flex items-center gap-3 mb-2">
        <div class="w-10 h-10 rounded-lg bg-brand-blue flex items-center justify-center text-white"><i class="fa-solid fa-map-location-dot"></i></div>
        <h2 class="text-lg font-bold text-brand-blue">Select Your District</h2>
      </div>
      <p class="text-xs text-gray-500 mb-6">This dashboard, the map, alerts and resource data will all be scoped to the district you choose.</p>

      <label class="block text-xs font-bold text-gray-600 mb-1">State / UT</label>
      <select id="gate-state-select" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-4">
        <option value="">Select state...</option>
        ${(window.INDIA_DISTRICTS ? Object.keys(window.INDIA_DISTRICTS).sort() : INDIA_STATES).map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}
      </select>

      <label class="block text-xs font-bold text-gray-600 mb-1">District</label>
      <select id="gate-district-select" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-4" disabled>
        <option value="">Select state first...</option>
      </select>

      <div id="gate-status" class="text-xs text-gray-400 mb-4 min-h-[1rem]"></div>

      <button id="gate-continue-btn" class="w-full py-3 bg-brand-blue hover:bg-brand-dark text-white font-bold rounded-lg transition-colors disabled:opacity-40" disabled>
        Continue
      </button>
    </div>
  `;
  return overlay;
}

function setGateStatus(text, isError) {
  const el = document.getElementById('gate-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = `text-xs mb-4 min-h-[1rem] ${isError ? 'text-brand-red' : 'text-gray-400'}`;
}

// Shows a lightweight "working" state in the Resource Readiness panel
// while facilities are discovered in the background (the gate is
// already closed by then).
function setReadinessLoading(text) {
  const summaryEl = document.getElementById('resource-readiness-summary');
  if (summaryEl) {
    summaryEl.innerHTML =
      `<span class="flex items-center gap-2"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(text)}</span>`;
  }

  // Replace any stale / placeholder cards with skeletons so no
  // simulated numbers are ever shown while discovery is in flight.
  const cardsEl = document.getElementById('resource-readiness-cards');
  if (cardsEl) {
    cardsEl.innerHTML = (RESOURCE_KINDS || [{}, {}, {}, {}]).map((kind) => `
      <div class="p-5 bg-white rounded-xl border-2 border-gray-100 shadow-sm animate-pulse">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-10 h-10 rounded-lg bg-gray-100"></div>
          <div class="h-3 w-24 bg-gray-100 rounded"></div>
        </div>
        <div class="flex justify-between mb-4">
          <div class="h-6 w-10 bg-gray-100 rounded"></div>
          <div class="h-6 w-10 bg-gray-100 rounded"></div>
        </div>
        <div class="h-1.5 w-full bg-gray-100 rounded-full mb-4"></div>
        <div class="space-y-2">
          <div class="h-2 w-full bg-gray-100 rounded"></div>
          <div class="h-2 w-5/6 bg-gray-100 rounded"></div>
          <div class="h-2 w-4/6 bg-gray-100 rounded"></div>
        </div>
        <div class="mt-3 text-[10px] text-gray-400 flex items-center gap-1">
          <i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(kind.label || 'Loading')}…
        </div>
      </div>`).join('');
  }

  // Top-of-page "Resources" stat also reflects the in-progress state.
  const statEl = document.getElementById('stat-resources');
  if (statEl) statEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-lg"></i>';
  const statSub = document.getElementById('stat-resources-sub');
  if (statSub) statSub.textContent = 'discovering…';
}

// Boundary resolution order: cache -> fast Nominatim (bbox + polygon)
// -> Overpass geometry -> centre-only geocode.
async function resolveDistrictBoundary(stateName, districtName, adminLevel, onStatus) {
  const cached = cacheGet('boundary', stateName, districtName);
  if (cached) return cached;

  try {
    onStatus('Locating district...');
    const fast = await fetchDistrictBoundaryFast(stateName, districtName);
    cacheSet('boundary', fast, stateName, districtName);
    return fast;
  } catch (err) {
    console.warn('[district-gate] fast boundary failed, trying Overpass', err);
  }

  try {
    onStatus('Fetching precise boundary...');
    const precise = await fetchDistrictBoundary(stateName, districtName, adminLevel);
    cacheSet('boundary', precise, stateName, districtName);
    return precise;
  } catch (err) {
    console.warn('[district-gate] Overpass boundary failed, using approximate centre', err);
  }

  onStatus('Using approximate location...');
  const center = await nominatimFallbackCenter(stateName, districtName);
  return { center, bbox: null, polygonPoints: [] };
}

// PHASE 1 (fast, blocks the gate): boundary + map recentre + scope
// the rest of the dashboard. Target: a couple of seconds.
async function runDistrictSetupFast(stateName, districtName, adminLevel, onStatus) {
  onStatus = onStatus || (() => {});

  const boundary = await resolveDistrictBoundary(stateName, districtName, adminLevel, onStatus);

  window.resqnetDistrict = {
    state: stateName,
    district: districtName,
    center: boundary.center,
    bbox: boundary.bbox,
    polygonPoints: boundary.polygonPoints,
  };

  recenterAzureMapWhenReady(boundary.center, boundary.bbox, boundary.polygonPoints);

  window.resqnetDistrictReady = true;
  window.dispatchEvent(
    new CustomEvent('resqnet:district-ready', { detail: window.resqnetDistrict })
  );

  const nameEl = document.getElementById('header-district-name');
  const subEl = document.getElementById('header-district-sub');
  if (nameEl) nameEl.textContent = `${districtName} Control Room`;
  if (subEl) subEl.textContent = stateName;

  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    state: stateName,
    district: districtName,
    adminLevel,
    savedAt: Date.now(),
  }));
}

// OSM / Places coverage of fire stations and ambulance depots is thin
// for most Indian districts. For a working simulation every district
// must still have all four categories, so derive sensible stand-ins
// (clearly flagged) when a category comes back near-empty:
//   ambulance -> co-located with the larger hospitals (hospitals run
//                ambulance fleets in India)
//   fire      -> a district fire & rescue station at the centre, plus
//                a couple spread across the area
function synthesizeMissingKinds(discovered, district) {
  const out = discovered.slice();
  const count = (t) => out.filter((r) => r.type === t).length;
  const c = district.center;
  const b = district.bbox;

  if (count('ambulance') < 3) {
    const hospitals = out.filter((r) => r.type === 'medical_team').slice(0, 6);
    hospitals.forEach((h, i) => {
      out.push({
        osmId: 'syn-amb-' + i,
        name: `${h.name.replace(/,.*$/, '')} — Ambulance`,
        type: 'ambulance', kindKey: 'ambulance', capacityPerUnit: 4,
        latitude: h.latitude, longitude: h.longitude,
        address: h.address, synthesized: true,
      });
    });
  }

  if (count('fire') < 2 && c) {
    const pts = [[c.lat, c.lon]];
    if (b) {
      pts.push([b.minLat + (b.maxLat - b.minLat) * 0.3, b.minLon + (b.maxLon - b.minLon) * 0.35]);
      pts.push([b.minLat + (b.maxLat - b.minLat) * 0.7, b.minLon + (b.maxLon - b.minLon) * 0.65]);
    }
    pts.forEach(([lat, lon], i) => {
      out.push({
        osmId: 'syn-fire-' + i,
        name: i === 0 ? `${district.district} Fire & Rescue Station` : `${district.district} Fire Post ${i}`,
        type: 'fire_brigade', kindKey: 'fire', capacityPerUnit: 8,
        latitude: lat, longitude: lon,
        address: `${district.district}, ${district.state}`, synthesized: true,
      });
    });
  }

  return out;
}

// Wrap a discovery promise so one hung source can't stall the sweep.
function _withCap(promise, ms, label) {
  return Promise.race([
    promise.catch((e) => {
      console.warn(`[district-gate] ${label} failed`, e && e.message);
      return [];
    }),
    new Promise((resolve) => setTimeout(() => {
      console.warn(`[district-gate] ${label} timed out after ${ms}ms`);
      resolve([]);
    }, ms)),
  ]);
}

// One discovery sweep across all sources -> merged list.
async function discoverResourcesOnce(district) {
  const [photon, overpass, google] = await Promise.all([
    _withCap(fetchDistrictResourcesViaPhoton(district), 16000, 'Photon'),
    _withCap(fetchDistrictResources(district), 18000, 'Overpass'),
    _withCap(fetchDistrictResourcesViaGoogle(district), 16000, 'Google Places'),
  ]);

  // Google names/addresses are best -> primary in the merge; Photon
  // and Overpass fill coverage gaps.
  const merged = mergeResources(google, mergeResources(photon, overpass));
  const used = [];
  if (google.length) used.push('Google Places');
  if (photon.length) used.push('Photon/OSM');
  if (overpass.length) used.push('Overpass');
  return { list: merged, source: used.join(' + ') || 'none' };
}

// PHASE 2 (runs after the gate has closed): discover facilities,
// draw markers, register with the AI backend, fill the readiness
// panel. Cached results make repeat visits instant.
async function runDistrictDiscovery(stateName, districtName, adminLevel) {
  const cached = cacheGet('resources', stateName, districtName);
  let discovered;
  let discoverySource;

  // Clear the previous district's pins + cards straight away so nothing
  // stale is ever on screen during a switch.
  try { clearResourceMarkersOnAzure(); } catch (_) {}
  window.resqnetDistrictResources = [];
  setReadinessLoading(`Loading resources for ${districtName}…`);

  if (cached && cached.list && cached.list.length) {
    discovered = cached.list;
    discoverySource = cached.source || 'cache';
  } else {
    setReadinessLoading(`Discovering hospitals, ambulance, police & fire in ${districtName}…`);

    let res = await discoverResourcesOnce(window.resqnetDistrict);

    // Public POI services are flaky -- one retry if the sweep came back
    // thin (some sources were down).
    if (res.list.length < 4) {
      await new Promise((r) => setTimeout(r, 4000));
      const retry = await discoverResourcesOnce(window.resqnetDistrict);
      if (retry.list.length > res.list.length) res = retry;
    }

    discovered = synthesizeMissingKinds(res.list, window.resqnetDistrict);
    discoverySource = res.source;

    if (discovered.length) {
      cacheSet('resources', { list: discovered, source: discoverySource }, stateName, districtName);
    }
  }

  window.resqnetDistrictResources = discovered;
  window.resqnetDistrictResourceSource = discoverySource;
  drawResourceMarkersOnAzure(discovered);
  window.dispatchEvent(
    new CustomEvent('resqnet:resources-ready', {
      detail: { resources: discovered, source: discoverySource, district: window.resqnetDistrict },
    })
  );

  let backendResources = [];
  let backendReachable = false;

  if (discovered.length) {
    try {
      await postResourcesToBackend(stateName, districtName, discovered);
      backendResources = await fetchBackendResources(districtName);
      backendReachable = true;
    } catch (err) {
      console.warn('[district-gate] AI backend unreachable', err);
    }
  }

  renderResourceReadiness(discovered, backendResources, backendReachable);
}

// Re-read the district's resources from the AI backend and redraw the
// readiness panel. Called after an allocation run commits, so the
// "Available" counts drop by exactly the units that were dispatched
// instead of going stale until the next district switch.
window.resqnetRefreshReadiness = async function () {
  const districtName = window.resqnetDistrict && window.resqnetDistrict.district;
  const discovered = window.resqnetDistrictResources || [];
  if (!districtName) return;

  let backendResources = [];
  let backendReachable = false;
  try {
    backendResources = await fetchBackendResources(districtName);
    backendReachable = true;
  } catch (err) {
    console.warn('[district-gate] readiness refresh — backend unreachable', err);
  }

  renderResourceReadiness(discovered, backendResources, backendReachable);
};

// Combined helper for the saved-selection reload path: run the fast
// phase, then kick discovery off without blocking.
async function runDistrictSetup(stateName, districtName, adminLevel, onStatus) {
  await runDistrictSetupFast(stateName, districtName, adminLevel, onStatus);
  runDistrictDiscovery(stateName, districtName, adminLevel).catch((err) =>
    console.warn('[district-gate] background discovery failed', err)
  );
}

function showGate() {
  if (document.getElementById('district-gate-overlay')) return;

  const overlay = buildGateOverlay();
  document.body.appendChild(overlay);

  const stateSelect = document.getElementById('gate-state-select');
  const districtSelect = document.getElementById('gate-district-select');
  const continueBtn = document.getElementById('gate-continue-btn');

  let currentAdminLevel = null;
  let stateRequestToken = 0;

  stateSelect.addEventListener('change', async () => {
    const stateName = stateSelect.value;
    const thisRequestToken = ++stateRequestToken;

    districtSelect.innerHTML = '<option value="">Loading districts...</option>';
    districtSelect.disabled = true;
    continueBtn.disabled = true;
    currentAdminLevel = null;

    if (!stateName) {
      districtSelect.innerHTML = '<option value="">Select state first...</option>';
      return;
    }

    setGateStatus('Loading districts for ' + stateName + '...');

    try {
      const { adminLevel, districts } = await fetchDistrictsForState(stateName);

      // The user may have switched states again while this request
      // was in flight -- a slower, stale response for the earlier
      // state must not clobber a newer, already-loaded selection.
      if (thisRequestToken !== stateRequestToken) return;

      currentAdminLevel = adminLevel;

      if (!districts.length) {
        districtSelect.innerHTML = '<option value="">No districts found -- type district name manually below</option>';
        setGateStatus('Could not auto-load districts for this state. You can still type a district name and continue.', true);
        districtSelect.disabled = false;
        districtSelect.innerHTML = `<option value="">Select district...</option>`;
        // Fall back to a free-text option
        const freeTextOpt = document.createElement('option');
        freeTextOpt.value = '__custom__';
        freeTextOpt.textContent = 'Other / type manually...';
        districtSelect.appendChild(freeTextOpt);
      } else {
        districtSelect.innerHTML = `<option value="">Select district...</option>` +
          districts.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
        districtSelect.disabled = false;
      }
      setGateStatus('');
    } catch (err) {
      if (thisRequestToken !== stateRequestToken) return;
      console.error('[district-gate] state->district fetch failed', err);
      setGateStatus('Failed to load districts. Check your connection and try again.', true);
      districtSelect.innerHTML = '<option value="">Select state again to retry...</option>';
    }
  });

  districtSelect.addEventListener('change', () => {
    continueBtn.disabled = !districtSelect.value;
  });

  continueBtn.addEventListener('click', async () => {
    const stateName = stateSelect.value;
    let districtName = districtSelect.value;

    if (districtName === '__custom__') {
      districtName = window.prompt('Enter district name:', '') || '';
      if (!districtName) return;
    }

    if (!stateName || !districtName) return;

    continueBtn.disabled = true;
    continueBtn.textContent = 'Loading...';

    try {
      // Fast phase only — close the gate as soon as the map is scoped.
      await runDistrictSetupFast(
        stateName,
        districtName,
        currentAdminLevel || null,
        (msg, isErr) => setGateStatus(msg, isErr)
      );
      overlay.remove();

      // Facility discovery + AI registration continue in the
      // background and fill the Resource Readiness panel when ready.
      runDistrictDiscovery(stateName, districtName, currentAdminLevel || null).catch((err) =>
        console.warn('[district-gate] background discovery failed', err)
      );
    } catch (err) {
      console.error('[district-gate] setup failed', err);
      setGateStatus('Something went wrong setting up this district. You can retry.', true);
      continueBtn.disabled = false;
      continueBtn.textContent = 'Continue';
    }
  });
}

function loadSavedSelection() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.state || !parsed.district) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function injectChangeDistrictControl() {
  const trigger = document.getElementById('header-change-district');
  if (trigger) {
    trigger.addEventListener('click', () => showGate());
  }
}

// ============================================================
// BOOT
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  injectChangeDistrictControl();

  const saved = loadSavedSelection();

  if (saved) {
    const nameEl = document.getElementById('header-district-name');
    const subEl = document.getElementById('header-district-sub');
    if (nameEl) nameEl.textContent = `${saved.district} Control Room`;
    if (subEl) subEl.textContent = saved.state;

    runDistrictSetup(saved.state, saved.district, saved.adminLevel || null, (msg) => {
      console.info('[district-gate] refresh:', msg);
    }).catch((err) => {
      console.warn('[district-gate] background refresh of saved district failed', err);
    });
  } else {
    showGate();
  }
});
