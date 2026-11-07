/**
 * Pure Mathematical Metrics & Timing Helpers
 *
 * Design and Architectural Principles:
 *
 * 1. Why activeMs merges overlapping and near intervals:
 *    Parallel chunk transfers overlap in time, so simply summing individual chunk durations
 *    would artificially inflate active transfer time and distort throughput calculations.
 *    Furthermore, small client gaps (< 1000ms) representing hashing, disk read, or network
 *    think time are part of continuous active transfer, whereas longer idle gaps (e.g., user
 *    pauses, client offline, network interruptions) are excluded so idle time does not depress
 *    measured transfer throughput.
 *
 * 2. Why throughput is labeled "server-observed" vs "client-observed":
 *    The server measures transfer rates strictly from chunk HTTP receive start to commit completion.
 *    The client measures wall-clock transfer rates including local hashing, process scheduling,
 *    and HTTP handshake latency. Separating these into "server-observed" and "client-observed"
 *    guarantees unambiguous metrics without blending different measurement frames into a single figure.
 *
 * 3. Pure math & integer arithmetic:
 *    All calculations use integer milliseconds and integer byte counts. Fractional rates are
 *    floored explicitly to prevent floating-point drift.
 */

/**
 * Returns the current high-resolution monotonic time in integer milliseconds.
 *
 * @returns {number}
 */
function nowMonotonicMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

/**
 * Merges overlapping or near-adjacent active time intervals using a configurable gap tolerance.
 * Pure function: does no I/O.
 *
 * @param {Array<{ startMs: number, endMs: number }>} intervals
 * @param {number} [gapToleranceMs=1000]
 * @returns {Array<{ startMs: number, endMs: number }>}
 */
function mergeActiveIntervals(intervals, gapToleranceMs = 1000) {
  if (!Array.isArray(intervals) || intervals.length === 0) {
    return [];
  }

  const valid = intervals.filter(
    (iv) =>
      iv &&
      typeof iv.startMs === 'number' &&
      typeof iv.endMs === 'number' &&
      !Number.isNaN(iv.startMs) &&
      !Number.isNaN(iv.endMs) &&
      iv.endMs >= iv.startMs
  );

  if (valid.length === 0) {
    return [];
  }

  const sorted = [...valid].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged = [{ startMs: sorted[0].startMs, endMs: sorted[0].endMs }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const prev = merged[merged.length - 1];

    if (current.startMs <= prev.endMs + gapToleranceMs) {
      prev.endMs = Math.max(prev.endMs, current.endMs);
    } else {
      merged.push({ startMs: current.startMs, endMs: current.endMs });
    }
  }

  return merged;
}

/**
 * Calculates total active milliseconds from an array of intervals (merged or unmerged).
 *
 * @param {Array<{ startMs: number, endMs: number }>} intervals
 * @returns {number}
 */
function activeMs(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) {
    return 0;
  }
  return intervals.reduce((acc, iv) => acc + Math.max(0, iv.endMs - iv.startMs), 0);
}

/**
 * Computes bytes per second using integer division.
 *
 * @param {number} bytes
 * @param {number} ms
 * @returns {number}
 */
function bytesPerSecond(bytes, ms) {
  if (ms <= 0 || bytes <= 0) {
    return 0;
  }
  return Math.floor((bytes * 1000) / ms);
}

/**
 * Converts bytes per second to MiB/s, floored to 2 decimal places.
 *
 * @param {number} bps
 * @returns {number}
 */
function toMiBps(bps) {
  if (bps <= 0) {
    return 0;
  }
  return Math.floor((bps * 100) / 1048576) / 100;
}

/**
 * Computes the integer median of an array of numbers.
 * For even length, returns the floor of the mean of the two middle values.
 * Returns 0 for an empty array.
 *
 * @param {number[]} numbers
 * @returns {number}
 */
function median(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return 0;
  }

  const sorted = [...numbers]
    .filter((n) => typeof n === 'number' && !Number.isNaN(n))
    .sort((a, b) => a - b);

  if (sorted.length === 0) {
    return 0;
  }

  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Computes recent throughput across the last windowSize committed chunk records.
 *
 * @param {Array<{ bytes: number, startMs: number, endMs: number }>} records
 * @param {number} [windowSize=8]
 * @returns {{ bytesPerSecond: number, samples: number }}
 */
