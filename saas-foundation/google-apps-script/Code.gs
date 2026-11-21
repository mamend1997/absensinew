const DATA_SHEET_NAME = 'Absensi';
const SUMMARY_SHEET_NAME = 'Rekap Bulanan';
const ORDER_SHEET_NAME = 'Urutan Peserta';
const CORRECTIONS_SHEET_NAME = 'Koreksi Absensi';
const CLEAR_CUTOFF_PROPERTY = 'ATTENDANCE_CLEAR_CUTOFF_MS';
const RESET_PIN_PROPERTY = 'RESET_PIN';
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
  'participant_id',
];
const LEGACY_DATA_HEADERS = DATA_HEADERS.slice(0, -1);
const DATE_HEADERS = ['Masuk', 'Terlambat', 'Keluar'];
const TOTAL_HEADERS = ['Total Terlambat', 'Total Hadir'];
const ORDER_HEADERS = ['participant_id', 'Nama Peserta', 'Kode Peserta'];
const CORRECTION_HEADERS = [
  'participant_id',
  'Nama Peserta',
  'Tanggal',
  'Jenis',
  'Aksi',
  'Waktu Koreksi',
];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Rekap Absensi')
    .addItem('Reset semua riwayat', 'clearAllAttendanceHistory')
    .addToUi();
}

function clearAllAttendanceHistory() {
  const ui = SpreadsheetApp.getUi();
  const resetPin = PropertiesService.getScriptProperties()
    .getProperty(RESET_PIN_PROPERTY);
  if (!isValidResetPin(resetPin)) {
    ui.alert('PIN reset belum diatur. Atur Script Property RESET_PIN dengan 4–6 angka.');
    return;
  }
  const pinPrompt = ui.prompt(
    'Verifikasi reset riwayat',
    'Masukkan PIN reset riwayat (4–6 angka):',
    ui.ButtonSet.OK_CANCEL,
  );
  if (pinPrompt.getSelectedButton() !== ui.Button.OK) return;
  if (pinPrompt.getResponseText() !== resetPin) {
    ui.alert('PIN salah. Riwayat tidak dihapus.');
    return;
  }

  const confirmation = ui.alert(
    'Hapus seluruh riwayat absensi?',
    'Data sumber dan rekap akan dihapus. Riwayat lama yang dikirim ulang dari backend juga akan diabaikan; scan baru setelah penghapusan tetap diterima.',
    ui.ButtonSet.YES_NO,
  );
  if (confirmation !== ui.Button.YES) return;

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const dataSheet = getDataSheet(spreadsheet);
    const summarySheet = getSummarySheet(spreadsheet);
    const correctionsSheet = getAttendanceCorrectionsSheet(spreadsheet);
    dataSheet.clearContents();
    dataSheet.getRange(1, 1, 1, DATA_HEADERS.length).setValues([DATA_HEADERS]);
    summarySheet.clear();
    if (correctionsSheet.getLastRow() > 1) {
      correctionsSheet.getRange(
        2,
        1,
        correctionsSheet.getLastRow() - 1,
        CORRECTION_HEADERS.length,
      ).clearContent();
    }
    PropertiesService.getScriptProperties().setProperty(
      CLEAR_CUTOFF_PROPERTY,
      String(Date.now()),
    );
    renderMonthlySummary(spreadsheet, dataSheet, summarySheet);
    dataSheet.hideSheet();
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
  ui.alert('Riwayat absensi berhasil dihapus.');
}

