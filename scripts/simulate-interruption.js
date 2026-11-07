#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

/**
 * Computes integer median of numbers array.
 */
function median(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) return 0;
  const sorted = [...numbers].filter((n) => typeof n === 'number' && !Number.isNaN(n)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Computes SHA-256 hex digest for an inclusive byte range [start, end] of a file using streams.
 * Bounded memory: chunks are never collected in a single buffer.
 *
 * NOTE: fs.createReadStream options { start, end } are INCLUSIVE byte positions.
 * This differs from browser Blob.prototype.slice(start, end) where end is exclusive.
 *
 * @param {string} filePath
 * @param {number} start - Inclusive start byte
 * @param {number} end - Inclusive end byte
 * @returns {Promise<string>} 64-char lowercase hex digest
 */
function computeSliceSha256(filePath, start, end) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Computes whole-file SHA-256 hex digest using streams with bounded memory.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Helper to execute JSON HTTP requests.
 */
function requestJson(urlStr, options = {}, bodyObj = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : null;

    const headers = {
      ...(bodyStr
        ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr)
          }
        : {}),
      ...options.headers
    };

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: options.method || (bodyObj ? 'POST' : 'GET'),
        headers
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({ statusCode: res.statusCode, headers: res.headers, json, raw });
        });
      }
    );

    req.on('error', reject);
    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

/**
 * Streams a single chunk to the server with retries on transient errors.
 * Never retries permanent 4xx errors.
 */
