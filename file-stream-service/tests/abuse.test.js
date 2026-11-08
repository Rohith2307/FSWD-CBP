const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const paths = require('../src/storage/paths');
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

function sendRawSocket(port, rawHttp) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const client = net.connect({ port, host: '127.0.0.1' }, () => {
      client.write(rawHttp);
    });

    const chunks = [];
    const finish = () => {
      if (resolved) return;
      if (chunks.length > 0) {
        resolved = true;
        const raw = Buffer.concat(chunks).toString('utf8');
        const lines = raw.split('\r\n');
        const statusLine = lines[0] || '';
        const match = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/);
        const statusCode = match ? parseInt(match[1], 10) : 0;
        return resolve({ statusCode, raw, lines });
      }
    };

    client.on('data', (c) => chunks.push(c));
    client.on('end', finish);
    client.on('close', finish);
    client.on('error', (err) => {
      if (chunks.length > 0) {
        return finish();
      }
      reject(err);
    });
  });
}

function listAllFiles(dir) {
  const result = [];
  if (!fs.existsSync(dir)) return result;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      result.push(...listAllFiles(full));
    } else {
      result.push(full);
    }
  }
  return result.sort();
}

test('B5: Abuse, limits, raw socket, and log sanitization tests', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-abuse-test-'));
  await paths.ensureStorageDirs(tmpRoot);

  t.after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const app = createServer({
    storageRoot: tmpRoot,
    cleanup: false,
    maxUploadBytes: 10 * 1024 * 1024, // 10 MiB
    maxChunkBytes: 2 * 1024 * 1024,   // 2 MiB
    minChunkBytes: 64 * 1024,         // 64 KiB
    maxFilenameLength: 100,
    maxJsonBodyBytes: 1024            // lowered to 1 KiB to test 413
  });

  const port = 62102;
  await app.start(port, '127.0.0.1');

  t.after(async () => {
    await app.stop();
  });

  await t.test('create validation: zero size -> 400, over max -> 413, chunk size bounds -> 400, long filename -> 400, large body -> 413', async () => {
    // Zero-byte size -> 400
    {
      const res = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ filename: 'zero.bin', size: 0, contentType: 'application/octet-stream', chunkSize: 65536 })
      );
      assert.equal(res.statusCode, 400, 'Zero size must return 400');
    }

    // Negative size -> 400
    {
      const res = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ filename: 'neg.bin', size: -100, contentType: 'application/octet-stream', chunkSize: 65536 })
      );
      assert.equal(res.statusCode, 400, 'Negative size must return 400');
    }

    // Size over maxUploadBytes (10 MiB) -> 413
    {
      const res = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ filename: 'large.bin', size: 11 * 1024 * 1024, contentType: 'application/octet-stream', chunkSize: 65536 })
      );
      assert.equal(res.statusCode, 413, 'Size exceeding maxUploadBytes must return 413');
    }

    // chunkSize below minChunkBytes (64 KiB) -> 400
    {
      const res = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ filename: 'smallchunk.bin', size: 100000, contentType: 'application/octet-stream', chunkSize: 1024 })
      );
      assert.equal(res.statusCode, 400, 'chunkSize below min must return 400');
    }

    // chunkSize above maxChunkBytes (2 MiB) -> 400
    {
      const res = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ filename: 'bigchunk.bin', size: 5000000, contentType: 'application/octet-stream', chunkSize: 3 * 1024 * 1024 })
      );
      assert.equal(res.statusCode, 400, 'chunkSize above max must return 400');
    }

    // Filename exceeding maxFilenameLength (100) -> 400
    {
      const longName = 'a'.repeat(101) + '.bin';
      const res = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ filename: longName, size: 100000, contentType: 'application/octet-stream', chunkSize: 65536 })
      );
      assert.equal(res.statusCode, 400, 'Filename exceeding max length must return 400');
    }

    // 10 KB JSON body with lowered maxJsonBodyBytes (1024) -> 413
    {
      const paddedBody = JSON.stringify({
        filename: 'pad.bin',
        size: 100000,
        contentType: 'application/octet-stream',
        chunkSize: 65536,
        padding: 'x'.repeat(10000)
      });
      const res = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        paddedBody
      );
      assert.equal(res.statusCode, 413, 'Body exceeding maxJsonBodyBytes must return 413');
      assert.equal(res.headers.connection, 'close');
    }
  });

  await t.test('chunk PUT abuse: Content-Length > maxChunkBytes -> 413 with Connection: close and nothing on disk', async () => {
    // Create valid session
    const createRes = await makeRequest(
      port,
      { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ filename: 'toolargechunk.bin', size: 5 * 1024 * 1024, contentType: 'application/octet-stream', chunkSize: 1024 * 1024 })
    );
    assert.equal(createRes.statusCode, 201);
    const uploadId = createRes.json.uploadId;

    const oversizedLength = 3 * 1024 * 1024; // > 2 MiB maxChunkBytes
    const dummyData = Buffer.alloc(100); // Only send 100 bytes of headers/preview

    const putRes = await makeRequest(
      port,
      {
        path: `/api/uploads/${uploadId}/chunks/0`,
        method: 'PUT',
        headers: {
          'Content-Length': String(oversizedLength),
          'Content-Range': `bytes 0-${oversizedLength - 1}/5242880`,
          'X-Chunk-SHA256': crypto.createHash('sha256').update(dummyData).digest('hex')
        }
      },
      dummyData
    );

    assert.equal(putRes.statusCode, 413, 'Oversized declared chunk must return 413');
    assert.equal(putRes.headers.connection, 'close');

    // Verify nothing left in temp directory
    const tempFiles = fs.readdirSync(paths.tempDir(tmpRoot)).filter((f) => f.startsWith(uploadId));
    assert.equal(tempFiles.length, 0, 'No temp file must exist for rejected oversized chunk');
  });

  await t.test('chunk PUT using Transfer-Encoding: chunked with no Content-Length -> 400 (raw socket)', async () => {
    const createRes = await makeRequest(
      port,
      { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ filename: 'no-cl.bin', size: 100000, contentType: 'application/octet-stream', chunkSize: 65536 })
    );
    assert.equal(createRes.statusCode, 201);
    const uploadId = createRes.json.uploadId;

    const fakeSha = crypto.createHash('sha256').update(Buffer.alloc(100)).digest('hex');
    const rawReq =
      `PUT /api/uploads/${uploadId}/chunks/0 HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Transfer-Encoding: chunked\r\n` +
      `Content-Range: bytes 0-99/100000\r\n` +
      `X-Chunk-SHA256: ${fakeSha}\r\n` +
      `Connection: close\r\n\r\n` +
      `64\r\n` +
      'a'.repeat(100) +
      `\r\n` +
      `0\r\n\r\n`;

    const res = await sendRawSocket(port, rawReq);
    assert.equal(res.statusCode, 400, 'Chunked transfer encoding without Content-Length must return 400');
  });

  await t.test('duplicate / conflicting Content-Range headers or trailing garbage -> 400', async () => {
    const createRes = await makeRequest(
      port,
      { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ filename: 'bad-cr.bin', size: 100000, contentType: 'application/octet-stream', chunkSize: 65536 })
    );
    assert.equal(createRes.statusCode, 201);
    const uploadId = createRes.json.uploadId;

    // Trailing garbage in Content-Range
    {
      const fakeSha = crypto.createHash('sha256').update(Buffer.alloc(100)).digest('hex');
      const res = await makeRequest(
        port,
        {
          path: `/api/uploads/${uploadId}/chunks/0`,
          method: 'PUT',
          headers: {
            'Content-Length': '100',
            'Content-Range': 'bytes 0-99/100000 trailing_garbage',
            'X-Chunk-SHA256': fakeSha
          }
        },
        Buffer.alloc(100)
      );
      assert.equal(res.statusCode, 400, 'Trailing garbage in Content-Range must return 400');
    }

    // Duplicate conflicting Content-Range headers via raw socket
    {
      const fakeSha = crypto.createHash('sha256').update(Buffer.alloc(100)).digest('hex');
      const rawReq =
        `PUT /api/uploads/${uploadId}/chunks/0 HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Content-Length: 100\r\n` +
        `Content-Range: bytes 0-99/100000\r\n` +
        `Content-Range: bytes 100-199/100000\r\n` +
        `X-Chunk-SHA256: ${fakeSha}\r\n` +
        `Connection: close\r\n\r\n` +
        'x'.repeat(100);

      const res = await sendRawSocket(port, rawReq);
      assert.equal(res.statusCode, 400, 'Duplicate Content-Range headers must return 400');
    }
  });

  await t.test('filename with CRLF / control characters never appears raw in Content-Disposition', async () => {
    const dirtyName = "video\r\nSet-Cookie: evil=true\r\n\x00\x1b[31m.mp4";
    const chunkSize = 65536;
    const totalSize = 65536;

    const createRes = await makeRequest(
      port,
      { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ filename: dirtyName, size: totalSize, contentType: 'video/mp4', chunkSize })
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

    const finRes = await makeRequest(
      port,
      { path: `/api/uploads/${uploadId}/finalize`, method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ sha256: chunkSha })
    );
    assert.equal(finRes.statusCode, 200);
    const mediaId = finRes.json.mediaId;

    // Fetch media with HEAD
    const headRes = await makeRequest(port, { path: `/api/media/${mediaId}`, method: 'HEAD' });
    assert.equal(headRes.statusCode, 200);
    const cd = headRes.headers['content-disposition'];
    assert.ok(cd, 'Content-Disposition header must be present');
    assert.ok(!cd.includes('\r'), 'CR must not appear raw in Content-Disposition');
    assert.ok(!cd.includes('\n'), 'LF must not appear raw in Content-Disposition');
    assert.ok(!cd.includes('\x00'), 'NUL byte must not appear raw in Content-Disposition');
    assert.ok(!cd.includes('\x1b'), 'Escape control byte must not appear raw in Content-Disposition');
  });

  await t.test('300 fuzz tests for :id and :index across parameterized routes never return 5xx or 2xx and disk is unchanged', async () => {
    const fuzzRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-fuzz-test-'));
    await paths.ensureStorageDirs(fuzzRoot);
    const fuzzApp = createServer({ storageRoot: fuzzRoot, cleanup: false });
    const fuzzPort = 62104;
    await fuzzApp.start(fuzzPort, '127.0.0.1');

    try {
      const beforeFiles = listAllFiles(fuzzRoot);

      const fuzzTokens = [
        '..',
        '../..',
        '../../..',
        '%2e%2e',
        '%2e%2e%2f',
        '%2e%2e/',
        '..%2f',
        '..\\..',
        '..\\\\..',
        '\\',
        '/',
        '%00',
        '\x00',
        'null',
        'undefined',
        'NaN',
        '0',
        '-1',
        '-99999',
        '1.5',
        '1e10',
        '9999999999999999999999999999999999999999',
        'a'.repeat(255),
        'b'.repeat(1024),
        '🌟🔥🚀🎉',
        'test/../secret',
        '....//....//',
        '%ff%fe%fd',
        '`id`',
        '$(whoami)',
        '; rm -rf / ;',
        '| cat /etc/passwd',
        '""',
        "''",
        '<script>alert(1)</script>',
        '\r\n',
        '\r\n\r\n',
        '   ',
        '\t',
        '\n',
        '../storage/media',
        '../storage/temp',
        'c:\\windows\\system32',
        'CON',
        'PRN',
        'AUX',
        'NUL'
      ];

      // Expand to >= 300 fuzz cases
      const fuzzCases = [];
      while (fuzzCases.length < 300) {
        for (const token of fuzzTokens) {
          if (fuzzCases.length >= 300) break;
          fuzzCases.push(token);
          if (fuzzCases.length >= 300) break;
          fuzzCases.push(token + '_' + fuzzCases.length);
        }
      }

      assert.ok(fuzzCases.length >= 300, `Must test at least 300 fuzz inputs, got ${fuzzCases.length}`);

      const dummyUploadId = '00000000-0000-4000-8000-000000000000';

      // Test across routes to achieve >= 300 distinct HTTP requests
      for (let i = 0; i < 300; i++) {
        const fuzz = fuzzCases[i];
        const encoded = encodeURIComponent(fuzz);

        let res;
        const mod = i % 6;
        if (mod === 0) {
          res = await makeRequest(fuzzPort, { path: `/api/uploads/${encoded}`, method: 'GET' });
        } else if (mod === 1) {
          res = await makeRequest(fuzzPort, { path: `/api/uploads/${encoded}/finalize`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, '{}');
        } else if (mod === 2) {
          res = await makeRequest(fuzzPort, { path: `/api/metrics/${encoded}`, method: 'GET' });
        } else if (mod === 3) {
          res = await makeRequest(fuzzPort, { path: `/api/media/${encoded}`, method: 'GET' });
        } else if (mod === 4) {
          res = await makeRequest(fuzzPort, { path: `/api/uploads/${encoded}/chunks/0`, method: 'PUT', headers: { 'Content-Length': '10', 'Content-Range': 'bytes 0-9/100000', 'X-Chunk-SHA256': 'a'.repeat(64) } }, '0123456789');
        } else {
          res = await makeRequest(fuzzPort, { path: `/api/uploads/${dummyUploadId}/chunks/${encoded}`, method: 'PUT', headers: { 'Content-Length': '10', 'Content-Range': 'bytes 0-9/100000', 'X-Chunk-SHA256': 'a'.repeat(64) } }, '0123456789');
        }

        assert.ok(
          res.statusCode >= 400 && res.statusCode < 500,
          `Fuzz case ${i} ("${fuzz}") against route returned ${res.statusCode}, expected 4xx`
        );
      }

      const afterFiles = listAllFiles(fuzzRoot);
      assert.deepEqual(afterFiles, beforeFiles, 'Storage directory listing must remain unchanged after fuzz testing');
    } finally {
      await fuzzApp.stop();
      fs.rmSync(fuzzRoot, { recursive: true, force: true });
    }
  });

  await t.test('slow client stalling after headers: server closes connection, temp file removed, server healthy', async () => {
    // Create server with short requestTimeout
    const slowServerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-slow-test-'));
    await paths.ensureStorageDirs(slowServerRoot);

    const slowApp = createServer({
      storageRoot: slowServerRoot,
      cleanup: false,
      requestTimeoutMs: 250, // 250 ms timeout
      headersTimeoutMs: 200
    });

    const slowPort = 62103;
    await slowApp.start(slowPort, '127.0.0.1');

    try {
      const createRes = await makeRequest(
        slowPort,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ filename: 'slow.bin', size: 200000, contentType: 'application/octet-stream', chunkSize: 100000 })
      );
      assert.equal(createRes.statusCode, 201);
      const uploadId = createRes.json.uploadId;

      const fakeSha = crypto.createHash('sha256').update(Buffer.alloc(100000)).digest('hex');

      // Connect raw socket and send headers, then stall
      await new Promise((resolve) => {
        const client = net.connect({ port: slowPort, host: '127.0.0.1' }, () => {
          client.write(
            `PUT /api/uploads/${uploadId}/chunks/0 HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${slowPort}\r\n` +
            `Content-Length: 100000\r\n` +
            `Content-Range: bytes 0-99999/200000\r\n` +
            `X-Chunk-SHA256: ${fakeSha}\r\n\r\n` +
            'partial_bytes'
          );
          // Stall and do not write further bytes
        });

        client.on('close', resolve);
        client.on('error', () => resolve());
      });

      // Give a tiny grace for server cleanup
      await new Promise((r) => setTimeout(r, 100));

      // Temp file must be unlinked
      const tempFiles = fs.readdirSync(paths.tempDir(slowServerRoot)).filter((f) => f.startsWith(uploadId));
      assert.equal(tempFiles.length, 0, 'Temp file must be unlinked when slow client times out');

      // Server remains healthy
      const healthRes = await makeRequest(slowPort, { path: '/health', method: 'GET' });
      assert.equal(healthRes.statusCode, 200, 'Server must remain healthy after slow client timeout');
    } finally {
      await slowApp.stop();
      fs.rmSync(slowServerRoot, { recursive: true, force: true });
    }
  });

  await t.test('logs never contain original filename or absolute storageRoot path', async () => {
    const secretFilename = 'SECRETNAME-xyz-887766.mp4';
    const capturedLogs = [];

    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    console.log = (...args) => {
      capturedLogs.push(args.map(String).join(' '));
      originalLog.apply(console, args);
    };
    console.error = (...args) => {
      capturedLogs.push(args.map(String).join(' '));
      originalError.apply(console, args);
    };
    console.warn = (...args) => {
      capturedLogs.push(args.map(String).join(' '));
      originalWarn.apply(console, args);
    };

    try {
      // 1. Create upload with secret filename
      const createRes = await makeRequest(
        port,
        { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ filename: secretFilename, size: 65536, contentType: 'video/mp4', chunkSize: 65536 })
      );
      assert.equal(createRes.statusCode, 201);
      const uploadId = createRes.json.uploadId;

      // 2. PUT chunk
      const chunkData = crypto.randomBytes(65536);
      const chunkSha = crypto.createHash('sha256').update(chunkData).digest('hex');
      const putRes = await makeRequest(
        port,
        {
          path: `/api/uploads/${uploadId}/chunks/0`,
          method: 'PUT',
          headers: {
            'Content-Length': '65536',
            'Content-Range': 'bytes 0-65535/65536',
            'X-Chunk-SHA256': chunkSha
          }
        },
        chunkData
      );
      assert.equal(putRes.statusCode, 201);

      // 3. Finalize upload
      const finRes = await makeRequest(
        port,
        { path: `/api/uploads/${uploadId}/finalize`, method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ sha256: chunkSha })
      );
      assert.equal(finRes.statusCode, 200);
      const mediaId = finRes.json.mediaId;

      // 4. GET media
      const getMediaRes = await makeRequest(port, { path: `/api/media/${mediaId}`, method: 'GET' });
      assert.equal(getMediaRes.statusCode, 200);

      // 5. Trigger errors: 400, 404, 413, 422
      await makeRequest(port, { path: '/api/uploads', method: 'POST', headers: { 'Content-Type': 'application/json' } }, 'not-json');
      await makeRequest(port, { path: '/api/uploads/00000000-0000-4000-8000-000000000000', method: 'GET' });
      await makeRequest(port, { path: `/api/uploads/${uploadId}/chunks/0`, method: 'PUT', headers: { 'Content-Length': '10', 'Content-Range': 'bytes 0-9/65536', 'X-Chunk-SHA256': 'bad' } }, '0123456789');
    } finally {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    }

    assert.ok(capturedLogs.length > 0, 'Logs must have been captured');

    for (const logLine of capturedLogs) {
      assert.ok(
        !logLine.includes(secretFilename),
        `Log line must not contain original filename: "${logLine}"`
      );
      assert.ok(
        !logLine.includes(tmpRoot),
        `Log line must not contain storageRoot path: "${logLine}"`
      );
    }
  });
});
