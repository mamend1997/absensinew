export function canDeleteSchoolRole(roleKey) {
  return typeof roleKey === 'string' && roleKey !== 'admin-sekolah';
}
