const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeActiveIntervals,
  activeMs,
  bytesPerSecond,
  toMiBps,
  median,
  recentThroughput,
  estimateEta,
  recommendChunkSize,
  resendEfficiency
} = require('../src/services/metrics');

test('metrics-math: mergeActiveIntervals handles overlap, small gaps, and distinct gaps', () => {
  // Overlapping intervals
  const overlapping = [
    { startMs: 100, endMs: 500 },
    { startMs: 300, endMs: 800 }
  ];
  const mergedOverlap = mergeActiveIntervals(overlapping);
  assert.deepEqual(mergedOverlap, [{ startMs: 100, endMs: 800 }]);

  // Small gap (< 1000ms) merges as active continuous transfer
  const smallGap = [
    { startMs: 0, endMs: 500 },
    { startMs: 900, endMs: 1500 } // gap = 400ms <= 1000ms
  ];
  const mergedSmall = mergeActiveIntervals(smallGap, 1000);
  assert.deepEqual(mergedSmall, [{ startMs: 0, endMs: 1500 }]);

  // Gap >= 1000ms stays split
  const largeGap = [
    { startMs: 0, endMs: 500 },
    { startMs: 1600, endMs: 2500 } // gap = 1100ms > 1000ms
  ];
  const mergedLarge = mergeActiveIntervals(largeGap, 1000);
  assert.deepEqual(mergedLarge, [
    { startMs: 0, endMs: 500 },
    { startMs: 1600, endMs: 2500 }
  ]);

  // Empty and invalid input
  assert.deepEqual(mergeActiveIntervals([]), []);
  assert.deepEqual(mergeActiveIntervals(null), []);
});

test('metrics-math: activeMs for 4 parallel intervals counts time once', () => {
  // 4 transfers happening concurrently between t=100 and t=600
  const parallel = [
    { startMs: 100, endMs: 500 },
    { startMs: 150, endMs: 600 },
    { startMs: 120, endMs: 450 },
    { startMs: 200, endMs: 580 }
  ];
  const merged = mergeActiveIntervals(parallel);
  assert.deepEqual(merged, [{ startMs: 100, endMs: 600 }]);
  assert.equal(activeMs(merged), 500);
});

test('metrics-math: bytesPerSecond and toMiBps calculation (20 MiB in 4s = 5 MiB/s)', () => {
  const bytes = 20 * 1024 * 1024; // 20971520 bytes
  const ms = 4000;
  const bps = bytesPerSecond(bytes, ms);
  assert.equal(bps, 5242880);

  const mibps = toMiBps(bps);
  assert.equal(mibps, 5.0);

  // Edge cases
  assert.equal(bytesPerSecond(100, 0), 0);
  assert.equal(bytesPerSecond(0, 1000), 0);
  assert.equal(toMiBps(0), 0);
});

test('metrics-math: median for odd, even, and empty arrays', () => {
  assert.equal(median([]), 0);
  assert.equal(median([42]), 42);
  assert.equal(median([10, 50, 20]), 20); // odd: [10, 20, 50] -> 20
  assert.equal(median([10, 20, 30, 40]), 25); // even: floor((20+30)/2) = 25
  assert.equal(median([10, 20, 31, 40]), 25); // even: floor((20+31)/2) = floor(25.5) = 25
});

test('metrics-math: recentThroughput rolling window', () => {
  const records = [
    { bytes: 1000, startMs: 0, endMs: 100 },
    { bytes: 1000, startMs: 100, endMs: 200 },
    { bytes: 1000, startMs: 200, endMs: 300 },
    { bytes: 1000, startMs: 300, endMs: 400 },
    { bytes: 1000, startMs: 400, endMs: 500 }
  ];

  // Window size = 3 takes the last 3 records (bytes = 3000, ms = 300)
  const result = recentThroughput(records, 3);
  assert.equal(result.samples, 3);
  assert.equal(result.bytesPerSecond, 10000); // 3000 / 0.3s = 10000 bps

  // Empty records
  assert.deepEqual(recentThroughput([]), { bytesPerSecond: 0, samples: 0 });
});