function isValidResetPin(value) {
  return typeof value === 'string' && /^\d{4,6}$/.test(value);
}

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
    const existingRows = lastRow > 1
      ? dataSheet.getRange(2, 1, lastRow - 1, DATA_HEADERS.length).getDisplayValues()
      : [];
    const existing = new Map(existingRows.map((row, index) => [
      row[0],
      { rowNumber: index + 2, participantId: String(row[DATA_HEADERS.length - 1] || '') },
    ]));
    const clearCutoff = Number(
      PropertiesService.getScriptProperties().getProperty(CLEAR_CUTOFF_PROPERTY),
    ) || 0;
    const acceptedIds = [];
    const newRows = [];
    for (const record of request.records) {
      if (!record || typeof record.id_unik !== 'string' || !record.id_unik ||
          !/^\d{4}-\d{2}-\d{2}$/.test(String(record.attendance_date || '')) ||
          !['check_in', 'check_out'].includes(record.event_type) ||
          !parseTimestamp(record.client_timestamp) ||
          (record.participant_id != null && !/^[1-9]\d*$/.test(String(record.participant_id)))) {
        return jsonResponse({ ok: false, error: 'invalid_record', accepted_ids: acceptedIds });
      }
      if (!shouldIncludeAfterClear(record, clearCutoff)) {
        acceptedIds.push(record.id_unik);
        continue;
      }
      const existingRecord = existing.get(record.id_unik);
      if (!existingRecord) {
        newRows.push(DATA_HEADERS.map((header) => safeCell(record[header])));
        existing.set(record.id_unik, {
          rowNumber: lastRow + newRows.length,
          participantId: String(record.participant_id || ''),
        });
      } else if (record.participant_id != null && !existingRecord.participantId) {
        dataSheet.getRange(existingRecord.rowNumber, DATA_HEADERS.length)
          .setValue(safeCell(record.participant_id));
        existingRecord.participantId = String(record.participant_id);
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

function shouldIncludeAfterClear(record, clearCutoffMs) {
  const cutoff = Number(clearCutoffMs) || 0;
  if (!cutoff) return true;
  const receivedAt = record.server_received_at_ms == null
    ? Number.NaN
    : Number(record.server_received_at_ms);
  const timestamp = Number.isFinite(receivedAt)
    ? receivedAt
    : parseTimestamp(record.client_timestamp)?.getTime();
  return Number.isFinite(timestamp) && timestamp > cutoff;
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
    const columnCount = Math.max(sheet.getLastColumn(), DATA_HEADERS.length);
    const headers = sheet.getRange(1, 1, 1, columnCount).getDisplayValues()[0];
    const hasCurrentHeaders = DATA_HEADERS.every((header, index) => headers[index] === header);
    if (!hasCurrentHeaders) {
      const hasLegacyHeaders = LEGACY_DATA_HEADERS.every((header, index) =>
        headers[index] === header);
      const unexpectedHeaders = headers.slice(LEGACY_DATA_HEADERS.length)
        .some((header) => String(header || '').trim() !== '');
      if (!hasLegacyHeaders || unexpectedHeaders) {
        throw new Error('Invalid data sheet headers');
      }
      sheet.getRange(1, DATA_HEADERS.length).setValue(DATA_HEADERS[DATA_HEADERS.length - 1]);
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

function getParticipantOrderSheet(spreadsheet) {
  return getSupportSheet(spreadsheet, ORDER_SHEET_NAME, ORDER_HEADERS);
}

function getAttendanceCorrectionsSheet(spreadsheet) {
  return getSupportSheet(spreadsheet, CORRECTIONS_SHEET_NAME, CORRECTION_HEADERS);
}

function getSupportSheet(spreadsheet, sheetName, headers) {
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
  if (sheet.isSheetHidden()) sheet.showSheet();
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    if (sheetName === CORRECTIONS_SHEET_NAME) {
      const validationRows = Math.max(sheet.getMaxRows() - 1, 1);
      sheet.getRange(2, 4, validationRows, 1).setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireValueInList(['check_in', 'check_out'], true)
          .setAllowInvalid(false)
          .build(),
      );
      sheet.getRange(2, 5, validationRows, 1).setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireValueInList(['set', 'clear'], true)
          .setAllowInvalid(false)
          .build(),
      );
      sheet.getRange(2, 3, validationRows, 1).setNumberFormat('yyyy-mm-dd');
      sheet.getRange(2, 6, validationRows, 1).setNumberFormat('HH:mm:ss');
    }
  } else {
    const actualHeaders = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
    if (headers.some((header, index) => actualHeaders[index] !== header)) {
      throw new Error(`Invalid headers in ${sheetName}`);
    }
  }
  return sheet;
}

function renderMonthlySummary(spreadsheet, dataSheet, summarySheet) {
  const timeZone = spreadsheet.getSpreadsheetTimeZone() || 'Asia/Jakarta';
  const rawRows = dataSheet.getLastRow() > 1
    ? dataSheet.getRange(2, 1, dataSheet.getLastRow() - 1, DATA_HEADERS.length).getValues()
    : [];
  const records = rawRows.map((row) =>
    Object.fromEntries(DATA_HEADERS.map((header, index) => [header, row[index]])));
  const participantOrder = updateParticipantOrderSheet(
    getParticipantOrderSheet(spreadsheet),
    records,
  );
  const corrections = readAttendanceCorrections(
    getAttendanceCorrectionsSheet(spreadsheet),
    timeZone,
  );
  const monthKey = Utilities.formatDate(new Date(), timeZone, 'yyyy-MM');
  const summary = buildMonthlySummary(records, timeZone, monthKey, participantOrder, corrections);
  const firstTotalColumn = 3 + summary.dates.length * DATE_HEADERS.length;
  const lastColumn = firstTotalColumn + TOTAL_HEADERS.length - 1;

  const filter = summarySheet.getFilter();
  if (filter) filter.remove();
  unmergeSummaryHeaders(summarySheet);
  summarySheet.clear();

  summarySheet.getRange(1, 1, 2, 1).merge().setValue('No');
  summarySheet.getRange(1, 2, 2, 1).merge().setValue('Nama');
  summary.dates.forEach((date, index) => {
    const firstDateColumn = 3 + index * DATE_HEADERS.length;
    summarySheet.getRange(1, firstDateColumn, 1, DATE_HEADERS.length)
      .merge()
      .setValue(formatDateLabel(date));
    summarySheet.getRange(2, firstDateColumn, 1, DATE_HEADERS.length)
      .setValues([DATE_HEADERS]);
  });
  summarySheet.getRange(1, firstTotalColumn, 2, 1).merge().setValue(TOTAL_HEADERS[0]);
  summarySheet.getRange(1, firstTotalColumn + 1, 2, 1).merge().setValue(TOTAL_HEADERS[1]);
  if (summary.rows.length) {
    summarySheet.getRange(3, 1, summary.rows.length, lastColumn).setValues(summary.rows);
    summarySheet.getRange(3, 1, summary.rows.length, lastColumn)
      .setVerticalAlignment('middle')
      .setBorder(true, true, true, true, true, true, '#000000', SpreadsheetApp.BorderStyle.SOLID);
    summarySheet.getRange(3, 2, summary.rows.length, 1).setHorizontalAlignment('left');
  }
  summarySheet.getRange(1, 1, 2, lastColumn)
    .setBackground('#ffff00')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setBorder(true, true, true, true, true, true, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  summarySheet.getRange(3, 1, Math.max(summary.rows.length, 1), lastColumn)
    .setHorizontalAlignment('center');
  summarySheet.setColumnWidth(1, 42);
  summarySheet.setColumnWidth(2, 250);
  summary.dates.forEach((date, index) => {
    const firstDateColumn = 3 + index * DATE_HEADERS.length;
    summarySheet.setColumnWidth(firstDateColumn, 85);
    summarySheet.setColumnWidth(firstDateColumn + 1, 85);
    summarySheet.setColumnWidth(firstDateColumn + 2, 85);
  });
  summarySheet.setColumnWidth(firstTotalColumn, 120);
  summarySheet.setColumnWidth(firstTotalColumn + 1, 100);
  summarySheet.setRowHeight(1, 28);
  summarySheet.setRowHeight(2, 26);
  summarySheet.setFrozenRows(2);
  summarySheet.setFrozenColumns(2);
}

function unmergeSummaryHeaders(summarySheet) {
  const headerRange = summarySheet.getRange(1, 1, 2, summarySheet.getMaxColumns());
  headerRange.getMergedRanges().forEach((range) => range.breakApart());
}

function updateParticipantOrderSheet(sheet, records) {
  const lastRow = sheet.getLastRow();
  const oldRows = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, ORDER_HEADERS.length).getValues()
    : [];
  const participants = new Map();
  for (const record of records) {
    const id = String(record.participant_id || '').trim();
    if (!/^[1-9]\d*$/.test(id)) continue;
    const timestamp = parseTimestamp(record.client_timestamp)?.getTime() || 0;
    const current = participants.get(id);
    if (!current || timestamp >= current.timestamp) {
      participants.set(id, {
        id,
        name: String(record.participant_name || ''),
        code: String(record.participant_code || ''),
        timestamp,
      });
    }
  }

  const existingIds = new Set();
  const updatedRows = oldRows.map((row) => {
    const id = String(row[0] || '').trim();
    if (!id) return row;
    existingIds.add(id);
    const participant = participants.get(id);
    return participant
      ? [id, participant.name || row[1], participant.code || row[2]]
      : row;
  });
  if (updatedRows.length) {
    sheet.getRange(2, 1, updatedRows.length, ORDER_HEADERS.length).setValues(updatedRows);
  }

  const newRows = Array.from(participants.values())
    .filter((participant) => !existingIds.has(participant.id))
    .sort((left, right) => compareParticipantIds(left.id, right.id))
    .map((participant) => [participant.id, participant.name, participant.code]);
  if (newRows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, ORDER_HEADERS.length)
      .setValues(newRows);
  }

  const allRows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, ORDER_HEADERS.length).getDisplayValues()
    : [];
  const order = new Map();
  allRows.forEach((row, index) => {
    const id = String(row[0] || '').trim();
    if (/^[1-9]\d*$/.test(id) && !order.has(id)) order.set(id, index);
  });
  return order;
}

