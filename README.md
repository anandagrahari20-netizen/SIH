# RESQNET + Kavach — Disaster / Hazard Management Platform

A two-sided disaster-response system built for the **Smart India Hackathon (SIH)**:

| Side | App | Who uses it |
|------|-----|-------------|
| **Command centre** | **RESQNET** — a live operations dashboard | District disaster-management authorities / control rooms |
| **Citizen** | **Kavach** — a mobile-style progressive web app | The public in an affected area |
| **Brain** | **RESQNET-AI** — a FastAPI service | Consumed by both apps (report triage, resource allocation, AI helpline, SACHET proxy) |

The three pieces talk to each other through **Firebase Firestore** (real-time) and a
small REST API, so an incident a citizen files in Kavach appears on the RESQNET
dispatch board within seconds, and a relocation/allocation decision the authority
makes flows straight back to the citizen's device.

> **Heads-up on keys:** every API key and credential in this repository is a
> placeholder (`YOUR_…`). Nothing here is a working secret. See
> [Configuration](#configuration) and [`SECURITY.md`](SECURITY.md) before deploying.

---

## Table of contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [AI backend API](#ai-backend-api)
- [Deployment](#deployment)
- [Security](#security)
- [Credits](#credits)

---

## What it does

### RESQNET — authority dashboard (`SIH_HAZARD_MANAGEMENT/`)

- **District gate** — the operator picks a state + district (bundled list of 36
  states / 725 districts, no external call). Everything below is scoped to that
  district. The boundary polygon is fetched once (Nominatim) and cached.
- **Live operations map** (Azure Maps) with switchable layers:
  - **Complaint-density dots** — live incidents grouped into a ~550 m grid,
    sized by count and coloured by worst priority in the cell.
  - **Weather / rain radar** (Azure Maps weather tiles).
  - **SACHET alert zones** — official NDMA CAP alert polygons, the district's
    drawn bold, the rest of the country faint.
  - **Facilities** — hospitals, ambulance, police, fire discovered for the
    district (Photon + Overpass + Google Places, spatially de-duplicated).
- **Resource readiness** panel — inventory per facility category.
- **AI relocation / allocation** — clusters open incidents and assigns the
  nearest compatible, fastest-arriving resource; draws resource→cluster routes;
  explains each decision ("Responding to: 2 reports · 11 people, 11 trapped …").
- **Dispatch board** — every live incident sorted by priority + age with a
  status dropdown that writes straight back to Firestore (the citizen sees it).
- **Authority broadcast** — pushes a real SACHET-style alert to every Kavach
  device inside a severity-sized radius / the district outline, with a safety
  form link and toll-free number.
- **Live caller locations** — Kavach users who file a request share GPS; a
  pulsing pin + "Navigate" link appears on the operator map.
- **Situation report** — a printable popup (incident KPIs, dispatch, SACHET
  zones, resource inventory, broadcast log).
- Full **English / हिंदी** UI, light + dark theme.

### Kavach — citizen app (`SIH_HAZARD_MANAGEMENT/Kavach/`)

- **Simple login** — name, mobile, state/district, location, language.
- **Emergency button** + **SMS-style AI chat** — both file a geo-tagged incident
  to the command centre (falls back to a direct Firestore write if the backend
  is down).
- **AI Helpline** — a conversational voice triage: browser speech-to-text →
  `/helpline/turn` → spoken reply, looping until the AI has enough to file a
  prioritised incident. Works offline with a fixed EN/HI/Hinglish script.
- **My Requests** — a 4-stage tracker (Received → Assigned → En route →
  Resolved) that updates live, and shows the responding unit + ETA.
- **SACHET alerts** for the user's city, **alert history**, **OS push
  notifications**, and a **wellness check** ("Is everyone safe?") when an alert
  covers the user.
- **Weather** screen with a 5-day forecast and condition-aware safety tips.
- City-locked map, full EN/हिंदी UI.

### RESQNET-AI — backend (`SIH_HAZARD_MANAGEMENT_ai/`)

- **Report analyzer** — language detection, fact extraction (people trapped /
  injured / affected, hazard type, needs), a deterministic
  `severity → priority` pipeline, and a trained urgency model
  (`app/urgency_weights.json`) for a graded magnitude score.
- **Resource allocator** — district-partitioned, distance-capped
  (`MAX_DISPATCH_KM`), speed-weighted greedy assignment with a human-readable
  rationale per decision. Never dispatches across districts.
- **AI Helpline** — LLM chain Ollama (local) → Groq → Gemini → fixed script;
  the LLM only writes the reply, all severity/priority come from the
  deterministic pipeline.
- **SACHET proxy** — server-side fetch of `sachet.ndma.gov.in` with browser-spoof
  headers, a path allowlist and a short in-process cache (browsers can't call
  NDMA directly — CORS).
- **Google Maps** — optional Distance Matrix ETAs, haversine fallback.

---

## Architecture

```
                 ┌───────────────────────────┐
                 │   RESQNET dashboard        │  Azure Maps · Firestore
                 │   SIH_HAZARD_MANAGEMENT/   │  (authority)
                 └─────────────┬─────────────┘
                               │  REST  /api/**        Firestore
                               │  (analyze, allocate,  (incidents, relocations,
                               │   incidents, sachet)   broadcasts, caller_locations)
                 ┌─────────────┴─────────────┐          ▲
                 │   RESQNET-AI  (FastAPI)    │          │ onSnapshot
                 │   SIH_HAZARD_MANAGEMENT_ai/│          │
                 │   + SACHET proxy           │          │
                 └─────────────┬─────────────┘          │
                               │  REST  /api/**         │
                 ┌─────────────┴─────────────┐          │
                 │   Kavach citizen PWA      │──────────┘
                 │   SIH_HAZARD_MANAGEMENT/  │  Firestore (citizen)
                 │   Kavach/                 │
                 └───────────────────────────┘
```

- **Hosting model:** Firebase Hosting serves the static frontend and rewrites
  `/api/**` to the FastAPI backend (deployed as a 2nd-gen Cloud Function, or
  Cloud Run, or Render — all three paths are in the repo). Same origin, no CORS.
- **Frontend ↔ AI:** plain `fetch` to `RESQNET_AI_API_BASE` (default `/api`).
  Every call has a client-side fallback, so the site still works if the backend
  is down (helpline script, client-side allocator, direct Firestore writes).
- **AI ↔ Kavach:** via Firestore collections — `incidents`, `relocations`,
  `broadcasts`, `caller_locations`, `safe_checkins`. Kavach subscribes with
  `onSnapshot`.

More detail: [`SIH_HAZARD_MANAGEMENT/DEPLOY.md`](SIH_HAZARD_MANAGEMENT/DEPLOY.md)
and [`SIH_HAZARD_MANAGEMENT_ai/API_CONTRACT.md`](SIH_HAZARD_MANAGEMENT_ai/API_CONTRACT.md).

---

## Repository layout

```
.
├── SIH_HAZARD_MANAGEMENT/          # Static frontend (RESQNET dashboard + Kavach)
│   ├── index.html                  # RESQNET dashboard
│   ├── config.js                   # ← THE single deploy edit point (keys, endpoints)
│   ├── script.js                   # dashboard logic, Azure map, dispatch, broadcast
│   ├── district-gate.js            # state/district gate + facility discovery
│   ├── relocation-sim.js           # AI relocation / allocation map
│   ├── firebase-bridge.js          # shared Firestore ES module
│   ├── firestore.rules             # Firestore security rules
│   ├── firebase.json / .firebaserc # Firebase Hosting + rewrites
│   ├── Kavach/                     # Citizen PWA (kavach.html, app.js, kavach-firebase.js)
│   ├── sachet-worker/              # Cloudflare Worker SACHET proxy (no-backend alternative)
│   └── DEPLOY.md                   # full deployment runbook
│
├── SIH_HAZARD_MANAGEMENT_ai/       # FastAPI backend
│   ├── app/
│   │   ├── main.py                 # routes
│   │   ├── analyzer.py severity.py priority.py   # report triage pipeline
│   │   ├── resource_allocator.py aggregation.py  # allocation
│   │   ├── helpline.py             # conversational AI helpline
│   │   ├── maps.py language.py transcription.py schemas.py
│   │   └── urgency_weights.json    # trained model weights
│   ├── main.py                     # Cloud Functions entrypoint (ASGI→WSGI shim)
│   ├── requirements.txt runtime.txt
│   ├── Dockerfile Procfile render.yaml   # Cloud Run / Render deploy paths
│   ├── firebase.json .firebaserc         # Cloud Function deploy
│   └── firebase-service-account.example.json   # template — real key is git-ignored
│
├── docs/                           # Project description (HTML + PDF)
├── RESQNET-Architecture.pdf
├── SECURITY.md                     # pre-public security checklist
└── README.md
```

---

## Tech stack

**Frontend:** Vanilla JS (ES modules), Tailwind (CDN), Azure Maps SDK, Google
Maps JS API, Firebase Web SDK (Firestore + Analytics), Web Speech API.

**Backend:** Python 3.11, FastAPI, Uvicorn, Pydantic, `firebase-admin`,
`requests`, optional `ollama` client. LLM providers: Ollama / Groq / Gemini.

**Infra:** Firebase Hosting + Firestore, Firebase Cloud Functions (2nd gen) /
Google Cloud Run / Render, optional Cloudflare Worker.

**Data sources:** NDMA SACHET (CAP alerts), OpenStreetMap via Photon + Overpass,
Nominatim (boundaries), Google Places (New), Azure Maps Weather.

---

## Getting started

### Prerequisites

- Node — only for the Firebase CLI (`npm i -g firebase-tools`), optional for local dev
- Python **3.11**
- A Firebase project (Firestore enabled)
- API keys: Firebase web config, Google Maps JS (Maps + Places New + Directions
  + Distance Matrix), Azure Maps subscription key

### 1. Backend

```bash
cd SIH_HAZARD_MANAGEMENT_ai
python -m venv venv
venv\Scripts\activate           # Windows  (source venv/bin/activate on *nix)
pip install -r requirements.txt

# credentials — pick ONE:
#   a) copy firebase-service-account.example.json -> firebase-service-account.json
#      and paste a real Admin SDK key (the file is git-ignored)
#   b) set FIREBASE_SERVICE_ACCOUNT_JSON to the key's contents on one line
# optional: GOOGLE_MAPS_API_KEY, GROQ_API_KEY or GEMINI_API_KEY (AI helpline)

uvicorn app.main:app --reload --port 8000
# -> http://127.0.0.1:8000  (docs at /docs)
```

### 2. Frontend

Edit [`SIH_HAZARD_MANAGEMENT/config.js`](SIH_HAZARD_MANAGEMENT/config.js) — replace
every `YOUR_…` placeholder (see [Configuration](#configuration)). For local dev
against the local backend, add **before** `config.js` in `index.html` /
`Kavach/kavach.html`:

```html
<script>window.RESQNET_AI_API_BASE = "http://127.0.0.1:8000/api";</script>
```

Then serve the folder with any static server:

```bash
cd SIH_HAZARD_MANAGEMENT
npx serve .            # or the VS Code "Live Server" extension (port 5501)
```

Open `index.html` for RESQNET, `Kavach/kavach.html` for the citizen app.

---

## Configuration

**`SIH_HAZARD_MANAGEMENT/config.js` is the only file you edit to deploy.** All
values below ship as `YOUR_…` placeholders.

| Key | What it is |
|-----|-----------|
| `RESQNET_FIREBASE_CONFIG` | Your Firebase project's web config (6–7 fields, from Firebase console → Project settings → Your apps → SDK config). The web `apiKey` is a **public identifier**, not a secret — security is Firestore Rules + App Check. |
| `RESQNET_GOOGLE_MAPS_KEY` | Google Maps JS API key. **Restrict it** by HTTP referrer to your `*.web.app` / `*.firebaseapp.com` / `localhost` and enable only Maps JavaScript + Places (New) + Directions + Distance Matrix. |
| `RESQNET_AZURE_MAPS_KEY` | Azure Maps subscription key. Shared-key auth **can't** be domain-restricted — set a **spending cap** and rotate regularly. |
| `RESQNET_AI_API_BASE` | Backend base URL. Default `/api` (Firebase Hosting rewrite). |
| `RESQNET_SACHET_PROXY` | SACHET proxy path. Default `/api/sachet` (served by the backend). |

Backend environment variables:

| Var | Required | Purpose |
|-----|----------|---------|
| `FIREBASE_SERVICE_ACCOUNT_JSON` *or* a git-ignored `firebase-service-account.json` | yes (unless running on GCP with ADC) | Firestore Admin access |
| `GOOGLE_MAPS_API_KEY` | no | Distance Matrix ETAs (haversine fallback otherwise) |
| `GROQ_API_KEY` / `GEMINI_API_KEY` | no | AI helpline LLM (fixed script otherwise) |
| `HELPLINE_USE_OLLAMA` | no | set `0` to skip the local Ollama attempt |

`.firebaserc` (both folders) and `firestore.rules` also carry the project id —
swap them for your project.

---

## AI backend API

Base path `/api` in production. Full contract in
[`API_CONTRACT.md`](SIH_HAZARD_MANAGEMENT_ai/API_CONTRACT.md).

| Method & path | Purpose |
|---------------|---------|
| `GET  /` | health check |
| `POST /analyze` | analyze one citizen report → language, facts, severity, priority |
| `POST /helpline/turn` | one turn of the conversational AI helpline; files an incident when `done` |
| `POST /voice-analyze` | audio → transcript → analysis (needs optional `faster-whisper`) |
| `POST /incidents` · `GET /incidents` · `GET /incidents/{id}` | incident CRUD (accepts `?district=`) |
| `GET  /incidents/aggregation` | demand clusters for a district |
| `POST /resources` · `GET /resources` · `POST /resources/bulk` | resource inventory |
| `GET  /allocate` · `POST /allocate/commit` | run / commit the allocation (auto-moves incidents to IN_PROGRESS) |
| `GET  /sachet/{path}` | server-side NDMA SACHET proxy (path-allowlisted, cached) |

---

## Deployment

Full runbook: [`SIH_HAZARD_MANAGEMENT/DEPLOY.md`](SIH_HAZARD_MANAGEMENT/DEPLOY.md).
Short version:

**Backend (Firebase Cloud Function — the primary path):**
```bash
cd SIH_HAZARD_MANAGEMENT_ai
firebase deploy --only functions        # 2nd-gen Python 3.11 function "api", asia-south1
```
Alternatives baked in: `gcloud run deploy --source .` (Cloud Run) or a Render
Blueprint (`render.yaml`). Set the secret env vars in the platform's dashboard.

**Frontend:**
```bash
cd SIH_HAZARD_MANAGEMENT
firebase deploy --only hosting,firestore:rules
```
`firebase.json` rewrites `/api/**` to the function, so the site is same-origin.

**SACHET:** served by the backend's `/sachet` route. The Cloudflare Worker in
`sachet-worker/` is the no-backend alternative (`wrangler deploy`).

---

## Security

This repo was scrubbed before going public — see [`SECURITY.md`](SECURITY.md) for
the full checklist. Key points:

- **All keys here are placeholders.** Put real values only in `config.js` at
  deploy time (or a git-ignored override) and in platform env vars.
- The **Firebase Admin service-account key** must never be committed —
  `.gitignore` blocks `*service-account*.json` (the `.example.json` template is
  the only one tracked).
- Client-side keys (Google/Azure Maps) are unavoidably visible in the browser
  bundle — protect them with **referrer restrictions + billing caps**, not by
  hiding.
- `firestore.rules` currently allows unauthenticated `create`/`update` on some
  collections for the prototype demo. Add Firebase **Auth + App Check** before
  any real deployment.
- Enable **GitHub secret scanning + push protection** on the repo.

---

## Credits

Built for the **Smart India Hackathon**. Data & services: NDMA SACHET,
OpenStreetMap (Photon, Overpass, Nominatim), Google Maps Platform, Azure Maps,
Firebase.
