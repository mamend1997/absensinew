import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../google-apps-script/Code.gs',
);
const script = await readFile(scriptPath, 'utf8');
const sandbox = {
  Utilities: {
    formatDate(date, timeZone, pattern) {
      if (pattern === 'yyyy-MM-dd') {
        return new Intl.DateTimeFormat('en-CA', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(date);
      }
      return new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).format(date);
    },
  },
};
runInNewContext(
  `${script}\nthis.buildMonthlySummary = buildMonthlySummary;\nthis.readAttendanceCorrections = readAttendanceCorrections;\nthis.readMonthlySummaryState = readMonthlySummaryState;\nthis.buildSummaryEditCorrections = buildSummaryEditCorrections;\nthis.saveMonthlySummaryCorrections = saveMonthlySummaryCorrections;\nthis.monthSheetName = monthSheetName;\nthis.monthKeyFromSheetName = monthKeyFromSheetName;\nthis.getSummarySheet = getSummarySheet;\nthis.groupAttendanceRecordsByMonth = groupAttendanceRecordsByMonth;\nthis.formatDateLabel = formatDateLabel;\nthis.shouldIncludeAfterClear = shouldIncludeAfterClear;\nthis.clearSupersededAttendanceClearCorrections = clearSupersededAttendanceClearCorrections;\nthis.unmergeSummaryHeaders = unmergeSummaryHeaders;\n  this.isValidResetPin = isValidResetPin;\n  this.permissionSheetName = permissionSheetName;\n  this.buildPermissionSummary = buildPermissionSummary;\nthis.permissionEventIdsForTimes = permissionEventIdsForTimes;\n  this.normalizeSummaryCorrectionValue = normalizeSummaryCorrectionValue;
  this.fillMissingScheduledCheckOut = fillMissingScheduledCheckOut;
  this.showCheckoutDifferenceColumns = showCheckoutDifferenceColumns;`,
  sandbox,
);

test('Apps Script builds monthly permission exit and return sheet', () => {
  assert.equal(sandbox.permissionSheetName('2026-11'), 'Izin November 2026');
  const summary = sandbox.buildPermissionSummary([
    {
      participant_id: 'P1',
      participant_name: 'Agung',
      event_type: 'permission_out',
      client_timestamp: '2026-11-01 01:00:00.000',
    },
    {
      participant_id: 'P1',
      participant_name: 'Agung',
      event_type: 'permission_in',
      client_timestamp: '2026-11-01 01:25:00.000',
    },
  ], 'Asia/Jakarta');

  assert.deepEqual(Array.from(summary.topHeaders), [
    'No', 'Nama Peserta', '01-11-2026', '', '', 'Total Menit Keluar', 'Total Kali Izin Keluar',
  ]);
  assert.deepEqual(Array.from(summary.subHeaders), [
    'No', 'Nama Peserta', 'Izin Keluar', 'Masuk Kembali', 'Durasi Keluar',
    'Total Menit Keluar', 'Total Kali Izin Keluar',
  ]);
  assert.equal(summary.rows.length, 1);
  assert.equal(summary.rows[0][1], 'Agung');
  assert.equal(summary.rows[0][2], '08:00:00');
  assert.equal(summary.rows[0][3], '08:25:00');
  assert.equal(summary.rows[0][4], 25);
  assert.equal(summary.rows[0][5], 25);
  assert.equal(summary.rows[0][6], 1);
});

test('Apps Script fills a missing checkout schedule on an existing attendance row', () => {
  const cells = [];
  const sheet = {
    getRange(row, column) {
      return {
        setValue(value) {
          cells.push({ row, column, value });
        },
      };
    },
  };

  assert.equal(
    sandbox.fillMissingScheduledCheckOut(sheet, 7, '', '15:00:00'),
    '15:00:00',
  );
  assert.deepEqual(cells, [{ row: 7, column: 12, value: '15:00:00' }]);
  assert.equal(
    sandbox.fillMissingScheduledCheckOut(sheet, 8, '14:30:00', '15:00:00'),
    '14:30:00',
  );
  assert.equal(
    sandbox.fillMissingScheduledCheckOut(sheet, 9, '', ''),
    '',
  );
  assert.equal(cells.length, 1);
});

test('Apps Script restores daily and monthly checkout difference columns', () => {
  const shownColumns = [];
  const headers = [
    ['No', 'Nama', '23-11-2026', '', '', '', 'Total Terlambat',
      'Total Hadir', 'Total Selisih Menit Keluar'],
    ['', '', 'Masuk', 'Terlambat', 'Keluar', 'Selisih Menit Keluar', '', '', ''],
  ];
  sandbox.showCheckoutDifferenceColumns({
    getLastColumn: () => headers[0].length,
    getLastRow: () => 3,
    getRange() {
      return { getDisplayValues: () => headers };
    },
    showColumns(column) {
      shownColumns.push(column);
    },
  });

  assert.deepEqual(shownColumns, [6, 9]);
});

