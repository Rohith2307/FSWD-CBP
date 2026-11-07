const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const paths = require('../src/storage/paths');
const { writeMetadata, readMetadata } = require('../src/storage/metadataStore');
const finalizer = require('../src/services/finalizer');
const { runCleanup, sweepTemp, expireSessions, sweepOrphans } = require('../src/services/cleanup');
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

test('cleanup: Storage cleanup and session lifecycle service tests', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-cleanup-test-'));
  await paths.ensureStorageDirs(tmpRoot);

  t.after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const nowBase = 1700000000000;

  await t.test('sweepTemp: deletes old temp file, preserves fresh temp file, preserves active finalization temp', async () => {
    const tempDir = paths.tempDir(tmpRoot);

    const oldFilePath = path.join(tempDir, 'old-chunk.part');
    const freshFilePath = path.join(tempDir, 'fresh-chunk.part');
    const activeUploadId = '11111111-1111-4111-8111-111111111111';
    const activeFinalizePath = path.join(tempDir, `${activeUploadId}-final-abcdef.tmp`);

    fs.writeFileSync(oldFilePath, 'stale part data');
    fs.writeFileSync(freshFilePath, 'fresh part data');
    fs.writeFileSync(activeFinalizePath, 'assembly in progress');

    // Backdate mtime
    const oldMtime = new Date(nowBase - 7200 * 1000); // 2 hours old
    const freshMtime = new Date(nowBase - 600 * 1000); // 10 minutes old
    fs.utimesSync(oldFilePath, oldMtime, oldMtime);
    fs.utimesSync(freshFilePath, freshMtime, freshMtime);
    fs.utimesSync(activeFinalizePath, oldMtime, oldMtime); // even if mtime is old!

    // Register active finalization
    finalizer._activeFinalizations.add(activeUploadId);

    try {
      const res = await sweepTemp({
        storageRoot: tmpRoot,
        tempFileTtlMs: 3600 * 1000, // 1 hour
        nowMs: nowBase,
        dryRun: false
      });

      assert.equal(res.tempDeleted, 1);
      assert.equal(fs.existsSync(oldFilePath), false, 'Old temp file must be deleted');
      assert.equal(fs.existsSync(freshFilePath), true, 'Fresh temp file must be preserved');
      assert.equal(fs.existsSync(activeFinalizePath), true, 'Active finalization temp file must be preserved');
    } finally {
      finalizer._activeFinalizations.delete(activeUploadId);
      if (fs.existsSync(freshFilePath)) fs.unlinkSync(freshFilePath);
      if (fs.existsSync(activeFinalizePath)) fs.unlinkSync(activeFinalizePath);
    }
  });

  await t.test('sweepTemp: never follows symlinks and does not delete target outside temp', async () => {
    const tempDir = paths.tempDir(tmpRoot);
    const outsideTarget = path.join(tmpRoot, 'outside-target.txt');
    fs.writeFileSync(outsideTarget, 'do not delete me');

    const symlinkPath = path.join(tempDir, 'symlink-to-outside.part');
    try {
      fs.symlinkSync(outsideTarget, symlinkPath);
    } catch {
      // Symlink creation might require privileges on certain environments
      return;
    }

    try {
      const res = await sweepTemp({
        storageRoot: tmpRoot,
        tempFileTtlMs: 0, // all eligible files
        nowMs: nowBase,
        dryRun: false
      });

      assert.equal(fs.existsSync(outsideTarget), true, 'Target file outside temp must NOT be deleted');
    } finally {
      if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
      if (fs.existsSync(outsideTarget)) fs.unlinkSync(outsideTarget);
    }
  });

  await t.test('expireSessions: expires session older than TTL, removes chunk files, keeps metadata/metrics, later PUT returns 409 SESSION_EXPIRED', async () => {
    const expiredUploadId = '22222222-2222-4222-8222-222222222222';
    const uploadDir = paths.uploadDir(expiredUploadId, tmpRoot);
    const chunksDir = paths.chunksDir(expiredUploadId, tmpRoot);
    await fs.promises.mkdir(chunksDir, { recursive: true });

    const chunk0Path = path.join(chunksDir, '0.chunk');
    fs.writeFileSync(chunk0Path, 'chunk 0 data');

    const meta = {
      uploadId: expiredUploadId,
      originalName: 'test.bin',
      safeStoredName: `${expiredUploadId}.bin`,
      expectedSize: 2000,
      contentType: 'application/octet-stream',
      chunkSize: 1000,
      totalChunks: 2,
      createdAt: new Date(nowBase - 100000 * 1000).toISOString(),
      updatedAt: new Date(nowBase - 100000 * 1000).toISOString(),
      state: 'uploading',
      chunks: [
        { index: 0, start: 0, end: 999, size: 1000, checksum: 'abcd', committedAt: new Date(nowBase - 100000 * 1000).toISOString() }
      ]
    };
    await writeMetadata(expiredUploadId, meta, tmpRoot);

    const res = await expireSessions({
      storageRoot: tmpRoot,
      sessionTtlMs: 24 * 3600 * 1000, // 24 hours
      nowMs: nowBase,
      dryRun: false
    });

    assert.equal(res.sessionsExpired, 1);
    assert.equal(fs.existsSync(chunk0Path), false, 'Chunk payload must be unlinked');

    const updatedMeta = await readMetadata(expiredUploadId, tmpRoot);
    assert.equal(updatedMeta.state, 'expired');
    assert.ok(updatedMeta.expiredAt);

    // Verify HTTP behavior against real server instance
    const app = createServer({ port: 0, storageRoot: tmpRoot, cleanup: false });
    await app.start();
    const port = app.server.address().port;

    try {
      // Status endpoint still returns 200 with state 'expired'
      const statusRes = await makeRequest(port, { method: 'GET', path: `/api/uploads/${expiredUploadId}` });
      assert.equal(statusRes.statusCode, 200);
      assert.equal(statusRes.json.state, 'expired');

      // Chunk PUT returns 409 SESSION_EXPIRED
      const putRes = await makeRequest(
        port,
        {
          method: 'PUT',
          path: `/api/uploads/${expiredUploadId}/chunks/1`,
          headers: {
            'Content-Range': 'bytes 1000-1999/2000',
            'X-Chunk-SHA256': '0'.repeat(64),
            'Content-Type': 'application/octet-stream'
          }
        },
        Buffer.alloc(1000)
      );
      assert.equal(putRes.statusCode, 409);
      assert.equal(putRes.json?.error?.code, 'SESSION_EXPIRED');

      // Finalize returns 409 SESSION_EXPIRED
      const finRes = await makeRequest(port, { method: 'POST', path: `/api/uploads/${expiredUploadId}/finalize` });
      assert.equal(finRes.statusCode, 409);
      assert.equal(finRes.json?.error?.code, 'SESSION_EXPIRED');
    } finally {
      await app.stop();
    }
  });

  await t.test('expireSessions: ready session is never expired even if ancient', async () => {
    const readyUploadId = '33333333-3333-4333-8333-333333333333';
    const uploadDir = paths.uploadDir(readyUploadId, tmpRoot);
    await fs.promises.mkdir(uploadDir, { recursive: true });

    const meta = {
      uploadId: readyUploadId,
      originalName: 'ready.bin',
      safeStoredName: `${readyUploadId}.bin`,
      expectedSize: 1000,
      contentType: 'application/octet-stream',
      chunkSize: 1000,
      totalChunks: 1,
      createdAt: new Date(nowBase - 500000 * 1000).toISOString(),
      state: 'ready',
      chunks: []
    };
    await writeMetadata(readyUploadId, meta, tmpRoot);

    const res = await expireSessions({
      storageRoot: tmpRoot,
      sessionTtlMs: 3600 * 1000,
      nowMs: nowBase,
      dryRun: false
    });

    assert.equal(res.sessionsExpired, 0);
    const readBack = await readMetadata(readyUploadId, tmpRoot);
    assert.equal(readBack.state, 'ready');
  });

  await t.test('F1: sweepOrphans: chunk files named NNNNNN.part; old uncommitted 000005.part deleted, committed kept, young kept, non-matching ignored', async () => {
    const uploadId = '44444444-4444-4444-8444-444444444444';
    const chunksDir = paths.chunksDir(uploadId, tmpRoot);
    await fs.promises.mkdir(chunksDir, { recursive: true });

    const committedChunkPath = path.join(chunksDir, '000000.part');
    const oldOrphan5Path = path.join(chunksDir, '000005.part');
    const youngOrphanChunkPath = path.join(chunksDir, '000002.part');
    const nonMatchingLegacy = path.join(chunksDir, '0.chunk');
    const nonMatchingTemp = path.join(chunksDir, 'temp.tmp');
    const nonMatchingTxt = path.join(chunksDir, 'readme.txt');

    fs.writeFileSync(committedChunkPath, 'committed chunk 0');
    fs.writeFileSync(oldOrphan5Path, 'old uncommitted 5');
    fs.writeFileSync(youngOrphanChunkPath, 'young orphan chunk 2');
    fs.writeFileSync(nonMatchingLegacy, 'legacy non-matching');
    fs.writeFileSync(nonMatchingTemp, 'temp non-matching');
    fs.writeFileSync(nonMatchingTxt, 'txt non-matching');

    const oldTime = new Date(nowBase - 7200 * 1000);
    const youngTime = new Date(nowBase - 300 * 1000);

    fs.utimesSync(committedChunkPath, oldTime, oldTime);
    fs.utimesSync(oldOrphan5Path, oldTime, oldTime);
    fs.utimesSync(youngOrphanChunkPath, youngTime, youngTime);
    fs.utimesSync(nonMatchingLegacy, oldTime, oldTime);
    fs.utimesSync(nonMatchingTemp, oldTime, oldTime);
    fs.utimesSync(nonMatchingTxt, oldTime, oldTime);

    const meta = {
      uploadId,
      originalName: 'orphan-test.bin',
      safeStoredName: `${uploadId}.bin`,
      expectedSize: 6000,
      contentType: 'application/octet-stream',
      chunkSize: 1000,
      totalChunks: 6,
      createdAt: new Date(nowBase - 10000).toISOString(),
      state: 'uploading',
      chunks: [{ index: 0, start: 0, end: 999, size: 1000, checksum: '1111', committedAt: new Date(nowBase - 10000).toISOString() }]
    };
    await writeMetadata(uploadId, meta, tmpRoot);

    const res = await sweepOrphans({
      storageRoot: tmpRoot,
      orphanGraceMs: 3600 * 1000, // 1 hour
      nowMs: nowBase,
      dryRun: false
    });

    assert.equal(res.orphanChunksDeleted, 1);
    assert.equal(fs.existsSync(committedChunkPath), true, 'Committed chunk must be kept');
    assert.equal(fs.existsSync(youngOrphanChunkPath), true, 'Young orphan chunk must be kept within grace period');
    assert.equal(fs.existsSync(oldOrphan5Path), false, 'Old uncommitted 000005.part must be deleted');
    assert.equal(fs.existsSync(nonMatchingLegacy), true, 'Non-matching legacy .chunk file must be ignored');
    assert.equal(fs.existsSync(nonMatchingTemp), true, 'Non-matching .tmp file must be ignored');
    assert.equal(fs.existsSync(nonMatchingTxt), true, 'Non-matching .txt file must be ignored');
  });

  await t.test('F2: expireSessions race: session transitioning to ready during sweep re-checks draft and keeps media intact', async () => {
    const uploadId = '88888888-8888-4888-8888-888888888888';
    const uploadDir = paths.uploadDir(uploadId, tmpRoot);
    const chunksDir = paths.chunksDir(uploadId, tmpRoot);
    const mediaDir = paths.mediaDir(tmpRoot);
    await fs.promises.mkdir(chunksDir, { recursive: true });
    await fs.promises.mkdir(mediaDir, { recursive: true });

    const chunkFile = path.join(chunksDir, '000000.part');
    const mediaFile = path.join(mediaDir, `${uploadId}.bin`);
    fs.writeFileSync(chunkFile, 'chunk 0 data');
    fs.writeFileSync(mediaFile, 'media file data');

    const meta = {
      uploadId,
      originalName: 'race-test.bin',
      safeStoredName: `${uploadId}.bin`,
      expectedSize: 1000,
      contentType: 'application/octet-stream',
      chunkSize: 1000,
      totalChunks: 1,
      createdAt: new Date(nowBase - 10000 * 1000).toISOString(),
      state: 'uploading',
      chunks: [{ index: 0, start: 0, end: 999, size: 1000, checksum: '1111', committedAt: new Date(nowBase - 10000 * 1000).toISOString() }]
    };
    await writeMetadata(uploadId, meta, tmpRoot);

    // Call expireSessions with _beforeExpireHook simulating session becoming ready right before updateMetadata mutator
    const res = await expireSessions({
      storageRoot: tmpRoot,
      sessionTtlMs: 3600 * 1000,
      nowMs: nowBase,
      dryRun: false,
      _beforeExpireHook: async ({ uploadId: uid }) => {
        // Transition session to ready
        await writeMetadata(uid, {
          ...meta,
          state: 'ready',
          mediaId: uid,
          finalizedAt: new Date(nowBase).toISOString()
        }, tmpRoot);
      }
    });

    assert.equal(res.sessionsExpired, 0, 'Session must not be expired because it transitioned to ready');
    const postMeta = await readMetadata(uploadId, tmpRoot);
    assert.equal(postMeta.state, 'ready', 'Session must remain in ready state');
    assert.equal(fs.existsSync(mediaFile), true, 'Media file must remain intact');
  });

  await t.test('F2: expireSessions race: session receiving new chunk commit stays alive', async () => {
    const uploadId = '99999999-9999-4999-8999-999999999999';
    const uploadDir = paths.uploadDir(uploadId, tmpRoot);
    const chunksDir = paths.chunksDir(uploadId, tmpRoot);
    await fs.promises.mkdir(chunksDir, { recursive: true });

    const chunk0 = path.join(chunksDir, '000000.part');
    const chunk1 = path.join(chunksDir, '000001.part');
    fs.writeFileSync(chunk0, 'chunk 0');
    fs.writeFileSync(chunk1, 'chunk 1');

    const meta = {
      uploadId,
      originalName: 'commit-race.bin',
      safeStoredName: `${uploadId}.bin`,
      expectedSize: 2000,
      contentType: 'application/octet-stream',
      chunkSize: 1000,
      totalChunks: 2,
      createdAt: new Date(nowBase - 10000 * 1000).toISOString(),
      state: 'uploading',
      chunks: [{ index: 0, start: 0, end: 999, size: 1000, checksum: '1111', committedAt: new Date(nowBase - 10000 * 1000).toISOString() }]
    };
    await writeMetadata(uploadId, meta, tmpRoot);

    // Call expireSessions with _beforeExpireHook simulating chunk 1 commit right before expiry
    const res = await expireSessions({
      storageRoot: tmpRoot,
      sessionTtlMs: 3600 * 1000,
      nowMs: nowBase,
      dryRun: false,
      _beforeExpireHook: async ({ uploadId: uid }) => {
        await writeMetadata(uid, {
          ...meta,
          state: 'uploading',
          chunks: [
            ...meta.chunks,
            { index: 1, start: 1000, end: 1999, size: 1000, checksum: '2222', committedAt: new Date(nowBase).toISOString() }
          ]
        }, tmpRoot);
      }
    });

    assert.equal(res.sessionsExpired, 0, 'Session must not be expired because fresh chunk commit was received');
    const postMeta = await readMetadata(uploadId, tmpRoot);
    assert.equal(postMeta.state, 'uploading');
    assert.equal(fs.existsSync(chunk0), true, 'Existing chunk must not be deleted');
    assert.equal(fs.existsSync(chunk1), true, 'New chunk must not be deleted');
  });

  await t.test('sweepOrphans: orphan media file deleted, media with JSON kept, missing media file reported in orphanMediaJson', async () => {
    const mediaDir = paths.mediaDir(tmpRoot);

    const validMediaId = '55555555-5555-4555-8555-555555555555';
    const orphanMediaId = '66666666-6666-4666-8666-666666666666';
    const missingMediaId = '77777777-7777-4777-8777-777777777777';

    const validFile = path.join(mediaDir, `${validMediaId}.mp4`);
    const validJson = path.join(mediaDir, `${validMediaId}.json`);
    const orphanFile = path.join(mediaDir, `${orphanMediaId}.mp4`);
    const missingJson = path.join(mediaDir, `${missingMediaId}.json`);

    fs.writeFileSync(validFile, 'valid media');
    fs.writeFileSync(validJson, JSON.stringify({ mediaId: validMediaId, storedFile: `${validMediaId}.mp4` }));
    fs.writeFileSync(orphanFile, 'orphan media');
    fs.writeFileSync(missingJson, JSON.stringify({ mediaId: missingMediaId, storedFile: `${missingMediaId}.mp4` }));

    const oldTime = new Date(nowBase - 7200 * 1000);
    fs.utimesSync(orphanFile, oldTime, oldTime);

    const res = await sweepOrphans({
      storageRoot: tmpRoot,
      orphanGraceMs: 3600 * 1000,
      nowMs: nowBase,
      dryRun: false
    });

    assert.equal(res.orphanMediaDeleted, 1);
    assert.equal(fs.existsSync(orphanFile), false, 'Orphan media file must be deleted');
    assert.equal(fs.existsSync(validFile), true, 'Valid media file with JSON must be kept');
    assert.equal(fs.existsSync(validJson), true, 'Valid media JSON must be kept');
    assert.equal(fs.existsSync(missingJson), true, 'Orphan media JSON must NEVER be automatically deleted');
    assert.ok(res.orphanMediaJson.includes(missingMediaId), 'Missing media file must be reported in orphanMediaJson');
  });

  await t.test('runCleanup: dryRun does not delete files or expire sessions', async () => {
    const tempDir = paths.tempDir(tmpRoot);
    const testFile = path.join(tempDir, 'dryrun.part');
    fs.writeFileSync(testFile, 'dryrun content');
    const oldTime = new Date(nowBase - 7200 * 1000);
    fs.utimesSync(testFile, oldTime, oldTime);

    const report = await runCleanup({
      storageRoot: tmpRoot,
      config: { tempFileTtlMs: 3600 * 1000 },
      nowMs: nowBase,
      dryRun: true
    });

    assert.equal(report.tempDeleted, 1);
    assert.equal(fs.existsSync(testFile), true, 'File must not be deleted when dryRun is true');
    fs.unlinkSync(testFile);
  });
});
