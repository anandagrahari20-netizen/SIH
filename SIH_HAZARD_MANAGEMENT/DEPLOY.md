# Deploying RESQNET (host it on your own account)

There are up to **4 things** to deploy. Only the first is required — the app
degrades gracefully without the others.

| # | Piece | Host | Needed? |
|---|-------|------|---------|
| 1 | Static site + Firestore | **Firebase** (free / Spark) | **Yes** |
| 2 | Firestore security rules | Firebase | Yes (one command) |
| 3 | SACHET proxy | **AI backend `/api/sachet`** (or Cloudflare Worker) | Optional — SACHET alerts stay blank without it |
| 4 | AI backend | **Firebase Cloud Function** `api`, fronted by Hosting at `/api/**` | Optional — helpline / allocation / triage use local fallbacks without it |

Everything the site reads is in **one file: `config.js`**. That's the only file
you edit.

---

## 1. Firebase — the site + database

**Project: `sih-disaster-management-6b931`** (your own). `config.js` and `.firebaserc` are
already pointed at it.

One-time setup in the Firebase console for `sih-disaster-management-6b931`:
1. **Build → Firestore Database → Create database** → *production mode* →
   region `asia-south1` (or nearest).
2. That's it for the web app — the config is already in `config.js`.

### Deploy
```bash
npm install -g firebase-tools
firebase login                       # your Google account (the one that owns sih-disaster-management-6b931)
cd SIH_HAZARD_MANAGEMENT
firebase deploy --only hosting,firestore:rules
```
Firebase prints your live URL: `https://sih-disaster-management-6b931.web.app`.
Open it — the district picker should appear.

> The Kavach citizen simulator ships with the site at
> `https://<project-id>.web.app/Kavach/kavach.html`. The **"Simulator"** button
> in the RESQNET header opens it (same origin, so the live bridge works).

---

## 2. Firestore rules
Already included in the deploy above (`firestore.rules`). If you ever change
them: `firebase deploy --only firestore:rules`.

> **Re-deploy the rules after this update.** `firestore.rules` now also opens
> the `broadcasts` collection (authority SACHET broadcasts → every Kavach
> device in the area) and `safe_checkins` ("I'm safe" check-ins). Until you run
> `firebase deploy --only firestore:rules` the Kavach console will log a
> harmless `permission-denied` for those two listeners and cross-device
> broadcasts fall back to the same-browser bridge.

---

## 3. SACHET proxy

`sachet.ndma.gov.in` blocks browser CORS. **Default: the AI backend proxies it**
— `app/main.py` has a `/sachet/{path}` route that fetches NDMA server-side, and
`config.js` → `RESQNET_SACHET_PROXY` is `"/api/sachet"`. Nothing extra to deploy
(it ships with the function in §4); Google Cloud egress is rarely blocked by NDMA.

