export function extractSchoolAccessToken(payload, depth = 0) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || depth > 3) return '';

  for (const key of ['access_token', 'accessToken', 'session_token', 'sessionToken', 'token']) {
    const token = payload[key];
    if (typeof token === 'string' && token.trim()) return token.trim();
  }

  for (const key of ['data', 'session', 'auth', 'result']) {
    const token = extractSchoolAccessToken(payload[key], depth + 1);
    if (token) return token;
  }

  return '';
}
