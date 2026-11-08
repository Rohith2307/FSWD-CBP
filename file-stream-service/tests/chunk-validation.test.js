const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
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

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

test('Chunked upload and validation integration tests', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-chunk-test-'));
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

  await t.test('successful upload of all chunks & disk concatenation verification', async () => {
    // Generate a 350 KiB test buffer (2 chunks of 128 KiB + 1 chunk of 94 KiB)
    const chunkSize = 128 * 1024;
    const totalSize = 350 * 1024;
    const sourceBuffer = crypto.randomBytes(totalSize);

    // 1. Create upload session
    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({
        filename: 'my-video.mp4',
        size: totalSize,
        contentType: 'video/mp4',
        chunkSize
      })
    );
    assert.equal(createRes.statusCode, 201);
    const { uploadId, totalChunks } = createRes.json;
    assert.equal(totalChunks, 3);

    // 2. Upload chunks 0, 1, 2
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize - 1, totalSize - 1);
      const slice = sourceBuffer.subarray(start, end + 1);
      const sliceSha = sha256(slice);

      const chunkRes = await makeRequest(
        port,
        {
          path: `/api/uploads/${uploadId}/chunks/${i}`,
          method: 'PUT',
          headers: {
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'X-Chunk-SHA256': sliceSha,
            'Content-Length': slice.length
          }
        },
        slice
      );
      assert.equal(chunkRes.statusCode, 201, `Chunk ${i} should return 201`);
      assert.equal(chunkRes.json.index, i);
      assert.equal(chunkRes.json.size, slice.length);
      assert.equal(chunkRes.json.checksum, sliceSha);
    }

    // 3. Verify concatenation on disk equals source bytes
    const chunksDir = path.join(tmpRoot, 'uploads', uploadId, 'chunks');
    const files = fs.readdirSync(chunksDir).sort();
    assert.equal(files.length, 3);

    const assembledParts = files.map((f) => fs.readFileSync(path.join(chunksDir, f)));
    const assembledBuffer = Buffer.concat(assembledParts);
    assert.equal(assembledBuffer.length, totalSize);
    assert.equal(sha256(assembledBuffer), sha256(sourceBuffer));

    // 4. Verify metadata.json lists all chunks
    const metaRaw = fs.readFileSync(
      path.join(tmpRoot, 'uploads', uploadId, 'metadata.json'),
      'utf8'
    );
    const meta = JSON.parse(metaRaw);
    assert.equal(meta.chunks.length, 3);
    assert.equal(meta.state, 'uploading');
  });

  await t.test('last partial chunk accepted with its exact shorter length', async () => {
    const chunkSize = 128 * 1024;
    const totalSize = 200 * 1024; // Chunk 0 is 128 KiB, chunk 1 is 72 KiB
    const sourceBuffer = crypto.randomBytes(totalSize);

    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({
        filename: 'short.webm',
        size: totalSize,
        contentType: 'video/webm',
        chunkSize
      })
    );
    const { uploadId } = createRes.json;

    // Upload chunk 1 (last chunk: 131072 - 204799 = 73728 bytes = 72 KiB)
    const start = 131072;
    const end = totalSize - 1;
    const slice = sourceBuffer.subarray(start, end + 1);
    const sliceSha = sha256(slice);

    const chunkRes = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/1`,
        method: 'PUT',
        headers: {
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'X-Chunk-SHA256': sliceSha,
          'Content-Length': slice.length
        }
      },
      slice
    );
    assert.equal(chunkRes.statusCode, 201);
    assert.equal(chunkRes.json.size, 72 * 1024);
  });

  await t.test('wrong Content-Length vs range -> 422 rejected, no chunk file, no metadata', async () => {
    const totalSize = 128 * 1024;
    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({ filename: 'test.mp4', size: totalSize, contentType: 'video/mp4' })
    );
    const { uploadId } = createRes.json;

    const slice = crypto.randomBytes(100);
    const res = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Range': `bytes 0-${totalSize - 1}/${totalSize}`,
          'X-Chunk-SHA256': sha256(slice),
          'Content-Length': slice.length // Mismatched Content-Length vs range
        }
      },
      slice
    );
    assert.equal(res.statusCode, 422);

    const chunkPath = path.join(tmpRoot, 'uploads', uploadId, 'chunks', '000000.part');
    assert.ok(!fs.existsSync(chunkPath));
  });

  await t.test('Content-Range range not matching index -> 422', async () => {
    const totalSize = 256 * 1024;
    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({
        filename: 'test.mp4',
        size: totalSize,
        contentType: 'video/mp4',
        chunkSize: 128 * 1024
      })
    );
    const { uploadId } = createRes.json;

    // Send chunk 0's range to index 1
    const slice = crypto.randomBytes(128 * 1024);
    const res = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/1`,
        method: 'PUT',
        headers: {
          'Content-Range': `bytes 0-${128 * 1024 - 1}/${totalSize}`,
          'X-Chunk-SHA256': sha256(slice),
          'Content-Length': slice.length
        }
      },
      slice
    );
    assert.equal(res.statusCode, 422);
  });

  await t.test('total in Content-Range != expectedSize -> 422', async () => {
    const totalSize = 128 * 1024;
    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({ filename: 'test.mp4', size: totalSize, contentType: 'video/mp4' })
    );
    const { uploadId } = createRes.json;

    const slice = crypto.randomBytes(totalSize);
    const res = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Range': `bytes 0-${totalSize - 1}/${totalSize + 500}`,
          'X-Chunk-SHA256': sha256(slice),
          'Content-Length': slice.length
        }
      },
      slice
    );
    assert.equal(res.statusCode, 422);
  });

  await t.test('bad X-Chunk-SHA256 -> 422 CHECKSUM_MISMATCH & temp file cleaned', async () => {
    const totalSize = 128 * 1024;
    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({ filename: 'test.mp4', size: totalSize, contentType: 'video/mp4' })
    );
    const { uploadId } = createRes.json;

    const slice = crypto.randomBytes(totalSize);
    const wrongSha = sha256(Buffer.from('different content'));

    const res = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Range': `bytes 0-${totalSize - 1}/${totalSize}`,
          'X-Chunk-SHA256': wrongSha,
          'Content-Length': slice.length
        }
      },
      slice
    );
    assert.equal(res.statusCode, 422);
    assert.equal(res.json.error.code, 'CHECKSUM_MISMATCH');

    // Assert temp directory has no leftover files
    const tempFiles = fs.readdirSync(path.join(tmpRoot, 'temp'));
    assert.equal(tempFiles.length, 0, 'storage/temp must be completely empty after failed checksum');
  });

  await t.test('malformed SHA header -> 400', async () => {
    const totalSize = 128 * 1024;
    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({ filename: 'test.mp4', size: totalSize, contentType: 'video/mp4' })
    );
    const { uploadId } = createRes.json;

    const slice = crypto.randomBytes(totalSize);
    const res = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Range': `bytes 0-${totalSize - 1}/${totalSize}`,
          'X-Chunk-SHA256': 'not-a-valid-hex-hash',
          'Content-Length': slice.length
        }
      },
      slice
    );
    assert.equal(res.statusCode, 400);
  });

  await t.test('body longer than declared Content-Length -> 413, temp cleaned', async () => {
    const totalSize = 128 * 1024;
    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({ filename: 'test.mp4', size: totalSize, contentType: 'video/mp4' })
    );
    const { uploadId } = createRes.json;

    // Send more bytes than range declared
    const extraBytes = Buffer.alloc(totalSize + 100);
    const res = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Range': `bytes 0-${totalSize - 1}/${totalSize}`,
          'X-Chunk-SHA256': sha256(extraBytes.subarray(0, totalSize)),
          'Content-Length': totalSize // We lie in header and send extra
        }
      },
      extraBytes
    );
    // Rejected by Node HTTP parser (400) or transform limit (413)
    assert.ok(
      res.statusCode === 400 || res.statusCode === 413,
      `Expected 400 or 413, got ${res.statusCode}`
    );

    // Give asynchronous stream cleanup a moment to settle
    await new Promise((r) => setTimeout(r, 50));

    const tempFiles = fs.readdirSync(path.join(tmpRoot, 'temp'));
    assert.equal(tempFiles.length, 0, 'storage/temp must be empty');
  });

  await t.test('client disconnect mid-chunk -> temp cleaned, not recorded', async () => {
    const totalSize = 128 * 1024;
    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({ filename: 'test.mp4', size: totalSize, contentType: 'video/mp4' })
    );
    const { uploadId } = createRes.json;

    await new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Range': `bytes 0-${totalSize - 1}/${totalSize}`,
          'X-Chunk-SHA256': '0'.repeat(64),
          'Content-Length': totalSize
        }
      });
      req.on('error', () => {
        // Expected error due to client socket destroy
        resolve();
      });

      // Write partial chunk and abruptly destroy socket
      req.write(Buffer.alloc(1024));
      setTimeout(() => {
        req.destroy();
      }, 50);
    });

    // Give server a moment to cleanup
    await new Promise((r) => setTimeout(r, 100));

    const tempFiles = fs.readdirSync(path.join(tmpRoot, 'temp'));
    assert.equal(tempFiles.length, 0, 'storage/temp must be empty after client disconnect');

    const meta = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'uploads', uploadId, 'metadata.json'), 'utf8')
    );
    assert.equal(meta.chunks.length, 0);
  });

  await t.test('chunk index out of range -> 400; invalid uploadId -> 404', async () => {
    const totalSize = 128 * 1024;
    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({ filename: 'test.mp4', size: totalSize, contentType: 'video/mp4' })
    );
    const { uploadId } = createRes.json;

    // Index 5 is out of bounds for 1-chunk file
    const resOutOfRange = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/5`,
        method: 'PUT',
        headers: {
          'Content-Range': `bytes 0-${totalSize - 1}/${totalSize}`,
          'X-Chunk-SHA256': '0'.repeat(64),
          'Content-Length': totalSize
        }
      },
      Buffer.alloc(totalSize)
    );
    assert.equal(resOutOfRange.statusCode, 400);

    // Malformed uploadId
    const resBadId = await makeRequest(
      port,
      {
        path: `/api/uploads/invalid-id/chunks/0`,
        method: 'PUT'
      }
    );
    assert.equal(resBadId.statusCode, 404);

    // Well-formed but non-existent uploadId
    const nonExistentId = crypto.randomUUID();
    const resNotFound = await makeRequest(
      port,
      {
        path: `/api/uploads/${nonExistentId}/chunks/0`,
        method: 'PUT'
      }
    );
    assert.equal(resNotFound.statusCode, 404);
  });

  await t.test('re-sending already committed chunk -> 200 duplicate:true (or 409 on conflict)', async () => {
    const totalSize = 128 * 1024;
    const slice = crypto.randomBytes(totalSize);
    const sliceSha = sha256(slice);

    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({ filename: 'test.mp4', size: totalSize, contentType: 'video/mp4' })
    );
    const { uploadId } = createRes.json;

    // First send -> 201
    const res1 = await makeRequest(
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
    assert.equal(res1.statusCode, 201);

    // Resend same checksum -> 200 duplicate: true
    const res2 = await makeRequest(
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
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.json.duplicate, true);

    // Resend different checksum -> 409 CHUNK_CONFLICT
    const conflictSha = sha256(Buffer.from('different'));
    const res3 = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Range': `bytes 0-${totalSize - 1}/${totalSize}`,
          'X-Chunk-SHA256': conflictSha,
          'Content-Length': totalSize
        }
      },
      slice
    );
    assert.equal(res3.statusCode, 409);
    assert.equal(res3.json.error.code, 'CHUNK_CONFLICT');
  });

  await t.test('parallel chunk uploads (6 parallel) commit with no lost updates (per-upload lock)', async () => {
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
      JSON.stringify({
        filename: 'parallel-test.mp4',
        size: totalSize,
        contentType: 'video/mp4',
        chunkSize
      })
    );
    const { uploadId } = createRes.json;

    // Concurrently upload all 6 chunks with Promise.all
    const uploadPromises = Array.from({ length: numChunks }, (_, i) => {
      const start = i * chunkSize;
      const end = start + chunkSize - 1;
      const slice = sourceBuffer.subarray(start, end + 1);
      const sliceSha = sha256(slice);

      return makeRequest(
        port,
        {
          path: `/api/uploads/${uploadId}/chunks/${i}`,
          method: 'PUT',
          headers: {
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'X-Chunk-SHA256': sliceSha,
            'Content-Length': slice.length
          }
        },
        slice
      );
    });

    const results = await Promise.all(uploadPromises);
    for (const r of results) {
      assert.equal(r.statusCode, 201);
    }

    // Verify metadata lists all 6 chunks without any lost updates
    const meta = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'uploads', uploadId, 'metadata.json'), 'utf8')
    );
    assert.equal(meta.chunks.length, 6);
    const committedIndices = meta.chunks.map((c) => c.index).sort((a, b) => a - b);
    assert.deepEqual(committedIndices, [0, 1, 2, 3, 4, 5]);
  });

  await t.test('disallowed contentType -> 415; traversal filename uses safe stored name inside storageRoot', async () => {
    // 1. Disallowed Content-Type
    const badMimeRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({
        filename: 'script.exe',
        size: 1000,
        contentType: 'application/x-msdownload'
      })
    );
    assert.equal(badMimeRes.statusCode, 415);

    // 2. Traversal filename
    const traversalRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      JSON.stringify({
        filename: '../../../../etc/passwd',
        size: 1000,
        contentType: 'video/mp4'
      })
    );
    assert.equal(traversalRes.statusCode, 201);
    const { uploadId } = traversalRes.json;

    const meta = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'uploads', uploadId, 'metadata.json'), 'utf8')
    );
    assert.equal(meta.originalName, 'etcpasswd');
    assert.equal(meta.safeStoredName, `${uploadId}.mp4`);
    assert.ok(fs.existsSync(path.join(tmpRoot, 'uploads', uploadId)));
  });

  await t.test('stop server and clean up', async () => {
    await app.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});
