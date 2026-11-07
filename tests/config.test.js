const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadConfig } = require('../src/config');

test('config - loads valid default configuration', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 3000);
  assert.equal(cfg.storageRoot, path.resolve(__dirname, '../storage'));
  assert.equal(cfg.maxJsonBodyBytes, 64 * 1024);
  assert.equal(cfg.maxUploadBytes, 2 * 1024 * 1024 * 1024);
  assert.equal(cfg.minChunkBytes, 64 * 1024);
  assert.equal(cfg.defaultChunkBytes, 1024 * 1024);
  assert.equal(cfg.maxChunkBytes, 16 * 1024 * 1024);
  assert.equal(cfg.maxConcurrentUploads, 10);
  assert.equal(cfg.maxFilenameLength, 255);
  assert.equal(cfg.requestTimeoutMs, 120000);
  assert.equal(cfg.headersTimeoutMs, 60000);
  assert.equal(cfg.keepAliveTimeoutMs, 5000);
  assert.ok(Object.isFrozen(cfg), 'Config object should be frozen');
  assert.ok(Object.isFrozen(cfg.allowedContentTypes), 'allowedContentTypes should be frozen');
});

test('config - respects valid environment variable overrides', () => {
  const cfg = loadConfig({
    HOST: '0.0.0.0',
    PORT: '8080',
    STORAGE_ROOT: 'relative/custom_storage',
    MIN_CHUNK_BYTES: '131072',
    DEFAULT_CHUNK_BYTES: '2097152',
    MAX_CHUNK_BYTES: '8388608',
    REQUEST_TIMEOUT_MS: '30000',
    HEADERS_TIMEOUT_MS: '20000'
  });

  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.storageRoot, path.resolve(process.cwd(), 'relative/custom_storage'));
  assert.equal(cfg.minChunkBytes, 131072);
  assert.equal(cfg.defaultChunkBytes, 2097152);
  assert.equal(cfg.maxChunkBytes, 8388608);
  assert.equal(cfg.requestTimeoutMs, 30000);
  assert.equal(cfg.headersTimeoutMs, 20000);
});

test('config - throws on invalid port', () => {
  assert.throws(() => loadConfig({ PORT: 'not-a-port' }), /Configuration error: "PORT"/);
  assert.throws(() => loadConfig({ PORT: '0' }), /Configuration error: "PORT"/);
  assert.throws(() => loadConfig({ PORT: '70000' }), /Configuration error: "PORT"/);
});

test('config - throws on inverted chunk sizes', () => {
  assert.throws(
    () => loadConfig({ MIN_CHUNK_BYTES: '2097152', DEFAULT_CHUNK_BYTES: '1048576' }),
    /minChunkBytes .* cannot exceed defaultChunkBytes/
  );
  assert.throws(
    () => loadConfig({ DEFAULT_CHUNK_BYTES: '33554432', MAX_CHUNK_BYTES: '16777216' }),
    /defaultChunkBytes .* cannot exceed maxChunkBytes/
  );
});

test('config - throws on invalid timeout ordering', () => {
  assert.throws(
    () => loadConfig({ REQUEST_TIMEOUT_MS: '20000', HEADERS_TIMEOUT_MS: '30000' }),
    /headersTimeoutMs .* must be <= requestTimeoutMs/
  );
});
