const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createServer } = require('../src/server');
const paths = require('../src/storage/paths');
const { readMetadata, writeMetadata, updateMetadata } = require('../src/storage/metadataStore');
const { generateFile } = require('../scripts/generate-test-file');
const {
  uploadFile,
  computeFileSha256,
  finalizeSession
} = require('../scripts/simulate-interruption');
const { _activeFinalizations } = require('../src/services/finalizer');

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

async function compareStreams(pathA, pathB) {
  const statA = await fs.promises.stat(pathA);
  const statB = await fs.promises.stat(pathB);
  if (statA.size !== statB.size) return false;

  const sA = fs.createReadStream(pathA);
  const sB = fs.createReadStream(pathB);
  const itA = sA[Symbol.asyncIterator]();
  const itB = sB[Symbol.asyncIterator]();

  let bufA = Buffer.alloc(0);
  let bufB = Buffer.alloc(0);

  while (true) {
    if (bufA.length === 0) {
      const nextA = await itA.next();
      if (!nextA.done) bufA = nextA.value;
    }
    if (bufB.length === 0) {
      const nextB = await itB.next();
      if (!nextB.done) bufB = nextB.value;
    }

    if (bufA.length === 0 && bufB.length === 0) break;
    if (bufA.length === 0 || bufB.length === 0) return false;

    const minLen = Math.min(bufA.length, bufB.length);
    if (!bufA.subarray(0, minLen).equals(bufB.subarray(0, minLen))) {
      return false;
    }
    bufA = bufA.subarray(minLen);
    bufB = bufB.subarray(minLen);
  }
  return true;
}