async function sendChunkWithRetry({
  baseUrl,
  uploadId,
  index,
  filePath,
  start,
  end,
  totalSize,
  sha256,
  maxRetries = 3,
  corruptChecksum = false,
  log = console.log
}) {
  const length = end - start + 1;
  let attempts = 0;
  let retriesUsed = 0;

  const effectiveSha = corruptChecksum ? '0'.repeat(64) : sha256;

  while (true) {
    try {
      const res = await new Promise((resolve, reject) => {
        const url = new URL(`${baseUrl}/api/uploads/${uploadId}/chunks/${index}`);
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port || 80,
            path: url.pathname,
            method: 'PUT',
            headers: {
              'Content-Range': `bytes ${start}-${end}/${totalSize}`,
              'X-Chunk-SHA256': effectiveSha,
              'Content-Length': length
            }
          },
          (response) => {
            const chunks = [];
            response.on('data', (c) => chunks.push(c));
            response.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf8');
              let json = null;
              try {
                json = JSON.parse(raw);
              } catch {}
              resolve({ statusCode: response.statusCode, headers: response.headers, json, raw });
            });
          }
        );

        req.on('error', reject);

        const fileStream = fs.createReadStream(filePath, { start, end });
        fileStream.on('error', (err) => {
          req.destroy(err);
          reject(err);
        });
        fileStream.pipe(req);
      });

      // 200 (duplicate) and 201 (committed) count as successful transfers
      if (res.statusCode === 200 || res.statusCode === 201) {
        return { res, retriesUsed };
      }

      // Permanent validation/client errors (400, 404, 409, 413, 422): NEVER retry
      if (
        res.statusCode >= 400 &&
        res.statusCode < 500 &&
        res.statusCode !== 408 &&
        res.statusCode !== 429
      ) {
        const err = new Error(
          `Permanent error ${res.statusCode}: ${res.json?.error?.message || res.raw}`
        );
        err.statusCode = res.statusCode;
        err.response = res;
        throw err;
      }

      // Transient server/network error
      throw new Error(`Transient server response ${res.statusCode}`);
    } catch (err) {
      if (
        err.statusCode &&
        err.statusCode >= 400 &&
        err.statusCode < 500 &&
        err.statusCode !== 408 &&
        err.statusCode !== 429
      ) {
        throw err;
      }

      attempts++;
      retriesUsed++;
      if (attempts > maxRetries) {
        throw err;
      }

      const backoffMs =
        Math.min(2000, 50 * Math.pow(2, attempts)) + Math.floor(Math.random() * 50);
      if (log) log(`Retry ${attempts}/${maxRetries} for chunk ${index} in ${backoffMs}ms...`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}

/**
 * Finalizes an upload session by streaming the whole file to compute its SHA-256
 * and submitting the finalize request to the server.
 *
 * @param {string} baseUrl
 * @param {string} uploadId
 * @param {string} filePath
 * @param {Function} [log]
 * @returns {Promise<object>}
 */
async function finalizeSession(baseUrl, uploadId, filePath, log = console.log) {
  if (log) log(`Computing whole-file SHA-256 for "${filePath}"...`);
  const wholeSha256 = await computeFileSha256(filePath);
  if (log) log(`Finalizing upload session "${uploadId}" (SHA-256: ${wholeSha256})...`);

  const res = await requestJson(
    `${baseUrl}/api/uploads/${uploadId}/finalize`,
    { method: 'POST' },
    { sha256: wholeSha256 }
  );

  if (res.statusCode === 200 && res.json) {
    if (log) {
      log('--- Finalize Succeeded ---');
      log(`Media ID:      ${res.json.mediaId}`);
      log(`Stored File:   ${res.json.downloadUrl}`);
      log(`Size:          ${res.json.size} bytes`);
      log(`SHA-256:       ${res.json.sha256}`);
      log(`Assembly Time: ${res.json.stats?.assemblyMs}ms`);
    }
    return res.json;
  }

  const errCode = res.json?.error?.code || 'ERROR';
  const errMsg = res.json?.error?.message || res.raw;
  const details = res.json?.error?.details;

  if (errCode === 'CHUNKS_DAMAGED') {
    const indices = details?.indices || [];
    if (log) {
      log(
        `Finalization failed: CHUNKS_DAMAGED. Missing or truncated chunks on disk: [${indices.join(
          ', '
        )}]. Please re-upload these chunks.`
      );
    }
  } else if (errCode === 'CHUNK_CORRUPT') {
    if (log) {
      log(
        `Finalization failed: CHUNK_CORRUPT. Chunk ${details?.index} failed integrity check. Please re-upload chunk ${details?.index}.`
      );
    }
  }

  const error = new Error(`Finalization failed (${res.statusCode} ${errCode}): ${errMsg}`);
  error.statusCode = res.statusCode;
  error.code = errCode;
  error.details = details;
  throw error;
}

/**
 * Uploads or resumes a file against the File Stream Service.
 * Always queries GET /api/uploads/:id first and transfers only missing chunks.
 *
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.filePath
 * @param {string} [options.filename]
 * @param {string} [options.contentType='application/octet-stream']
 * @param {number} [options.chunkSize=1048576]
 * @param {string} [options.uploadId]
 * @param {number} [options.stopAfter]
 * @param {number} [options.concurrency=1]
 * @param {number} [options.corruptChunkIndex]
 * @param {boolean} [options.finalize=false]
 * @param {number} [options.maxRetries=3]
 * @param {boolean} [options.corruptChecksumOnce=false]
 * @param {Function} [options.log]
 * @returns {Promise<object>}
 */
async function uploadFile({
  baseUrl = 'http://127.0.0.1:3000',
  filePath,
  filename,
  contentType = 'application/octet-stream',
  chunkSize = 1048576,
  uploadId: initialUploadId,
  stopAfter,
  concurrency = 1,
  corruptChunkIndex,
  finalize = false,
  maxRetries = 3,
  corruptChecksumOnce = false,
  log = console.log
}) {
  const resolvedPath = path.resolve(filePath);
  const stat = await fs.promises.stat(resolvedPath);
  const totalSize = stat.size;
  const effectiveName = filename || path.basename(resolvedPath);
  const poolSize = Math.max(1, Math.min(8, Number(concurrency) || 1));

  let uploadId = initialUploadId;

  // 1. Session initialization if uploadId is not provided
  if (!uploadId) {
    if (log) log(`Creating new upload session for "${effectiveName}" (${totalSize} bytes)...`);
    const createRes = await requestJson(`${baseUrl}/api/uploads`, { method: 'POST' }, {
      filename: effectiveName,
      size: totalSize,
      contentType,
      chunkSize
    });

    if (createRes.statusCode !== 201) {
      throw new Error(`Failed to create upload: ${createRes.statusCode} ${createRes.raw}`);
    }
    uploadId = createRes.json.uploadId;
    if (log) log(`Created upload session: ${uploadId}`);
  }

  // 2. Query server for authoritative transfer status (trust server, not local progress)
  const statusRes = await requestJson(`${baseUrl}/api/uploads/${uploadId}`);
  if (statusRes.statusCode !== 200) {
    throw new Error(`Failed to get upload status: ${statusRes.statusCode} ${statusRes.raw}`);
  }

  const serverStatus = statusRes.json;
  const serverChunkSize = serverStatus.chunkSize;
  const totalChunks = serverStatus.totalChunks;
  const missingIndices = serverStatus.missingChunks;
  const bytesAlreadyCommitted = serverStatus.committedBytes;

  if (log) {
    log(
      `Server status: ${serverStatus.committedChunks.length}/${totalChunks} chunks committed (${serverStatus.progressPercent}%). Missing: [${missingIndices.join(', ')}]`
    );
  }

  let chunksSentThisRun = 0;
  let chunksStarted = 0;
  let bytesSentThisRun = 0;
  let bytesResent = 0;
  let totalRetries = 0;
  let interrupted = false;
  let permanentError = null;
  let nextIndexToProcess = 0;
  const chunkStats = [];

  const runStartMs = Number(process.hrtime.bigint() / 1000000n);

  // 3. Send missing chunks using bounded worker pool of size `concurrency`
  async function worker() {
    while (true) {
      if (permanentError) return;
      if (stopAfter !== undefined && chunksStarted >= stopAfter) {
        interrupted = true;
        return;
      }
      if (nextIndexToProcess >= missingIndices.length) return;

      const idx = missingIndices[nextIndexToProcess++];
      chunksStarted++;

      const start = idx * serverChunkSize;
      const end = Math.min(start + serverChunkSize - 1, totalSize - 1);
      const chunkLength = end - start + 1;

      if (log) log(`Computing SHA-256 for chunk ${idx} (bytes ${start}-${end}/${totalSize})...`);
      const hashStart = Number(process.hrtime.bigint() / 1000000n);
      const sha = await computeSliceSha256(resolvedPath, start, end);
      const hashEnd = Number(process.hrtime.bigint() / 1000000n);
      const hashMs = Math.max(0, hashEnd - hashStart);

      const shouldCorrupt =
        idx === corruptChunkIndex || (corruptChecksumOnce && chunksStarted === 1);

      if (log) log(`Uploading chunk ${idx} [${chunkLength} bytes]...`);
      const sendStart = Number(process.hrtime.bigint() / 1000000n);

      try {
        const result = await sendChunkWithRetry({
          baseUrl,
          uploadId,
          index: idx,
          filePath: resolvedPath,
          start,
          end,
          totalSize,
          sha256: sha,
          maxRetries,
          corruptChecksum: shouldCorrupt,
          log
        });

        const sendEnd = Number(process.hrtime.bigint() / 1000000n);
        const sendMs = Math.max(0, sendEnd - sendStart);

        chunkStats.push({ index: idx, hashMs, sendMs, bytes: chunkLength });
        totalRetries += result.retriesUsed;
        chunksSentThisRun++;
        bytesSentThisRun += chunkLength;

        if (result.res.json && result.res.json.duplicate) {
          bytesResent += chunkLength;
          if (log) log(`Chunk ${idx} acknowledged as idempotent duplicate.`);
        } else {
          if (log) log(`Chunk ${idx} committed successfully.`);
        }
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

  const runEndMs = Number(process.hrtime.bigint() / 1000000n);
  const elapsedMs = Math.max(0, runEndMs - runStartMs);

  const clientObservedMiBps =
    elapsedMs <= 0
      ? 0
      : Math.floor(((bytesSentThisRun * 1000) / elapsedMs) * 100 / 1048576) / 100;

  const medianSendMs = median(chunkStats.map((c) => c.sendMs));
  const medianHashMs = median(chunkStats.map((c) => c.hashMs));

  const clientMetrics = {
    basis: 'client-observed',
    elapsedMs,
    bytesSentThisRun,
    clientObservedMiBps,
    medianSendMs,
    medianHashMs,
    concurrency: poolSize,
    retries: totalRetries
  };

  // 4. Fetch updated status from server
  let finalStatus = {};
  try {
    const finalStatusRes = await requestJson(`${baseUrl}/api/uploads/${uploadId}`);
    finalStatus = finalStatusRes.json || {};
  } catch {}

  const resendEfficiency =
    totalSize > 0 ? Math.floor((bytesResent * 10000) / totalSize) / 10000 : 0;

  const summary = {
    uploadId,
    totalChunks,
    chunksSentThisRun,
    bytesSentThisRun,
    bytesAlreadyCommitted,
    retries: totalRetries,
    resendEfficiency,
    progressPercent: finalStatus.progressPercent ?? 0,
    state: finalStatus.state ?? 'unknown',
    interrupted,
    clientMetrics
  };

  if (log) {
    log('--- Transfer Summary ---');
    log(`Upload ID:           ${summary.uploadId}`);
    log(`Chunks Sent This Run:${summary.chunksSentThisRun}`);
    log(`Bytes Sent This Run: ${summary.bytesSentThisRun}`);
    log(`Already Committed:   ${summary.bytesAlreadyCommitted}`);
    log(`Total Retries:       ${summary.retries}`);
    log(`Resend Efficiency:   ${summary.resendEfficiency}`);
    log(`Final Progress:      ${summary.progressPercent}%`);
    log(`Interrupted:         ${summary.interrupted}`);
    log('--- Client Metrics (client-observed) ---');
    log(`Elapsed Wall Time:   ${clientMetrics.elapsedMs}ms`);
    log(`Observed Throughput: ${clientMetrics.clientObservedMiBps} MiB/s (includes hashing)`);
    log(`Median Send Time:    ${clientMetrics.medianSendMs}ms`);
    log(`Median Hash Time:    ${clientMetrics.medianHashMs}ms`);
    log(`Concurrency:         ${clientMetrics.concurrency}`);
  }

  if (permanentError) {
    permanentError.summary = summary;
    throw permanentError;
  }

  // 5. Optional automatic finalization
  if (
    finalize &&
    !interrupted &&
    (finalStatus.missingChunks?.length === 0 || finalStatus.progressPercent === 100)
  ) {
    const media = await finalizeSession(baseUrl, uploadId, resolvedPath, log);
    summary.media = media;
    summary.mediaId = media.mediaId;
    summary.state = media.state || 'ready';
  }

  return summary;
}

// CLI argument parsing
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== 'upload' && command !== 'resume' && command !== 'finalize') {
    console.error('Usage:');
    console.error('  node scripts/simulate-interruption.js upload <file> [--base http://127.0.0.1:3000] [--chunk 1048576] [--stop-after N] [--concurrency N] [--corrupt-chunk I] [--content-type video/mp4] [--finalize]');
    console.error('  node scripts/simulate-interruption.js resume <file> --id <uploadId> [--base http://127.0.0.1:3000] [--concurrency N] [--finalize]');
    console.error('  node scripts/simulate-interruption.js finalize <file> --id <uploadId> [--base http://127.0.0.1:3000]');
    process.exit(1);
  }

  const filePath = args[1];
  if (!filePath) {
    console.error('Error: <file> path is required.');
    process.exit(1);
  }

  let baseUrl = 'http://127.0.0.1:3000';
  let chunkSize = 1048576;
  let stopAfter;
  let concurrency = 1;
  let corruptChunkIndex;
  let uploadId;
  let contentType = 'video/mp4';
  let finalize = false;

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--base' && args[i + 1]) {
      baseUrl = args[++i];
    } else if (args[i] === '--chunk' && args[i + 1]) {
      chunkSize = Number(args[++i]);
    } else if (args[i] === '--stop-after' && args[i + 1]) {
      stopAfter = Number(args[++i]);
    } else if (args[i] === '--concurrency' && args[i + 1]) {
      concurrency = Number(args[++i]);
    } else if (args[i] === '--corrupt-chunk' && args[i + 1]) {
      corruptChunkIndex = Number(args[++i]);
    } else if (args[i] === '--id' && args[i + 1]) {
      uploadId = args[++i];
    } else if (args[i] === '--content-type' && args[i + 1]) {
      contentType = args[++i];
    } else if (args[i] === '--finalize') {
      finalize = true;
    }
  }

  if ((command === 'resume' || command === 'finalize') && !uploadId) {
    console.error('Error: --id <uploadId> is required when resuming or finalizing.');
    process.exit(1);
  }

  try {
    if (command === 'finalize') {
      await finalizeSession(baseUrl, uploadId, path.resolve(filePath), console.log);
    } else {
      await uploadFile({
        baseUrl,
        filePath,
        contentType,
        chunkSize,
        uploadId,
        stopAfter,
        concurrency,
        corruptChunkIndex,
        finalize,
        log: console.log
      });
    }
  } catch (err) {
    console.error('Operation failed:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  uploadFile,
  finalizeSession,
  computeSliceSha256,
  computeFileSha256
};