function readAttendanceCorrections(sheet, timeZone) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return new Map();
  const rows = sheet.getRange(2, 1, lastRow - 1, CORRECTION_HEADERS.length).getValues();
  const corrections = new Map();
  rows.forEach((row, index) => {
    const [rawId, , rawDate, rawEventType, rawAction, rawTime] = row;
    if (row.every((value) => value == null || String(value).trim() === '')) return;
    const participantId = String(rawId || '').trim();
    const date = attendanceDateKey(rawDate, timeZone);
    const eventType = String(rawEventType || '').trim();
    const action = String(rawAction || '').trim().toLowerCase();
    const rowNumber = index + 2;
    if (!/^[1-9]\d*$/.test(participantId) || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !['check_in', 'check_out'].includes(eventType) || !['set', 'clear'].includes(action)) {
      throw new Error(`Koreksi Absensi baris ${rowNumber} tidak lengkap atau tidak valid.`);
    }
    const time = action === 'set' ? normalizeCorrectionTime(rawTime, timeZone, rowNumber) : '';
    const key = `${participantId}\u0000${date}\u0000${eventType}`;
    if (corrections.has(key)) {
      throw new Error(`Koreksi Absensi ganda untuk peserta ${participantId}, tanggal ${date}, ${eventType}.`);
    }
    corrections.set(key, { participantId, date, eventType, action, time });
  });
  return corrections;
}

