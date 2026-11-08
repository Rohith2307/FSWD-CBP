const { expectedRange } = require('../utils/validation');

/**
 * Merges an array of inclusive byte ranges [{start, end}] into sorted, contiguous ranges.
 * Overlapping and directly adjacent ranges (where next.start === prev.end + 1) are merged.
 *
 * @param {Array<{ start: number, end: number }>} ranges
 * @returns {Array<{ start: number, end: number }>}
 */
function mergeRanges(ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    return [];
  }

  // Clone and sort by start ascending, then end ascending
  const sorted = ranges
    .map((r) => ({ start: Number(r.start), end: Number(r.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [{ start: sorted[0].start, end: sorted[0].end }];

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const current = sorted[i];

    // Merge if overlapping or directly adjacent
    if (current.start <= prev.end + 1) {
      prev.end = Math.max(prev.end, current.end);
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }

  return merged;
}

/**
 * Returns merged contiguous byte ranges from committed chunk records.
 *
 * @param {Array<{ start: number, end: number }>} chunks
 * @returns {Array<{ start: number, end: number }>}
 */
function committedRanges(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return [];
  }
  const rawRanges = chunks.map((c) => ({ start: c.start, end: c.end }));
  return mergeRanges(rawRanges);
}

/**
 * Returns sorted array of zero-based chunk indices that are not yet committed.
 *
 * @param {number} totalChunks
 * @param {Array<{ index: number }>} chunks
 * @returns {number[]}
 */
function missingChunkIndices(totalChunks, chunks) {
  const committedSet = new Set((chunks || []).map((c) => c.index));
  const missing = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!committedSet.has(i)) {
      missing.push(i);
    }
  }
  return missing;
}

/**
 * Returns merged contiguous byte ranges of all missing chunks,
 * calculating accurate bounds for intermediate chunks and the final partial chunk.
 *
 * @param {number} totalChunks
 * @param {number} size - Total file size
 * @param {number} chunkSize - Nominal chunk size
 * @param {Array<{ index: number }>} chunks
 * @returns {Array<{ start: number, end: number }>}
 */
function missingRanges(totalChunks, size, chunkSize, chunks) {
  const missingIndices = missingChunkIndices(totalChunks, chunks);
  if (missingIndices.length === 0) {
    return [];
  }

  const rawRanges = missingIndices.map((idx) => {
    const range = expectedRange(idx, size, chunkSize);
    return { start: range.start, end: range.end };
  });

  return mergeRanges(rawRanges);
}

/**
 * Computes the total byte count of uniquely committed chunks.
 * Duplicates are counted only once to protect against ledger corruption.
 *
 * @param {Array<{ index: number, size: number }>} chunks
 * @returns {number}
 */
function committedBytes(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return 0;
  }
  const seenIndices = new Set();
  let total = 0;
  for (const c of chunks) {
    if (!seenIndices.has(c.index)) {
      seenIndices.add(c.index);
      total += Number(c.size) || 0;
    }
  }
  return total;
}

/**
 * Computes progress percentage using integer math only.
 * Returns a number rounded down to 2 decimal places (e.g. 33.33).
 * Never exceeds 100.
 *
 * @param {number} committed
 * @param {number} total
 * @returns {number}
 */
function progressPercent(committed, total) {
  if (total <= 0 || committed <= 0) {
    return 0;
  }
  const pct = Math.floor((committed * 10000) / total) / 100;
  return Math.min(100, Math.max(0, pct));
}

/**
 * Validates that an upload session ledger is complete, non-overlapping, and mathematically consistent.
 *
 * Checks:
 * 1. Every index 0..totalChunks-1 is present exactly once (no missing, no duplicates).
 * 2. Each chunk's start/end/size matches expectedRange(index, expectedSize, chunkSize).
 * 3. Chunks do not overlap.
 * 4. Total chunk sizes sum exactly to expectedSize.
 *
 * @param {object} metadata
 * @returns {{ ok: boolean, problems: string[], missingChunks: number[] }}
 */
function validateLedger(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return { ok: false, problems: ['Missing or invalid upload metadata'], missingChunks: [] };
  }

  const totalChunks = Number(metadata.totalChunks);
  const expectedSize = Number(metadata.expectedSize);
  const chunkSize = Number(metadata.chunkSize);
  const chunks = Array.isArray(metadata.chunks) ? metadata.chunks : [];

  const problems = [];
  const seenIndices = new Map();

  // 1. Detect duplicates and check index bounds
  for (const chunk of chunks) {
    if (
      typeof chunk.index !== 'number' ||
      !Number.isSafeInteger(chunk.index) ||
      chunk.index < 0 ||
      chunk.index >= totalChunks
    ) {
      problems.push(`Invalid chunk index ${chunk.index}: must be within [0, ${totalChunks - 1}]`);
    } else if (seenIndices.has(chunk.index)) {
      problems.push(`Duplicate chunk index ${chunk.index}`);
    } else {
      seenIndices.set(chunk.index, chunk);
    }
  }

  // 2. Identify missing chunk indices
  const missingChunks = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!seenIndices.has(i)) {
      missingChunks.push(i);
    }
  }

  // 3. Check each chunk's range bounds against expectedRange
  for (const chunk of chunks) {
    if (typeof chunk.index === 'number' && chunk.index >= 0 && chunk.index < totalChunks) {
      try {
        const expected = expectedRange(chunk.index, expectedSize, chunkSize);
        if (
          chunk.start !== expected.start ||
          chunk.end !== expected.end ||
          chunk.size !== expected.length
        ) {
          problems.push(
            `Chunk ${chunk.index} range mismatch: expected ${expected.start}-${expected.end} (${expected.length} bytes), got ${chunk.start}-${chunk.end} (${chunk.size} bytes)`
          );
        }
      } catch (err) {
        problems.push(`Chunk ${chunk.index} range calculation error: ${err.message}`);
      }
    }
  }

  // 4. Check for overlapping byte ranges
  const sorted = chunks
    .filter((c) => typeof c.start === 'number' && typeof c.end === 'number')
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (curr.start <= prev.end) {
      problems.push(
        `Overlapping chunks detected: chunk ${prev.index} [${prev.start}-${prev.end}] overlaps with chunk ${curr.index} [${curr.start}-${curr.end}]`
      );
    }
  }

  // 5. Check total byte sum equals expected file size
  let sumBytes = 0;
  for (const chunk of chunks) {
    sumBytes += Number(chunk.size) || 0;
  }
  if (sumBytes !== expectedSize) {
    problems.push(
      `Chunk sizes sum (${sumBytes}) does not equal expected file size (${expectedSize})`
    );
  }

  const ok = problems.length === 0 && missingChunks.length === 0;

  return {
    ok,
    problems,
    missingChunks
  };
}

module.exports = {
  mergeRanges,
  committedRanges,
  missingChunkIndices,
  missingRanges,
  committedBytes,
  progressPercent,
  validateLedger
};
