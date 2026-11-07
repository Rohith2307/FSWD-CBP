const { sendJson } = require('../utils/http');
const { notFound } = require('../utils/httpErrors');
const { assertValidId } = require('../storage/paths');

/**
 * Registers metrics and statistics endpoints.
 *
 * Routing map:
 * - GET /api/recommendation/chunk-size -> Process-wide heuristic recommendation
 * - GET /api/stats                     -> Server memory and runtime statistics
 * - GET /api/metrics/:id               -> Per-upload metrics report (server-observed)
 *
 * @param {import('../server').Router} router
 * @param {object} context
 * @param {import('../services/metricsStore')} context.metricsStore
 */
function registerMetricsRoutes(router, { metricsStore }) {
  if (!metricsStore) {
    throw new Error('registerMetricsRoutes requires metricsStore');
  }

  // 1. Global chunk size recommendation endpoint
  router.register('GET', '/api/recommendation/chunk-size', (req, res) => {
    const recommendation = metricsStore.getRecommendation();
    sendJson(res, 200, recommendation);
  });

  // 2. Global server statistics endpoint
  router.register('GET', '/api/stats', (req, res) => {
    const stats = metricsStore.getServerStats();
    sendJson(res, 200, stats);
  });

  // 3. Per-upload metrics report endpoint
  router.register('GET', '/api/metrics/:id', async (req, res) => {
    const uploadId = req.params.id;

    // Validate ID format (throws notFound 404 on invalid format)
    assertValidId(uploadId);

    const report = await metricsStore.getReport(uploadId);
    if (!report) {
      throw notFound(`Metrics for upload session "${uploadId}" not found`);
    }

    sendJson(res, 200, report);
  });
}

module.exports = {
  registerMetricsRoutes
};
