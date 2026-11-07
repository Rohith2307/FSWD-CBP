const test = require('node:test');
const assert = require('node:assert/strict');
const clientChunkMath = require('../public/chunkMath');
const serverValidation = require('../src/utils/validation');

test('chunkMath: Pure client math parity and Blob.slice protocol tests', async (t) => {
  await t.test('Parity with server chunkCount and expectedRange for >= 200 parameter combinations', () => {
    const chunkSizes = [256, 1024, 65536, 1048576, 4194304];
    const testCases = [
      // size < chunk
      { size: 100, chunkSize: 256 },
      { size: 500, chunkSize: 1024 },
      { size: 50000, chunkSize: 65536 },
      // size == chunk
      { size: 256, chunkSize: 256 },
      { size: 1024, chunkSize: 1024 },
      { size: 1048576, chunkSize: 1048576 },
      // size == chunk + 1
      { size: 257, chunkSize: 256 },
      { size: 1025, chunkSize: 1024 },
      { size: 1048577, chunkSize: 1048576 },
      // 7 MiB / 1 MiB
      { size: 7 * 1048576, chunkSize: 1048576 },
      // 7.5 MiB
      { size: Math.floor(7.5 * 1048576), chunkSize: 1048576 },
      // 5.5 MiB
      { size: Math.floor(5.5 * 1048576), chunkSize: 1048576 }
    ];

    // Expand combinations to reach > 200 combinations
    for (const cs of chunkSizes) {
      for (let s = 1; s <= 40; s++) {
        testCases.push({ size: s * 1337 + (s % 7), chunkSize: cs });
      }
    }

    let combinationsChecked = 0;

    for (const { size, chunkSize } of testCases) {
      const serverTotal = serverValidation.chunkCount(size, chunkSize);
      const clientTotal = clientChunkMath.chunkCount(size, chunkSize);
      assert.equal(clientTotal, serverTotal, `chunkCount mismatch for size ${size}, chunk ${chunkSize}`);

      for (let idx = 0; idx < clientTotal; idx++) {
        const serverR = serverValidation.expectedRange(idx, size, chunkSize);
        const clientR = clientChunkMath.chunkRange(idx, size, chunkSize);

        assert.equal(clientR.start, serverR.start);
        assert.equal(clientR.end, serverR.end);
        assert.equal(clientR.length, serverR.length);
        assert.equal(clientR.sliceEnd, clientR.end + 1, 'sliceEnd must be end + 1');

        const header = clientChunkMath.contentRangeHeader(idx, size, chunkSize);
        assert.equal(header, `bytes ${serverR.start}-${serverR.end}/${size}`);

        combinationsChecked++;
      }
    }

    assert.ok(combinationsChecked >= 200, `Expected >= 200 combinations, checked ${combinationsChecked}`);
  });

  await t.test('Real Blob.slice(start, sliceEnd).size === length for every chunk of 5.5 MiB Blob', () => {
    const size = Math.floor(5.5 * 1048576); // 5767168 bytes
    const chunkSize = 1048576; // 1 MiB
    const totalChunks = clientChunkMath.chunkCount(size, chunkSize);
    assert.equal(totalChunks, 6);

    const buffer = Buffer.alloc(size, 0x42);
    const blob = new Blob([buffer]);
    assert.equal(blob.size, size);

    let totalSlicedBytes = 0;
    for (let idx = 0; idx < totalChunks; idx++) {
      const r = clientChunkMath.chunkRange(idx, size, chunkSize);
      assert.equal(r.sliceEnd, r.end + 1);

      const slice = blob.slice(r.start, r.sliceEnd);
      assert.equal(slice.size, r.length, `Slice size must equal chunk length for index ${idx}`);
      totalSlicedBytes += slice.size;
    }

    assert.equal(totalSlicedBytes, size);
  });

  await t.test('Explicit verification: using `end` instead of `sliceEnd` drops exactly one byte', () => {
    const size = 1048576; // 1 MiB
    const chunkSize = 262144; // 256 KiB
    const buffer = Buffer.alloc(size, 0xaa);
    const blob = new Blob([buffer]);

    const r = clientChunkMath.chunkRange(0, size, chunkSize);
    assert.equal(r.start, 0);
    assert.equal(r.end, 262143);
    assert.equal(r.length, 262144);
    assert.equal(r.sliceEnd, 262144);

    // Correct slice with sliceEnd
    const correctSlice = blob.slice(r.start, r.sliceEnd);
    assert.equal(correctSlice.size, 262144);

    // Flawed slice using inclusive HTTP 'end' drops exactly one byte
    const flawedSlice = blob.slice(r.start, r.end);
    assert.equal(flawedSlice.size, r.length - 1);
    assert.equal(flawedSlice.size, 262143);
  });
});
