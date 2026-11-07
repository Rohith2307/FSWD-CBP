const path = require('node:path');

/**
 * Parses and validates an integer from environment or default value.
 *
 * @param {string|number|undefined} val - Raw value
 * @param {string} name - Config parameter name for error messages
 * @param {number} min - Minimum acceptable integer (inclusive)
 * @param {number} max - Maximum acceptable integer (inclusive)
 * @returns {number|undefined}
 */
function parsePositiveInt(val, name, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (val === undefined || val === null || val === '') {
    return undefined;
  }
  const num = Number(val);
  if (!Number.isSafeInteger(num) || num < min || num > max) {
    throw new Error(
      `Configuration error: "${name}" must be an integer between ${min} and ${max}. Received: "${val}"`
    );
  }
  return num;
}

const DEFAULT_ALLOWED_CONTENT_TYPES = Object.freeze([
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/webm',
  'image/png',
  'image/jpeg',
  'application/octet-stream'
]);

/**
 * Builds and validates configuration from environment variables.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {Readonly<Record<string, any>>}
 */
function loadConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  const port = parsePositiveInt(env.PORT, 'PORT', 1, 65535) ?? 3000;

  // storageRoot defaults to project root storage directory (file-stream-service/storage)
  // STORAGE_ROOT env override allows relative paths (resolved against process.cwd()) or absolute paths
  const defaultStorageRoot = path.resolve(__dirname, '..', 'storage');
  const storageRoot = env.STORAGE_ROOT
    ? path.resolve(process.cwd(), env.STORAGE_ROOT)
    : defaultStorageRoot;

  const maxJsonBodyBytes = parsePositiveInt(env.MAX_JSON_BODY_BYTES, 'MAX_JSON_BODY_BYTES', 1) ?? 64 * 1024;
  const maxUploadBytes = parsePositiveInt(env.MAX_UPLOAD_BYTES, 'MAX_UPLOAD_BYTES', 1) ?? 2 * 1024 * 1024 * 1024;
  const minChunkBytes = parsePositiveInt(env.MIN_CHUNK_BYTES, 'MIN_CHUNK_BYTES', 1) ?? 64 * 1024;
  const maxChunkBytes = parsePositiveInt(env.MAX_CHUNK_BYTES, 'MAX_CHUNK_BYTES', 1) ?? 16 * 1024 * 1024;
  const defaultChunkBytes = parsePositiveInt(env.DEFAULT_CHUNK_BYTES, 'DEFAULT_CHUNK_BYTES', 1) ?? 1024 * 1024;

  const maxConcurrentUploads = parsePositiveInt(env.MAX_CONCURRENT_UPLOADS, 'MAX_CONCURRENT_UPLOADS', 1) ?? 10;
  const maxFilenameLength = parsePositiveInt(env.MAX_FILENAME_LENGTH, 'MAX_FILENAME_LENGTH', 1, 1024) ?? 255;

  const requestTimeoutMs = parsePositiveInt(env.REQUEST_TIMEOUT_MS, 'REQUEST_TIMEOUT_MS', 1000) ?? 120000;
  const headersTimeoutMs = parsePositiveInt(env.HEADERS_TIMEOUT_MS, 'HEADERS_TIMEOUT_MS', 1000) ?? 60000;
  const keepAliveTimeoutMs = parsePositiveInt(env.KEEP_ALIVE_TIMEOUT_MS, 'KEEP_ALIVE_TIMEOUT_MS', 1000) ?? 5000;

  const sessionTtlMs = parsePositiveInt(env.SESSION_TTL_MS, 'SESSION_TTL_MS', 1) ?? 24 * 60 * 60 * 1000;
  const tempFileTtlMs = parsePositiveInt(env.TEMP_FILE_TTL_MS, 'TEMP_FILE_TTL_MS', 1) ?? 60 * 60 * 1000;
  const orphanGraceMs = parsePositiveInt(env.ORPHAN_GRACE_MS, 'ORPHAN_GRACE_MS', 1) ?? 60 * 60 * 1000;
  const cleanupIntervalMs = parsePositiveInt(env.CLEANUP_INTERVAL_MS, 'CLEANUP_INTERVAL_MS', 1) ?? 10 * 60 * 1000;

  // Validate chunk size invariants: minChunkBytes <= defaultChunkBytes <= maxChunkBytes
  if (minChunkBytes > defaultChunkBytes) {
    throw new Error(
      `Configuration error: minChunkBytes (${minChunkBytes}) cannot exceed defaultChunkBytes (${defaultChunkBytes})`
    );
  }
  if (defaultChunkBytes > maxChunkBytes) {
    throw new Error(
      `Configuration error: defaultChunkBytes (${defaultChunkBytes}) cannot exceed maxChunkBytes (${maxChunkBytes})`
    );
  }
  if (headersTimeoutMs > requestTimeoutMs) {
    throw new Error(
      `Configuration error: headersTimeoutMs (${headersTimeoutMs}) must be <= requestTimeoutMs (${requestTimeoutMs})`
    );
  }

  return Object.freeze({
    host,
    port,
    storageRoot,
    maxJsonBodyBytes,
    maxUploadBytes,
    minChunkBytes,
    maxChunkBytes,
    defaultChunkBytes,
    maxConcurrentUploads,
    maxFilenameLength,
    requestTimeoutMs,
    headersTimeoutMs,
    keepAliveTimeoutMs,
    sessionTtlMs,
    tempFileTtlMs,
    orphanGraceMs,
    cleanupIntervalMs,
    allowedContentTypes: DEFAULT_ALLOWED_CONTENT_TYPES
  });
}

const baseConfig = loadConfig(process.env);

const config = Object.freeze({
  ...baseConfig,
  loadConfig
});

module.exports = config;

