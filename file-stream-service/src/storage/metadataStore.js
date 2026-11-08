const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const paths = require('./paths');
const { internal } = require('../utils/httpErrors');

// In-process lock table for per-upload serialization
/** @type {Map<string, Promise<any>>} */
const uploadLocks = new Map();

/**
 * Reads and parses metadata for a given uploadId.
 * Returns null if the file does not exist.
 * Throws 500 HttpError if file content is corrupted JSON.
 *
 * @param {string} uploadId
 * @param {string} storageRoot
 * @returns {Promise<any|null>}
 */
async function readMetadata(uploadId, storageRoot) {
  const filePath = paths.metadataPath(uploadId, storageRoot);
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    try {
      return JSON.parse(raw);
    } catch {
      throw internal('Corrupt metadata ledger on disk', 'METADATA_CORRUPT');
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Atomically writes arbitrary JSON data to disk using a temp file in the same directory,
 * fsync to ensure physical durability, and atomic rename.
 *
 * @param {string} targetPath
 * @param {any} data
 * @returns {Promise<void>}
 */
async function writeJsonAtomic(targetPath, data) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const randomSuffix = crypto.randomBytes(6).toString('hex');
  const tempPath = path.join(dir, `${base}.${randomSuffix}.tmp`);

  const jsonStr = JSON.stringify(data, null, 2);
  let fileHandle = null;

  try {
    fileHandle = await fs.promises.open(tempPath, 'w');
    await fileHandle.writeFile(jsonStr, 'utf8');
    // fsync ensures written bytes are flushed to physical disk before atomic rename
    await fileHandle.sync();
  } catch (writeErr) {
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch {}
      fileHandle = null;
    }
    try {
      await fs.promises.unlink(tempPath);
    } catch {}
    throw writeErr;
  }

  if (fileHandle) {
    await fileHandle.close();
  }

  // Atomic rename replaces destination file on same filesystem
  await fs.promises.rename(tempPath, targetPath);
}

/**
 * Atomically writes upload metadata.
 *
 * @param {string} uploadId
 * @param {any} data
 * @param {string} storageRoot
 * @returns {Promise<void>}
 */
async function writeMetadata(uploadId, data, storageRoot) {
  const targetPath = paths.metadataPath(uploadId, storageRoot);
  return writeJsonAtomic(targetPath, data);
}

/**
 * Atomically writes media metadata to storage/media/<mediaId>.json.
 *
 * @param {string} mediaId
 * @param {any} data
 * @param {string} storageRoot
 * @returns {Promise<void>}
 */
async function writeMediaMetadata(mediaId, data, storageRoot) {
  const targetPath = paths.mediaMetaPath(mediaId, storageRoot);
  return writeJsonAtomic(targetPath, data);
}

/**
 * Reads and parses media metadata for a given mediaId.
 * Returns null if file does not exist.
 *
 * @param {string} mediaId
 * @param {string} storageRoot
 * @returns {Promise<any|null>}
 */
async function readMediaMetadata(mediaId, storageRoot) {
  const filePath = paths.mediaMetaPath(mediaId, storageRoot);
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Sequentially updates metadata for a given uploadId.
 * Chains operations per uploadId to serialize concurrent chunk commits and prevent lost updates.
 * Lock is removed when queue is drained; failures do not poison subsequent callers.
 *
 * @param {string} uploadId
 * @param {string} storageRoot
 * @param {(draft: any) => Promise<any>|any} mutatorFn
 * @returns {Promise<any>} The newly written metadata object
 */
function updateMetadata(uploadId, storageRoot, mutatorFn) {
  const previousPromise = uploadLocks.get(uploadId) || Promise.resolve();

  // Guard against previous failure poisoning the chain
  const currentTask = previousPromise
    .catch(() => {})
    .then(async () => {
      const current = await readMetadata(uploadId, storageRoot);
      const modified = await mutatorFn(current);
      await writeMetadata(uploadId, modified, storageRoot);
      return modified;
    });

  uploadLocks.set(uploadId, currentTask);

  // Clean up lock map entry if this was the final task in the queue.
  // Note: .catch(() => {}) is attached to the cleanup chain so that a failing mutator
  // does not trigger an unhandledRejection event. The caller still receives the rejection from currentTask.
  currentTask
    .finally(() => {
      if (uploadLocks.get(uploadId) === currentTask) {
        uploadLocks.delete(uploadId);
      }
    })
    .catch(() => {});

  return currentTask;
}

/**
 * Test helper to inspect active lock map size.
 *
 * @returns {number}
 */
function _lockCount() {
  return uploadLocks.size;
}

module.exports = {
  readMetadata,
  writeMetadata,
  updateMetadata,
  writeJsonAtomic,
  writeMediaMetadata,
  readMediaMetadata,
  _lockCount
};
