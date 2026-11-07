const paths = require('../storage/paths');
const { listMedia, getMedia } = require('../services/mediaCatalog');
const { serveMedia } = require('../services/rangeStreamer');
const { sendJson } = require('../utils/http');

/**
 * Registers media endpoints on the provided router.
 *
 * @param {import('../server').Router} router
 * @param {{ storageRoot: string, config: object, metricsStore?: object, onServed?: Function }} context
 */
function registerMediaRoutes(router, { storageRoot, config, metricsStore, onServed: customOnServed } = {}) {
  // GET /api/media - List published media items (supports ?limit=)
  router.register('GET', '/api/media', async (req, res) => {
    const limit = req.query ? req.query.limit : undefined;
    const items = await listMedia(storageRoot, { limit });
    sendJson(res, 200, {
      items,
      count: items.length
    });
  });

  // GET | HEAD /api/media/:id - Stream media content with HTTP Range and conditional support
  router.register('GET', '/api/media/:id', async (req, res) => {
    const mediaId = paths.assertValidId(req.params.id);
    const { record, filePath, stat } = await getMedia(mediaId, storageRoot);

    serveMedia(req, res, {
      record,
      filePath,
      size: stat.size,
      onServed: (servedInfo) => {
        if (metricsStore) {
          metricsStore.recordMediaServed(mediaId, servedInfo);
        }
        if (typeof customOnServed === 'function') {
          customOnServed({ ...servedInfo, mediaId });
        }
      }
    });
  });
}

module.exports = {
  registerMediaRoutes
};
