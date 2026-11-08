const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createServer } = require('../src/server');

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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

test('Static Asset Serving (Checkpoint 6B)', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-static-test-'));
  const app = createServer({
    port: 0,
    storageRoot: tmpRoot
  });

  let port;

  t.after(async () => {
    await app.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('start server', async () => {
    await app.start();
    port = app.server.address().port;
    assert.ok(port > 0);
  });

  await t.test('GET / returns 200 HTML with exact CSP, nosniff, and security headers', async () => {
    const res = await makeRequest(port, { method: 'GET', path: '/' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.headers['content-security-policy'], EXPECTED_CSP);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
    assert.ok(res.headers['etag'] && res.headers['etag'].startsWith('W/"'));
    assert.ok(Number(res.headers['content-length']) > 0);
    assert.ok(res.raw.includes('<!DOCTYPE html>'));
  });

  await t.test('GET /index.html returns identical HTML response', async () => {
    const rootRes = await makeRequest(port, { method: 'GET', path: '/' });
    const indexRes = await makeRequest(port, { method: 'GET', path: '/index.html' });
    assert.equal(indexRes.statusCode, 200);
    assert.equal(indexRes.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(indexRes.headers['content-security-policy'], EXPECTED_CSP);
    assert.equal(indexRes.raw, rootRes.raw);
  });

  await t.test('Allow-listed assets have accurate content-type headers', async () => {
    const expectations = [
      { path: '/app.js', type: 'text/javascript; charset=utf-8' },
      { path: '/uploader.js', type: 'text/javascript; charset=utf-8' },
      { path: '/chunkMath.js', type: 'text/javascript; charset=utf-8' },
      { path: '/ledgerView.js', type: 'text/javascript; charset=utf-8' },
      { path: '/styles.css', type: 'text/css; charset=utf-8' }
    ];

    for (const item of expectations) {
      const res = await makeRequest(port, { method: 'GET', path: item.path });
      assert.equal(res.statusCode, 200, `Path ${item.path} should return 200`);
      assert.equal(res.headers['content-type'], item.type, `Path ${item.path} content-type mismatch`);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['cache-control'], 'no-cache');
      assert.ok(res.headers['etag'], `Path ${item.path} should have ETag`);
      assert.ok(res.raw.length > 0, `Path ${item.path} body should not be empty`);
    }
  });

  await t.test('GET /favicon.ico returns 204 No Content without Content-Type or Content-Length', async () => {
    const res = await makeRequest(port, { method: 'GET', path: '/favicon.ico' });
    assert.equal(res.statusCode, 204);
    assert.equal(res.raw, '');
    assert.equal(res.headers['content-type'], undefined);
    assert.equal(res.headers['content-length'], undefined);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'no-cache');
  });

  await t.test('HEAD request returns headers but empty body', async () => {
    const getRes = await makeRequest(port, { method: 'GET', path: '/app.js' });
    const headRes = await makeRequest(port, { method: 'HEAD', path: '/app.js' });

    assert.equal(headRes.statusCode, 200);
    assert.equal(headRes.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(headRes.headers['content-length'], getRes.headers['content-length']);
    assert.equal(headRes.headers['etag'], getRes.headers['etag']);
    assert.equal(headRes.raw, '');
  });

  await t.test('If-None-Match returns 304 with empty body when ETag matches', async () => {
    const getRes = await makeRequest(port, { method: 'GET', path: '/styles.css' });
    const etag = getRes.headers['etag'];
    assert.ok(etag);

    const conditionalRes = await makeRequest(port, {
      method: 'GET',
      path: '/styles.css',
      headers: { 'If-None-Match': etag }
    });

    assert.equal(conditionalRes.statusCode, 304);
    assert.equal(conditionalRes.raw, '');
    assert.equal(conditionalRes.headers['etag'], etag);
  });

  await t.test('POST / returns 405 Method Not Allowed with Allow header', async () => {
    const res = await makeRequest(port, { method: 'POST', path: '/' });
    assert.equal(res.statusCode, 405);
    const allowHeader = res.headers['allow'] || '';
    assert.ok(allowHeader.includes('GET'));
    assert.ok(allowHeader.includes('HEAD'));
  });

  await t.test('Path traversal attempts return 404 without leaking server files', async () => {
    const traversalPaths = [
      '/../src/server.js',
      '/%2e%2e/src/server.js',
      '/public/../package.json',
      '/src/config.js',
      '/storage/',
      '/package.json'
    ];

    for (const travPath of traversalPaths) {
      const res = await makeRequest(port, { method: 'GET', path: travPath });
      assert.equal(res.statusCode, 404, `Traversal "${travPath}" must return 404`);
      assert.equal(res.json?.error?.code, 'NOT_FOUND');
      // Must never return file contents
      assert.equal(res.raw.includes('createServer'), false);
      assert.equal(res.raw.includes('require('), false);
      assert.equal(res.raw.includes('"dependencies"'), false);
    }
  });

  await t.test('Missing allow-listed file from custom publicDir returns 404 JSON (not 500)', async () => {
    const emptyPublic = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-empty-public-'));
    const tempApp = createServer({
      port: 0,
      storageRoot: tmpRoot,
      publicDir: emptyPublic
    });
    await tempApp.start();
    const tempPort = tempApp.server.address().port;

    try {
      const res = await makeRequest(tempPort, { method: 'GET', path: '/app.js' });
      assert.equal(res.statusCode, 404);
      assert.equal(res.json?.error?.code, 'NOT_FOUND');
      assert.equal(res.raw.includes(emptyPublic), false, 'Must not leak server publicDir path');
    } finally {
      await tempApp.stop();
      fs.rmSync(emptyPublic, { recursive: true, force: true });
    }
  });

  await t.test('HTML file has no inline script, no inline style, and no inline event handlers', () => {
    const htmlPath = path.resolve(__dirname, '..', 'public', 'index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    // Every script tag must have a src attribute (no inline script blocks)
    const scriptTagRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptTagRegex.exec(htmlContent)) !== null) {
      const attrs = match[1];
      const inlineBody = match[2].trim();
      assert.ok(/\bsrc\s*=/i.test(attrs), `Script tag missing src: ${match[0]}`);
      assert.equal(inlineBody, '', `Script tag contains inline code: ${inlineBody}`);
    }

    // No style attributes
    assert.equal(/\bstyle\s*=/i.test(htmlContent), false, 'index.html must not contain style= attributes');

    // No inline event handler attributes like onclick=, onload=, onerror=
    const tagRegex = /<[a-z0-9-]+(\s+[^>]*)>/gi;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(htmlContent)) !== null) {
      const tagAttrs = tagMatch[1];
      assert.equal(/\son[a-z]+\s*=/i.test(tagAttrs), false, `Tag contains inline event handler: ${tagMatch[0]}`);
    }

    // No external http(s):// links
    assert.equal(/https?:\/\//i.test(htmlContent), false, 'index.html must not contain external URLs');
  });

  await t.test('public/app.js has no unsafe DOM injection or eval patterns', () => {
    const appJsPath = path.resolve(__dirname, '..', 'public', 'app.js');
    const appJsContent = fs.readFileSync(appJsPath, 'utf8');

    const unsafePatterns = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new\s+Function|setAttribute\(['"]style/i;
    assert.equal(
      unsafePatterns.test(appJsContent),
      false,
      'app.js must not contain innerHTML, outerHTML, eval, or setAttribute style'
    );
  });
});
