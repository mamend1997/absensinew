import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLogoDataUrl } from '../src/core/branding.js';

function dataUrl(mimeType, bytes) {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

test('platform logo accepts supported image signatures', () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const jpeg = Buffer.from([255, 216, 255]);
  const webp = Buffer.from('RIFF0000WEBP');

  assert.equal(parseLogoDataUrl(dataUrl('image/png', png)).mimeType, 'image/png');
  assert.equal(parseLogoDataUrl(dataUrl('image/jpeg', jpeg)).mimeType, 'image/jpeg');
  assert.equal(parseLogoDataUrl(dataUrl('image/webp', webp)).mimeType, 'image/webp');
});

test('platform logo rejects mismatched, malformed, and oversized image data', () => {
  assert.throws(() => parseLogoDataUrl('data:image/png;base64,SGVsbG8='), { statusCode: 400 });
  assert.throws(() => parseLogoDataUrl('data:image/svg+xml;base64,PHN2Zz4='), { statusCode: 400 });
  const oversized = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.alloc(1024 * 1024),
  ]);
  assert.throws(() => parseLogoDataUrl(dataUrl('image/png', oversized)), { statusCode: 400 });
});
