const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const paths = require('../storage/paths');
const { updateMetadata } = require('../storage/metadataStore');
const { getUploadOrThrow } = require('./uploadManager');
const { createSha256Transform } = require('./integrity');
const {
  parseContentRange,
  parseSha256Header,
  expectedRange
} = require('../utils/validation');
const {
  badRequest,
  notFound,
  conflict,
  payloadTooLarge,
  unprocessable
} = require('../utils/httpErrors');

/**
 * Handles incoming chunk transfers with strict header validation, pre-stream idempotent duplicate detection,
 * streamed integrity verification, and in-lock atomic rename with race safety.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ uploadId: string, index: string|number, storageRoot: string, config: object }} options
 * @returns {Promise<{ chunk: object, duplicate: boolean }>}
 */
async function receiveChunk(req, { uploadId, index, storageRoot, config }) {
  // 1. Verify upload session exists
  const metadata = await getUploadOrThrow(uploadId, storageRoot);
  if (metadata.state !== 'created' && metadata.state !== 'uploading') {
    req.resume();
    throw conflict(`Cannot upload chunk: session "${uploadId}" is in state "${metadata.state}"`);
  }

  // 2. Validate chunk index within session bounds
  const validIndex = paths.assertValidIndex(index);
  if (validIndex < 0 || validIndex >= metadata.totalChunks) {
    req.resume();
    throw badRequest(
      `Chunk index ${validIndex} is out of bounds [0, ${metadata.totalChunks - 1}]`
    );
  }

  // 3. Strict header parsing and validation BEFORE touching physical disk
  // Validating headers first avoids disk I/O, prevents file creation for invalid requests,
  // and discards bodies cleanly so keep-alive connections do not stall.
  let contentRange;
  let expectedSha256;
  try {
    contentRange = parseContentRange(req.headers['content-range']);
    expectedSha256 = parseSha256Header(req.headers['x-chunk-sha256']);

    if (contentRange.total !== metadata.expectedSize) {
      throw unprocessable(
        `Content-Range total (${contentRange.total}) does not match expected file size (${metadata.expectedSize})`
      );
    }

    const expected = expectedRange(validIndex, metadata.expectedSize, metadata.chunkSize);
    if (contentRange.start !== expected.start || contentRange.end !== expected.end) {
      throw unprocessable(
        `Content-Range byte bounds ${contentRange.start}-${contentRange.end} do not match expected chunk bounds ${expected.start}-${expected.end}`,
        { expected, received: { start: contentRange.start, end: contentRange.end } }
      );
    }

    const rawContentLength = req.headers['content-length'];
    if (!rawContentLength || !/^\d+$/.test(rawContentLength)) {
      throw badRequest('Missing or invalid Content-Length header');
    }
    const contentLength = Number(rawContentLength);
    if (contentLength !== contentRange.length) {
      throw unprocessable(
        `Content-Length (${contentLength}) does not match declared byte range length (${contentRange.length})`
      );
    }

    if (contentRange.length > config.maxChunkBytes) {
      throw payloadTooLarge(
        `Chunk length (${contentRange.length}) exceeds maximum limit (${config.maxChunkBytes})`,
        null,
        { Connection: 'close' }
      );
    }
  } catch (headerErr) {
    req.resume();
    throw headerErr;
  }

  // B1 / A1. Pre-stream fast path for already committed duplicates
  const existingCommitted = metadata.chunks.find((c) => c.index === validIndex);
  if (existingCommitted) {
    if (
      contentRange.start === existingCommitted.start &&
      contentRange.end === existingCommitted.end &&
      expectedSha256 === existingCommitted.checksum
    ) {
      // Check if chunk file on physical disk is intact
      const existingChunkPath = paths.chunkPath(uploadId, validIndex, storageRoot);
      let isIntact = false;
      try {
        const st = await fs.promises.stat(existingChunkPath);
        if (st.size === existingCommitted.size) {
          isIntact = true;
        }
      } catch {
        isIntact = false;
      }

      if (isIntact) {
        // Intact duplicate: drain request body and return 200 without disk writes
        req.resume();
        return {
          chunk: existingCommitted,
          duplicate: true,
          repaired: false
        };
      }
      // If missing or truncated on disk ("damaged"), do NOT short-circuit:
      // continue to normal streaming path to repair the chunk.
    } else {
      // Conflicting duplicate with different checksum: drain and reject with 409
      req.resume();
      const err = conflict('Chunk conflict: index already committed with different checksum', {
        index: validIndex,
        committedChecksum: existingCommitted.checksum,
        receivedChecksum: expectedSha256
      });
      err.code = 'CHUNK_CONFLICT';
      throw err;
    }
  }

  // 4. Stream body to a temporary file under storage/temp
  // Writing to a temporary file first ensures incomplete, dropped, or corrupted transfers
  // are never exposed as committed chunks on disk.
  const declaredLength = contentRange.length;
  const randomSuffix = crypto.randomBytes(6).toString('hex');
  const tempFilename = `${uploadId}-${validIndex}-${randomSuffix}.part`;
  const tempPath = path.join(paths.tempDir(storageRoot), tempFilename);

  const hashTransform = createSha256Transform(declaredLength);
  const fileWriteStream = fs.createWriteStream(tempPath, { flags: 'wx' });

  try {
    await pipeline(req, hashTransform, fileWriteStream);
  } catch (streamErr) {
    if (!fileWriteStream.destroyed) {
      fileWriteStream.destroy();
    }
    await fs.promises.unlink(tempPath).catch(() => {});
    throw streamErr;
  }

  // 5. Post-stream integrity verification
  if (hashTransform.bytesSeen !== declaredLength) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw unprocessable(
      `Received ${hashTransform.bytesSeen} bytes, but declared length was ${declaredLength}`
    );
  }

  const computedDigest = hashTransform.digestHex();
  if (computedDigest !== expectedSha256) {
    await fs.promises.unlink(tempPath).catch(() => {});
    const err = unprocessable('Chunk SHA-256 checksum mismatch', {
      expected: expectedSha256,
      actual: computedDigest
    });
    err.code = 'CHECKSUM_MISMATCH';
    throw err;
  }

  // fsync ensures all chunk bytes are durably persisted to physical media before renaming
  let handle = null;
  try {
    handle = await fs.promises.open(tempPath, 'r+');
    await handle.sync();
  } catch (syncErr) {
    if (handle) {
      try {
        await handle.close();
      } catch {}
      handle = null;
    }
    await fs.promises.unlink(tempPath).catch(() => {});
    throw syncErr;
  }

  if (handle) {
    await handle.close();
  }

  // A3 / A1. In-lock commit, damaged-chunk repair & race resolution
  // The final rename and metadata commit happen INSIDE the per-upload lock to prevent races
  // between concurrent duplicate uploads of the same chunk index.
  const finalChunkPath = paths.chunkPath(uploadId, validIndex, storageRoot);
  let renamed = false;
  let isRepair = false;
  let resultRecord = null;
  let isDuplicate = false;
  let isRepaired = false;

  try {
    await updateMetadata(uploadId, storageRoot, async (draft) => {
      if (!draft) {
        throw notFound(`Upload session "${uploadId}" not found during commit`);
      }

      // (a) State check with fresh draft
      if (draft.state !== 'created' && draft.state !== 'uploading') {
        await fs.promises.unlink(tempPath).catch(() => {});
        throw conflict(`Cannot commit chunk: upload is in state "${draft.state}"`);
      }

      // (b) Check for existing committed record / concurrent race duplicate
      const duplicateRecord = draft.chunks.find((c) => c.index === validIndex);
      if (duplicateRecord) {
        if (duplicateRecord.checksum !== computedDigest) {
          await fs.promises.unlink(tempPath).catch(() => {});
          const err = conflict('Chunk conflict: index already committed with different checksum', {
            index: validIndex,
            committedChecksum: duplicateRecord.checksum,
            receivedChecksum: computedDigest
          });
          err.code = 'CHUNK_CONFLICT';
          throw err;
        }

        // Check if on-disk chunk file is intact
        let isIntact = false;
        try {
          const st = await fs.promises.stat(finalChunkPath);
          if (st.size === duplicateRecord.size) {
            isIntact = true;
          }
        } catch {
          isIntact = false;
        }

        if (isIntact) {
          await fs.promises.unlink(tempPath).catch(() => {});
          isDuplicate = true;
          isRepaired = false;
          resultRecord = duplicateRecord;
          return draft; // Draft unchanged
        }

        // Damaged chunk repair: atomically replace corrupted/missing final file
        await fs.promises.rename(tempPath, finalChunkPath);
        isRepair = true;
        duplicateRecord.committedAt = new Date().toISOString();
        resultRecord = duplicateRecord;
        isDuplicate = false;
        isRepaired = true;
        draft.state = 'uploading';
        return draft;
      }

      // (c) Perform atomic rename inside the lock for brand-new chunk
      await fs.promises.rename(tempPath, finalChunkPath);
      renamed = true;
      isRepair = false;

      const committedAt = new Date().toISOString();
      resultRecord = {
        index: validIndex,
        start: contentRange.start,
        end: contentRange.end,
        size: declaredLength,
        checksum: computedDigest,
        committedAt,
        status: 'committed'
      };

      draft.chunks.push(resultRecord);
      // Keep chunks sorted by zero-based index
      draft.chunks.sort((a, b) => a.index - b.index);
      draft.state = 'uploading';
      isDuplicate = false;
      isRepaired = false;

      return draft;
    });
  } catch (commitErr) {
    // If updateMetadata rejected after the rename succeeded on a brand-new chunk,
    // roll back by removing the renamed file. For repairs, NEVER unlink the final file.
    if (renamed && !isRepair) {
      await fs.promises.unlink(finalChunkPath).catch(() => {});
    }
    // Clean up temp file if not yet renamed or deleted
    await fs.promises.unlink(tempPath).catch(() => {});
    throw commitErr;
  }

  return {
    chunk: resultRecord,
    duplicate: isDuplicate,
    repaired: isRepaired
  };
}

module.exports = {
  receiveChunk
};