test('Apps Script summary includes signed checkout differences for regular and permitted checkout', () => {
  const summary = sandbox.buildMonthlySummary([
    {
      participant_id: 'P1',
      participant_name: 'Agung',
      event_type: 'check_out',
      attendance_date: '2026-11-01',
      client_timestamp: '2026-11-01 07:55:00.000',
      scheduled_check_out: '15:00:00',
    },
    {
      participant_id: 'P1',
      participant_name: 'Agung',
      event_type: 'permission_check_out',
      attendance_date: '2026-11-02',
      client_timestamp: '2026-11-02 08:15:00.000',
      scheduled_check_out: '15:00:00',
    },
  ], 'Asia/Jakarta', '2026-11');

  assert.equal(summary.rows[0][5], -5);
  assert.equal(summary.rows[0][9], 15);
  assert.equal(summary.rows[0][12], 10);
});

test('Apps Script allows daily and monthly checkout differences to be cleared', () => {
  const rows = [
    [
      'No', 'Nama', '23-11-2026', '', '', '', 'Total Terlambat',
      'Total Hadir', 'Total Selisih Menit Keluar', 'participant_id',
      '__attendance_override__2026-11-23__check_out_diff',
      '__attendance_override__total_checkout_diff',
      '__attendance_baseline__2026-11-23__check_out_diff',
      '__attendance_baseline__total_checkout_diff',
    ],
    [
      'No', 'Nama', 'Masuk', 'Terlambat', 'Keluar', 'Selisih Menit Keluar',
      'Total Terlambat', 'Total Hadir', 'Total Selisih Menit Keluar',
      '', '', '', '', '',
    ],
    [1, 'Agung', '', '', '15:05:00', 5, 0, 0, 5, '17', '', '', 5, 5],
  ];
  const sheet = {
    getLastRow: () => rows.length,
    getLastColumn: () => rows[0].length,
    getRange(row, column, rowCount = 1, columnCount = 1) {
      return {
        getDisplayValues: () => rows.slice(row - 1, row - 1 + rowCount)
          .map((values) => values.slice(column - 1, column - 1 + columnCount)
            .map((value) => String(value ?? ''))),
        setValue(value) {
          rows[row - 1][column - 1] = value;
        },
      };
    },
  };
  const corrections = [
    {
      participantId: '17',
      date: '2026-11-23',
      eventType: 'check_out_diff',
      action: 'clear',
      value: '',
    },
    {
      participantId: '17',
      date: '',
      eventType: 'total_checkout_diff',
      action: 'clear',
      value: '',
    },
  ];

  sandbox.saveMonthlySummaryCorrections(sheet, corrections);
  const state = sandbox.readMonthlySummaryState(sheet, 'Asia/Jakarta');
  const summary = sandbox.buildMonthlySummary([{
    participant_id: '17',
    participant_code: 'P17',
    participant_name: 'Agung',
    attendance_date: '2026-11-23',
    event_type: 'check_out',
    client_timestamp: '2026-11-23 08:05:00.000',
    scheduled_check_out: '15:00:00',
  }], 'Asia/Jakarta', '2026-11', state.order, state.corrections);

  assert.equal(rows[2][5], '');
  assert.equal(rows[2][8], '');
  assert.equal(rows[2][10], 'clear');
  assert.equal(rows[2][11], 'clear');
  assert.equal(summary.rows[0][5], '');
  assert.equal(summary.rows[0][8], '');
});

test('Apps Script permission pairing stays within the same attendance date', () => {
  const summary = sandbox.buildPermissionSummary([
    {
      participant_id: 'P1',
      participant_name: 'Agung',
      attendance_date: '2026-11-01',
      event_type: 'permission_out',
      client_timestamp: '2026-11-01 01:00:00.000',
    },
    {
      participant_id: 'P1',
      participant_name: 'Agung',
      attendance_date: '2026-11-02',
      event_type: 'permission_in',
      client_timestamp: '2026-11-02 01:25:00.000',
    },
  ], 'Asia/Jakarta');

  assert.equal(summary.rows.length, 1);
  assert.equal(summary.rows[0][2], '08:00:00');
  assert.equal(summary.rows[0][3], '');
  assert.equal(summary.rows[0][4], '');
});

test('Apps Script sums permission seconds before rounding to tenths of a minute', () => {
  const summary = sandbox.buildPermissionSummary([
    {
      participant_id: 'P1',
      participant_name: 'Agung',
      attendance_date: '2026-11-01',
      event_type: 'permission_out',
      client_timestamp: '2026-11-01 01:00:00.000',
    },
    {
      participant_id: 'P1',
      participant_name: 'Agung',
      attendance_date: '2026-11-01',
      event_type: 'permission_in',
      client_timestamp: '2026-11-01 01:00:30.000',
    },
    {
      participant_id: 'P1',
      participant_name: 'Agung',
      attendance_date: '2026-11-01',
      event_type: 'permission_out',
      client_timestamp: '2026-11-01 03:00:00.000',
    },
    {
      participant_id: 'P1',
      participant_name: 'Agung',
      attendance_date: '2026-11-01',
      event_type: 'permission_in',
      client_timestamp: '2026-11-01 03:01:42.000',
    },
  ], 'Asia/Jakarta');

  assert.equal(summary.rows[0][4], 2.2);
  assert.equal(summary.rows[0][5], 2.2);
  assert.equal(summary.rows[0][6], 2);
});

