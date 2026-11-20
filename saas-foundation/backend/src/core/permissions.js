export class TenantAuthorizationError extends Error {
  constructor(message = 'Akses ditolak untuk sekolah atau izin ini.') {
    super(message);
    this.name = 'TenantAuthorizationError';
    this.statusCode = 403;
    this.code = 'TENANT_PERMISSION_DENIED';
  }
}

export function hasTenantPermission({ principal, requestedSchoolId, permission }) {
  if (!principal || requestedSchoolId == null || !permission) return false;
  if (String(principal.sekolah_id) !== String(requestedSchoolId)) return false;
  if (String(principal.role_sekolah_id) !== String(requestedSchoolId)) return false;
  return Array.isArray(principal.permissions) && principal.permissions.includes(permission);
}

export function assertTenantPermission(input) {
  if (!hasTenantPermission(input)) {
    throw new TenantAuthorizationError();
  }
}
