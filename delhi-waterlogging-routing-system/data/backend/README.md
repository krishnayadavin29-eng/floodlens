# Delhi JalAlert: Waterlogging Prediction & Safer Route Navigation (Frontend)

**Predict Risk. Plan Smarter. Travel Safer.**

A static, plain HTML/CSS/JavaScript frontend for a college project. It shows waterlogging risk on a Leaflet map of Delhi and compares alternative routes by travel time and *estimated* waterlogging exposure. It is built to be connected to a Python FastAPI + machine-learning backend later.

> **Demo mode is ON by default.** Risk scores, hotspots and reports are invented sample data (see `js/mock.js`). They are labelled "Demo data" / "illustrative" in the interface and are **not** real-time, official, or model output.

## Features

- **Navigation-style map**: light, Google-Maps-inspired street style (CARTO Voyager) with street names drawn *above* route lines; Light, Standard (OSM) and Satellite alternatives; zoom, my-location, recenter, layers, full screen, Delhi-overview buttons; attribution always visible
- **Route planner**: Driving / Two-wheeler / Walking / Cycling selector (honest about provider support), searchable start and destination with suggestions, "use my location" (asks permission first), click-the-map to pick (popup: Start here / Go here, or the crosshair buttons), reverse geocoding, swap, clear
- **Alternatives and comparison**: up to 3 real routes with duration, distance, arrival time, labels (Fastest / Lower waterlogging risk), overall risk, high-risk section count and distance, trade-off line, expandable section list, and a Fastest-vs-Lower-risk table
- **Segment-level waterlogging risk**: every route is drawn as separate road sections coloured green / amber / red / grey; click a section for risk, score, rainfall (if supplied), historical hotspot, prediction time and data status. One toggle switches risk colouring off (selected route turns blue, like a normal navigation app)
- **Start Journey** (route-following mode): live position, progress, remaining distance/time, next instruction *when the routing service supplies steps*, off-route notice with Recalculate, and warnings for high-risk sections ahead
- Optional analytical overlays (risk zones, historical hotspots) - **off by default**
- Dashboard, Location details, Report waterlogging, Incident history, About (unchanged)
- Collapsible side panel on desktop, bottom sheet and swipeable route cards on mobile

## Map, routing and geocoding providers

| Purpose | Default provider | Key needed? | Notes |
|---|---|---|---|
| Map tiles | CARTO Voyager raster tiles (OSM data). Also Light, OSM Standard, Esri Satellite | No | Free for light/educational use with attribution (shown). For production traffic use a plan from CARTO/MapTiler/Stadia or self-host. |
| Optional style | MapTiler Streets | **Yes** (`MAP.maptilerKey`) | Create a free account at <https://cloud.maptiler.com/>, create a *browser* key and **restrict it to your site's domain**. Leave empty to disable. Never use a private key. |
| Routing | OSRM, FOSSGIS public servers: `routed-car`, `routed-bike`, `routed-foot` | No | Separate real profiles, alternatives and turn steps. Fair use only; no uptime guarantee. Self-host OSRM for production. |
| Place search | Nominatim (OpenStreetMap) | No | 1 request/second enforced, debounced, cached, limited to Delhi-NCR. Set `GEOCODING.contactEmail`. |
| Weather | Open-Meteo | No | Non-commercial use with attribution. |
| Optional routing | openrouteservice | **Yes** (server-side only) | Put the key in a FastAPI proxy; set `ROUTING.provider = 'ors'` and `ROUTING.ors.baseUrl`. No turn steps in this adapter. |

### Travel modes

- **Driving, Walking, Cycling** use different OSRM servers, so the routes genuinely differ.
- **Two-wheeler is disabled**: no free routing provider offers a motorcycle/scooter profile. The app will not return a car route and call it a two-wheeler route. If you self-host OSRM with a motorcycle profile, add its URL to `ROUTING.osrm.endpoints` and set `supported: true` on the mode in `config.js`.

## Folder structure

```
delhi-jalalert/
├── index.html
├── css/        style.css  map.css  responsive.css
├── js/
│   ├── config.js        ← all settings (start here)
│   ├── app.js           bootstrap, navigation, header, layer toggles
│   ├── api.js           ALL backend + weather calls, response validation
│   ├── routing.js       route providers (OSRM / ORS), risk merge, ranking rules
│   ├── routePlanner.js  route planner UI and flow
│   ├── map.js           everything that touches Leaflet
│   ├── location.js      location details panel + map-click popup
│   ├── reports.js       report form + incident list
│   ├── dashboard.js     cards, weather, status, charts
│   ├── geocoding.js     Nominatim search (rate-limited, cached)
│   ├── geolocation.js   "use my location" with consent dialog
│   ├── autocomplete.js  accessible search dropdown
│   ├── mock.js          DEMO sample data + mock model (illustrative only)
│   ├── state.js, ui.js, utils.js
│   ├── journey.js       Start Journey mode (tracking, steps, warnings)
├── assets/logo.svg
└── README.md
```

