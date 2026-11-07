const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const paths = require('../storage/paths');
const {
  updateMetadata,
  writeMediaMetadata,
  readMediaMetadata
} = require('../storage/metadataStore');
const { getUploadOrThrow, CONTENT_TYPE_EXTENSIONS } = require('./uploadManager');
const { createSha256Transform } = require('./integrity');
const ledger = require('./ledger');
const {
  notFound,
  conflict,
  unprocessable,
  badRequest
} = require('../utils/httpErrors');

// Process-local set tracking uploads currently undergoing chunk assembly & publication.
// Prevents concurrent finalize workers within the same Node process from colliding.
const activeFinalizations = new Set();

/**
 * Finalizes an upload session by verifying ledger integrity, assembling all chunk streams
 * into a single unified media file, validating hashes, and publishing media metadata.
 *
 * Architecture & Design Rationale:
 * 1. Why assembly is one pipeline with backpressure:
 *    Streams use bounded memory. By streaming chunk-by-chunk through an async generator into
 *    the whole-file hash transform and disk write stream, memory usage remains strictly bounded (O(1))
 *    regardless of whether the assembled media is 5 MiB or 2 GiB. Natural backpressure ensures disk writes
 *    throttle chunk reading.
 * 2. Why state flips to "finalizing" inside the lock:
 *    Compare-and-set inside updateMetadata serializes concurrent finalize attempts and prevents incoming
 *    chunk PUTs from modifying the ledger during assembly.
 * 3. Why damaged chunks are removed from the ledger:
 *    If an on-disk chunk file was deleted, truncated, or silently corrupted, removing its record from
 *    the ledger allows subsequent GET /api/uploads/:id queries to report it as missing, enabling the client
 *    to resume and re-upload only the damaged chunks without restarting the entire upload.
 * 4. Why media metadata is separate from upload session state:
 *    Upload sessions are ephemeral ingestion records with chunk ledgers that get cleaned up. Media records
 *    are durable catalog items for long-term streaming, Range requests, and playback metadata.
 * 5. Why the media file is renamed only after all verification:
 *    Atomic rename into storage/media guarantees that any file present in media/ is 100% complete,
 *    verified against SHA-256 digests, and ready for streaming.
 *
 * @param {string} uploadId
 * @param {{ storageRoot: string, config: object, expectedSha256?: string }} options
 * @returns {Promise<object>}
 */
