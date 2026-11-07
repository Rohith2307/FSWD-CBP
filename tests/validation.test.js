const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeDisplayName,
  parseSize,
  parseContentRange,
  parseSha256Header,
  chunkCount,
  expectedRange
} = require('../src/utils/validation');
const { HttpError } = require('../src/utils/httpErrors');

test('validation - chunkCount and expectedRange math', () => {
  const ONE_MIB = 1048576;
  const SEVEN_MIB = 7340032; // 7 * 1048576

  // 1. 7 MiB / 1 MiB example: 7 chunks, chunk 6 = 6291456..7340031
  assert.equal(chunkCount(SEVEN_MIB, ONE_MIB), 7);
  const chunk0 = expectedRange(0, SEVEN_MIB, ONE_MIB);
  assert.deepEqual(chunk0, { start: 0, end: 1048575, length: ONE_MIB });
  const chunk5 = expectedRange(5, SEVEN_MIB, ONE_MIB);
  assert.deepEqual(chunk5, { start: 5242880, end: 6291455, length: ONE_MIB });
  const chunk6 = expectedRange(6, SEVEN_MIB, ONE_MIB);
  assert.deepEqual(chunk6, { start: 6291456, end: 7340031, length: ONE_MIB });

  // 2. 7.5 MiB file (7 * 1048576 + 524288 = 7864320 bytes)
  const SEVEN_POINT_FIVE_MIB = 7864320;
  assert.equal(chunkCount(SEVEN_POINT_FIVE_MIB, ONE_MIB), 8);
  const lastChunk7_5 = expectedRange(7, SEVEN_POINT_FIVE_MIB, ONE_MIB);
  assert.deepEqual(lastChunk7_5, { start: 7340032, end: 7864319, length: 524288 });

  // 3. File smaller than one chunk (500 KiB file with 1 MiB chunks)
  const SMALL_SIZE = 512000;
  assert.equal(chunkCount(SMALL_SIZE, ONE_MIB), 1);
  const smallChunk = expectedRange(0, SMALL_SIZE, ONE_MIB);
  assert.deepEqual(smallChunk, { start: 0, end: 511999, length: 512000 });

  // 4. File size exactly equal to chunkSize
  assert.equal(chunkCount(ONE_MIB, ONE_MIB), 1);
  const exactChunk = expectedRange(0, ONE_MIB, ONE_MIB);
  assert.deepEqual(exactChunk, { start: 0, end: 1048575, length: ONE_MIB });

  // 5. File size = chunkSize + 1
  assert.equal(chunkCount(ONE_MIB + 1, ONE_MIB), 2);
  const chunkPlus1_0 = expectedRange(0, ONE_MIB + 1, ONE_MIB);
  assert.deepEqual(chunkPlus1_0, { start: 0, end: 1048575, length: ONE_MIB });
  const chunkPlus1_1 = expectedRange(1, ONE_MIB + 1, ONE_MIB);
  assert.deepEqual(chunkPlus1_1, { start: 1048576, end: 1048576, length: 1 });

  // Out of bounds index throws
  assert.throws(() => expectedRange(7, SEVEN_MIB, ONE_MIB), /out of bounds/);
  assert.throws(() => expectedRange(-1, SEVEN_MIB, ONE_MIB), /Invalid chunk index/);
});

test('validation - parseContentRange strict parser', () => {
  // Valid header
  const valid = parseContentRange('bytes 0-1048575/7340032');
  assert.deepEqual(valid, { start: 0, end: 1048575, total: 7340032, length: 1048576 });

  // Malformed variants
  const invalidHeaders = [
    '',
    null,
    undefined,
    123,
    'bytes */100',
    'bytes 0-50/*',
    'bytes 0-50/-1',
    'bytes  0-10/100',
    'bytes 0-10/100 garbage',
    'bytes 0-10/100 ',
    'bytes +0-10/100',
    'bytes 0-+10/100',
    'bytes 0-10/+100',
    'bytes -5-10/100',
    'bytes 10-5/100', // start > end
    'bytes 0-100/100', // end >= total (ranges are 0-indexed)
    'bytes 0-105/100',
    'bytes 0-10/0',
    'bytes 0-10/9007199254740992' // overflow > MAX_SAFE_INTEGER
  ];

  for (const h of invalidHeaders) {
    assert.throws(
      () => parseContentRange(h),
      (err) => err instanceof HttpError && err.statusCode === 400,
      `Should have rejected malformed Content-Range: "${h}"`
    );
  }
});

test('validation - sanitizeDisplayName', () => {
  assert.equal(sanitizeDisplayName('../../etc/passwd'), 'etcpasswd');
  assert.equal(sanitizeDisplayName('a\\b.txt'), 'ab.txt');
  assert.equal(sanitizeDisplayName('  .hidden '), 'hidden');
  assert.equal(sanitizeDisplayName('file\x00\x1f\x7fname.mp4'), 'filename.mp4');
  assert.equal(sanitizeDisplayName('my   video   file.mp4'), 'my video file.mp4');

  // Empty after sanitize
  assert.throws(() => sanitizeDisplayName('...'), /empty after sanitization/);
  assert.throws(() => sanitizeDisplayName(' /\\ . '), /empty after sanitization/);

  // Over-length
  assert.throws(() => sanitizeDisplayName('a'.repeat(256), 255), /exceeds maximum allowed length/);
});

test('validation - parseSha256Header and parseSize', () => {
  const validHex = 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855';
  assert.equal(parseSha256Header(validHex), validHex.toLowerCase());

  assert.throws(() => parseSha256Header('short'), /Invalid X-Chunk-SHA256/);
  assert.throws(() => parseSha256Header('g'.repeat(64)), /Invalid X-Chunk-SHA256/);
  assert.throws(() => parseSha256Header(null), /Missing or invalid/);

  assert.equal(parseSize(100), 100);
  assert.equal(parseSize('100'), 100);
  assert.throws(() => parseSize(0), /positive safe integer/);
  assert.throws(() => parseSize(-5), /positive safe integer/);
  assert.throws(() => parseSize('abc'), /positive safe integer/);
});

test('A2 - generator test: 3 MiB yields three distinct 1 MiB hashes, same seed gives identical hash', async () => {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const crypto = require('node:crypto');
  const { generateFile } = require('../scripts/generate-test-file');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-gen-test-'));
  const file1 = path.join(tmpDir, 'file1.bin');
  const file2 = path.join(tmpDir, 'file2.bin');

  try {
    const size3MiB = 3 * 1024 * 1024;
    const res1 = await generateFile(size3MiB, file1, 12345);
    const res2 = await generateFile(size3MiB, file2, 12345);

    // 1. Same seed gives identical whole-file hash
    assert.equal(res1.sha256, res2.sha256);

    // 2. Read the three 1 MiB chunks and assert their hashes are all distinct
    const buf = fs.readFileSync(file1);
    const chunk0 = buf.subarray(0, 1048576);
    const chunk1 = buf.subarray(1048576, 2097152);
    const chunk2 = buf.subarray(2097152, 3145728);

    const sha0 = crypto.createHash('sha256').update(chunk0).digest('hex');
    const sha1 = crypto.createHash('sha256').update(chunk1).digest('hex');
    const sha2 = crypto.createHash('sha256').update(chunk2).digest('hex');

    assert.notEqual(sha0, sha1, 'Chunk 0 and Chunk 1 hashes must differ');
    assert.notEqual(sha1, sha2, 'Chunk 1 and Chunk 2 hashes must differ');
    assert.notEqual(sha0, sha2, 'Chunk 0 and Chunk 2 hashes must differ');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
