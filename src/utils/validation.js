const { badRequest } = require('./httpErrors');

/**
 * Sanitizes a user-supplied filename into a safe human-readable display name.
 * Strips path separators, control characters, leading dots, and collapses whitespace.
 * Enforces length limit. NEVER used as a filesystem path.
 *
 * @param {string} name - Raw filename from client
 * @param {number} [maxLen=255] - Maximum permitted display length
 * @returns {string} Sanitized display name
 */
function sanitizeDisplayName(name, maxLen = 255) {
  if (typeof name !== 'string') {
    throw badRequest('Invalid filename: must be a string');
  }

  // Remove control characters (ASCII 0x00-0x1F and 0x7F-0x9F)
  let sanitized = name.replace(/[\x00-\x1f\x7f-\x9f]/g, '');

  // Strip path separators (/ and \)
  sanitized = sanitized.replace(/[/\\]/g, '');

  // Trim whitespace first so leading spaces do not protect leading dots
  sanitized = sanitized.trim();

  // Strip leading dots to avoid hidden/special names
  sanitized = sanitized.replace(/^\.+/, '');

  // Collapse consecutive whitespace and trim
  sanitized = sanitized.replace(/\s+/g, ' ').trim();

  if (!sanitized) {
    throw badRequest('Invalid filename: filename cannot be empty after sanitization');
  }

  if (sanitized.length > maxLen) {
    throw badRequest(
      `Filename length (${sanitized.length}) exceeds maximum allowed length of ${maxLen} characters`
    );
  }

  return sanitized;
}

/**
 * Parses and validates an integer byte size.
 *
 * @param {number|string} value
 * @returns {number}
 */
function parseSize(value) {
  const num = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isSafeInteger(num) || num <= 0) {
    throw badRequest(`Invalid size "${value}". Must be a positive safe integer.`);
  }
  return num;
}

/**
 * Strict parser for HTTP Content-Range header: "bytes <start>-<end>/<total>".
 * Rejects wildcard forms, non-digits, leading signs (+), out-of-order bounds, and overflow.
 *
 * @param {string} headerValue
 * @returns {{ start: number, end: number, total: number, length: number }}
 */
function parseContentRange(headerValue) {
  if (typeof headerValue !== 'string' || !headerValue) {
    throw badRequest('Missing Content-Range header');
  }

  // Strict regex: exactly "bytes <start>-<end>/<total>" without leading +, spaces, or wildcards
  const match = headerValue.match(/^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(0|[1-9]\d*)$/);
  if (!match) {
    throw badRequest(
      `Invalid Content-Range header "${headerValue}". Expected format: bytes <start>-<end>/<total>`
    );
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total)
  ) {
    throw badRequest('Content-Range values exceed maximum safe integer limit');
  }

  if (total <= 0) {
    throw badRequest(`Content-Range total must be positive: got ${total}`);
  }

  if (start > end) {
    throw badRequest(`Content-Range start (${start}) cannot be greater than end (${end})`);
  }

  if (end >= total) {
    throw badRequest(
      `Content-Range end (${end}) cannot be greater than or equal to total file size (${total})`
    );
  }

  const length = end - start + 1;
  return { start, end, total, length };
}

/**
 * Validates and normalizes an X-Chunk-SHA256 header.
 *
 * @param {string} value
 * @returns {string} Lowercase 64-character hex digest
 */
function parseSha256Header(value) {
  if (typeof value !== 'string') {
    throw badRequest('Missing or invalid X-Chunk-SHA256 header');
  }

  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw badRequest(
      'Invalid X-Chunk-SHA256 header. Expected exactly 64 hexadecimal characters.'
    );
  }

  return value.toLowerCase();
}

/**
 * Calculates total chunk count using integer arithmetic.
 * N = ceil(size / chunkSize) = Math.floor((size + chunkSize - 1) / chunkSize)
 *
 * @param {number} size - Total file size in bytes
 * @param {number} chunkSize - Nominal chunk size in bytes
 * @returns {number}
 */
function chunkCount(size, chunkSize) {
  const validSize = parseSize(size);
  const validChunkSize = parseSize(chunkSize);
  return Math.floor((validSize + validChunkSize - 1) / validChunkSize);
}

/**
 * Computes the nominal byte range for a zero-based chunk index.
 * start(i) = i * C
 * end(i)   = min(start(i) + C - 1, S - 1)
 * length(i) = end(i) - start(i) + 1
 *
 * @param {number} index - Zero-based chunk index
 * @param {number} size - Total file size in bytes
 * @param {number} chunkSize - Nominal chunk size in bytes
 * @returns {{ start: number, end: number, length: number }}
 */
function expectedRange(index, size, chunkSize) {
  const numIndex = typeof index === 'string' && /^\d+$/.test(index) ? Number(index) : index;
  if (typeof numIndex !== 'number' || !Number.isSafeInteger(numIndex) || numIndex < 0) {
    throw badRequest(`Invalid chunk index "${index}". Must be a non-negative integer.`);
  }

  const validSize = parseSize(size);
  const validChunkSize = parseSize(chunkSize);
  const totalChunks = chunkCount(validSize, validChunkSize);

  if (numIndex >= totalChunks) {
    throw badRequest(
      `Chunk index ${numIndex} is out of bounds. Total chunks for file of ${validSize} bytes is ${totalChunks}.`
    );
  }

  const start = numIndex * validChunkSize;
  const end = Math.min(start + validChunkSize - 1, validSize - 1);
  const length = end - start + 1;

  return { start, end, length };
}

module.exports = {
  sanitizeDisplayName,
  parseSize,
  parseContentRange,
  parseSha256Header,
  chunkCount,
  expectedRange
};
