const http = require('node:http');
const defaultConfig = require('./config');
const { ensureStorageDirs } = require('./storage/paths');
const { registerUploadRoutes } = require('./routes/uploads');
const { registerMediaRoutes } = require('./routes/media');
const { registerMetricsRoutes } = require('./routes/metrics');
const { createMetricsStore } = require('./services/metricsStore');
const { sendJson, sendError } = require('./utils/http');
const {
  badRequest,
  notFound,
  methodNotAllowed
} = require('./utils/httpErrors');

/**
 * Lightweight HTTP Router supporting parameterized URL patterns and method dispatch.
 */
class Router {
  constructor() {
    /** @type {Array<{ method: string, pattern: string, regex: RegExp, paramNames: string[], handler: Function }>} */
    this.routes = [];
  }

  /**
   * Registers a route handler for an HTTP method and URL pattern.
   * Supports path parameters (e.g., /api/uploads/:id/chunks/:index).
   *
   * @param {string} method - HTTP method (GET, POST, PUT, DELETE, etc.)
   * @param {string} pattern - URL pattern path starting with /
   * @param {Function} handler - Request handler callback (req, res)
   */
  register(method, pattern, handler) {
    if (typeof method !== 'string' || !method) {
      throw new Error('Router method must be a non-empty string');
    }
    if (typeof pattern !== 'string' || !pattern.startsWith('/')) {
      throw new Error(`Router pattern must start with "/": got "${pattern}"`);
    }
    if (typeof handler !== 'function') {
      throw new Error('Router handler must be a function');
    }

    const normalizedMethod = method.toUpperCase();
    const paramNames = [];

    // Transform :paramName tokens into regex capture groups
    const regexPattern = pattern.replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });

    const regex = new RegExp(`^${regexPattern}$`);

    this.routes.push({
      method: normalizedMethod,
      pattern,
      regex,
      paramNames,
      handler
    });
  }

  /**
   * Matches an incoming request by method and pathname.
   *
   * @param {string} method
   * @param {string} pathname
   * @returns {{ route: object|null, params: Record<string, string>, allowedMethods: string[] }}
   */
  match(method, pathname) {
    const normalizedMethod = method.toUpperCase();
    let matchedRoute = null;
    let params = {};
    const allowedMethods = new Set();

    for (const route of this.routes) {
      const execResult = route.regex.exec(pathname);
      if (execResult) {
        allowedMethods.add(route.method);
        if (route.method === 'GET') {
          allowedMethods.add('HEAD');
        }

        const isMethodMatch =
          route.method === normalizedMethod ||
          (normalizedMethod === 'HEAD' && route.method === 'GET');

        if (isMethodMatch && !matchedRoute) {
          matchedRoute = route;
          params = {};
          for (let i = 0; i < route.paramNames.length; i++) {
            params[route.paramNames[i]] = decodeURIComponent(execResult[i + 1]);
          }
        }
      }
    }

    return {
      route: matchedRoute,
      params,
      allowedMethods: Array.from(allowedMethods)
    };
  }
}

/**
 * Creates and configures the HTTP server instance.
 *
 * @param {Partial<import('./config')>} [overrideConfig={}]
 * @returns {{ server: http.Server, router: Router, config: object, start: Function, stop: Function }}
 */
