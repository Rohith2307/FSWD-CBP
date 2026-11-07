const { Transform } = require('node:stream');
const crypto = require('node:crypto');
const { payloadTooLarge } = require('../utils/httpErrors');

/**
 * Creates a pass-through Transform stream that computes SHA-256 and counts bytes on the fly.
 * Chunks are passed through immediately to apply natural backpressure with bounded memory.
 * If incoming bytes exceed maxAllowedBytes, aborts immediately with 413 Payload Too Large.
 *
 * @param {number} [maxAllowedBytes=Infinity]
 * @returns {Transform & { digestHex: () => string|null, bytesSeen: number }}
 */
function createSha256Transform(maxAllowedBytes = Infinity) {
  const hash = crypto.createHash('sha256');
  let bytesSeen = 0;
  let digest = null;

  const stream = new Transform({
    transform(chunk, encoding, callback) {
      bytesSeen += chunk.length;
      if (bytesSeen > maxAllowedBytes) {
        return callback(
          payloadTooLarge(
            `Incoming bytes (${bytesSeen}) exceeded declared chunk length of ${maxAllowedBytes} bytes`,
            null,
            { Connection: 'close' }
          )
        );
      }
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      digest = hash.digest('hex').toLowerCase();
      callback();
    }
  });

  stream.digestHex = () => {
    return digest;
  };

  Object.defineProperty(stream, 'bytesSeen', {
    get: () => bytesSeen
  });

  return stream;
}

module.exports = {
  createSha256Transform
};
