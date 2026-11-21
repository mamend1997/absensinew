import { fail } from '../http.js';

export function validateAppsScriptWebAppUrl(value) {
  if (typeof value !== 'string' || value.length > 1000) {
    throw fail(400, 'URL Apps Script wajib diisi.', 'VALIDATION_ERROR');
  }
  let url;
  try { url = new URL(value); } catch { throw fail(400, 'URL Apps Script tidak valid.', 'VALIDATION_ERROR'); }
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' ||
      url.username || url.password || (url.port && url.port !== '443') ||
      !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname) ||
      url.search || url.hash) {
    throw fail(400, 'Gunakan URL deployment Apps Script HTTPS yang berakhir dengan /macros/s/.../exec.', 'VALIDATION_ERROR');
  }
  return url.toString();
}
