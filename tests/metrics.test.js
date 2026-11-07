const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createServer } = require('../src/server');
const { createMetricsStore } = require('../src/services/metricsStore');
const paths = require('../src/storage/paths');
const { generateFile } = require('../scripts/generate-test-file');
const { uploadFile, computeFileSha256 } = require('../scripts/simulate-interruption');

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

function sendChunkDirect(port, uploadId, index, buffer, totalSize, shaOverride = null) {
  const sha = shaOverride || crypto.createHash('sha256').update(buffer).digest('hex');
  const start = index * buffer.length;
  const end = start + buffer.length - 1;

  return makeRequest(
    port,
    {
      path: `/api/uploads/${uploadId}/chunks/${index}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'X-Chunk-SHA256': sha,
        'Content-Length': buffer.length
      }
    },
    buffer
  );
}

test('Metrics integration tests', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-metrics-test-'));
  const testFilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-metrics-files-'));

  const app = createServer({
    port: 0,
    storageRoot: tmpRoot,
    maxUploadBytes: 100 * 1024 * 1024,
    defaultChunkBytes: 1024 * 1024,
    minChunkBytes: 100,
    maxChunkBytes: 16 * 1024 * 1024,
    maxConcurrentUploads: 100
  });

  let port;
  let baseUrl;

  await t.test('start server', async () => {
    await app.start(0, '127.0.0.1');
    port = app.server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  await t.test(
    'Sequential upload of 6 chunks: counters, sizes, timing, throughput, ETA progression',
    async () => {
      const chunkSize = 1000;
      const totalChunks = 6;
      const totalSize = chunkSize * totalChunks;

      const createRes = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({
          filename: 'seq-metrics.bin',
          size: totalSize,
          contentType: 'application/octet-stream',
          chunkSize
        })
      );
      assert.equal(createRes.statusCode, 201);
      const uploadId = createRes.json.uploadId;

      // Upload first 2 chunks
      for (let i = 0; i < 2; i++) {
        const buf = Buffer.alloc(chunkSize, i + 1);
        const chunkRes = await sendChunkDirect(port, uploadId, i, buf, totalSize);
        assert.equal(chunkRes.statusCode, 201);
      }

      // Check metrics after 2 chunks: ETA unavailable (< 3 samples)
      const m2 = await makeRequest(port, { path: `/api/metrics/${uploadId}`, method: 'GET' });
      assert.equal(m2.statusCode, 200);
      assert.equal(m2.json.counters.committed, 2);
      assert.equal(m2.json.counters.attempts, 2);
      assert.equal(m2.json.counters.retries, 0);
      assert.equal(m2.json.eta.available, false);
      assert.equal(m2.json.eta.reason, 'insufficient_data');

      // Upload remaining 4 chunks
      for (let i = 2; i < 6; i++) {
        const buf = Buffer.alloc(chunkSize, i + 1);
        const chunkRes = await sendChunkDirect(port, uploadId, i, buf, totalSize);
        assert.equal(chunkRes.statusCode, 201);
      }

      // Check full metrics report
      const mFinal = await makeRequest(port, { path: `/api/metrics/${uploadId}`, method: 'GET' });
      assert.equal(mFinal.statusCode, 200);
      const report = mFinal.json;

      assert.equal(report.uploadId, uploadId);
      assert.equal(report.partial, false);

      // Counters
      assert.equal(report.counters.committed, 6);
      assert.equal(report.counters.attempts, 6);
      assert.equal(report.counters.retries, 0);
      assert.equal(report.counters.duplicates, 0);
      assert.equal(report.counters.repaired, 0);
      assert.equal(report.counters.rejected, 0);
      assert.equal(report.counters.aborted, 0);

      // Sizes
      assert.equal(report.size.expectedBytes, totalSize);
      assert.equal(report.size.committedBytes, totalSize);
      assert.equal(report.size.remainingBytes, 0);
      assert.equal(report.size.chunkSize, chunkSize);
      assert.equal(report.size.totalChunks, 6);
      assert.equal(report.size.committedChunks, 6);

      // Throughput
      assert.equal(report.throughput.basis, 'server-observed');
      assert.ok('overallBytesPerSecond' in report.throughput);
      assert.ok('overallMiBPerSecond' in report.throughput);
      assert.ok('recentBytesPerSecond' in report.throughput);
      assert.ok('recentMiBPerSecond' in report.throughput);

      // ETA at the end (remaining 0) -> available: true, seconds: 0
      assert.equal(report.eta.available, true);
      assert.equal(report.eta.seconds, 0);

      // Definitions present
      assert.ok(report.definitions.activeMs);
      assert.ok(report.definitions.resendEfficiency);
    }
  );

  await t.test(
    'Duplicate resend -> duplicates 1, retries 1, bytes.resentDeclared, resendEfficiency',
    async () => {
      const chunkSize = 2000;
      const totalSize = 4000;

      const createRes = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({
          filename: 'dup-test.bin',
          size: totalSize,
          contentType: 'application/octet-stream',
          chunkSize
        })
      );
      const uploadId = createRes.json.uploadId;
      const buf = Buffer.alloc(chunkSize, 0xaa);

      // Send chunk 0
      const res1 = await sendChunkDirect(port, uploadId, 0, buf, totalSize);
      assert.equal(res1.statusCode, 201);

      // Re-send chunk 0 (duplicate)
      const resDup = await sendChunkDirect(port, uploadId, 0, buf, totalSize);
      assert.equal(resDup.statusCode, 200);
      assert.equal(resDup.json.duplicate, true);

      const m = await makeRequest(port, { path: `/api/metrics/${uploadId}`, method: 'GET' });
      assert.equal(m.statusCode, 200);
      const report = m.json;

      assert.equal(report.counters.duplicates, 1);
      assert.equal(report.counters.retries, 1);
      assert.equal(report.bytes.resentDeclared, chunkSize);
      assert.equal(report.resume.bytesResentDeclared, chunkSize);
      const expectedEff = Math.floor((chunkSize * 10000) / totalSize) / 10000;
      assert.equal(report.resume.resendEfficiency, expectedEff);
    }
  );

  await t.test(
    'Wrong checksum -> checksumMismatches 1 and rejected 1, good re-send commits -> retries 1, committedBytes unaffected',
    async () => {
      const chunkSize = 1000;
      const totalSize = 2000;

      const createRes = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({
          filename: 'corrupt-chk.bin',
          size: totalSize,
          contentType: 'application/octet-stream',
          chunkSize
        })
      );
      const uploadId = createRes.json.uploadId;
      const buf = Buffer.alloc(chunkSize, 0x55);

      // Attempt 1 with bad checksum -> 422
      const badRes = await sendChunkDirect(
        port,
        uploadId,
        0,
        buf,
        totalSize,
        '0'.repeat(64) // bad SHA
      );
      assert.equal(badRes.statusCode, 422);

      // Check intermediate report: rejected 1, checksumMismatches 1, committedBytes 0
      const m1 = await makeRequest(port, { path: `/api/metrics/${uploadId}`, method: 'GET' });
      assert.equal(m1.json.counters.checksumMismatches, 1);
      assert.equal(m1.json.counters.rejected, 1);
      assert.equal(m1.json.size.committedBytes, 0);

      // Attempt 2 with correct checksum -> 201
      const goodRes = await sendChunkDirect(port, uploadId, 0, buf, totalSize);
      assert.equal(goodRes.statusCode, 201);

      const m2 = await makeRequest(port, { path: `/api/metrics/${uploadId}`, method: 'GET' });
      assert.equal(m2.json.counters.committed, 1);
      assert.equal(m2.json.counters.checksumMismatches, 1);
      assert.equal(m2.json.counters.rejected, 1);
      assert.equal(m2.json.counters.retries, 1);
      assert.equal(m2.json.size.committedBytes, chunkSize);
    }
  );

  await t.test('Aborted mid-chunk (destroy socket) -> aborted 1', async () => {
    const chunkSize = 10000;
    const totalSize = 20000;

    const createRes = await makeRequest(
      port,
      { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({
        filename: 'abort-chk.bin',
        size: totalSize,
        contentType: 'application/octet-stream',
        chunkSize
      })
    );
    const uploadId = createRes.json.uploadId;

    await new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Range': `bytes 0-9999/${totalSize}`,
          'X-Chunk-SHA256': '1'.repeat(64),
          'Content-Length': 10000
        }
      });
      req.on('error', () => {
        // Expected client abort error
      });

      req.write(Buffer.alloc(100, 0x11));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });

    await new Promise((r) => setTimeout(r, 100));

    const m = await makeRequest(port, { path: `/api/metrics/${uploadId}`, method: 'GET' });
    assert.equal(m.statusCode, 200);
    assert.equal(m.json.counters.aborted, 1);
  });

  await t.test('Repaired chunk (delete file, re-send) -> repaired 1 and counted in resentDeclared', async () => {
    const chunkSize = 1500;
    const totalSize = 3000;

    const createRes = await makeRequest(
      port,
      { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({
        filename: 'repair-chk.bin',
        size: totalSize,
        contentType: 'application/octet-stream',
        chunkSize
      })
    );
    const uploadId = createRes.json.uploadId;
    const buf = Buffer.alloc(chunkSize, 0xcc);

    // 1. Initial upload -> 201
    const res1 = await sendChunkDirect(port, uploadId, 0, buf, totalSize);
    assert.equal(res1.statusCode, 201);

    // 2. Delete chunk file on disk to simulate damage
    const chunkPath = paths.chunkPath(uploadId, 0, tmpRoot);
    await fs.promises.unlink(chunkPath);

    // 3. Re-send chunk -> 201 repaired: true
    const resRepair = await sendChunkDirect(port, uploadId, 0, buf, totalSize);
    assert.equal(resRepair.statusCode, 201);
    assert.equal(resRepair.json.repaired, true);

    const m = await makeRequest(port, { path: `/api/metrics/${uploadId}`, method: 'GET' });
    assert.equal(m.statusCode, 200);
    assert.equal(m.json.counters.repaired, 1);
    assert.equal(m.json.bytes.resentDeclared, chunkSize);
  });

  await t.test(
    'Unknown/invalid upload id on PUT is not recorded; metrics GET 404 for unknown and invalid ids',
    async () => {
      // 1. Invalid ID format on PUT
      const invPut = await makeRequest(
        port,
        {
          path: '/api/uploads/not-a-valid-uuid/chunks/0',
          method: 'PUT',
          headers: {
            'Content-Range': 'bytes 0-99/100',
            'X-Chunk-SHA256': '0'.repeat(64),
            'Content-Length': 100
          }
        },
        Buffer.alloc(100)
      );
      assert.equal(invPut.statusCode, 404);

      // 2. Non-existent UUID on PUT
      const randomUuid = crypto.randomUUID();
      const unknownPut = await makeRequest(
        port,
        {
          path: `/api/uploads/${randomUuid}/chunks/0`,
          method: 'PUT',
          headers: {
            'Content-Range': 'bytes 0-99/100',
            'X-Chunk-SHA256': '0'.repeat(64),
            'Content-Length': 100
          }
        },
        Buffer.alloc(100)
      );
      assert.equal(unknownPut.statusCode, 404);

      // 3. GET /api/metrics for invalid ID -> 404
      const invGet = await makeRequest(port, { path: '/api/metrics/invalid-uuid', method: 'GET' });
      assert.equal(invGet.statusCode, 404);

      // 4. GET /api/metrics for non-existent UUID -> 404
      const unkGet = await makeRequest(port, { path: `/api/metrics/${randomUuid}`, method: 'GET' });
      assert.equal(unkGet.statusCode, 404);
    }
  );

  await t.test('4 parallel chunk uploads: activeMs <= wallMs and report is consistent', async () => {
    const chunkSize = 1000;
    const totalSize = 4000;

    const createRes = await makeRequest(
      port,
      { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({
        filename: 'par-chunks.bin',
        size: totalSize,
        contentType: 'application/octet-stream',
        chunkSize
      })
    );
    const uploadId = createRes.json.uploadId;

    // Send 4 chunks concurrently
    const sends = [0, 1, 2, 3].map((i) => {
      const buf = Buffer.alloc(chunkSize, i + 1);
      return sendChunkDirect(port, uploadId, i, buf, totalSize);
    });

    const results = await Promise.all(sends);
    for (const r of results) {
      assert.equal(r.statusCode, 201);
    }

    const m = await makeRequest(port, { path: `/api/metrics/${uploadId}`, method: 'GET' });
    assert.equal(m.statusCode, 200);
    const report = m.json;

    assert.equal(report.counters.committed, 4);
    assert.equal(report.counters.attempts, 4);
    // Active time with 1000ms gap tolerance must be <= wall time
    assert.ok(report.timing.activeMs >= 0);
    assert.ok(report.timing.wallMs >= 0);
    assert.ok(
      report.timing.activeMs <= report.timing.wallMs + 50,
      `activeMs (${report.timing.activeMs}) should be <= wallMs (${report.timing.wallMs})`
    );
  });

  await t.test(
    'Finalize: section present, idempotent replay does not overwrite, failure recorded',
    async () => {
      const chunkSize = 1000;
      const totalSize = 2000;

      const createRes = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({
          filename: 'finalize-metrics.bin',
          size: totalSize,
          contentType: 'application/octet-stream',
          chunkSize
        })
      );
      const uploadId = createRes.json.uploadId;

      // 1. Force finalize failure on incomplete upload -> INCOMPLETE_UPLOAD
      const failFin = await makeRequest(
        port,
        { path: `/api/uploads/${uploadId}/finalize`, method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({})
      );
      assert.equal(failFin.statusCode, 409);

      // Verify failure recorded in metrics
      const mAfterFail = await makeRequest(port, { path: `/api/metrics/${uploadId}`, method: 'GET' });
      assert.equal(mAfterFail.statusCode, 200);
      assert.equal(mAfterFail.json.finalizeFailures.length, 1);
      assert.equal(mAfterFail.json.finalizeFailures[0].code, 'INCOMPLETE_UPLOAD');

      // Upload both chunks
      const b0 = Buffer.alloc(chunkSize, 0x11);
      const b1 = Buffer.alloc(chunkSize, 0x22);
      await sendChunkDirect(port, uploadId, 0, b0, totalSize);
      await sendChunkDirect(port, uploadId, 1, b1, totalSize);

      const wholeSha = crypto
        .createHash('sha256')
        .update(Buffer.concat([b0, b1]))
        .digest('hex');

      // 2. Successful finalize
      const fin1 = await makeRequest(
        port,
        { path: `/api/uploads/${uploadId}/finalize`, method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ sha256: wholeSha })
      );
      assert.equal(fin1.statusCode, 200);
      const originalAssemblyMs = fin1.json.stats.assemblyMs;

      // Inspect report
      const mFin1 = await makeRequest(port, { path: `/api/metrics/${uploadId}`, method: 'GET' });
      assert.ok(mFin1.json.finalize);
      assert.equal(mFin1.json.finalize.sha256, wholeSha);

      // 3. Second idempotent finalize returns assemblyMs: 0
      const fin2 = await makeRequest(
        port,
        { path: `/api/uploads/${uploadId}/finalize`, method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ sha256: wholeSha })
      );
      assert.equal(fin2.statusCode, 200);
      assert.equal(fin2.json.stats.assemblyMs, 0);

      // Finalize record in metrics must NOT be overwritten by assemblyMs: 0
      const mFin2 = await makeRequest(port, { path: `/api/metrics/${uploadId}`, method: 'GET' });
      assert.equal(mFin2.json.finalize.assemblyMs, originalAssemblyMs);
    }
  );

  await t.test(
    'Persistence: flush, stop server, start NEW server -> identical counters; missing metrics.json -> partial report',
    async () => {
      const chunkSize = 1000;
      const totalSize = 2000;

      const createRes = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({
          filename: 'persist-test.bin',
          size: totalSize,
          contentType: 'application/octet-stream',
          chunkSize
        })
      );
      const uploadId = createRes.json.uploadId;
      await sendChunkDirect(port, uploadId, 0, Buffer.alloc(chunkSize, 0x33), totalSize);

      // Flush metrics
      await app.metricsStore.flush(uploadId);

      const beforeStop = await makeRequest(port, { path: `/api/metrics/${uploadId}`, method: 'GET' });
      assert.equal(beforeStop.statusCode, 200);

      // Stop old server and start new server pointing to identical storageRoot
      await app.stop();

      const newApp = createServer({
        port: 0,
        storageRoot: tmpRoot,
        minChunkBytes: 100
      });
      await newApp.start(0, '127.0.0.1');
      const newPort = newApp.server.address().port;

      try {
        const afterRestart = await makeRequest(newPort, { path: `/api/metrics/${uploadId}`, method: 'GET' });
        assert.equal(afterRestart.statusCode, 200);
        assert.deepEqual(afterRestart.json.counters, beforeStop.json.counters);

        // Stop newApp first so flushAll() completes
        await newApp.stop();

        // Remove metrics.json to test synthesized partial report
        const metricsPath = path.join(tmpRoot, 'uploads', uploadId, 'metrics.json');
        await fs.promises.unlink(metricsPath);

        const thirdApp = createServer({ port: 0, storageRoot: tmpRoot, minChunkBytes: 100 });
        await thirdApp.start(0, '127.0.0.1');
        const thirdPort = thirdApp.server.address().port;

        try {
          const partialReport = await makeRequest(thirdPort, { path: `/api/metrics/${uploadId}`, method: 'GET' });
          assert.equal(partialReport.statusCode, 200);
          assert.equal(partialReport.json.partial, true);
          assert.equal(partialReport.json.size.committedChunks, 1);
        } finally {
          await thirdApp.stop();
        }
      } finally {
        // Re-start app for subsequent subtests
        await app.start(port, '127.0.0.1');
      }
    }
  );

  await t.test(
    'Media served: GET full, GET range, aborted download, 304 -> media counts correct; HEAD not counted',
    async () => {
      // Create and finalize a 2 MiB media item
      const chunkSize = 1024 * 1024;
      const mediaSize = 2 * chunkSize;
      const b0 = Buffer.alloc(chunkSize, 0x77);
      const b1 = Buffer.alloc(chunkSize, 0x88);
      const mediaBuf = Buffer.concat([b0, b1]);
      const mediaSha = crypto.createHash('sha256').update(mediaBuf).digest('hex');

      const createRes = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({
          filename: 'media-serv.bin',
          size: mediaSize,
          contentType: 'application/octet-stream',
          chunkSize
        })
      );
      const uploadId = createRes.json.uploadId;
      await sendChunkDirect(port, uploadId, 0, b0, mediaSize);
      await sendChunkDirect(port, uploadId, 1, b1, mediaSize);

      const finRes = await makeRequest(
        port,
        { path: `/api/uploads/${uploadId}/finalize`, method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ sha256: mediaSha })
      );
      assert.equal(finRes.statusCode, 200);
      const mediaId = finRes.json.mediaId;

      // 1. HEAD request -> should NOT be counted in requests
      await makeRequest(port, { path: `/api/media/${mediaId}`, method: 'HEAD' });

      // 2. Full GET -> requests: 1, partialResponses: 0
      await makeRequest(port, { path: `/api/media/${mediaId}`, method: 'GET' });

      // 3. Range GET -> requests: 2, partialResponses: 1
      await makeRequest(port, {
        path: `/api/media/${mediaId}`,
        method: 'GET',
        headers: { Range: 'bytes=0-499' }
      });

      // 4. 304 Not Modified -> notModified: 1
      await makeRequest(port, {
        path: `/api/media/${mediaId}`,
        method: 'GET',
        headers: { 'If-None-Match': `"${mediaSha}"` }
      });

      // 5. Aborted download -> abortedResponses: 1
      await new Promise((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: `/api/media/${mediaId}`,
          method: 'GET'
        }, (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', () => {});
        req.end();
      });

      await new Promise((r) => setTimeout(r, 100));

      const m = await makeRequest(port, { path: `/api/metrics/${uploadId}`, method: 'GET' });
      assert.equal(m.statusCode, 200);
      const media = m.json.media;
      assert.ok(media);
      assert.equal(media.requests, 3); // 1 full GET + 1 Range GET + 1 aborted GET (HEAD & 304 excluded)
      assert.equal(media.partialResponses, 1);
      assert.equal(media.notModified, 1);
      assert.equal(media.abortedResponses, 1);
    }
  );

  await t.test('Metrics persistence failure injected -> chunk PUT returns 201 and completes', async () => {
    const chunkSize = 1000;
    const totalSize = 2000;

    const createRes = await makeRequest(
      port,
      { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({
        filename: 'inject-fail.bin',
        size: totalSize,
        contentType: 'application/octet-stream',
        chunkSize
      })
    );
    const uploadId = createRes.json.uploadId;

    // Inject persistence failure
    app.metricsStore._setPersistenceFailure(() => {
      throw new Error('Injected storage failure');
    });

    try {
      const res = await sendChunkDirect(port, uploadId, 0, Buffer.alloc(chunkSize, 0x88), totalSize);
      assert.equal(res.statusCode, 201, 'Chunk PUT must succeed despite persistence failure');
    } finally {
      app.metricsStore._setPersistenceFailure(null);
    }
  });

  await t.test(
    '/api/recommendation/chunk-size and /api/stats routing and output validation',
    async () => {
      const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-fresh-rec-'));
      const freshServer = createServer({ port: 0, storageRoot: freshRoot });
      await freshServer.start(0, '127.0.0.1');
      const freshPort = freshServer.server.address().port;
      const freshBaseUrl = `http://127.0.0.1:${freshPort}`;

      try {
        // 1. Fresh server recommendation
        const recRes = await makeRequest(freshPort, {
          path: '/api/recommendation/chunk-size',
          method: 'GET'
        });
        assert.equal(recRes.statusCode, 200);
        assert.equal(recRes.json.reason, 'insufficient_data');
        assert.equal(recRes.json.recommendedChunkBytes, 1024 * 1024);
        assert.ok(recRes.json.basis);

        // Upload 5 MiB through client to populate global window (5 chunks)
        const test5MbPath = path.join(testFilesDir, 'rec-5mb.bin');
        await generateFile(5 * 1024 * 1024, test5MbPath, 12345);
        await uploadFile({
          baseUrl: freshBaseUrl,
          filePath: test5MbPath,
          chunkSize: 1024 * 1024,
          log: () => {}
        });

        // Check recommendation after 5 MiB
        const recAfter = await makeRequest(freshPort, {
          path: '/api/recommendation/chunk-size',
          method: 'GET'
        });
        assert.equal(recAfter.statusCode, 200);
        const rec = recAfter.json;
        assert.ok(rec.recommendedChunkBytes >= 64 * 1024);
        assert.ok(rec.recommendedChunkBytes <= 16 * 1024 * 1024);
        // Verify power of two:
        assert.equal((rec.recommendedChunkBytes & (rec.recommendedChunkBytes - 1)), 0);
        assert.ok(rec.inputs.samples >= 3);
        assert.ok(rec.inputs.recentBytesPerSecond > 0);

        // 2. Server stats
        const statsRes = await makeRequest(freshPort, { path: '/api/stats', method: 'GET' });
        assert.equal(statsRes.statusCode, 200);
        assert.ok(typeof statsRes.json.uptimeSeconds === 'number');
        assert.ok(typeof statsRes.json.rssBytes === 'number');
        assert.ok(typeof statsRes.json.heapUsedBytes === 'number');
        assert.ok(typeof statsRes.json.peakRssBytes === 'number');
        assert.ok(statsRes.json.peakRssBytes >= statsRes.json.rssBytes);
      } finally {
        await freshServer.stop();
        fs.rmSync(freshRoot, { recursive: true, force: true });
      }
    }
  );

  await t.test('Two servers with different storageRoots keep independent metrics', async () => {
    const root1 = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-srv1-'));
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-srv2-'));

    const srv1 = createServer({ port: 0, storageRoot: root1, minChunkBytes: 100 });
    const srv2 = createServer({ port: 0, storageRoot: root2, minChunkBytes: 100 });

    await srv1.start(0, '127.0.0.1');
    await srv2.start(0, '127.0.0.1');

    const p1 = srv1.server.address().port;
    const p2 = srv2.server.address().port;

    try {
      const c1 = await makeRequest(
        p1,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({
          filename: 's1.bin',
          size: 1000,
          contentType: 'application/octet-stream',
          chunkSize: 1000
        })
      );
      const id1 = c1.json.uploadId;
      await sendChunkDirect(p1, id1, 0, Buffer.alloc(1000, 0x11), 1000);

      // srv1 has metrics for id1
      const m1 = await makeRequest(p1, { path: `/api/metrics/${id1}`, method: 'GET' });
      assert.equal(m1.statusCode, 200);

      // srv2 knows nothing about id1 -> 404
      const m2 = await makeRequest(p2, { path: `/api/metrics/${id1}`, method: 'GET' });
      assert.equal(m2.statusCode, 404);
    } finally {
      await srv1.stop();
      await srv2.stop();
      fs.rmSync(root1, { recursive: true, force: true });
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });

  await t.test(
    'A3: wallMs monotonic tracking ensures activeMs <= wallMs for single, parallel, and sequential chunks + reload',
    async () => {
      // 1. Single chunk upload
      const resSingle = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ filename: 'single.bin', size: 1000, contentType: 'application/octet-stream', chunkSize: 1000 })
      );
      const idSingle = resSingle.json.uploadId;
      await sendChunkDirect(port, idSingle, 0, Buffer.alloc(1000, 0x01), 1000);
      const mSingle = await makeRequest(port, { path: `/api/metrics/${idSingle}`, method: 'GET' });
      assert.equal(mSingle.statusCode, 200);
      assert.ok(mSingle.json.timing.wallMs >= mSingle.json.timing.activeMs, `wallMs (${mSingle.json.timing.wallMs}) must be >= activeMs (${mSingle.json.timing.activeMs})`);

      // 2. 4 parallel chunks upload
      const resParallel = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ filename: 'parallel.bin', size: 4000, contentType: 'application/octet-stream', chunkSize: 1000 })
      );
      const idParallel = resParallel.json.uploadId;
      await Promise.all([
        sendChunkDirect(port, idParallel, 0, Buffer.alloc(1000, 0x01), 4000),
        sendChunkDirect(port, idParallel, 1, Buffer.alloc(1000, 0x02), 4000),
        sendChunkDirect(port, idParallel, 2, Buffer.alloc(1000, 0x03), 4000),
        sendChunkDirect(port, idParallel, 3, Buffer.alloc(1000, 0x04), 4000)
      ]);
      const mParallel = await makeRequest(port, { path: `/api/metrics/${idParallel}`, method: 'GET' });
      assert.equal(mParallel.statusCode, 200);
      assert.ok(mParallel.json.timing.wallMs >= mParallel.json.timing.activeMs, `wallMs (${mParallel.json.timing.wallMs}) must be >= activeMs (${mParallel.json.timing.activeMs}) for parallel`);

      // 3. Sequential chunks upload
      const resSeq = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ filename: 'seq.bin', size: 3000, contentType: 'application/octet-stream', chunkSize: 1000 })
      );
      const idSeq = resSeq.json.uploadId;
      for (let i = 0; i < 3; i++) {
        await sendChunkDirect(port, idSeq, i, Buffer.alloc(1000, i + 1), 3000);
      }
      const mSeq = await makeRequest(port, { path: `/api/metrics/${idSeq}`, method: 'GET' });
      assert.equal(mSeq.statusCode, 200);
      assert.ok(mSeq.json.timing.wallMs >= mSeq.json.timing.activeMs, `wallMs (${mSeq.json.timing.wallMs}) must be >= activeMs (${mSeq.json.timing.activeMs}) for sequential`);

      // 4. Persist and reload test (flushing and reading back)
      await app.metricsStore.flush(idSeq);
      const loaded = await app.metricsStore.getReport(idSeq);
      assert.ok(loaded.timing.wallMs >= loaded.timing.activeMs);

      // Backwards compatibility: test loading an old metrics.json missing firstStartMs / lastEndMs
      const resOld = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ filename: 'old.bin', size: 1000, contentType: 'application/octet-stream', chunkSize: 1000 })
      );
      const idOld = resOld.json.uploadId;
      const oldMetricsPayload = {
        uploadId: idOld,
        counters: { attempts: 1, committed: 1, duplicates: 0, repaired: 0, rejected: 0, conflicts: 0, checksumMismatches: 0, aborted: 0 },
        perIndexAttempts: { 0: 1 },
        bytes: { declaredOnAttempts: 1000, committed: 1000, resent: 0 },
        mergedIntervals: [{ startMs: 100, endMs: 150 }],
        recentRecords: [{ bytes: 1000, startMs: 100, endMs: 150 }],
        chunkDurationsMs: [50],
        firstAttemptAt: '2026-11-07T10:00:00.000Z',
        lastCommitAt: '2026-11-07T10:00:01.000Z'
      };
      fs.writeFileSync(paths.metricsPath(idOld, tmpRoot), JSON.stringify(oldMetricsPayload), 'utf8');
      const oldLoaded = await app.metricsStore.getReport(idOld);
      assert.ok(oldLoaded);
      assert.equal(oldLoaded.timing.wallMs, 1000);
    }
  );

  await t.test(
    'A4: finalize on 20 random unknown well-formed ids leaves getServerStats().trackedUploads unchanged',
    async () => {
      const initialStats = app.metricsStore.getServerStats();
      const initialTracked = initialStats.trackedUploads;

      for (let i = 0; i < 20; i++) {
        const fakeId = crypto.randomUUID();
        const res = await makeRequest(port, {
          path: `/api/uploads/${fakeId}/finalize`,
          method: 'POST'
        });
        assert.equal(res.statusCode, 404);
      }

      const postStats = app.metricsStore.getServerStats();
      assert.equal(postStats.trackedUploads, initialTracked, 'trackedUploads must not increase on unknown finalize 404s');
    }
  );

  await t.test(
    'A3: monotonic rebase on load when monoOriginEpochMs differs by 10 minutes',
    async () => {
      const totalSize = 2000;
      const chunkSize = 1000;
      const res = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ filename: 'rebase.bin', size: totalSize, contentType: 'application/octet-stream', chunkSize })
      );
      const uploadId = res.json.uploadId;

      const currentOrigin = Date.now() - app.metricsStore.nowMonotonicMs();
      const fakeOrigin = currentOrigin - 600000; // 10 minutes earlier

      // Monotonic values relative to the fake origin
      const fakeStartMs = 50000;
      const fakeEndMs = 52500; // 2500 ms duration

      const rebasePayload = {
        uploadId,
        monoOriginEpochMs: fakeOrigin,
        counters: { attempts: 1, committed: 1, duplicates: 0, repaired: 0, rejected: 0, conflicts: 0, checksumMismatches: 0, aborted: 0 },
        perIndexAttempts: { 0: 1 },
        bytes: { declaredOnAttempts: 1000, committed: 1000, resent: 0 },
        mergedIntervals: [{ startMs: fakeStartMs, endMs: fakeEndMs }],
        recentRecords: [{ bytes: 1000, startMs: fakeStartMs, endMs: fakeEndMs }],
        chunkDurationsMs: [2500],
        firstStartMs: fakeStartMs,
        lastEndMs: fakeEndMs,
        firstAttemptAt: new Date(Date.now() - 600000).toISOString(),
        lastCommitAt: new Date(Date.now() - 597500).toISOString()
      };

      fs.writeFileSync(paths.metricsPath(uploadId, tmpRoot), JSON.stringify(rebasePayload), 'utf8');

      // Create a fresh metrics store to force disk load
      const freshStore = createMetricsStore({ storageRoot: tmpRoot, config: app.config });
      const loadedReport = await freshStore.getReport(uploadId);

      assert.ok(loadedReport);
      assert.equal(loadedReport.timing.wallMs, 2500, 'wallMs must be preserved after monotonic rebase');
      assert.equal(loadedReport.timing.activeMs, 2500, 'activeMs must be preserved after monotonic rebase');

      // Now add a new chunk in the current process monotonic frame
      const currentMono = app.metricsStore.nowMonotonicMs();
      freshStore.recordChunkAttempt(uploadId, {
        index: 1,
        declaredBytes: 1000,
        startMs: currentMono + 10,
        endMs: currentMono + 100,
        outcome: 'committed'
      });

      const updatedReport = await freshStore.getReport(uploadId);
      assert.ok(updatedReport.timing.activeMs <= updatedReport.timing.wallMs, `activeMs (${updatedReport.timing.activeMs}) must be <= wallMs (${updatedReport.timing.wallMs}) after rebase and new chunk`);
    }
  );

  await t.test('stop server and clean up', async () => {
    await app.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(testFilesDir, { recursive: true, force: true });
  });
});