function createServer(overrideConfig = {}) {
  const activeConfig = Object.freeze({
    ...defaultConfig,
    ...overrideConfig
  });

  const router = new Router();
  const metricsStore = createMetricsStore({
    storageRoot: activeConfig.storageRoot,
    config: activeConfig
  });

  // Register GET /health endpoint
  router.register('GET', '/health', (req, res) => {
    sendJson(res, 200, {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      node: process.version,
      timestamp: new Date().toISOString()
    });
  });

  // Register upload routes passing active configuration and storage root down explicitly
  registerUploadRoutes(router, {
    storageRoot: activeConfig.storageRoot,
    config: activeConfig,
    metricsStore
  });

  // Register media routes passing active configuration and storage root down explicitly
  registerMediaRoutes(router, {
    storageRoot: activeConfig.storageRoot,
    config: activeConfig,
    metricsStore,
    onServed: overrideConfig.onServed
  });

  // Register metrics routes
  registerMetricsRoutes(router, {
    metricsStore
  });

  const server = http.createServer(async (req, res) => {
    const startNs = process.hrtime.bigint();
    let parsedUrl = null;
    let logged = false;

    // Structured request logger: method, path, status, and duration in ms.
    // res.on('close') catches aborted connections; res.on('finish') catches normal completions.
    // The `logged` boolean ensures exactly one log line per request. Bodies are never logged.
    const logRequest = (statusStr) => {
      if (logged) return;
      logged = true;
      const elapsedNs = process.hrtime.bigint() - startNs;
      const elapsedMs = (Number(elapsedNs) / 1e6).toFixed(2);
      const logPath = parsedUrl ? parsedUrl.pathname : req.url;
      console.log(`[${new Date().toISOString()}] ${req.method} ${logPath} ${statusStr} ${elapsedMs}ms`);
    };

    res.on('finish', () => {
      logRequest(res.statusCode);
    });

    res.on('close', () => {
      if (!res.writableFinished) {
        logRequest('aborted');
      }
    });

    try {
      // Parse URL safely
      try {
        parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      } catch (urlErr) {
        throw badRequest(`Malformed request URL: ${urlErr.message}`);
      }

      // Check for malformed URI encoding in the pathname
      try {
        decodeURIComponent(parsedUrl.pathname);
      } catch (uriErr) {
        throw badRequest(`Malformed URI encoding in request path: ${uriErr.message}`);
      }

      // Normalize pathname (strip trailing slash except for root)
      const pathname =
        parsedUrl.pathname.length > 1 && parsedUrl.pathname.endsWith('/')
          ? parsedUrl.pathname.slice(0, -1)
          : parsedUrl.pathname;

      // Match route against registered patterns
      // NOTE: Global JSON pre-parsing was removed. Handlers invoke readJsonBody() explicitly when needed.
      const { route, params, allowedMethods } = router.match(req.method, pathname);

      if (!route) {
        if (allowedMethods.length > 0) {
          throw methodNotAllowed(
            allowedMethods,
            `Method ${req.method} not allowed on ${parsedUrl.pathname}`
          );
        }
        throw notFound(`Route ${req.method} ${parsedUrl.pathname} not found`);
      }

      // Expose parsed routing info to the handler
      req.params = params;
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      req.pathname = pathname;

      // Execute route handler within async error boundary
      await route.handler(req, res);
    } catch (err) {
      sendError(res, err);
    }
  });

  // Configure timeouts from configuration
  server.requestTimeout = activeConfig.requestTimeoutMs;
  server.headersTimeout = activeConfig.headersTimeoutMs;
  server.keepAliveTimeout = activeConfig.keepAliveTimeoutMs;

  let listening = false;

  async function start(port = activeConfig.port, host = activeConfig.host) {
    // Ensure runtime storage directories exist before opening network port
    await ensureStorageDirs(activeConfig.storageRoot);

    return new Promise((resolve, reject) => {
      server.listen(port, host, () => {
        listening = true;
        resolve(server);
      });
      server.once('error', reject);
    });
  }

  async function stop() {
    await metricsStore.flushAll();
    return new Promise((resolve) => {
      if (!listening) {
        return resolve();
      }
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
      server.close(() => {
        listening = false;
        resolve();
      });
    });
  }

  return {
    server,
    router,
    config: activeConfig,
    metricsStore,
    start,
    stop
  };
}

// Auto-listen only when run directly from command line
if (require.main === module) {
  const app = createServer();
  const host = defaultConfig.host;
  const port = defaultConfig.port;

  app.start(port, host).then(() => {
    console.log(`Server listening on http://${host}:${port} [storageRoot: ${defaultConfig.storageRoot}]`);
  }).catch((err) => {
    console.error('Fatal: Failed to start server:', err);
    process.exit(1);
  });

  // Graceful shutdown on termination signals
  function handleShutdown(signal) {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);
    const forceTimer = setTimeout(() => {
      console.error('Shutdown timeout exceeded (5s). Forcing process exit.');
      process.exit(1);
    }, 5000);
    forceTimer.unref();

    app.stop().then(() => {
      console.log('Server stopped cleanly.');
      process.exit(0);
    });
  }

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

module.exports = {
  Router,
  createServer
};
