# ChetnaSync: Product Requirements Document (PRD)

## 1. Product Overview
**ChetnaSync** is a resilient, offline-capable disaster response system designed to bridge the "last mile" communication gap during natural disasters. When cellular grids degrade and standard navigation apps fail, ChetnaSync provides citizens with cached maps, hazard visualization, and an SMS-fallback SOS system to reach emergency responders.

## 2. Architectural Philosophy: The "Zero-Install" Paradigm
ChetnaSync is built for instant deployment and maximum portability. It eliminates package managers and build steps:
- **Frontend (Zero-Install HTML):** Vanilla JavaScript with Leaflet.js loaded from CDN. Service worker caches static assets for offline use.
- **Backend (Zero-Dependency Node):** A standalone Node.js server using only built-in modules (`http`, `fs`, `path`, `crypto`, `https`, `url`). No npm packages required.

## 3. Core Features

### 3.1 Geo-Targeted Danger Mapping
The backend parses government SACHET CAP XML alerts to extract GPS coordinates of disaster zones. The frontend renders these as precise 'Red Zone' polygons on an interactive map, replacing generic district-wide text warnings.

### 3.2 Offline-Capable Resilience
A Progressive Web App (PWA) Service Worker caches static assets (HTML, JS, CSS) and public API responses (hazard zones, shelters) while online. If connectivity is lost, previously cached map tiles and hazard data remain available. **Note:** Full offline functionality requires that data was cached during a previous online session. Map tiles not yet cached will not be available offline.

### 3.3 Avoidance Routing
Using the OpenRouteService API (proxied through the backend to protect API keys), the app calculates escape routes to the nearest verified government shelter with hazard avoidance. **Note:** Route avoidance depends on ORS API availability and the accuracy of the hazard polygon. The backend validates returned routes against the hazard polygon and warns if intersection is detected.

### 3.4 Dual-Mode Triage & SMS Fallback
Users select from a triage menu: **Safe, Need Rescue, Injured, or Trapped**.
- **Online Mode:** Sends an HTTP POST/PUT/PATCH request with GPS coordinates.
- **Offline Mode:** Opens a native `sms:` intent pre-filled with the user's GPS coordinates and status. The SMS is received by a Twilio webhook with cryptographic signature verification.

### 3.5 Responder Authority Dashboard
An authenticated real-time command center for authorities. Displays the hazard map alongside live color-coded markers representing citizen statuses (Green = Safe, Orange = Rescue, Dark Orange = Injured, Flashing Red = Trapped). Requires admin login.

## 4. Technical Stack
- **Frontend:** HTML5, Vanilla JavaScript, Leaflet.js (CDN), Service Workers (PWA)
- **Backend:** Node.js (built-in modules only)
- **Database:** Local JSON persistence (`citizens.json` via atomic file writes)
- **Integrations:** OpenRouteService (routing), Twilio (offline SMS)

## 5. Security Architecture
- **Authentication:** Server-side admin authentication with environment-variable credentials. Session tokens with 24-hour expiry.
- **Webhook Security:** Twilio HMAC-SHA1 signature verification on all SMS webhooks.
- **Input Validation:** Strict validation of all inputs including status enums, coordinate ranges, ID formats, and phone numbers.
- **Path Traversal Protection:** Null-byte rejection, encoded path normalization, directory containment checks.
- **Rate Limiting:** Per-IP rate limits on authentication, triage, and SOS endpoints.
- **Security Headers:** X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy.
- **XSS Prevention:** All user-supplied data rendered with textContent/DOM APIs, never innerHTML.
- **CORS:** Restricted to configured origins.

## 6. Data & Privacy
- **Retention:** Citizen records are automatically purged after 72 hours (configurable).
- **Minimal Data:** Only ID, status, coordinates, and timestamp are stored.
- **No PII in Logs:** Structured logging excludes personal identifiers and credentials.
- **Backups:** Production deployments should implement external backup of `citizens.json`.

## 7. Deployment
- **Requirements:** Node.js 18+ (no other dependencies)
- **Configuration:** Environment variables via `.env` file or system environment
- **Startup:** `node start.js` with graceful shutdown support (SIGTERM/SIGINT)
- **Health Monitoring:** `/health` (liveness) and `/ready` (readiness) endpoints
- **Platforms:** Windows, Linux, macOS, Docker