function normalizeCorrectionTime(value, timeZone, rowNumber) {
  const text = value instanceof Date
    ? Utilities.formatDate(value, timeZone, 'HH:mm:ss')
    : String(value || '').trim();
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) {
    throw new Error(`Waktu Koreksi pada baris ${rowNumber} harus berformat HH:mm atau HH:mm:ss.`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`Waktu Koreksi pada baris ${rowNumber} bukan waktu yang valid.`);
  }
  return `${match[1]}:${match[2]}:${String(second).padStart(2, '0')}`;
}

function compareParticipantIds(left, right) {
  const leftId = String(left).replace(/^0+(?=\d)/, '');
  const rightId = String(right).replace(/^0+(?=\d)/, '');
  return leftId.length - rightId.length || leftId.localeCompare(rightId);
}

function buildMonthlySummary(records, timeZone, monthKey, participantOrder = new Map(), corrections = new Map()) {
  const dates = new Set();
  const participants = new Map();

  for (const record of records) {
    const date = attendanceDateKey(record.attendance_date, timeZone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 7) !== monthKey) continue;
    if (!['check_in', 'check_out'].includes(record.event_type)) continue;

    const participantId = String(record.participant_id || '').trim();
    const participantCode = String(record.participant_code || '').trim();
    const name = String(record.participant_name || '');
    const classroom = String(record.classroom_name || '');
    if (!participantCode && !name) continue;
    const participantKey = participantId
      ? `id:${participantId}`
      : participantCode
        ? `code:${participantCode}`
        : `name:${name}\u0000${classroom}`;

    let participant = participants.get(participantKey);
    if (!participant) {
      participant = { name, days: new Map() };
      participant.id = participantId;
      participant.code = participantCode;
      participants.set(participantKey, participant);
    } else if (!participant.name && name) {
      participant.name = name;
    }
    if (!participant.id && participantId) participant.id = participantId;
    if (!participant.code && participantCode) participant.code = participantCode;

    let day = participant.days.get(date);
    if (!day) {
      day = {
        checkedIn: false,
        checkIn: '',
        checkInTimestamp: null,
        checkOut: '',
        checkOutTimestamp: null,
        lateMinutes: 0,
      };
      participant.days.set(date, day);
    }

    const timestamp = parseTimestamp(record.client_timestamp);
    if (record.event_type === 'check_in') {
      day.checkedIn = true;
      day.lateMinutes = Math.max(day.lateMinutes, Number(record.late_minutes) || 0);
      if (timestamp && (!day.checkInTimestamp || timestamp < day.checkInTimestamp)) {
        day.checkInTimestamp = timestamp;
        day.checkIn = formatClock(record.client_timestamp, timeZone);
      }
    } else if (timestamp && (!day.checkOutTimestamp || timestamp > day.checkOutTimestamp)) {
      day.checkOutTimestamp = timestamp;
      day.checkOut = formatClock(record.client_timestamp, timeZone);
    }
    dates.add(date);
  }

  for (const correction of corrections.values()) {
    if (correction.date.slice(0, 7) !== monthKey) continue;
    const participant = participants.get(`id:${correction.participantId}`);
    const day = participant?.days.get(correction.date);
    if (!day) continue;
    const value = correction.action === 'clear' ? '' : correction.time;
    if (correction.eventType === 'check_in') day.checkIn = value;
    else day.checkOut = value;
  }

  const sortedDates = Array.from(dates).sort();
  const sortedParticipants = Array.from(participants.values())
    .sort((left, right) => {
      const leftOrder = participantOrder.get(String(left.id || ''));
      const rightOrder = participantOrder.get(String(right.id || ''));
      if (leftOrder !== undefined || rightOrder !== undefined) {
        if (leftOrder === undefined) return 1;
        if (rightOrder === undefined) return -1;
        return leftOrder - rightOrder;
      }
      if (left.id && right.id) return compareParticipantIds(left.id, right.id);
      return String(left.code || left.name).localeCompare(String(right.code || right.name));
    });
  const rows = sortedParticipants.map((participant, index) => {
    let totalLateMinutes = 0;
    let totalAttendance = 0;
    const row = [index + 1, participant.name];
    for (const date of sortedDates) {
      const day = participant.days.get(date);
      if (day && day.checkedIn) {
        totalAttendance += 1;
        totalLateMinutes += day.lateMinutes;
      }
      row.push(
        day?.checkIn || '',
        day && day.checkedIn ? day.lateMinutes : '',
        day?.checkOut || '',
      );
    }
    row.push(totalLateMinutes, totalAttendance);
    return row;
  });
  return { dates: sortedDates, rows };
}

function formatDateLabel(value) {
  const [year, month, day] = value.split('-');
  return `${day}-${month}-${year}`;
}

function attendanceDateKey(value, timeZone) {
  if (value instanceof Date) return Utilities.formatDate(value, timeZone, 'yyyy-MM-dd');
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  return Number.isNaN(date.getTime())
    ? ''
    : Utilities.formatDate(date, timeZone, 'yyyy-MM-dd');
}

function parseTimestamp(value) {
  const text = String(value || '').trim();
  const utcDateTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  const timestamp = value instanceof Date ? value : new Date(utcDateTime);
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
