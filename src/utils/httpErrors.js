/**
 * Custom error class for HTTP exceptions with machine-readable codes and status codes.
 */
class HttpError extends Error {
  /**
   * @param {number} statusCode - HTTP status code
   * @param {string} code - Machine-readable error code string
   * @param {string} message - Human-readable error message
   * @param {any} [details=null] - Optional structured details
   * @param {Record<string, string>} [headers={}] - Optional HTTP headers to include in response
   */
  constructor(statusCode, code, message, details = null, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.headers = headers || {};
  }
}

function badRequest(message = 'Bad Request', details = null, headers = {}) {
  return new HttpError(400, 'BAD_REQUEST', message, details, headers);
}

function notFound(message = 'Not Found', details = null, headers = {}) {
  return new HttpError(404, 'NOT_FOUND', message, details, headers);
}

function methodNotAllowed(allowedMethods, message = 'Method Not Allowed', details = null) {
  const allowHeader = Array.isArray(allowedMethods) ? allowedMethods.join(', ') : String(allowedMethods);
  return new HttpError(405, 'METHOD_NOT_ALLOWED', message, details, { Allow: allowHeader });
}

function conflict(message = 'Conflict', details = null, headers = {}) {
  return new HttpError(409, 'CONFLICT', message, details, headers);
}

function payloadTooLarge(message = 'Payload Too Large', details = null, headers = { Connection: 'close' }) {
  return new HttpError(413, 'PAYLOAD_TOO_LARGE', message, details, headers);
}

function unsupportedMediaType(message = 'Unsupported Media Type', details = null, headers = {}) {
  return new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', message, details, headers);
}

function rangeNotSatisfiable(message = 'Range Not Satisfiable', details = null, headers = {}) {
  return new HttpError(416, 'RANGE_NOT_SATISFIABLE', message, details, headers);
}

function unprocessable(message = 'Unprocessable Entity', details = null, headers = {}) {
  return new HttpError(422, 'UNPROCESSABLE_ENTITY', message, details, headers);
}

function internal(message = 'Internal Server Error', code = 'INTERNAL_SERVER_ERROR', details = null, headers = {}) {
  if (typeof code === 'object' && code !== null) {
    details = code;
    code = 'INTERNAL_SERVER_ERROR';
  }
  return new HttpError(500, code, message, details, headers);
}

function insufficientStorage(message = 'Server storage is full', details = null, headers = {}) {
  return new HttpError(507, 'INSUFFICIENT_STORAGE', message, details, headers);
}

module.exports = {
  HttpError,
  badRequest,
  notFound,
  methodNotAllowed,
  conflict,
  payloadTooLarge,
  unsupportedMediaType,
  rangeNotSatisfiable,
  unprocessable,
  internal,
  insufficientStorage
};