test('Apps Script permission sheet accepts stable participant code when numeric ID is missing', () => {
  const summary = sandbox.buildPermissionSummary([
    {
      participant_code: 'P-CLASS-01',
      participant_name: 'Siti',
      attendance_date: '2026-11-02',
      event_type: 'permission_out',
      client_timestamp: '2026-11-02 02:00:00.000',
    },
  ], 'Asia/Jakarta');

  assert.equal(summary.rows.length, 1);
  assert.equal(summary.rows[0][1], 'Siti');
  assert.equal(summary.rows[0][2], '09:00:00');
});

test('Apps Script keeps deleted permission events hidden after later scans', () => {
  const summary = sandbox.buildPermissionSummary([
    {
      id_unik: 'deleted-scan-1',
      participant_id: '17',
      participant_name: 'Maman',
      attendance_date: '2026-11-22',
      event_type: 'permission_out',
      client_timestamp: '2026-11-22 07:57:58.000',
    },
    {
      id_unik: 'deleted-scan-2',
      participant_id: '17',
      participant_name: 'Maman',
      attendance_date: '2026-11-22',
      event_type: 'permission_out',
      client_timestamp: '2026-11-22 08:15:55.000',
    },
    {
      id_unik: 'new-scan',
      participant_id: '17',
      participant_name: 'Maman',
      attendance_date: '2026-11-22',
      event_type: 'permission_out',
      client_timestamp: '2026-11-22 08:29:22.000',
    },
  ], 'Asia/Jakarta', new Set(['deleted-scan-1', 'deleted-scan-2']));

  assert.equal(summary.rows.length, 1);
  assert.equal(summary.rows[0][2], '15:29:22');
  assert.deepEqual(Array.from(summary.participantIds), ['17']);
});

test('Apps Script maps repeated permission times to distinct scan IDs', () => {
  const records = [
    { id_unik: 'scan-a', client_timestamp: '2026-11-22 07:57:58.000' },
    { id_unik: 'scan-b', client_timestamp: '2026-11-22 07:57:58.000' },
  ];

  assert.deepEqual(
    Array.from(sandbox.permissionEventIdsForTimes(records, ['14:57:58'], 'Asia/Jakarta')),
    ['scan-a'],
  );
  assert.equal(
    sandbox.permissionEventIdsForTimes(records, ['14:57:58', '15:00:00'], 'Asia/Jakarta'),
    null,
  );
});

test('Apps Script groups attendance by participant across dynamic date columns', () => {
  const { dates, rows } = sandbox.buildMonthlySummary([
    {
      participant_code: 'P1',
      participant_name: 'Agung',
      attendance_date: '2026-11-01',
      event_type: 'check_out',
      client_timestamp: '2026-11-01 08:11:17.000',
      late_minutes: 0,
    },
    {
      participant_code: 'P1',
      participant_name: 'Agung',
      attendance_date: '2026-11-01',
      event_type: 'check_out',
      client_timestamp: '2026-11-01 08:15:00.000',
      late_minutes: 0,
    },
    {
      participant_code: 'P1',
      participant_name: 'Agung',
      attendance_date: '2026-11-01',
      event_type: 'check_in',
      client_timestamp: '2026-11-01 00:54:09.000',
      late_minutes: 5,
    },
    {
      participant_code: 'P1',
      participant_name: 'Agung',
      attendance_date: '2026-11-02',
      event_type: 'check_in',
      client_timestamp: '2026-11-02 00:49:58.000',
      late_minutes: 0,
    },
    {
      participant_code: 'P2',
      participant_name: 'Budi',
      attendance_date: '2026-11-02',
      event_type: 'check_in',
      client_timestamp: '2026-11-02 00:50:00.000',
      late_minutes: 2,
    },
    {
      participant_code: 'P1',
      participant_name: 'Agung',
      attendance_date: '2026-10-31',
      event_type: 'check_in',
      client_timestamp: '2026-10-31 00:00:00.000',
      late_minutes: 20,
    },
  ], 'Asia/Jakarta', '2026-11');

  assert.deepEqual(Array.from(dates), ['2026-11-01', '2026-11-02']);
  assert.equal(sandbox.formatDateLabel(dates[0]), '01-11-2026');
  assert.deepEqual(Array.from(rows, (row) => Array.from(row)), [
    [1, 'Agung', '07:54:09', 5, '15:15:00', '', '07:49:58', 0, '', '', 5, 2, ''],
    [2, 'Budi', '', '', '', '', '07:50:00', 2, '', '', 2, 1, ''],
  ]);
});

test('Apps Script merges code changes by stable participant ID', () => {
  const { rows } = sandbox.buildMonthlySummary([
    {
      participant_id: '17',
      participant_code: 'OLD-CODE',
      participant_name: 'Siti',
      classroom_name: 'Kelas 1',
      attendance_date: '2026-11-01',
      event_type: 'check_in',
      client_timestamp: '2026-11-01 00:54:09.000',
      late_minutes: 5,
    },
    {
      participant_id: '17',
      participant_code: 'NEW-CODE',
      participant_name: 'Siti',
      classroom_name: 'Kelas 1',
      attendance_date: '2026-11-01',
      event_type: 'check_out',
      client_timestamp: '2026-11-01 08:11:17.000',
      late_minutes: 0,
    },
    {
      participant_id: '18',
      participant_code: 'OTHER-CODE',
      participant_name: 'Siti',
      classroom_name: 'Kelas 1',
      attendance_date: '2026-11-01',
      event_type: 'check_in',
      client_timestamp: '2026-11-01 01:00:00.000',
      late_minutes: 0,
    },
  ], 'Asia/Jakarta', '2026-11');

  assert.equal(rows.length, 2);
  assert.deepEqual(Array.from(rows, (row) => Array.from(row)), [
    [1, 'Siti', '07:54:09', 5, '15:11:17', '', 5, 1, ''],
    [2, 'Siti', '08:00:00', 0, '', '', 0, 1, ''],
  ]);
});