**Alternative — Cloudflare Worker** (if you're not deploying the AI backend):
```bash
cd SIH_HAZARD_MANAGEMENT/sachet-worker
npx wrangler login          # opens browser once
npx wrangler deploy
```
Copy the printed URL (`https://sachet-proxy.<sub>.workers.dev`) into
**`config.js`** → `RESQNET_SACHET_PROXY`, then re-run
`firebase deploy --only hosting`.

---

## 4. AI backend — deployed as a Firebase Cloud Function (`api`)

The FastAPI app (`SIH_HAZARD_MANAGEMENT_ai/`) is deployed as a **2nd-gen Python
Cloud Function** named `api`, and Firebase Hosting **rewrites `/api/**` to it**.
The browser only ever talks to `https://<project>.web.app`, so there's no CORS
and nothing to set in `config.js` (`RESQNET_AI_API_BASE` is already `/api`).
It's optional — helpline / allocation / triage all have local fallbacks.

How the wiring fits together:
- `SIH_HAZARD_MANAGEMENT/firebase.json` → `hosting.rewrites`:
  `{ "source": "/api/**", "function": { "functionId": "api", "region": "asia-south1" } }`.
- `SIH_HAZARD_MANAGEMENT_ai/firebase.json` + `.firebaserc` define the functions
  codebase (`source: "."`, `runtime: "python311"`). `SIH_HAZARD_MANAGEMENT_ai/main.py`
  is the entrypoint: it imports the FastAPI app and exposes it as the `api`
  function through a tiny in-process ASGI→WSGI shim.
- `app/main.py` mounts the whole API under `/api` (Firebase does **not** strip the
  prefix), so `GET https://<project>.web.app/api/allocate` reaches the `/allocate`
  route. On Functions, Firebase credentials come from Application Default
  Credentials (the runtime service account) — no key file is uploaded.

### Requirements
- **Blaze** billing on the project (Cloud Functions needs it). Set a budget alert
  (Billing → Budgets & alerts → ~₹400 / $5). Free tier covers a demo easily.
- **Python 3.11** installed locally — the Firebase CLI builds a discovery venv
  matching the `runtime`. With the `py` manager: `py install 3.11`.
- `firebase login` (same Google account that has deploy access to the project).

### Deploy
```powershell
# one-time: create the local 3.11 venv the Firebase CLI reuses for discovery
cd "C:\Users\vyoms\OneDrive\Desktop\SIH\SIH_HAZARD_MANAGEMENT_ai"
py -3.11 -m venv venv
.\venv\Scripts\python -m pip install -r requirements.txt

# backend  (re-run whenever you change anything under SIH_HAZARD_MANAGEMENT_ai/)
firebase deploy --only functions

# frontend + rules + wire the /api rewrite to the function
cd ..\SIH_HAZARD_MANAGEMENT
firebase deploy --only hosting,firestore:rules
```
First `functions` deploy auto-enables the needed APIs (Cloud Functions, Cloud
Build, Artifact Registry, Run, Eventarc) and sets a 1-day image cleanup policy.

Sanity check: `curl https://<project>.web.app/api/` → `{"status":"online",...}`
and `curl https://<project>.web.app/api/allocate` → a JSON allocation object.

Logs: `cd SIH_HAZARD_MANAGEMENT_ai ; firebase functions:log --only api`
Remove it: `firebase functions:delete api --region asia-south1`

### 4c. Alternative — Cloud Run / Render (no Blaze, or you prefer a container)
`SIH_HAZARD_MANAGEMENT_ai/` still carries `Dockerfile` / `Procfile` / `render.yaml`
and `uvicorn app.main:app` works directly (the `/api` mount is harmless there).
- **Cloud Run:** `gcloud run deploy resqnet-ai --source . --region asia-south1
  --allow-unauthenticated --set-secrets "FIREBASE_SERVICE_ACCOUNT_JSON=firebase-sa:latest"`
  then change the hosting rewrite to
  `{ "source": "/api/**", "run": { "serviceId": "resqnet-ai", "region": "asia-south1" } }`.
- **Render:** New → Blueprint → `render.yaml`; set env vars; then set
  `RESQNET_AI_API_BASE` in `config.js` to the absolute URL **ending in `/api`**
  (e.g. `https://resqnet-ai.onrender.com/api`) and redeploy hosting.
- Either way provide Firebase creds via `FIREBASE_SERVICE_ACCOUNT_JSON` (Render)
  or a Secret Manager secret (Cloud Run). Update a Cloud Run key later:
  `gcloud secrets versions add firebase-sa --data-file="...json"`.

**Env vars — all optional except the Firebase key:**

| var | if set | if NOT set |
|-----|--------|-----------|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | required | backend won't start |
| `GEMINI_API_KEY` | smart free-form LLM helpline (get a free key at aistudio.google.com) | helpline uses the fixed EN/HI/Hinglish script — still a full two-way voice call |
| `GROQ_API_KEY` | same, alternative LLM | — |
| `GOOGLE_MAPS_API_KEY` | `/allocate` uses real driving ETAs (Distance Matrix API) | ETAs are straight-line estimates (×1.3) — allocation still works |

On a **Cloud Function** set these with
`firebase functions:secrets:set GEMINI_API_KEY` (or `:config:set` for non-secret
values), then redeploy. On **Cloud Run** use `--set-env-vars` / `--set-secrets`;
on **Render** the Environment tab.

⚠ If you set `GOOGLE_MAPS_API_KEY` on the backend it must be a key **without an
HTTP-referrer restriction** (a server has no referrer). Don't reuse the
referrer-locked frontend key — make a second key restricted to *Distance Matrix
API* only, or just leave it unset.

- Cloud Functions / Cloud Run free tier (2M req/mo, scales to zero) easily covers
  a demo. Cold start after idle is ~2–5s. For demo day, bump `max_instances` /
  add a min-instance in `SIH_HAZARD_MANAGEMENT_ai/main.py`
  (`options.set_global_options(min_instances=1)`), then revert.

---

## 5. Google Cloud APIs (for the maps + discovery to work fully)
In https://console.cloud.google.com (the project your Maps key belongs to —
currently `879641895404`):
- Enable: **Maps JavaScript API**, **Places API (New)**, **Directions API**,
  **Distance Matrix API**.
- Enable **billing** on that Google Cloud project (Maps requires a card even for
  the free monthly credit).
- **APIs & Services → Credentials →** your key → **Application restrictions →
  HTTP referrers →** add `https://<project-id>.web.app/*` and
  `https://<project-id>.firebaseapp.com/*` and `http://localhost:*`.

Until this is done, facility discovery falls back to Photon/OpenStreetMap and
ETAs use a straight-line estimate — the app still works.

---

## Recap — the only file you edit
`config.js`:
```js
RESQNET_FIREBASE_CONFIG : { ...your Firebase web config... }
RESQNET_AI_API_BASE     : "/api"   // Firebase Hosting rewrites this to Cloud Run — leave as-is
RESQNET_SACHET_PROXY    : "https://sachet-proxy.<sub>.workers.dev" // or ""
RESQNET_GOOGLE_MAPS_KEY : "<your Maps key>"
```
Then: `firebase deploy --only hosting,firestore:rules`
