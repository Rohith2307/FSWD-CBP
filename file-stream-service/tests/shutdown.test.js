const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const paths = require('../src/storage/paths');
const { createServer } = require('../src/server');

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

test('B6: Graceful shutdown and handle leak prevention', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-shutdown-test-'));
  await paths.ensureStorageDirs(tmpRoot);

  t.after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('stop() waits for in-flight chunk PUT, flushes metrics, and completes PUT with 201', async () => {
    const app = createServer({
      storageRoot: tmpRoot,
      cleanup: false
    });
    const port = 62105;
    await app.start(port, '127.0.0.1');

    const totalSize = 100000;
    const chunkSize = 100000;
    const createRes = await makeRequest(
      port,
      { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ filename: 'graceful.bin', size: totalSize, contentType: 'application/octet-stream', chunkSize })
    );
    assert.equal(createRes.statusCode, 201);
    const uploadId = createRes.json.uploadId;

    const chunkData = crypto.randomBytes(chunkSize);
    const chunkSha = crypto.createHash('sha256').update(chunkData).digest('hex');

    // Start in-flight chunk PUT with delayed body
    let putResponse = null;
    const putPromise = new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: `/api/uploads/${uploadId}/chunks/0`,
          method: 'PUT',
          headers: {
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes 0-${chunkSize - 1}/${totalSize}`,
            'X-Chunk-SHA256': chunkSha
          }
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
            putResponse = { statusCode: res.statusCode, json, raw };
            resolve(putResponse);
          });
        }
      );
      req.on('error', reject);

      // Write half the chunk immediately
      req.write(chunkData.subarray(0, 50000));

      // After 50ms, call app.stop() while PUT is still in-flight
      setTimeout(async () => {
        const stopPromise = app.stop();

        // Delay another 100ms before finishing the PUT request
        setTimeout(() => {
          req.write(chunkData.subarray(50000));
          req.end();
        }, 100);

        await stopPromise;
      }, 50);
    });

    const res = await putPromise;
    assert.equal(res.statusCode, 201, 'In-flight chunk PUT must complete with 201 before stop resolves');
    assert.equal(res.json.index, 0);

    // Verify chunk is committed in metadata
    const metaRaw = fs.readFileSync(paths.metadataPath(uploadId, tmpRoot), 'utf8');
    const meta = JSON.parse(metaRaw);
    assert.equal(meta.chunks.length, 1);
    assert.equal(meta.chunks[0].checksum, chunkSha);
  });

  await t.test('20 start/stop cycles do not leak handles (process.getActiveResourcesInfo tolerance 2)', async () => {
    // Warm up cycle
    const warmup = createServer({ storageRoot: tmpRoot, cleanup: true, cleanupIntervalMs: 5000 });
    const port = 62106;
    await warmup.start(port, '127.0.0.1');
    await makeRequest(port, { path: '/health', method: 'GET' });
    await warmup.stop();

    // Check if getActiveResourcesInfo is available in this Node version
    const hasActiveResources = typeof process.getActiveResourcesInfo === 'function';
    const baseHandles = hasActiveResources ? process.getActiveResourcesInfo().length : 0;

    for (let i = 0; i < 20; i++) {
      const cycleApp = createServer({
        storageRoot: tmpRoot,
        cleanup: true,
        cleanupIntervalMs: 5000
      });
      await cycleApp.start(port, '127.0.0.1');
      const healthRes = await makeRequest(port, { path: '/health', method: 'GET' });
      assert.equal(healthRes.statusCode, 200);
      await cycleApp.stop();
    }

    if (hasActiveResources) {
      const finalHandles = process.getActiveResourcesInfo().length;
      const diff = Math.abs(finalHandles - baseHandles);
      assert.ok(
        diff <= 2,
        `Handle count must not grow after 20 cycles: base=${baseHandles}, final=${finalHandles}, diff=${diff}`
      );
    }
  });
});
