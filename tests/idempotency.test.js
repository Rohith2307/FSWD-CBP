const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createServer } = require('../src/server');
const { updateMetadata, _lockCount } = require('../src/storage/metadataStore');

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

test('A1 - updateMetadata unhandledRejection prevention and lock draining', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-lock-test-'));
  const uploadId = crypto.randomUUID();
  const upDir = path.join(tmpRoot, 'uploads', uploadId);
  fs.mkdirSync(upDir, { recursive: true });
  fs.writeFileSync(path.join(upDir, 'metadata.json'), JSON.stringify({ uploadId, chunks: [] }));

  let unhandledCaught = false;
  const onUnhandled = () => {
    unhandledCaught = true;
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    // 1. A throwing mutator must reject for the caller
    await assert.rejects(
      async () => {
        await updateMetadata(uploadId, tmpRoot, () => {
          throw new Error('Simulated mutator error');
        });
      },
      /Simulated mutator error/
    );

    // Give microtask queue time to settle
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(unhandledCaught, false, 'Mutator rejection must not trigger unhandledRejection');

    // 2. Subsequent updateMetadata on same uploadId must succeed
    const updated = await updateMetadata(uploadId, tmpRoot, (draft) => {
      draft.state = 'uploading';
      return draft;
    });
    assert.equal(updated.state, 'uploading');

    // 3. Lock map should be drained and empty
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(_lockCount(), 0, 'Lock count should be 0 after queue drains');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Idempotency and concurrency integration tests', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-idempotency-test-'));
  const app = createServer({
    port: 0,
    storageRoot: tmpRoot,
    minChunkBytes: 64 * 1024,
    defaultChunkBytes: 128 * 1024,
    maxChunkBytes: 512 * 1024,
    maxUploadBytes: 10 * 1024 * 1024,
    maxConcurrentUploads: 100
  });

  let port;

  await t.test('start server', async () => {
    await app.start(0, '127.0.0.1');
    port = app.server.address().port;
    assert.ok(port > 0);
  });

  await t.test('re-send same chunk with same checksum -> 200 duplicate:true', async () => {
    const chunkSize = 128 * 1024;
    const totalSize = 256 * 1024;
    const slice0 = crypto.randomBytes(chunkSize);
    const sha0 = sha256(slice0);

    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({ filename: 'idempotent.mp4', size: totalSize, contentType: 'video/mp4', chunkSize })
    );
    const { uploadId } = createRes.json;

    // First upload -> 201 Created
    const res1 = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Range': `bytes 0-${chunkSize - 1}/${totalSize}`,
          'X-Chunk-SHA256': sha0,
          'Content-Length': chunkSize
        }
      },
      slice0
    );
    assert.equal(res1.statusCode, 201);
    assert.equal(res1.json.duplicate, false);

    const chunkFile = path.join(tmpRoot, 'uploads', uploadId, 'chunks', '000000.part');
    const stat1 = fs.statSync(chunkFile);

    // Wait slightly so mtime would advance if file were touched
    await new Promise((r) => setTimeout(r, 20));

    // Second upload (identical body & checksum) -> 200 OK duplicate: true
    const res2 = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Range': `bytes 0-${chunkSize - 1}/${totalSize}`,
          'X-Chunk-SHA256': sha0,
          'Content-Length': chunkSize
        }
      },
      slice0
    );
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.json.duplicate, true);
    assert.equal(res2.json.index, 0);

    const stat2 = fs.statSync(chunkFile);
    assert.equal(stat2.mtimeMs, stat1.mtimeMs, 'Chunk file mtime must remain unchanged');
    assert.equal(stat2.size, chunkSize);

    const meta = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'uploads', uploadId, 'metadata.json'), 'utf8')
    );
    assert.equal(meta.chunks.length, 1, 'Ledger length must remain unchanged');
  });

  await t.test('re-send same index with different checksum -> 409 CHUNK_CONFLICT', async () => {
    const chunkSize = 128 * 1024;
    const totalSize = 256 * 1024;
    const slice0 = crypto.randomBytes(chunkSize);
    const sha0 = sha256(slice0);

    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({ filename: 'conflict.mp4', size: totalSize, contentType: 'video/mp4', chunkSize })
    );
    const { uploadId } = createRes.json;

    // Initial commit -> 201
    await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Range': `bytes 0-${chunkSize - 1}/${totalSize}`,
          'X-Chunk-SHA256': sha0,
          'Content-Length': chunkSize
        }
      },
      slice0
    );

    // Conflict commit with different content/checksum
    const conflictingSlice = crypto.randomBytes(chunkSize);
    const conflictingSha = sha256(conflictingSlice);

    const conflictRes = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Range': `bytes 0-${chunkSize - 1}/${totalSize}`,
          'X-Chunk-SHA256': conflictingSha,
          'Content-Length': chunkSize
        }
      },
      conflictingSlice
    );

    assert.equal(conflictRes.statusCode, 409);
    assert.equal(conflictRes.json.error.code, 'CHUNK_CONFLICT');

    // Committed chunk file remains intact
    const chunkFile = path.join(tmpRoot, 'uploads', uploadId, 'chunks', '000000.part');
    const existingBytes = fs.readFileSync(chunkFile);
    assert.equal(sha256(existingBytes), sha0);
  });

  await t.test('5 parallel requests for the SAME index -> exactly one 201, four 200 duplicate:true', async () => {
    const chunkSize = 128 * 1024;
    const totalSize = 256 * 1024;
    const slice0 = crypto.randomBytes(chunkSize);
    const sha0 = sha256(slice0);

    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({ filename: 'race.mp4', size: totalSize, contentType: 'video/mp4', chunkSize })
    );
    const { uploadId } = createRes.json;

    // Send 5 identical parallel requests
    const promises = Array.from({ length: 5 }, () =>
      makeRequest(
        port,
        {
          path: `/api/uploads/${uploadId}/chunks/0`,
          method: 'PUT',
          headers: {
            'Content-Range': `bytes 0-${chunkSize - 1}/${totalSize}`,
            'X-Chunk-SHA256': sha0,
            'Content-Length': chunkSize
          }
        },
        slice0
      )
    );

    const results = await Promise.all(promises);
    const status201 = results.filter((r) => r.statusCode === 201);
    const status200 = results.filter((r) => r.statusCode === 200);

    assert.equal(status201.length, 1, 'Exactly one request should return 201');
    assert.equal(status200.length, 4, 'Four requests should return 200 duplicate: true');
    for (const r of status200) {
      assert.equal(r.json.duplicate, true);
    }

    // Ledger has exactly 1 record
    const meta = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'uploads', uploadId, 'metadata.json'), 'utf8')
    );
    assert.equal(meta.chunks.length, 1);

    // Temp directory is empty
    const tempFiles = fs.readdirSync(path.join(tmpRoot, 'temp'));
    assert.equal(tempFiles.length, 0, 'storage/temp must be empty');
  });

  await t.test('parallel mix: 6 different indices + duplicates of 2 at same time', async () => {
    const chunkSize = 64 * 1024;
    const numChunks = 6;
    const totalSize = numChunks * chunkSize;
    const sourceBuffer = crypto.randomBytes(totalSize);

    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({ filename: 'mix.mp4', size: totalSize, contentType: 'video/mp4', chunkSize })
    );
    const { uploadId } = createRes.json;

    const reqs = [];
    // 6 unique chunks
    for (let i = 0; i < numChunks; i++) {
      const start = i * chunkSize;
      const end = start + chunkSize - 1;
      const slice = sourceBuffer.subarray(start, end + 1);
      const sha = sha256(slice);

      reqs.push(
        makeRequest(
          port,
          {
            path: `/api/uploads/${uploadId}/chunks/${i}`,
            method: 'PUT',
            headers: {
              'Content-Range': `bytes ${start}-${end}/${totalSize}`,
              'X-Chunk-SHA256': sha,
              'Content-Length': slice.length
            }
          },
          slice
        )
      );

      // Add duplicate requests for chunk 1 and chunk 4
      if (i === 1 || i === 4) {
        reqs.push(
          makeRequest(
            port,
            {
              path: `/api/uploads/${uploadId}/chunks/${i}`,
              method: 'PUT',
              headers: {
                'Content-Range': `bytes ${start}-${end}/${totalSize}`,
                'X-Chunk-SHA256': sha,
                'Content-Length': slice.length
              }
            },
            slice
          )
        );
      }
    }

    const results = await Promise.all(reqs);
    for (const r of results) {
      assert.ok(r.statusCode === 201 || r.statusCode === 200);
    }

    const meta = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'uploads', uploadId, 'metadata.json'), 'utf8')
    );
    assert.equal(meta.chunks.length, 6);
    const indices = meta.chunks.map((c) => c.index);
    assert.deepEqual(indices, [0, 1, 2, 3, 4, 5], 'Ledger must be sorted and deduplicated');
  });

  await t.test('metadata write failure after rename triggers rollback (removes final chunk file)', async () => {
    const chunkSize = 64 * 1024;
    const totalSize = 64 * 1024;
    const slice = crypto.randomBytes(totalSize);
    const sliceSha = sha256(slice);

    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({ filename: 'rollback.mp4', size: totalSize, contentType: 'video/mp4', chunkSize })
    );
    const { uploadId } = createRes.json;

    const uploadDir = path.join(tmpRoot, 'uploads', uploadId);
    const metaFile = path.join(uploadDir, 'metadata.json');
    const finalChunk = path.join(uploadDir, 'chunks', '000000.part');

    // Make uploadDir read-only so creating metadata.json.<random>.tmp inside it fails
    fs.chmodSync(uploadDir, 0o555);

    try {
      const res = await makeRequest(
        port,
        {
          path: `/api/uploads/${uploadId}/chunks/0`,
          method: 'PUT',
          headers: {
            'Content-Range': `bytes 0-${totalSize - 1}/${totalSize}`,
            'X-Chunk-SHA256': sliceSha,
            'Content-Length': totalSize
          }
        },
        slice
      );

      // Must fail with 500
      assert.equal(res.statusCode, 500);

      // Restore permissions to inspect disk
      fs.chmodSync(uploadDir, 0o755);

      // The final chunk file must have been rolled back (unlinked)
      assert.equal(fs.existsSync(finalChunk), false, 'Final chunk file must be removed on metadata write failure');

      // Metadata must have no chunk records
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      assert.equal(meta.chunks.length, 0, 'Ledger must have no record');
    } finally {
      fs.chmodSync(uploadDir, 0o755);
    }
  });

  await t.test('stop server and clean up', async () => {
    await app.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});
