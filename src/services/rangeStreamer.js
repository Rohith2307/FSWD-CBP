const fs = require('node:fs');
const { pipeline, Transform } = require('node:stream');
const { sendError } = require('../utils/http');
const { badRequest, rangeNotSatisfiable } = require('../utils/httpErrors');

/**
 * HTTP Range Request Streamer & Parser
 *
 * Architectural & Protocol Design Notes:
 *
 * 1. Why 416 must carry "Content-Range: bytes *\/S":
 *    Per RFC 9110 Section 14.4, when a server rejects a Range request with 416 (Range Not Satisfiable),
 *    it MUST include a Content-Range header indicating the current complete representation length
 *    ("bytes *\/<size>"). This informs media players and download managers of the valid file length so they
 *    can re-calculate and issue a valid byte range.
 *
 * 2. Why HTTP byte ranges are inclusive (contrast with Blob.prototype.slice):
 *    HTTP Range headers specify inclusive start and end byte offsets: "bytes=0-1023" transmits exactly
 *    1024 bytes (bytes 0 through 1023 inclusive). In contrast, JavaScript Array and Blob slices use
 *    half-open intervals [start, end) where end is exclusive (blob.slice(0, 1024)).
 *
 * 3. Why malformed and unsatisfiable ranges never degrade to a full 200:
 *    If an invalid or unsatisfiable range was silently degraded to 200 OK with the full file body,
 *    a video player seeking towards the end of a 2 GiB video would inadvertently trigger a multi-gigabyte
 *    transfer, exhausting client bandwidth and introducing stalling. Returning 400 or 416 stops transfer immediately.
 *
 * 4. Why we wait for the read stream's 'open' event before writing HTTP headers:
 *    Node.js HTTP responses cannot alter headers or status codes once writeHead() is called.
 *    By deferring writeHead() until the file descriptor has successfully opened, any open-time I/O error
 *    (e.g., file deleted between stat and open) can be intercepted and answered with a clean 404/500 JSON error.
 *
 * 5. Why multi-range ("bytes=0-10,20-30") is deliberately served as 200:
 *    Multipart byte ranges require multipart/byteranges framing with boundary delimiters and sub-headers.
 *    Modern HTML5 <video> and <audio> players exclusively issue single contiguous ranges during seeking.
 *    Per RFC 9110 §14.2, servers are permitted to ignore a Range header and return 200 full content when
 *    a range form is unsupported. Serving 200 full content avoids multipart complexity while preserving compatibility.
 */

/**
 * Formats standard Content-Range header for a successful 206 range response.
 *
 * @param {number} start
 * @param {number} end
 * @param {number} size
 * @returns {string}
 */
function contentRangeHeader(start, end, size) {
  return `bytes ${start}-${end}/${size}`;
}

/**
 * Formats Content-Range header for a 416 Range Not Satisfiable response.
 *
 * @param {number} size
 * @returns {string}
 */
function unsatisfiedRangeHeader(size) {
  return `bytes */${size}`;
}

/**
 * Parses an HTTP Range header value against the known resource size.
 * Pure function: does no I/O, uses integer math only.
 *
 * @param {string|null|undefined} headerValue
 * @param {number} size - Total representation size in bytes
 * @returns {{ kind: "none" } | { kind: "multi" } | { kind: "malformed" } | { kind: "unsatisfiable" } | { kind: "range", start: number, end: number }}
 */
