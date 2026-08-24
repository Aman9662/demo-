# ChetnaSync

A zero-dependency, offline-capable disaster response system. Bridges the last mile in disaster communication when cellular networks degrade.

## Prerequisites

- **Node.js 18+** (no other dependencies required)

## Quick Start

### 1. Configure Environment

```bash
# Copy the example environment file
cp backend/.env.example backend/.env

# Edit backend/.env and fill in required values:
# ADMIN_USERNAME, ADMIN_PASSWORD, TWILIO_AUTH_TOKEN
```

### 2. Start the Server

**Windows (PowerShell):**
```powershell
$env:ADMIN_USERNAME="your_admin_user"
$env:ADMIN_PASSWORD="your_secure_password"
$env:TWILIO_AUTH_TOKEN="your_twilio_token"
node start.js
```

**Windows (Command Prompt):**
```cmd
set ADMIN_USERNAME=your_admin_user
set ADMIN_PASSWORD=your_secure_password
set TWILIO_AUTH_TOKEN=your_twilio_token
node start.js
```

**Linux / macOS:**
```bash
export ADMIN_USERNAME=your_admin_user
export ADMIN_PASSWORD=your_secure_password
export TWILIO_AUTH_TOKEN=your_twilio_token
node start.js
```

**Using .env file (any platform):**
```bash
# Fill in backend/.env, then:
node start.js
```

### 3. Access the Application

Open `http://localhost:3000` in your browser.

- **Citizen Portal:** No login required. Submit emergency status, view hazard maps.
- **Admin Dashboard:** Click "Admin Login" on the home page. Use your configured credentials.

## Running Tests

```bash
node --test backend/server.test.js
```

Tests use Node's built-in test runner. No npm packages required.

## Project Structure

```
demo/
├── backend/
│   ├── server.js          # Main server (zero dependencies)
│   ├── server.test.js     # Comprehensive test suite
│   ├── mock_sachet.xml    # Sample SACHET CAP XML alert
│   ├── .env.example       # Environment variable template
│   └── citizens.json      # Runtime database (auto-created, gitignored)
├── frontend/
│   ├── home.html          # Landing page with portal selection
│   ├── index.html         # Main app (citizen + dashboard views)
│   └── sw.js              # Service worker for offline support
├── start.js               # Production startup script
├── API_DOCS.md            # API documentation
├── PRD.md                 # Product requirements document
└── README.md              # This file
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_USERNAME` | Yes | — | Admin login username |
| `ADMIN_PASSWORD` | Yes | — | Admin login password |
| `TWILIO_AUTH_TOKEN` | Yes | — | Twilio auth token for webhook verification |
| `ORS_API_KEY` | No | — | OpenRouteService API key for routing |
| `PORT` | No | 3000 | Server listening port |
| `ALLOWED_ORIGINS` | No | `http://localhost:3000` | Comma-separated CORS origins |
| `SMS_NUMBER` | No | — | SMS gateway phone number |
| `RETENTION_HOURS` | No | 72 | Hours to retain citizen records |

## API Endpoints

See [API_DOCS.md](API_DOCS.md) for full documentation.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | /health | No | Liveness check |
| GET | /ready | No | Readiness check |
| POST | /api/login | No | Admin authentication |
| GET | /api/hazard | No | Hazard zone polygon |
| GET | /api/verified-shelters | No | Shelter locations |
| POST | /api/triage/status | No | Citizen status update |
| POST | /api/sms/sos | Twilio | SMS webhook receiver |
| GET | /api/citizens | Bearer | Dashboard data |
| POST | /api/route | No | Route calculation proxy |

## Security

- No default credentials — admin username and password must be set via environment variables
- Twilio webhook signature verification (HMAC-SHA1)
- Path traversal protection with null-byte and encoding guards
- Per-IP rate limiting on all endpoints
- Security headers on all responses
- XSS prevention via DOM API rendering (never innerHTML)
- CORS restricted to configured origins
- Session tokens with 24-hour expiry
- Atomic file writes prevent data corruption

## Data Retention & Backups

- Citizen records are automatically purged after the configured retention window (default: 72 hours)
- The `citizens.json` file should be backed up regularly in production
- Back up by copying `backend/citizens.json` to a secure location
- To restore, place the backup file at `backend/citizens.json` and restart the server

## Incident Response

1. **Server not starting:** Check that all required env vars are set. Check `node --check backend/server.js` for syntax errors.
2. **Authentication issues:** Verify `ADMIN_USERNAME` and `ADMIN_PASSWORD` env vars. Sessions expire after 24 hours.
3. **SMS not working:** Verify `TWILIO_AUTH_TOKEN` matches your Twilio account. Check webhook URL configuration in Twilio dashboard.
4. **Routing unavailable:** Verify `ORS_API_KEY` is set and valid. The app gracefully degrades without routing.
5. **Data corruption:** The server uses atomic writes. If `citizens.json` is corrupted, delete it — the server will start with an empty database.
6. **High load:** Rate limiting protects the server. Consider placing behind a reverse proxy (nginx) for production.

## Production Deployment

1. Set strong, unique `ADMIN_USERNAME` and `ADMIN_PASSWORD`
2. Configure `TWILIO_AUTH_TOKEN` from your Twilio dashboard
3. Set `ALLOWED_ORIGINS` to your production domain
4. Place behind a reverse proxy (nginx/caddy) with TLS termination
5. Set up process management (systemd, pm2, or Docker)
6. Configure automated backups of `citizens.json`
7. Monitor `/health` and `/ready` endpoints