test('Apps Script retains fractional lateness in daily and monthly totals', () => {
  const { rows } = sandbox.buildMonthlySummary([
    {
      participant_id: '17',
      participant_code: 'P17',
      participant_name: 'Zahra',
      attendance_date: '2026-11-01',
      event_type: 'check_in',
      client_timestamp: '2026-11-01 01:05:30.000',
      late_minutes: 0.5,
    },
    {
      participant_id: '17',
      participant_code: 'P17',
      participant_name: 'Zahra',
      attendance_date: '2026-11-02',
      event_type: 'check_in',
      client_timestamp: '2026-11-02 01:06:42.000',
      late_minutes: 1.7,
    },
  ], 'Asia/Jakarta', '2026-11');

  assert.equal(rows[0][3], 0.5);
  assert.equal(rows[0][7], 1.7);
  assert.equal(rows[0][10], 2.2);
});

test('Apps Script accepts lateness corrections with one decimal place', () => {
  assert.equal(
    sandbox.normalizeSummaryCorrectionValue('1.7', 'late_minutes', 'Asia/Jakarta', 3),
    '1.7',
  );
  assert.throws(
    () => sandbox.normalizeSummaryCorrectionValue('1.75', 'late_minutes', 'Asia/Jakarta', 3),
    /maksimal satu angka desimal/,
  );
});

test('Apps Script follows manual participant order and keeps time corrections', () => {
  const { rows } = sandbox.buildMonthlySummary([
    {
      participant_id: '18',
      participant_code: 'P18',
      participant_name: 'Ayu',
      attendance_date: '2026-11-01',
      event_type: 'check_in',
      client_timestamp: '2026-11-01 01:00:00.000',
      late_minutes: 0,
    },
    {
      participant_id: '17',
      participant_code: 'P17',
      participant_name: 'Zahra',
      attendance_date: '2026-11-01',
      event_type: 'check_in',
      client_timestamp: '2026-11-01 00:54:09.000',
      late_minutes: 5,
    },
  ], 'Asia/Jakarta', '2026-11', new Map([
    ['17', 0],
    ['18', 1],
  ]), new Map([
    ['17-check-in', {
      participantId: '17',
      date: '2026-11-01',
      eventType: 'check_in',
      action: 'clear',
      value: '',
    }],
    ['18-check-in', {
      participantId: '18',
      date: '2026-11-01',
      eventType: 'check_in',
      action: 'set',
      value: '08:15:00',
    }],
  ]));

  assert.deepEqual(Array.from(rows, (row) => Array.from(row)), [
    [1, 'Zahra', '', 5, '', '', 5, 1, ''],
    [2, 'Ayu', '08:15:00', 0, '', '', 0, 1, ''],
  ]);
});

test('Apps Script supports daily lateness and total lateness corrections', () => {
  const date = '2026-11-21';
  const summary = sandbox.buildMonthlySummary([
    {
      participant_id: '17',
      participant_code: 'P17',
      participant_name: 'Zahra',
      attendance_date: date,
      event_type: 'check_in',
      client_timestamp: '2026-11-21 00:40:00.000',
      late_minutes: 5,
    },
    {
      participant_id: '17',
      participant_code: 'P17',
      participant_name: 'Zahra',
      attendance_date: '2026-11-22',
      event_type: 'check_in',
      client_timestamp: '2026-11-22 00:45:00.000',
      late_minutes: 3,
    },
  ], 'Asia/Jakarta', '2026-11', new Map(), new Map([
    ['17\u00002026-11-21\u0000late_minutes', {
      participantId: '17',
      date,
      eventType: 'late_minutes',
      action: 'set',
      value: '12',
    }],
    ['17\u0000\u0000total_late_minutes', {
      participantId: '17',
      date: '',
      eventType: 'total_late_minutes',
      action: 'set',
      value: '25',
    }],
  ]));

  assert.deepEqual(Array.from(summary.rows[0]), [
    1, 'Zahra',  '07:40:00', 12, '', '', '07:45:00', 3, '', '', 25, 2, '',
  ]);
  assert.deepEqual(Array.from(summary.baselineRows[0]), [
    '07:40:00', 5, '', '', '07:45:00', 3, '', '',
  ]);
  assert.deepEqual(Array.from(summary.baselineTotalRows[0]), [15, 2, '']);

  const dateColumns = new Map([[3, date]]);
  const editedLateMinutes = sandbox.buildSummaryEditCorrections(
    [[9]],
    3,
    4,
    3,
    ['17'],
    dateColumns,
    'Asia/Jakarta',
    new Map([['17\u00002026-11-21\u0000late_minutes', '5']]),
  );
  assert.deepEqual(
    {
      eventType: editedLateMinutes.corrections[0].eventType,
      action: editedLateMinutes.corrections[0].action,
      value: editedLateMinutes.corrections[0].value,
    },
    { eventType: 'late_minutes', action: 'set', value: '9' },
  );

  const editedTotal = sandbox.buildSummaryEditCorrections(
    [[20]],
    3,
    7,
    3,
    ['17'],
    dateColumns,
    'Asia/Jakarta',
    new Map([['17\u0000\u0000total_late_minutes', '15']]),
  );
  assert.deepEqual(
    {
      eventType: editedTotal.corrections[0].eventType,
      action: editedTotal.corrections[0].action,
      value: editedTotal.corrections[0].value,
    },
    { eventType: 'total_late_minutes', action: 'set', value: '20' },
  );
  const fractionalCorrection = sandbox.buildSummaryEditCorrections(
    [[1.5]],
    3,
    4,
    3,
    ['17'],
    dateColumns,
    'Asia/Jakarta',
  );
  assert.equal(fractionalCorrection.corrections[0].value, '1.5');
  assert.throws(() => sandbox.buildSummaryEditCorrections(
    [[1.55]],
    3,
    4,
    3,
    ['17'],
    dateColumns,
    'Asia/Jakarta',
  ), /maksimal satu angka desimal/);
});