function parseRangeHeader(headerValue, size) {
  if (typeof headerValue !== 'string' || !headerValue) {
    return { kind: 'none' };
  }

  const trimmed = headerValue.trim();
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) {
    return { kind: 'none' };
  }

  const unit = trimmed.slice(0, eqIdx).trim().toLowerCase();
  if (unit !== 'bytes') {
    return { kind: 'none' };
  }

  const rangeSpec = trimmed.slice(eqIdx + 1);
  if (!rangeSpec || !rangeSpec.trim()) {
    return { kind: 'malformed' };
  }

  // Detect multi-range requests (comma separated)
  if (rangeSpec.includes(',')) {
    return { kind: 'multi' };
  }

  // A valid single range must contain exactly one hyphen
  const hyphenCount = (rangeSpec.match(/-/g) || []).length;
  if (hyphenCount !== 1) {
    return { kind: 'malformed' };
  }

  const dashIndex = rangeSpec.indexOf('-');
  const startStr = rangeSpec.slice(0, dashIndex);
  const endStr = rangeSpec.slice(dashIndex + 1);

  // Suffix byte range: "-n" (e.g. bytes=-500)
  if (startStr === '') {
    if (!/^\d+$/.test(endStr)) {
      return { kind: 'malformed' };
    }

    if (endStr.length > 16 || Number(endStr) > Number.MAX_SAFE_INTEGER) {
      return { kind: 'unsatisfiable' };
    }

    const n = Number(endStr);
    if (n === 0 || size <= 0) {
      return { kind: 'unsatisfiable' };
    }

    if (n >= size) {
      return { kind: 'range', start: 0, end: size - 1 };
    }

    return { kind: 'range', start: size - n, end: size - 1 };
  }

  // Open-ended byte range: "a-" (e.g. bytes=500-)
  if (endStr === '') {
    if (!/^\d+$/.test(startStr)) {
      return { kind: 'malformed' };
    }

    if (startStr.length > 16 || Number(startStr) > Number.MAX_SAFE_INTEGER) {
      return { kind: 'unsatisfiable' };
    }

    const a = Number(startStr);
    if (a >= size || size <= 0) {
      return { kind: 'unsatisfiable' };
    }

    return { kind: 'range', start: a, end: size - 1 };
  }

  // Explicit byte range: "a-b" (e.g. bytes=0-1023)
  if (!/^\d+$/.test(startStr) || !/^\d+$/.test(endStr)) {
    return { kind: 'malformed' };
  }

  if (
    startStr.length > 16 ||
    endStr.length > 16 ||
    Number(startStr) > Number.MAX_SAFE_INTEGER ||
    Number(endStr) > Number.MAX_SAFE_INTEGER
  ) {
    return { kind: 'unsatisfiable' };
  }

  const a = Number(startStr);
  const b = Number(endStr);

  if (a > b) {
    return { kind: 'malformed' };
  }

  if (a >= size || size <= 0) {
    return { kind: 'unsatisfiable' };
  }

  const end = Math.min(b, size - 1);
  return { kind: 'range', start: a, end };
}

/**
 * Builds Content-Disposition header with sanitized ASCII fallback and RFC 5987 UTF-8 encoding.
 *
 * @param {string} originalName
 * @param {boolean} forceDownload
 * @param {string} contentType
 * @returns {string}
 */
