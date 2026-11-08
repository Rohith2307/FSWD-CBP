const { Buffer } = require('node:buffer');
const {
  HttpError,
  badRequest,
  payloadTooLarge,
  unsupportedMediaType
} = require('./httpErrors');

/**
 * Sends a JSON response with standard security and content headers.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} body
 * @param {Record<string, string>} [extraHeaders={}]
 */
function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent) {
    return;
  }

  const jsonString = JSON.stringify(body);
  const payloadBuffer = Buffer.from(jsonString, 'utf8');

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payloadBuffer.length,
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  };

  res.writeHead(status, headers);
  res.end(payloadBuffer);
}

/**
 * Sends a structured JSON error response.
 * Non-HttpErrors are normalized to 500 Internal Server Error without leaking internal paths or stack traces.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {Error|HttpError} err
 */
function sendError(res, err) {
  if (res.headersSent) {
    if (!res.destroyed) {
      res.destroy(err);
    }
    return;
  }

  if (err instanceof HttpError) {
    const statusCode = err.statusCode || 500;
    const body = {
      error: {
        code: err.code || 'ERROR',
        message: err.message,
        details: err.details !== undefined ? err.details : null
      }
    };
    sendJson(res, statusCode, body, err.headers || {});
  } else if (err && (err.code === 'ENOSPC' || err.code === 'EDQUOT')) {
    console.error(`[ServerError] Storage error: ${err.code}`);
    sendJson(res, 507, {
      error: {
        code: 'INSUFFICIENT_STORAGE',
        message: 'Server storage is full',
        details: null
      }
    });
  } else if (
    err &&
    (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS' || err.code === 'EIO')
  ) {
    console.error(`[ServerError] Filesystem error: ${err.code}`);
    sendJson(res, 500, {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal Server Error',
        details: null
      }
    });
  } else {
    // Log unexpected errors server-side with code or message only, never leaking filesystem paths
    console.error('[ServerError]', err?.code ? `Error code: ${err.code}` : (err?.message || 'Unknown error'));

    const body = {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal Server Error',
        details: null
      }
    };
    sendJson(res, 500, body);
  }
}

/**
 * Streams and parses an incoming JSON request body with strict byte limits and Content-Type validation.
 * Memory is strictly bounded: chunks are never buffered beyond maxBytes.
 * When payload exceeds maxBytes, rejects with 413 and "Connection: close".
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<any>}
 */
function readJsonBody(req, maxBytes) {
  if (req.body !== undefined) {
    return Promise.resolve(req.body);
  }

  const contentType = req.headers['content-type'];
  if (!contentType) {
    return Promise.reject(
      unsupportedMediaType('Missing Content-Type header. Expected application/json')
    );
  }

  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (mime !== 'application/json') {
    return Promise.reject(
      unsupportedMediaType(`Unsupported Content-Type "${mime}". Expected application/json`)
    );
  }

  const contentLength = req.headers['content-length'];
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isSafeInteger(declaredBytes) && declaredBytes > maxBytes) {
      return Promise.reject(
        payloadTooLarge(
          `Payload size (${declaredBytes} bytes) exceeds limit of ${maxBytes} bytes`,
          null,
          { Connection: 'close' }
        )
      );
    }
  }

  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks = [];
    let aborted = false;

    function cleanup() {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
    }

    function onData(chunk) {
      if (aborted) return;
      totalBytes += chunk.length;

      // Abort immediately if byte budget exceeded; do not buffer excess bytes into memory
      if (totalBytes > maxBytes) {
        aborted = true;
        cleanup();
        req.pause();
        reject(
          payloadTooLarge(
            `Payload size exceeded limit of ${maxBytes} bytes`,
            null,
            { Connection: 'close' }
          )
        );
        return;
      }

      chunks.push(chunk);
    }

    function onEnd() {
      if (aborted) return;
      cleanup();

      // Explicitly handle empty request bodies
      if (totalBytes === 0 || chunks.length === 0) {
        reject(badRequest('Request body cannot be empty'));
        return;
      }

      const raw = Buffer.concat(chunks, totalBytes).toString('utf8');
      try {
        const parsed = JSON.parse(raw);
        req.body = parsed;
        resolve(parsed);
      } catch (parseErr) {
        reject(badRequest(`Malformed JSON body: ${parseErr.message}`));
      }
    }

    function onError(err) {
      if (aborted) return;
      aborted = true;
      cleanup();
      reject(err);
    }

    function onClose() {
      if (aborted) return;
      if (!req.readableEnded) {
        aborted = true;
        cleanup();
        reject(badRequest('Client connection closed before body was fully received'));
      }
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

/**
 * Reads an optional JSON body.
 * If there is no body (Content-Length 0/absent and no Transfer-Encoding), drains and returns {}.
 * Otherwise behaves like readJsonBody: enforces Content-Type, byte cap, and requires a JSON object.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Record<string, any>>}
 */
async function readOptionalJsonBody(req, maxBytes) {
  const contentLength = req.headers['content-length'];
  const transferEncoding = req.headers['transfer-encoding'];

  // No body condition: Content-Length is '0', or Content-Length is absent and no Transfer-Encoding
  if (
    contentLength === '0' ||
    (contentLength === undefined && !transferEncoding)
  ) {
    req.resume();
    return {};
  }

  const parsed = await readJsonBody(req, maxBytes);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw badRequest('Request body must be a JSON object');
  }

  return parsed;
}

module.exports = {
  sendJson,
  sendError,
  readJsonBody,
  readOptionalJsonBody
};
