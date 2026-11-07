const defaultConfig = require('../src/config');
const { runCleanup } = require('../src/services/cleanup');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const config = defaultConfig;
  const storageRoot = config.storageRoot;

  console.log(`Starting cleanup sweep (dryRun: ${dryRun})`);
  console.log(`Storage root: ${storageRoot}`);
  console.log('---');

  const startTime = Date.now();
  const report = await runCleanup({
    storageRoot,
    config,
    nowMs: Date.now(),
    dryRun
  });
  const elapsedMs = Date.now() - startTime;

  console.log('Cleanup report:');
  console.log(`- Stale temp files deleted:      ${report.tempDeleted}`);
  console.log(`- Expired upload sessions:       ${report.sessionsExpired}`);
  console.log(`- Orphan chunk files deleted:    ${report.orphanChunksDeleted}`);
  console.log(`- Orphan media files deleted:    ${report.orphanMediaDeleted}`);
  console.log(`- Inconsistent media JSON (kept): ${report.orphanMediaJson.length}${report.orphanMediaJson.length > 0 ? ` [${report.orphanMediaJson.join(', ')}]` : ''}`);
  console.log(`- Errors encountered:            ${report.errors.length}`);
  console.log(`Duration: ${elapsedMs}ms`);

  if (report.errors.length > 0) {
    console.error('Errors:');
    for (const err of report.errors) {
      console.error(`  - ${err.item}: ${err.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[Cleanup CLI Error]', err.message);
  process.exit(1);
});