## Troubleshooting: map not visible

- Hard-refresh (Ctrl+Shift+R) so the browser does not use an old `style.css`.
- Open the browser console (F12). A message that Leaflet could not load means the CDN is blocked or you are offline.
- Serve the folder over `http://` (Live Server), not `file://`.
- Fixed in v2: an empty `.nav-backdrop` element was becoming a desktop grid cell and collapsing the map to zero height. It is now `display: none` outside the mobile menu.

## Run locally

The app uses ES modules, so it must be served over HTTP. **Do not open `index.html` with `file://`.**

- **VS Code:** install *Live Server*, right-click `index.html` → *Open with Live Server*.
- **Python:** `cd delhi-jalalert && python -m http.server 5500`, then open <http://localhost:5500>.

You need an internet connection for the CDN libraries (Leaflet 1.9.4, Chart.js 4.4.1, Lucide 0.263.1, Inter font), map tiles, place search, routing and weather. The browser location feature needs `https://` or `localhost`.

## Configuration (`js/config.js`)

| Setting | Purpose |
|---|---|
| `DEMO_MODE` | `true` = sample data; `false` = use the FastAPI backend. You can also open `index.html?demo=0` or `?demo=1`. |
| `API_BASE_URL` | Backend URL, default `http://127.0.0.1:8000`. |
| `MAP.tileUrl` / `attribution` | Map tiles. |
| `RISK.thresholds` | Moderate/high cut-offs. **Must match the backend.** |
| `RISK.probabilityIsCalibrated` | Keep `false` unless your scores are calibrated probabilities (then they are labelled "probability" instead of "risk score"). |
| `MAP.styles`, `MAP.defaultStyle`, `MAP.maptilerKey` | Base-map styles and optional MapTiler key. |
| `ROUTING` | Provider (`osrm` or `ors`), per-mode server endpoints, alternatives. |
| `JOURNEY` | Warning distance and levels, off-route threshold, stale-data limit, simulation. |
| `GEOCODING` | Nominatim URL, debounce, rate limit, Delhi bounding box. |
| `WEATHER.provider` | `open-meteo`, `backend`, or `none`. |

### Demo mode vs API mode

- **Demo:** predictions, hotspots and route risk come from `js/mock.js` after a short delay. Reports are validated but **not sent**; the form says so. Real services are still used for map tiles, routing, place search and weather.
- **API mode:** every request goes to `API_BASE_URL`. If it fails, the UI shows an error with a retry button. It **never** silently falls back to fake data.
- If the routing service fails in demo mode, you may *explicitly* choose "Use sample routes". Those are smooth curves (not roads) and are labelled so.

## Usage limits and attribution

Attribution for the active map style is shown in the bottom-right of the map. Keep it visible. The footer credits OpenStreetMap, OSRM, Nominatim and Open-Meteo. Respect each provider's terms (see the provider table above); the public servers are for demos and light use.

## Backend API contract (proposed)

These endpoints are **proposals**, not existing services. Backend responses are validated in `js/api.js`; unknown or missing values become "Not available" / "Unknown", never "low".

`GET /health` → `{"status": "ok"}`

`POST /predict`
```json
{ "latitude": 28.6139, "longitude": 77.2090 }
```
→
```json
{
  "risk_level": "moderate",
  "risk_probability": 0.62,
  "risk_probability_calibrated": false,
  "prediction_timestamp": "2026-10-10T12:00:00Z",
  "data_status": "model"
}
```
Optional fields shown in the location panel when present: `recent_rainfall_mm`, `rainfall_1h_mm`, `rainfall_3h_mm`, `rainfall_24h_mm`, `terrain {elevation_m, slope_deg, description}`, `distance_to_drain_m`, `historical_hotspot {name, incident_count}`, `confirmed_current_reports`.

`POST /route-risk`: request and response exactly as in the project brief. The frontend sends `routes[].geometry` (GeoJSON LineString, `[lng, lat]`), `distance_m`, `duration_s` and `preference`. Each returned route needs `route_id`; `overall_risk`, `average_risk_probability`, `high_risk_segment_count`, `high_risk_distance_m` and `risk_segments[]` (`coordinates`, `risk_level`, `risk_probability`) are used when present. `data_status` is one of `example | model | forecast | historical | live`.

`GET /hotspots?min_lat&min_lng&max_lat&max_lng` → list (or `{"hotspots": [...]}`) of `{id, name, latitude, longitude, risk_level, risk_probability, historical_incident_count, rainfall_context, data_status, data_timestamp, radius_m}`.

`GET /reports?q&severity&status&from&to` → list of `{id, location, latitude, longitude, observed_at, severity, status (verified|unverified|historical), source, description}`.

`POST /reports` (multipart: `latitude, longitude, description, severity, observed_at, photo?`) → `{"status": "received", "report_id": "..."}`. A success message appears only if this response is received.

