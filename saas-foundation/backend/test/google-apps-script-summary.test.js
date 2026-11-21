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
  `${script}\nthis.buildMonthlySummary = buildMonthlySummary;\nthis.updateParticipantOrderSheet = updateParticipantOrderSheet;\nthis.readAttendanceCorrections = readAttendanceCorrections;\nthis.formatDateLabel = formatDateLabel;\nthis.shouldIncludeAfterClear = shouldIncludeAfterClear;\nthis.unmergeSummaryHeaders = unmergeSummaryHeaders;\nthis.isValidResetPin = isValidResetPin;`,
  sandbox,
);

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
    [1, 'Agung', '07:54:09', 5, '15:11:17', '07:49:58', 0, '', 5, 2],
    [2, 'Budi', '', '', '', '07:50:00', 2, '', 2, 1],
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
    [1, 'Siti', '07:54:09', 5, '15:11:17', 5, 1],
    [2, 'Siti', '08:00:00', 0, '', 0, 1],
  ]);
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
      time: '',
    }],
    ['18-check-in', {
      participantId: '18',
      date: '2026-11-01',
      eventType: 'check_in',
      action: 'set',
      time: '08:15:00',
    }],
  ]));

  assert.deepEqual(Array.from(rows, (row) => Array.from(row)), [
    [1, 'Zahra', '', 5, '', 5, 1],
    [2, 'Ayu', '08:15:00', 0, '', 0, 1],
  ]);
});

test('Apps Script preserves participant order and appends newly synced participants', () => {
  const rows = [
    ['participant_id', 'Nama Peserta', 'Kode Peserta'],
    ['18', 'Ayu', 'P18'],
    ['17', 'Zahra', 'P17'],
  ];
  const sheet = {
    getLastRow: () => rows.length,
    getRange(row, column, rowCount, columnCount) {
      return {
        getValues: () => rows.slice(row - 1, row - 1 + rowCount)
          .map((values) => values.slice(column - 1, column - 1 + columnCount)),
        getDisplayValues: () => rows.slice(row - 1, row - 1 + rowCount)
          .map((values) => values.slice(column - 1, column - 1 + columnCount)),
        setValues(values) {
          values.forEach((value, index) => {
            rows[row - 1 + index] = value.slice();
          });
        },
      };
    },
  };
  const order = sandbox.updateParticipantOrderSheet(sheet, [
    {
      participant_id: '19',
      participant_code: 'P19',
      participant_name: 'Bima',
      client_timestamp: '2026-11-01 01:00:00.000',
    },
    {
      participant_id: '18',
      participant_code: 'P18',
      participant_name: 'Ayu',
      client_timestamp: '2026-11-01 01:00:00.000',
    },
  ]);

  assert.deepEqual(rows.slice(1).map((row) => Array.from(row)), [
    ['18', 'Ayu', 'P18'],
    ['17', 'Zahra', 'P17'],
    ['19', 'Bima', 'P19'],
  ]);
  assert.equal(order.get('18'), 0);
  assert.equal(order.get('17'), 1);
  assert.equal(order.get('19'), 2);
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

  assert.equal(corrections.get('17\u00002026-11-01\u0000check_in').time, '08:15:00');
  assert.equal(corrections.get('18\u00002026-11-01\u0000check_out').action, 'clear');
  assert.throws(() => sandbox.readAttendanceCorrections({
    getLastRow: () => 2,
    getRange: () => ({ getValues: () => [
      ['17', 'Zahra', '2026-11-01', 'check_in', 'set', '25:00'],
    ] }),
  }, 'Asia/Jakarta'), /bukan waktu yang valid/);
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
