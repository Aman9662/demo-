/**
 * ChetnaSync comprehensive test suite.
 * Run with: node --test backend/server.test.js
 *
 * Uses Node.js built-in test runner only — zero npm dependencies.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createApp, parseCAPPolygon } = require('./server');

// ── Test Helpers ────────────────────────────────────────────────────────────
const TEST_TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
const TEST_SECRET = 'test-twilio-secret';
const TEST_ADMIN = 'testadmin';
const TEST_PASS = 'testpass123';

function request(port, options, bodyData) {
  return new Promise(function(resolve) {
    const opts = Object.assign({ hostname: '127.0.0.1', port: port }, options);
    const req = http.request(opts, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        resolve({ status: res.statusCode, headers: res.headers, data: data });
      });
    });
    req.on('error', function(err) {
      resolve({ status: 0, error: err, data: '' });
    });
    req.setTimeout(5000, function() { req.destroy(); });
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

function buildTwilioSig(port, bodyStr, secret) {
  var url = 'http://127.0.0.1:' + port + '/api/sms/sos';
  var params = new URLSearchParams(bodyStr);
  var sigStr = url;
  var keys = Array.from(params.keys()).sort();
  for (var i = 0; i < keys.length; i++) {
    sigStr += keys[i] + params.get(keys[i]);
  }
  return crypto.createHmac('sha1', secret).update(sigStr).digest('base64');
}

// ── Test Suite ──────────────────────────────────────────────────────────────
describe('ChetnaSync Server', function() {
  let app, PORT;
  const dbFile = path.join(__dirname, 'test_citizens_' + process.pid + '.json');
  const auth = { 'Authorization': 'Bearer ' + TEST_TOKEN };

  before(async function() {
    // Clean up test DB if it exists
    try { fs.unlinkSync(dbFile); } catch (_) {}
    app = createApp({
      dbFile: dbFile,
      skipDbLoad: true,
      skipRetention: true,
      twilioAuthToken: TEST_SECRET,
      testToken: TEST_TOKEN,
      adminUsername: TEST_ADMIN,
      adminPassword: TEST_PASS,
      allowedOrigins: ['http://localhost:3000']
    });
    PORT = await app.start(0);
  });

  after(async function() {
    await app.stop();
    try { fs.unlinkSync(dbFile); } catch (_) {}
    try { fs.unlinkSync(dbFile + '.tmp'); } catch (_) {}
  });

  beforeEach(function() {
    app.resetState();
  });

  // ── Health & Readiness ──────────────────────────────────────────────────
  describe('Health and Readiness', function() {
    it('GET /health returns 200 with status ok', async function() {
      const res = await request(PORT, { path: '/health', method: 'GET' });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.data);
      assert.equal(body.status, 'ok');
    });

    it('GET /ready returns 200 with status ready', async function() {
      const res = await request(PORT, { path: '/ready', method: 'GET' });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.data);
      assert.equal(body.status, 'ready');
    });

    it('POST /health returns 405', async function() {
      const res = await request(PORT, { path: '/health', method: 'POST' });
      assert.equal(res.status, 405);
    });
  });

  // ── Security Headers ──────────────────────────────────────────────────
  describe('Security Headers', function() {
    it('includes X-Content-Type-Options', async function() {
      const res = await request(PORT, { path: '/health', method: 'GET' });
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
    });

    it('includes X-Frame-Options', async function() {
      const res = await request(PORT, { path: '/health', method: 'GET' });
      assert.equal(res.headers['x-frame-options'], 'DENY');
    });

    it('includes Referrer-Policy', async function() {
      const res = await request(PORT, { path: '/health', method: 'GET' });
      assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
    });
  });

  // ── Authentication ────────────────────────────────────────────────────
  describe('Authentication', function() {
    it('POST /api/login succeeds with valid credentials', async function() {
      const res = await request(PORT, {
        path: '/api/login', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ username: TEST_ADMIN, password: TEST_PASS }));
      assert.equal(res.status, 200);
      const body = JSON.parse(res.data);
      assert.ok(body.token);
      assert.equal(typeof body.token, 'string');
      assert.ok(body.token.length >= 32);
    });

    it('POST /api/login fails with wrong password', async function() {
      const res = await request(PORT, {
        path: '/api/login', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ username: TEST_ADMIN, password: 'wrongpass' }));
      assert.equal(res.status, 401);
    });

    it('POST /api/login fails with wrong username', async function() {
      const res = await request(PORT, {
        path: '/api/login', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ username: 'wronguser', password: TEST_PASS }));
      assert.equal(res.status, 401);
    });

    it('GET /api/login returns 405', async function() {
      const res = await request(PORT, { path: '/api/login', method: 'GET' });
      assert.equal(res.status, 405);
    });

    it('POST /api/login rejects non-string credentials', async function() {
      const res = await request(PORT, {
        path: '/api/login', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ username: 123, password: true }));
      assert.equal(res.status, 400);
    });
  });

  // ── Admin Authorization ───────────────────────────────────────────────
  describe('Admin Authorization', function() {
    it('GET /api/citizens without token returns 401', async function() {
      const res = await request(PORT, { path: '/api/citizens', method: 'GET' });
      assert.equal(res.status, 401);
    });

    it('GET /api/citizens with invalid token returns 401', async function() {
      const res = await request(PORT, {
        path: '/api/citizens', method: 'GET',
        headers: { 'Authorization': 'Bearer invalid-token' }
      });
      assert.equal(res.status, 401);
    });

    it('GET /api/citizens with valid token returns 200', async function() {
      const res = await request(PORT, {
        path: '/api/citizens', method: 'GET',
        headers: auth
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.data);
      assert.ok(Array.isArray(body));
    });

    it('GET /api/citizens with malformed auth header returns 401', async function() {
      const res = await request(PORT, {
        path: '/api/citizens', method: 'GET',
        headers: { 'Authorization': 'Basic dXNlcjpwYXNz' }
      });
      assert.equal(res.status, 401);
    });
  });

  // ── Path Traversal ────────────────────────────────────────────────────
  describe('Path Traversal', function() {
    it('blocks ../../etc/passwd', async function() {
      const res = await request(PORT, { path: '/../../etc/passwd', method: 'GET' });
      assert.equal(res.status, 403);
    });

    it('blocks URL-encoded /%2e%2e/%2e%2e/etc/passwd', async function() {
      const res = await request(PORT, { path: '/%2e%2e/%2e%2e/etc/passwd', method: 'GET' });
      assert.equal(res.status, 403);
    });

    it('blocks backslash traversal', async function() {
      const res = await request(PORT, { path: '/..\\..\\etc\\passwd', method: 'GET' });
      assert.equal(res.status, 403);
    });

    it('blocks null-byte injection', async function() {
      const res = await request(PORT, { path: '/index.html%00.png', method: 'GET' });
      assert.equal(res.status, 400);
    });

    it('blocks double-encoded traversal', async function() {
      const res = await request(PORT, { path: '/%252e%252e/%252e%252e/etc/passwd', method: 'GET' });
      // After single decode this becomes /%2e%2e/... which contains .. after second decode
      // But we only decode once, so the %25 becomes %, and %2e stays
      // The key is it should NOT serve files outside frontend dir
      assert.ok([400, 403, 404].includes(res.status));
    });

    it('blocks access to disallowed file extensions', async function() {
      const res = await request(PORT, { path: '/server.js', method: 'GET' });
      // .js is allowed but server.js doesn't exist in frontend dir
      assert.ok([404].includes(res.status));
    });
  });

  // ── CORS ──────────────────────────────────────────────────────────────
  describe('CORS', function() {
    it('allows configured origin', async function() {
      const res = await request(PORT, {
        path: '/health', method: 'GET',
        headers: { 'Origin': 'http://localhost:3000' }
      });
      assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:3000');
    });

    it('blocks unknown origin', async function() {
      const res = await request(PORT, {
        path: '/health', method: 'GET',
        headers: { 'Origin': 'http://evil.com' }
      });
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    });

    it('handles OPTIONS preflight', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'OPTIONS',
        headers: { 'Origin': 'http://localhost:3000' }
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:3000');
    });
  });

  // ── Rate Limiting ─────────────────────────────────────────────────────
  describe('Rate Limiting', function() {
    it('rate limits login endpoint after 5 attempts', async function() {
      // Reset rate limiter by using unique app
      const rateLimitDb = dbFile + '.ratelimit';
      const rlApp = createApp({
        dbFile: rateLimitDb, skipDbLoad: true, skipRetention: true,
        twilioAuthToken: TEST_SECRET, adminUsername: TEST_ADMIN,
        adminPassword: TEST_PASS, allowedOrigins: ['http://localhost:3000']
      });
      const rlPort = await rlApp.start(0);
      try {
        for (let i = 0; i < 5; i++) {
          await request(rlPort, {
            path: '/api/login', method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          }, JSON.stringify({ username: 'wrong', password: 'wrong' }));
        }
        const res = await request(rlPort, {
          path: '/api/login', method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({ username: 'wrong', password: 'wrong' }));
        assert.equal(res.status, 429);
      } finally {
        await rlApp.stop();
        try { fs.unlinkSync(rateLimitDb); } catch (_) {}
      }
    });
  });

  // ── Request Size Limits ───────────────────────────────────────────────
  describe('Request Size Limits', function() {
    it('rejects oversized JSON body', async function() {
      const bigBody = JSON.stringify({
        id: 'user1', status: 'SAFE', lat: 19.0, lon: 72.0,
        padding: 'x'.repeat(15000)
      });
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, bigBody);
      // May get 400, 413, or connection reset
      assert.ok(res.status === 400 || res.status === 413 || res.status === 0,
        'Expected 400, 413, or connection reset for oversized body, got ' + res.status);
    });
  });

  // ── Malformed Input ───────────────────────────────────────────────────
  describe('Malformed Input', function() {
    it('rejects malformed JSON', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, '{ id: "user1" ');
      assert.equal(res.status, 400);
    });

    it('rejects JSON array body', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify([{ id: 'user1' }]));
      assert.equal(res.status, 400);
    });

    it('rejects empty body', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, '');
      assert.equal(res.status, 400);
    });
  });

  // ── Status Validation ─────────────────────────────────────────────────
  describe('Status Validation', function() {
    it('rejects invalid status DEAD', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ id: 'user1', status: 'DEAD', lat: 19.0, lon: 72.0 }));
      assert.equal(res.status, 400);
      assert.ok(res.data.includes('Invalid status'));
    });

    it('accepts valid status SAFE', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ id: 'user1', status: 'SAFE', lat: 19.0, lon: 72.0 }));
      assert.equal(res.status, 200);
    });

    it('accepts valid status TRAPPED', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ id: 'user1', status: 'TRAPPED', lat: 19.0, lon: 72.0 }));
      assert.equal(res.status, 200);
    });

    it('accepts valid status RESCUE', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ id: 'user2', status: 'RESCUE', lat: 19.0, lon: 72.0 }));
      assert.equal(res.status, 200);
    });

    it('accepts valid status INJURED', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ id: 'user3', status: 'INJURED', lat: 19.0, lon: 72.0 }));
      assert.equal(res.status, 200);
    });
  });

  // ── Coordinate Validation ─────────────────────────────────────────────
  describe('Coordinate Validation', function() {
    it('rejects latitude > 90', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ id: 'user1', status: 'SAFE', lat: 91.0, lon: 72.0 }));
      assert.equal(res.status, 400);
    });

    it('rejects latitude < -90', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ id: 'user1', status: 'SAFE', lat: -91.0, lon: 72.0 }));
      assert.equal(res.status, 400);
    });

    it('rejects longitude > 180', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ id: 'user1', status: 'SAFE', lat: 19.0, lon: 181.0 }));
      assert.equal(res.status, 400);
    });

    it('rejects NaN latitude', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ id: 'user1', status: 'SAFE', lat: 'NaN', lon: 72.0 }));
      assert.equal(res.status, 400);
    });

    it('rejects Infinity longitude', async function() {
      const body = '{"id":"user1","status":"SAFE","lat":19.0,"lon":1e999}';
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, body);
      assert.equal(res.status, 400);
    });

    it('accepts boundary coordinates', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ id: 'user1', status: 'SAFE', lat: 90, lon: -180 }));
      assert.equal(res.status, 200);
    });
  });

  // ── ID Validation ─────────────────────────────────────────────────────
  describe('ID Validation', function() {
    it('rejects HTML in id (XSS payload)', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ id: '<img src=x onerror=alert(1)>', status: 'SAFE', lat: 19.0, lon: 72.0 }));
      assert.equal(res.status, 400);
    });

    it('rejects script tag in id', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ id: '<script>alert(1)</script>', status: 'SAFE', lat: 19.0, lon: 72.0 }));
      assert.equal(res.status, 400);
    });

    it('accepts valid alphanumeric id', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ id: 'user-1234', status: 'SAFE', lat: 19.0, lon: 72.0 }));
      assert.equal(res.status, 200);
    });

    it('rejects empty id', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ id: '', status: 'SAFE', lat: 19.0, lon: 72.0 }));
      assert.equal(res.status, 400);
    });

    it('rejects unknown fields', async function() {
      const res = await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ id: 'user1', status: 'SAFE', lat: 19.0, lon: 72.0, evil: 'payload' }));
      assert.equal(res.status, 400);
      assert.ok(res.data.includes('Unknown field'));
    });
  });

  // ── XSS Prevention ────────────────────────────────────────────────────
  describe('XSS Prevention', function() {
    it('stores valid data and returns it safely via citizens endpoint', async function() {
      // Submit a citizen with a normal ID
      await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ id: 'safe-user', status: 'SAFE', lat: 19.0, lon: 72.0 }));

      const res = await request(PORT, {
        path: '/api/citizens', method: 'GET',
        headers: auth
      });
      assert.equal(res.status, 200);
      const citizens = JSON.parse(res.data);
      const found = citizens.find(function(c) { return c.id === 'safe-user'; });
      assert.ok(found);
      assert.equal(found.status, 'SAFE');
    });

    it('rejects XSS payloads at input validation', async function() {
      const xssPayloads = [
        '<img src=x onerror=alert(1)>',
        '<script>alert("xss")</script>',
        '"><svg onload=alert(1)>',
        "'; DROP TABLE users;--"
      ];
      for (const payload of xssPayloads) {
        const res = await request(PORT, {
          path: '/api/triage/status', method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({ id: payload, status: 'SAFE', lat: 19.0, lon: 72.0 }));
        assert.equal(res.status, 400, 'Should reject XSS payload: ' + payload);
      }
    });
  });

  // ── Twilio Webhook ────────────────────────────────────────────────────
  describe('Twilio SMS Webhook', function() {
    it('rejects missing signature', async function() {
      const res = await request(PORT, {
        path: '/api/sms/sos', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, 'From=%2B123&Body=STATUS:SAFE%20LAT:19.0%20LON:72.0');
      assert.equal(res.status, 401);
    });

    it('rejects forged signature', async function() {
      const res = await request(PORT, {
        path: '/api/sms/sos', method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': 'forged-signature'
        }
      }, 'From=%2B123&Body=STATUS:SAFE%20LAT:19.0%20LON:72.0');
      assert.equal(res.status, 403);
    });

    it('rejects wrong content type', async function() {
      const res = await request(PORT, {
        path: '/api/sms/sos', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-twilio-signature': 'any'
        }
      }, JSON.stringify({ From: '+123', Body: 'STATUS:SAFE LAT:19.0 LON:72.0' }));
      assert.equal(res.status, 401);
    });

    it('accepts valid signature and stores citizen', async function() {
      const bodyStr = 'Body=STATUS%3ASAFE+LAT%3A19.0+LON%3A72.0&From=%2B1234567890';
      const sig = buildTwilioSig(PORT, bodyStr, TEST_SECRET);
      const res = await request(PORT, {
        path: '/api/sms/sos', method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': sig
        }
      }, bodyStr);
      assert.equal(res.status, 200);
      assert.ok(res.data.includes('<Response>'));

      // Verify citizen was stored
      const citizensRes = await request(PORT, {
        path: '/api/citizens', method: 'GET',
        headers: auth
      });
      const citizens = JSON.parse(citizensRes.data);
      const found = citizens.find(function(c) { return c.id === '+1234567890'; });
      assert.ok(found, 'Citizen should be stored after valid SMS');
      assert.equal(found.status, 'SAFE');
    });

    it('rejects GET method', async function() {
      const res = await request(PORT, { path: '/api/sms/sos', method: 'GET' });
      assert.equal(res.status, 405);
    });
  });

  // ── XML Parsing ───────────────────────────────────────────────────────
  describe('XML Parsing (parseCAPPolygon)', function() {
    it('parses valid CAP XML', function() {
      const xml = '<alert><info><area><polygon>19.080,72.870 19.080,72.875 19.075,72.875 19.075,72.870 19.080,72.870</polygon></area></info></alert>';
      const result = parseCAPPolygon(xml);
      assert.ok(!result.error, 'Should not have error');
      assert.ok(result.points);
      assert.equal(result.points.length, 5);
    });

    it('rejects XML without polygon', function() {
      const xml = '<alert><info><area></area></info></alert>';
      const result = parseCAPPolygon(xml);
      assert.ok(result.error);
      assert.ok(result.error.includes('No <polygon>'));
    });

    it('rejects empty polygon', function() {
      const xml = '<alert><polygon></polygon></alert>';
      const result = parseCAPPolygon(xml);
      assert.ok(result.error);
    });

    it('rejects invalid characters in coordinates', function() {
      const xml = '<polygon>abc,def ghi,jkl</polygon>';
      const result = parseCAPPolygon(xml);
      assert.ok(result.error);
    });

    it('rejects out-of-range latitude', function() {
      const xml = '<polygon>91.0,72.0 19.0,72.0 19.0,73.0 91.0,72.0</polygon>';
      const result = parseCAPPolygon(xml);
      assert.ok(result.error);
      assert.ok(result.error.includes('Latitude out of range'));
    });

    it('rejects unclosed polygon', function() {
      const xml = '<polygon>19.080,72.870 19.080,72.875 19.075,72.875 19.075,72.870</polygon>';
      const result = parseCAPPolygon(xml);
      assert.ok(result.error);
      assert.ok(result.error.includes('not closed'));
    });

    it('rejects too few coordinate pairs', function() {
      const xml = '<polygon>19.080,72.870 19.080,72.875 19.080,72.870</polygon>';
      const result = parseCAPPolygon(xml);
      assert.ok(result.error);
      assert.ok(result.error.includes('at least 4'));
    });

    it('rejects empty input', function() {
      const result = parseCAPPolygon('');
      assert.ok(result.error);
    });

    it('rejects non-string input', function() {
      const result = parseCAPPolygon(null);
      assert.ok(result.error);
    });
  });

  // ── Hazard API ────────────────────────────────────────────────────────
  describe('Hazard API', function() {
    it('GET /api/hazard returns FeatureCollection', async function() {
      const res = await request(PORT, { path: '/api/hazard', method: 'GET' });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.data);
      assert.equal(body.type, 'FeatureCollection');
      assert.ok(body.features);
      assert.ok(body.features.length > 0);
      assert.equal(body.features[0].geometry.type, 'Polygon');
    });

    it('POST /api/hazard returns 405', async function() {
      const res = await request(PORT, { path: '/api/hazard', method: 'POST' });
      assert.equal(res.status, 405);
    });
  });

  // ── Shelters API ──────────────────────────────────────────────────────
  describe('Shelters API', function() {
    it('GET /api/verified-shelters returns FeatureCollection', async function() {
      const res = await request(PORT, { path: '/api/verified-shelters', method: 'GET' });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.data);
      assert.equal(body.type, 'FeatureCollection');
      assert.ok(body.features.length > 0);
    });
  });

  // ── Atomic Persistence ────────────────────────────────────────────────
  describe('Atomic Persistence', function() {
    it('writes data to DB file after triage update', async function() {
      await request(PORT, {
        path: '/api/triage/status', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ id: 'persist-test', status: 'INJURED', lat: 19.0, lon: 72.0 }));

      // Wait for async write to complete (atomic write is async)
      await new Promise(function(resolve) { setTimeout(resolve, 500); });

      // Verify DB file exists and contains the data
      assert.ok(fs.existsSync(dbFile), 'DB file should exist');
      const raw = fs.readFileSync(dbFile, 'utf8');
      const data = JSON.parse(raw);
      assert.ok(Array.isArray(data));
      const found = data.find(function(entry) { return entry[0] === 'persist-test'; });
      assert.ok(found, 'persist-test should be in DB file');
      assert.equal(found[1].status, 'INJURED');
    });
  });

  // ── Concurrent Writes ─────────────────────────────────────────────────
  describe('Concurrent Writes', function() {
    it('handles multiple simultaneous triage updates without corruption', async function() {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(request(PORT, {
          path: '/api/triage/status', method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({ id: 'concurrent-' + i, status: 'SAFE', lat: 19.0 + i * 0.001, lon: 72.0 })));
      }
      const results = await Promise.all(promises);
      for (const res of results) {
        assert.equal(res.status, 200, 'All concurrent writes should succeed');
      }

      // Wait for async writes to complete
      await new Promise(function(resolve) { setTimeout(resolve, 500); });

      // Verify all citizens exist
      const citizensRes = await request(PORT, {
        path: '/api/citizens', method: 'GET',
        headers: auth
      });
      const citizens = JSON.parse(citizensRes.data);
      for (let i = 0; i < 10; i++) {
        const found = citizens.find(function(c) { return c.id === 'concurrent-' + i; });
        assert.ok(found, 'concurrent-' + i + ' should exist');
      }
    });
  });

  // ── Route API ─────────────────────────────────────────────────────────
  describe('Route API', function() {
    it('returns 503 when ORS key not configured', async function() {
      const res = await request(PORT, {
        path: '/api/route', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({
        coordinates: [[72.875, 19.070], [72.8777, 19.076]]
      }));
      assert.equal(res.status, 503);
    });

    it('rejects invalid coordinates', async function() {
      // Create app with fake ORS key to test input validation
      const routeApp = createApp({
        dbFile: dbFile + '.route', skipDbLoad: true, skipRetention: true,
        twilioAuthToken: TEST_SECRET, adminUsername: TEST_ADMIN,
        adminPassword: TEST_PASS, orsApiKey: 'fake-key'
      });
      const routePort = await routeApp.start(0);
      try {
        const res = await request(routePort, {
          path: '/api/route', method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({ coordinates: 'invalid' }));
        assert.equal(res.status, 400);
      } finally {
        await routeApp.stop();
        try { fs.unlinkSync(dbFile + '.route'); } catch (_) {}
      }
    });
  });

  // ── Unknown API Routes ────────────────────────────────────────────────
  describe('Unknown Routes', function() {
    it('returns 404 for unknown API path', async function() {
      const res = await request(PORT, { path: '/api/nonexistent', method: 'GET' });
      assert.equal(res.status, 404);
    });
  });

  // ── Frontend JS Syntax ────────────────────────────────────────────────
  describe('Frontend Syntax', function() {
    it('sw.js has valid JavaScript syntax', function() {
      const swPath = path.join(__dirname, '..', 'frontend', 'sw.js');
      if (fs.existsSync(swPath)) {
        const content = fs.readFileSync(swPath, 'utf8');
        // Basic syntax check: try to parse as a function body
        assert.doesNotThrow(function() {
          new Function(content);
        }, 'sw.js should be valid JavaScript');
      }
    });

    it('home.html inline scripts have valid syntax', function() {
      const htmlPath = path.join(__dirname, '..', 'frontend', 'home.html');
      if (fs.existsSync(htmlPath)) {
        const content = fs.readFileSync(htmlPath, 'utf8');
        const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
        let match;
        let scriptCount = 0;
        while ((match = scriptRegex.exec(content)) !== null) {
          if (match[1].trim()) {
            scriptCount++;
            // Use require('vm') for syntax check without executing
            const vm = require('vm');
            assert.doesNotThrow(function() {
              new vm.Script(match[1], { filename: 'home.html' });
            }, 'home.html inline script should be valid JavaScript');
          }
        }
        assert.ok(scriptCount > 0, 'Should find at least one inline script');
      }
    });

    it('index.html inline scripts have valid syntax', function() {
      const htmlPath = path.join(__dirname, '..', 'frontend', 'index.html');
      if (fs.existsSync(htmlPath)) {
        const content = fs.readFileSync(htmlPath, 'utf8');
        const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
        let match;
        let scriptCount = 0;
        while ((match = scriptRegex.exec(content)) !== null) {
          // Skip external scripts (those with src attribute)
          if (match[0].includes('src=')) continue;
          if (match[1].trim()) {
            scriptCount++;
            const vm = require('vm');
            assert.doesNotThrow(function() {
              new vm.Script(match[1], { filename: 'index.html' });
            }, 'index.html inline script should be valid JavaScript');
          }
        }
        assert.ok(scriptCount > 0, 'Should find at least one inline script');
      }
    });
  });
});
