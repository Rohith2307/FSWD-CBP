(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const chunkMath = require('./chunkMath');
    module.exports = factory(chunkMath);
  } else {
    root.FSS = root.FSS || {};
    root.FSS.uploader = factory(root.FSS.chunkMath);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (chunkMath) {
  'use strict';

  /**
   * Browser & Node Resumable Uploader Client
   *
   * Architectural & Protocol Design Principles:
   *
   * 1. Why the browser skips the whole-file hash:
   *    Web Cryptography's `crypto.subtle.digest('SHA-256', buffer)` requires buffering the ENTIRE
   *    dataset into a contiguous `ArrayBuffer` in memory. Browser SubtleCrypto has no incremental or
   *    streaming digest API. For multi-gigabyte video files, loading the entire file into an ArrayBuffer
   *    would crash the browser tab with an Out-Of-Memory (OOM) error.
   *    Instead, the client independently computes SHA-256 for each small chunk (bounded to chunk buffer size),
   *    and the server streams and verifies the assembled file on disk during finalization.
   *
   * 2. Why UI progress counts only server-committed bytes:
   *    In-flight chunk bytes sent across the socket have not been verified by the server ledger or durably
   *    written to disk. Counting in-flight bytes creates a false sense of completion; if the connection drops,
   *    all uncommitted bytes are discarded. Progress strictly tracks authoritative `committedBytes`.
   *
   * 3. Memory Boundedness:
   *    At most `concurrency` chunk ArrayBuffers are held in memory simultaneously. Slices are read and
   *    hashed on-demand immediately before their PUT request is issued.
   */

  function defaultNow() {
    return Date.now();
  }

  function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function median(numbers) {
    if (!Array.isArray(numbers) || numbers.length === 0) return 0;
    const sorted = [...numbers].filter((n) => typeof n === 'number' && !Number.isNaN(n)).sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid];
    return Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
  }

  async function digestSha256Hex(arrayBuffer, subtle = globalThis.crypto?.subtle) {
    if (!subtle || typeof subtle.digest !== 'function') {
      throw new Error('Web Cryptography SubtleCrypto is required for SHA-256 hashing');
    }
    const digestBuf = await subtle.digest('SHA-256', arrayBuffer);
    const bytes = new Uint8Array(digestBuf);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  /**
   * Creates an uploader instance.
   *
   * @param {object} [options]
   * @param {string} [options.baseUrl=""]
   * @param {typeof fetch} [options.fetch=globalThis.fetch]
   * @param {Function} [options.now]
   * @param {Function} [options.sleep]
   * @returns {{ upload: Function, interrupt: Function }}
   */
  function createUploader({
    baseUrl = '',
    fetch = globalThis.fetch,
    now = defaultNow,
    sleep = defaultSleep,
    onBufferAlloc: defaultOnBufferAlloc,
    onBufferRelease: defaultOnBufferRelease,
    onBufferFree: defaultOnBufferFree
  } = {}) {
    let isInterrupted = false;
    const activeControllers = new Set();

    function interrupt() {
      isInterrupted = true;
      for (const ctrl of activeControllers) {
        try {
          ctrl.abort();
        } catch {}
      }
      activeControllers.clear();
    }

    async function upload(
      blob,
      {
        name,
        contentType = 'application/octet-stream',
        chunkSize = 1048576,
        concurrency = 1,
        uploadId: explicitUploadId,
        stopAfter,
        corruptIndex,
        finalize = false,
        maxRetries = 4,
        onEvent = () => {},
        onBufferAlloc = defaultOnBufferAlloc,
        onBufferRelease = defaultOnBufferRelease || defaultOnBufferFree,
        onBufferFree
      } = {}
    ) {
      const bufferFreeHook = onBufferRelease || onBufferFree || defaultOnBufferFree;
      if (!blob || typeof blob.size !== 'number') {
        throw new Error('upload requires a valid Blob or File');
      }

      isInterrupted = false;
      activeControllers.clear();

      const totalSize = blob.size;
      const fileName = name || blob.name || 'unnamed.bin';
      const poolSize = Math.max(1, Math.min(4, Number(concurrency) || 1));

      let uploadId = explicitUploadId;

      // 1. Session initialization if uploadId was not provided
      if (!uploadId) {
        const createRes = await fetch(`${baseUrl}/api/uploads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: fileName,
            size: totalSize,
            contentType,
            chunkSize
          })
        });

        if (!createRes.ok) {
          const raw = await createRes.text();
          throw new Error(`Failed to create upload session: ${createRes.status} ${raw}`);
        }

        const createJson = await createRes.json();
        uploadId = createJson.uploadId;
      }

      // 2. Query server for authoritative transfer status
      const statusRes = await fetch(`${baseUrl}/api/uploads/${uploadId}`, { method: 'GET' });
      if (statusRes.status === 404) {
        onEvent({ type: 'session_gone', uploadId });
        const err = new Error(`Upload session "${uploadId}" not found on server (session_gone)`);
        err.code = 'SESSION_GONE';
        err.reason = 'session_gone';
        err.sessionGone = true;
        throw err;
      }

      if (!statusRes.ok) {
        const raw = await statusRes.text();
        throw new Error(`Failed to query upload status: ${statusRes.status} ${raw}`);
      }

      const serverStatus = await statusRes.json();
      onEvent({ type: 'status', status: serverStatus });

      const serverChunkSize = serverStatus.chunkSize;
      const totalChunks = serverStatus.totalChunks;
      const missingIndices = [...serverStatus.missingChunks];
      const bytesAlreadyCommitted = serverStatus.committedBytes;

      let chunksSentThisRun = 0;
      let chunksStarted = 0;
      let bytesSentThisRun = 0;
      let bytesResent = 0;
      let totalRetries = 0;
      let permanentError = null;
      let nextMissingIdx = 0;
      const chunkStats = [];

      const runStartMs = now();

      // Helper to execute a single chunk upload attempt
      async function sendChunkAttempt(idx) {
        const r = chunkMath.chunkRange(idx, totalSize, serverChunkSize);
        const contentRange = `bytes ${r.start}-${r.end}/${totalSize}`;

        let attempt = 0;
        while (true) {
          if (isInterrupted) return;

          // Memory bound: read chunk slice and hash immediately before upload
          if (typeof onBufferAlloc === 'function') {
            try {
              onBufferAlloc(idx);
            } catch {}
          }
          onEvent({ type: 'buffer-alloc', index: idx });

          let bufferReleased = false;
          const releaseBuffer = () => {
            if (!bufferReleased) {
              bufferReleased = true;
              if (typeof bufferFreeHook === 'function') {
                try {
                  bufferFreeHook(idx);
                } catch {}
              }
              onEvent({ type: 'buffer-release', index: idx });
            }
          };

          try {
            const slice = blob.slice(r.start, r.sliceEnd);
            const hashStart = now();
            const arrayBuffer = await slice.arrayBuffer();
            let sha256 = await digestSha256Hex(arrayBuffer);
            const hashMs = Math.max(0, now() - hashStart);

            // One-shot corruption injection
            if (corruptIndex !== undefined && idx === corruptIndex && attempt === 0) {
              sha256 = '0'.repeat(64);
            }

            const ctrl = new AbortController();
            activeControllers.add(ctrl);

            const sendStart = now();
            onEvent({ type: 'chunk-start', index: idx, bytes: r.length });

            try {
              const putRes = await fetch(`${baseUrl}/api/uploads/${uploadId}/chunks/${idx}`, {
                method: 'PUT',
                headers: {
                  'Content-Range': contentRange,
                  'X-Chunk-SHA256': sha256,
                  'Content-Type': 'application/octet-stream'
                },
                body: slice,
                signal: ctrl.signal
              });

              activeControllers.delete(ctrl);
              const sendMs = Math.max(0, now() - sendStart);

              if (putRes.ok) {
                const resJson = await putRes.json().catch(() => ({}));
                const outcome = resJson.duplicate ? 'duplicate' : resJson.repaired ? 'repaired' : 'committed';
                if (resJson.duplicate) {
                  bytesResent += r.length;
                }

                chunkStats.push({ index: idx, hashMs, sendMs, bytes: r.length });
                chunksSentThisRun++;
                bytesSentThisRun += r.length;

                onEvent({
                  type: 'chunk-done',
                  index: idx,
                  outcome,
                  attempt,
                  ms: sendMs,
                  bytes: r.length
                });
                return;
              }

              // HTTP error response
              const resJson = await putRes.json().catch(() => null);
              const errCode = resJson?.error?.code || 'ERROR';
              const errMsg = resJson?.error?.message || `HTTP ${putRes.status}`;

              // Do not retry 4xx errors (except 408 Request Timeout and 429 Too Many Requests)
              if (putRes.status >= 400 && putRes.status < 500 && putRes.status !== 408 && putRes.status !== 429) {
                const permanent = new Error(`Permanent error ${putRes.status}: ${errMsg}`);
                permanent.statusCode = putRes.status;
                permanent.code = errCode;
                onEvent({
                  type: 'chunk-failed',
                  index: idx,
                  status: putRes.status,
                  code: errCode,
                  message: errMsg
                });
                throw permanent;
              }

              // Retryable error
              attempt++;
              totalRetries++;
              if (attempt > maxRetries) {
                const retriesExhausted = new Error(`Retries exhausted for chunk ${idx}: ${errMsg}`);
                retriesExhausted.statusCode = putRes.status;
                retriesExhausted.code = errCode;
                throw retriesExhausted;
              }

              const delayMs = Math.min(2000, 50 * Math.pow(2, attempt)) + Math.floor(Math.random() * 50);
              onEvent({ type: 'chunk-retry', index: idx, attempt, reason: errMsg, delayMs });
              await sleep(delayMs);
            } catch (err) {
              activeControllers.delete(ctrl);

              if (isInterrupted || err.name === 'AbortError') {
                return;
              }

              // If permanent error, bubble immediately
              if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 408 && err.statusCode !== 429) {
                throw err;
              }

              // Network failure retry
              attempt++;
              totalRetries++;
              if (attempt > maxRetries) {
                throw err;
              }

              const delayMs = Math.min(2000, 50 * Math.pow(2, attempt)) + Math.floor(Math.random() * 50);
              onEvent({ type: 'chunk-retry', index: idx, attempt, reason: err.message, delayMs });
              await sleep(delayMs);
            }
          } finally {
            releaseBuffer();
          }
        }
      }

      // Worker pool
      async function worker() {
        while (true) {
          if (isInterrupted || permanentError) return;
          if (stopAfter !== undefined && chunksStarted >= stopAfter) {
            isInterrupted = true;
            return;
          }
          if (nextMissingIdx >= missingIndices.length) return;

          const idx = missingIndices[nextMissingIdx++];
          chunksStarted++;

          try {
            await sendChunkAttempt(idx);
          } catch (err) {
            if (!permanentError) {
              permanentError = err;
            }
            return;
          }
        }
      }

      const workers = [];
      for (let w = 0; w < poolSize; w++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      const runEndMs = now();
      const elapsedMs = Math.max(0, runEndMs - runStartMs);

      const clientObservedMiBps =
        elapsedMs <= 0
          ? 0
          : Math.floor(((bytesSentThisRun * 1000) / elapsedMs) * 100 / 1048576) / 100;

      const clientMetrics = {
        basis: 'client-observed',
        elapsedMs,
        bytesSentThisRun,
        clientObservedBytesPerSecond: elapsedMs > 0 ? Math.floor((bytesSentThisRun * 1000) / elapsedMs) : 0,
        clientObservedMiBps,
        medianSendMs: median(chunkStats.map((c) => c.sendMs)),
        medianHashMs: median(chunkStats.map((c) => c.hashMs)),
        concurrency: poolSize,
        retries: totalRetries
      };

      const resendEfficiency = totalSize > 0 ? Number((bytesResent / totalSize).toFixed(4)) : 0;

      const summary = {
        uploadId,
        totalChunks,
        chunksSentThisRun,
        bytesSentThisRun,
        bytesAlreadyCommitted,
        bytesResent,
        resendEfficiency,
        retries: totalRetries,
        interrupted: isInterrupted,
        clientMetrics
      };

      if (isInterrupted) {
        onEvent({ type: 'interrupted' });
      }

      if (permanentError) {
        permanentError.summary = summary;
        throw permanentError;
      }

      // Finalize if requested and not interrupted
      if (finalize && !isInterrupted) {
        // SubtleCrypto lacks streaming whole-file hashing, so browser submits finalize with NO body.
        // Server computes whole-file SHA-256 during assembly and returns it in response.
        const finRes = await fetch(`${baseUrl}/api/uploads/${uploadId}/finalize`, {
          method: 'POST'
        });

        if (finRes.ok) {
          const media = await finRes.json();
          summary.media = media;
          onEvent({ type: 'finalized', media });
        } else {
          const finErr = await finRes.json().catch(() => ({}));
          onEvent({
            type: 'finalize-failed',
            code: finErr?.error?.code || 'FINALIZE_ERROR',
            details: finErr?.error?.details
          });
          const err = new Error(`Finalize failed: ${finRes.status} ${finErr?.error?.message || ''}`);
          err.statusCode = finRes.status;
          err.code = finErr?.error?.code;
          err.summary = summary;
          throw err;
        }
      }

      return summary;
    }

    return {
      upload,
      interrupt
    };
  }

  return {
    createUploader,
    digestSha256Hex,
    median
  };
});
