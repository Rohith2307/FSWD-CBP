const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createServer } = require('../src/server');
const paths = require('../src/storage/paths');
const { generateFile } = require('../scripts/generate-test-file');
const {
  uploadFile,
  computeFileSha256
} = require('../scripts/simulate-interruption');

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
          const buffer = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(buffer.toString('utf8'));
          } catch {}
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            buffer,
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

test('HTTP media streaming, Range requests, and catalog integration tests', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-streaming-test-'));
  const testFilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-streaming-files-'));

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

  // Generate 5.5 MiB file (5767168 bytes)
  const source55MbSize = 5767168;
  const source55MbPath = path.join(testFilesDir, 'source-5.5mb.bin');
  await generateFile(source55MbSize, source55MbPath, 424242);
  const sourceSha256 = await computeFileSha256(source55MbPath);
  const sourceBuffer = fs.readFileSync(source55MbPath);

  let mediaRecord = null;
  let mediaId = null;
  let largeMediaId = null;
  const large40MbSize = 40 * 1024 * 1024;

  await t.test('start server and ingest 5.5 MiB media file via real upload flow', async () => {
    await app.start(0, '127.0.0.1');
    port = app.server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    const summary = await uploadFile({
      baseUrl,
      filePath: source55MbPath,
      contentType: 'video/mp4',
      chunkSize: 1024 * 1024,
      finalize: true,
      log: () => {}
    });

    assert.equal(summary.state, 'ready');
    const mId = summary.mediaId || summary.media?.mediaId;
    assert.ok(mId);
    mediaRecord = summary;
    mediaId = mId;
  });

  await t.test('GET full representation -> 200, Content-Length 5767168, ETag, SHA matches', async () => {
    const res = await makeRequest(port, {
      path: `/api/media/${mediaId}`,
      method: 'GET'
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-length'], String(source55MbSize));
    assert.equal(res.headers['content-type'], 'video/mp4');
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.headers['etag'], `"${sourceSha256}"`);
    assert.ok(res.headers['last-modified']);
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');

    const bodySha = crypto.createHash('sha256').update(res.buffer).digest('hex');
    assert.equal(bodySha, sourceSha256);
  });

  await t.test('HEAD full representation -> 200, identical headers, 0 body bytes', async () => {
    const res = await makeRequest(port, {
      path: `/api/media/${mediaId}`,
      method: 'HEAD'
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-length'], String(source55MbSize));
    assert.equal(res.headers['content-type'], 'video/mp4');
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.headers['etag'], `"${sourceSha256}"`);
    assert.equal(res.buffer.length, 0, 'HEAD must transmit 0 body bytes');
  });

  await t.test('Range 0-1023 -> 206, Content-Range bytes 0-1023/5767168, 1024 bytes matching source', async () => {
    const res = await makeRequest(port, {
      path: `/api/media/${mediaId}`,
      method: 'GET',
      headers: {
        Range: 'bytes=0-1023'
      }
    });

    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-range'], `bytes 0-1023/${source55MbSize}`);
    assert.equal(res.headers['content-length'], '1024');
    assert.equal(res.buffer.length, 1024);
    assert.ok(res.buffer.equals(sourceBuffer.subarray(0, 1024)));
  });

  await t.test('Range at chunk boundary 1048576-2097151 -> 206, exact chunk 1 bytes', async () => {
    const start = 1048576;
    const end = 2097151;
    const res = await makeRequest(port, {
      path: `/api/media/${mediaId}`,
      method: 'GET',
      headers: {
        Range: `bytes=${start}-${end}`
      }
    });

    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-range'], `bytes ${start}-${end}/${source55MbSize}`);
    assert.equal(res.headers['content-length'], String(end - start + 1));
    assert.ok(res.buffer.equals(sourceBuffer.subarray(start, end + 1)));
  });

  await t.test('Range crossing partial-chunk boundary to final byte (5240000-5767167) -> 206, exact bytes', async () => {
    const start = 5240000;
    const end = source55MbSize - 1;
    const res = await makeRequest(port, {
      path: `/api/media/${mediaId}`,
      method: 'GET',
      headers: {
        Range: `bytes=${start}-${end}`
      }
    });

    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-range'], `bytes ${start}-${end}/${source55MbSize}`);
    assert.equal(res.headers['content-length'], String(end - start + 1));
    assert.ok(res.buffer.equals(sourceBuffer.subarray(start, end + 1)));
  });

  await t.test('Open-ended range "bytes=5767000-" -> 206, exact remaining bytes to end of file', async () => {
    const start = 5767000;
    const end = source55MbSize - 1;
    const res = await makeRequest(port, {
      path: `/api/media/${mediaId}`,
      method: 'GET',
      headers: {
        Range: `bytes=${start}-`
      }
    });

    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-range'], `bytes ${start}-${end}/${source55MbSize}`);
    assert.equal(res.headers['content-length'], String(end - start + 1));
    assert.ok(res.buffer.equals(sourceBuffer.subarray(start, end + 1)));
  });

  await t.test('Suffix range "bytes=-500" -> 206, exact last 500 bytes', async () => {
    const start = source55MbSize - 500;
    const end = source55MbSize - 1;
    const res = await makeRequest(port, {
      path: `/api/media/${mediaId}`,
      method: 'GET',
      headers: {
        Range: 'bytes=-500'
      }
    });

    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-range'], `bytes ${start}-${end}/${source55MbSize}`);
    assert.equal(res.headers['content-length'], '500');
    assert.ok(res.buffer.equals(sourceBuffer.subarray(start, end + 1)));
  });

  await t.test('Clamped end range "bytes=5767000-99999999" -> 206, clamped to file size - 1', async () => {
    const start = 5767000;
    const end = source55MbSize - 1;
    const res = await makeRequest(port, {
      path: `/api/media/${mediaId}`,
      method: 'GET',
      headers: {
        Range: 'bytes=5767000-99999999'
      }
    });

    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-range'], `bytes ${start}-${end}/${source55MbSize}`);
    assert.equal(res.headers['content-length'], String(end - start + 1));
    assert.ok(res.buffer.equals(sourceBuffer.subarray(start, end + 1)));
  });

  await t.test('Single byte range "bytes=0-0" -> 206, 1 byte', async () => {
    const res = await makeRequest(port, {
      path: `/api/media/${mediaId}`,
      method: 'GET',
      headers: {
        Range: 'bytes=0-0'
      }
    });

    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-range'], `bytes 0-0/${source55MbSize}`);
    assert.equal(res.headers['content-length'], '1');
    assert.equal(res.buffer.length, 1);
    assert.equal(res.buffer[0], sourceBuffer[0]);
  });

  await t.test('HEAD with Range -> 206 headers, no body', async () => {
    const res = await makeRequest(port, {
      path: `/api/media/${mediaId}`,
      method: 'HEAD',
      headers: {
        Range: 'bytes=0-1023'
      }
    });

    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-range'], `bytes 0-1023/${source55MbSize}`);
    assert.equal(res.headers['content-length'], '1024');
    assert.equal(res.buffer.length, 0);
  });

  await t.test('Unsatisfiable ranges -> 416 with Content-Range bytes */5767168 and JSON error', async () => {
    for (const range of ['bytes=5767168-', 'bytes=99999999999999999999-']) {
      const res = await makeRequest(port, {
        path: `/api/media/${mediaId}`,
        method: 'GET',
        headers: {
          Range: range
        }
      });

      assert.equal(res.statusCode, 416);
      assert.equal(res.headers['content-range'], `bytes */${source55MbSize}`);
      assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(res.json.error.code, 'RANGE_NOT_SATISFIABLE');
      assert.notEqual(res.buffer.length, source55MbSize);
    }
  });

  await t.test('Malformed ranges -> 400 and body is not the file', async () => {
    for (const range of ['bytes=abc', 'bytes=5-4', 'bytes=']) {
      const res = await makeRequest(port, {
        path: `/api/media/${mediaId}`,
        method: 'GET',
        headers: {
          Range: range
        }
      });

      assert.equal(res.statusCode, 400);
      assert.equal(res.json.error.code, 'BAD_REQUEST');
      assert.notEqual(res.buffer.length, source55MbSize);
    }
  });

  await t.test('Multi-range and unknown unit -> 200 with full file representation', async () => {
    for (const range of ['bytes=0-1,5-6', 'items=0-5']) {
      const res = await makeRequest(port, {
        path: `/api/media/${mediaId}`,
        method: 'GET',
        headers: {
          Range: range
        }
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-length'], String(source55MbSize));
      const bodySha = crypto.createHash('sha256').update(res.buffer).digest('hex');
      assert.equal(bodySha, sourceSha256);
    }
  });

  await t.test('If-Range conditional: matching ETag -> 206, non-matching -> 200 full', async () => {
    // Matching ETag -> 206
    const resMatching = await makeRequest(port, {
      path: `/api/media/${mediaId}`,
      method: 'GET',
      headers: {
        Range: 'bytes=0-1023',
        'If-Range': `"${sourceSha256}"`
      }
    });
    assert.equal(resMatching.statusCode, 206);
    assert.equal(resMatching.headers['content-range'], `bytes 0-1023/${source55MbSize}`);

    // Non-matching ETag -> 200 full representation
    const resMismatch = await makeRequest(port, {
      path: `/api/media/${mediaId}`,
      method: 'GET',
      headers: {
        Range: 'bytes=0-1023',
        'If-Range': '"0000000000000000000000000000000000000000000000000000000000000000"'
      }
    });
    assert.equal(resMismatch.statusCode, 200);
    assert.equal(resMismatch.headers['content-length'], String(source55MbSize));
    assert.equal(resMismatch.headers['content-range'], undefined);
  });

  await t.test('If-None-Match conditional: matching ETag or "*" -> 304, different -> 200', async () => {
    // Exact ETag -> 304
    const resEtag = await makeRequest(port, {
      path: `/api/media/${mediaId}`,
      method: 'GET',
      headers: {
        'If-None-Match': `"${sourceSha256}"`
      }
    });
    assert.equal(resEtag.statusCode, 304);
    assert.equal(resEtag.buffer.length, 0);

    // "*" -> 304
    const resStar = await makeRequest(port, {
      path: `/api/media/${mediaId}`,
      method: 'GET',
      headers: {
        'If-None-Match': '*'
      }
    });
    assert.equal(resStar.statusCode, 304);
    assert.equal(resStar.buffer.length, 0);

    // Different ETag -> 200
    const resDiff = await makeRequest(port, {
      path: `/api/media/${mediaId}`,
      method: 'GET',
      headers: {
        'If-None-Match': '"other-etag"'
      }
    });
    assert.equal(resDiff.statusCode, 200);
    assert.equal(resDiff.headers['content-length'], String(source55MbSize));
  });

  await t.test('Content-Disposition sanitization with tricky filenames and ?download=1', async () => {
    // Ingest a second file with quotes, backslash, and non-ASCII in originalName
    const trickyPath = path.join(testFilesDir, 'tricky.mp4');
    await fs.promises.writeFile(trickyPath, Buffer.alloc(1024, 0xaa));

    const trickySummary = await uploadFile({
      baseUrl,
      filePath: trickyPath,
      filename: 'my "vid" é\\x.mp4',
      contentType: 'video/mp4',
      chunkSize: 1024 * 1024,
      finalize: true,
      log: () => {}
    });

    const trickyId = trickySummary.mediaId;

    // Normal GET: inline disposition
    const resInline = await makeRequest(port, {
      path: `/api/media/${trickyId}`,
      method: 'GET'
    });
    assert.equal(resInline.statusCode, 200);
    const dispInline = resInline.headers['content-disposition'];
    assert.ok(dispInline.startsWith('inline; filename='));
    assert.ok(!dispInline.includes('\n') && !dispInline.includes('\r'));
    // ASCII fallback must not contain raw unescaped quotes or non-ASCII inside filename="..."
    const asciiPart = dispInline.split(';')[1].trim();
    assert.ok(!asciiPart.includes('é'), 'ASCII fallback must replace non-ASCII characters');

    // filename* must decode to sanitized name
    const starPart = dispInline.split(';')[2].trim();
    assert.ok(starPart.startsWith("filename*=UTF-8''"));
    const encodedVal = starPart.slice("filename*=UTF-8''".length);
    const decodedName = decodeURIComponent(encodedVal);
    assert.ok(decodedName.includes('my "vid"'));

    // Forced download (?download=1): attachment disposition
    const resAttachment = await makeRequest(port, {
      path: `/api/media/${trickyId}?download=1`,
      method: 'GET'
    });
    assert.equal(resAttachment.statusCode, 200);
    const dispAttachment = resAttachment.headers['content-disposition'];
    assert.ok(dispAttachment.startsWith('attachment; filename='));
  });

  await t.test('GET /api/media catalog listing: sorted newest first, pagination & error handling', async () => {
    // List media
    const listRes = await makeRequest(port, {
      path: '/api/media',
      method: 'GET'
    });
    assert.equal(listRes.statusCode, 200);
    assert.ok(Array.isArray(listRes.json.items));
    assert.ok(listRes.json.count >= 2);
    // Newest first
    const items = listRes.json.items;
    const t0 = new Date(items[0].createdAt).getTime();
    const t1 = new Date(items[1].createdAt).getTime();
    assert.ok(t0 >= t1, 'Items must be sorted by createdAt DESC');

    // ?limit=1
    const pagedRes = await makeRequest(port, {
      path: '/api/media?limit=1',
      method: 'GET'
    });
    assert.equal(pagedRes.statusCode, 200);
    assert.equal(pagedRes.json.items.length, 1);
    assert.equal(pagedRes.json.count, 1);

    // Invalid limits -> 400
    for (const badLimit of ['0', 'abc', '-5', '9999']) {
      const errRes = await makeRequest(port, {
        path: `/api/media?limit=${badLimit}`,
        method: 'GET'
      });
      assert.equal(errRes.statusCode, 400);
      assert.equal(errRes.json.error.code, 'BAD_REQUEST');
    }

    // Corrupt media json is skipped and does not crash listing
    const corruptId = crypto.randomUUID();
    const corruptPath = paths.mediaMetaPath(corruptId, tmpRoot);
    fs.writeFileSync(corruptPath, '{ corrupt json !!!');

    // Orphan json (media file deleted) is skipped
    const orphanId = crypto.randomUUID();
    const orphanRecord = {
      mediaId: orphanId,
      uploadId: crypto.randomUUID(),
      originalName: 'orphan.mp4',
      storedFile: `${orphanId}.mp4`,
      contentType: 'video/mp4',
      size: 1024,
      sha256: '0'.repeat(64),
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(paths.mediaMetaPath(orphanId, tmpRoot), JSON.stringify(orphanRecord));

    const listResWithCorrupt = await makeRequest(port, {
      path: '/api/media',
      method: 'GET'
    });
    assert.equal(listResWithCorrupt.statusCode, 200);
    const itemIds = listResWithCorrupt.json.items.map((i) => i.mediaId);
    assert.ok(!itemIds.includes(corruptId), 'Corrupt JSON should be skipped');
    assert.ok(!itemIds.includes(orphanId), 'Orphan JSON should be skipped');

    // Clean up test files
    fs.unlinkSync(corruptPath);
    fs.unlinkSync(paths.mediaMetaPath(orphanId, tmpRoot));
  });

  await t.test('Unknown / invalid media IDs and missing media files -> 404', async () => {
    // Unknown valid UUID -> 404
    const unknownId = crypto.randomUUID();
    const resUnknown = await makeRequest(port, {
      path: `/api/media/${unknownId}`,
      method: 'GET'
    });
    assert.equal(resUnknown.statusCode, 404);
    assert.equal(resUnknown.json.error.code, 'NOT_FOUND');

    // Malformed ID -> 404
    const resInvalid = await makeRequest(port, {
      path: '/api/media/invalid--id',
      method: 'GET'
    });
    assert.equal(resInvalid.statusCode, 404);
    assert.equal(resInvalid.json.error.code, 'NOT_FOUND');

    // Media file deleted but JSON present -> 404 on GET
    const ghostId = crypto.randomUUID();
    const ghostRecord = {
      mediaId: ghostId,
      uploadId: crypto.randomUUID(),
      originalName: 'ghost.mp4',
      storedFile: `${ghostId}.mp4`,
      contentType: 'video/mp4',
      size: 1024,
      sha256: '0'.repeat(64),
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(paths.mediaMetaPath(ghostId, tmpRoot), JSON.stringify(ghostRecord));

    const resGhost = await makeRequest(port, {
      path: `/api/media/${ghostId}`,
      method: 'GET'
    });
    assert.equal(resGhost.statusCode, 404);
    assert.equal(resGhost.json.error.code, 'NOT_FOUND');

    fs.unlinkSync(paths.mediaMetaPath(ghostId, tmpRoot));
  });

  await t.test('Media file truncated on disk -> 500 without path leak', async () => {
    // Create and upload small test media
    const truncPath = path.join(testFilesDir, 'trunc.mp4');
    await fs.promises.writeFile(truncPath, Buffer.alloc(2048, 0xbb));

    const truncSummary = await uploadFile({
      baseUrl,
      filePath: truncPath,
      contentType: 'video/mp4',
      chunkSize: 1024 * 1024,
      finalize: true,
      log: () => {}
    });
    const truncId = truncSummary.mediaId;

    // Truncate the file on disk
    const diskPath = paths.mediaPath(truncId, 'mp4', tmpRoot);
    fs.truncateSync(diskPath, 500);

    const res = await makeRequest(port, {
      path: `/api/media/${truncId}`,
      method: 'GET'
    });

    assert.equal(res.statusCode, 500);
    assert.equal(res.json.error.code, 'INTERNAL_SERVER_ERROR');
    assert.ok(!res.json.error.message.includes(tmpRoot), 'Error message must not leak storage path');
  });

  await t.test('Client abort mid-download: stream closes cleanly without server crash', async () => {
    let uncaughtObserved = false;
    const onUncaught = () => {
      uncaughtObserved = true;
    };
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);

    await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: `/api/media/${mediaId}`,
          method: 'GET'
        },
        (res) => {
          res.once('data', () => {
            // Abort client socket after first data packet
            req.destroy();
            resolve();
          });
        }
      );
      req.on('error', () => {
        // Expected client abort error
      });
      req.end();
    });

    // Wait 200ms to allow server cleanup to run
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify server remains completely healthy and handles subsequent full download correctly
    const healthRes = await makeRequest(port, { path: '/health', method: 'GET' });
    assert.equal(healthRes.statusCode, 200);

    const retryRes = await makeRequest(port, {
      path: `/api/media/${mediaId}`,
      method: 'GET'
    });
    assert.equal(retryRes.statusCode, 200);
    const bodySha = crypto.createHash('sha256').update(retryRes.buffer).digest('hex');
    assert.equal(bodySha, sourceSha256);

    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onUncaught);
    assert.equal(uncaughtObserved, false, 'No uncaught exceptions should occur on client abort');
  });

  await t.test('Concurrency: 8 parallel range requests with different ranges all return exact bytes', async () => {
    const ranges = [
      [0, 100],
      [101, 500],
      [501, 1000],
      [1000000, 1000500],
      [2000000, 2005000],
      [3000000, 3000005],
      [4000000, 4001000],
      [5000000, source55MbSize - 1]
    ];

    const requests = ranges.map(([start, end]) =>
      makeRequest(port, {
        path: `/api/media/${mediaId}`,
        method: 'GET',
        headers: {
          Range: `bytes=${start}-${end}`
        }
      }).then((res) => {
        assert.equal(res.statusCode, 206);
        assert.equal(res.headers['content-range'], `bytes ${start}-${end}/${source55MbSize}`);
        assert.equal(res.headers['content-length'], String(end - start + 1));
        assert.ok(
          res.buffer.equals(sourceBuffer.subarray(start, end + 1)),
          `Byte mismatch in range ${start}-${end}`
        );
      })
    );

    await Promise.all(requests);
  });

  await t.test(
    'Streaming not buffering: 40 MiB download samples RSS every 20ms and stays bounded',
    async () => {
      const large40MbSize = 40 * 1024 * 1024;
      const large40MbPath = path.join(testFilesDir, 'large-40mb.bin');
      await generateFile(large40MbSize, large40MbPath, 987654);
      const largeExpectedSha = await computeFileSha256(large40MbPath);

      const largeSummary = await uploadFile({
        baseUrl,
        filePath: large40MbPath,
        contentType: 'video/mp4',
        chunkSize: 4 * 1024 * 1024,
        finalize: true,
        log: () => {}
      });
      largeMediaId = largeSummary.mediaId || largeSummary.media?.mediaId;
      assert.ok(largeMediaId, '40 MiB upload must be finalized and return a mediaId');

      // Force GC if available or establish pre-download RSS baseline
      if (global.gc) {
        global.gc();
      }
      const baselineRss = process.memoryUsage().rss;
      let maxRssSeen = baselineRss;

      const sampleTimer = setInterval(() => {
        const curRss = process.memoryUsage().rss;
        if (curRss > maxRssSeen) {
          maxRssSeen = curRss;
        }
      }, 20);

      const downloadSha = await new Promise((resolve, reject) => {
        const hasher = crypto.createHash('sha256');
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: `/api/media/${largeMediaId}`,
            method: 'GET'
          },
          (res) => {
            if (res.statusCode !== 200) {
              reject(new Error(`Unexpected status ${res.statusCode}`));
              return;
            }
            res.on('data', (chunk) => {
              hasher.update(chunk);
            });
            res.on('end', () => {
              resolve(hasher.digest('hex'));
            });
          }
        );
        req.on('error', reject);
        req.end();
      });

      clearInterval(sampleTimer);

      assert.equal(downloadSha, largeExpectedSha, 'Downloaded 40 MiB stream SHA must match source');

      const rssGrowth = maxRssSeen - baselineRss;
      // Growth during 40 MiB download should stay strictly under 30 MiB of baseline
      // (buffer streams use 64 KiB chunks with backpressure, never buffering entire file)
      assert.ok(
        rssGrowth < 30 * 1024 * 1024,
        `RSS growth during 40 MiB download was ${(rssGrowth / 1024 / 1024).toFixed(2)} MiB, exceeding bounded threshold`
      );
    }
  );

  await t.test('A1: onServed hook records accurate bytesSent, abort status, and methods', async () => {
    const servedEvents = [];
    const hookServer = createServer({
      port: 0,
      storageRoot: tmpRoot,
      onServed: (info) => {
        servedEvents.push(info);
      }
    });

    await hookServer.start(0, '127.0.0.1');
    const hPort = hookServer.server.address().port;

    try {
      // 1. Completed full GET
      servedEvents.length = 0;
      const resFull = await makeRequest(hPort, { path: `/api/media/${mediaId}`, method: 'GET' });
      assert.equal(resFull.statusCode, 200);
      assert.equal(servedEvents.length, 1);
      assert.equal(servedEvents[0].aborted, false);
      assert.equal(servedEvents[0].bytesSent, source55MbSize);
      assert.equal(servedEvents[0].method, 'GET');

      // 2. Completed 206 range
      servedEvents.length = 0;
      const res206 = await makeRequest(hPort, {
        path: `/api/media/${mediaId}`,
        method: 'GET',
        headers: { Range: 'bytes=0-1023' }
      });
      assert.equal(res206.statusCode, 206);
      assert.equal(servedEvents.length, 1);
      assert.equal(servedEvents[0].aborted, false);
      assert.equal(servedEvents[0].bytesSent, 1024);
      assert.equal(servedEvents[0].rangeStart, 0);
      assert.equal(servedEvents[0].rangeEnd, 1023);
      assert.equal(servedEvents[0].method, 'GET');

      // 3. Client socket destroyed mid-download of 40 MiB file
      servedEvents.length = 0;
      await new Promise((resolve) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: hPort,
            path: `/api/media/${largeMediaId}`,
            method: 'GET'
          },
          (res) => {
            res.once('data', () => {
              req.destroy();
              resolve();
            });
          }
        );
        req.on('error', () => {});
        req.end();
      });

      // Wait for server to process socket closure
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(servedEvents.length, 1);
      assert.equal(servedEvents[0].aborted, true);
      assert.ok(
        servedEvents[0].bytesSent < large40MbSize,
        `bytesSent (${servedEvents[0].bytesSent}) must be strictly less than 40 MiB on abort`
      );
      assert.equal(servedEvents[0].method, 'GET');

      // 4. HEAD request
      servedEvents.length = 0;
      const resHead = await makeRequest(hPort, { path: `/api/media/${mediaId}`, method: 'HEAD' });
      assert.equal(resHead.statusCode, 200);
      assert.equal(servedEvents.length, 1);
      assert.equal(servedEvents[0].bytesSent, 0);
      assert.equal(servedEvents[0].aborted, false);
      assert.equal(servedEvents[0].method, 'HEAD');

      // 5. 304 Not Modified
      servedEvents.length = 0;
      const res304 = await makeRequest(hPort, {
        path: `/api/media/${mediaId}`,
        method: 'GET',
        headers: { 'If-None-Match': `"${sourceSha256}"` }
      });
      assert.equal(res304.statusCode, 304);
      assert.equal(servedEvents.length, 1);
      assert.equal(servedEvents[0].bytesSent, 0);
      assert.equal(servedEvents[0].aborted, false);
      assert.equal(servedEvents[0].method, 'GET');
    } finally {
      await hookServer.stop();
    }
  });

  await t.test('clean up server and temporary files', async () => {
    await app.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(testFilesDir, { recursive: true, force: true });
  });
});