test('Finalization engine integration tests', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-finalize-test-'));
  const testFilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-test-files-'));

  const app = createServer({
    port: 0,
    storageRoot: tmpRoot,
    defaultChunkBytes: 1024 * 1024,
    minChunkBytes: 64 * 1024,
    maxChunkBytes: 16 * 1024 * 1024
  });

  let port;
  let baseUrl;

  // Generate 5.5 MiB test file (5767168 bytes, 6 chunks: 5 of 1 MiB + 1 of 512 KiB)
  const source55MbPath = path.join(testFilesDir, 'source-5.5mb.bin');
  const generated55 = await generateFile(5767168, source55MbPath, 'seed-finalize-55');

  await t.test('start server', async () => {
    await app.start(0, '127.0.0.1');
    port = app.server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  let happyUploadId;
  let happyMediaRecord;

  await t.test(
    'Happy path: upload ~5.5 MiB, finalize with whole-file sha256 -> 200 and published media',
    async () => {
      // 1. Upload all chunks using simulate-interruption client
      const summary = await uploadFile({
        baseUrl,
        filePath: source55MbPath,
        contentType: 'video/mp4',
        chunkSize: 1024 * 1024,
        log: () => {}
      });
      assert.equal(summary.progressPercent, 100);
      assert.equal(summary.interrupted, false);
      happyUploadId = summary.uploadId;

      // 2. Finalize with correct whole-file sha256
      const finPayload = JSON.stringify({ sha256: generated55.sha256 });
      const finRes = await makeRequest(
        port,
        {
          path: `/api/uploads/${happyUploadId}/finalize`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(finPayload)
          }
        },
        finPayload
      );

      assert.equal(finRes.statusCode, 200);
      assert.equal(finRes.json.state, 'ready');
      assert.equal(finRes.json.size, 5767168);
      assert.equal(finRes.json.sha256, generated55.sha256);
      assert.equal(finRes.json.uploadId, happyUploadId);
      assert.ok(finRes.json.mediaId);
      assert.equal(finRes.json.downloadUrl, `/api/media/${finRes.json.mediaId}`);
      assert.equal(finRes.json.stats.chunks, 6);
      assert.equal(finRes.json.stats.verifiedChunks, 6);
      happyMediaRecord = finRes.json;

      // 3. Verify media file exists in storage/media
      const mediaFilePath = paths.mediaPath(finRes.json.mediaId, 'mp4', tmpRoot);
      assert.ok(fs.existsSync(mediaFilePath), 'Media file must exist on disk');
      assert.equal(fs.statSync(mediaFilePath).size, 5767168);

      // Verify SHA-256 and byte-for-byte identity by streaming
      const mediaSha = await computeFileSha256(mediaFilePath);
      assert.equal(mediaSha, generated55.sha256);
      const isIdentical = await compareStreams(source55MbPath, mediaFilePath);
      assert.ok(isIdentical, 'Assembled media must be byte-for-byte identical to source file');

      // 4. Verify media JSON metadata exists with expected schema
      const mediaMetaPath = paths.mediaMetaPath(finRes.json.mediaId, tmpRoot);
      assert.ok(fs.existsSync(mediaMetaPath), 'Media JSON file must exist on disk');
      const mediaMeta = JSON.parse(fs.readFileSync(mediaMetaPath, 'utf8'));
      assert.equal(mediaMeta.mediaId, finRes.json.mediaId);
      assert.equal(mediaMeta.uploadId, happyUploadId);
      assert.equal(mediaMeta.sha256, generated55.sha256);
      assert.equal(mediaMeta.contentType, 'video/mp4');
      assert.equal(mediaMeta.size, 5767168);
      assert.equal(mediaMeta.storedFile, `${finRes.json.mediaId}.mp4`);

      // 5. Verify upload metadata updated to state 'ready' with mediaId and cleared lastFinalizeError
      const uploadMeta = await readMetadata(happyUploadId, tmpRoot);
      assert.equal(uploadMeta.state, 'ready');
      assert.equal(uploadMeta.mediaId, finRes.json.mediaId);
      assert.equal(uploadMeta.finalSha256, generated55.sha256);
      assert.equal(uploadMeta.lastFinalizeError, null);

      // 6. Verify chunk files deleted from storage/uploads/<id>/chunks
      const chunksDir = paths.chunksDir(happyUploadId, tmpRoot);
      const chunkFiles = fs.readdirSync(chunksDir);
      assert.equal(chunkFiles.filter((f) => f.endsWith('.part')).length, 0);

      // 7. Verify storage/temp is empty
      const tempFiles = fs.readdirSync(paths.tempDir(tmpRoot));
      assert.deepEqual(tempFiles, [], 'storage/temp must be empty');
    }
  );

  await t.test(
    'Finalize twice -> second returns 200 with the SAME mediaId, and storage/media contains exactly one media file',
    async () => {
      // Re-finalize already ready upload
      const finRes = await makeRequest(
        port,
        {
          path: `/api/uploads/${happyUploadId}/finalize`,
          method: 'POST'
        }
      );
      assert.equal(finRes.statusCode, 200);
      assert.equal(finRes.json.mediaId, happyMediaRecord.mediaId);

      // Ensure storage/media contains only 1 media binary and 1 json
      const mediaDir = paths.mediaDir(tmpRoot);
      const mediaFiles = fs.readdirSync(mediaDir);
      assert.equal(mediaFiles.filter((f) => f.endsWith('.mp4')).length, 1);
      assert.equal(mediaFiles.filter((f) => f.endsWith('.json')).length, 1);
    }
  );

  await t.test(
    'Finalize without a body (no sha256) works on fresh complete upload',
    async () => {
      const summary = await uploadFile({
        baseUrl,
        filePath: source55MbPath,
        contentType: 'application/octet-stream',
        chunkSize: 1024 * 1024,
        log: () => {}
      });
      assert.equal(summary.progressPercent, 100);

      const finRes = await makeRequest(
        port,
        {
          path: `/api/uploads/${summary.uploadId}/finalize`,
          method: 'POST'
        }
      );
      assert.equal(finRes.statusCode, 200);
      assert.equal(finRes.json.state, 'ready');
      assert.equal(finRes.json.sha256, generated55.sha256);
    }
  );

  await t.test(
    'Gap: upload 4 of 6 chunks, finalize -> 409 INCOMPLETE_UPLOAD with correct missingChunks and missingRanges',
    async () => {
      const summary = await uploadFile({
        baseUrl,
        filePath: source55MbPath,
        contentType: 'video/mp4',
        chunkSize: 1024 * 1024,
        stopAfter: 4,
        log: () => {}
      });
      assert.equal(summary.interrupted, true);

      const finRes = await makeRequest(
        port,
        {
          path: `/api/uploads/${summary.uploadId}/finalize`,
          method: 'POST'
        }
      );
      assert.equal(finRes.statusCode, 409);
      assert.equal(finRes.json.error.code, 'INCOMPLETE_UPLOAD');
      assert.deepEqual(finRes.json.error.details.missingChunks, [4, 5]);
      assert.deepEqual(finRes.json.error.details.missingRanges, [
        { start: 4194304, end: 5767167 }
      ]);

      const meta = await readMetadata(summary.uploadId, tmpRoot);
      assert.equal(meta.state, 'uploading');
    }
  );

  await t.test(
    'Tampered ledger: duplicate index record -> 409 LEDGER_INVALID, record with wrong end -> 409 LEDGER_INVALID',
    async () => {
      const summary = await uploadFile({
        baseUrl,
        filePath: source55MbPath,
        contentType: 'video/mp4',
        chunkSize: 1024 * 1024,
        log: () => {}
      });

      // 1. Inject duplicate index into metadata
      await updateMetadata(summary.uploadId, tmpRoot, (draft) => {
        draft.chunks.push({ ...draft.chunks[0] });
        return draft;
      });

      const resDup = await makeRequest(
        port,
        { path: `/api/uploads/${summary.uploadId}/finalize`, method: 'POST' }
      );
      assert.equal(resDup.statusCode, 409);
      assert.equal(resDup.json.error.code, 'LEDGER_INVALID');
      assert.ok(resDup.json.error.details.problems.some((p) => p.includes('Duplicate chunk index')));

      // 2. Fix duplicate, but corrupt a chunk record end position
      await updateMetadata(summary.uploadId, tmpRoot, (draft) => {
        draft.chunks.pop(); // remove duplicate
        draft.chunks[0].end = draft.chunks[0].end - 10;
        return draft;
      });

      const resEnd = await makeRequest(
        port,
        { path: `/api/uploads/${summary.uploadId}/finalize`, method: 'POST' }
      );
      assert.equal(resEnd.statusCode, 409);
      assert.equal(resEnd.json.error.code, 'LEDGER_INVALID');
      assert.ok(resEnd.json.error.details.problems.some((p) => p.includes('range mismatch')));
    }
  );

  await t.test(
    'Wrong client sha256 -> 422 FILE_CHECKSUM_MISMATCH; retry without sha succeeds',
    async () => {
      const summary = await uploadFile({
        baseUrl,
        filePath: source55MbPath,
        contentType: 'video/mp4',
        chunkSize: 1024 * 1024,
        log: () => {}
      });

      const wrongSha = 'a'.repeat(64);
      const payload = JSON.stringify({ sha256: wrongSha });
      const res = await makeRequest(
        port,
        {
          path: `/api/uploads/${summary.uploadId}/finalize`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        },
        payload
      );

      assert.equal(res.statusCode, 422);
      assert.equal(res.json.error.code, 'FILE_CHECKSUM_MISMATCH');
      assert.equal(res.json.error.details.expected, wrongSha);
      assert.equal(res.json.error.details.actual, generated55.sha256);

      // Verify temp is empty and chunks remain intact
      const tempFiles = fs.readdirSync(paths.tempDir(tmpRoot));
      assert.deepEqual(tempFiles, []);

      const meta = await readMetadata(summary.uploadId, tmpRoot);
      assert.equal(meta.state, 'uploading');
      assert.equal(meta.chunks.length, 6);

      // Retry without sha succeeds
      const retryRes = await makeRequest(
        port,
        { path: `/api/uploads/${summary.uploadId}/finalize`, method: 'POST' }
      );
      assert.equal(retryRes.statusCode, 200);
      assert.equal(retryRes.json.state, 'ready');
    }
  );

  await t.test('Malformed sha256 in body -> 400 Bad Request', async () => {
    const summary = await uploadFile({
      baseUrl,
      filePath: source55MbPath,
      contentType: 'video/mp4',
      chunkSize: 1024 * 1024,
      log: () => {}
    });

    const payload = JSON.stringify({ sha256: 'not-64-hex' });
    const res = await makeRequest(
      port,
      {
        path: `/api/uploads/${summary.uploadId}/finalize`,
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

  await t.test(
    'Damaged files: delete one chunk file and truncate another, finalize -> 409 CHUNKS_DAMAGED listing both; ledger removes them; resume re-sends both; finalize succeeds',
    async () => {
      const summary = await uploadFile({
        baseUrl,
        filePath: source55MbPath,
        contentType: 'video/mp4',
        chunkSize: 1024 * 1024,
        log: () => {}
      });
      const uploadId = summary.uploadId;

      // Delete chunk 1
      fs.unlinkSync(paths.chunkPath(uploadId, 1, tmpRoot));
      // Truncate chunk 3
      fs.truncateSync(paths.chunkPath(uploadId, 3, tmpRoot), 100);

      const finRes = await makeRequest(
        port,
        { path: `/api/uploads/${uploadId}/finalize`, method: 'POST' }
      );
      assert.equal(finRes.statusCode, 409);
      assert.equal(finRes.json.error.code, 'CHUNKS_DAMAGED');
      assert.deepEqual(finRes.json.error.details.indices.sort(), [1, 3]);

      // Ledger has removed records for chunk 1 and 3
      const meta = await readMetadata(uploadId, tmpRoot);
      assert.equal(meta.state, 'uploading');
      const committedIndices = meta.chunks.map((c) => c.index);
      assert.ok(!committedIndices.includes(1));
      assert.ok(!committedIndices.includes(3));

      // Resume via uploadFile re-sends exactly those 2 chunks
      const resumeSummary = await uploadFile({
        baseUrl,
        filePath: source55MbPath,
        uploadId,
        chunkSize: 1024 * 1024,
        log: () => {}
      });
      assert.equal(resumeSummary.chunksSentThisRun, 2);
      assert.equal(resumeSummary.progressPercent, 100);

      // Finalize now succeeds
      const finRes2 = await makeRequest(
        port,
        { path: `/api/uploads/${uploadId}/finalize`, method: 'POST' }
      );
      assert.equal(finRes2.statusCode, 200);
      assert.equal(finRes2.json.state, 'ready');
      const mediaPath = paths.mediaPath(finRes2.json.mediaId, 'mp4', tmpRoot);
      assert.equal(await computeFileSha256(mediaPath), generated55.sha256);
    }
  );

  await t.test(
    'Silent corruption: flip one byte inside a chunk file -> 422 CHUNK_CORRUPT; chunk removed from ledger; resume re-sends; finalize succeeds',
    async () => {
      const summary = await uploadFile({
        baseUrl,
        filePath: source55MbPath,
        contentType: 'video/mp4',
        chunkSize: 1024 * 1024,
        log: () => {}
      });
      const uploadId = summary.uploadId;

      // Corrupt chunk 2 by flipping a byte at offset 50 without altering size
      const chunk2Path = paths.chunkPath(uploadId, 2, tmpRoot);
      const fd = fs.openSync(chunk2Path, 'r+');
      const singleByte = Buffer.alloc(1);
      fs.readSync(fd, singleByte, 0, 1, 50);
      singleByte[0] = singleByte[0] ^ 0xff;
      fs.writeSync(fd, singleByte, 0, 1, 50);
      fs.closeSync(fd);

      const finRes = await makeRequest(
        port,
        { path: `/api/uploads/${uploadId}/finalize`, method: 'POST' }
      );
      assert.equal(finRes.statusCode, 422);
      assert.equal(finRes.json.error.code, 'CHUNK_CORRUPT');
      assert.equal(finRes.json.error.details.index, 2);

      // Verify assembly temp deleted
      const tempFiles = fs.readdirSync(paths.tempDir(tmpRoot));
      assert.deepEqual(tempFiles, []);

      // Chunk 2 is removed from ledger
      const meta = await readMetadata(uploadId, tmpRoot);
      assert.equal(meta.state, 'uploading');
      assert.ok(!meta.chunks.some((c) => c.index === 2));

      // Resume re-sends just chunk 2
      const resumeSummary = await uploadFile({
        baseUrl,
        filePath: source55MbPath,
        uploadId,
        chunkSize: 1024 * 1024,
        log: () => {}
      });
      assert.equal(resumeSummary.chunksSentThisRun, 1);

      // Finalize succeeds
      const finRes2 = await makeRequest(
        port,
        { path: `/api/uploads/${uploadId}/finalize`, method: 'POST' }
      );
      assert.equal(finRes2.statusCode, 200);
      assert.equal(finRes2.json.state, 'ready');
    }
  );

  await t.test(
    'A1: 5 concurrent finalize requests repeated 5 times -> outcomes only 200 or 409 FINALIZE_IN_PROGRESS, exactly one media file & json, temp empty, _activeFinalizations empty',
    async () => {
      for (let iteration = 0; iteration < 5; iteration++) {
        const iterSummary = await uploadFile({
          baseUrl,
          filePath: source55MbPath,
          contentType: 'video/mp4',
          chunkSize: 1024 * 1024,
          log: () => {}
        });
        const uploadId = iterSummary.uploadId;

        const callFinalize = () =>
          makeRequest(
            port,
            { path: `/api/uploads/${uploadId}/finalize`, method: 'POST' }
          );

        // Fire 5 concurrent finalize requests
        const results = await Promise.all([
          callFinalize(),
          callFinalize(),
          callFinalize(),
          callFinalize(),
          callFinalize()
        ]);

        let sharedMediaId = null;
        for (const res of results) {
          assert.ok(
            res.statusCode === 200 || res.statusCode === 409,
            `Unexpected statusCode ${res.statusCode} for concurrent finalize request`
          );
          if (res.statusCode === 200) {
            assert.equal(res.json.state, 'ready');
            assert.ok(res.json.mediaId);
            if (sharedMediaId === null) {
              sharedMediaId = res.json.mediaId;
            } else {
              assert.equal(
                res.json.mediaId,
                sharedMediaId,
                'Concurrent 200 responses must carry identical mediaId'
              );
            }
          } else {
            assert.equal(res.json.error.code, 'FINALIZE_IN_PROGRESS');
          }
        }

        assert.ok(sharedMediaId, 'At least one finalize request must succeed with 200');

        // Check media directory: contains exactly one media file and one media json for this upload
        const mediaFilePath = paths.mediaPath(sharedMediaId, 'mp4', tmpRoot);
        const mediaMetaFilePath = paths.mediaMetaPath(sharedMediaId, tmpRoot);
        assert.ok(fs.existsSync(mediaFilePath), 'Published media file must exist on disk');
        assert.ok(fs.existsSync(mediaMetaFilePath), 'Published media metadata json must exist on disk');

        // storage/temp must be empty
        const tempDir = paths.tempDir(tmpRoot);
        const tempFiles = fs.readdirSync(tempDir);
        assert.deepEqual(tempFiles, [], 'storage/temp must be empty after finalize');

        // _activeFinalizations size is 0 afterwards
        assert.equal(_activeFinalizations.size, 0, '_activeFinalizations size must be 0 afterwards');
      }
    }
  );

  await t.test('Chunk PUT after ready -> 409, and during finalizing -> 409', async () => {
    // 1. Chunk PUT after ready
    const putRes = await makeRequest(
      port,
      {
        path: `/api/uploads/${happyUploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': 1024 * 1024,
          'Content-Range': `bytes 0-${1024 * 1024 - 1}/5767168`,
          'X-Chunk-SHA256': '0'.repeat(64)
        }
      },
      Buffer.alloc(1024 * 1024)
    );
    assert.equal(putRes.statusCode, 409);
    assert.match(putRes.json.error.message, /in state "ready"/);

    // 2. Simulate state "finalizing" on disk and PUT a chunk -> 409
    const summary = await uploadFile({
      baseUrl,
      filePath: source55MbPath,
      contentType: 'video/mp4',
      chunkSize: 1024 * 1024,
      stopAfter: 2,
      log: () => {}
    });
    await updateMetadata(summary.uploadId, tmpRoot, (draft) => {
      draft.state = 'finalizing';
      return draft;
    });

    const putRes2 = await makeRequest(
      port,
      {
        path: `/api/uploads/${summary.uploadId}/chunks/2`,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': 1024 * 1024,
          'Content-Range': `bytes 2097152-3145727/5767168`,
          'X-Chunk-SHA256': '0'.repeat(64)
        }
      },
      Buffer.alloc(1024 * 1024)
    );
    assert.equal(putRes2.statusCode, 409);
    assert.match(putRes2.json.error.message, /in state "finalizing"/);
  });

  await t.test(
    'Stale finalizing: set state "finalizing" in metadata with in-process Set empty -> finalize runs and succeeds',
    async () => {
      const summary = await uploadFile({
        baseUrl,
        filePath: source55MbPath,
        contentType: 'video/mp4',
        chunkSize: 1024 * 1024,
        log: () => {}
      });
      const uploadId = summary.uploadId;

      // Set state to 'finalizing'
      await updateMetadata(uploadId, tmpRoot, (draft) => {
        draft.state = 'finalizing';
        return draft;
      });

      // Ensure uploadId is NOT in activeFinalizations (simulates process restart)
      _activeFinalizations.delete(uploadId);

      // Finalize request runs and succeeds
      const finRes = await makeRequest(
        port,
        { path: `/api/uploads/${uploadId}/finalize`, method: 'POST' }
      );
      assert.equal(finRes.statusCode, 200);
      assert.equal(finRes.json.state, 'ready');
    }
  );

  await t.test(
    'Disk failure path: remove storage/media directory before rename -> 500, assembly temp deleted, state uploading, ledger intact; recreate dir and finalize succeeds',
    async () => {
      const summary = await uploadFile({
        baseUrl,
        filePath: source55MbPath,
        contentType: 'video/mp4',
        chunkSize: 1024 * 1024,
        log: () => {}
      });
      const uploadId = summary.uploadId;

      // Remove storage/media directory to simulate filesystem write failure
      const mediaDir = paths.mediaDir(tmpRoot);
      fs.rmSync(mediaDir, { recursive: true, force: true });

      const finRes = await makeRequest(
        port,
        { path: `/api/uploads/${uploadId}/finalize`, method: 'POST' }
      );
      assert.equal(finRes.statusCode, 500);
      assert.equal(finRes.json.error.code, 'INTERNAL_SERVER_ERROR');
      assert.ok(!finRes.json.error.message.includes(tmpRoot), 'Must not leak storage path');

      // Assembly temp deleted
      const tempDir = paths.tempDir(tmpRoot);
      const tempFiles = fs.readdirSync(tempDir);
      assert.deepEqual(tempFiles, []);

      // State is back to uploading and ledger is intact
      const meta = await readMetadata(uploadId, tmpRoot);
      assert.equal(meta.state, 'uploading');
      assert.equal(meta.chunks.length, 6);

      // Recreate media directory and retry -> succeeds
      fs.mkdirSync(mediaDir, { recursive: true });
      const retryRes = await makeRequest(
        port,
        { path: `/api/uploads/${uploadId}/finalize`, method: 'POST' }
      );
      assert.equal(retryRes.statusCode, 200);
      assert.equal(retryRes.json.state, 'ready');
    }
  );

  await t.test('Status for ready upload with ?verify=true -> 200, verified false, no problems, includes mediaId', async () => {
    const statusRes = await makeRequest(
      port,
      { path: `/api/uploads/${happyUploadId}?verify=true`, method: 'GET' }
    );
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.json.state, 'ready');
    assert.equal(statusRes.json.verified, false);
    assert.deepEqual(statusRes.json.problems, []);
    assert.equal(statusRes.json.mediaId, happyMediaRecord.mediaId);
  });

  await t.test('clean up server and temporary files', async () => {
    await app.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(testFilesDir, { recursive: true, force: true });
  });
});
