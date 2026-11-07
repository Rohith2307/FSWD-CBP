const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createServer } = require('../src/server');
const { createUploader } = require('../public/uploader');

function createSeededBuffer(size, seed = 12345) {
  const buf = Buffer.alloc(size);
  let state = seed;
  for (let i = 0; i < size; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    buf[i] = state & 0xff;
  }
  return buf;
}

test('uploader: Resumable client integration tests (Checkpoint 6B)', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-uploader-test-'));
  const app = createServer({
    port: 0,
    storageRoot: tmpRoot,
    maxConcurrentUploads: 100
  });

  let port;
  let baseUrl;

  t.after(async () => {
    await app.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('start server', async () => {
    await app.start();
    port = app.server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
    assert.ok(port > 0);
  });

  const fileBytes = Math.floor(5.5 * 1024 * 1024); // 5.5 MiB
  const fileBuffer = createSeededBuffer(fileBytes, 98765);
  const expectedSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  await t.test('Full upload + finalize of ~5.5 MiB Blob matches source and SHA', async () => {
    const blob = new Blob([fileBuffer]);
    const uploader = createUploader({ baseUrl });

    const summary = await uploader.upload(blob, {
      name: 'video-test.mp4',
      contentType: 'video/mp4',
      chunkSize: 1048576,
      concurrency: 2,
      finalize: true
    });

    assert.equal(summary.interrupted, false);
    assert.ok(summary.media);
    assert.equal(summary.media.sha256, expectedSha256);
    assert.equal(summary.media.size, fileBytes);

    // Stream download and verify byte-for-byte
    const mediaUrl = summary.media.url || summary.media.downloadUrl;
    const getRes = await fetch(`${baseUrl}${mediaUrl}`);
    assert.equal(getRes.status, 200);
    const downloadedArrayBuffer = await getRes.arrayBuffer();
    const downloadedBuffer = Buffer.from(downloadedArrayBuffer);

    assert.equal(downloadedBuffer.length, fileBytes);
    assert.ok(downloadedBuffer.equals(fileBuffer), 'Downloaded media bytes must equal source buffer');
  });

  await t.test('stopAfter 3 then resume sends ONLY remaining chunks and resendEfficiency is 0', async () => {
    const blob = new Blob([fileBuffer]);
    let putCountRun1 = 0;
    const fetchRun1 = async (url, opts) => {
      if (opts?.method === 'PUT') putCountRun1++;
      return globalThis.fetch(url, opts);
    };

    const uploader1 = createUploader({ baseUrl, fetch: fetchRun1 });
    const run1 = await uploader1.upload(blob, {
      name: 'partial.bin',
      chunkSize: 1048576,
      concurrency: 1,
      stopAfter: 3
    });

    assert.equal(run1.interrupted, true);
    assert.equal(putCountRun1, 3, 'First run must send exactly 3 chunks');
    assert.ok(run1.uploadId);

    // Run 2: resume sending only remaining chunks
    let putCountRun2 = 0;
    const fetchRun2 = async (url, opts) => {
      if (opts?.method === 'PUT') putCountRun2++;
      return globalThis.fetch(url, opts);
    };

    const uploader2 = createUploader({ baseUrl, fetch: fetchRun2 });
    const run2 = await uploader2.upload(blob, {
      uploadId: run1.uploadId,
      name: 'partial.bin',
      concurrency: 2,
      finalize: true
    });

    assert.equal(run2.interrupted, false);
    // 5.5 MiB with 1 MiB chunk has 6 chunks total; 3 were uploaded, so exactly 3 remain
    assert.equal(putCountRun2, 3, 'Second run must send ONLY the remaining 3 chunks');
    assert.equal(run2.resendEfficiency, 0, 'Resend efficiency must stay 0 on resume without duplicates');
    assert.ok(run2.media);
    assert.equal(run2.media.sha256, expectedSha256);
  });

  await t.test('corruptIndex: exactly one PUT attempt, no retry, in-flight chunks finish, resume completes', async () => {
    const blob = new Blob([fileBuffer]);
    let chunk1PutAttempts = 0;

    const wrappedFetch = async (url, opts) => {
      if (opts?.method === 'PUT' && url.endsWith('/chunks/1')) {
        chunk1PutAttempts++;
      }
      return globalThis.fetch(url, opts);
    };

    const uploader = createUploader({ baseUrl, fetch: wrappedFetch });

    let threwPermanent = false;
    let failedSummary = null;
    try {
      await uploader.upload(blob, {
        name: 'corrupt-test.bin',
        chunkSize: 1048576,
        concurrency: 2,
        corruptIndex: 1
      });
    } catch (err) {
      threwPermanent = true;
      assert.equal(err.statusCode, 422);
      failedSummary = err.summary;
    }

    assert.ok(threwPermanent, 'corruptIndex must cause upload to reject with 422');
    assert.equal(chunk1PutAttempts, 1, 'Corrupted chunk must have exactly 1 PUT attempt and never be retried');
    assert.ok(failedSummary?.uploadId);

    // Resume without corruptIndex completes successfully
    const resumeUploader = createUploader({ baseUrl });
    const resumeSummary = await resumeUploader.upload(blob, {
      uploadId: failedSummary.uploadId,
      name: 'corrupt-test.bin',
      concurrency: 2,
      finalize: true
    });

    assert.equal(resumeSummary.interrupted, false);
    assert.ok(resumeSummary.media);
    assert.equal(resumeSummary.media.sha256, expectedSha256);
  });

  await t.test('Wrapped fetch retries 503 and network error, but never retries 422', async () => {
    const smallBuffer = createSeededBuffer(256 * 1024, 1111);
    const blob = new Blob([smallBuffer]);

    let attempts503 = 0;
    let networkErrorAttempts = 0;

    const testFetch = async (url, opts) => {
      if (opts?.method === 'PUT') {
        if (attempts503 === 0) {
          attempts503++;
          return new Response(JSON.stringify({ error: { code: 'BUSY', message: 'Service Unavailable' } }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (networkErrorAttempts === 0) {
          networkErrorAttempts++;
          throw new TypeError('fetch failed: network socket reset');
        }
      }
      return globalThis.fetch(url, opts);
    };

    const uploader = createUploader({ baseUrl, fetch: testFetch });
    const summary = await uploader.upload(blob, {
      name: 'retry-test.bin',
      chunkSize: 256 * 1024,
      concurrency: 1,
      finalize: true
    });

    assert.equal(attempts503, 1, '503 was returned once');
    assert.equal(networkErrorAttempts, 1, 'Network error was thrown once');
    assert.ok(summary.retries >= 2, 'Total retries should account for 503 and network error');
    assert.ok(summary.media);
  });

  await t.test('interrupt() mid-upload resolves interrupted: true without unhandled rejections, then resume completes', async () => {
    const blob = new Blob([fileBuffer]);
    let unhandledCount = 0;
    const onUnhandled = () => { unhandledCount++; };
    process.on('unhandledRejection', onUnhandled);

    try {
      const slowFetch = async (url, opts) => {
        if (opts?.method === 'PUT') {
          await new Promise((r) => setTimeout(r, 80));
        }
        return globalThis.fetch(url, opts);
      };

      const uploader = createUploader({ baseUrl, fetch: slowFetch });

      const uploadPromise = uploader.upload(blob, {
        name: 'interruptible.bin',
        chunkSize: 1048576,
        concurrency: 2
      });

      // Interrupt shortly after starting
      setTimeout(() => {
        uploader.interrupt();
      }, 40);

      const res = await uploadPromise;
      assert.equal(res.interrupted, true);
      assert.ok(res.uploadId);
      assert.equal(unhandledCount, 0, 'Must have zero unhandled rejections on interrupt');

      // Resume completes successfully
      const normalUploader = createUploader({ baseUrl });
      const resumed = await normalUploader.upload(blob, {
        uploadId: res.uploadId,
        name: 'interruptible.bin',
        concurrency: 2,
        finalize: true
      });

      assert.equal(resumed.interrupted, false);
      assert.ok(resumed.media);
      assert.equal(resumed.media.sha256, expectedSha256);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  await t.test('Unknown uploadId reports session_gone', async () => {
    const blob = new Blob([Buffer.from('hello world')]);
    const uploader = createUploader({ baseUrl });

    let emittedSessionGone = false;
    let thrownCode = null;

    try {
      await uploader.upload(blob, {
        uploadId: '00000000-0000-4000-8000-000000000000',
        onEvent: (evt) => {
          if (evt.type === 'session_gone') emittedSessionGone = true;
        }
      });
    } catch (err) {
      thrownCode = err.code || err.reason;
    }

    assert.ok(emittedSessionGone, 'Must emit session_gone event');
    assert.ok(thrownCode === 'SESSION_GONE' || thrownCode === 'session_gone');
  });

  await t.test('Concurrency 4 never exceeds 4 PUTs in flight and 4 active chunk buffers', async () => {
    const blob = new Blob([fileBuffer]);
    let inFlightPuts = 0;
    let maxInFlightPuts = 0;

    const wrappedFetch = async (url, opts) => {
      if (opts?.method === 'PUT') {
        inFlightPuts++;
        if (inFlightPuts > maxInFlightPuts) maxInFlightPuts = inFlightPuts;
        await new Promise((r) => setTimeout(r, 20));
        try {
          return await globalThis.fetch(url, opts);
        } finally {
          inFlightPuts--;
        }
      }
      return globalThis.fetch(url, opts);
    };

    let aliveBuffers = 0;
    let maxAliveBuffers = 0;

    const uploader = createUploader({
      baseUrl,
      fetch: wrappedFetch,
      onBufferAlloc: () => {
        aliveBuffers++;
        if (aliveBuffers > maxAliveBuffers) maxAliveBuffers = aliveBuffers;
      },
      onBufferRelease: () => {
        aliveBuffers--;
      }
    });

    const summary = await uploader.upload(blob, {
      name: 'concurrency-test.bin',
      chunkSize: 1048576,
      concurrency: 4,
      finalize: true
    });

    assert.equal(summary.interrupted, false);
    assert.ok(summary.media);
    assert.ok(maxInFlightPuts <= 4, `maxInFlightPuts was ${maxInFlightPuts}, must be <= 4`);
    assert.ok(maxAliveBuffers <= 4, `maxAliveBuffers was ${maxAliveBuffers}, must be <= 4`);
  });

  await t.test('A4: maxRetries 2 on continuous 503 results in exactly 3 PUT attempts and retries === 2', async () => {
    const smallBuffer = createSeededBuffer(65536, 777);
    const blob = new Blob([smallBuffer]);

    let putAttempts = 0;
    const always503Fetch = async (url, opts) => {
      if (opts?.method === 'PUT') {
        putAttempts++;
        return new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Busy' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return globalThis.fetch(url, opts);
    };

    const uploader = createUploader({ baseUrl, fetch: always503Fetch, sleep: () => Promise.resolve() });
    let threw = false;
    let failedSummary = null;

    try {
      await uploader.upload(blob, {
        name: 'exhaust-retries.bin',
        chunkSize: 65536,
        maxRetries: 2
      });
    } catch (err) {
      threw = true;
      failedSummary = err.summary;
    }

    assert.ok(threw, 'Upload must throw when retries are exhausted');
    assert.equal(putAttempts, 3, 'Exactly 3 PUT attempts should occur for initial try + 2 retries');
    assert.equal(failedSummary?.retries, 2, 'Summary retries must be exactly 2 (not double-counted)');
  });
});
