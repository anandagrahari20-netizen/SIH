# KAVACH — AI-Assisted Disaster Response Prototype

> **SIH 2025 — Citizen Communication & Emergency Response Simulation**

---

## Quick Start

Open `index.html` in any modern browser. No server or installation required.

```
File → Open → index.html
```

---

## Demo Flow (SIH Presentation)

| Step | Action |
|------|--------|
| 1 | Click **Load Flood Scenario** (top-right) to pre-populate data |
| 2 | Tap the **Kavach** icon → **Continue as Demo User** |
| 3 | Observe: Active Disaster Alert + Weather Heatmap |
| 4 | Tap **🚨 EMERGENCY** → submit 6 people, Medical + Rescue, Injured, Trapped |
| 5 | View Request #KV-XXXX with CRITICAL priority + tracking timeline |
| 6 | Return home → open **Messages** → **Kavach Emergency Services** |
| 7 | Demonstrate SMS decision tree (try: `3` → `6` → `1` → `2`) |
| 8 | Switch language to **हि** or **HG** and observe multilingual flow |
| 9 | Toggle **🤖 AI Mode** → type: `"Ghar mein paani aa gaya, hum 6 log hain aur papa injured hain"` |
| 10 | Open **Phone** icon → **IVR Simulator** → Start Call → navigate with keypad |
| 11 | Reset with the **Reset Demo** button |

---

## Architecture

```
                 CITIZEN RESPONSE
                        │
            ┌───────────┴───────────┐
            │                       │
           SMS                     IVR
            │                       │
            └───────────┬───────────┘
                        │
                 ResponseEngine
                   (shared JS class)
                        │
               Normalized Request Object
                        │
              { id, needs, people, injured,
                trapped, priority, source }
```

---

## Google Maps Setup

By default the app uses a **simulated SVG heatmap** that works without any API key.

To enable real Google Maps:

1. Get a Google Maps JavaScript API key (with `visualization` library enabled)
2. Open `app.js` and set:
   ```js
   const GOOGLE_MAPS_API_KEY = 'YOUR_ACTUAL_KEY';
   ```
3. Uncomment the `<script>` tag in `index.html`:
   ```html
   <script async src="https://maps.googleapis.com/maps/api/js?key=YOUR_KEY&libraries=visualization&callback=onGoogleMapsReady"></script>
   ```

---

## Features

- ✅ Android phone simulation with wallpaper, status bar, dock, app icons
- ✅ Kavach app: splash → login → register → dashboard
- ✅ Interactive weather heatmap (SVG simulation + Google Maps optional)
- ✅ Location-aware weather cards
- ✅ Multi-step emergency form with priority calculation
- ✅ Request tracking timeline with sync animation
- ✅ SMS inbox + interactive conversation with full decision tree
- ✅ Multilingual SMS (English / Hindi / Hinglish)
- ✅ AI triage simulation (free-text NLP mock)
- ✅ IVR simulator with DTMF keypad
- ✅ Shared ResponseEngine for SMS + IVR
- ✅ Demo controls: Load Flood Scenario, Reset Demo
- ✅ localStorage persistence
- ✅ Toast notifications
- ✅ No backend required

---

## File Structure

```
Kavach/
├── index.html    — Phone frame + all screen markup
├── style.css     — Complete design system (CSS variables, animations)
├── app.js        — All logic (router, engines, map, auth)
└── README.md
```

---

*SIMULATION DATA — All weather, request and location data is mock/simulated for demonstration purposes.*