`GET /weather?lat&lon` (only if `WEATHER.provider = 'backend'`).

Enable CORS in FastAPI for your frontend origin:
```python
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5500"], allow_methods=["*"], allow_headers=["*"])
```

## Journey mode: what it is and is not

**It is** a browser-based route-following mode. Press **Start journey** on a selected route, allow location, and you get your position on the route, progress, remaining distance and estimated time, and the next instruction from the routing service. Steps and risk-section positions are matched to the route line by projecting them onto the route geometry.

**It is not** full GPS navigation: no voice guidance, no live traffic, no automatic re-routing (you press **Recalculate**, which re-plans from your position and follows the best route for your ranking preference). If the routing service sent no steps (e.g. sample routes, openrouteservice adapter), the app says "Route-following mode" and shows no instructions rather than inventing them.

- **Off-route**: after 2 position updates farther than `JOURNEY.offRouteM` (60 m, or 1.5 x GPS accuracy) a notice appears.
- **Waterlogging warnings**: when a section of level `JOURNEY.warnLevels` (default: high) is within `warnDistanceM` (600 m) ahead, a card shows approximate distance, section length, model score, data type and prediction time. It appears once per section, can be dismissed, and is suppressed when off-route, when risk data is unavailable, or when a risk section cannot be matched to the route. Data older than `staleRiskMinutes` is flagged as possibly outdated. Wording always says "estimated" and "not a confirmed flood report".
- **Without location permission** you can still view the route, steps and the list of risky sections (distances measured from the start).
- **Simulate (demo)** moves a clearly labelled *simulated* position along the route so you can demo the journey without travelling. Disable with `JOURNEY.allowSimulation = false`.

## Testing the navigation features

1. Run with Live Server. Open the browser console (F12) and check there are no red errors.
2. **Map**: street names should be readable; open the layers button to switch Map / Light / Standard / Satellite. Risk circles and hotspot markers should NOT be visible until switched on.
3. **Route**: choose start "New Delhi Railway Station", destination "India Gate", press **Find Routes**. Check each card's time and distance, click a card or a route line to select it, click a coloured section for the risk popup, and toggle "Colour routes by risk" in the layers menu.
4. **Modes**: pick Walking, then Cycling, press Find Routes again; the request URL (Network tab) should contain `routed-foot` / `routed-bike`. Two-wheeler should be disabled with an explanation.
5. **Journey**: press Start journey, allow location. In Chrome DevTools use *Sensors → Location* to set a position near your route, or press **Simulate (demo)**. Move toward a high-risk section to see the warning; set a faraway location to see the off-route notice; deny permission to see the route-only fallback.
6. Switch to mobile size (DevTools device toolbar): the map fills the screen, the panel is a bottom sheet, route cards swipe sideways.

Automated checks I ran for this version used headless Chromium with a stand-in for Leaflet (to record drawn lines) and OSRM-shaped test fixtures. They cannot prove real tile rendering, GPS behaviour or live provider responses, so please do step 1-6 above in a real browser.

## How route ranking works

Implemented in `js/routing.js` (`rankRoutes`):

- **Fastest:** shortest `duration_s` first.
- **Lowest risk:** lowest average risk score first (length-weighted from segments if the backend omits it); ties go to the faster route.
- **Balanced:** `0.5 × normalised time + 0.5 × normalised risk` (weight in `RANKING.balancedTimeWeight`), normalised across the routes returned.
- Routes without risk data are placed after assessed routes. If none has risk data, routes are ordered by time and the UI says so.

The routing engine does not avoid flooded roads. It returns candidates and the risk model scores them afterwards.

In demo mode the mock model gives each ~400 m piece of a route a score from its distance to the sample hotspots, merges neighbouring pieces with the same level, and calls the route high if at least 10% is high-risk (see `mockRouteRisk`). This is a stand-in, not a real model.

## Known limitations

- Demo data is fictional; hotspot coordinates are approximate.
- Two-wheeler routing is disabled (no provider support).
- Journey mode is route-following, not full turn-by-turn GPS navigation; browser location accuracy and background tracking depend on the device and browser (the page must stay open).
- Public routing/tile servers may be slow or rate-limited.
- The public OSRM and Nominatim servers can be slow, rate-limited or offline; the app shows errors and retry buttons.
- No user accounts; reports are not stored anywhere in demo mode.
- No automated tests; logic was exercised with Node scripts and the interface should be checked in a browser.
- Risk estimates are not guarantees. Conditions change quickly. This is not an official warning service.

## Deploy the static frontend

Upload the folder to any static host (GitHub Pages, Netlify, Vercel static, S3). Then set `DEMO_MODE`, `API_BASE_URL` (must be `https://` when the site is `https://`), and enable CORS on the backend.

## Privacy

Only harmless UI preferences (layer toggles, route preference, travel mode) are kept in `localStorage`. Location, routes and reports are held in memory only.
