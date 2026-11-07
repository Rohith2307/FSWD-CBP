const test = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../src/services/ledger');

test('ledger - mergeRanges logic', () => {
  // Empty
  assert.deepEqual(ledger.mergeRanges([]), []);

  // Adjacent ranges merge: [0, 99] and [100, 199] -> [0, 199]
  assert.deepEqual(
    ledger.mergeRanges([
      { start: 0, end: 99 },
      { start: 100, end: 199 }
    ]),
    [{ start: 0, end: 199 }]
  );

  // Overlapping ranges merge: [0, 150] and [100, 200] -> [0, 200]
  assert.deepEqual(
    ledger.mergeRanges([
      { start: 0, end: 150 },
      { start: 100, end: 200 }
    ]),
    [{ start: 0, end: 200 }]
  );

  // Gaps remain separate: [0, 99] and [200, 299]
  assert.deepEqual(
    ledger.mergeRanges([
      { start: 0, end: 99 },
      { start: 200, end: 299 }
    ]),
    [
      { start: 0, end: 99 },
      { start: 200, end: 299 }
    ]
  );

  // Unsorted input merges into sorted order
  assert.deepEqual(
    ledger.mergeRanges([
      { start: 200, end: 299 },
      { start: 0, end: 99 },
      { start: 100, end: 199 }
    ]),
    [{ start: 0, end: 299 }]
  );
});

test('ledger - committedRanges from chunk records', () => {
  const chunks = [
    { index: 2, start: 200, end: 299 },
    { index: 0, start: 0, end: 99 },
    { index: 1, start: 100, end: 199 }
  ];
  assert.deepEqual(ledger.committedRanges(chunks), [{ start: 0, end: 299 }]);
});

test('ledger - missingChunkIndices', () => {
  const chunks = [{ index: 0 }, { index: 1 }, { index: 4 }];
  assert.deepEqual(ledger.missingChunkIndices(5, chunks), [2, 3]);
  assert.deepEqual(ledger.missingChunkIndices(3, []), [0, 1, 2]);
  assert.deepEqual(ledger.missingChunkIndices(2, [{ index: 0 }, { index: 1 }]), []);
});

test('ledger - missingRanges with partial chunk math', () => {
  // 7.5 MiB file with 1 MiB chunks -> 8 chunks total.
  // 7 * 1048576 = 7340032. Last chunk 7: 7340032..7864319 (524288 bytes)
  const totalSize = 7864320;
  const chunkSize = 1048576;
  const totalChunks = 8;

  // If chunk 7 is missing:
  const chunksWithoutLast = Array.from({ length: 7 }, (_, i) => ({
    index: i,
    start: i * chunkSize,
    end: (i + 1) * chunkSize - 1
  }));

  const missing = ledger.missingRanges(totalChunks, totalSize, chunkSize, chunksWithoutLast);
  assert.deepEqual(missing, [{ start: 7340032, end: 7864319 }]);

  // If chunks 2 and 3 are missing:
  const chunksWithGap = [
    { index: 0, start: 0, end: chunkSize - 1 },
    { index: 1, start: chunkSize, end: 2 * chunkSize - 1 },
    { index: 4, start: 4 * chunkSize, end: 5 * chunkSize - 1 }
  ];
  const missingGaps = ledger.missingRanges(5, 5 * chunkSize, chunkSize, chunksWithGap);
  assert.deepEqual(missingGaps, [{ start: 2 * chunkSize, end: 4 * chunkSize - 1 }]);
});

test('ledger - committedBytes ignores duplicates', () => {
  const chunks = [
    { index: 0, size: 1000 },
    { index: 1, size: 2000 },
    { index: 0, size: 1000 } // Duplicate
  ];
  assert.equal(ledger.committedBytes(chunks), 3000);
});

test('ledger - progressPercent calculation', () => {
  assert.equal(ledger.progressPercent(0, 1000), 0);
  assert.equal(ledger.progressPercent(500, 1000), 50);
  assert.equal(ledger.progressPercent(1000, 1000), 100);
  assert.equal(ledger.progressPercent(1500, 1000), 100); // Capped at 100
  // Rounding down: 1/3 -> 33.33
  assert.equal(ledger.progressPercent(1, 3), 33.33);
});

