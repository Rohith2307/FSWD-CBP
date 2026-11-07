const fs = require('node:fs');
const path = require('node:path');
const paths = require('../storage/paths');
const { readMetadata, updateMetadata } = require('../storage/metadataStore');
const finalizer = require('./finalizer');

/**
 * Storage Cleanup & Session Lifecycle Management Service
 *
 * Architectural & Protocol Design Principles:
 *
 * 1. Why sessions expire instead of being deleted:
 *    Deleting upload sessions abruptly breaks HTTP semantics and creates client ambiguity.
 *    If an in-progress or interrupted upload session was silently deleted, subsequent client requests
 *    (such as a resume query or delayed in-flight chunk PUT) would receive 404 Not Found, making it
 *    impossible for the client to distinguish between a non-existent session and an expired one.
 *    Marking sessions with state "expired" provides explicit protocol feedback (409 SESSION_EXPIRED),
 *    while still freeing disk space by deleting underlying chunk payload data.
 *
 * 2. Why cleanup never deletes "ready" data or metadata.json:
 *    Sessions in the "ready" state represent successfully published media assets. The media files and
 *    their authoritative metadata are immutable catalog items and must be preserved permanently unless
 *    explicitly removed by user action. Retaining metadata.json and metrics.json for expired uploads
 *    preserves telemetry, audit logs, and accounting history without consuming chunk file storage.
 *
 * 3. Why orphan deletion has a grace period (orphanGraceMs):
 *    During high-concurrency chunk uploads, there is a brief physical window between when a temporary
 *    chunk file is fsynced/renamed and when the atomic metadata ledger update completes. Furthermore,
 *    incoming network transfers might write chunk files while an upload request is actively in flight.
 *    An immediate deletion of unreferenced files would introduce severe race conditions, deleting valid
 *    data mid-flight. The grace period (default 1 hour) ensures that only genuinely abandoned orphan files
 *    are pruned.
 *
 * 4. Why cleanup logs IDs only (never paths or names):
 *    To maintain data privacy and security compliance, server logs must never leak absolute filesystem
 *    paths, internal directory layouts, or user-supplied original filenames. Logging only opaque UUIDs
 *    (uploadId or mediaId) provides full traceability without exposing sensitive metadata.
 */

/**
 * Pure helper: Computes the newest activity timestamp for an upload metadata object.
 * Checks createdAt, finalizeStartedAt, and all chunk committedAt timestamps.
 *
 * @param {object} metadata
 * @returns {number} Timestamp in ms
 */
function getSessionNewestActivityMs(metadata) {
  if (!metadata) return 0;
  let newest = 0;

  if (metadata.createdAt) {
    const t = Date.parse(metadata.createdAt);
    if (!Number.isNaN(t) && t > newest) newest = t;
  }

  if (metadata.finalizeStartedAt) {
    const t = Date.parse(metadata.finalizeStartedAt);
    if (!Number.isNaN(t) && t > newest) newest = t;
  }

  if (Array.isArray(metadata.chunks)) {
    for (const chunk of metadata.chunks) {
      if (chunk && chunk.committedAt) {
        const t = Date.parse(chunk.committedAt);
        if (!Number.isNaN(t) && t > newest) newest = t;
      }
    }
  }

  return newest;
}

/**
 * Sweeps storage/temp to delete temporary files older than tempFileTtlMs.
 * Never follows symlinks; only inspects regular files directly inside temp/.
 * Protects active assembly files whose uploadId is in finalizer's active set.
 *
 * @param {object} params
 * @param {string} params.storageRoot
 * @param {number} params.tempFileTtlMs
 * @param {number} [params.nowMs]
 * @param {boolean} [params.dryRun]
 * @returns {Promise<{ tempDeleted: number, errors: Array<{ item: string, error: string }> }>}
 */