function buildContentDisposition(originalName, forceDownload = false, contentType = '') {
  const isAttachment = forceDownload || contentType === 'application/octet-stream';
  const dispositionType = isAttachment ? 'attachment' : 'inline';

  const rawName = typeof originalName === 'string' && originalName ? originalName : 'media';
  // ASCII fallback: replace quotes, backslashes, CR, LF, controls and non-ASCII with '_'
  const asciiFallback = rawName.replace(/[^\x20-\x7E]|["\\\r\n]/g, '_');
  // Percent-encode for filename*=UTF-8'' with extra encoding for ' ( ) *
  const utf8Encoded = encodeURIComponent(rawName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );

  return `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}

/**
 * Tests If-None-Match header value against strong ETag using weak comparison.
 *
 * @param {string|undefined} ifNoneMatch
 * @param {string} sha256
 * @returns {boolean}
 */
function testIfNoneMatch(ifNoneMatch, sha256) {
  if (!ifNoneMatch) return false;
  const trimmed = ifNoneMatch.trim();
  if (trimmed === '*') return true;

  const target = sha256.toLowerCase();
  const tags = trimmed.split(',').map((t) => t.trim());
  for (const tag of tags) {
    const clean = tag.replace(/^W\//i, '').replace(/^"|"$/g, '').toLowerCase();
    if (clean === target) {
      return true;
    }
  }
  return false;
}

/**
 * Tests If-Range header value against ETag and Last-Modified date.
 * Per RFC 9110 §13.1.2:
 * An If-Range header MUST be an exact quoted strong entity-tag or an HTTP-date.
 * Weak entity-tags (prefixed with W/) and unquoted entity-tags MUST NOT match,
 * causing the server to ignore the Range header and return a 200 full representation.
 *
 * @param {string|undefined} ifRange
 * @param {string} etagStr
 * @param {string} lastModifiedStr
 * @returns {boolean}
 */
function testIfRange(ifRange, etagStr, lastModifiedStr) {
  if (!ifRange) return true; // No If-Range: evaluate Range normally
  const trimmed = ifRange.trim();
  // Weak validators (W/"...") must never match in If-Range
  if (trimmed.startsWith('W/') || trimmed.startsWith('w/')) {
    return false;
  }
  // Exact match on quoted strong ETag only (unquoted tag string must NOT match)
  if (trimmed === etagStr) {
    return true;
  }
  // Exact match on HTTP-date string
  if (trimmed === lastModifiedStr) {
    return true;
  }
  return false;
}

/**
 * Serves media content with full HTTP Range (200/206/416), conditionals (304), HEAD support,
 * safe Content-Disposition, and bounded memory streaming.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} options
 * @param {object} options.record
 * @param {string} options.filePath
 * @param {number} options.size
 * @param {Function} [options.onServed]
 */
function serveMedia(req, res, { record, filePath, size, onServed }) {
  const etag = `"${record.sha256}"`;
  const lastModified = new Date(record.createdAt).toUTCString();
  const forceDownload = req.query && req.query.download === '1';
  const contentDisposition = buildContentDisposition(
    record.originalName,
    forceDownload,
    record.contentType
  );

  const baseHeaders = {
    'Content-Type': record.contentType,
    'Accept-Ranges': 'bytes',
    'ETag': etag,
    'Last-Modified': lastModified,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': contentDisposition
  };

  // 1. Conditional handling: If-None-Match (returns 304 Not Modified)
  if (req.headers['if-none-match'] && testIfNoneMatch(req.headers['if-none-match'], record.sha256)) {
    res.writeHead(304, baseHeaders);
    res.end();
    if (onServed) {
      onServed({
        bytesSent: 0,
        status: 304,
        rangeStart: null,
        rangeEnd: null,
        aborted: false,
        method: req.method
      });
    }
    return;
  }

  // 2. Evaluate Range header with If-Range conditional check
  let rangeResult = { kind: 'none' };
  if (req.headers.range) {
    const isIfRangeMatching = testIfRange(req.headers['if-range'], etag, lastModified);
    if (isIfRangeMatching) {
      rangeResult = parseRangeHeader(req.headers.range, size);
    } else {
      // If-Range failed to match: serve full representation (kind "none")
      rangeResult = { kind: 'none' };
    }
  }

  // 3. Handle malformed range -> 400
  if (rangeResult.kind === 'malformed') {
    sendError(res, badRequest('Malformed Range header'));
    return;
  }

  // 4. Handle unsatisfiable range -> 416
  if (rangeResult.kind === 'unsatisfiable') {
    const err = rangeNotSatisfiable('Requested range not satisfiable');
    err.headers = {
      'Content-Range': unsatisfiedRangeHeader(size),
      'Accept-Ranges': 'bytes',
      'ETag': etag,
      'Last-Modified': lastModified
    };
    sendError(res, err);
    return;
  }

  // 5. Determine response status and byte interval
  let status = 200;
  let startOffset = 0;
  let endOffset = size - 1;
  let contentLength = size;
  const headers = { ...baseHeaders };

  if (rangeResult.kind === 'range') {
    status = 206;
    startOffset = rangeResult.start;
    endOffset = rangeResult.end;
    contentLength = endOffset - startOffset + 1;
    headers['Content-Range'] = contentRangeHeader(startOffset, endOffset, size);
  }

  headers['Content-Length'] = contentLength;

  // 6. Handle HEAD request (no body)
  if (req.method === 'HEAD') {
    res.writeHead(status, headers);
    res.end();
    if (onServed) {
      onServed({
        bytesSent: 0,
        status,
        rangeStart: status === 206 ? startOffset : null,
        rangeEnd: status === 206 ? endOffset : null,
        aborted: false,
        method: req.method
      });
    }
    return;
  }

  // 7. Stream file content with bounded memory and backpressure
  const readStream = fs.createReadStream(filePath, {
    start: startOffset,
    end: endOffset,
    highWaterMark: 64 * 1024
  });

  // Count bytesSent with a small pass-through Transform stream between the read stream and res
  // (bytes handed to the response socket, not raw bytes read from disk)
  let bytesSent = 0;
  const counter = new Transform({
    transform(chunk, encoding, callback) {
      bytesSent += chunk.length;
      callback(null, chunk);
    }
  });

  // Why res 'close' (not req 'close') decides abort:
  // In Node.js >= 16, req.on('close') fires as soon as the incoming request stream (headers/body)
  // is fully read, which happens immediately for GET/HEAD requests. Using req.on('close') falsely marks
  // completed downloads as aborted. Instead, res.on('close') indicates the underlying response socket
  // has terminated. Checking !res.writableFinished accurately distinguishes premature client disconnections
  // from completed response flushes.
  let servedCalled = false;
  const callOnServed = (aborted) => {
    if (servedCalled) return;
    servedCalled = true;
    if (onServed) {
      onServed({
        bytesSent,
        status,
        rangeStart: status === 206 ? startOffset : null,
        rangeEnd: status === 206 ? endOffset : null,
        aborted,
        method: req.method
      });
    }
  };

  res.on('close', () => {
    const aborted = !res.writableFinished;
    // Destroy read stream on close (even if not yet opened) to guarantee no fd leaks
    readStream.destroy();
    callOnServed(aborted);
  });

  // Defer writeHead until file descriptor successfully opens
  readStream.once('open', () => {
    if (res.destroyed || res.writableEnded) {
      readStream.destroy();
      return;
    }

    res.writeHead(status, headers);

    pipeline(readStream, counter, res, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        // Client abort is not a server error; other stream errors propagate to error boundary
        sendError(res, err);
      }
    });
  });

  readStream.once('error', (openErr) => {
    if (!res.headersSent) {
      sendError(res, openErr);
    }
  });
}

module.exports = {
  parseRangeHeader,
  contentRangeHeader,
  unsatisfiedRangeHeader,
  buildContentDisposition,
  testIfNoneMatch,
  testIfRange,
  serveMedia
};
