const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Defaults ────────────────────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'citizens.json');
const FRONTEND_DIR = path.resolve(path.join(__dirname, '..', 'frontend'));
const VALID_STATUSES = ['SAFE', 'RESCUE', 'INJURED', 'TRAPPED'];
const ID_RE = /^[a-zA-Z0-9_\-\.\+@]+$/;
const E164_RE = /^\+[1-9]\d{1,14}$/;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const ALLOWED_EXTENSIONS = new Set([
  '.html', '.js', '.css', '.json', '.png', '.jpg', '.jpeg',
  '.svg', '.ico', '.webmanifest', '.woff', '.woff2'
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

// ── Env Loader ──────────────────────────────────────────────────────────────
function loadEnv(envPath) {
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (_) { /* .env file is optional */ }
}

// ── Structured Logger ───────────────────────────────────────────────────────
function log(level, message, meta) {
  const entry = { timestamp: new Date().toISOString(), level, message };
  if (meta) {
    const safe = Object.assign({}, meta);
    // Never log secrets or PII
    delete safe.password; delete safe.token; delete safe.authorization;
    delete safe.cookie; delete safe.secret;
    Object.assign(entry, safe);
  }
  const out = JSON.stringify(entry) + '\n';
  if (level === 'error') process.stderr.write(out);
  else process.stdout.write(out);
}

// ── Rate Limiter ────────────────────────────────────────────────────────────
class RateLimiter {
  constructor() { this.windows = new Map(); }

  check(key, limit, windowMs) {
    windowMs = windowMs || 60000;
    const now = Date.now();
    let timestamps = this.windows.get(key);
    if (!timestamps) { timestamps = []; this.windows.set(key, timestamps); }
    while (timestamps.length > 0 && timestamps[0] <= now - windowMs) timestamps.shift();
    if (timestamps.length >= limit) return false;
    timestamps.push(now);
    return true;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, ts] of this.windows) {
      while (ts.length > 0 && ts[0] <= now - 120000) ts.shift();
      if (ts.length === 0) this.windows.delete(key);
    }
  }
}

// ── Timing-Safe String Compare ──────────────────────────────────────────────
function timingSafeStringEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

// ── CAP XML Polygon Parser ─────────────────────────────────────────────────
function parseCAPPolygon(xmlString) {
  if (typeof xmlString !== 'string' || xmlString.length === 0) {
    return { error: 'Empty or invalid XML input' };
  }
  const match = xmlString.match(/<polygon>([\s\S]*?)<\/polygon>/);
  if (!match) return { error: 'No <polygon> element found in CAP XML' };

  const raw = match[1].trim();
  if (!raw) return { error: 'Empty polygon element' };
  if (!/^[0-9., \t\r\n-]+$/.test(raw)) {
    return { error: 'Invalid characters in polygon coordinates' };
  }

  const pairs = raw.split(/\s+/).filter(Boolean);
  if (pairs.length < 4) {
    return { error: 'Polygon must have at least 4 coordinate pairs (including closure)' };
  }

  const points = [];
  for (const pair of pairs) {
    const parts = pair.split(',');
    if (parts.length !== 2) return { error: 'Invalid coordinate pair: ' + pair };
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { error: 'Non-finite coordinate: ' + pair };
    }
    if (lat < -90 || lat > 90) return { error: 'Latitude out of range: ' + lat };
    if (lon < -180 || lon > 180) return { error: 'Longitude out of range: ' + lon };
    points.push([lon, lat]); // GeoJSON format [lon, lat]
  }

  // Validate closure
  const first = points[0], last = points[points.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return { error: 'Polygon is not closed (first point must equal last point)' };
  }

  return { points };
}

