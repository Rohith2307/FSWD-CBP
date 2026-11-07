const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const { readJsonBody, readOptionalJsonBody, sendJson, sendError } = require('../src/utils/http');
const { badRequest } = require('../src/utils/httpErrors');

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

test('readOptionalJsonBody utility tests', async (t) => {
  let server;
  let port;

  await t.test('start helper server', async () => {
    server = http.createServer(async (req, res) => {
      try {
        const body = await readOptionalJsonBody(req, 256);
        sendJson(res, 200, { parsed: body });
      } catch (err) {
        sendError(res, err);
      }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  await t.test('no body (absent Content-Length and no Transfer-Encoding) -> returns {}', async () => {
    const res = await makeRequest(port, { method: 'POST' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json.parsed, {});
  });

  await t.test('no body (Content-Length: 0) -> returns {}', async () => {
    const res = await makeRequest(port, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': 0
      }
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json.parsed, {});
  });

  await t.test('valid JSON object body -> returns parsed object', async () => {
    const payload = JSON.stringify({ key: 'value', count: 10 });
    const res = await makeRequest(
      port,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      payload
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json.parsed, { key: 'value', count: 10 });
  });

  await t.test('malformed JSON body -> 400 Bad Request', async () => {
    const payload = '{"bad": json';
    const res = await makeRequest(
      port,
      {
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

  await t.test('oversized JSON body (>256 bytes) -> 413 Payload Too Large', async () => {
    const payload = JSON.stringify({ data: 'x'.repeat(300) });
    const res = await makeRequest(
      port,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      payload
    );
    assert.equal(res.statusCode, 413);
    assert.equal(res.json.error.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(res.headers['connection'], 'close');
  });

  await t.test('non-object JSON array -> 400 Bad Request', async () => {
    const payload = JSON.stringify([1, 2, 3]);
    const res = await makeRequest(
      port,
      {
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
    assert.match(res.json.error.message, /must be a JSON object/i);
  });

  await t.test('non-object JSON primitive (string, number, null) -> 400 Bad Request', async () => {
    for (const val of ['"string"', '42', 'null']) {
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(val)
          }
        },
        val
      );
      assert.equal(res.statusCode, 400);
      assert.equal(res.json.error.code, 'BAD_REQUEST');
    }
  });

  await t.test('stop helper server', async () => {
    await new Promise((resolve) => server.close(resolve));
  });
});

test('http - sendJson sets correct headers and formats body', () => {
  let writtenStatus = null;
  let writtenHeaders = null;
  let writtenBody = null;

  const mockRes = {
    writeHead(status, headers) {
      writtenStatus = status;
      writtenHeaders = headers;
    },
    end(body) {
      writtenBody = body;
    }
  };

  sendJson(mockRes, 201, { success: true, count: 5 });

  assert.equal(writtenStatus, 201);
  assert.equal(writtenHeaders['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(writtenHeaders['X-Content-Type-Options'], 'nosniff');
  assert.equal(writtenHeaders['Content-Length'], Buffer.byteLength(writtenBody));
  assert.deepEqual(JSON.parse(writtenBody), { success: true, count: 5 });
});

test('http - readJsonBody successfully parses valid JSON payload', async () => {
  const payload = JSON.stringify({ hello: 'world', number: 123 });
  const stream = Readable.from([Buffer.from(payload)]);
  stream.headers = { 'content-type': 'application/json' };

  const parsed = await readJsonBody(stream, 1024);
  assert.deepEqual(parsed, { hello: 'world', number: 123 });
});

test('http - readJsonBody rejects invalid JSON syntax with 400 badRequest', async () => {
  const stream = Readable.from([Buffer.from('{"bad": json')]);
  stream.headers = { 'content-type': 'application/json' };

  await assert.rejects(
    async () => {
      await readJsonBody(stream, 1024);
    },
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'BAD_REQUEST');
      assert.match(err.message, /malformed json body/i);
      return true;
    }
  );
});

test('http - readJsonBody enforces byte limit and rejects oversized payload with 413', async () => {
  const payload = JSON.stringify({ data: 'x'.repeat(200) });
  const stream = Readable.from([Buffer.from(payload)]);
  stream.headers = { 'content-type': 'application/json' };

  await assert.rejects(
    async () => {
      await readJsonBody(stream, 64);
    },
    (err) => {
      assert.equal(err.statusCode, 413);
      assert.equal(err.code, 'PAYLOAD_TOO_LARGE');
      assert.equal(err.headers && err.headers['Connection'], 'close');
      return true;
    }
  );
});

test('http - sendError sets status and JSON body with errorCode', () => {
  let writtenStatus = null;
  let writtenHeaders = null;
  let writtenBody = null;

  const mockRes = {
    writeHead(status, headers) {
      writtenStatus = status;
      writtenHeaders = headers;
    },
    end(body) {
      writtenBody = body;
    }
  };

  const err = badRequest('Custom client error message');
  sendError(mockRes, err);

  assert.equal(writtenStatus, 400);
  assert.equal(writtenHeaders['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(writtenHeaders['X-Content-Type-Options'], 'nosniff');
  const body = JSON.parse(writtenBody);
  assert.equal(body.error.code, 'BAD_REQUEST');
  assert.equal(body.error.message, 'Custom client error message');
});

test('http - sendError translates unexpected errors to 500 internal', () => {
  let writtenStatus = null;
  let writtenHeaders = null;
  let writtenBody = null;

  const mockRes = {
    writeHead(status, headers) {
      writtenStatus = status;
      writtenHeaders = headers;
    },
    end(body) {
      writtenBody = body;
    }
  };

  const unexpectedErr = new Error('Database disk exploded on /secret/path');
  sendError(mockRes, unexpectedErr);

  assert.equal(writtenStatus, 500);
  assert.equal(writtenHeaders['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(writtenHeaders['X-Content-Type-Options'], 'nosniff');
  const body = JSON.parse(writtenBody);
  assert.equal(body.error.code, 'INTERNAL_SERVER_ERROR');
  assert.equal(body.error.message, 'Internal Server Error');
  assert.ok(!writtenBody.includes('/secret/path'), 'Must not leak unexpected error message');
});
