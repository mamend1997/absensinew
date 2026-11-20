import { fail } from '../http.js';

export function parseLogoDataUrl(value) {
  const match = typeof value === 'string'
    ? /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
    : null;
  if (!match) throw fail(400, 'Logo harus berupa PNG, JPEG, atau WebP.', 'VALIDATION_ERROR');
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > 1024 * 1024 || data.toString('base64') !== match[2]) {
    throw fail(400, 'Ukuran logo maksimal 1 MB atau data gambar tidak valid.', 'VALIDATION_ERROR');
  }
  const signatureMatches = match[1] === 'image/png'
    ? data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : match[1] === 'image/jpeg'
      ? data.length >= 3 && data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' &&
        data.toString('ascii', 8, 12) === 'WEBP';
  if (!signatureMatches) throw fail(400, 'Format isi file tidak sesuai dengan tipe gambarnya.', 'VALIDATION_ERROR');
  return { mimeType: match[1], data };
}
