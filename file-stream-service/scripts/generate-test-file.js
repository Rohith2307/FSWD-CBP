#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function parseSizeArg(arg) {
  if (!arg) {
    throw new Error('Size argument is required');
  }
  const match = String(arg).trim().match(/^([0-9.]+)\s*([a-zA-Z]*)$/);
  if (!match) {
    throw new Error(`Invalid size argument: "${arg}"`);
  }
  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = {
    '': 1,
    'b': 1,
    'k': 1024,
    'kib': 1024,
    'kb': 1000,
    'm': 1024 * 1024,
    'mib': 1024 * 1024,
    'mb': 1000 * 1000,
    'g': 1024 * 1024 * 1024,
    'gib': 1024 * 1024 * 1024,
    'gb': 1000 * 1000 * 1000
  };
  const mult = multipliers[unit];
  if (!mult) {
    throw new Error(`Unknown size unit: "${unit}"`);
  }
  return Math.floor(val * mult);
}

function parseSeedArg(arg) {
  if (arg === undefined || arg === null || arg === '') {
    return 0x853c49e6;
  }
  const num = Number(arg);
  if (Number.isSafeInteger(num)) {
    return num >>> 0;
  }
  // If string seed provided, hash to 32-bit integer
  const hash = crypto.createHash('sha256').update(String(arg)).digest();
  return hash.readUInt32LE(0);
}

/**
 * High-quality 32-bit PRNG (Mulberry32) with a period of ~4 billion integers.
 * State persists continuously across chunks to ensure non-repeating data.
 */
function createMulberry32(seed) {
  let s = (seed >>> 0) || 0x853c49e6;
  return function nextUint32() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/**
 * Readable stream that generates deterministic, non-repeating pseudo-random bytes
 * using bounded buffers and natural backpressure.
 */
class DeterministicByteStream extends Readable {
  constructor(totalBytes, seed = 0x853c49e6) {
    super();
    this.totalBytes = totalBytes;
    this.bytesSent = 0;
    this.bufferSize = 64 * 1024; // 64 KiB chunks
    this.prng = createMulberry32(parseSeedArg(seed));
  }

  _read() {
    if (this.bytesSent >= this.totalBytes) {
      this.push(null);
      return;
    }

    const toSend = Math.min(this.bufferSize, this.totalBytes - this.bytesSent);
    const buf = Buffer.allocUnsafe(toSend);

    const intCount = Math.floor(toSend / 4);
    for (let i = 0; i < intCount; i++) {
      buf.writeUInt32LE(this.prng(), i * 4);
    }

    const remainder = toSend % 4;
    if (remainder > 0) {
      const extra = this.prng();
      const offset = intCount * 4;
      for (let j = 0; j < remainder; j++) {
        buf[offset + j] = (extra >>> (j * 8)) & 0xff;
      }
    }

    this.bytesSent += toSend;
    this.push(buf);
  }
}

async function generateFile(targetBytes, outPath, seed) {
  await fs.promises.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });

  const hash = crypto.createHash('sha256');
  let totalWritten = 0;

  const hashingTransform = new Transform({
    transform(chunk, encoding, callback) {
      totalWritten += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    }
  });

  const sourceStream = new DeterministicByteStream(targetBytes, seed);
  const destinationStream = fs.createWriteStream(outPath);

  await pipeline(sourceStream, hashingTransform, destinationStream);

  const finalSha256 = hash.digest('hex');
  return {
    path: path.resolve(outPath),
    size: totalWritten,
    sha256: finalSha256
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node scripts/generate-test-file.js <sizeBytes|e.g. 20MiB> <outPath> [seed]');
    process.exit(1);
  }

  const targetBytes = parseSizeArg(args[0]);
  const outPath = args[1];
  const seed = args[2];

  const result = await generateFile(targetBytes, outPath, seed);
  console.log(`File created: ${result.path}`);
  console.log(`Size: ${result.size} bytes (${(result.size / (1024 * 1024)).toFixed(2)} MiB)`);
  console.log(`SHA-256: ${result.sha256}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error generating test file:', err.message);
    process.exit(1);
  });
}

module.exports = {
  parseSizeArg,
  parseSeedArg,
  DeterministicByteStream,
  generateFile
};