// ── Point-in-Polygon (ray casting) ──────────────────────────────────────────
function pointInPolygon(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Atomic Write Queue ──────────────────────────────────────────────────────
let writeQueue = Promise.resolve();
function atomicWriteJSON(filePath, data) {
  const p = writeQueue.then(() => {
    return new Promise((resolve, reject) => {
      const tmp = filePath + '.tmp';
      const content = JSON.stringify(data);
      fs.writeFile(tmp, content, 'utf8', (err) => {
        if (err) return reject(err);
        fs.rename(tmp, filePath, (err2) => {
          if (err2) return reject(err2);
          resolve();
        });
      });
    });
  }).catch((err) => {
    log('error', 'Atomic write failed', { error: err.message });
  });
  writeQueue = p;
  return p;
}

// ── createApp Factory ───────────────────────────────────────────────────────
function createApp(options) {
  options = options || {};
  const dbFile = options.dbFile || DB_FILE;
  const frontendDir = options.frontendDir != null ? path.resolve(options.frontendDir) : FRONTEND_DIR;
  const twilioAuthToken = options.twilioAuthToken || process.env.TWILIO_AUTH_TOKEN || '';
  const adminUsername = options.adminUsername || process.env.ADMIN_USERNAME || '';
  const adminPassword = options.adminPassword || process.env.ADMIN_PASSWORD || '';
  const allowedOrigins = options.allowedOrigins ||
    (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  const orsApiKey = options.orsApiKey || process.env.ORS_API_KEY || '';
  const retentionMs = (parseInt(options.retentionHours || process.env.RETENTION_HOURS, 10) || 72) * 3600000;

  // ── Sessions ──────────────────────────────────────────────────────────────
  const sessions = new Map();
  if (options.testToken) sessions.set(options.testToken, { createdAt: Date.now() });

  function isValidSession(token) {
    const session = sessions.get(token);
    if (!session) return false;
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  // ── Citizens DB ───────────────────────────────────────────────────────────
  let citizens = new Map();
  const rateLimiter = new RateLimiter();

  function loadDB() {
    if (!fs.existsSync(dbFile)) {
      log('info', 'No DB file found, starting with empty database');
      return;
    }
    try {
      const raw = fs.readFileSync(dbFile, 'utf8');
      if (!raw.trim()) { log('info', 'Empty DB file, starting fresh'); return; }
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) { log('warn', 'DB file is not an array, starting fresh'); return; }
      for (const entry of data) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const key = entry[0], val = entry[1];
        // Sanitize: skip entries with invalid IDs (HTML injection)
        if (typeof key !== 'string') continue;
        if (!ID_RE.test(key) && !E164_RE.test(key)) {
          log('warn', 'Skipping citizen with invalid ID format on load');
          continue;
        }
        if (val && typeof val === 'object' && VALID_STATUSES.includes(val.status)) {
          citizens.set(key, val);
        }
      }
      log('info', 'Loaded citizens from DB', { count: citizens.size });
    } catch (err) {
      log('error', 'Error parsing DB file, starting fresh', { error: err.message });
    }
  }

  function saveDB() {
    return atomicWriteJSON(dbFile, Array.from(citizens.entries()));
  }

  function purgeOldRecords() {
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    let purged = 0;
    for (const [key, val] of citizens) {
      if (val.lastUpdated && val.lastUpdated < cutoff) {
        citizens.delete(key);
        purged++;
      }
    }
    if (purged > 0) {
      log('info', 'Purged old citizen records', { count: purged });
      saveDB();
    }
  }

  if (!options.skipDbLoad) loadDB();
  if (!options.skipDbLoad) purgeOldRecords();

  // Retention cleanup interval
  let retentionInterval;
  if (!options.skipRetention) {
    retentionInterval = setInterval(purgeOldRecords, 3600000);
    if (retentionInterval.unref) retentionInterval.unref();
  }

  // Rate limiter cleanup
  const rlInterval = setInterval(function() { rateLimiter.cleanup(); }, 60000);
  if (rlInterval.unref) rlInterval.unref();

  // ── Helpers ───────────────────────────────────────────────────────────────
  function getClientIP(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  }

  function setSecurityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(self)');
  }

  function setCorsHeaders(req, res) {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Twilio-Signature, Authorization');
  }

  function jsonError(res, status, message) {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }

  function jsonOk(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  function checkAuth(req, res) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
      jsonError(res, 401, 'Unauthorized');
      return false;
    }
    const token = auth.slice(7);
    if (!isValidSession(token)) {
      jsonError(res, 401, 'Unauthorized');
      return false;
    }
    return true;
  }

  function getBody(req, callback, limit) {
    limit = limit || 10240;
    let body = '';
    let tooLarge = false;
    req.on('data', function(chunk) {
      body += chunk.toString();
      if (body.length > limit) { tooLarge = true; req.destroy(); }
    });
    req.on('error', function() { callback(null, new Error('Request error')); });
    req.on('end', function() {
      if (tooLarge) return callback(null, new Error('Payload too large'));
      try {
        const ct = req.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          const parsed = JSON.parse(body);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return callback(null, new Error('Invalid JSON: expected object'));
          }
          callback(parsed, null);
        } else if (ct.includes('application/x-www-form-urlencoded')) {
          callback(new URLSearchParams(body), null);
        } else {
          callback(null, new Error('Unsupported content type'));
        }
      } catch (e) { callback(null, e); }
    });
  }

  // ── HTTPS Post Helper (for route proxy) ───────────────────────────────────
  function httpsPost(reqUrl, bodyObj, headers) {
    return new Promise(function(resolve, reject) {
      const parsed = new URL(reqUrl);
      const bodyStr = JSON.stringify(bodyObj);
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: Object.assign({
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr)
        }, headers || {})
      };
      const r = https.request(opts, function(resp) {
        let data = '';
        resp.on('data', function(chunk) { data += chunk; });
        resp.on('end', function() { resolve({ status: resp.statusCode, data: data }); });
      });
      r.on('error', reject);
      r.setTimeout(15000, function() { r.destroy(new Error('Timeout')); });
      r.write(bodyStr);
      r.end();
    });
  }

  // ── Cached hazard polygon for route validation ────────────────────────────
  let cachedHazardPolygon = null;

  // ── Request Handler ───────────────────────────────────────────────────────
  function handler(req, res) {
    setSecurityHeaders(res);
    setCorsHeaders(req, res);

    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    // Null byte check on raw URL
    if (req.url.indexOf('\0') !== -1) {
      return jsonError(res, 400, 'Bad Request');
    }

    // Parse URL path
    var urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split('?')[0]);
    } catch (e) {
      return jsonError(res, 400, 'Bad Request');
    }

    // Second null byte check after decode
    if (urlPath.indexOf('\0') !== -1) {
      return jsonError(res, 400, 'Bad Request');
    }

    var clientIP = getClientIP(req);

    // ── Health / Ready ────────────────────────────────────────────────────
    if (urlPath === '/health') {
      if (req.method !== 'GET') return jsonError(res, 405, 'Method Not Allowed');
      return jsonOk(res, { status: 'ok' });
    }

    if (urlPath === '/ready') {
      if (req.method !== 'GET') return jsonError(res, 405, 'Method Not Allowed');
      // Check that we can write to DB directory
      try {
        var dbDir = path.dirname(dbFile);
        fs.accessSync(dbDir, fs.constants.W_OK);
        return jsonOk(res, { status: 'ready' });
      } catch (e) {
        return jsonError(res, 503, 'Not Ready');
      }
    }

    // ── API Routes ──────────────────────────────────────────────────────
    if (urlPath.startsWith('/api/')) {
      return handleAPI(req, res, urlPath, clientIP);
    }

    // ── Static Files ────────────────────────────────────────────────────
    return serveStatic(req, res, urlPath);
  }

  // ── API Handler ───────────────────────────────────────────────────────────
  function handleAPI(req, res, urlPath, clientIP) {
    // General rate limit for API
    if (!rateLimiter.check('api:' + clientIP, 100, 60000)) {
      return jsonError(res, 429, 'Too Many Requests');
    }

    // ── Login ─────────────────────────────────────────────────────────────
    if (urlPath === '/api/login') {
      if (req.method !== 'POST') return jsonError(res, 405, 'Method Not Allowed');
      if (!rateLimiter.check('login:' + clientIP, 5, 60000)) {
        return jsonError(res, 429, 'Too Many Requests');
      }
      if (!adminUsername || !adminPassword) {
        return jsonError(res, 503, 'Authentication not configured');
      }
      getBody(req, function(body, err) {
        if (err || !body) return jsonError(res, 400, 'Bad Request');
        if (typeof body.username !== 'string' || typeof body.password !== 'string') {
          return jsonError(res, 400, 'Bad Request');
        }
        if (timingSafeStringEqual(body.username, adminUsername) &&
            timingSafeStringEqual(body.password, adminPassword)) {
          var token = crypto.randomBytes(32).toString('hex');
          sessions.set(token, { createdAt: Date.now() });
          return jsonOk(res, { token: token, session_token: token });
        }
        return jsonError(res, 401, 'Unauthorized');
      });
      return;
    }

    // ── Hazard ────────────────────────────────────────────────────────────
    if (urlPath === '/api/hazard') {
      if (req.method !== 'GET') return jsonError(res, 405, 'Method Not Allowed');
      var xmlPath = path.join(__dirname, 'mock_sachet.xml');
      fs.readFile(xmlPath, 'utf8', function(err, data) {
        if (err) return jsonError(res, 500, 'Failed to read hazard data');
        var result = parseCAPPolygon(data);
        if (result.error) return jsonError(res, 500, 'Invalid hazard data: ' + result.error);

        cachedHazardPolygon = result.points;
        var geojson = {
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            properties: { type: 'hazard' },
            geometry: { type: 'Polygon', coordinates: [result.points] }
          }]
        };
        return jsonOk(res, geojson);
      });
      return;
    }

    // ── Verified Shelters ─────────────────────────────────────────────────
    if (urlPath === '/api/verified-shelters') {
      if (req.method !== 'GET') return jsonError(res, 405, 'Method Not Allowed');
      return jsonOk(res, {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: { name: 'Govt School Shelter' },
          geometry: { type: 'Point', coordinates: [72.8777, 19.0760] }
        }]
      });
    }

    // ── Triage Status ─────────────────────────────────────────────────────
    if (urlPath === '/api/triage/status') {
      if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
        return jsonError(res, 405, 'Method Not Allowed');
      }
      if (!rateLimiter.check('triage:' + clientIP, 20, 60000)) {
        return jsonError(res, 429, 'Too Many Requests');
      }
      getBody(req, function(body, err) {
        if (err) {
          if (err.message === 'Payload too large') return jsonError(res, 413, 'Payload Too Large');
          return jsonError(res, 400, 'Bad Request');
        }
        if (!body) return jsonError(res, 400, 'Bad Request');

        // Validate id
        if (!body.id || typeof body.id !== 'string' || body.id.trim().length === 0 || body.id.length > 100 || !ID_RE.test(body.id)) {
          return jsonError(res, 400, 'Invalid id format');
        }

        // Reject unknown fields
        var allowed = ['id', 'status', 'lat', 'lon'];
        for (var key in body) {
          if (Object.prototype.hasOwnProperty.call(body, key) && !allowed.includes(key)) {
            return jsonError(res, 400, 'Unknown field: ' + key);
          }
        }

        var existing = citizens.get(body.id) || {};

        // POST/PUT require all fields
        if (['POST', 'PUT'].includes(req.method)) {
          if (!body.status || body.lat === undefined || body.lon === undefined) {
            return jsonError(res, 400, 'Missing required fields: status, lat, lon');
          }
        }

        // Validate status
        if (body.status !== undefined) {
          if (!VALID_STATUSES.includes(body.status)) {
            return jsonError(res, 400, 'Invalid status. Must be SAFE, RESCUE, INJURED, or TRAPPED');
          }
        }

        // Validate coordinates
        if (body.lat !== undefined) {
          if (typeof body.lat !== 'number' || !Number.isFinite(body.lat) || body.lat < -90 || body.lat > 90) {
            return jsonError(res, 400, 'Invalid latitude');
          }
        }
        if (body.lon !== undefined) {
          if (typeof body.lon !== 'number' || !Number.isFinite(body.lon) || body.lon < -180 || body.lon > 180) {
            return jsonError(res, 400, 'Invalid longitude');
          }
        }

        citizens.set(body.id, {
          id: body.id,
          status: body.status || existing.status || 'SAFE',
          lat: body.lat !== undefined ? body.lat : existing.lat,
          lon: body.lon !== undefined ? body.lon : existing.lon,
          lastUpdated: new Date().toISOString()
        });
        saveDB();
        return jsonOk(res, { success: true });
      });
      return;
    }

    // ── SMS SOS (httpSMS Webhook) ─────────────────────────────────────────
    if (urlPath === '/api/sms/sos') {
      if (req.method !== 'POST') return jsonError(res, 405, 'Method Not Allowed');
      if (!rateLimiter.check('sos:' + clientIP, 10, 60000)) {
        return jsonError(res, 429, 'Too Many Requests');
      }
      
      getBody(req, function(body, err) {
        if (err || !body) return jsonError(res, 400, 'Bad Request');
        
        let jsonBody;
        try {
          // Fallback if body is already parsed by a previous layer (though getBody returns raw string/buffer for API)
          jsonBody = typeof body === 'string' ? JSON.parse(body) : body;
        } catch (e) {
          return jsonError(res, 400, 'Invalid JSON');
        }

        // httpSMS sends CloudEvents format
        if (jsonBody.type !== 'message.phone.received' || !jsonBody.data) {
          return jsonOk(res, { ignored: true });
        }

        var from = jsonBody.data.contact;
        var text = jsonBody.data.content;
        
        if (!from || !text || typeof from !== 'string') {
          return jsonError(res, 400, 'Missing contact or content');
        }

        // Validate phone number format
        if (!E164_RE.test(from)) {
          return jsonError(res, 400, 'Invalid phone number format');
        }

        var sMatch = text.match(/STATUS:([A-Z]+)/);
        var laMatch = text.match(/LAT:([0-9.\-]+)/);
        var loMatch = text.match(/LON:([0-9.\-]+)/);
        if (sMatch && laMatch && loMatch) {
          var parsedLat = parseFloat(laMatch[1]);
          var parsedLon = parseFloat(loMatch[1]);
          if (VALID_STATUSES.includes(sMatch[1]) &&
              Number.isFinite(parsedLat) && parsedLat >= -90 && parsedLat <= 90 &&
              Number.isFinite(parsedLon) && parsedLon >= -180 && parsedLon <= 180) {
            citizens.set(from, {
              id: from, status: sMatch[1],
              lat: parsedLat, lon: parsedLon,
              lastUpdated: new Date().toISOString()
            });
            saveDB();
          }
        }
        return jsonOk(res, { success: true });
      });
      return;
    }

    // ── Citizens (Dashboard) ──────────────────────────────────────────────
    if (urlPath === '/api/citizens') {
      if (req.method !== 'GET') return jsonError(res, 405, 'Method Not Allowed');
      return jsonOk(res, Array.from(citizens.values()));
    }

    // ── Route Proxy ─────────────────────────────────────────────────────
    if (urlPath === '/api/route') {
      if (req.method !== 'POST') return jsonError(res, 405, 'Method Not Allowed');
      getBody(req, function(body, err) {
        if (err || !body) return jsonError(res, 400, 'Bad Request');
        if (!body.coordinates || !Array.isArray(body.coordinates) || body.coordinates.length < 2) {
          return jsonError(res, 400, 'Invalid coordinates');
        }
        
        for (var i = 0; i < body.coordinates.length; i++) {
          var pt = body.coordinates[i];
          if (!Array.isArray(pt) || pt.length !== 2 || typeof pt[0] !== 'number' || typeof pt[1] !== 'number') {
            return jsonError(res, 400, 'Invalid coordinate format');
          }
        }

        var orsBody = {
          coordinates: body.coordinates
        };
        if (body.options && body.options.avoid_polygons) {
          orsBody.options = { avoid_polygons: body.options.avoid_polygons };
        }

        if (!orsApiKey) return jsonError(res, 503, 'Routing service not configured');

        httpsPost(
          'https://api.openrouteservice.org/v2/directions/foot-walking/geojson',
          orsBody,
          { 'Authorization': orsApiKey }
        ).then(function(orsRes) {
          try {
            var routeData = JSON.parse(orsRes.data);
            if (orsRes.status !== 200) {
              return jsonError(res, 502, 'Routing provider error');
            }

            // Validate route against hazard polygon
            if (cachedHazardPolygon && routeData.features && routeData.features[0]) {
              var coords = routeData.features[0].geometry.coordinates;
              var intersects = false;
              for (var i = 0; i < coords.length; i++) {
                if (pointInPolygon(coords[i][0], coords[i][1], cachedHazardPolygon)) {
                  intersects = true;
                  break;
                }
              }
              if (intersects) {
                routeData.hazard_warning = 'Route may intersect hazard zone. Exercise caution.';
              }
            }
            return jsonOk(res, routeData);
          } catch (e) {
            return jsonError(res, 502, 'Invalid response from routing provider');
          }
        }).catch(function(e) {
          log('error', 'Route proxy error', { error: e.message });
          return jsonError(res, 502, 'Routing service unavailable');
        });
      });
      return;
    }

    // ── 404 for unknown API routes ────────────────────────────────────────
    return jsonError(res, 404, 'Not Found');
  }

  // ── Static File Server ────────────────────────────────────────────────────
  function serveStatic(req, res, urlPath) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return jsonError(res, 405, 'Method Not Allowed');
    }

    var servePath = urlPath === '/' ? '/home.html' : urlPath;

    // Reject encoded traversal early
    if (servePath.indexOf('..') !== -1 || servePath.indexOf('\\') !== -1) {
      return jsonError(res, 403, 'Forbidden');
    }

    // Normalize and resolve
    var normalizedPath = servePath.replace(/^\/+/, '');
    var filePath = path.resolve(path.join(frontendDir, normalizedPath));

    // Directory containment check
    if (!filePath.startsWith(frontendDir + path.sep) && filePath !== frontendDir) {
      return jsonError(res, 403, 'Forbidden');
    }

    // Extension allowlist check
    var ext = path.extname(filePath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return jsonError(res, 403, 'Forbidden');
    }

    fs.readFile(filePath, function(err, content) {
      if (err) {
        if (err.code === 'ENOENT') return jsonError(res, 404, 'Not Found');
        return jsonError(res, 500, 'Internal Server Error');
      }
      var contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  }

  // ── Server Setup ──────────────────────────────────────────────────────────
  var server = http.createServer(handler);
  server.timeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;

  server.on('clientError', function(err, socket) {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  return {
    server: server,
    start: function(port) {
      port = port || 0;
      return new Promise(function(resolve, reject) {
        server.listen(port, function() {
          var addr = server.address();
          log('info', 'Server listening', { port: addr.port });
          resolve(addr.port);
        });
        server.once('error', reject);
      });
    },
    stop: function() {
      clearInterval(rlInterval);
      if (retentionInterval) clearInterval(retentionInterval);
      return new Promise(function(resolve) {
        server.close(function() { resolve(); });
      });
    },
    getCitizens: function() { return citizens; },
    resetState: function() {
      citizens.clear();
      sessions.clear();
      rateLimiter.windows.clear();
      if (options.testToken) sessions.set(options.testToken, { createdAt: Date.now() });
    }
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  loadEnv(path.join(__dirname, '.env'));

  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    log('error', 'ADMIN_USERNAME and ADMIN_PASSWORD environment variables are required');
    process.exit(1);
  }
  if (!process.env.TWILIO_AUTH_TOKEN) {
    log('warn', 'TWILIO_AUTH_TOKEN not set — SMS webhook verification will reject all requests');
  }

  var app = createApp();
  var port = parseInt(process.env.PORT, 10) || 3000;
  app.start(port);

  function shutdown() {
    log('info', 'Graceful shutdown initiated');
    app.stop().then(function() {
      log('info', 'Server stopped');
      process.exit(0);
    });
    setTimeout(function() { process.exit(1); }, 10000);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createApp, parseCAPPolygon, loadEnv };
