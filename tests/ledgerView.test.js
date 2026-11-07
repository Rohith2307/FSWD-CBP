const test = require('node:test');
const assert = require('node:assert/strict');
const { bucketize, rangesFromStatus } = require('../public/ledgerView');

test('ledgerView: Bucketizing and visualization tests', async (t) => {
  await t.test('Identity mapping when totalChunks <= maxCells', () => {
    const states = {
      0: 'committed',
      1: 'inflight',
      2: 'missing',
      3: 'failed'
    };

    const cells = bucketize(4, states, 256);
    assert.equal(cells.length, 4);

    assert.deepEqual(cells[0], { from: 0, to: 0, state: 'committed' });
    assert.deepEqual(cells[1], { from: 1, to: 1, state: 'inflight' });
    assert.deepEqual(cells[2], { from: 2, to: 2, state: 'missing' });
    assert.deepEqual(cells[3], { from: 3, to: 3, state: 'failed' });
  });

  await t.test('32768 chunks maps to exactly <= 256 cells with no gaps or overlaps', () => {
    const totalChunks = 32768;
    const maxCells = 256;
    const cells = bucketize(totalChunks, {}, maxCells);

    assert.equal(cells.length, maxCells);

    // Verify complete contiguous coverage without gaps or overlaps
    let expectedNextFrom = 0;
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c];
      assert.equal(cell.from, expectedNextFrom, `Cell ${c} from bound mismatch`);
      assert.ok(cell.to >= cell.from, `Cell ${c} to bound must be >= from`);
      expectedNextFrom = cell.to + 1;
    }

    assert.equal(expectedNextFrom, totalChunks, 'Last cell must reach totalChunks');
    assert.equal(cells[cells.length - 1].to, totalChunks - 1);
  });

  await t.test('Precedence rule: failed > inflight > repaired > partial > missing > committed', () => {
    const totalChunks = 1000;
    const maxCells = 10; // each cell covers 100 chunks

    // Cell 0: mixed committed + failed -> must resolve to 'failed'
    // Cell 1: mixed committed + inflight -> must resolve to 'inflight'
    // Cell 2: mixed committed + repaired -> must resolve to 'repaired'
    // Cell 3: mixed committed + missing -> must resolve to 'partial'
    // Cell 4: all missing -> 'missing'
    // Cell 5: all committed -> 'committed'

    const stateMap = {};
    // Cell 0: chunks 0-99
    for (let i = 0; i < 99; i++) stateMap[i] = 'committed';
    stateMap[99] = 'failed';

    // Cell 1: chunks 100-199
    for (let i = 100; i < 199; i++) stateMap[i] = 'committed';
    stateMap[199] = 'inflight';

    // Cell 2: chunks 200-299
    for (let i = 200; i < 299; i++) stateMap[i] = 'committed';
    stateMap[299] = 'repaired';

    // Cell 3: chunks 300-399
    for (let i = 300; i < 350; i++) stateMap[i] = 'committed';
    for (let i = 350; i <= 399; i++) stateMap[i] = 'missing';

    // Cell 4: chunks 400-499: all default to missing

    // Cell 5: chunks 500-599: all committed
    for (let i = 500; i <= 599; i++) stateMap[i] = 'committed';

    const cells = bucketize(totalChunks, stateMap, maxCells);

    assert.equal(cells[0].state, 'failed', 'Precedence failed must dominate');
    assert.equal(cells[1].state, 'inflight', 'Precedence inflight must dominate');
    assert.equal(cells[2].state, 'repaired', 'Precedence repaired must dominate');
    assert.equal(cells[3].state, 'partial', 'Mixed committed/missing must be partial');
    assert.equal(cells[4].state, 'missing', 'All missing must be missing');
    assert.equal(cells[5].state, 'committed', 'All committed must be committed');
  });

  await t.test('rangesFromStatus helper formats ranges accurately', () => {
    assert.deepEqual(rangesFromStatus(null), { committed: [], missing: [] });

    const statusObj = {
      committedRanges: [
        { start: 0, end: 1048575 },
        { start: 2097152, end: 3145727 }
      ],
      missingRanges: [
        { start: 1048576, end: 2097151 }
      ]
    };

    const formatted = rangesFromStatus(statusObj);
    assert.deepEqual(formatted.committed, ['0-1048575', '2097152-3145727']);
    assert.deepEqual(formatted.missing, ['1048576-2097151']);
  });
});
