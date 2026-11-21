const DATA_SHEET_NAME = 'Absensi';
const SUMMARY_SHEET_NAME = 'Rekap Bulanan';
const DATA_HEADERS = [
  'id_unik',
  'participant_code',
  'participant_name',
  'classroom_name',
  'attendance_date',
  'event_type',
  'client_timestamp',
  'attendance_status',
  'late_minutes',
  'scan_method',
];
const SUMMARY_HEADERS = [
  'No',
  'Nama',
  'Kelas',
  'Tanggal',
  'Masuk',
  'Menit telat',
  'Keluar',
  'Total kehadiran bulanan',
  'Total menit telat bulanan',
];

function doPost(event) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const request = JSON.parse(event.postData.contents);
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('SYNC_SECRET');
    if (!expectedSecret || request.secret !== expectedSecret) {
      return jsonResponse({ ok: false, error: 'unauthorized', accepted_ids: [] });
    }
    if (!Array.isArray(request.records) || request.records.length > 100) {
      return jsonResponse({ ok: false, error: 'invalid_records', accepted_ids: [] });
    }

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const dataSheet = getDataSheet(spreadsheet);
    const summarySheet = getSummarySheet(spreadsheet);
    const lastRow = dataSheet.getLastRow();
    const existing = new Set(lastRow > 1
      ? dataSheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues().flat()
      : []);
    const acceptedIds = [];
    const newRows = [];
    for (const record of request.records) {
      if (!record || typeof record.id_unik !== 'string' || !record.id_unik ||
          !/^\d{4}-\d{2}-\d{2}$/.test(String(record.attendance_date || '')) ||
          !['check_in', 'check_out'].includes(record.event_type) ||
          !record.client_timestamp) {
        return jsonResponse({ ok: false, error: 'invalid_record', accepted_ids: acceptedIds });
      }
      if (!existing.has(record.id_unik)) {
        newRows.push(DATA_HEADERS.map((header) => safeCell(record[header])));
        existing.add(record.id_unik);
      }
      acceptedIds.push(record.id_unik);
    }
    if (newRows.length) {
      dataSheet.getRange(dataSheet.getLastRow() + 1, 1, newRows.length, DATA_HEADERS.length)
        .setValues(newRows);
    }
    renderMonthlySummary(spreadsheet, dataSheet, summarySheet);
    dataSheet.hideSheet();
    return jsonResponse({ ok: true, accepted_ids: acceptedIds });
  } catch (error) {
    const detail = error && error.message
      ? String(error.message).replace(/[\r\n]/g, ' ').slice(0, 300)
      : 'Unknown Apps Script error';
    console.error('Google Sheets sync failed:', detail);
    return jsonResponse({
      ok: false,
      error: 'sync_failed',
      detail,
      accepted_ids: [],
    });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function installDailyRefreshTrigger() {
  const handler = 'refreshMonthlySummary';
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === handler)
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger(handler).timeBased().everyDays(1).atHour(1).create();
  refreshMonthlySummary();
}

function refreshMonthlySummary() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const dataSheet = getDataSheet(spreadsheet);
    const summarySheet = getSummarySheet(spreadsheet);
    renderMonthlySummary(spreadsheet, dataSheet, summarySheet);
    dataSheet.hideSheet();
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function getDataSheet(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(DATA_SHEET_NAME);
  if (!sheet) {
    const blankSheet = spreadsheet.getSheets()
      .find((item) => item.getLastRow() === 0 && item.getLastColumn() === 0);
    sheet = blankSheet || spreadsheet.insertSheet();
    sheet.setName(DATA_SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, DATA_HEADERS.length).setValues([DATA_HEADERS]);
  } else {
    const headers = sheet.getRange(1, 1, 1, DATA_HEADERS.length).getDisplayValues()[0];
    if (DATA_HEADERS.some((header, index) => headers[index] !== header)) {
      throw new Error('Invalid data sheet headers');
    }
  }
  return sheet;
}

