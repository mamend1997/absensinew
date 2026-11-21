export function extractSchoolAccessToken(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const token = payload.access_token ?? payload.token;
  return typeof token === 'string' ? token.trim() : '';
}
