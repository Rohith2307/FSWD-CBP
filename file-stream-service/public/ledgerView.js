(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FSS = root.FSS || {};
    root.FSS.ledgerView = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Ledger Visualization & Bucketizing Helper
   *
   * Architectural Design Principle:
   *
   * Why bucketing exists:
   * When uploading large media files (e.g., 2 GiB with 1 MiB chunks = 2,048 chunks, or with 64 KiB
   * chunks = 32,768 chunks), creating individual DOM elements for every single chunk causes extreme
   * DOM bloat, high memory overhead, and severe browser reflow/jank.
   *
   * By bucketizing total chunk counts into a fixed, bounded number of visual cells (default 256),
   * DOM complexity remains constant regardless of file size, while high-precedence visual signals
   * (such as active transfers, failures, and repairs) are immediately surfaced to the user.
   */

  /**
   * Bucketizes chunk states into at most maxCells contiguous cells.
   *
   * State precedence for aggregated cells:
   * failed > inflight > repaired > partial (committed-partial) > missing > committed
   * ("committed" only if ALL chunks in the cell are committed; mixed -> "partial")
   *
   * @param {number} totalChunks - Total chunks in file
   * @param {Record<number, string>} stateByIndex - Map from chunk index to state
   * @param {number} [maxCells=256] - Maximum number of cells to generate
   * @returns {Array<{ from: number, to: number, state: string }>}
   */
  function bucketize(totalChunks, stateByIndex = {}, maxCells = 256) {
    if (typeof totalChunks !== 'number' || totalChunks <= 0 || !Number.isSafeInteger(totalChunks)) {
      return [];
    }

    const cellCount = Math.min(totalChunks, Math.max(1, maxCells));

    // When totalChunks <= maxCells, 1-to-1 identity mapping
    if (totalChunks <= cellCount) {
      const result = [];
      for (let i = 0; i < totalChunks; i++) {
        const state = stateByIndex[i] || 'missing';
        result.push({
          from: i,
          to: i,
          state
        });
      }
      return result;
    }

    // Aggregate into cellCount cells
    const cells = [];
    for (let c = 0; c < cellCount; c++) {
      const from = Math.floor((c * totalChunks) / cellCount);
      const to = Math.floor(((c + 1) * totalChunks) / cellCount) - 1;

      let hasFailed = false;
      let hasInflight = false;
      let hasRepaired = false;
      let committedCount = 0;
      let missingCount = 0;

      for (let i = from; i <= to; i++) {
        const s = stateByIndex[i] || 'missing';
        if (s === 'failed') {
          hasFailed = true;
        } else if (s === 'inflight') {
          hasInflight = true;
        } else if (s === 'repaired') {
          hasRepaired = true;
        } else if (s === 'committed') {
          committedCount++;
        } else {
          missingCount++;
        }
      }

      let state;
      if (hasFailed) {
        state = 'failed';
      } else if (hasInflight) {
        state = 'inflight';
      } else if (hasRepaired) {
        state = 'repaired';
      } else if (committedCount === to - from + 1) {
        state = 'committed';
      } else if (committedCount > 0 && missingCount > 0) {
        state = 'partial';
      } else {
        state = 'missing';
      }

      cells.push({ from, to, state });
    }

    return cells;
  }

  /**
   * Formats byte range lists from server status response.
   *
   * @param {object} status - Server status JSON object
   * @returns {{ committed: string[], missing: string[] }}
   */
  function rangesFromStatus(status) {
    if (!status) {
      return { committed: [], missing: [] };
    }

    const formatRanges = (ranges) => {
      if (!Array.isArray(ranges) || ranges.length === 0) return [];
      return ranges.map((r) => `${r.start}-${r.end}`);
    };

    return {
      committed: formatRanges(status.committedRanges),
      missing: formatRanges(status.missingRanges)
    };
  }

  return {
    bucketize,
    rangesFromStatus
  };
});
