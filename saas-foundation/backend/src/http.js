export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function fail(status, message, code) {
  const error = new Error(message);
  error.statusCode = status;
  error.code = code;
  return error;
}

export function requireFields(body, fields) {
  const missing = fields.filter((field) => body?.[field] === undefined ||
    body[field] === null || body[field] === '');
  if (missing.length) throw fail(400, `Field wajib: ${missing.join(', ')}.`, 'VALIDATION_ERROR');
}

export function parseJson(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function isPositiveId(value) {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}
