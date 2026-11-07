const fs = require('node:fs');
const crypto = require('node:crypto');
const paths = require('../storage/paths');
const { readMetadata, writeMetadata } = require('../storage/metadataStore');
const ledger = require('./ledger');
const {
  sanitizeDisplayName,
  parseSize,
  chunkCount
} = require('../utils/validation');
const {
  badRequest,
  notFound,
  conflict,
  payloadTooLarge,
  unsupportedMediaType
} = require('../utils/httpErrors');

// Allow-listed Content-Type to safe extension mapping
const CONTENT_TYPE_EXTENSIONS = Object.freeze({
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/webm': 'weba',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/octet-stream': 'bin'
});

// Per-storageRoot async mutex to serialize count active + create
const createLocks = new Map();

function withCreateLock(storageRoot, fn) {
  const previous = createLocks.get(storageRoot) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  createLocks.set(
    storageRoot,
    previous.catch(() => {}).then(() => current)
  );

  return previous.catch(() => {}).then(async () => {
    try {
      return await fn();
    } finally {
      release();
      if (createLocks.get(storageRoot) === current) {
        createLocks.delete(storageRoot);
      }
    }
  });
}

/**
 * Counts currently active upload sessions (state 'created' or 'uploading').
 *
 * @param {string} storageRoot
 * @returns {Promise<number>}
 */
async function countActiveUploads(storageRoot) {
  const uploadsDirectory = paths.uploadsDir(storageRoot);
  let entries = [];
  try {
    entries = await fs.promises.readdir(uploadsDirectory, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return 0;
    }
    throw err;
  }

  let activeCount = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      try {
        const metadata = await readMetadata(entry.name, storageRoot);
        if (metadata && (metadata.state === 'created' || metadata.state === 'uploading')) {
          activeCount++;
        }
      } catch {
        // Corrupt or non-upload directory; ignore for active count
      }
    }
  }

  return activeCount;
}

/**
 * Creates a new upload session with durable metadata and directory structure.
 *
 * @param {{ filename: string, size: number|string, contentType: string, chunkSize?: number|string }} params
 * @param {string} storageRoot
 * @param {object} config
 * @returns {Promise<{ uploadId: string, chunkSize: number, totalChunks: number, expectedSize: number, state: string }>}
 */
async function createUpload({ filename, size, contentType, chunkSize }, storageRoot, config) {
  const sanitizedFilename = sanitizeDisplayName(filename, config.maxFilenameLength);

  const expectedSize = parseSize(size);
  if (expectedSize > config.maxUploadBytes) {
    throw payloadTooLarge(
      `File size (${expectedSize} bytes) exceeds maximum permitted upload limit of ${config.maxUploadBytes} bytes`
    );
  }

  if (typeof contentType !== 'string' || !config.allowedContentTypes.includes(contentType)) {
    throw unsupportedMediaType(
      `Content-Type "${contentType}" is not in the allowed list of supported media formats.`
    );
  }

  let actualChunkSize = config.defaultChunkBytes;
  if (chunkSize !== undefined && chunkSize !== null) {
    actualChunkSize = parseSize(chunkSize);
    if (actualChunkSize < config.minChunkBytes || actualChunkSize > config.maxChunkBytes) {
      throw badRequest(
        `chunkSize (${actualChunkSize}) must be between ${config.minChunkBytes} and ${config.maxChunkBytes} bytes.`
      );
    }
  }

  return withCreateLock(storageRoot, async () => {
    const activeUploads = await countActiveUploads(storageRoot);
    if (activeUploads >= config.maxConcurrentUploads) {
      throw conflict(
        `Too many active uploads (${activeUploads}). Concurrency limit of ${config.maxConcurrentUploads} reached.`
      );
    }

    const uploadId = crypto.randomUUID();
    const ext = CONTENT_TYPE_EXTENSIONS[contentType] || 'bin';
    const safeStoredName = `${uploadId}.${ext}`;

    const totalChunks = chunkCount(expectedSize, actualChunkSize);

    const uploadFolderPath = paths.uploadDir(uploadId, storageRoot);
    const chunksFolderPath = paths.chunksDir(uploadId, storageRoot);
    await fs.promises.mkdir(uploadFolderPath, { recursive: true });
    await fs.promises.mkdir(chunksFolderPath, { recursive: true });

    const metadata = {
      uploadId,
      originalName: sanitizedFilename,
      safeStoredName,
      expectedSize,
      contentType,
      chunkSize: actualChunkSize,
      totalChunks,
      createdAt: new Date().toISOString(),
      state: 'created',
      chunks: []
    };

    await writeMetadata(uploadId, metadata, storageRoot);

    return {
      uploadId,
      chunkSize: actualChunkSize,
      totalChunks,
      expectedSize,
      state: 'created'
    };
  });
}

