const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { notFound, badRequest } = require('../utils/httpErrors');

// Strict pattern for server-generated IDs (UUIDs or hex identifiers, 8-64 chars)
const ID_PATTERN = /^[a-f0-9-]{8,64}$/i;

// Strict pattern for safe file extensions (1-10 alphanumeric characters)
const EXT_PATTERN = /^[a-zA-Z0-9]{1,10}$/;

/**
 * Validates that an identifier matches strict UUID / hex format.
 * Throws 404 HttpError (notFound) so invalid route params do not cause 500s.
 * Error message is kept safe and free of filesystem paths.
 *
 * @param {string} id
 * @returns {string}
 */
function assertValidId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw notFound(`Resource identifier "${id}" not found or invalid`);
  }
  return id;
}

/**
 * Validates that a chunk index is a non-negative safe integer.
 * Throws 400 HttpError (badRequest).
 *
 * @param {number|string} index
 * @returns {number}
 */
function assertValidIndex(index) {
  const num = typeof index === 'string' && /^\d+$/.test(index) ? Number(index) : index;
  if (typeof num !== 'number' || !Number.isSafeInteger(num) || num < 0) {
    throw badRequest(`Invalid chunk index "${index}". Must be a non-negative safe integer.`);
  }
  return num;
}

/**
 * Validates and normalizes file extensions.
 * Throws 400 HttpError (badRequest).
 *
 * @param {string} ext
 * @returns {string}
 */
function assertValidExt(ext) {
  if (typeof ext !== 'string') {
    throw badRequest(`Invalid extension type: expected string, got ${typeof ext}`);
  }
  const clean = ext.startsWith('.') ? ext.slice(1) : ext;
  if (!EXT_PATTERN.test(clean)) {
    throw badRequest(`Invalid extension "${ext}". Must match ${EXT_PATTERN}.`);
  }
  return clean;
}

/**
 * Asserts that storageRoot is explicitly provided and valid.
 *
 * @param {string} storageRoot
 * @returns {string}
 */
function assertStorageRoot(storageRoot) {
  if (typeof storageRoot !== 'string' || !storageRoot) {
    throw new Error('storageRoot must be explicitly provided as a non-empty string');
  }
  return storageRoot;
}

/**
 * Asserts that the target path resolves inside the given storage root directory.
 * Prevents directory traversal. Does not leak absolute filesystem paths in error message.
 *
 * @param {string} targetPath
 * @param {string} storageRoot
 * @returns {string} Fully resolved absolute path
 */
function assertInsideStorageRoot(targetPath, storageRoot) {
  const resolvedRoot = path.resolve(assertStorageRoot(storageRoot));
  const resolvedTarget = path.resolve(targetPath);

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Path traversal violation: Target path escapes storage root');
  }

  return resolvedTarget;
}

function uploadsDir(storageRoot) {
  assertStorageRoot(storageRoot);
  return assertInsideStorageRoot(path.join(storageRoot, 'uploads'), storageRoot);
}

function uploadDir(uploadId, storageRoot) {
  assertValidId(uploadId);
  return assertInsideStorageRoot(path.join(uploadsDir(storageRoot), uploadId), storageRoot);
}

function chunksDir(uploadId, storageRoot) {
  return assertInsideStorageRoot(path.join(uploadDir(uploadId, storageRoot), 'chunks'), storageRoot);
}

function chunkPath(uploadId, index, storageRoot) {
  const validIndex = assertValidIndex(index);
  const filename = `${String(validIndex).padStart(6, '0')}.part`;
  return assertInsideStorageRoot(path.join(chunksDir(uploadId, storageRoot), filename), storageRoot);
}

function parseChunkFilename(filename) {
  if (typeof filename !== 'string') return null;
  const match = /^(\d{6,})\.part$/.exec(filename);
  if (!match) return null;
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index) || index < 0) return null;
  return index;
}

function metadataPath(uploadId, storageRoot) {
  return assertInsideStorageRoot(path.join(uploadDir(uploadId, storageRoot), 'metadata.json'), storageRoot);
}

function metricsPath(uploadId, storageRoot) {
  return assertInsideStorageRoot(path.join(uploadDir(uploadId, storageRoot), 'metrics.json'), storageRoot);
}

function tempDir(storageRoot) {
  assertStorageRoot(storageRoot);
  return assertInsideStorageRoot(path.join(storageRoot, 'temp'), storageRoot);
}

function mediaDir(storageRoot) {
  assertStorageRoot(storageRoot);
  return assertInsideStorageRoot(path.join(storageRoot, 'media'), storageRoot);
}

function mediaPath(mediaId, ext, storageRoot) {
  const validId = assertValidId(mediaId);
  const validExt = assertValidExt(ext);
  return assertInsideStorageRoot(path.join(mediaDir(storageRoot), `${validId}.${validExt}`), storageRoot);
}

function mediaMetaPath(mediaId, storageRoot) {
  const validId = assertValidId(mediaId);
  return assertInsideStorageRoot(path.join(mediaDir(storageRoot), `${validId}.json`), storageRoot);
}

function finalTempPath(uploadId, storageRoot) {
  const validId = assertValidId(uploadId);
  const randomSuffix = crypto.randomBytes(6).toString('hex');
  return assertInsideStorageRoot(
    path.join(tempDir(storageRoot), `${validId}-final-${randomSuffix}.tmp`),
    storageRoot
  );
}

/**
 * Creates essential storage directories (uploads/, temp/, media/) recursively.
 *
 * @param {string} storageRoot
 */
async function ensureStorageDirs(storageRoot) {
  const resolvedRoot = path.resolve(assertStorageRoot(storageRoot));
  await fs.promises.mkdir(path.join(resolvedRoot, 'uploads'), { recursive: true });
  await fs.promises.mkdir(path.join(resolvedRoot, 'temp'), { recursive: true });
  await fs.promises.mkdir(path.join(resolvedRoot, 'media'), { recursive: true });
}

module.exports = {
  assertValidId,
  assertValidIndex,
  assertValidExt,
  assertInsideStorageRoot,
  uploadsDir,
  uploadDir,
  chunksDir,
  chunkPath,
  parseChunkFilename,
  metadataPath,
  metricsPath,
  tempDir,
  mediaDir,
  mediaPath,
  mediaMetaPath,
  finalTempPath,
  ensureStorageDirs
};
