const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createServer } = require('../src/server');
const paths = require('../src/storage/paths');
const { generateFile } = require('../scripts/generate-test-file');
const {
  uploadFile,
  computeFileSha256,
  computeSliceSha256
} = require('../scripts/simulate-interruption');

function makeRequest(port, options = {}) {
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
    req.end();
  });
}

test('Client concurrency, failure injection, and clientMetrics tests', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-client-test-'));
  const testFilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-client-files-'));

  const app = createServer({
    port: 0,
    storageRoot: tmpRoot,
    maxUploadBytes: 100 * 1024 * 1024,
    defaultChunkBytes: 1024 * 1024,
    minChunkBytes: 64 * 1024,
    maxChunkBytes: 16 * 1024 * 1024
  });

  let port;
  let baseUrl;

  // Generate ~6.5 MiB seeded file (6815744 bytes)
  const fileSize65Mb = 6815744;
  const filePath65Mb = path.join(testFilesDir, 'client-6.5mb.bin');
  await generateFile(fileSize65Mb, filePath65Mb, 777888);
  const expectedWholeSha = await computeFileSha256(filePath65Mb);

  await t.test('start server', async () => {
    await app.start(0, '127.0.0.1');
    port = app.server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  await t.test(
    'uploadFile with concurrency 3 on ~6.5 MiB file -> ledger complete, chunk SHAs match, clientMetrics present',
    async () => {
      const summary = await uploadFile({
        baseUrl,
        filePath: filePath65Mb,
        chunkSize: 1024 * 1024,
        concurrency: 3,
        finalize: true,
        log: () => {}
      });

      assert.equal(summary.state, 'ready');
      assert.equal(summary.chunksSentThisRun, 7);
      assert.equal(summary.bytesSentThisRun, fileSize65Mb);
      assert.equal(summary.retries, 0);

      // Verify clientMetrics shape and basis
      const cm = summary.clientMetrics;
      assert.ok(cm, 'clientMetrics must be present');
      assert.equal(cm.basis, 'client-observed');
      assert.ok(cm.elapsedMs > 0);
      assert.equal(cm.bytesSentThisRun, fileSize65Mb);
      assert.ok(cm.clientObservedMiBps > 0);
      assert.ok(typeof cm.medianSendMs === 'number');
      assert.ok(typeof cm.medianHashMs === 'number');
      assert.equal(cm.concurrency, 3);
      assert.equal(cm.retries, 0);

      // Query server ledger
      const statusRes = await makeRequest(port, {
        path: `/api/uploads/${summary.uploadId}`,
        method: 'GET'
      });
      assert.equal(statusRes.statusCode, 200);
      const serverStatus = statusRes.json;
      assert.equal(serverStatus.committedChunks.length, 7);
      assert.deepEqual(serverStatus.missingChunks, []);

      // Verify on-disk chunk integrity against expected source slice SHA-256
      // (media finalization cleans up chunks from chunksDir, but media file has full SHA)
      assert.equal(summary.media.sha256, expectedWholeSha);
    }
  );

  await t.test('stopAfter 3 with concurrency 3 starts exactly 3 chunk uploads', async () => {
    const summary = await uploadFile({
      baseUrl,
      filePath: filePath65Mb,
      chunkSize: 1024 * 1024,
      concurrency: 3,
      stopAfter: 3,
      finalize: false,
      log: () => {}
    });

    assert.equal(summary.chunksSentThisRun, 3);
    assert.equal(summary.interrupted, true);

    // Verify exactly 3 chunks committed on server
    const statusRes = await makeRequest(port, {
      path: `/api/uploads/${summary.uploadId}`,
      method: 'GET'
    });
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.json.committedChunks.length, 3);
  });

  await t.test(
    'corruptChunkIndex 2 -> permanent error, 1 attempt for that chunk, in-flight finish, then resume finalizes',
    async () => {
      let thrownErr = null;

      try {
        await uploadFile({
          baseUrl,
          filePath: filePath65Mb,
          chunkSize: 1024 * 1024,
          concurrency: 3,
          corruptChunkIndex: 2,
          finalize: false,
          log: () => {}
        });
      } catch (err) {
        thrownErr = err;
      }

      assert.ok(thrownErr, 'Expected uploadFile to throw on corruptChunkIndex');
      assert.equal(thrownErr.statusCode, 422);

      const failedSummary = thrownErr.summary;
      assert.ok(failedSummary, 'Thrown error must carry summary so far');
      const uploadId = failedSummary.uploadId;
      assert.ok(uploadId);

      // Check server upload status
      const statusRes = await makeRequest(port, {
        path: `/api/uploads/${uploadId}`,
        method: 'GET'
      });
      assert.equal(statusRes.statusCode, 200);
      const serverStatus = statusRes.json;

      // Chunk 0 and chunk 1 (in-flight before chunk 2 failed) should have finished and committed
      assert.ok(serverStatus.committedChunks.includes(0));
      assert.ok(serverStatus.committedChunks.includes(1));
      // Chunk 2 failed and was not committed
      assert.ok(!serverStatus.committedChunks.includes(2));

      // Check metrics: exactly 1 attempt on chunk 2, checksumMismatches 1
      const mRes = await makeRequest(port, {
        path: `/api/metrics/${uploadId}`,
        method: 'GET'
      });
      assert.equal(mRes.statusCode, 200);
      assert.equal(mRes.json.counters.checksumMismatches, 1);

      // Resume upload with NO corruption and finalize
      const resumeSummary = await uploadFile({
        baseUrl,
        uploadId,
        filePath: filePath65Mb,
        chunkSize: 1024 * 1024,
        concurrency: 3,
        finalize: true,
        log: () => {}
      });

      assert.equal(resumeSummary.state, 'ready');
      assert.equal(resumeSummary.media.sha256, expectedWholeSha);

      // Verify resume metrics report
      const finalMetricsRes = await makeRequest(port, {
        path: `/api/metrics/${uploadId}`,
        method: 'GET'
      });
      assert.equal(finalMetricsRes.statusCode, 200);
      assert.equal(finalMetricsRes.json.counters.committed, 7);
      assert.equal(finalMetricsRes.json.counters.checksumMismatches, 1);
      assert.equal(finalMetricsRes.json.counters.retries, 1); // 1 retry on index 2
    }
  );

  await t.test('clean up server and temporary files', async () => {
    await app.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(testFilesDir, { recursive: true, force: true });
  });
});