function getSummarySheet(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(SUMMARY_SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(SUMMARY_SHEET_NAME);
  if (sheet.isSheetHidden()) sheet.showSheet();
  return sheet;
}

function renderMonthlySummary(spreadsheet, dataSheet, summarySheet) {
  const timeZone = spreadsheet.getSpreadsheetTimeZone() || 'Asia/Jakarta';
  const records = dataSheet.getLastRow() > 1
    ? dataSheet.getRange(2, 1, dataSheet.getLastRow() - 1, DATA_HEADERS.length).getValues()
    : [];
  const columns = Object.fromEntries(DATA_HEADERS.map((header, index) => [header, index]));
  const days = new Map();

  for (const row of records) {
    const date = String(row[columns.attendance_date] || '').slice(0, 10);
    const participantCode = String(row[columns.participant_code] || '');
    const key = `${date}\u0000${participantCode}`;
    let day = days.get(key);
    if (!day) {
      day = {
        date,
        participantCode,
        name: String(row[columns.participant_name] || ''),
        classroom: String(row[columns.classroom_name] || ''),
        checkIn: '',
        checkInTime: null,
        checkOut: '',
        checkOutTime: null,
        status: '',
        lateMinutes: 0,
      };
      days.set(key, day);
    }
    const timestamp = parseTimestamp(row[columns.client_timestamp]);
    if (row[columns.event_type] === 'check_in') {
      if (!day.checkInTime || (timestamp && timestamp < day.checkInTime)) {
        day.checkInTime = timestamp;
        day.checkIn = formatClock(row[columns.client_timestamp], timeZone);
      }
      day.status = String(row[columns.attendance_status] || day.status);
      day.lateMinutes = Math.max(day.lateMinutes, Number(row[columns.late_minutes]) || 0);
    } else if (row[columns.event_type] === 'check_out' &&
        (!day.checkOutTime || (timestamp && timestamp > day.checkOutTime))) {
      day.checkOutTime = timestamp;
      day.checkOut = formatClock(row[columns.client_timestamp], timeZone);
      if (!day.status) day.status = 'pulang';
    }
  }

  const sortedDays = Array.from(days.values())
    .sort((left, right) => left.date.localeCompare(right.date) ||
      left.classroom.localeCompare(right.classroom) || left.name.localeCompare(right.name));
  const participantTotals = new Map();
  for (const day of sortedDays) {
    const monthlyKey = `${day.date.slice(0, 7)}\u0000${day.participantCode}`;
    const total = participantTotals.get(monthlyKey) || { attendanceCount: 0, lateMinutes: 0 };
    if (day.checkIn) total.attendanceCount += 1;
    total.lateMinutes += day.lateMinutes;
    participantTotals.set(monthlyKey, total);
  }
  const rows = sortedDays.map((day, index) => {
    const total = participantTotals.get(`${day.date.slice(0, 7)}\u0000${day.participantCode}`);
    return [
      index + 1,
      day.name,
      day.classroom,
      day.date,
      day.checkIn,
      day.lateMinutes,
      day.checkOut,
      total.attendanceCount,
      total.lateMinutes,
    ];
  });

  const filter = summarySheet.getFilter();
  if (filter) filter.remove();
  summarySheet.clearContents();
  summarySheet.getRange(1, 1).setValue('Rekap Absensi Bulanan');
  summarySheet.getRange(2, 1, 1, SUMMARY_HEADERS.length).setValues([SUMMARY_HEADERS]);
  if (rows.length) summarySheet.getRange(3, 1, rows.length, SUMMARY_HEADERS.length).setValues(rows);
  summarySheet.setFrozenRows(2);
  summarySheet.getRange(2, 1, Math.max(rows.length + 1, 1), SUMMARY_HEADERS.length).createFilter();
  summarySheet.autoResizeColumns(1, SUMMARY_HEADERS.length);
}

function parseTimestamp(value) {
  const timestamp = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function formatClock(value, timeZone) {
  const timestamp = parseTimestamp(value);
  return timestamp ? Utilities.formatDate(timestamp, timeZone, 'HH:mm:ss') : '';
}

function safeCell(value) {
  const text = value == null ? '' : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
