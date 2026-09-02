# Before making this repo public — security checklist

## Scan result

| What | Risk | In git now? |
|------|------|-------------|
| `SIH_HAZARD_MANAGEMENT_ai/firebase-service-account.json` — contains a real **RSA private key** (Firebase Admin SDK for the old project `sih-disaster-management-6b931`) | **CRITICAL** — full read/write to that project's Firestore, bypasses all rules | **Yes, since the first commit** |
| `RESQNET_GOOGLE_MAPS_KEY` in `config.js` (`AIzaSy…`) | Medium — billable if abused | Yes (and also served on the live site — see note) |
| `RESQNET_AZURE_MAPS_KEY` in `config.js` / hardcoded fallback in `script.js` + `Kavach/app.js` (`Eh2HpZ…`) | Medium — Azure Maps subscription key, billable; Azure shared-key auth can't be domain-restricted | Yes (also served on the live site) |
| Firebase **web** `apiKey` in `config.js` / `firebase-bridge.js` (`AIzaSy…`) | **Not a secret** — Firebase web keys are public identifiers by design; security is Firestore Rules + App Check | Yes — fine |
| `render.yaml` | None — every secret is a `sync: false` env var, nothing hard-coded | Yes — fine |
| `mychanges.patch` (×2, 1 MB) | None found, but junk | Yes — remove |
| `SIH_HAZARD_MANAGEMENT/node_modules/` (~9.5k files) | None — bloat only | Yes — untrack |
| `app/__pycache__/*.pyc`, `.firebase/hosting..cache` | None — junk | Yes — untrack |

The `AIzaSyDOCAbC…` strings inside `node_modules/@firebase/**/*.d.ts` are Google's
own doc placeholders, not real keys.

---

## 1. REVOKE the leaked service-account key — do this first, no matter what

The key is compromised the moment it hit a repo; scrubbing git is not enough.

- Google Cloud Console for project **`sih-disaster-management-6b931`** →
  **IAM & Admin → Service Accounts** →
  `firebase-adminsdk-fbsvc@sih-disaster-management-6b931.iam.gserviceaccount.com`
  → **Keys** → delete the key whose id = the `private_key_id` in the file
  (or delete the whole service account if that project is dead).
- No access? Ask the friend who owns that project to do it.
- Nothing of yours breaks — you're on `kavach-e1d3e` now, which needs its **own**
  fresh key (Firebase console → Project settings → Service accounts → Generate
  new private key) placed in a **git-ignored** `firebase-service-account.json`
  or the Render env var `FIREBASE_SERVICE_ACCOUNT_JSON`.

## 2. Restrict the Google Maps key

It's a **browser** key — it has to ship in the page's JS, so it's visible on the
live site regardless of the repo. The real protection:

- Google Cloud Console → **APIs & Services → Credentials** → the Maps key:
  - **Application restrictions → HTTP referrers**: `https://kavach-e1d3e.web.app/*`,
    `https://kavach-e1d3e.firebaseapp.com/*`, `http://localhost:*`
  - **API restrictions**: Maps JavaScript API, Places API (New), Directions API,
    Distance Matrix API — nothing else.
- Optionally **regenerate** it (it's been in a repo), then update `config.js`.

### Azure Maps key
Same situation — it's in the browser SDK, so it's on the live site regardless.
Azure shared-key auth **cannot** be domain-restricted, so:
- Azure portal → your Azure Maps account → **Authentication → regenerate**
  the primary key, update `config.js` → `RESQNET_AZURE_MAPS_KEY`.
- Set a **spending limit / budget alert** on the Azure subscription so abuse
  can't run up a bill.
- (Better long-term: switch the SDK to Entra ID / SAS-token auth.)

## 3. Clean the working tree

```bash
cd <repo root>
git rm --cached SIH_HAZARD_MANAGEMENT_ai/firebase-service-account.json
git rm --cached mychanges.patch SIH_HAZARD_MANAGEMENT/mychanges.patch
git rm -r --cached SIH_HAZARD_MANAGEMENT/node_modules
git rm -r --cached SIH_HAZARD_MANAGEMENT_ai/app/__pycache__
git rm --cached .firebase/hosting..cache SIH_HAZARD_MANAGEMENT/.firebase/hosting..cache
git add .gitignore SIH_HAZARD_MANAGEMENT/.gitignore SIH_HAZARD_MANAGEMENT_ai/firebase-service-account.example.json
git commit -m "chore: remove secrets and build artefacts from tracking"
```

## 4. Purge git HISTORY

The key is in **every commit** (it was in the first one). `git rm` only affects
new commits. For a public repo you must rewrite history — or start fresh.

### Option A — fresh repo (simplest, recommended for a new public repo)
```bash
cd <repo root>
# working tree already cleaned by step 3
rm -rf .git
git init && git add . && git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<you>/<new-public-repo>.git
git push -u origin main
```
You lose commit history, but the public repo is guaranteed clean.

### Option B — keep history, surgically remove the file
```bash
pip install git-filter-repo
git filter-repo --invert-paths \
  --path SIH_HAZARD_MANAGEMENT_ai/firebase-service-account.json \
  --path mychanges.patch \
  --path SIH_HAZARD_MANAGEMENT/mychanges.patch \
  --path SIH_HAZARD_MANAGEMENT/node_modules \
  --path SIH_HAZARD_MANAGEMENT_ai/app/__pycache__
# re-add your remote (filter-repo drops it) and force-push
git remote add origin https://github.com/<you>/<repo>.git
git push --force --all
```
If you'd already pushed to the friend's remotes, those copies still contain the
key until they're deleted / re-pushed — another reason step 1 (revoke) matters.

## 5. Firestore rules — note for after the demo

`firestore.rules` currently allows unauthenticated `create`/`update` on
`incidents`, `relocations`, `caller_locations` (fine for the prototype demo, but
on a public deployment anyone can write). Add Firebase **Auth** + **App Check**
before real use.

## 6. After going public
- Enable **GitHub → Settings → Code security → Secret scanning + Push protection**.
- If GitHub emails you about a detected secret, it means the key is still live —
  go back to step 1.