test('Apps Script supports correcting and clearing total attendance', () => {
  const rows = [
    [
      'No', 'Nama', '21-11-2026', '', '', '', 'Total Terlambat', 'Total Hadir',
      'participant_id',
      '__attendance_override__total_attendance',
      '__attendance_baseline__total_attendance',
    ],
    ['No', 'Nama', 'Masuk', 'Terlambat', 'Keluar', 'Selisih Menit Keluar',
      'Total Terlambat', 'Total Hadir', '', '', ''],
    [1, 'Zahra', '07:40:00', 5, '', '', 5, 1, '17', '', 1],
  ];
  const sheet = {
    getLastRow: () => rows.length,
    getLastColumn: () => rows[0].length,
    getRange(row, column, rowCount = 1, columnCount = 1) {
      return {
        getDisplayValues: () => rows.slice(row - 1, row - 1 + rowCount)
          .map((values) => values.slice(column - 1, column - 1 + columnCount)
            .map((value) => String(value ?? ''))),
        setValue(value) {
          rows[row - 1][column - 1] = value;
        },
      };
    },
  };
  const correctionKey = '17\u0000\u0000total_attendance';
  const dateColumns = new Map([[3, '2026-11-21']]);
  const baselineValues = new Map([[correctionKey, '1']]);
  const editedTotal = sandbox.buildSummaryEditCorrections(
    [[4]],
    3,
    8,
    3,
    ['17'],
    dateColumns,
    'Asia/Jakarta',
    baselineValues,
  ).corrections[0];
  assert.deepEqual(
    { eventType: editedTotal.eventType, action: editedTotal.action, value: editedTotal.value },
    { eventType: 'total_attendance', action: 'set', value: '4' },
  );
  assert.throws(() => sandbox.buildSummaryEditCorrections(
    [[1.5]],
    3,
    8,
    3,
    ['17'],
    dateColumns,
    'Asia/Jakarta',
    baselineValues,
  ), /Total hadir.*bilangan bulat/);

  sandbox.saveMonthlySummaryCorrections(sheet, [editedTotal]);
  let state = sandbox.readMonthlySummaryState(sheet, 'Asia/Jakarta');
  let summary = sandbox.buildMonthlySummary([{
    participant_id: '17',
    participant_code: 'P17',
    participant_name: 'Zahra',
    attendance_date: '2026-11-21',
    event_type: 'check_in',
    client_timestamp: '2026-11-21 00:40:00.000',
    late_minutes: 5,
  }], 'Asia/Jakarta', '2026-11', state.order, state.corrections);
  assert.equal(rows[2][7], 4);
  assert.equal(summary.rows[0][7], 4);

  const clearedTotal = sandbox.buildSummaryEditCorrections(
    [['']],
    3,
    8,
    3,
    ['17'],
    dateColumns,
    'Asia/Jakarta',
    baselineValues,
    new Map([[correctionKey, '4']]),
  ).corrections[0];
  assert.equal(clearedTotal.action, 'clear');
  sandbox.saveMonthlySummaryCorrections(sheet, [clearedTotal]);
  state = sandbox.readMonthlySummaryState(sheet, 'Asia/Jakarta');
  summary = sandbox.buildMonthlySummary([{
    participant_id: '17',
    participant_code: 'P17',
    participant_name: 'Zahra',
    attendance_date: '2026-11-21',
    event_type: 'check_in',
    client_timestamp: '2026-11-21 00:40:00.000',
    late_minutes: 5,
  }], 'Asia/Jakarta', '2026-11', state.order, state.corrections);
  assert.equal(rows[2][7], '');
  assert.equal(summary.rows[0][7], '');
});

