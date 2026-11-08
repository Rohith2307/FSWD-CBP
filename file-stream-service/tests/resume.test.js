const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createServer } = require('../src/server');
const { uploadFile, computeSliceSha256 } = require('../scripts/simulate-interruption');
const { generateFile } = require('../scripts/generate-test-file');

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

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

test('Status and resume engine integration tests', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-resume-test-'));
  let app = createServer({
    port: 0,
    storageRoot: tmpRoot,
    minChunkBytes: 64 * 1024,
    defaultChunkBytes: 128 * 1024,
    maxChunkBytes: 2 * 1024 * 1024,
    maxUploadBytes: 20 * 1024 * 1024,
    maxConcurrentUploads: 100
  });

  let port;

  await t.test('start server', async () => {
    await app.start(0, '127.0.0.1');
    port = app.server.address().port;
    assert.ok(port > 0);
  });

  await t.test('status on fresh upload: all chunks missing, 0 committed, progress 0', async () => {
    const size = 600 * 1024;
    const chunkSize = 100 * 1024;

    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({ filename: 'fresh.mp4', size, contentType: 'video/mp4', chunkSize })
    );
    const { uploadId } = createRes.json;

    const statusRes = await makeRequest(port, {
      path: `/api/uploads/${uploadId}`,
      method: 'GET'
    });
    assert.equal(statusRes.statusCode, 200);
    const st = statusRes.json;
    assert.equal(st.uploadId, uploadId);
    assert.deepEqual(st.committedChunks, []);
    assert.deepEqual(st.missingChunks, [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(st.committedRanges, []);
    assert.deepEqual(st.missingRanges, [{ start: 0, end: size - 1 }]);
    assert.equal(st.committedBytes, 0);
    assert.equal(st.progressPercent, 0);
    assert.equal(st.verified, false);
  });

  await t.test('upload chunks 0, 1, 3 of a 6-chunk file: status shows correct merged ranges and progress', async () => {
    const chunkSize = 128 * 1024;
    const totalChunks = 6;
    const totalSize = totalChunks * chunkSize;
    const source = crypto.randomBytes(totalSize);

    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({ filename: 'partial.mp4', size: totalSize, contentType: 'video/mp4', chunkSize })
    );
    const { uploadId } = createRes.json;

    // Upload chunks 0, 1, 3
    for (const i of [0, 1, 3]) {
      const start = i * chunkSize;
      const end = start + chunkSize - 1;
      const slice = source.subarray(start, end + 1);
      await makeRequest(
        port,
        {
          path: `/api/uploads/${uploadId}/chunks/${i}`,
          method: 'PUT',
          headers: {
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'X-Chunk-SHA256': sha256(slice),
            'Content-Length': slice.length
          }
        },
        slice
      );
    }

    const statusRes = await makeRequest(port, {
      path: `/api/uploads/${uploadId}`,
      method: 'GET'
    });
    const st = statusRes.json;
    assert.deepEqual(st.committedChunks, [0, 1, 3]);
    assert.deepEqual(st.missingChunks, [2, 4, 5]);
    // Merged committed ranges: 0..2*C-1 (chunks 0 and 1) and 3*C..4*C-1 (chunk 3)
    assert.deepEqual(st.committedRanges, [
      { start: 0, end: 2 * chunkSize - 1 },
      { start: 3 * chunkSize, end: 4 * chunkSize - 1 }
    ]);
    // Merged missing ranges: 2*C..3*C-1 (chunk 2) and 4*C..totalSize-1 (chunks 4 and 5)
    assert.deepEqual(st.missingRanges, [
      { start: 2 * chunkSize, end: 3 * chunkSize - 1 },
      { start: 4 * chunkSize, end: totalSize - 1 }
    ]);
    assert.equal(st.committedBytes, 3 * chunkSize);
    assert.equal(st.progressPercent, 50);

    // Test ?verify=true on disk
    // Delete chunk 1 from disk
    const chunk1Path = path.join(tmpRoot, 'uploads', uploadId, 'chunks', '000001.part');
    fs.unlinkSync(chunk1Path);

    // Truncate chunk 3 on disk
    const chunk3Path = path.join(tmpRoot, 'uploads', uploadId, 'chunks', '000003.part');
    fs.truncateSync(chunk3Path, 100);

    // Standard GET without ?verify still reports ledger view (cheap)
    const cheapRes = await makeRequest(port, { path: `/api/uploads/${uploadId}`, method: 'GET' });
    assert.deepEqual(cheapRes.json.committedChunks, [0, 1, 3]);

    // GET with ?verify=true inspects on-disk reality
    const verifyRes = await makeRequest(port, { path: `/api/uploads/${uploadId}?verify=true`, method: 'GET' });
    const vst = verifyRes.json;
    assert.equal(vst.verified, true);
    assert.deepEqual(vst.committedChunks, [0]);
    assert.deepEqual(vst.missingChunks, [1, 2, 3, 4, 5]);
    assert.deepEqual(vst.problems, [
      { index: 1, reason: 'missing_file' },
      { index: 3, reason: 'size_mismatch' }
    ]);
    assert.equal(vst.committedBytes, chunkSize);
  });

  await t.test('restart: state is durable across server instances', async () => {
    const size = 256 * 1024;
    const chunkSize = 128 * 1024;
    const slice0 = crypto.randomBytes(chunkSize);

    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({ filename: 'restart.mp4', size, contentType: 'video/mp4', chunkSize })
    );
    const { uploadId } = createRes.json;

    await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Range': `bytes 0-${chunkSize - 1}/${size}`,
          'X-Chunk-SHA256': sha256(slice0),
          'Content-Length': chunkSize
        }
      },
      slice0
    );

    // Stop server
    await app.stop();

    // Start a completely new server instance pointing at the SAME storageRoot
    app = createServer({
      port: 0,
      storageRoot: tmpRoot,
      minChunkBytes: 64 * 1024,
      defaultChunkBytes: 128 * 1024,
      maxChunkBytes: 2 * 1024 * 1024,
      maxUploadBytes: 20 * 1024 * 1024,
      maxConcurrentUploads: 100
    });
    await app.start(0, '127.0.0.1');
    port = app.server.address().port;

    const statusRes = await makeRequest(port, { path: `/api/uploads/${uploadId}`, method: 'GET' });
    assert.equal(statusRes.statusCode, 200);
    assert.deepEqual(statusRes.json.committedChunks, [0]);
    assert.equal(statusRes.json.progressPercent, 50);
  });

  await t.test('simulate-interruption client: in-process upload with stopAfter and resume', async () => {
    // Generate a ~5.5 MiB file with 1 MiB chunks
    const testFilePath = path.join(tmpRoot, 'test-5.5m.bin');
    const targetSize = Math.floor(5.5 * 1024 * 1024); // 5,767,168 bytes
    await generateFile(targetSize, testFilePath, 'seed-resume-test');

    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. First run with stopAfter: 3
    const run1 = await uploadFile({
      baseUrl,
      filePath: testFilePath,
      chunkSize: 1048576,
      contentType: 'application/octet-stream',
      stopAfter: 3,
      log: null
    });

    assert.equal(run1.interrupted, true);
    assert.equal(run1.chunksSentThisRun, 3);
    assert.equal(run1.totalChunks, 6);
    const uploadId = run1.uploadId;

    // 2. Resume run: upload remainder
    const run2 = await uploadFile({
      baseUrl,
      filePath: testFilePath,
      uploadId,
      log: null
    });

    assert.equal(run2.interrupted, false);
    assert.equal(run2.chunksSentThisRun, 3); // Sent only the missing 3 chunks
    assert.equal(run2.bytesAlreadyCommitted, 3 * 1048576);
    assert.equal(run2.progressPercent, 100);
    assert.equal(run2.resendEfficiency, 0);

    // 3. Verify every chunk on disk matches the source file slices
    for (let i = 0; i < 6; i++) {
      const start = i * 1048576;
      const end = Math.min(start + 1048576 - 1, targetSize - 1);
      const expectedSha = await computeSliceSha256(testFilePath, start, end);

      const chunkDiskPath = path.join(tmpRoot, 'uploads', uploadId, 'chunks', `${String(i).padStart(6, '0')}.part`);
      const diskBytes = fs.readFileSync(chunkDiskPath);
      assert.equal(sha256(diskBytes), expectedSha);
    }
  });

  await t.test('client does not retry 4xx validation errors', async () => {
    const chunkSize = 64 * 1024;
    const testFilePath = path.join(tmpRoot, 'test-err.bin');
    fs.writeFileSync(testFilePath, Buffer.alloc(chunkSize));

    const baseUrl = `http://127.0.0.1:${port}`;

    await assert.rejects(
      async () => {
        await uploadFile({
          baseUrl,
          filePath: testFilePath,
          chunkSize,
          contentType: 'application/octet-stream',
          corruptChecksumOnce: true,
          maxRetries: 3,
          log: null
        });
      },
      (err) => {
        assert.ok(
          err.statusCode === 422 || err.message.includes('Permanent error 422'),
          `Expected 422 error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  await t.test('status endpoint rejects invalid and unknown upload IDs with 404', async () => {
    const resBadId = await makeRequest(port, { path: '/api/uploads/invalid-id-format', method: 'GET' });
    assert.equal(resBadId.statusCode, 404);

    const nonExistentId = crypto.randomUUID();
    const resNotFound = await makeRequest(port, { path: `/api/uploads/${nonExistentId}`, method: 'GET' });
    assert.equal(resNotFound.statusCode, 404);
  });

  await t.test('stop server and clean up', async () => {
    await app.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});