/**
 * Retrieves upload metadata or throws 404 HttpError if not found.
 *
 * @param {string} uploadId
 * @param {string} storageRoot
 * @returns {Promise<any>}
 */
async function getUploadOrThrow(uploadId, storageRoot) {
  paths.assertValidId(uploadId);
  const metadata = await readMetadata(uploadId, storageRoot);
  if (!metadata) {
    throw notFound(`Upload session "${uploadId}" not found`);
  }
  return metadata;
}

/**
 * Returns upload status and resume map.
 * When verify=true, inspects actual on-disk chunk files and removes any missing/truncated
 * chunks from committed status, populating the problems array.
 *
 * @param {string} uploadId
 * @param {string} storageRoot
 * @param {{ verify?: boolean }} options
 * @returns {Promise<object>}
 */
async function getUploadStatus(uploadId, storageRoot, { verify = false } = {}) {
  const metadata = await getUploadOrThrow(uploadId, storageRoot);

  let effectiveChunks = metadata.chunks || [];
  const problems = [];
  let isVerified = Boolean(verify);

  // For state "ready", chunk files are already cleaned up upon finalization,
  // so ?verify=true must NOT stat chunk files.
  if (metadata.state === 'ready') {
    isVerified = false;
  } else if (verify) {
    const verifiedChunks = [];
    for (const chunk of effectiveChunks) {
      const cPath = paths.chunkPath(uploadId, chunk.index, storageRoot);
      try {
        const stat = await fs.promises.stat(cPath);
        if (stat.size !== chunk.size) {
          problems.push({ index: chunk.index, reason: 'size_mismatch' });
        } else {
          verifiedChunks.push(chunk);
        }
      } catch (err) {
        if (err.code === 'ENOENT') {
          problems.push({ index: chunk.index, reason: 'missing_file' });
        } else {
          throw err;
        }
      }
    }
    effectiveChunks = verifiedChunks;
  }

  const committedChunks = effectiveChunks.map((c) => c.index).sort((a, b) => a - b);
  const missingChunks = ledger.missingChunkIndices(metadata.totalChunks, effectiveChunks);
  const committedRanges = ledger.committedRanges(effectiveChunks);
  const missingRanges = ledger.missingRanges(
    metadata.totalChunks,
    metadata.expectedSize,
    metadata.chunkSize,
    effectiveChunks
  );
  const committedBytes = ledger.committedBytes(effectiveChunks);
  const progressPercent = ledger.progressPercent(committedBytes, metadata.expectedSize);

  const statusResponse = {
    uploadId: metadata.uploadId,
    originalName: metadata.originalName,
    state: metadata.state,
    expectedSize: metadata.expectedSize,
    chunkSize: metadata.chunkSize,
    totalChunks: metadata.totalChunks,
    createdAt: metadata.createdAt,
    committedChunks,
    missingChunks,
    committedRanges,
    missingRanges,
    committedBytes,
    progressPercent,
    verified: isVerified
  };

  if (metadata.mediaId) {
    statusResponse.mediaId = metadata.mediaId;
  }

  if (metadata.lastFinalizeError) {
    statusResponse.lastFinalizeError = metadata.lastFinalizeError;
  }

  if (verify) {
    statusResponse.problems = problems;
  }

  return statusResponse;
}

module.exports = {
  createUpload,
  getUploadOrThrow,
  getUploadStatus,
  CONTENT_TYPE_EXTENSIONS
};