test('metrics-math: estimateEta (remaining 0, < 3 samples unavailable, ceil rounding)', () => {
  // remaining 0 -> available: true, seconds: 0
  assert.deepEqual(
    estimateEta({ remainingBytes: 0, recentBytesPerSecond: 1000000, samples: 5 }),
    { available: true, seconds: 0 }
  );

  // samples < 3 -> unavailable
  assert.deepEqual(
    estimateEta({ remainingBytes: 5000000, recentBytesPerSecond: 1000000, samples: 2 }),
    { available: false, reason: 'insufficient_data' }
  );

  // recentBytesPerSecond <= 0 -> unavailable
  assert.deepEqual(
    estimateEta({ remainingBytes: 5000000, recentBytesPerSecond: 0, samples: 5 }),
    { available: false, reason: 'insufficient_data' }
  );

  // Ceil rounding: 1001 bytes at 1000 B/s -> ceil(1.001) = 2 seconds
  const res = estimateEta({ remainingBytes: 1001, recentBytesPerSecond: 1000, samples: 4 });
  assert.equal(res.available, true);
  assert.equal(res.seconds, 2);
  assert.deepEqual(res.basedOn, { samples: 4, recentBytesPerSecond: 1000 });
});

test('metrics-math: recommendChunkSize heuristics and bounds', () => {
  const minChunk = 64 * 1024; // 64 KiB
  const maxChunk = 16 * 1024 * 1024; // 16 MiB
  const defaultChunk = 1024 * 1024; // 1 MiB

  // 1. Insufficient samples (< 3) -> default
  const noData = recommendChunkSize({
    recentBytesPerSecond: 10000000,
    samples: 2,
    minChunkBytes: minChunk,
    maxChunkBytes: maxChunk,
    defaultChunkBytes: defaultChunk
  });
  assert.equal(noData.recommendedChunkBytes, defaultChunk);
  assert.equal(noData.reason, 'insufficient_data');

  // 2. High throughput -> clamped to max
  const fast = recommendChunkSize({
    recentBytesPerSecond: 50 * 1024 * 1024, // 50 MiB/s * 2s = 100 MiB -> clamps to 16 MiB
    samples: 5,
    minChunkBytes: minChunk,
    maxChunkBytes: maxChunk,
    defaultChunkBytes: defaultChunk
  });
  assert.equal(fast.recommendedChunkBytes, maxChunk);
  assert.equal(fast.reason, 'clamped_to_max');

  // 3. Very low throughput -> clamped to min
  const slow = recommendChunkSize({
    recentBytesPerSecond: 10 * 1024, // 10 KiB/s * 2s = 20 KiB -> pow=16 KiB -> clamps to 64 KiB
    samples: 5,
    minChunkBytes: minChunk,
    maxChunkBytes: maxChunk,
    defaultChunkBytes: defaultChunk
  });
  assert.equal(slow.recommendedChunkBytes, minChunk);
  assert.equal(slow.reason, 'clamped_to_min');

  // 4. Mid throughput -> power of two floor
  // 1.5 MiB/s * 2s = 3 MiB = 3145728 bytes. Highest pow2 <= 3145728 is 2097152 (2 MiB)
  const mid = recommendChunkSize({
    recentBytesPerSecond: 1572864, // 1.5 MiB/s
    samples: 5,
    minChunkBytes: minChunk,
    maxChunkBytes: maxChunk,
    defaultChunkBytes: defaultChunk
  });
  assert.equal(mid.recommendedChunkBytes, 2097152);
  assert.equal(mid.reason, 'throughput_based');

  // 5. High failure rate (> 10% / 100 permille) -> halves recommendation
  const highFailure = recommendChunkSize({
    recentBytesPerSecond: 1572864, // normal would be 2 MiB
    samples: 5,
    failurePermille: 150, // 15% failure rate
    minChunkBytes: minChunk,
    maxChunkBytes: maxChunk,
    defaultChunkBytes: defaultChunk
  });
  assert.equal(highFailure.recommendedChunkBytes, 1048576); // halved to 1 MiB
  assert.equal(highFailure.reason, 'high_failure_rate');
});

test('metrics-math: resendEfficiency rounding and calculation', () => {
  // 1 MiB resent out of 10 MiB expected = 0.1000
  assert.equal(resendEfficiency(1048576, 10485760), 0.1);

  // 500 bytes resent out of 2048 bytes expected = 500/2048 = 0.244140625 -> floor to 4 dec = 0.2441
  assert.equal(resendEfficiency(500, 2048), 0.2441);

  // 0 expected size -> 0
  assert.equal(resendEfficiency(100, 0), 0);
  assert.equal(resendEfficiency(0, 100), 0);
});
