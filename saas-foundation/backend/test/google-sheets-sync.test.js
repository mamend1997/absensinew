import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAppsScriptWebAppUrl } from '../src/core/google-sheets-url.js';

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
