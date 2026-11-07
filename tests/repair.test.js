const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createServer } = require('../src/server');
const paths = require('../src/storage/paths');
const { readMetadata } = require('../src/storage/metadataStore');

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

test('Damaged-chunk repair integration tests', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-repair-test-'));
  const app = createServer({
    port: 0,
    storageRoot: tmpRoot,
    defaultChunkBytes: 64 * 1024,
    minChunkBytes: 64 * 1024,
    maxChunkBytes: 1024 * 1024
  });

  let port;

  await t.test('start server', async () => {
    await app.start(0, '127.0.0.1');
    port = app.server.address().port;
  });

  await t.test(
    'delete a committed chunk file, re-send it -> 201 repaired:true, file bytes equal source slice, ?verify=true shows problems []',
    async () => {
      // 1. Create upload session (128 KiB, 2 chunks of 64 KiB)
      const initPayload = JSON.stringify({
        filename: 'repair-test.bin',
        size: 128 * 1024,
        contentType: 'application/octet-stream',
        chunkSize: 64 * 1024
      });
      const createRes = await makeRequest(
        port,
        {
          path: '/api/uploads',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(initPayload)
          }
        },
        initPayload
      );
      assert.equal(createRes.statusCode, 201);
      const uploadId = createRes.json.uploadId;

      // 2. Upload chunk 0
      const chunk0Data = crypto.randomBytes(64 * 1024);
      const chunk0Sha = crypto.createHash('sha256').update(chunk0Data).digest('hex');

      const putRes1 = await makeRequest(
        port,
        {
          path: `/api/uploads/${uploadId}/chunks/0`,
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': chunk0Data.length,
            'Content-Range': `bytes 0-${64 * 1024 - 1}/${128 * 1024}`,
            'X-Chunk-SHA256': chunk0Sha
          }
        },
        chunk0Data
      );
      assert.equal(putRes1.statusCode, 201);
      assert.equal(putRes1.json.duplicate, false);
      assert.equal(putRes1.json.repaired, false);

      const chunk0Path = paths.chunkPath(uploadId, 0, tmpRoot);
      assert.ok(fs.existsSync(chunk0Path));

      // 3. Delete the chunk file from disk (simulate damage / accidental deletion)
      fs.unlinkSync(chunk0Path);
      assert.ok(!fs.existsSync(chunk0Path));

      // Check ?verify=true shows missing_file problem
      const verifyRes1 = await makeRequest(port, {
        path: `/api/uploads/${uploadId}?verify=true`,
        method: 'GET'
      });
      assert.equal(verifyRes1.statusCode, 200);
      assert.equal(verifyRes1.json.verified, true);
      assert.equal(verifyRes1.json.problems.length, 1);
      assert.equal(verifyRes1.json.problems[0].reason, 'missing_file');

      // 4. Re-send chunk 0 with identical data and checksum
      const putRes2 = await makeRequest(
        port,
        {
          path: `/api/uploads/${uploadId}/chunks/0`,
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': chunk0Data.length,
            'Content-Range': `bytes 0-${64 * 1024 - 1}/${128 * 1024}`,
            'X-Chunk-SHA256': chunk0Sha
          }
        },
        chunk0Data
      );
      assert.equal(putRes2.statusCode, 201, 'Repair must return 201 Created');
      assert.equal(putRes2.json.repaired, true);
      assert.equal(putRes2.json.duplicate, false);

      // Verify file recreated and contents match source slice
      assert.ok(fs.existsSync(chunk0Path));
      const diskBytes = fs.readFileSync(chunk0Path);
      assert.deepEqual(diskBytes, chunk0Data);

      // Verify status with ?verify=true now shows problems: []
      const verifyRes2 = await makeRequest(port, {
        path: `/api/uploads/${uploadId}?verify=true`,
        method: 'GET'
      });
      assert.equal(verifyRes2.statusCode, 200);
      assert.equal(verifyRes2.json.verified, true);
      assert.deepEqual(verifyRes2.json.problems, []);
    }
  );

  await t.test('truncate a chunk file, re-send -> repaired', async () => {
    // 1. Create upload session
    const initPayload = JSON.stringify({
      filename: 'truncate-test.bin',
      size: 64 * 1024,
      contentType: 'application/octet-stream',
      chunkSize: 64 * 1024
    });
    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(initPayload)
        }
      },
      initPayload
    );
    const uploadId = createRes.json.uploadId;

    // 2. Upload chunk 0
    const chunk0Data = crypto.randomBytes(64 * 1024);
    const chunk0Sha = crypto.createHash('sha256').update(chunk0Data).digest('hex');

    const putRes1 = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': chunk0Data.length,
          'Content-Range': `bytes 0-${64 * 1024 - 1}/${64 * 1024}`,
          'X-Chunk-SHA256': chunk0Sha
        }
      },
      chunk0Data
    );
    assert.equal(putRes1.statusCode, 201);

    const chunk0Path = paths.chunkPath(uploadId, 0, tmpRoot);
    // Truncate to 10 bytes
    fs.truncateSync(chunk0Path, 10);
    assert.equal(fs.statSync(chunk0Path).size, 10);

    // 3. Re-send chunk 0
    const putRes2 = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': chunk0Data.length,
          'Content-Range': `bytes 0-${64 * 1024 - 1}/${64 * 1024}`,
          'X-Chunk-SHA256': chunk0Sha
        }
      },
      chunk0Data
    );
    assert.equal(putRes2.statusCode, 201);
    assert.equal(putRes2.json.repaired, true);
    assert.equal(fs.statSync(chunk0Path).size, 64 * 1024);
    assert.deepEqual(fs.readFileSync(chunk0Path), chunk0Data);
  });

  await t.test('damaged chunk re-sent with a DIFFERENT checksum -> 409 and file untouched', async () => {
    const initPayload = JSON.stringify({
      filename: 'conflict-test.bin',
      size: 64 * 1024,
      contentType: 'application/octet-stream',
      chunkSize: 64 * 1024
    });
    const createRes = await makeRequest(
      port,
      {
        path: '/api/uploads',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(initPayload)
        }
      },
      initPayload
    );
    const uploadId = createRes.json.uploadId;

    const chunk0Data = crypto.randomBytes(64 * 1024);
    const chunk0Sha = crypto.createHash('sha256').update(chunk0Data).digest('hex');

    await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': chunk0Data.length,
          'Content-Range': `bytes 0-${64 * 1024 - 1}/${64 * 1024}`,
          'X-Chunk-SHA256': chunk0Sha
        }
      },
      chunk0Data
    );

    const chunk0Path = paths.chunkPath(uploadId, 0, tmpRoot);
    // Truncate to 5 bytes
    fs.truncateSync(chunk0Path, 5);

    // Re-send with different checksum & data
    const differentData = crypto.randomBytes(64 * 1024);
    const differentSha = crypto.createHash('sha256').update(differentData).digest('hex');

    const res = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': differentData.length,
          'Content-Range': `bytes 0-${64 * 1024 - 1}/${64 * 1024}`,
          'X-Chunk-SHA256': differentSha
        }
      },
      differentData
    );

    assert.equal(res.statusCode, 409);
    assert.equal(res.json.error.code, 'CHUNK_CONFLICT');
    // On-disk file remains untouched at 5 bytes
    assert.equal(fs.statSync(chunk0Path).size, 5);
  });

  await t.test(
    '2 parallel repair requests for the same damaged chunk -> one 201 repaired:true and one 200 duplicate:true, ledger still has exactly one record for that index, storage/temp empty',
    async () => {
      const initPayload = JSON.stringify({
        filename: 'parallel-repair.bin',
        size: 64 * 1024,
        contentType: 'application/octet-stream',
        chunkSize: 64 * 1024
      });
      const createRes = await makeRequest(
        port,
        {
          path: '/api/uploads',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(initPayload)
          }
        },
        initPayload
      );
      const uploadId = createRes.json.uploadId;

      const chunk0Data = crypto.randomBytes(64 * 1024);
      const chunk0Sha = crypto.createHash('sha256').update(chunk0Data).digest('hex');

      // Upload once
      await makeRequest(
        port,
        {
          path: `/api/uploads/${uploadId}/chunks/0`,
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': chunk0Data.length,
            'Content-Range': `bytes 0-${64 * 1024 - 1}/${64 * 1024}`,
            'X-Chunk-SHA256': chunk0Sha
          }
        },
        chunk0Data
      );

      // Now damage the chunk file by deleting it
      const chunk0Path = paths.chunkPath(uploadId, 0, tmpRoot);
      fs.unlinkSync(chunk0Path);

      // Fire 2 parallel repair requests
      const sendRepair = () =>
        makeRequest(
          port,
          {
            path: `/api/uploads/${uploadId}/chunks/0`,
            method: 'PUT',
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': chunk0Data.length,
              'Content-Range': `bytes 0-${64 * 1024 - 1}/${64 * 1024}`,
              'X-Chunk-SHA256': chunk0Sha
            }
          },
          chunk0Data
        );

      const [resA, resB] = await Promise.all([sendRepair(), sendRepair()]);

      const statusCodes = [resA.statusCode, resB.statusCode].sort();
      assert.deepEqual(statusCodes, [200, 201], 'One must be 201 (repaired) and one 200 (duplicate)');

      const rep = resA.statusCode === 201 ? resA : resB;
      const dup = resA.statusCode === 200 ? resA : resB;

      assert.equal(rep.json.repaired, true);
      assert.equal(dup.json.duplicate, true);

      // Ledger has exactly one record for index 0
      const metadata = await readMetadata(uploadId, tmpRoot);
      assert.equal(metadata.chunks.length, 1);
      assert.equal(metadata.chunks[0].index, 0);

      // storage/temp is empty
      const tempDir = paths.tempDir(tmpRoot);
      const tempFiles = fs.readdirSync(tempDir);
      assert.deepEqual(tempFiles, [], 'storage/temp must be completely empty');
    }
  );

  await t.test('clean up server', async () => {
    await app.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});
