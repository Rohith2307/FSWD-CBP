const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic, readMetadata } = require('../storage/metadataStore');
const { metricsPath } = require('../storage/paths');
const {
  nowMonotonicMs,
  mergeActiveIntervals,
  activeMs,
  bytesPerSecond,
  toMiBps,
  median,
  recentThroughput,
  estimateEta,
  recommendChunkSize,
  resendEfficiency
} = require('./metrics');

/**
 * Stateful Metrics Store
 *
 * Architectural & Protocol Design Notes:
 *
 * 1. Why the store is instantiated per server instance (no global singleton):
 *    Creating the store within createServer() ensures isolated runtime state. Multiple server
 *    instances (e.g. In unit tests or multi-tenant setups) do not leak metrics, active timers,
 *    or upload caches across each other.
 *
 * 2. Why metrics persistence failures are swallowed and logged (ID only):
 *    Metrics tracking is an observability layer, never the critical path of file storage.
 *    If disk write for metrics.json fails (e.g., Disk full, permissions), chunk reception
 *    and commit MUST still succeed. Swallowing persistence errors and logging the uploadId
 *    guarantees that client uploads are never failed or delayed by metrics I/O.
 *
 * 3. LRU In-memory Cache & Ring Buffers:
 *    Limits memory consumption by capping tracked uploads to 200 via LRU eviction, capping
 *    recent chunk records to 32 per upload, capping duration history to 2048 samples, and
 *    capping the global rolling window to 20 chunks.
 */

const DEFINITIONS = Object.freeze({
  activeMs:
    'Total milliseconds server was actively processing chunks, merging overlapping chunks and idle gaps < 1000ms (merged gaps < 1000ms count as active)',
  wallMs:
    'Wall-clock milliseconds from start of first chunk attempt to end of last chunk commit (lastEndMs - firstStartMs)',
  resendEfficiency:
    'Ratio of resent chunk bytes (duplicates + repairs) to expected file size; lower is better (0 is optimal)',
  throughput:
    'Server-observed processing throughput based on committed chunks over active time',
  eta: 'Estimated seconds remaining based on recent throughput; estimate only, not a guarantee'
});

/**
 * Creates an isolated metrics store instance.
 *
 * @param {object} options
 * @param {string} options.storageRoot
 * @param {object} options.config
 * @returns {object}
 */