async function sweepTemp({ storageRoot, tempFileTtlMs, nowMs = Date.now(), dryRun = false }) {
  const tempDirectory = paths.tempDir(storageRoot);
  let tempDeleted = 0;
  const errors = [];

  let entries = [];
  try {
    entries = await fs.promises.readdir(tempDirectory);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { tempDeleted: 0, errors: [] };
    }
    errors.push({ item: 'temp', error: err.code || err.message });
    return { tempDeleted: 0, errors };
  }

  const activeFinalizations =
    typeof finalizer.getActiveFinalizations === 'function'
      ? finalizer.getActiveFinalizations()
      : finalizer._activeFinalizations || new Set();

  for (const entryName of entries) {
    const fullPath = path.join(tempDirectory, entryName);
    try {
      // Use lstat to inspect file without following symbolic links
      const stat = await fs.promises.lstat(fullPath);

      // Never delete directories or follow symlinks; regular files only
      if (stat.isSymbolicLink() || !stat.isFile()) {
        continue;
      }

      // Check active finalization exclusion
      let isActiveFinalization = false;
      for (const uploadId of activeFinalizations) {
        if (entryName.startsWith(`${uploadId}-final-`)) {
          isActiveFinalization = true;
          break;
        }
      }
      if (isActiveFinalization) {
        continue;
      }

      const ageMs = nowMs - stat.mtimeMs;
      if (ageMs >= tempFileTtlMs) {
        if (!dryRun) {
          await fs.promises.unlink(fullPath);
          console.log(`[Cleanup] Deleted stale temp file: ${entryName.split('-')[0]}`);
        }
        tempDeleted++;
      }
    } catch (err) {
      errors.push({ item: entryName, error: err.code || err.message });
    }
  }

  return { tempDeleted, errors };
}

/**
 * Expires stale upload sessions older than sessionTtlMs.
 * Sets state to "expired", deletes chunk files and part temp files, and keeps metadata/metrics.
 *
 * @param {object} params
 * @param {string} params.storageRoot
 * @param {number} params.sessionTtlMs
 * @param {number} [params.nowMs]
 * @param {boolean} [params.dryRun]
 * @returns {Promise<{ sessionsExpired: number, errors: Array<{ item: string, error: string }> }>}
 */
async function expireSessions({ storageRoot, sessionTtlMs, nowMs = Date.now(), dryRun = false, _beforeExpireHook }) {
  const uploadsDirectory = paths.uploadsDir(storageRoot);
  let sessionsExpired = 0;
  const errors = [];

  let entries = [];
  try {
    entries = await fs.promises.readdir(uploadsDirectory, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { sessionsExpired: 0, errors: [] };
    }
    errors.push({ item: 'uploads', error: err.code || err.message });
    return { sessionsExpired: 0, errors };
  }

  const activeFinalizations =
    typeof finalizer.getActiveFinalizations === 'function'
      ? finalizer.getActiveFinalizations()
      : finalizer._activeFinalizations || new Set();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const uploadId = entry.name;

    try {
      paths.assertValidId(uploadId);
    } catch {
      continue;
    }

    try {
      const metadata = await readMetadata(uploadId, storageRoot);
      if (!metadata) continue;

      // "ready" sessions are never expired
      if (metadata.state === 'ready' || metadata.state === 'expired') {
        continue;
      }

      // Check if session is in created, uploading, or stale finalizing
      const isStaleFinalizing =
        metadata.state === 'finalizing' && !activeFinalizations.has(uploadId);
      const isEligibleState =
        metadata.state === 'created' || metadata.state === 'uploading' || isStaleFinalizing;

      if (!isEligibleState) {
        continue;
      }

      const newestActivityMs = getSessionNewestActivityMs(metadata);
      const ageMs = nowMs - newestActivityMs;

      if (ageMs >= sessionTtlMs) {
        if (!dryRun) {
          // Injectable hook for testing race conditions
          if (typeof _beforeExpireHook === 'function') {
            await _beforeExpireHook({ uploadId, metadata });
          }

          let actuallyExpired = false;
          // Inside updateMetadata, re-check fresh draft under per-upload lock
          await updateMetadata(uploadId, storageRoot, (draft) => {
            if (!draft) return draft;
            if (draft.state === 'ready' || draft.state === 'expired') {
              return draft;
            }
            const isStaleDraftFinalizing =
              draft.state === 'finalizing' && !activeFinalizations.has(uploadId);
            const isDraftEligible =
              draft.state === 'created' || draft.state === 'uploading' || isStaleDraftFinalizing;

            if (!isDraftEligible) {
              return draft;
            }

            const freshActivityMs = getSessionNewestActivityMs(draft);
            if (nowMs - freshActivityMs < sessionTtlMs) {
              return draft;
            }

            draft.state = 'expired';
            draft.expiredAt = new Date(nowMs).toISOString();
            actuallyExpired = true;
            return draft;
          });

          if (actuallyExpired) {
            // Best-effort removal of chunk files
            const chunksDirectory = paths.chunksDir(uploadId, storageRoot);
            try {
              const chunkFiles = await fs.promises.readdir(chunksDirectory);
              for (const cf of chunkFiles) {
                await fs.promises.unlink(path.join(chunksDirectory, cf)).catch(() => {});
              }
            } catch {}

            // Best-effort removal of temp part files for this uploadId
            const tempDirectory = paths.tempDir(storageRoot);
            try {
              const tempFiles = await fs.promises.readdir(tempDirectory);
              for (const tf of tempFiles) {
                if (tf.startsWith(`${uploadId}-`) && tf.endsWith('.part')) {
                  await fs.promises.unlink(path.join(tempDirectory, tf)).catch(() => {});
                }
              }
            } catch {}

            console.log(`[Cleanup] Expired upload session: ${uploadId}`);
            sessionsExpired++;
          }
        } else {
          sessionsExpired++;
        }
      }
    } catch (err) {
      errors.push({ item: uploadId, error: err.code || err.message });
    }
  }

  return { sessionsExpired, errors };
}