test('Apps Script reads saved lateness correction metadata', () => {
  const rows = [
    [
      'No',
      'Nama',
      '21-11-2026',
      '',
      '',
      '',
      'Total Terlambat',
      'Total Hadir',
      'participant_id',
      '__attendance_override__2026-11-21__late_minutes',
      '__attendance_override__total_late_minutes',
      '__attendance_baseline__2026-11-21__late_minutes',
      '__attendance_baseline__total_late_minutes',
    ],
    ['', '', 'Masuk', 'Terlambat', 'Keluar', 'Selisih Menit Keluar', '', '', '', '', '', '', ''],
    [1, 'Zahra', '07:40:00', 12, '', '', 25, 1, '17', '12', '25', '5', '5'],
  ];
  const sheet = {
    getLastRow: () => rows.length,
    getLastColumn: () => rows[0].length,
    getRange(row, column, rowCount = 1, columnCount = 1) {
      return {
        getDisplayValues: () => rows.slice(row - 1, row - 1 + rowCount)
          .map((values) => values.slice(column - 1, column - 1 + columnCount)
            .map((value) => String(value ?? ''))),
      };
    },
  };
  const state = sandbox.readMonthlySummaryState(sheet, 'Asia/Jakarta');

  assert.equal(
    state.corrections.get('17\u00002026-11-21\u0000late_minutes').value,
    '12',
  );
  assert.equal(
    state.corrections.get('17\u0000\u0000total_late_minutes').value,
    '25',
  );
  const summary = sandbox.buildMonthlySummary([{
    participant_id: '17',
    participant_code: 'P17',
    participant_name: 'Zahra',
    attendance_date: '2026-11-21',
    event_type: 'check_in',
    client_timestamp: '2026-11-21 00:40:00.000',
    late_minutes: 5,
  }], 'Asia/Jakarta', '2026-11', state.order, state.corrections);
  assert.equal(summary.rows[0][3], 12);
  assert.equal(summary.rows[0][6], 25);
});

test('Apps Script saves daily and total lateness edits to their metadata cells', () => {
  const rows = [
    [
      'No', 'Nama', '21-11-2026', '', '', 'Total Terlambat', 'Total Hadir',
      'participant_id',
      '__attendance_override__2026-11-21__check_in',
      '__attendance_override__2026-11-21__late_minutes',
      '__attendance_override__2026-11-21__check_out',
      '__attendance_override__total_late_minutes',
      '__attendance_baseline__2026-11-21__check_in',
      '__attendance_baseline__2026-11-21__late_minutes',
      '__attendance_baseline__2026-11-21__check_out',
      '__attendance_baseline__total_late_minutes',
    ],
    ['No', 'Nama', 'Masuk', 'Terlambat', 'Keluar', 'Total Terlambat', 'Total Hadir',
      'participant_id', '', '', '', '', '', '', '', ''],
    [1, 'Zahra', '07:40:00', 5, '', 5, 1, '17', '', '', '', '', '07:40:00', 5, '', 5],
  ];
  const sheet = {
    getLastRow: () => rows.length,
    getLastColumn: () => rows[0].length,
    getRange(row, column, rowCount = 1, columnCount = 1) {
      return {
        getDisplayValues: () => rows.slice(row - 1, row - 1 + rowCount)
          .map((values) => values.slice(column - 1, column - 1 + columnCount)
            .map((value) => String(value ?? ''))),
        setValue(value) {
          rows[row - 1][column - 1] = value;
        },
      };
    },
  };
  sandbox.saveMonthlySummaryCorrections(sheet, [
    {
      participantId: '17',
      date: '2026-11-21',
      eventType: 'late_minutes',
      action: 'set',
      value: '9',
    },
    {
      participantId: '17',
      date: '',
      eventType: 'total_late_minutes',
      action: 'set',
      value: '20',
    },
  ]);
  const state = sandbox.readMonthlySummaryState(sheet, 'Asia/Jakarta');

  assert.equal(rows[2][3], 9);
  assert.equal(rows[2][5], 20);
  assert.equal(rows[2][9], '9');
  assert.equal(rows[2][11], '20');
  assert.equal(state.corrections.get('17\u00002026-11-21\u0000late_minutes').value, '9');
  assert.equal(state.corrections.get('17\u0000\u0000total_late_minutes').value, '20');
});

test('Apps Script parses set and clear attendance correction rows', () => {
  const rows = [
    ['17', 'Zahra', '2026-11-01', 'check_in', 'set', '08:15'],
    ['18', 'Ayu', '2026-11-01', 'check_out', 'clear', ''],
  ];
  const corrections = sandbox.readAttendanceCorrections({
    getLastRow: () => rows.length + 1,
    getRange: () => ({ getValues: () => rows }),
  }, 'Asia/Jakarta');

  assert.equal(corrections.get('17\u00002026-11-01\u0000check_in').value, '08:15:00');
  assert.equal(corrections.get('18\u00002026-11-01\u0000check_out').action, 'clear');
  assert.throws(() => sandbox.readAttendanceCorrections({
    getLastRow: () => 2,
    getRange: () => ({ getValues: () => [
      ['17', 'Zahra', '2026-11-01', 'check_in', 'set', '25:00'],
    ] }),
  }, 'Asia/Jakarta'), /bukan waktu yang valid/);
});

