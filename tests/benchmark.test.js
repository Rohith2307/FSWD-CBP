const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Benchmark smoke test: runs quick benchmark suite under 30s and verifies output artifacts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fss-bench-smoke-'));
  const outFile = path.join(tmpDir, 'TEST_BENCHMARKS.md');
  const jsonFile = path.join(tmpDir, 'TEST_BENCHMARKS.json');
  const benchScript = path.resolve(__dirname, '../scripts/benchmark.js');

  const startTime = Date.now();
  const result = spawnSync(
    process.execPath,
    [benchScript, '--quick', `--out=${outFile}`, `--json-out=${jsonFile}`],
    {
      encoding: 'utf8',
      timeout: 30000
    }
  );

  const durationMs = Date.now() - startTime;
  assert.ok(durationMs < 30000, `Benchmark test took ${durationMs}ms; expected under 30,000ms`);

  if (result.status !== 0) {
    console.error('Benchmark stdout:', result.stdout);
    console.error('Benchmark stderr:', result.stderr);
  }
  assert.equal(result.status, 0, `Benchmark script exited with non-zero status: ${result.status}`);

  // Assert output files exist
  assert.ok(fs.existsSync(outFile), `Markdown output file ${outFile} should exist`);
  assert.ok(fs.existsSync(jsonFile), `JSON output file ${jsonFile} should exist`);

  // Assert Markdown structure and table rows
  const mdContent = fs.readFileSync(outFile, 'utf8');
  assert.ok(mdContent.includes('# Benchmark Results'));
  assert.ok(mdContent.includes('16 MiB'));
  assert.ok(
    mdContent.includes(
      '| Chunk Size | Concurrency | Elapsed (median ms) | Throughput (median MiB/s) | Min-Max MiB/s | Assembly (ms) | Server Peak RSS (MiB) | Server CPU (ms) | Attempts/Retries |'
    )
  );

  // Assert both matrix cells are present in the table
  const lines = mdContent.split('\n');
  const row1 = lines.find((l) => l.includes('1 MiB') && l.includes('| 1 '));
  const row2 = lines.find((l) => l.includes('1 MiB') && l.includes('| 2 '));
  assert.ok(row1, 'Table must contain row for concurrency 1');
  assert.ok(row2, 'Table must contain row for concurrency 2');
  assert.ok(row1.includes('16 / 0'), 'Row 1 should show 16 chunks / 0 retries');
  assert.ok(row2.includes('16 / 0'), 'Row 2 should show 16 chunks / 0 retries');

  // Assert JSON structure
  const jsonData = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  assert.equal(jsonData.fileSize, 16 * 1024 * 1024);
  assert.equal(jsonData.runsPerCell, 1);
  assert.equal(jsonData.results.length, 2);
  assert.equal(jsonData.results[0].concurrency, 1);
  assert.equal(jsonData.results[0].attemptsTotal, 16);
  assert.equal(jsonData.results[0].retriesTotal, 0);
  assert.ok(jsonData.results[0].throughputMedianMiBps > 0);

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
