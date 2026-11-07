const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const paths = require('../src/storage/paths');
const { HttpError } = require('../src/utils/httpErrors');

test('paths - valid identifiers and paths generation', () => {
  const tmpRoot = path.join(os.tmpdir(), 'fss-test-paths');
  const validId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  assert.equal(paths.uploadsDir(tmpRoot), path.join(tmpRoot, 'uploads'));
  assert.equal(paths.uploadDir(validId, tmpRoot), path.join(tmpRoot, 'uploads', validId));
  assert.equal(paths.chunksDir(validId, tmpRoot), path.join(tmpRoot, 'uploads', validId, 'chunks'));
  assert.equal(
    paths.chunkPath(validId, 12, tmpRoot),
    path.join(tmpRoot, 'uploads', validId, 'chunks', '000012.part')
  );
  assert.equal(
    paths.chunkPath(validId, 0, tmpRoot),
    path.join(tmpRoot, 'uploads', validId, 'chunks', '000000.part')
  );
  assert.equal(
    paths.metadataPath(validId, tmpRoot),
    path.join(tmpRoot, 'uploads', validId, 'metadata.json')
  );
  assert.equal(paths.tempDir(tmpRoot), path.join(tmpRoot, 'temp'));
  assert.equal(paths.mediaDir(tmpRoot), path.join(tmpRoot, 'media'));
  assert.equal(
    paths.mediaPath(validId, 'mp4', tmpRoot),
    path.join(tmpRoot, 'media', `${validId}.mp4`)
  );
  assert.equal(
    paths.mediaPath(validId, '.webm', tmpRoot),
    path.join(tmpRoot, 'media', `${validId}.webm`)
  );
  assert.equal(
    paths.mediaMetaPath(validId, tmpRoot),
    path.join(tmpRoot, 'media', `${validId}.json`)
  );
  const tempAssemblyPath = paths.finalTempPath(validId, tmpRoot);
  assert.ok(
    tempAssemblyPath.startsWith(path.join(tmpRoot, 'temp', `${validId}-final-`)) &&
      tempAssemblyPath.endsWith('.tmp')
  );
});

test('paths - rejects traversal attempts and malicious IDs with 404 HttpError', () => {
  const tmpRoot = path.join(os.tmpdir(), 'fss-test-paths');
  const maliciousIds = [
    '../x',
    '..\\x',
    '/etc/passwd',
    '..',
    '../',
    '..\\',
    'a/../b',
    '%2e%2e%2f',
    'id with spaces',
    'short',
    'invalid$char*',
    '',
    null,
    undefined
  ];

  for (const id of maliciousIds) {
    assert.throws(
      () => paths.uploadDir(id, tmpRoot),
      (err) => {
        assert.ok(err instanceof HttpError, 'Should throw HttpError');
        assert.equal(err.statusCode, 404, 'Should be 404 for invalid ID');
        assert.ok(!err.message.includes(tmpRoot), 'Must not leak absolute storage path');
        return true;
      },
      `Should have rejected malicious id: "${id}" with 404`
    );
  }
});

test('paths - rejects invalid chunk indices with 400 HttpError', () => {
  const tmpRoot = path.join(os.tmpdir(), 'fss-test-paths');
  const validId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const invalidIndices = [-1, -100, 1.5, 'not-a-number', NaN, Infinity, -Infinity, null, undefined];

  for (const index of invalidIndices) {
    assert.throws(
      () => paths.chunkPath(validId, index, tmpRoot),
      (err) => {
        assert.ok(err instanceof HttpError, 'Should throw HttpError');
        assert.equal(err.statusCode, 400, 'Should be 400 for invalid index');
        return true;
      },
      `Should have rejected invalid chunk index: ${index}`
    );
  }
});

test('paths - rejects malicious extensions in mediaPath with 400 HttpError', () => {
  const tmpRoot = path.join(os.tmpdir(), 'fss-test-paths');
  const validId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const badExtensions = ['../../etc/passwd', 'exe/sh', 'mp4.bak', '', '.', null, undefined];

  for (const ext of badExtensions) {
    assert.throws(
      () => paths.mediaPath(validId, ext, tmpRoot),
      (err) => {
        assert.ok(err instanceof HttpError, 'Should throw HttpError');
        assert.equal(err.statusCode, 400, 'Should be 400 for invalid extension');
        return true;
      },
      `Should have rejected bad extension: ${ext}`
    );
  }
});

test('paths - assertInsideStorageRoot rejects paths outside root without leaking root path', () => {
  const tmpRoot = path.join(os.tmpdir(), 'fss-test-paths');
  const outsidePath = path.join(tmpRoot, '..', 'escaped');

  assert.throws(
    () => paths.assertInsideStorageRoot(outsidePath, tmpRoot),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('escapes storage root'));
      assert.ok(!err.message.includes(tmpRoot), 'Must not leak absolute storage path in message');
      return true;
    }
  );
});

test('paths - ensureStorageDirs creates uploads, temp, and media directories', async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-dirs-test-'));
  try {
    await paths.ensureStorageDirs(testRoot);

    assert.ok(fs.existsSync(path.join(testRoot, 'uploads')), 'uploads dir must exist');
    assert.ok(fs.existsSync(path.join(testRoot, 'temp')), 'temp dir must exist');
    assert.ok(fs.existsSync(path.join(testRoot, 'media')), 'media dir must exist');
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});