test('ledger - validateLedger pure validation tests', () => {
  const chunkSize = 100;
  const expectedSize = 250;
  const totalChunks = 3; // Chunk 0: 0..99 (100), Chunk 1: 100..199 (100), Chunk 2: 200..249 (50)

  // 1. Complete valid ledger
  const validMetadata = {
    totalChunks,
    expectedSize,
    chunkSize,
    chunks: [
      { index: 0, start: 0, end: 99, size: 100 },
      { index: 1, start: 100, end: 199, size: 100 },
      { index: 2, start: 200, end: 249, size: 50 }
    ]
  };
  const resValid = ledger.validateLedger(validMetadata);
  assert.equal(resValid.ok, true);
  assert.deepEqual(resValid.problems, []);
  assert.deepEqual(resValid.missingChunks, []);

  // 2. Missing chunk
  const missingMetadata = {
    totalChunks,
    expectedSize,
    chunkSize,
    chunks: [
      { index: 0, start: 0, end: 99, size: 100 },
      { index: 2, start: 200, end: 249, size: 50 }
    ]
  };
  const resMissing = ledger.validateLedger(missingMetadata);
  assert.equal(resMissing.ok, false);
  assert.deepEqual(resMissing.missingChunks, [1]);

  // 3. Duplicate index
  const duplicateMetadata = {
    totalChunks,
    expectedSize,
    chunkSize,
    chunks: [
      { index: 0, start: 0, end: 99, size: 100 },
      { index: 0, start: 0, end: 99, size: 100 },
      { index: 1, start: 100, end: 199, size: 100 },
      { index: 2, start: 200, end: 249, size: 50 }
    ]
  };
  const resDuplicate = ledger.validateLedger(duplicateMetadata);
  assert.equal(resDuplicate.ok, false);
  assert.ok(resDuplicate.problems.some((p) => p.includes('Duplicate chunk index 0')));

  // 4. Overlap
  const overlapMetadata = {
    totalChunks,
    expectedSize,
    chunkSize,
    chunks: [
      { index: 0, start: 0, end: 120, size: 121 },
      { index: 1, start: 100, end: 199, size: 100 },
      { index: 2, start: 200, end: 249, size: 50 }
    ]
  };
  const resOverlap = ledger.validateLedger(overlapMetadata);
  assert.equal(resOverlap.ok, false);
  assert.ok(resOverlap.problems.some((p) => p.includes('Overlapping chunks')));

  // 5. Wrong range
  const wrongRangeMetadata = {
    totalChunks,
    expectedSize,
    chunkSize,
    chunks: [
      { index: 0, start: 0, end: 80, size: 81 },
      { index: 1, start: 100, end: 199, size: 100 },
      { index: 2, start: 200, end: 249, size: 50 }
    ]
  };
  const resWrongRange = ledger.validateLedger(wrongRangeMetadata);
  assert.equal(resWrongRange.ok, false);
  assert.ok(resWrongRange.problems.some((p) => p.includes('range mismatch')));

  // 6. Wrong total size sum
  const wrongTotalMetadata = {
    totalChunks,
    expectedSize: 300, // expected 300, but chunks sum to 250
    chunkSize,
    chunks: [
      { index: 0, start: 0, end: 99, size: 100 },
      { index: 1, start: 100, end: 199, size: 100 },
      { index: 2, start: 200, end: 299, size: 100 } // Wait: let's have sum not match expected
    ]
  };
  // chunk 2 expected range for size 250 would be 200..249, but here expectedSize is 300:
  // chunk 0: 0..99 (100), chunk 1: 100..199 (100), chunk 2: 200..299 (100) -> sum 300
  // If we change chunk 2 size property to 50:
  wrongTotalMetadata.chunks[2] = { index: 2, start: 200, end: 299, size: 50 };
  const resWrongTotal = ledger.validateLedger(wrongTotalMetadata);
  assert.equal(resWrongTotal.ok, false);
  assert.ok(resWrongTotal.problems.some((p) => p.includes('does not equal expected file size')));
});
