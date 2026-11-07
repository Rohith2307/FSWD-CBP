const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');
const paths = require('../src/storage/paths');
const { sendError } = require('../src/utils/http');
const { HttpError, insufficientStorage } = require('../src/utils/httpErrors');
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

function createMockResponse() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    headersSent: false,
    destroyed: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          this.headers[k.toLowerCase()] = v;
        }
      }
      this.headersSent = true;
    },
    end(data) {
      this.body = data;
      this.headersSent = true;
    },
    destroy(err) {
      this.destroyed = true;
    }
  };
}

test('B3 & B4: Storage errors and corrupt metadata handling', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-storage-errors-'));
  await paths.ensureStorageDirs(tmpRoot);

  t.after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('B3: unit tests for sendError mapping and path containment', () => {
    // ENOSPC -> 507
    {
      const res = createMockResponse();
      const err = new Error('No space left on device');
      err.code = 'ENOSPC';
      err.path = '/var/secret/storage/disk/full';
      sendError(res, err);
      assert.equal(res.statusCode, 507);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.error.code, 'INSUFFICIENT_STORAGE');
      assert.equal(parsed.error.message, 'Server storage is full');
      assert.equal(parsed.error.details, null);
      assert.ok(!res.body.includes('/var/secret'), 'Path must not leak in 507 response');
    }

    // EDQUOT -> 507
    {
      const res = createMockResponse();
      const err = new Error('Disk quota exceeded');
      err.code = 'EDQUOT';
      sendError(res, err);
      assert.equal(res.statusCode, 507);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.error.code, 'INSUFFICIENT_STORAGE');
    }

    // EACCES -> 500
    {
      const res = createMockResponse();
      const err = new Error('Permission denied');
      err.code = 'EACCES';
      err.path = '/etc/shadow';
      sendError(res, err);
      assert.equal(res.statusCode, 500);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.error.code, 'INTERNAL_SERVER_ERROR');
      assert.equal(parsed.error.message, 'Internal Server Error');
      assert.ok(!res.body.includes('/etc/shadow'), 'Path must not leak in 500 response');
    }

    // EPERM, EROFS, EIO -> 500
    for (const code of ['EPERM', 'EROFS', 'EIO']) {
      const res = createMockResponse();
      const err = new Error(`Filesystem failure ${code}`);
      err.code = code;
      sendError(res, err);
      assert.equal(res.statusCode, 500);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.error.code, 'INTERNAL_SERVER_ERROR');
    }

    // Generic error with path in message
    {
      const res = createMockResponse();
      const err = new Error('Failed to access /Users/admin/private/keys/id_rsa');
      sendError(res, err);
      assert.equal(res.statusCode, 500);
      assert.ok(!res.body.includes('admin/private'), 'Error message paths must not leak');
    }

    // HttpError helper
    {
      const err507 = insufficientStorage();
      assert.equal(err507.statusCode, 507);
      assert.equal(err507.code, 'INSUFFICIENT_STORAGE');
    }
  });

  let failChunkWrite = false;
  let failRename = false;

  const app = createServer({
    storageRoot: tmpRoot,
    cleanup: false,
    _createWriteStream(tempPath, opts) {
      if (failChunkWrite) {
        // Return a writable stream that emits ENOSPC
        const ws = new Writable({
          write(chunk, enc, cb) {
            const err = new Error('No space left on device');
            err.code = 'ENOSPC';
            cb(err);
          }
        });
        return ws;
      }
      return fs.createWriteStream(tempPath, opts);
    },
    async _rename(fromPath, toPath) {
      if (failRename) {
        const err = new Error('No space left on device');
        err.code = 'ENOSPC';
        throw err;
      }
      return fs.promises.rename(fromPath, toPath);
    }
  });

  const port = 62101;
  await app.start(port, '127.0.0.1');

  t.after(async () => {
    await app.stop();
  });

  await t.test('B3: injected ENOSPC on chunk PUT returns 507, cleans temp, preserves state, later PUT succeeds', async () => {
    const totalSize = 200000;
    const chunkSize = 100000;
    const createRes = await makeRequest(
      port,
      { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ filename: 'enospc-test.bin', size: totalSize, contentType: 'application/octet-stream', chunkSize })
    );
    assert.equal(createRes.statusCode, 201);
    const uploadId = createRes.json.uploadId;

    const chunkData = crypto.randomBytes(chunkSize);
    const chunkSha = crypto.createHash('sha256').update(chunkData).digest('hex');

    // Enable ENOSPC injection
    failChunkWrite = true;
    try {
      const failPutRes = await makeRequest(
        port,
        {
          path: `/api/uploads/${uploadId}/chunks/0`,
          method: 'PUT',
          headers: {
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes 0-${chunkSize - 1}/${totalSize}`,
            'X-Chunk-SHA256': chunkSha
          }
        },
        chunkData
      );

      assert.equal(failPutRes.statusCode, 507, 'Must return HTTP 507');
      assert.equal(failPutRes.json.error.code, 'INSUFFICIENT_STORAGE');
      assert.equal(failPutRes.json.error.message, 'Server storage is full');
      assert.ok(!failPutRes.raw.includes(tmpRoot), 'storageRoot must not appear in response');

      // Temp directory must be clean of any lingering part file
      const tempFiles = fs.readdirSync(paths.tempDir(tmpRoot));
      const uploadTempFiles = tempFiles.filter((f) => f.startsWith(uploadId));
      assert.equal(uploadTempFiles.length, 0, 'Temp file must be unlinked after ENOSPC');

      // Ledger state check
      const statusRes = await makeRequest(port, { path: `/api/uploads/${uploadId}`, method: 'GET' });
      assert.equal(statusRes.statusCode, 200);
      assert.equal(statusRes.json.committedChunks.length, 0, 'Chunk must not be recorded in ledger');
    } finally {
      // Disable ENOSPC injection; later PUT must succeed
      failChunkWrite = false;
    }

    const succeedPutRes = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Length': String(chunkSize),
          'Content-Range': `bytes 0-${chunkSize - 1}/${totalSize}`,
          'X-Chunk-SHA256': chunkSha
        }
      },
      chunkData
    );
    assert.equal(succeedPutRes.statusCode, 201, 'Later PUT must succeed');
  });

  await t.test('B3: finalize rename failing with ENOSPC returns 507 and reverts state to uploading', async () => {
    const totalSize = 100000;
    const chunkSize = 100000;
    const createRes = await makeRequest(
      port,
      { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ filename: 'finalize-enospc.bin', size: totalSize, contentType: 'application/octet-stream', chunkSize })
    );
    assert.equal(createRes.statusCode, 201);
    const uploadId = createRes.json.uploadId;

    const chunkData = crypto.randomBytes(chunkSize);
    const chunkSha = crypto.createHash('sha256').update(chunkData).digest('hex');

    const putRes = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Length': String(chunkSize),
          'Content-Range': `bytes 0-${chunkSize - 1}/${totalSize}`,
          'X-Chunk-SHA256': chunkSha
        }
      },
      chunkData
    );
    assert.equal(putRes.statusCode, 201);

    // Inject ENOSPC during rename
    failRename = true;
    try {
      const finRes = await makeRequest(
        port,
        {
          path: `/api/uploads/${uploadId}/finalize`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        },
        JSON.stringify({ sha256: chunkSha })
      );

      assert.equal(finRes.statusCode, 507, 'Finalize rename ENOSPC must return 507');
      assert.equal(finRes.json.error.code, 'INSUFFICIENT_STORAGE');

      // State must have reverted to uploading
      const statusRes = await makeRequest(port, { path: `/api/uploads/${uploadId}`, method: 'GET' });
      assert.equal(statusRes.statusCode, 200);
      assert.equal(statusRes.json.state, 'uploading', 'State must return to uploading on rename failure');
    } finally {
      failRename = false;
    }
  });

  await t.test('F3: readMetadata throws internal METADATA_CORRUPT on garbage JSON with no path or cause in response', async () => {
    const corruptId = 'c0000000-0000-4000-8000-000000000099';
    const uploadDirPath = paths.uploadDir(corruptId, tmpRoot);
    await fs.promises.mkdir(uploadDirPath, { recursive: true });
    const metaPath = paths.metadataPath(corruptId, tmpRoot);
    fs.writeFileSync(metaPath, '{{{CORRUPT_JSON_DATA', 'utf8');

    const { readMetadata } = require('../src/storage/metadataStore');
    let thrown = null;
    try {
      await readMetadata(corruptId, tmpRoot);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'readMetadata must throw an error');
    assert.equal(thrown.statusCode, 500);
    assert.equal(thrown.code, 'METADATA_CORRUPT');
    assert.equal(thrown.message, 'Corrupt metadata ledger on disk');
    assert.equal(thrown.details, null);
    assert.ok(!thrown.message.includes(tmpRoot), 'No filesystem path leakage in error message');
  });

  await t.test('B4: corrupt metadata.json returns 500 METADATA_CORRUPT without leaks; other endpoints remain healthy', async () => {
    const totalSize = 100000;
    const chunkSize = 100000;
    const createRes = await makeRequest(
      port,
      { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ filename: 'corrupt-meta.bin', size: totalSize, contentType: 'application/octet-stream', chunkSize })
    );
    assert.equal(createRes.statusCode, 201);
    const uploadId = createRes.json.uploadId;

    // Overwrite metadata.json with garbage
    const metaPath = paths.metadataPath(uploadId, tmpRoot);
    fs.writeFileSync(metaPath, '{{{CORRUPT_JSON_GARBAGE', 'utf8');

    // GET /api/uploads/:id -> 500 METADATA_CORRUPT
    const getRes = await makeRequest(port, { path: `/api/uploads/${uploadId}`, method: 'GET' });
    assert.equal(getRes.statusCode, 500);
    assert.equal(getRes.json.error.code, 'METADATA_CORRUPT');
    assert.ok(!getRes.raw.includes(tmpRoot), 'No path leak in GET status');

    // PUT /api/uploads/:id/chunks/0 -> 500 METADATA_CORRUPT
    const dummyChunk = Buffer.alloc(100);
    const putRes = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Length': '100',
          'Content-Range': 'bytes 0-99/100000',
          'X-Chunk-SHA256': crypto.createHash('sha256').update(dummyChunk).digest('hex')
        }
      },
      dummyChunk
    );
    assert.equal(putRes.statusCode, 500);
    assert.equal(putRes.json.error.code, 'METADATA_CORRUPT');

    // POST /api/uploads/:id/finalize -> 500 METADATA_CORRUPT
    const finRes = await makeRequest(
      port,
      { path: `/api/uploads/${uploadId}/finalize`, method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({})
    );
    assert.equal(finRes.statusCode, 500);
    assert.equal(finRes.json.error.code, 'METADATA_CORRUPT');

    // GET /api/metrics/:id -> 500 METADATA_CORRUPT
    const metRes = await makeRequest(port, { path: `/api/metrics/${uploadId}`, method: 'GET' });
    assert.equal(metRes.statusCode, 500);
    assert.equal(metRes.json.error.code, 'METADATA_CORRUPT');

    // Creating a NEW upload still works (countActiveUploads skips corrupt upload)
    const newUploadRes = await makeRequest(
      port,
      { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ filename: 'new-valid.bin', size: totalSize, contentType: 'application/octet-stream', chunkSize })
    );
    assert.equal(newUploadRes.statusCode, 201, 'New upload creation must succeed despite corrupt sibling upload');

    // Listing media works
    const mediaRes = await makeRequest(port, { path: '/api/media', method: 'GET' });
    assert.equal(mediaRes.statusCode, 200);

    // /health works
    const healthRes = await makeRequest(port, { path: '/health', method: 'GET' });
    assert.equal(healthRes.statusCode, 200);
  });

  await t.test('B4: corrupt metrics.json falls back to partial:true', async () => {
    const totalSize = 100000;
    const chunkSize = 100000;
    const createRes = await makeRequest(
      port,
      { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ filename: 'corrupt-metrics.bin', size: totalSize, contentType: 'application/octet-stream', chunkSize })
    );
    assert.equal(createRes.statusCode, 201);
    const uploadId = createRes.json.uploadId;

    // Write garbage to metrics.json
    const mPath = paths.metricsPath(uploadId, tmpRoot);
    fs.writeFileSync(mPath, '{{{CORRUPT_METRICS_DATA', 'utf8');

    // Force server to read from disk by querying metrics
    const metRes = await makeRequest(port, { path: `/api/metrics/${uploadId}`, method: 'GET' });
    assert.equal(metRes.statusCode, 200);
    assert.equal(metRes.json.partial, true, 'Corrupt metrics.json must fall back to partial:true');
    assert.equal(metRes.json.uploadId, uploadId);
  });

  await t.test('B4: corrupt media json is skipped in listing and GET /api/media/:id returns 404', async () => {
    const corruptMediaId = 'c0000000-0000-4000-8000-000000000001';
    const mediaJsonPath = paths.mediaMetaPath(corruptMediaId, tmpRoot);
    fs.writeFileSync(mediaJsonPath, '{{{CORRUPT_MEDIA_JSON', 'utf8');

    // Listing media must skip corrupt JSON
    const listRes = await makeRequest(port, { path: '/api/media', method: 'GET' });
    assert.equal(listRes.statusCode, 200);
    const found = listRes.json.items.find((item) => item.mediaId === corruptMediaId);
    assert.equal(found, undefined, 'Corrupt media JSON must be omitted from listing');

    // Direct GET /api/media/:id -> 404
    const getMediaRes = await makeRequest(port, { path: `/api/media/${corruptMediaId}`, method: 'GET' });
    assert.equal(getMediaRes.statusCode, 404, 'Direct GET for corrupt media item must return 404');
  });
});
