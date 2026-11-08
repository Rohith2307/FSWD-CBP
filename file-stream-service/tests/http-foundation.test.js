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

test('HTTP foundation tests', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-http-test-'));
  const app = createServer({
    port: 0,
    storageRoot: tmpRoot,
    maxJsonBodyBytes: 512 // small limit for testing oversized payloads easily
  });

  // Register dedicated test route for JSON validation tests (handlers invoke readJsonBody)
  app.router.register('POST', '/api/test/json', async (req, res) => {
    const body = await readJsonBody(req, app.config.maxJsonBodyBytes);
    sendJson(res, 200, { received: body });
  });

  // Register parameterized route for testing URL routing params
  app.router.register('GET', '/api/test/:section/items/:id', (req, res) => {
    sendJson(res, 200, { section: req.params.section, id: req.params.id, query: req.query });
  });

  let port;

  await t.test('start server on ephemeral port 0', async () => {
    await app.start(0, '127.0.0.1');
    port = app.server.address().port;
    assert.ok(port > 0, 'Server should listen on an assigned port');
  });

  await t.test('GET /health -> 200 with status ok', async () => {
    const res = await makeRequest(port, { path: '/health', method: 'GET' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.json.status, 'ok');
    assert.equal(res.json.node, process.version);
    assert.equal(typeof res.json.uptimeSeconds, 'number');
    assert.ok(res.json.timestamp);
  });

  await t.test('HEAD /health -> 200 with headers but no body', async () => {
    const res = await makeRequest(port, { path: '/health', method: 'HEAD' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.raw, '');
  });

  await t.test('Unknown route -> 404 JSON error shape', async () => {
    const res = await makeRequest(port, { path: '/unknown-route', method: 'GET' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.json.error.code, 'NOT_FOUND');
    assert.match(res.json.error.message, /not found/i);
  });

  await t.test('JSON POST to unknown route -> 404 (not 400 or 413)', async () => {
    const res = await makeRequest(
      port,
      {
        path: '/unknown-route',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': 10
        }
      },
      '{"bad":123'
    );
    assert.equal(res.statusCode, 404);
    assert.equal(res.json.error.code, 'NOT_FOUND');
  });

  await t.test('Known path with wrong method -> 405 with Allow header', async () => {
    const res = await makeRequest(port, { path: '/health', method: 'POST' });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.ok(res.headers['allow'], 'Response must include Allow header');
    assert.match(res.headers['allow'], /GET/);
    assert.equal(res.json.error.code, 'METHOD_NOT_ALLOWED');
  });

  await t.test('Parameterized route matches and extracts parameters & query', async () => {
    const res = await makeRequest(port, {
      path: '/api/test/docs/items/item-123?sort=asc&filter=active',
      method: 'GET'
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.section, 'docs');
    assert.equal(res.json.id, 'item-123');
    assert.deepEqual(res.json.query, { sort: 'asc', filter: 'active' });
  });

  await t.test('Valid JSON body -> 200 with echoed parsed object', async () => {
    const payload = JSON.stringify({ message: 'hello', count: 42 });
    const res = await makeRequest(
      port,
      {
        path: '/api/test/json',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      payload
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json.received, { message: 'hello', count: 42 });
  });

  await t.test('Malformed JSON body -> 400 Bad Request', async () => {
    const malformedPayload = '{bad json';
    const res = await makeRequest(
      port,
      {
        path: '/api/test/json',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(malformedPayload)
        }
      },
      malformedPayload
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error.code, 'BAD_REQUEST');
    assert.match(res.json.error.message, /Malformed JSON body/);
  });

  await t.test('Oversized JSON body -> 413 Payload Too Large with Connection: close', async () => {
    const largeObject = { data: 'x'.repeat(1024) }; // > 512 bytes limit
    const payload = JSON.stringify(largeObject);
    const res = await makeRequest(
      port,
      {
        path: '/api/test/json',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      payload
    );
    assert.equal(res.statusCode, 413);
    assert.equal(res.json.error.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(res.headers['connection'], 'close');
    assert.match(res.json.error.message, /Payload size/);
  });

  await t.test('Wrong Content-Type -> 415 Unsupported Media Type', async () => {
    const payload = 'plain text content';
    const res = await makeRequest(
      port,
      {
        path: '/api/test/json',
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      payload
    );
    assert.equal(res.statusCode, 415);
    assert.equal(res.json.error.code, 'UNSUPPORTED_MEDIA_TYPE');
  });

  await t.test('Empty JSON body -> 400 Bad Request', async () => {
    const res = await makeRequest(
      port,
      {
        path: '/api/test/json',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': 0
        }
      },
      ''
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error.code, 'BAD_REQUEST');
    assert.match(res.json.error.message, /empty/i);
  });

  await t.test('Malformed URL -> 400 Bad Request', async () => {
    const res = await makeRequest(port, {
      path: '/%E0%A4%A',
      method: 'GET'
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.error.code, 'BAD_REQUEST');
  });

  await t.test('two servers with different storageRoots do not touch each other files', async () => {
    const root1 = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-isolation-1-'));
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-isolation-2-'));
    const app1 = createServer({ port: 0, storageRoot: root1 });
    const app2 = createServer({ port: 0, storageRoot: root2 });

    await app1.start(0, '127.0.0.1');
    await app2.start(0, '127.0.0.1');

    const port1 = app1.server.address().port;
    const port2 = app2.server.address().port;

    const payload = JSON.stringify({ filename: 'test.mp4', size: 1024, contentType: 'video/mp4' });
    const res1 = await makeRequest(
      port1,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      payload
    );
    assert.equal(res1.statusCode, 201);
    const uploadId1 = res1.json.uploadId;

    // Verify upload exists in root1 but not in root2
    assert.ok(fs.existsSync(path.join(root1, 'uploads', uploadId1)));
    assert.ok(!fs.existsSync(path.join(root2, 'uploads', uploadId1)));

    await app1.stop();
    await app2.stop();
    fs.rmSync(root1, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t.test('Stop server and clean up', async () => {
    await app.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});