test('Apps Script captures direct edits and deletions from the summary', () => {
  const dateColumns = new Map([[3, '2026-11-21']]);
  const deletedTimes = sandbox.buildSummaryEditCorrections(
    [['', '', '']],
    3,
    3,
    3,
    ['17'],
    dateColumns,
    'Asia/Jakarta',
  );
  assert.deepEqual(Array.from(deletedTimes.corrections, (correction) => ({
    participantId: correction.participantId,
    date: correction.date,
    eventType: correction.eventType,
    action: correction.action,
  })), [
    { participantId: '17', date: '2026-11-21', eventType: 'check_in', action: 'clear' },
    { participantId: '17', date: '2026-11-21', eventType: 'late_minutes', action: 'clear' },
    { participantId: '17', date: '2026-11-21', eventType: 'check_out', action: 'clear' },
  ]);

  const correctedTime = sandbox.buildSummaryEditCorrections(
    [['08:15:00']],
    3,
    3,
    3,
    ['17'],
    dateColumns,
    'Asia/Jakarta',
  );
  assert.equal(correctedTime.corrections[0].action, 'set');
  assert.equal(correctedTime.corrections[0].value, '08:15:00');

  const unchangedTime = sandbox.buildSummaryEditCorrections(
    [['08:15:00']],
    3,
    3,
    3,
    ['17'],
    dateColumns,
    'Asia/Jakarta',
    new Map([['17\u00002026-11-21\u0000check_in', '08:15:00']]),
  );
  assert.equal(unchangedTime.corrections[0].action, 'inherit');

  const deletedOverride = sandbox.buildSummaryEditCorrections(
    [['']],
    3,
    3,
    3,
    ['17'],
    dateColumns,
    'Asia/Jakarta',
    new Map([['17\u00002026-11-21\u0000check_in', '']]),
    new Map([['17\u00002026-11-21\u0000check_in', '08:15:00']]),
  );
  assert.equal(deletedOverride.corrections[0].action, 'clear');
});

test('Apps Script creates a separate sheet name for each Indonesian month', () => {
  assert.equal(sandbox.monthSheetName('2026-11'), 'November 2026');
  assert.equal(sandbox.monthSheetName('2026-12'), 'Desember 2026');
  assert.equal(sandbox.monthKeyFromSheetName('November 2026'), '2026-11');
  assert.equal(sandbox.monthKeyFromSheetName('Rekap Bulanan'), '');

  const sheets = new Map();
  const spreadsheet = {
    getSpreadsheetTimeZone: () => 'Asia/Jakarta',
    getSheetByName: (name) => sheets.get(name) || null,
    insertSheet(name) {
      const sheet = {
        isSheetHidden: () => false,
        showSheet() {},
      };
      sheets.set(name, sheet);
      return sheet;
    },
  };
  const november = sandbox.getSummarySheet(spreadsheet, '2020-11');
  const december = sandbox.getSummarySheet(spreadsheet, '2020-12');
  assert.notEqual(november, december);
  assert.equal(sandbox.getSummarySheet(spreadsheet, '2020-11'), november);

  const grouped = sandbox.groupAttendanceRecordsByMonth([
    { attendance_date: '2026-11-30' },
    { attendance_date: '2026-12-01' },
  ], 'Asia/Jakarta');
  assert.deepEqual(Array.from(grouped.keys()), ['2026-11', '2026-12']);
});

test('Apps Script keeps direct time deletions and row order in monthly sheet metadata', () => {
  const rows = [
    [
      'No',
      'Nama',
      '21-11-2026',
      '',
      '',
      'Total Terlambat',
      'Total Hadir',
      'participant_id',
      '__attendance_override__2026-11-21__check_in',
      '__attendance_override__2026-11-21__check_out',
      '__attendance_baseline__2026-11-21__check_in',
      '__attendance_baseline__2026-11-21__check_out',
    ],
    ['', '', 'Masuk', 'Terlambat', 'Keluar', '', '', '', '', '', '', ''],
    [1, 'Ayu', '20:48:54', 0, '', 0, 1, '18', '', '', '20:48:54', ''],
    [2, 'Zahra', '20:40:00', 0, '', 0, 1, '17', '', '', '20:40:00', ''],
  ];
  const sheet = {
    getLastRow: () => rows.length,
    getLastColumn: () => rows[0].length,
    getRange(row, column, rowCount, columnCount) {
      const height = rowCount || 1;
      const width = columnCount || 1;
      return {
        getValues: () => rows.slice(row - 1, row - 1 + height)
          .map((values) => values.slice(column - 1, column - 1 + width)),
        getDisplayValues: () => rows.slice(row - 1, row - 1 + height)
          .map((values) => values.slice(column - 1, column - 1 + width)
            .map((value) => String(value ?? ''))),
        setValue(value) {
          rows[row - 1][column - 1] = value;
        },
      };
    },
  };
  const edit = sandbox.buildSummaryEditCorrections(
    [['']],
    4,
    3,
    4,
    ['17'],
    new Map([[3, '2026-11-21']]),
    'Asia/Jakarta',
  );
  sandbox.saveMonthlySummaryCorrections(sheet, edit.corrections);
  const state = sandbox.readMonthlySummaryState(sheet, 'Asia/Jakarta');
  const summary = sandbox.buildMonthlySummary([
    {
      participant_id: '17',
      participant_code: 'P17',
      participant_name: 'Zahra',
      attendance_date: '2026-11-21',
      event_type: 'check_in',
      client_timestamp: '2026-11-21 13:40:00.000',
      late_minutes: 0,
    },
    {
      participant_id: '18',
      participant_code: 'P18',
      participant_name: 'Ayu',
      attendance_date: '2026-11-21',
      event_type: 'check_in',
      client_timestamp: '2026-11-21 13:48:54.000',
      late_minutes: 0,
    },
  ], 'Asia/Jakarta', '2026-11', state.order, state.corrections);

  assert.equal(rows[3][2], '');
  assert.equal(rows[3][8], 'clear');
  assert.deepEqual(Array.from(summary.rows, (row) => Array.from(row)), [
    [1, 'Ayu', '20:48:54', 0, '', '', 0, 1, ''],
    [2, 'Zahra', '', 0, '', '', 0, 1, ''],
  ]);
  assert.deepEqual(Array.from(summary.baselineRows, (row) => Array.from(row)), [
    ['20:48:54', 0, '', ''],
    ['20:40:00', 0, '', ''],
  ]);
});

