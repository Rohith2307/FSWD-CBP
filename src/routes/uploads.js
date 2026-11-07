const paths = require('../storage/paths');
const uploadManager = require('../services/uploadManager');
const chunkReceiver = require('../services/chunkReceiver');
const finalizer = require('../services/finalizer');
const { sendJson, readJsonBody, readOptionalJsonBody } = require('../utils/http');
const { parseSha256Header } = require('../utils/validation');

/**
 * Registers upload endpoints on the provided router.
 *
 * @param {import('../server').Router} router
 * @param {{ storageRoot: string, config: object, metricsStore?: object }} context
 */
function registerUploadRoutes(router, { storageRoot, config, metricsStore }) {
  // POST /api/uploads - Create a new chunked upload session
  router.register('POST', '/api/uploads', async (req, res) => {
    const body = await readJsonBody(req, config.maxJsonBodyBytes);
    const result = await uploadManager.createUpload(body, storageRoot, config);
    sendJson(res, 201, result);
  });

  // PUT /api/uploads/:id/chunks/:index - Accept and verify one chunk (supports repair)
  router.register('PUT', '/api/uploads/:id/chunks/:index', async (req, res) => {
    const uploadId = paths.assertValidId(req.params.id);
    const index = paths.assertValidIndex(req.params.index);

    let declaredBytes = 0;
    const cl = req.headers['content-length'];
    if (cl && /^\d+$/.test(cl)) {
      declaredBytes = parseInt(cl, 10);
    }

    const startMs = Number(process.hrtime.bigint() / 1000000n);

    try {
      const { chunk, duplicate, repaired } = await chunkReceiver.receiveChunk(req, {
        uploadId,
        index,
        storageRoot,
        config
      });

      const endMs = Number(process.hrtime.bigint() / 1000000n);

      let outcome = 'committed';
      if (duplicate) {
        outcome = repaired ? 'repaired' : 'duplicate';
      } else if (repaired) {
        outcome = 'repaired';
      }

      if (metricsStore) {
        metricsStore.recordChunkAttempt(uploadId, {
          index,
          declaredBytes,
          startMs,
          endMs,
          outcome
        });
      }

      // 200 for idempotent duplicate, 201 for freshly committed or repaired chunk
      sendJson(res, duplicate ? 200 : 201, {
        ...chunk,
        duplicate,
        repaired
      });
    } catch (err) {
      const endMs = Number(process.hrtime.bigint() / 1000000n);

      // Do not record anything when the upload is unknown (404/invalid id)
      if (err.code !== 'UPLOAD_NOT_FOUND' && err.statusCode !== 404) {
        let outcome = 'rejected';
        let code = err.code || null;

        if (err.code === 'CHECKSUM_MISMATCH') {
          outcome = 'checksum_mismatch';
        } else if (err.code === 'CHUNK_CONFLICT') {
          outcome = 'conflict';
        } else if (
          err.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
          err.code === 'ECONNRESET' ||
          err.code === 'ABORT' ||
          req.destroyed
        ) {
          outcome = 'aborted';
        }

        if (metricsStore) {
          metricsStore.recordChunkAttempt(uploadId, {
            index,
            declaredBytes,
            startMs,
            endMs,
            outcome,
            code
          });
        }
      }

      throw err;
    }
  });

  // GET /api/uploads/:id - Inspect upload status and resume map
  router.register('GET', '/api/uploads/:id', async (req, res) => {
    const uploadId = paths.assertValidId(req.params.id);
    const verify = req.query && req.query.verify === 'true';

    const status = await uploadManager.getUploadStatus(uploadId, storageRoot, { verify });
    sendJson(res, 200, status);
  });

  // POST /api/uploads/:id/finalize - Finalize chunked upload and publish media
  router.register('POST', '/api/uploads/:id/finalize', async (req, res) => {
    const uploadId = paths.assertValidId(req.params.id);
    const body = await readOptionalJsonBody(req, config.maxJsonBodyBytes);

    let expectedSha256;
    if (body && body.sha256 !== undefined) {
      expectedSha256 = parseSha256Header(body.sha256);
    }

    try {
      const media = await finalizer.finalizeUpload(uploadId, {
        storageRoot,
        config,
        expectedSha256
      });

      if (metricsStore) {
        metricsStore.recordFinalize(uploadId, {
          assemblyMs: media.stats?.assemblyMs ?? 0,
          verifiedChunks: media.stats?.verifiedChunks ?? 0,
          sha256: media.sha256
        });
      }

      sendJson(res, 200, media);
    } catch (err) {
      if (metricsStore) {
        metricsStore.recordFinalizeFailure(uploadId, err.code || 'UNKNOWN');
      }
      throw err;
    }
  });
}

module.exports = {
  registerUploadRoutes
};
