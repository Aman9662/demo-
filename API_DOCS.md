# ChetnaSync API Documentation

Zero-dependency Node.js backend for disaster response coordination.

**Base URL:** `http://localhost:3000` (or your deployment URL)

## Authentication

Protected endpoints require a Bearer token obtained from `/api/login`:
```
Authorization: Bearer <token>
```
Tokens expire after 24 hours.

## Error Format

All API errors return JSON:
```json
{ "error": "Error description" }
```

## Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| POST /api/login | 5 requests | 1 minute |
| POST /api/sms/sos | 10 requests | 1 minute |
| POST /api/triage/status | 20 requests | 1 minute |
| All other endpoints | 100 requests | 1 minute |

Rate limits are per IP address. Exceeding returns `429 Too Many Requests`.

---

## Endpoints

### Health Check
- **GET /health**
- **Auth:** No
- **Response:** `200 OK`
```json
{ "status": "ok" }
```

### Readiness Check
- **GET /ready**
- **Auth:** No
- **Response:** `200 OK`
```json
{ "status": "ready" }
```

### Admin Login
- **POST /api/login**
- **Auth:** No
- **Content-Type:** application/json
- **Request Body:**
```json
{ "username": "string", "password": "string" }
```
- **Success (200):**
```json
{ "token": "hex-string" }
```
- **Failure (401):**
```json
{ "error": "Unauthorized" }
```

### Get Hazard Zone
Fetches the active disaster polygon parsed from SACHET CAP XML.
- **GET /api/hazard**
- **Auth:** No (public endpoint)
- **Success (200):**
```json
{
  "type": "FeatureCollection",
  "features": [{
    "type": "Feature",
    "properties": { "type": "hazard" },
    "geometry": {
      "type": "Polygon",
      "coordinates": [[[72.870, 19.080], ...]]
    }
  }]
}
```

### Get Verified Shelters
- **GET /api/verified-shelters**
- **Auth:** No (public endpoint)
- **Success (200):** GeoJSON FeatureCollection with Point features.

### Update Citizen Status
Allows the citizen app to submit triage status.
- **POST, PUT, PATCH /api/triage/status**
- **Auth:** No (citizen-facing)
- **Content-Type:** application/json
- **Request Body:**
```json
{
  "id": "user-1234",
  "status": "SAFE|RESCUE|INJURED|TRAPPED",
  "lat": 19.070,
  "lon": 72.875
}
```
- **Validation:**
  - `id`: 1-100 chars, alphanumeric/hyphen/underscore only
  - `status`: Must be SAFE, RESCUE, INJURED, or TRAPPED
  - `lat`: Finite number, -90 to 90
  - `lon`: Finite number, -180 to 180
  - POST/PUT require all fields; PATCH allows partial updates
- **Success (200):**
```json
{ "success": true }
```

### SMS SOS Webhook (Twilio)
Receives Twilio SMS webhooks for offline citizen status.
- **POST /api/sms/sos**
- **Auth:** Twilio signature (X-Twilio-Signature header, HMAC-SHA1)
- **Content-Type:** application/x-www-form-urlencoded
- **Expected Fields:** `From` (E.164 phone), `Body` (structured payload)
- **Body Format:** `STATUS:SAFE LAT:19.070 LON:72.875`
- **Success (200):** Returns TwiML: `<Response></Response>`

### Get Citizens (Dashboard)
- **GET /api/citizens**
- **Auth:** Required (Bearer token)
- **Success (200):**
```json
[
  {
    "id": "user-1234",
    "status": "INJURED",
    "lat": 19.070,
    "lon": 72.875,
    "lastUpdated": "2026-08-23T10:30:35.334Z"
  }
]
```

### Route Calculation (Proxy)
Proxies routing requests to OpenRouteService with server-side API key.
- **POST /api/route**
- **Auth:** No
- **Content-Type:** application/json
- **Requires:** `ORS_API_KEY` environment variable
- **Request Body:**
```json
{
  "coordinates": [[72.875, 19.070], [72.8777, 19.0760]],
  "options": {
    "avoid_polygons": {
      "type": "Polygon",
      "coordinates": [[[72.870, 19.080], ...]]
    }
  }
}
```
- **Success (200):** GeoJSON response from OpenRouteService with route validated against hazard polygon.
- **Unavailable (503):** When ORS_API_KEY is not configured.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| ADMIN_USERNAME | Yes | Admin login username |
| ADMIN_PASSWORD | Yes | Admin login password |
| TWILIO_AUTH_TOKEN | Yes | Twilio auth token for webhook verification |
| ORS_API_KEY | No | OpenRouteService API key for routing |
| PORT | No | Server port (default: 3000) |
| ALLOWED_ORIGINS | No | Comma-separated CORS origins |
| SMS_NUMBER | No | SMS gateway number for offline fallback |
| RETENTION_HOURS | No | Data retention window (default: 72) |

---

## Security Headers

All responses include:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: geolocation=(self)`

---

## 6. Login
Authenticates admin users and issues a session token.

- **Endpoint:** POST /api/login
- **Auth Required:** No
- **Content-Type:** pplication/json
- **Request Body:**
  `json
  { "username": "admin", "password": "..." }
  `
- **Success Response (200 OK):**
  `json
  { "token": "a1b2c3d4..." }
  `

---

## 7. Proxied Route Request
Fetches directions via ORS securely using the backend proxy, eliminating client-side API keys.

- **Endpoint:** POST /api/route
- **Auth Required:** No
- **Content-Type:** pplication/json
- **Request Body:**
  `json
  { "coordinates": [[72.8, 19.0], [72.9, 19.1]], "options": { "avoid_polygons": { ... } } }
  `
- **Success Response (200 OK):**
  GeoJSON Directions