function createMetricsStore({ storageRoot, config }) {
  if (!storageRoot || typeof storageRoot !== 'string') {
    throw new Error('MetricsStore: storageRoot is required');
  }

  // LRU map: uploadId -> metrics state (max 200)
  const uploads = new Map();
  const dirtyTimers = new Map();

  // Process-wide rolling window of last 20 committed chunks
  const globalRecentRecords = [];

  // In-memory non-durable media stats: mediaId -> { requests, bytesServed, partialResponses, notModified, abortedResponses }
  const mediaStats = new Map();

  let peakRssBytes = process.memoryUsage().rss;
  let testPersistenceFailureHook = null;

  function sampleRss() {
    const mem = process.memoryUsage();
    if (mem.rss > peakRssBytes) {
      peakRssBytes = mem.rss;
    }
    return mem;
  }

  function getOrCreateEntry(uploadId) {
    if (uploads.has(uploadId)) {
      // Refresh LRU position
      const entry = uploads.get(uploadId);
      uploads.delete(uploadId);
      uploads.set(uploadId, entry);
      return entry;
    }

    const entry = {
      uploadId,
      counters: {
        attempts: 0,
        committed: 0,
        duplicates: 0,
        repaired: 0,
        rejected: 0,
        conflicts: 0,
        checksumMismatches: 0,
        aborted: 0
      },
      perIndexAttempts: {},
      bytes: {
        declaredOnAttempts: 0,
        committed: 0,
        resent: 0
      },
      mergedIntervals: [],
      recentRecords: [],
      chunkDurationsMs: [],
      firstStartMs: null,
      lastEndMs: null,
      firstAttemptAt: null,
      lastCommitAt: null,
      finalize: null,
      finalizeFailures: []
    };

    if (uploads.size >= 200) {
      const oldestId = uploads.keys().next().value;
      uploads.delete(oldestId);
    }

    uploads.set(uploadId, entry);
    return entry;
  }

  function scheduleFlush(uploadId) {
    if (dirtyTimers.has(uploadId)) {
      clearTimeout(dirtyTimers.get(uploadId));
    }

    const timer = setTimeout(() => {
      dirtyTimers.delete(uploadId);
      flush(uploadId).catch(() => {});
    }, 500);

    timer.unref();
    dirtyTimers.set(uploadId, timer);
  }

  async function flush(uploadId) {
    if (dirtyTimers.has(uploadId)) {
      clearTimeout(dirtyTimers.get(uploadId));
      dirtyTimers.delete(uploadId);
    }

    const entry = uploads.get(uploadId);
    if (!entry) return;

    try {
      if (typeof testPersistenceFailureHook === 'function') {
        testPersistenceFailureHook();
      } else if (testPersistenceFailureHook === true) {
        throw new Error('Injected metrics persistence failure');
      }

      const filePath = metricsPath(uploadId, storageRoot);
      const monoOriginEpochMs = Date.now() - nowMonotonicMs();
      const payload = {
        uploadId: entry.uploadId,
        monoOriginEpochMs,
        counters: { ...entry.counters },
        perIndexAttempts: { ...entry.perIndexAttempts },
        bytes: { ...entry.bytes },
        mergedIntervals: [...entry.mergedIntervals],
        recentRecords: [...entry.recentRecords],
        chunkDurationsMs: [...entry.chunkDurationsMs],
        firstStartMs: entry.firstStartMs,
        lastEndMs: entry.lastEndMs,
        firstAttemptAt: entry.firstAttemptAt,
        lastCommitAt: entry.lastCommitAt,
        finalize: entry.finalize ? { ...entry.finalize } : null,
        finalizeFailures: [...entry.finalizeFailures],
        savedAt: new Date().toISOString()
      };

      await writeJsonAtomic(filePath, payload);
    } catch (err) {
      // Swallowed: metrics persistence error must never fail or delay client requests
      console.error(`[MetricsStore] Failed to persist metrics for upload: ${uploadId}`);
    }
  }

  async function flushAll() {
    const ids = Array.from(new Set([...uploads.keys(), ...dirtyTimers.keys()]));
    for (const id of ids) {
      await flush(id);
    }
  }

  function recordChunkAttempt(
    uploadId,
    { index, declaredBytes = 0, startMs, endMs, outcome, code }
  ) {
    if (!uploadId || typeof uploadId !== 'string') return;
    sampleRss();

    const entry = getOrCreateEntry(uploadId);
    entry.counters.attempts++;

    const numIndex = Number(index);
    entry.perIndexAttempts[numIndex] = (entry.perIndexAttempts[numIndex] || 0) + 1;
    entry.bytes.declaredOnAttempts += declaredBytes;

    if (entry.firstStartMs === null || startMs < entry.firstStartMs) {
      entry.firstStartMs = startMs;
      const nowMs = nowMonotonicMs();
      const offsetMs = Math.max(0, nowMs - startMs);
      entry.firstAttemptAt = new Date(Date.now() - offsetMs).toISOString();
    }

    const durationMs = Math.max(0, endMs - startMs);

    switch (outcome) {
      case 'committed': {
        entry.counters.committed++;
        entry.bytes.committed += declaredBytes;
        if (entry.lastEndMs === null || endMs > entry.lastEndMs) {
          entry.lastEndMs = endMs;
          const nowMs = nowMonotonicMs();
          const offsetMs = Math.max(0, nowMs - endMs);
          entry.lastCommitAt = new Date(Date.now() - offsetMs).toISOString();
        }

        entry.chunkDurationsMs.push(durationMs);
        if (entry.chunkDurationsMs.length > 2048) {
          entry.chunkDurationsMs.shift();
        }

        const rec = { bytes: declaredBytes, startMs, endMs };
        entry.recentRecords.push(rec);
        if (entry.recentRecords.length > 32) {
          entry.recentRecords.shift();
        }

        globalRecentRecords.push(rec);
        if (globalRecentRecords.length > 20) {
          globalRecentRecords.shift();
        }

        entry.mergedIntervals = mergeActiveIntervals([
          ...entry.mergedIntervals,
          { startMs, endMs }
        ]);
        break;
      }

      case 'repaired': {
        entry.counters.repaired++;
        entry.bytes.resent += declaredBytes;
        if (entry.lastEndMs === null || endMs > entry.lastEndMs) {
          entry.lastEndMs = endMs;
          const nowMs = nowMonotonicMs();
          const offsetMs = Math.max(0, nowMs - endMs);
          entry.lastCommitAt = new Date(Date.now() - offsetMs).toISOString();
        }

        entry.chunkDurationsMs.push(durationMs);
        if (entry.chunkDurationsMs.length > 2048) {
          entry.chunkDurationsMs.shift();
        }

        const rec = { bytes: declaredBytes, startMs, endMs };
        entry.recentRecords.push(rec);
        if (entry.recentRecords.length > 32) {
          entry.recentRecords.shift();
        }

        globalRecentRecords.push(rec);
        if (globalRecentRecords.length > 20) {
          globalRecentRecords.shift();
        }

        entry.mergedIntervals = mergeActiveIntervals([
          ...entry.mergedIntervals,
          { startMs, endMs }
        ]);
        break;
      }

      case 'duplicate': {
        entry.counters.duplicates++;
        entry.bytes.resent += declaredBytes;
        break;
      }

      case 'conflict': {
        entry.counters.rejected++;
        entry.counters.conflicts++;
        break;
      }

      case 'checksum_mismatch': {
        entry.counters.rejected++;
        entry.counters.checksumMismatches++;
        break;
      }

      case 'rejected': {
        entry.counters.rejected++;
        break;
      }

      case 'aborted': {
        entry.counters.aborted++;
        break;
      }

      default:
        break;
    }

    scheduleFlush(uploadId);
  }

  function recordFinalize(uploadId, result) {
    if (!uploadId) return;
    sampleRss();

    const entry = getOrCreateEntry(uploadId);
    // Do not overwrite an existing finalize record with an idempotent assemblyMs: 0 replay
    if (!entry.finalize || (result.assemblyMs > 0 && entry.finalize.assemblyMs === 0)) {
      entry.finalize = {
        assemblyMs: result.assemblyMs,
        verifiedChunks: result.verifiedChunks,
        sha256: result.sha256,
        at: new Date().toISOString()
      };
    }

    flush(uploadId).catch(() => {});
  }

  function recordFinalizeFailure(uploadId, code) {
    if (!uploadId) return;
    sampleRss();

    const entry = getOrCreateEntry(uploadId);
    entry.finalizeFailures.push({
      code: code || 'UNKNOWN',
      at: new Date().toISOString()
    });

    if (entry.finalizeFailures.length > 10) {
      entry.finalizeFailures.shift();
    }

    flush(uploadId).catch(() => {});
  }

  function recordMediaServed(mediaId, { bytesSent = 0, status, aborted = false, method }) {
    if (!mediaId || method === 'HEAD') return;
    sampleRss();

    let stat = mediaStats.get(mediaId);
    if (!stat) {
      stat = {
        requests: 0,
        bytesServed: 0,
        partialResponses: 0,
        notModified: 0,
        abortedResponses: 0
      };
      mediaStats.set(mediaId, stat);
    }

    if (status === 304) {
      stat.notModified++;
    } else {
      stat.requests++;
      stat.bytesServed += bytesSent;
    }

    if (status === 206) {
      stat.partialResponses++;
    }

    if (aborted) {
      stat.abortedResponses++;
    }
  }

  function getMediaReport(mediaId) {
    if (!mediaId) return null;
    const stat = mediaStats.get(mediaId) || {
      requests: 0,
      bytesServed: 0,
      partialResponses: 0,
      notModified: 0,
      abortedResponses: 0
    };

    return {
      durable: false,
      mediaId,
      requests: stat.requests,
      bytesServed: stat.bytesServed,
      partialResponses: stat.partialResponses,
      notModified: stat.notModified,
      abortedResponses: stat.abortedResponses
    };
  }

  async function loadPersistedEntry(uploadId) {
    const metricsFilePath = metricsPath(uploadId, storageRoot);
    try {
      const raw = await fs.promises.readFile(metricsFilePath, 'utf8');
      const loaded = JSON.parse(raw);
      if (loaded && loaded.uploadId === uploadId) {
        const currentOrigin = Date.now() - nowMonotonicMs();
        const storedOrigin =
          typeof loaded.monoOriginEpochMs === 'number' ? loaded.monoOriginEpochMs : null;
        const shift =
          storedOrigin !== null && storedOrigin !== currentOrigin
            ? storedOrigin - currentOrigin
            : 0;

        const mergedIntervals = (
          Array.isArray(loaded.mergedIntervals) ? loaded.mergedIntervals : []
        ).map((iv) => ({
          startMs: iv.startMs + shift,
          endMs: iv.endMs + shift
        }));

        const recentRecords = (
          Array.isArray(loaded.recentRecords) ? loaded.recentRecords : []
        ).map((rec) => ({
          ...rec,
          startMs: typeof rec.startMs === 'number' ? rec.startMs + shift : rec.startMs,
          endMs: typeof rec.endMs === 'number' ? rec.endMs + shift : rec.endMs
        }));

        const firstStartMs =
          typeof loaded.firstStartMs === 'number' ? loaded.firstStartMs + shift : null;
        const lastEndMs =
          typeof loaded.lastEndMs === 'number' ? loaded.lastEndMs + shift : null;

        const entry = {
          uploadId,
          counters: { ...loaded.counters },
          perIndexAttempts: { ...loaded.perIndexAttempts },
          bytes: { ...loaded.bytes },
          mergedIntervals,
          recentRecords,
          chunkDurationsMs: Array.isArray(loaded.chunkDurationsMs) ? loaded.chunkDurationsMs : [],
          firstStartMs,
          lastEndMs,
          firstAttemptAt: loaded.firstAttemptAt || null,
          lastCommitAt: loaded.lastCommitAt || null,
          finalize: loaded.finalize || null,
          finalizeFailures: Array.isArray(loaded.finalizeFailures) ? loaded.finalizeFailures : []
        };
        uploads.set(uploadId, entry);
        return entry;
      }
    } catch {
      // File not found or corrupt
    }
    return null;
  }

  async function getReport(uploadId) {
    if (!uploadId || typeof uploadId !== 'string') {
      return null;
    }

    sampleRss();

    // Authoritative upload metadata check
    const metadata = await readMetadata(uploadId, storageRoot);
    if (!metadata) {
      return null;
    }

    let entry = uploads.get(uploadId);
    if (!entry) {
      entry = await loadPersistedEntry(uploadId);
    }

    const expectedBytes = metadata.expectedSize;
    const committedChunks = metadata.chunks ? metadata.chunks.length : 0;
    const committedBytes = metadata.chunks
      ? metadata.chunks.reduce((acc, c) => acc + c.size, 0)
      : 0;
    const remainingBytes = Math.max(0, expectedBytes - committedBytes);

    // If no in-memory or persisted metrics exist, synthesize a partial report
    if (!entry) {
      return {
        uploadId: metadata.uploadId,
        state: metadata.state,
        partial: true,
        size: {
          expectedBytes,
          committedBytes,
          remainingBytes,
          chunkSize: metadata.chunkSize,
          totalChunks: metadata.totalChunks || metadata.chunkCount || 0,
          committedChunks
        },
        counters: {
          attempts: committedChunks,
          committed: committedChunks,
          duplicates: 0,
          repaired: 0,
          rejected: 0,
          conflicts: 0,
          checksumMismatches: 0,
          aborted: 0,
          retries: 0
        },
        bytes: {
          declaredOnAttempts: committedBytes,
          resentDeclared: 0
        },
        timing: {
          basis: 'server-observed',
          firstAttemptAt: null,
          lastCommitAt: metadata.updatedAt || null,
          activeMs: 0,
          wallMs: 0,
          medianChunkMs: 0,
          avgChunkMs: 0
        },
        throughput: {
          basis: 'server-observed',
          overallBytesPerSecond: 0,
          overallMiBPerSecond: 0,
          recentBytesPerSecond: 0,
          recentMiBPerSecond: 0,
          recentWindowChunks: 0
        },
        eta: {
          available: remainingBytes === 0,
          seconds: remainingBytes === 0 ? 0 : undefined,
          reason: remainingBytes === 0 ? undefined : 'insufficient_data'
        },
        resume: {
          bytesResentDeclared: 0,
          resendEfficiency: 0
        },
        integrity: {
          checksumMismatches: 0,
          chunksVerified: committedChunks,
          finalSha256: metadata.finalSha256 || null
        },
        finalize:
          metadata.state === 'ready'
            ? {
                assemblyMs: 0,
                verifiedChunks: committedChunks,
                sha256: metadata.finalSha256,
                at: metadata.updatedAt
              }
            : null,
        finalizeFailures: [],
        media: metadata.mediaId ? getMediaReport(metadata.mediaId) : null,
        recommendation: recommendChunkSize({
          recentBytesPerSecond: 0,
          samples: 0,
          failurePermille: 0,
          minChunkBytes: config.minChunkBytes,
          maxChunkBytes: config.maxChunkBytes,
          defaultChunkBytes: config.defaultChunkBytes
        }),
        definitions: DEFINITIONS
      };
    }

    // Full report
    const activeTimeMs = activeMs(entry.mergedIntervals);
    let wallMs = 0;
    if (entry.firstStartMs !== null && entry.lastEndMs !== null) {
      wallMs = Math.max(0, entry.lastEndMs - entry.firstStartMs);
    } else if (entry.firstAttemptAt && entry.lastCommitAt) {
      wallMs = Math.max(0, new Date(entry.lastCommitAt).getTime() - new Date(entry.firstAttemptAt).getTime());
    }

    const overallBps = bytesPerSecond(committedBytes, activeTimeMs);
    const overallMiB = toMiBps(overallBps);

    const recent = recentThroughput(entry.recentRecords, 8);
    const recentBps = recent.bytesPerSecond;
    const recentMiB = toMiBps(recentBps);

    const eta = estimateEta({
      remainingBytes,
      recentBytesPerSecond: recentBps,
      samples: recent.samples,
      minSamples: 3
    });

    const retries = Object.values(entry.perIndexAttempts).reduce(
      (acc, count) => acc + Math.max(0, count - 1),
      0
    );

    const failureCount = entry.counters.rejected + entry.counters.aborted;
    const failurePermille =
      entry.counters.attempts > 0 ? Math.floor((failureCount * 1000) / entry.counters.attempts) : 0;

    const recommendation = recommendChunkSize({
      recentBytesPerSecond: recentBps,
      samples: recent.samples,
      failurePermille,
      minChunkBytes: config.minChunkBytes,
      maxChunkBytes: config.maxChunkBytes,
      defaultChunkBytes: config.defaultChunkBytes
    });

    const avgChunkMs =
      entry.chunkDurationsMs.length === 0
        ? 0
        : Math.floor(
            entry.chunkDurationsMs.reduce((a, b) => a + b, 0) / entry.chunkDurationsMs.length
          );

    const resendEff = resendEfficiency(entry.bytes.resent, expectedBytes);

    return {
      uploadId: metadata.uploadId,
      state: metadata.state,
      partial: false,
      size: {
        expectedBytes,
        committedBytes,
        remainingBytes,
        chunkSize: metadata.chunkSize,
        totalChunks: metadata.totalChunks || metadata.chunkCount || 0,
        committedChunks
      },
      counters: {
        attempts: entry.counters.attempts,
        committed: entry.counters.committed,
        duplicates: entry.counters.duplicates,
        repaired: entry.counters.repaired,
        rejected: entry.counters.rejected,
        conflicts: entry.counters.conflicts,
        checksumMismatches: entry.counters.checksumMismatches,
        aborted: entry.counters.aborted,
        retries
      },
      bytes: {
        declaredOnAttempts: entry.bytes.declaredOnAttempts,
        resentDeclared: entry.bytes.resent
      },
      timing: {
        basis: 'server-observed',
        firstAttemptAt: entry.firstAttemptAt,
        lastCommitAt: entry.lastCommitAt,
        activeMs: activeTimeMs,
        wallMs,
        medianChunkMs: median(entry.chunkDurationsMs),
        avgChunkMs
      },
      throughput: {
        basis: 'server-observed',
        overallBytesPerSecond: overallBps,
        overallMiBPerSecond: overallMiB,
        recentBytesPerSecond: recentBps,
        recentMiBPerSecond: recentMiB,
        recentWindowChunks: recent.samples
      },
      eta,
      resume: {
        bytesResentDeclared: entry.bytes.resent,
        resendEfficiency: resendEff
      },
      integrity: {
        checksumMismatches: entry.counters.checksumMismatches,
        chunksVerified: committedChunks,
        finalSha256: metadata.finalSha256 || (entry.finalize ? entry.finalize.sha256 : null)
      },
      finalize:
        entry.finalize ||
        (metadata.state === 'ready'
          ? {
              assemblyMs: 0,
              verifiedChunks: committedChunks,
              sha256: metadata.finalSha256,
              at: metadata.updatedAt
            }
          : null),
      finalizeFailures: [...entry.finalizeFailures],
      media: metadata.mediaId ? getMediaReport(metadata.mediaId) : null,
      recommendation,
      definitions: DEFINITIONS
    };
  }

  function getRecommendation() {
    sampleRss();
    const recent = recentThroughput(globalRecentRecords, 20);

    let totalAttempts = 0;
    let totalFailures = 0;
    for (const entry of uploads.values()) {
      totalAttempts += entry.counters.attempts;
      totalFailures += entry.counters.rejected + entry.counters.aborted;
    }

    const failurePermille =
      totalAttempts > 0 ? Math.floor((totalFailures * 1000) / totalAttempts) : 0;

    const rec = recommendChunkSize({
      recentBytesPerSecond: recent.bytesPerSecond,
      samples: recent.samples,
      failurePermille,
      minChunkBytes: config.minChunkBytes,
      maxChunkBytes: config.maxChunkBytes,
      defaultChunkBytes: config.defaultChunkBytes
    });

    return {
      recommendedChunkBytes: rec.recommendedChunkBytes,
      reason: rec.reason,
      inputs: rec.inputs,
      basis: 'last 20 committed chunks across uploads, server-observed',
      note: 'applies to new uploads only'
    };
  }

  function getServerStats() {
    const mem = sampleRss();
    return {
      uptimeSeconds: Math.floor(process.uptime()),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      peakRssBytes,
      trackedUploads: uploads.size
    };
  }

  function _setPersistenceFailure(fnOrBool) {
    testPersistenceFailureHook = fnOrBool;
  }

  return {
    nowMonotonicMs,
    recordChunkAttempt,
    recordFinalize,
    recordFinalizeFailure,
    recordMediaServed,
    getReport,
    getRecommendation,
    getServerStats,
    flush,
    flushAll,
    _setPersistenceFailure
  };
}

module.exports = {
  createMetricsStore
};