function recentThroughput(records, windowSize = 8) {
  if (!Array.isArray(records) || records.length === 0 || windowSize <= 0) {
    return { bytesPerSecond: 0, samples: 0 };
  }

  const slice = records.slice(-windowSize);
  const totalBytes = slice.reduce((acc, r) => acc + (r.bytes || 0), 0);
  const intervals = slice.map((r) => ({ startMs: r.startMs, endMs: r.endMs }));
  const merged = mergeActiveIntervals(intervals);
  const durationMs = activeMs(merged);
  const bps = bytesPerSecond(totalBytes, durationMs);

  return {
    bytesPerSecond: bps,
    samples: slice.length
  };
}

/**
 * Estimates remaining transfer time in seconds based on recent throughput.
 * Returns { available: boolean, seconds?: number, basedOn?: object, reason?: string }.
 *
 * @param {object} options
 * @param {number} options.remainingBytes
 * @param {number} options.recentBytesPerSecond
 * @param {number} options.samples
 * @param {number} [options.minSamples=3]
 * @returns {object}
 */
function estimateEta({ remainingBytes, recentBytesPerSecond, samples, minSamples = 3 }) {
  if (remainingBytes === 0) {
    return { available: true, seconds: 0 };
  }

  if (samples < minSamples || recentBytesPerSecond <= 0) {
    return { available: false, reason: 'insufficient_data' };
  }

  const seconds = Math.ceil(remainingBytes / recentBytesPerSecond);
  return {
    available: true,
    seconds,
    basedOn: {
      samples,
      recentBytesPerSecond
    }
  };
}

/**
 * Floors a positive integer to the greatest power of two less than or equal to n.
 *
 * @param {number} n
 * @returns {number}
 */
function floorPowerOfTwo(n) {
  if (n < 1) return 1;
  let p = 1;
  while (p * 2 <= n) {
    p *= 2;
  }
  return p;
}

/**
 * Recommends an optimal chunk size based on observed throughput and failure rate.
 * Note: this is a heuristic informing new uploads; an active session's chunk size never changes.
 *
 * @param {object} options
 * @param {number} options.recentBytesPerSecond
 * @param {number} options.samples
 * @param {number} [options.failurePermille=0] - Failures per 1000 attempts (e.g. 100 = 10%)
 * @param {number} options.minChunkBytes
 * @param {number} options.maxChunkBytes
 * @param {number} options.defaultChunkBytes
 * @param {number} [options.targetChunkMs=2000] - Target transfer duration per chunk
 * @returns {object}
 */
function recommendChunkSize({
  recentBytesPerSecond,
  samples,
  failurePermille = 0,
  minChunkBytes,
  maxChunkBytes,
  defaultChunkBytes,
  targetChunkMs = 2000
}) {
  const inputs = {
    recentBytesPerSecond,
    samples,
    failurePermille,
    targetChunkMs,
    minChunkBytes,
    maxChunkBytes
  };

  if (samples < 3 || recentBytesPerSecond <= 0) {
    return {
      recommendedChunkBytes: defaultChunkBytes,
      reason: 'insufficient_data',
      inputs
    };
  }

  const rawBytes = Math.floor((recentBytesPerSecond * targetChunkMs) / 1000);
  const pow = floorPowerOfTwo(rawBytes);

  let rec = pow;
  let reason = 'throughput_based';

  if (rec < minChunkBytes) {
    rec = minChunkBytes;
    reason = 'clamped_to_min';
  } else if (rec > maxChunkBytes) {
    rec = maxChunkBytes;
    reason = 'clamped_to_max';
  }

  // If failure rate > 10% (100 permille), halve the recommendation clamped to minChunkBytes
  if (failurePermille > 100) {
    rec = Math.max(minChunkBytes, Math.floor(rec / 2));
    reason = 'high_failure_rate';
  }

  return {
    recommendedChunkBytes: rec,
    reason,
    inputs
  };
}

/**
 * Calculates resend efficiency ratio floored to 4 decimal places.
 * Ratio of resent chunk bytes (duplicates + repairs) to expected file size.
 *
 * @param {number} bytesResent
 * @param {number} expectedSize
 * @returns {number}
 */
function resendEfficiency(bytesResent, expectedSize) {
  if (expectedSize <= 0 || bytesResent <= 0) {
    return 0;
  }
  return Math.floor((bytesResent * 10000) / expectedSize) / 10000;
}

module.exports = {
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
};
