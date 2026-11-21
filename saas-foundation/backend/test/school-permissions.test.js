import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSchoolPermission, normalizeSchoolPermissions } from '../src/core/school-permissions.js';
import { canDeleteSchoolRole } from '../src/core/school-roles.js';

test('legacy school permissions keep their existing access while becoming granular', () => {
  const permissions = normalizeSchoolPermissions(['participants.manage']);

  assert.equal(hasSchoolPermission(permissions, 'participants.view'), true);
  assert.equal(hasSchoolPermission(permissions, 'participants.edit'), true);
  assert.equal(hasSchoolPermission(permissions, 'participants.delete'), true);
});

test('edit and delete permissions include the view access required by their screens', () => {
  const permissions = normalizeSchoolPermissions([
    'attendance.export',
    'school.users.edit',
    'school.roles.delete',
  ]);

  assert.equal(hasSchoolPermission(permissions, 'attendance.view'), true);
  assert.equal(hasSchoolPermission(permissions, 'school.users.view'), true);
  assert.equal(hasSchoolPermission(permissions, 'school.roles.view'), true);
});

test('only the school admin role is protected from deletion', () => {
  assert.equal(canDeleteSchoolRole('admin-sekolah'), false);
  assert.equal(canDeleteSchoolRole('operator-scanner'), true);
  assert.equal(canDeleteSchoolRole('custom-role'), true);
});
