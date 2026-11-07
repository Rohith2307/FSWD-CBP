(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FSS = root.FSS || {};
    root.FSS.chunkMath = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * CRITICAL OFF-BY-ONE PROTOCOL DESIGN NOTE:
   *
   * HTTP byte ranges (RFC 9110 §14.4) are INCLUSIVE on both boundaries:
   *   "Content-Range: bytes 0-1023/1024" indicates 1024 bytes (indices 0 through 1023 inclusive).
   *
   * Conversely, JavaScript's standard `Blob.prototype.slice(start, end)` API uses a HALF-OPEN interval:
   *   [start, end) where `start` is inclusive, but `end` is EXCLUSIVE.
   *
   * Therefore, to extract chunk bytes 0 through 1023 inclusive from a Blob, `slice()` MUST be passed
   * `sliceEnd = end + 1` (i.e. 1024).
   *
   * If a client incorrectly passes the HTTP inclusive `end` (1023) directly to `blob.slice(0, 1023)`,
   * exactly 1 byte is dropped from the end of the slice, resulting in an undersized chunk payload,
   * an immediate SHA-256 checksum mismatch (422), and corrupt assembled files!
   */

  /**
   * Calculates total chunk count using integer ceil math.
   *
   * @param {number} size - Total file size in bytes
   * @param {number} chunkSize - Nominal chunk size in bytes
   * @returns {number}
   */
  function chunkCount(size, chunkSize) {
    if (typeof size !== 'number' || size < 0 || !Number.isSafeInteger(size)) {
      throw new Error(`chunkCount: invalid size "${size}"`);
    }
    if (typeof chunkSize !== 'number' || chunkSize <= 0 || !Number.isSafeInteger(chunkSize)) {
      throw new Error(`chunkCount: invalid chunkSize "${chunkSize}"`);
    }
    if (size === 0) {
      return 0;
    }
    return Math.floor((size + chunkSize - 1) / chunkSize);
  }

  /**
   * Calculates the byte boundaries for chunk index.
   *
   * @param {number} index - 0-based chunk index
   * @param {number} size - Total file size in bytes
   * @param {number} chunkSize - Nominal chunk size in bytes
   * @returns {{ start: number, end: number, length: number, sliceEnd: number }}
   */
  function chunkRange(index, size, chunkSize) {
    if (typeof index !== 'number' || index < 0 || !Number.isSafeInteger(index)) {
      throw new Error(`chunkRange: invalid index "${index}"`);
    }
    if (typeof size !== 'number' || size <= 0 || !Number.isSafeInteger(size)) {
      throw new Error(`chunkRange: invalid size "${size}"`);
    }
    if (typeof chunkSize !== 'number' || chunkSize <= 0 || !Number.isSafeInteger(chunkSize)) {
      throw new Error(`chunkRange: invalid chunkSize "${chunkSize}"`);
    }

    const start = index * chunkSize;
    if (start >= size) {
      throw new Error(`chunkRange: chunk index ${index} out of range for size ${size}`);
    }

    const end = Math.min(start + chunkSize - 1, size - 1);
    const length = end - start + 1;
    // sliceEnd is EXCLUSIVE for Blob.prototype.slice(start, sliceEnd)
    const sliceEnd = end + 1;

    return {
      start,
      end,
      length,
      sliceEnd
    };
  }

  /**
   * Formats the standard HTTP Content-Range header value for a chunk upload.
   *
   * @param {number} index - 0-based chunk index
   * @param {number} size - Total file size in bytes
   * @param {number} chunkSize - Nominal chunk size in bytes
   * @returns {string} e.g. "bytes 0-1048575/13107200"
   */
  function contentRangeHeader(index, size, chunkSize) {
    const r = chunkRange(index, size, chunkSize);
    return `bytes ${r.start}-${r.end}/${size}`;
  }

  return {
    chunkCount,
    chunkRange,
    contentRangeHeader
  };
});
