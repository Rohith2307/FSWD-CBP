const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createServer } = require('../src/server');
const { sendJson, readJsonBody } = require('../src/utils/http');

function makeRequest(port, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        ...options
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            raw,
            json
          });
        });
      }
    );
    req.on('error', reject);
    if (body !== null && body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

test('HTTP foundation integration tests', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-http-integ-'));
  const app = createServer({
    port: 0,
    storageRoot: tmpRoot,
    maxJsonBodyBytes: 512
  });

  // Dedicated test route for JSON validation tests (calling readJsonBody in handler)
  app.router.register('POST', '/test-json', async (req, res) => {
    const body = await readJsonBody(req, app.config.maxJsonBodyBytes);
    sendJson(res, 200, { echoed: body });
  });

  let port;

  await t.test('start server', async () => {
    await app.start(0, '127.0.0.1');
    port = app.server.address().port;
    assert.ok(port > 0, 'Server should listen on an assigned port');
  });

  await t.test('POST /test-json accepts valid JSON and echoes', async () => {
    const payload = JSON.stringify({ hello: 'world', count: 123 });
    const res = await makeRequest(
      port,
      {
        path: '/test-json',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      payload
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.deepEqual(res.json, { echoed: { hello: 'world', count: 123 } });
  });

  await t.test('POST /test-json rejects oversized body with 413', async () => {
    const payload = JSON.stringify({ data: 'a'.repeat(600) });
    const res = await makeRequest(
      port,
      {
        path: '/test-json',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      payload
    );
    assert.equal(res.statusCode, 413);
    assert.equal(res.headers['connection'], 'close');
    assert.equal(res.json.error.code, 'PAYLOAD_TOO_LARGE');
  });

  await t.test('POST /test-json rejects malformed JSON with 400', async () => {
    const payload = '{"bad": json';
    const res = await makeRequest(
      port,
      {
        path: '/test-json',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      payload
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error.code, 'BAD_REQUEST');
  });

  await t.test('unknown route returns 404 with structured JSON', async () => {
    const res = await makeRequest(port, { path: '/no-such-route', method: 'GET' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.json.error.code, 'NOT_FOUND');
  });

  await t.test('JSON POST to unknown route returns 404 without reading body', async () => {
    const payload = JSON.stringify({ key: 'val' });
    const res = await makeRequest(
      port,
      {
        path: '/no-such-route',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      payload
    );
    assert.equal(res.statusCode, 404);
    assert.equal(res.json.error.code, 'NOT_FOUND');
  });

  await t.test('stop server', async () => {
    await app.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});
