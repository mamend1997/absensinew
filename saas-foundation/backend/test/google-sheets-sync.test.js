import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { validateAppsScriptWebAppUrl } from '../src/core/google-sheets-url.js';

process.env.JWT_SECRET ??= randomBytes(48).toString('base64url');
const { describeAppsScriptResponse } = await import('../src/core/google-sheets-sync.js');

test('Apps Script sync accepts only HTTPS deployment URLs', () => {
  const url = 'https://script.google.com/macros/s/Abc_123/exec';
  assert.equal(validateAppsScriptWebAppUrl(url), url);
});

test('Apps Script sync rejects lookalike hosts and URLs with extra parameters', () => {
  for (const url of [
    'http://script.google.com/macros/s/Abc_123/exec',
    'https://script.google.com.evil.example/macros/s/Abc_123/exec',
    'https://script.google.com/macros/s/Abc_123/exec?x=1',
    'https://example.com/macros/s/Abc_123/exec',
  ]) {
    assert.throws(() => validateAppsScriptWebAppUrl(url), { code: 'VALIDATION_ERROR' });
  }
});

test('Apps Script sync explains when the deployment URL points to a missing file', () => {
  assert.match(
    describeAppsScriptResponse(200, 'text/html', 'Maaf, file yang Anda minta tidak ada.'),
    /URL Web App Apps Script tidak ditemukan/,
  );
  assert.match(
    describeAppsScriptResponse(200, 'text/html', '<html>Sign in</html>'),
    /dapat diakses Anyone/,
  );
});
