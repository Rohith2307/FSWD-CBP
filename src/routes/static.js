const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream');
const { sendError } = require('../utils/http');
const { notFound } = require('../utils/httpErrors');

/**
 * Static Asset Serving with Fixed Allow-List
 *
 * Architectural & Security Principles:
 *
 * 1. Why the static route uses a fixed allow-list:
 *    A fixed allow-list completely eliminates path traversal, arbitrary file access, directory indexing,
 *    and unintended exposure of internal server code, tests, or storage files. Because the file served
 *    is selected from an immutable internal mapping rather than derived from req.url or decoded file paths,
 *    malicious path segments (e.g. "..", "%2e%2e", null bytes) cannot escape into filesystem lookups.
 *
 * 2. Why the CSP forbids inline code:
 *    Enforcing `script-src 'self'` and `style-src 'self'` without `'unsafe-inline'` prevents Cross-Site
 *    Scripting (XSS) attacks. Any injected `<script>` tag or inline event handler (e.g. onload=, onerror=)
 *    from untrusted filenames or user-controlled metadata is blocked by the browser engine.
 */

const HTML_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const STATIC_ALLOW_LIST = Object.freeze({
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8', isHtml: true },
  '/index.html': { file: 'index.html', contentType: 'text/html; charset=utf-8', isHtml: true },
  '/app.js': { file: 'app.js', contentType: 'text/javascript; charset=utf-8', isHtml: false },
  '/uploader.js': { file: 'uploader.js', contentType: 'text/javascript; charset=utf-8', isHtml: false },
  '/chunkMath.js': { file: 'chunkMath.js', contentType: 'text/javascript; charset=utf-8', isHtml: false },
  '/ledgerView.js': { file: 'ledgerView.js', contentType: 'text/javascript; charset=utf-8', isHtml: false },
  '/styles.css': { file: 'styles.css', contentType: 'text/css; charset=utf-8', isHtml: false },
  '/favicon.ico': { favicon: true }
});

/**
 * Registers static file serving routes on the router.
 *
 * @param {import('../server').Router} router
 * @param {object} options
 * @param {string} options.publicDir - Absolute path to public assets directory
 */
function registerStaticRoutes(router, { publicDir }) {
  if (!publicDir || typeof publicDir !== 'string') {
    throw new Error('registerStaticRoutes requires publicDir');
  }

  for (const [urlPath, item] of Object.entries(STATIC_ALLOW_LIST)) {
    if (item.favicon) {
      router.register('GET', urlPath, (req, res) => {
        if (req.method === 'HEAD') {
          res.writeHead(204, {
            'Content-Type': 'image/x-icon',
            'Content-Length': 0,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-cache'
          });
          return res.end();
        }
        res.writeHead(204, {
          'Content-Type': 'image/x-icon',
          'Content-Length': 0,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-cache'
        });
        res.end();
      });
      continue;
    }

    router.register('GET', urlPath, async (req, res) => {
      const filePath = path.join(publicDir, item.file);

      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw notFound(`Static asset "${item.file}" not found`);
        }
        throw err;
      }

      if (!stat.isFile()) {
        throw notFound(`Static asset "${item.file}" is not a regular file`);
      }

      const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
      const baseHeaders = {
        'Content-Type': item.contentType,
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'ETag': etag,
        'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Resource-Policy': 'same-origin'
      };

      if (item.isHtml) {
        baseHeaders['Content-Security-Policy'] = HTML_CSP;
      }

      // Check conditional 304
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && (ifNoneMatch.trim() === etag || ifNoneMatch.trim() === '*')) {
        res.writeHead(304, baseHeaders);
        return res.end();
      }

      // HEAD request returns headers only (no body stream)
      if (req.method === 'HEAD') {
        res.writeHead(200, baseHeaders);
        return res.end();
      }

      // Stream file with bounded backpressure, waiting for 'open' before writeHead
      const readStream = fs.createReadStream(filePath);

      res.on('close', () => {
        if (!res.writableFinished) {
          readStream.destroy();
        }
      });

      readStream.once('open', () => {
        if (res.destroyed || res.writableEnded) {
          readStream.destroy();
          return;
        }

        res.writeHead(200, baseHeaders);

        pipeline(readStream, res, (err) => {
          if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            sendError(res, err);
          }
        });
      });

      readStream.once('error', (openErr) => {
        if (!res.headersSent) {
          sendError(res, openErr);
        }
      });
    });
  }
}

module.exports = {
  registerStaticRoutes,
  HTML_CSP,
  STATIC_ALLOW_LIST
};
