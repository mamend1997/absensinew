export const LEGACY_PERMISSION_EXPANSIONS = Object.freeze({
  'dashboard.read': ['dashboard.view'],
  'attendance.read': ['attendance.view'],
  'attendance.excuse.manage': ['attendance.edit'],
  'participants.read': ['participants.view'],
  'participants.manage': ['participants.view', 'participants.edit', 'participants.delete'],
  'settings.operational.manage': ['settings.operational.view', 'settings.operational.edit'],
  'school.users.manage': ['school.users.view', 'school.users.edit', 'school.users.delete'],
  'school.roles.manage': ['school.roles.view', 'school.roles.edit', 'school.roles.delete'],
});

const VIEW_PERMISSION_DEPENDENCIES = Object.freeze({
  'attendance.export': ['attendance.view'],
  'attendance.edit': ['attendance.view'],
  'participants.edit': ['participants.view'],
  'participants.delete': ['participants.view'],
  'settings.operational.edit': ['settings.operational.view'],
  'school.users.edit': ['school.users.view', 'school.roles.view'],
  'school.users.delete': ['school.users.view'],
  'school.roles.edit': ['school.roles.view'],
  'school.roles.delete': ['school.roles.view'],
});

export const ALLOWED_PERMISSIONS = new Set([
  'dashboard.read', 'dashboard.view',
  'attendance.read', 'attendance.view', 'attendance.export',
  'attendance.excuse.manage', 'attendance.edit',
  'participants.read', 'participants.view', 'participants.manage',
  'participants.edit', 'participants.delete', 'participants.qr.print',
  'settings.operational.manage', 'settings.operational.view', 'settings.operational.edit',
  'scanner.use',
  'school.users.manage', 'school.users.view', 'school.users.edit', 'school.users.delete',
  'school.roles.manage', 'school.roles.view', 'school.roles.edit', 'school.roles.delete',
]);

export function normalizeSchoolPermissions(permissions) {
  const result = new Set(Array.isArray(permissions)
    ? permissions.filter((permission) => typeof permission === 'string')
    : []);
  for (const [legacy, expanded] of Object.entries(LEGACY_PERMISSION_EXPANSIONS)) {
    if (result.has(legacy)) {
      for (const permission of expanded) result.add(permission);
    }
  }
  for (const [permission, dependencies] of Object.entries(VIEW_PERMISSION_DEPENDENCIES)) {
    if (result.has(permission)) {
      for (const dependency of dependencies) result.add(dependency);
    }
  }
  return [...result];
}

export function hasSchoolPermission(permissions, required) {
  if (!Array.isArray(permissions)) return false;
  if (permissions.includes(required)) return true;
  return (LEGACY_PERMISSION_EXPANSIONS[required] ?? [])
    .some((permission) => permissions.includes(permission));
}
