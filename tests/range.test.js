const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseRangeHeader,
  contentRangeHeader,
  unsatisfiedRangeHeader
} = require('../src/services/rangeStreamer');

test('pure parseRangeHeader and header helpers unit tests', async (t) => {
  const size = 1000;

  await t.test('absent or non-string header -> kind none', () => {
    assert.deepEqual(parseRangeHeader(undefined, size), { kind: 'none' });
    assert.deepEqual(parseRangeHeader(null, size), { kind: 'none' });
    assert.deepEqual(parseRangeHeader('', size), { kind: 'none' });
  });

  await t.test('unknown range unit (not "bytes") -> kind none', () => {
    assert.deepEqual(parseRangeHeader('items=0-5', size), { kind: 'none' });
    assert.deepEqual(parseRangeHeader('seconds=10-20', size), { kind: 'none' });
    assert.deepEqual(parseRangeHeader('foobar', size), { kind: 'none' });
  });

  await t.test('unit matching is case-insensitive ("Bytes=" or "BYTES=") -> kind range', () => {
    assert.deepEqual(parseRangeHeader('Bytes=0-9', size), { kind: 'range', start: 0, end: 9 });
    assert.deepEqual(parseRangeHeader('BYTES=10-19', size), { kind: 'range', start: 10, end: 19 });
  });

  await t.test('multi-range requests ("bytes=0-1,5-6") -> kind multi', () => {
    assert.deepEqual(parseRangeHeader('bytes=0-1,5-6', size), { kind: 'multi' });
    assert.deepEqual(parseRangeHeader('bytes=0-10, 20-30', size), { kind: 'multi' });
  });

  await t.test('explicit range "bytes=a-b" within bounds', () => {
    assert.deepEqual(parseRangeHeader('bytes=0-0', size), { kind: 'range', start: 0, end: 0 });
    assert.deepEqual(parseRangeHeader('bytes=0-1023', 2000), { kind: 'range', start: 0, end: 1023 });
    assert.deepEqual(parseRangeHeader('bytes=999-999', size), { kind: 'range', start: 999, end: 999 });
  });

  await t.test('explicit range "bytes=a-b" where b >= size -> clamped to size - 1', () => {
    assert.deepEqual(parseRangeHeader('bytes=0-99999', size), { kind: 'range', start: 0, end: 999 });
    assert.deepEqual(parseRangeHeader('bytes=500-1500', size), { kind: 'range', start: 500, end: 999 });
  });

  await t.test('explicit range "bytes=a-b" where a >= size -> kind unsatisfiable', () => {
    assert.deepEqual(parseRangeHeader('bytes=1000-1000', size), { kind: 'unsatisfiable' });
    assert.deepEqual(parseRangeHeader('bytes=1001-2000', size), { kind: 'unsatisfiable' });
  });

  await t.test('explicit range "bytes=a-b" where a > b -> kind malformed', () => {
    assert.deepEqual(parseRangeHeader('bytes=5-4', size), { kind: 'malformed' });
    assert.deepEqual(parseRangeHeader('bytes=500-100', size), { kind: 'malformed' });
    assert.deepEqual(parseRangeHeader('bytes=100-50', size), { kind: 'malformed' });
  });

  await t.test('open-ended range "bytes=a-"', () => {
    assert.deepEqual(parseRangeHeader('bytes=500-', size), { kind: 'range', start: 500, end: 999 });
    assert.deepEqual(parseRangeHeader('bytes=0-', size), { kind: 'range', start: 0, end: 999 });
    assert.deepEqual(parseRangeHeader('bytes=999-', size), { kind: 'range', start: 999, end: 999 });
    assert.deepEqual(parseRangeHeader('bytes=1000-', size), { kind: 'unsatisfiable' });
    assert.deepEqual(parseRangeHeader('bytes=5000-', size), { kind: 'unsatisfiable' });
  });

  await t.test('suffix range "bytes=-n"', () => {
    assert.deepEqual(parseRangeHeader('bytes=-1', size), { kind: 'range', start: 999, end: 999 });
    assert.deepEqual(parseRangeHeader('bytes=-500', size), { kind: 'range', start: 500, end: 999 });
    assert.deepEqual(parseRangeHeader('bytes=-1000', size), { kind: 'range', start: 0, end: 999 });
    assert.deepEqual(parseRangeHeader('bytes=-5000', size), { kind: 'range', start: 0, end: 999 });
    assert.deepEqual(parseRangeHeader('bytes=-0', size), { kind: 'unsatisfiable' });
  });

  await t.test('grammar violations -> kind malformed', () => {
    assert.deepEqual(parseRangeHeader('bytes=', size), { kind: 'malformed' });
    assert.deepEqual(parseRangeHeader('bytes=-', size), { kind: 'malformed' });
    assert.deepEqual(parseRangeHeader('bytes=a', size), { kind: 'malformed' });
    assert.deepEqual(parseRangeHeader('bytes=a-b-c', size), { kind: 'malformed' });
    assert.deepEqual(parseRangeHeader('bytes= 0-5', size), { kind: 'malformed' });
    assert.deepEqual(parseRangeHeader('bytes=0- 5', size), { kind: 'malformed' });
    assert.deepEqual(parseRangeHeader('bytes=+5-10', size), { kind: 'malformed' });
    assert.deepEqual(parseRangeHeader('bytes=0x10-20', size), { kind: 'malformed' });
    assert.deepEqual(parseRangeHeader('bytes=--50', size), { kind: 'malformed' });
  });

  await t.test('numbers exceeding Number.MAX_SAFE_INTEGER -> kind unsatisfiable', () => {
    assert.deepEqual(parseRangeHeader('bytes=99999999999999999999-', size), { kind: 'unsatisfiable' });
    assert.deepEqual(parseRangeHeader('bytes=0-99999999999999999999', size), { kind: 'unsatisfiable' });
    assert.deepEqual(parseRangeHeader('bytes=-99999999999999999999', size), { kind: 'unsatisfiable' });
  });

  await t.test('size 1 resource edge cases', () => {
    assert.deepEqual(parseRangeHeader('bytes=0-0', 1), { kind: 'range', start: 0, end: 0 });
    assert.deepEqual(parseRangeHeader('bytes=1-1', 1), { kind: 'unsatisfiable' });
    assert.deepEqual(parseRangeHeader('bytes=0-', 1), { kind: 'range', start: 0, end: 0 });
    assert.deepEqual(parseRangeHeader('bytes=1-', 1), { kind: 'unsatisfiable' });
    assert.deepEqual(parseRangeHeader('bytes=-1', 1), { kind: 'range', start: 0, end: 0 });
    assert.deepEqual(parseRangeHeader('bytes=-2', 1), { kind: 'range', start: 0, end: 0 });
  });

  await t.test('size 0 resource edge cases', () => {
    assert.deepEqual(parseRangeHeader('bytes=0-0', 0), { kind: 'unsatisfiable' });
    assert.deepEqual(parseRangeHeader('bytes=0-', 0), { kind: 'unsatisfiable' });
    assert.deepEqual(parseRangeHeader('bytes=-1', 0), { kind: 'unsatisfiable' });
  });

  await t.test('header formatting helpers', () => {
    assert.equal(contentRangeHeader(0, 1023, 5767168), 'bytes 0-1023/5767168');
    assert.equal(unsatisfiedRangeHeader(5767168), 'bytes */5767168');
  });

  await t.test('A3: testIfRange RFC 9110 strict validator rules', () => {
    const { testIfRange } = require('../src/services/rangeStreamer');
    const strongEtag = '"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"';
    const unquotedEtag = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const lastModified = 'Sat, 07 Nov 2026 11:15:15 GMT';

    // 1. Exact quoted strong ETag matches
    assert.equal(testIfRange(strongEtag, strongEtag, lastModified), true);

    // 2. Unquoted ETag string must NOT match
    assert.equal(testIfRange(unquotedEtag, strongEtag, lastModified), false);

    // 3. Weak validator (W/"...") must NOT match
    assert.equal(testIfRange(`W/${strongEtag}`, strongEtag, lastModified), false);
    assert.equal(testIfRange('W/"some-weak-tag"', strongEtag, lastModified), false);

    // 4. Exact Last-Modified HTTP-date string matches
    assert.equal(testIfRange(lastModified, strongEtag, lastModified), true);

    // 5. Mismatched date fails
    assert.equal(testIfRange('Sun, 08 Nov 2026 12:00:00 GMT', strongEtag, lastModified), false);

    // 6. Absent If-Range allows normal Range processing
    assert.equal(testIfRange(undefined, strongEtag, lastModified), true);
    assert.equal(testIfRange(null, strongEtag, lastModified), true);
  });

  await t.test('A3: mediaCatalog.listMedia does not create missing storage/media directory', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { listMedia } = require('../src/services/mediaCatalog');

    const tempRoot = path.join(os.tmpdir(), `test-missing-media-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const mediaDir = path.join(tempRoot, 'media');

    try {
      // mediaDir does not exist
      assert.equal(fs.existsSync(mediaDir), false);

      const items = await listMedia(tempRoot);
      assert.deepEqual(items, []);

      // Verify listMedia did NOT create the directory
      assert.equal(fs.existsSync(mediaDir), false);
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});