test('Apps Script clear cutoff ignores old backfill but accepts new attendance', () => {
  const cutoff = Date.parse('2026-11-21T13:00:00.000Z');
  assert.equal(sandbox.shouldIncludeAfterClear({
    client_timestamp: '2026-11-21 12:59:59.000',
  }, cutoff), false);
  assert.equal(sandbox.shouldIncludeAfterClear({
    client_timestamp: '2026-11-21 13:00:01.000',
  }, cutoff), true);
  assert.equal(sandbox.shouldIncludeAfterClear({
    client_timestamp: '2026-11-21 12:00:00.000',
  }, 0), true);
  assert.equal(sandbox.shouldIncludeAfterClear({
    client_timestamp: '2026-11-21 12:59:59.000',
    server_received_at_ms: cutoff + 1000,
  }, cutoff), true);
});

test('Apps Script clears old manual deletions when a new matching scan is inserted', () => {
  const corrections = new Map([
    ['18\u00002026-11-22\u0000check_in', { action: 'clear' }],
    ['18\u00002026-11-22\u0000late_minutes', { action: 'clear' }],
    ['18\u00002026-11-22\u0000check_out', { action: 'clear' }],
    ['19\u00002026-11-22\u0000check_in', { action: 'clear' }],
    ['18\u00002026-11-21\u0000check_in', { action: 'clear' }],
    ['20\u00002026-11-22\u0000late_minutes', { action: 'set', value: '5' }],
  ]);
  sandbox.clearSupersededAttendanceClearCorrections(corrections, [{
    participantId: '18',
    date: '2026-11-22',
    eventType: 'check_in',
  }]);

  assert.equal(corrections.has('18\u00002026-11-22\u0000check_in'), false);
  assert.equal(corrections.has('18\u00002026-11-22\u0000late_minutes'), false);
  assert.equal(corrections.get('18\u00002026-11-22\u0000check_out').action, 'clear');
  assert.equal(corrections.get('19\u00002026-11-22\u0000check_in').action, 'clear');
  assert.equal(corrections.get('18\u00002026-11-21\u0000check_in').action, 'clear');
  assert.equal(corrections.get('20\u00002026-11-22\u0000late_minutes').value, '5');
});

test('Apps Script recalculates cleared monthly totals after a new matching scan', () => {
  const corrections = new Map([
    ['18\u0000\u0000total_late_minutes', { action: 'clear' }],
    ['18\u0000\u0000total_attendance', { action: 'clear' }],
    ['18\u0000\u0000total_checkout_diff', { action: 'clear' }],
    ['19\u0000\u0000total_attendance', { action: 'set', value: '4' }],
  ]);

  sandbox.clearSupersededAttendanceClearCorrections(corrections, [{
    participantId: '18',
    date: '2026-11-22',
    eventType: 'check_in',
  }]);

  assert.equal(corrections.has('18\u0000\u0000total_late_minutes'), false);
  assert.equal(corrections.has('18\u0000\u0000total_attendance'), false);
  assert.equal(corrections.get('18\u0000\u0000total_checkout_diff').action, 'clear');

  sandbox.clearSupersededAttendanceClearCorrections(corrections, [{
    participantId: '18',
    date: '2026-11-22',
    eventType: 'check_out',
  }]);

  assert.equal(corrections.has('18\u0000\u0000total_checkout_diff'), false);
  assert.equal(corrections.get('19\u0000\u0000total_attendance').value, '4');
});

test('Apps Script unmerges every complete summary header range before rebuilding', () => {
  const requestedRange = [];
  let unmergedRanges = 0;
  sandbox.unmergeSummaryHeaders({
    getMaxColumns: () => 120,
    getRange: (...args) => {
      requestedRange.push(...args);
      return {
        getMergedRanges: () => [
          { breakApart: () => { unmergedRanges += 1; } },
          { breakApart: () => { unmergedRanges += 1; } },
        ],
      };
    },
  });
  assert.deepEqual(requestedRange, [1, 1, 2, 120]);
  assert.equal(unmergedRanges, 2);
});

test('Apps Script reset PIN must contain four to six digits', () => {
  assert.equal(sandbox.isValidResetPin('1234'), true);
  assert.equal(sandbox.isValidResetPin('123456'), true);
  assert.equal(sandbox.isValidResetPin('123'), false);
  assert.equal(sandbox.isValidResetPin('1234567'), false);
  assert.equal(sandbox.isValidResetPin('12ab'), false);
});