async function finalizeUpload(uploadId, { storageRoot, config, expectedSha256 }) {
  paths.assertValidId(uploadId);

  // 1. Initial read and state inspection
  const metadata = await getUploadOrThrow(uploadId, storageRoot);

  // Idempotent completion: if already ready, return existing media record
  if (metadata.state === 'ready') {
    if (metadata.mediaId) {
      const mediaMeta = await readMediaMetadata(metadata.mediaId, storageRoot);
      if (mediaMeta) {
        return {
          mediaId: mediaMeta.mediaId,
          uploadId: mediaMeta.uploadId,
          originalName: mediaMeta.originalName,
          contentType: mediaMeta.contentType,
          size: mediaMeta.size,
          sha256: mediaMeta.sha256,
          createdAt: mediaMeta.createdAt,
          state: 'ready',
          downloadUrl: `/api/media/${mediaMeta.mediaId}`,
          stats: {
            chunks: mediaMeta.totalChunks,
            assemblyMs: 0,
            verifiedChunks: mediaMeta.totalChunks
          }
        };
      }
    }
  }

  if (metadata.state === 'expired') {
    const err = conflict(`Upload session "${uploadId}" has expired`);
    err.code = 'SESSION_EXPIRED';
    throw err;
  }

  // Active concurrency check
  if (metadata.state === 'finalizing') {
    if (activeFinalizations.has(uploadId)) {
      const err = conflict(`Finalization already in progress for upload "${uploadId}"`);
      err.code = 'FINALIZE_IN_PROGRESS';
      throw err;
    }
    // If state is 'finalizing' but NOT in activeFinalizations, this is a stale state
    // from a server restart mid-finalize. Allow re-running finalization.
  } else if (metadata.state !== 'created' && metadata.state !== 'uploading') {
    throw conflict(`Cannot finalize upload in state "${metadata.state}"`);
  }

  // 2. Pure ledger validation before performing any disk I/O
  const ledgerValidation = ledger.validateLedger(metadata);
  if (ledgerValidation.missingChunks.length > 0) {
    const err = conflict('Cannot finalize: upload is incomplete', {
      missingChunks: ledgerValidation.missingChunks,
      missingRanges: ledger.missingRanges(
        metadata.totalChunks,
        metadata.expectedSize,
        metadata.chunkSize,
        metadata.chunks
      ),
      committedBytes: ledger.committedBytes(metadata.chunks),
      expectedSize: metadata.expectedSize
    });
    err.code = 'INCOMPLETE_UPLOAD';
    throw err;
  }

  if (ledgerValidation.problems.length > 0) {
    const err = conflict('Cannot finalize: ledger metadata is invalid', {
      problems: ledgerValidation.problems
    });
    err.code = 'LEDGER_INVALID';
    throw err;
  }

  // 3. Atomically transition state to "finalizing" inside the per-upload lock
  const assemblyStartTime = process.hrtime.bigint();
  let assemblyTempPath = null;
  let assemblyTempCreated = false;
  let finalMediaPath = null;
  let finalMediaMetaPath = null;
  let mediaRenamed = false;
  let addedToActive = false;

  try {
    let alreadyReadyMedia = null;
    const freshMetadata = await updateMetadata(uploadId, storageRoot, async (draft) => {
      if (!draft) {
        throw notFound(`Upload session "${uploadId}" not found during finalization`);
      }

      if (draft.state === 'ready') {
        alreadyReadyMedia = draft.mediaId;
        return draft;
      }

      if (draft.state === 'expired') {
        const err = conflict(`Upload session "${uploadId}" has expired`);
        err.code = 'SESSION_EXPIRED';
        throw err;
      }

      if (draft.state === 'finalizing' && activeFinalizations.has(uploadId)) {
        const err = conflict(`Finalization already in progress for upload "${uploadId}"`);
        err.code = 'FINALIZE_IN_PROGRESS';
        throw err;
      }

      // Re-verify ledger consistency on fresh draft
      const freshValidation = ledger.validateLedger(draft);
      if (freshValidation.missingChunks.length > 0) {
        const err = conflict('Cannot finalize: upload is incomplete', {
          missingChunks: freshValidation.missingChunks,
          missingRanges: ledger.missingRanges(
            draft.totalChunks,
            draft.expectedSize,
            draft.chunkSize,
            draft.chunks
          ),
          committedBytes: ledger.committedBytes(draft.chunks),
          expectedSize: draft.expectedSize
        });
        err.code = 'INCOMPLETE_UPLOAD';
        throw err;
      }

      if (freshValidation.problems.length > 0) {
        const err = conflict('Cannot finalize: ledger metadata is invalid', {
          problems: freshValidation.problems
        });
        err.code = 'LEDGER_INVALID';
        throw err;
      }

      draft.state = 'finalizing';
      draft.finalizingStartedAt = new Date().toISOString();
      activeFinalizations.add(uploadId);
      addedToActive = true;
      return draft;
    });

    if (alreadyReadyMedia) {
      const mediaMeta = await readMediaMetadata(alreadyReadyMedia, storageRoot);
      if (mediaMeta) {
        return {
          mediaId: mediaMeta.mediaId,
          uploadId: mediaMeta.uploadId,
          originalName: mediaMeta.originalName,
          contentType: mediaMeta.contentType,
          size: mediaMeta.size,
          sha256: mediaMeta.sha256,
          createdAt: mediaMeta.createdAt,
          state: 'ready',
          downloadUrl: `/api/media/${mediaMeta.mediaId}`,
          stats: {
            chunks: mediaMeta.totalChunks,
            assemblyMs: 0,
            verifiedChunks: mediaMeta.totalChunks
          }
        };
      }
    }

    // Chunks sorted by index
    const sortedChunks = [...freshMetadata.chunks].sort((a, b) => a.index - b.index);

    // 4. File check: stat every chunk file on disk to detect missing or damaged chunks
    const damaged = [];
    for (const chunk of sortedChunks) {
      const cPath = paths.chunkPath(uploadId, chunk.index, storageRoot);
      try {
        const st = await fs.promises.stat(cPath);
        if (st.size !== chunk.size) {
          damaged.push({
            index: chunk.index,
            reason: 'size_mismatch',
            expectedSize: chunk.size,
            actualSize: st.size
          });
        }
      } catch (err) {
        if (err.code === 'ENOENT') {
          damaged.push({ index: chunk.index, reason: 'missing_file' });
        } else {
          throw err;
        }
      }
    }

    if (damaged.length > 0) {
      // Remove damaged chunk records from the ledger so the client can resume and re-upload them
      const damagedIndices = new Set(damaged.map((d) => d.index));
      await updateMetadata(uploadId, storageRoot, (draft) => {
        draft.chunks = draft.chunks.filter((c) => !damagedIndices.has(c.index));
        draft.state = 'uploading';
        draft.lastFinalizeError = {
          code: 'CHUNKS_DAMAGED',
          message: 'One or more chunk files were missing or damaged on disk',
          at: new Date().toISOString()
        };
        return draft;
      });

      const err = conflict('One or more chunk files are missing or damaged on disk', {
        indices: damaged.map((d) => d.index),
        reasons: damaged
      });
      err.code = 'CHUNKS_DAMAGED';
      throw err;
    }

    // 5. Assembly pipeline (bounded memory):
    // Read chunks sequentially in index order, compute SHA-256 per chunk, and stream to assembly temp file
    let verifiedChunksCount = 0;

    async function* chunkStreamGenerator() {
      for (const chunk of sortedChunks) {
        const cPath = paths.chunkPath(uploadId, chunk.index, storageRoot);
        const chunkHasher = crypto.createHash('sha256');
        const readStream = fs.createReadStream(cPath);

        for await (const data of readStream) {
          chunkHasher.update(data);
          yield data;
        }

        const actualChunkSha = chunkHasher.digest('hex');
        if (actualChunkSha !== chunk.checksum) {
          const corruptErr = new Error(`Chunk ${chunk.index} checksum mismatch`);
          corruptErr.code = 'CHUNK_CORRUPT';
          corruptErr.corruptChunk = {
            index: chunk.index,
            expected: chunk.checksum,
            actual: actualChunkSha
          };
          throw corruptErr;
        }
        verifiedChunksCount++;
      }
    }

    assemblyTempPath = paths.finalTempPath(uploadId, storageRoot);
    const wholeFileTransform = createSha256Transform(freshMetadata.expectedSize);
    const fileWriteStream = fs.createWriteStream(assemblyTempPath, { flags: 'wx' });
    assemblyTempCreated = true;

    try {
      await pipeline(
        Readable.from(chunkStreamGenerator()),
        wholeFileTransform,
        fileWriteStream
      );
    } catch (pipelineErr) {
      if (!fileWriteStream.destroyed) {
        fileWriteStream.destroy();
      }
      await fs.promises.unlink(assemblyTempPath).catch(() => {});
      assemblyTempCreated = false;

      if (pipelineErr.code === 'CHUNK_CORRUPT' && pipelineErr.corruptChunk) {
        const badIndex = pipelineErr.corruptChunk.index;
        const badChunkPath = paths.chunkPath(uploadId, badIndex, storageRoot);
        // Best effort remove corrupted chunk file
        await fs.promises.unlink(badChunkPath).catch(() => {});

        // Remove corrupt chunk from ledger and reset to uploading
        await updateMetadata(uploadId, storageRoot, (draft) => {
          draft.chunks = draft.chunks.filter((c) => c.index !== badIndex);
          draft.state = 'uploading';
          draft.lastFinalizeError = {
            code: 'CHUNK_CORRUPT',
            message: `Chunk ${badIndex} failed checksum verification during assembly`,
            at: new Date().toISOString()
          };
          return draft;
        });

        const unprocErr = unprocessable(
          `Chunk ${badIndex} is corrupt: computed checksum does not match ledger`,
          {
            index: badIndex,
            expected: pipelineErr.corruptChunk.expected,
            actual: pipelineErr.corruptChunk.actual
          }
        );
        unprocErr.code = 'CHUNK_CORRUPT';
        throw unprocErr;
      }

      // Any other assembly error: reset state to uploading
      await updateMetadata(uploadId, storageRoot, (draft) => {
        draft.state = 'uploading';
        draft.lastFinalizeError = {
          code: 'ASSEMBLY_FAILED',
          message: pipelineErr.message,
          at: new Date().toISOString()
        };
        return draft;
      }).catch(() => {});

      throw pipelineErr;
    }

    // 6. Post-assembly verification: size and client expected SHA-256 check
    if (wholeFileTransform.bytesSeen !== freshMetadata.expectedSize) {
      await fs.promises.unlink(assemblyTempPath).catch(() => {});
      assemblyTempCreated = false;

      await updateMetadata(uploadId, storageRoot, (draft) => {
        draft.state = 'uploading';
        draft.lastFinalizeError = {
          code: 'SIZE_MISMATCH',
          message: `Assembled size (${wholeFileTransform.bytesSeen}) does not match expected (${freshMetadata.expectedSize})`,
          at: new Date().toISOString()
        };
        return draft;
      }).catch(() => {});

      throw unprocessable(
        `Assembled file size (${wholeFileTransform.bytesSeen}) does not match expected size (${freshMetadata.expectedSize})`
      );
    }

    const computedWholeSha256 = wholeFileTransform.digestHex();
    if (expectedSha256) {
      const normalizedExpected = String(expectedSha256).trim().toLowerCase();
      if (normalizedExpected !== computedWholeSha256) {
        await fs.promises.unlink(assemblyTempPath).catch(() => {});
        assemblyTempCreated = false;

        await updateMetadata(uploadId, storageRoot, (draft) => {
          draft.state = 'uploading';
          draft.lastFinalizeError = {
            code: 'FILE_CHECKSUM_MISMATCH',
            message: 'Whole-file SHA-256 does not match client expected checksum',
            at: new Date().toISOString()
          };
          return draft;
        }).catch(() => {});

        const err = unprocessable('Whole-file SHA-256 checksum mismatch', {
          expected: normalizedExpected,
          actual: computedWholeSha256
        });
        err.code = 'FILE_CHECKSUM_MISMATCH';
        throw err;
      }
    }

    // 7. fsync assembly temp file, then rename to storage/media/<mediaId>.<ext>
    let tempHandle = null;
    try {
      tempHandle = await fs.promises.open(assemblyTempPath, 'r+');
      await tempHandle.sync();
    } finally {
      if (tempHandle) {
        await tempHandle.close().catch(() => {});
      }
    }

    const mediaId = crypto.randomUUID();
    const ext = paths.assertValidExt(
      CONTENT_TYPE_EXTENSIONS[freshMetadata.contentType] ||
      freshMetadata.safeStoredName.split('.').pop() ||
      'bin'
    );
    finalMediaPath = paths.mediaPath(mediaId, ext, storageRoot);
    finalMediaMetaPath = paths.mediaMetaPath(mediaId, storageRoot);

    try {
      const renameFn = (config && config._rename) || fs.promises.rename;
      await renameFn(assemblyTempPath, finalMediaPath);
      mediaRenamed = true;
      assemblyTempCreated = false;
    } catch (renameErr) {
      await fs.promises.unlink(assemblyTempPath).catch(() => {});
      assemblyTempCreated = false;

      await updateMetadata(uploadId, storageRoot, (draft) => {
        draft.state = 'uploading';
        draft.lastFinalizeError = {
          code: 'MEDIA_PUBLISH_FAILED',
          message: renameErr.message,
          at: new Date().toISOString()
        };
        return draft;
      }).catch(() => {});

      throw renameErr;
    }

    // 8. Write media metadata atomically to storage/media/<mediaId>.json
    const mediaRecord = {
      mediaId,
      uploadId,
      originalName: freshMetadata.originalName,
      storedFile: `${mediaId}.${ext}`,
      contentType: freshMetadata.contentType,
      size: freshMetadata.expectedSize,
      sha256: computedWholeSha256,
      chunkSize: freshMetadata.chunkSize,
      totalChunks: freshMetadata.totalChunks,
      createdAt: new Date().toISOString()
    };

    try {
      await writeMediaMetadata(mediaId, mediaRecord, storageRoot);
    } catch (mediaMetaErr) {
      // Rollback media file if media meta write fails
      if (mediaRenamed) {
        await fs.promises.unlink(finalMediaPath).catch(() => {});
      }
      await updateMetadata(uploadId, storageRoot, (draft) => {
        draft.state = 'uploading';
        draft.lastFinalizeError = {
          code: 'MEDIA_METADATA_WRITE_FAILED',
          message: mediaMetaErr.message,
          at: new Date().toISOString()
        };
        return draft;
      }).catch(() => {});
      throw mediaMetaErr;
    }

    // 9. Update upload metadata: state 'ready', mediaId, finalSha256, clear lastFinalizeError
    const finalizedAt = new Date().toISOString();
    try {
      await updateMetadata(uploadId, storageRoot, (draft) => {
        draft.state = 'ready';
        draft.mediaId = mediaId;
        draft.finalSha256 = computedWholeSha256;
        draft.finalizedAt = finalizedAt;
        draft.lastFinalizeError = null;
        return draft;
      });
    } catch (metaUpdateErr) {
      // Rollback media files if ledger update fails
      if (mediaRenamed) {
        await fs.promises.unlink(finalMediaPath).catch(() => {});
      }
      await fs.promises.unlink(finalMediaMetaPath).catch(() => {});
      await updateMetadata(uploadId, storageRoot, (draft) => {
        draft.state = 'uploading';
        draft.lastFinalizeError = {
          code: 'LEDGER_UPDATE_FAILED',
          message: metaUpdateErr.message,
          at: new Date().toISOString()
        };
        return draft;
      }).catch(() => {});
      throw metaUpdateErr;
    }

    // 10. Best-effort delete of chunks directory contents
    try {
      const cDir = paths.chunksDir(uploadId, storageRoot);
      const chunkFiles = await fs.promises.readdir(cDir);
      for (const f of chunkFiles) {
        if (f.endsWith('.part')) {
          await fs.promises.unlink(path.join(cDir, f)).catch(() => {});
        }
      }
    } catch (cleanErr) {
      console.error(
        `[Finalizer] Non-fatal chunk cleanup failure for upload "${uploadId}":`,
        cleanErr.message
      );
    }

    // 11 / 12. Return published media record
    const assemblyMs = Number((process.hrtime.bigint() - assemblyStartTime) / 1000000n);
    return {
      mediaId,
      uploadId,
      originalName: freshMetadata.originalName,
      contentType: freshMetadata.contentType,
      size: freshMetadata.expectedSize,
      sha256: computedWholeSha256,
      createdAt: mediaRecord.createdAt,
      state: 'ready',
      downloadUrl: `/api/media/${mediaId}`,
      stats: {
        chunks: freshMetadata.totalChunks,
        assemblyMs,
        verifiedChunks: verifiedChunksCount
      }
    };
  } finally {
    if (addedToActive) {
      activeFinalizations.delete(uploadId);
    }
    if (assemblyTempCreated && assemblyTempPath) {
      await fs.promises.unlink(assemblyTempPath).catch(() => {});
    }
  }
}

module.exports = {
  finalizeUpload,
  getActiveFinalizations: () => activeFinalizations,
  _activeFinalizations: activeFinalizations
};