/**
 * Sweeps orphan chunk files, orphan media files, and detects orphan media JSON.
 *
 * @param {object} params
 * @param {string} params.storageRoot
 * @param {number} params.orphanGraceMs
 * @param {number} [params.nowMs]
 * @param {boolean} [params.dryRun]
 * @returns {Promise<{ orphanChunksDeleted: number, orphanMediaDeleted: number, orphanMediaJson: string[], errors: Array<{ item: string, error: string }> }>}
 */
async function sweepOrphans({ storageRoot, orphanGraceMs, nowMs = Date.now(), dryRun = false }) {
  let orphanChunksDeleted = 0;
  let orphanMediaDeleted = 0;
  const orphanMediaJson = [];
  const errors = [];

  // (a) Sweep orphan chunk files in uploads/<id>/chunks
  const uploadsDirectory = paths.uploadsDir(storageRoot);
  try {
    const uploadDirs = await fs.promises.readdir(uploadsDirectory, { withFileTypes: true });
    for (const dir of uploadDirs) {
      if (!dir.isDirectory()) continue;
      const uploadId = dir.name;
      try {
        paths.assertValidId(uploadId);
      } catch {
        continue;
      }

      try {
        const metadata = await readMetadata(uploadId, storageRoot);
        // If upload has no valid metadata, skip chunk inspection (handled by session manager)
        if (!metadata || !Array.isArray(metadata.chunks)) continue;

        const committedIndices = new Set(metadata.chunks.map((c) => c.index));
        const chunksDir = paths.chunksDir(uploadId, storageRoot);

        let chunkEntries = [];
        try {
          chunkEntries = await fs.promises.readdir(chunksDir);
        } catch {
          continue;
        }

        for (const chunkFileName of chunkEntries) {
          const chunkFilePath = path.join(chunksDir, chunkFileName);
          try {
            const stat = await fs.promises.lstat(chunkFilePath);
            if (stat.isSymbolicLink() || !stat.isFile()) continue;

            const chunkIndex = paths.parseChunkFilename(chunkFileName);
            if (chunkIndex === null) continue;
            const isCommitted = committedIndices.has(chunkIndex);

            if (!isCommitted) {
              const ageMs = nowMs - stat.mtimeMs;
              if (ageMs >= orphanGraceMs) {
                if (!dryRun) {
                  await fs.promises.unlink(chunkFilePath);
                  console.log(`[Cleanup] Deleted orphan chunk: ${uploadId} index ${chunkIndex}`);
                }
                orphanChunksDeleted++;
              }
            }
          } catch (err) {
            errors.push({ item: `${uploadId}/${chunkFileName}`, error: err.code || err.message });
          }
        }
      } catch (err) {
        errors.push({ item: uploadId, error: err.code || err.message });
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      errors.push({ item: 'uploadsDir', error: err.code || err.message });
    }
  }

  // (b) and (c) Sweep storage/media
  const mediaDirectory = paths.mediaDir(storageRoot);
  try {
    const mediaEntries = await fs.promises.readdir(mediaDirectory);
    const mediaJsonIds = new Set();
    const mediaFiles = [];

    for (const entryName of mediaEntries) {
      if (entryName.endsWith('.json')) {
        const mediaId = entryName.slice(0, -5);
        mediaJsonIds.add(mediaId);
      } else {
        mediaFiles.push(entryName);
      }
    }

    // (b) Media files without matching JSON older than orphanGraceMs -> delete
    for (const mediaFileName of mediaFiles) {
      const dotIdx = mediaFileName.lastIndexOf('.');
      const mediaId = dotIdx === -1 ? mediaFileName : mediaFileName.slice(0, dotIdx);
      const mediaFilePath = path.join(mediaDirectory, mediaFileName);

      try {
        const stat = await fs.promises.lstat(mediaFilePath);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;

        if (!mediaJsonIds.has(mediaId)) {
          const ageMs = nowMs - stat.mtimeMs;
          if (ageMs >= orphanGraceMs) {
            if (!dryRun) {
              await fs.promises.unlink(mediaFilePath);
              console.log(`[Cleanup] Deleted orphan media file: ${mediaId}`);
            }
            orphanMediaDeleted++;
          }
        }
      } catch (err) {
        errors.push({ item: mediaFileName, error: err.code || err.message });
      }
    }

    // (c) Media JSON whose media file is missing -> report only (never delete)
    for (const mediaId of mediaJsonIds) {
      const jsonFilePath = path.join(mediaDirectory, `${mediaId}.json`);
      try {
        const raw = await fs.promises.readFile(jsonFilePath, 'utf8');
        const meta = JSON.parse(raw);
        const storedFile = meta?.storedFile;

        let fileExists = false;
        if (typeof storedFile === 'string') {
          const expectedMediaPath = path.join(mediaDirectory, storedFile);
          try {
            await fs.promises.access(expectedMediaPath, fs.constants.F_OK);
            fileExists = true;
          } catch {
            fileExists = false;
          }
        }

        if (!fileExists) {
          orphanMediaJson.push(mediaId);
        }
      } catch (err) {
        errors.push({ item: `${mediaId}.json`, error: err.code || err.message });
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      errors.push({ item: 'mediaDir', error: err.code || err.message });
    }
  }

  return {
    orphanChunksDeleted,
    orphanMediaDeleted,
    orphanMediaJson,
    errors
  };
}

/**
 * Runs a complete cleanup sweep.
 *
 * @param {object} options
 * @param {string} options.storageRoot
 * @param {object} [options.config]
 * @param {number} [options.nowMs]
 * @param {boolean} [options.dryRun]
 * @returns {Promise<{ tempDeleted: number, sessionsExpired: number, orphanChunksDeleted: number, orphanMediaDeleted: number, orphanMediaJson: string[], errors: Array<{ item: string, error: string }> }>}
 */
async function runCleanup({
  storageRoot,
  config = {},
  nowMs = Date.now(),
  dryRun = false,
  _beforeExpireHook
} = {}) {
  if (!storageRoot || typeof storageRoot !== 'string') {
    throw new Error('runCleanup requires storageRoot');
  }

  const tempFileTtlMs = config.tempFileTtlMs ?? 60 * 60 * 1000;
  const sessionTtlMs = config.sessionTtlMs ?? 24 * 60 * 60 * 1000;
  const orphanGraceMs = config.orphanGraceMs ?? 60 * 60 * 1000;

  const report = {
    tempDeleted: 0,
    sessionsExpired: 0,
    orphanChunksDeleted: 0,
    orphanMediaDeleted: 0,
    orphanMediaJson: [],
    errors: []
  };

  try {
    const tempResult = await sweepTemp({ storageRoot, tempFileTtlMs, nowMs, dryRun });
    report.tempDeleted = tempResult.tempDeleted;
    report.errors.push(...tempResult.errors);
  } catch (err) {
    report.errors.push({ item: 'sweepTemp', error: err.code || err.message });
  }

  try {
    const sessionResult = await expireSessions({ storageRoot, sessionTtlMs, nowMs, dryRun, _beforeExpireHook });
    report.sessionsExpired = sessionResult.sessionsExpired;
    report.errors.push(...sessionResult.errors);
  } catch (err) {
    report.errors.push({ item: 'expireSessions', error: err.code || err.message });
  }

  try {
    const orphanResult = await sweepOrphans({ storageRoot, orphanGraceMs, nowMs, dryRun });
    report.orphanChunksDeleted = orphanResult.orphanChunksDeleted;
    report.orphanMediaDeleted = orphanResult.orphanMediaDeleted;
    report.orphanMediaJson = orphanResult.orphanMediaJson;
    report.errors.push(...orphanResult.errors);
  } catch (err) {
    report.errors.push({ item: 'sweepOrphans', error: err.code || err.message });
  }

  return report;
}

module.exports = {
  runCleanup,
  sweepTemp,
  expireSessions,
  sweepOrphans,
  getSessionNewestActivityMs
};
