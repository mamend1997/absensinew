const DATA_SHEET_NAME = 'Absensi';
const LEGACY_SUMMARY_SHEET_NAME = 'Rekap Bulanan';
const LEGACY_ORDER_SHEET_NAME = 'Urutan Peserta';
const LEGACY_CORRECTIONS_SHEET_NAME = 'Koreksi Absensi';
const PERMISSION_SHEET_PREFIX = 'Izin ';
const CLEAR_CUTOFF_PROPERTY = 'ATTENDANCE_CLEAR_CUTOFF_MS';
const RESET_PIN_PROPERTY = 'RESET_PIN';
const SUMMARY_PARTICIPANT_ID_HEADER = 'participant_id';
const SUMMARY_OVERRIDE_PREFIX = '__attendance_override__';
const SUMMARY_BASELINE_PREFIX = '__attendance_baseline__';
const MONTH_NAMES = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
];
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

function onEdit(event) {
  if (!event || !event.range ||
      (!isMonthlySummarySheetName(event.range.getSheet().getName()) &&
       !event.range.getSheet().getName().startsWith(PERMISSION_SHEET_PREFIX))) return;
  if (event.range.getSheet().getName().startsWith(PERMISSION_SHEET_PREFIX)) {
    savePermissionSheetEdit(event);
    return;
  }
  const summarySheet = event.range.getSheet();
  const metadata = findSummaryMetadata(summarySheet);
  const participantIdColumn = metadata.participantIdColumn;
  if (!participantIdColumn) {
    event.source.toast(
      'ID peserta belum tersedia. Jalankan pembaruan rekap terlebih dahulu.',
      'Rekap Absensi',
      5,
    );
    return;
  }
  const firstRow = Math.max(3, event.range.getRow());
  const lastRow = Math.min(event.range.getLastRow(), summarySheet.getLastRow());
  if (firstRow > lastRow) return;

  const timeZone = event.source.getSpreadsheetTimeZone() || 'Asia/Jakarta';
  const dateByFirstColumn = getSummaryDateColumns(summarySheet, participantIdColumn);
  const participantIds = summarySheet
    .getRange(firstRow, participantIdColumn, lastRow - firstRow + 1, 1)
    .getDisplayValues()
    .map((row) => row[0]);
  const baselineValues = readSummaryBaselineValues(
    summarySheet,
    metadata,
    firstRow,
    lastRow,
    participantIds,
  );
  const overrideValues = readSummaryOverrideValues(
    summarySheet,
    metadata,
    firstRow,
    lastRow,
    participantIds,
  );
  const result = buildSummaryEditCorrections(
    event.range.getValues(),
    event.range.getRow(),
    event.range.getColumn(),
    firstRow,
    participantIds,
    dateByFirstColumn,
    timeZone,
    baselineValues,
    overrideValues,
  );
  if (!result.corrections.length && !result.unmappedCount) return;

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (result.corrections.length) {
      saveMonthlySummaryCorrections(summarySheet, result.corrections);
    }
    if (result.unmappedCount) {
      event.source.toast(
        `${result.unmappedCount} koreksi tidak tersimpan karena ID peserta tidak ditemukan.`,
        'Rekap Absensi',
        8,
      );
    } else if (result.corrections.length) {
      event.source.toast(
        'Koreksi absensi tersimpan di sheet bulan ini.',
        'Rekap Absensi',
        5,
      );
    }
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
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
    'Data sumber dan seluruh rekap bulanan akan dihapus. Riwayat lama yang dikirim ulang dari backend juga akan diabaikan; scan baru setelah penghapusan tetap diterima.',
    ui.ButtonSet.YES_NO,
  );
  if (confirmation !== ui.Button.YES) return;

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const dataSheet = getDataSheet(spreadsheet);
    dataSheet.clearContents();
    dataSheet.getRange(1, 1, 1, DATA_HEADERS.length).setValues([DATA_HEADERS]);
    const monthKey = currentMonthKey(spreadsheet.getSpreadsheetTimeZone());
    const summarySheet = getSummarySheet(spreadsheet, monthKey);
    spreadsheet.getSheets()
      .filter((sheet) => isMonthlySummarySheetName(sheet.getName()) ||
        sheet.getName().startsWith(PERMISSION_SHEET_PREFIX) ||
        [LEGACY_SUMMARY_SHEET_NAME, LEGACY_ORDER_SHEET_NAME,
          LEGACY_CORRECTIONS_SHEET_NAME].includes(sheet.getName()))
      .filter((sheet) => sheet !== summarySheet)
      .forEach((sheet) => spreadsheet.deleteSheet(sheet));
    showSummaryMetadataColumns(summarySheet, findSummaryMetadata(summarySheet).columns);
    summarySheet.clear();
    removeLegacySupportSheets(spreadsheet);
    PropertiesService.getScriptProperties().setProperty(
      CLEAR_CUTOFF_PROPERTY,
      String(Date.now()),
    );
    renderMonthlySummary(spreadsheet, dataSheet, summarySheet, monthKey, []);
    renderPermissionSummary(spreadsheet, monthKey, [], spreadsheet.getSpreadsheetTimeZone());
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
    const newAttendanceEvents = [];
    const timeZone = spreadsheet.getSpreadsheetTimeZone() || 'Asia/Jakarta';
    const monthKeys = new Set([currentMonthKey(timeZone)]);
    for (const record of request.records) {
      if (!record || typeof record.id_unik !== 'string' || !record.id_unik ||
          !/^\d{4}-\d{2}-\d{2}$/.test(String(record.attendance_date || '')) ||
          !['check_in', 'check_out', 'permission_out', 'permission_in'].includes(record.event_type) ||
          !parseTimestamp(record.client_timestamp) ||
          ((record.event_type === 'check_in' || record.event_type === 'check_out') &&
            record.participant_id != null &&
            !/^[1-9]\d*$/.test(String(record.participant_id)))) {
        return jsonResponse({ ok: false, error: 'invalid_record', accepted_ids: acceptedIds });
      }
      if (!shouldIncludeAfterClear(record, clearCutoff)) {
        acceptedIds.push(record.id_unik);
        continue;
      }
      monthKeys.add(String(record.attendance_date).slice(0, 7));
      const existingRecord = existing.get(record.id_unik);
      if (!existingRecord) {
        newRows.push(DATA_HEADERS.map((header) => safeCell(record[header])));
        const participantId = String(record.participant_id || '').trim();
        if (/^[1-9]\d*$/.test(participantId)) {
          newAttendanceEvents.push({
            participantId,
            date: String(record.attendance_date),
            eventType: record.event_type,
          });
        }
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
    migrateLegacySummarySheet(spreadsheet, currentMonthKey(timeZone));
    const recordsByMonth = groupAttendanceRecordsByMonth(
      readAttendanceRecords(dataSheet),
      timeZone,
    );
    Array.from(monthKeys).sort().forEach((monthKey) => {
      const summarySheet = getSummarySheet(spreadsheet, monthKey);
      renderMonthlySummary(
        spreadsheet,
        dataSheet,
        summarySheet,
        monthKey,
        recordsByMonth.get(monthKey) || [],
        newAttendanceEvents,
      );
      renderPermissionSummary(
        spreadsheet,
        monthKey,
        recordsByMonth.get(monthKey) || [],
        timeZone,
      );
    });
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
    const timeZone = spreadsheet.getSpreadsheetTimeZone() || 'Asia/Jakarta';
    const recordsByMonth = groupAttendanceRecordsByMonth(
      readAttendanceRecords(dataSheet),
      timeZone,
    );
    const monthKeys = new Set(recordsByMonth.keys());
    const activeMonthKey = currentMonthKey(timeZone);
    monthKeys.add(activeMonthKey);
    migrateLegacySummarySheet(spreadsheet, activeMonthKey);
    const migrateLegacySupport = Boolean(
      spreadsheet.getSheetByName(LEGACY_ORDER_SHEET_NAME) ||
      spreadsheet.getSheetByName(LEGACY_CORRECTIONS_SHEET_NAME),
    );
    Array.from(monthKeys).sort().forEach((monthKey) => {
      const sheetName = monthSheetName(monthKey);
      if (monthKey !== activeMonthKey && !migrateLegacySupport &&
          spreadsheet.getSheetByName(sheetName)) return;
      const summarySheet = getSummarySheet(spreadsheet, monthKey);
      renderMonthlySummary(
        spreadsheet,
        dataSheet,
        summarySheet,
        monthKey,
        recordsByMonth.get(monthKey) || [],
      );
      renderPermissionSummary(
        spreadsheet,
        monthKey,
        recordsByMonth.get(monthKey) || [],
        timeZone,
      );
    });
    removeLegacySupportSheets(spreadsheet);
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

function getSummarySheet(spreadsheet, monthKey) {
  const sheetName = monthSheetName(monthKey);
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet && monthKey === currentMonthKey(spreadsheet.getSpreadsheetTimeZone())) {
    const legacySheet = spreadsheet.getSheetByName(LEGACY_SUMMARY_SHEET_NAME);
    if (legacySheet) {
      legacySheet.setName(sheetName);
      sheet = legacySheet;
    }
  }
  if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
  if (sheet.isSheetHidden()) sheet.showSheet();
  return sheet;
}

function currentMonthKey(timeZone) {
  return Utilities.formatDate(new Date(), timeZone || 'Asia/Jakarta', 'yyyy-MM');
}

function monthSheetName(monthKey) {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) throw new Error(`Invalid attendance month: ${monthKey}`);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid attendance month: ${monthKey}`);
  return `${MONTH_NAMES[month - 1]} ${match[1]}`;
}

function permissionSheetName(monthKey) {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) throw new Error(`Invalid permission month: ${monthKey}`);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid permission month: ${monthKey}`);
  return `${PERMISSION_SHEET_PREFIX}${MONTH_NAMES[month - 1]} ${match[1]}`;
}

function buildPermissionSummary(records, timeZone) {
  const permissionRecords = (records || [])
    .filter((record) => ['permission_out', 'permission_in'].includes(record.event_type))
    .map((record) => ({
      record,
      timestamp: parseTimestamp(record.client_timestamp),
    }))
    .filter((item) => item.timestamp);

  const participants = new Map();
  const dates = new Set();
  permissionRecords.forEach((item) => {
    const participantId = String(
      item.record.participant_id ||
      item.record.participant_code ||
      item.record.participant_name ||
      '',
    ).trim();
    if (!participantId) return;
    const attendanceDate = attendanceDateKey(
      item.record.attendance_date ||
      attendanceDateKey(item.timestamp, timeZone),
      timeZone,
    );
    dates.add(attendanceDate);
    if (!participants.has(participantId)) {
      participants.set(participantId, {
        participantId,
        name: String(
          item.record.participant_name ||
          item.record.participant_name_snapshot ||
          'Nama tidak tersedia',
        ).trim() || 'Nama tidak tersedia',
        permissionsByDate: new Map(),
      });
    }
    const participant = participants.get(participantId);
    if (!participant.name || participant.name === 'Nama tidak tersedia') {
      participant.name = String(
        item.record.participant_name ||
        item.record.participant_name_snapshot ||
        '',
      ).trim() || participant.name;
    }
    if (!participant.permissionsByDate.has(attendanceDate)) {
      participant.permissionsByDate.set(attendanceDate, { outs: [], ins: [] });
    }
    const day = participant.permissionsByDate.get(attendanceDate);
    if (item.record.event_type === 'permission_out') day.outs.push(item.timestamp);
    else day.ins.push(item.timestamp);
  });

  const sortedDates = Array.from(dates).sort();
  const topHeaders = ['No', 'Nama Peserta'];
  sortedDates.forEach((date) => topHeaders.push(formatDateLabel(date), '', ''));
  topHeaders.push('Total Menit Keluar', 'Total Kali Izin Keluar');
  const subHeaders = ['No', 'Nama Peserta'];
  sortedDates.forEach(() => subHeaders.push('Izin Keluar', 'Masuk Kembali', 'Durasi Keluar'));
  subHeaders.push('Total Menit Keluar', 'Total Kali Izin Keluar');

  const rows = [];
  Array.from(participants.values())
    .sort((left, right) => left.name.localeCompare(right.name))
    .forEach((participant) => {
      const row = [rows.length + 1, participant.name];
      let totalMinutes = 0;
      let totalCount = 0;
      sortedDates.forEach((date) => {
        const day = participant.permissionsByDate.get(date);
        if (!day) {
          row.push('', '', '');
          return;
        }
        day.outs.sort((left, right) => left.getTime() - right.getTime());
        day.ins.sort((left, right) => left.getTime() - right.getTime());
        let dayMinutes = 0;
        const outValues = [];
        const inValues = [];
        day.outs.forEach((outTimestamp) => {
          const returnTimestamp = day.ins.find((inTimestamp) =>
            inTimestamp.getTime() >= outTimestamp.getTime());
          if (returnTimestamp) {
            day.ins = day.ins.filter((inTimestamp) => inTimestamp !== returnTimestamp);
            const minutes = Math.max(
              0,
              Math.ceil((returnTimestamp.getTime() - outTimestamp.getTime()) / 60000),
            );
            dayMinutes += minutes;
            totalMinutes += minutes;
            totalCount += 1;
            outValues.push(formatClock(outTimestamp, timeZone));
            inValues.push(formatClock(returnTimestamp, timeZone));
          } else {
            outValues.push(formatClock(outTimestamp, timeZone));
            inValues.push('');
          }
        });
        row.push(outValues.join('\n'), inValues.join('\n'), dayMinutes || '');
      });
      row.push(totalMinutes, totalCount);
      rows.push(row);
    });

  return { topHeaders, subHeaders, rows, sortedDates };
}

function renderPermissionSummary(spreadsheet, monthKey, records, timeZone) {
  const sheetName = permissionSheetName(monthKey);
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
  sheet.showSheet();
  sheet.clear();

  const summary = buildPermissionSummary(records, timeZone);
  const columnCount = summary.topHeaders.length;
  sheet.getRange(1, 1, 1, columnCount).setValues([summary.topHeaders]);
  sheet.getRange(2, 1, 1, columnCount).setValues([summary.subHeaders]);
  sheet.getRange(1, 1, 2, columnCount).setFontWeight('bold');
  sheet.getRange(1, 1, 1, columnCount).setBackground('#fff200');
  sheet.getRange(2, 1, 1, columnCount).setBackground('#fff200');
  sheet.setFrozenRows(2);

  const dateStartColumns = [];
  let columnIndex = 3;
  summary.sortedDates.forEach(() => {
    dateStartColumns.push(columnIndex);
    columnIndex += 3;
  });
  dateStartColumns.forEach((startColumn) => {
    sheet.getRange(1, startColumn, 1, 3).merge();
  });
  sheet.getRange(1, 1, 2, 2).mergeAcross();

  if (!summary.rows.length) {
    sheet.getRange(3, 1, 1, columnCount)
      .setValues([['', 'Belum ada izin keluar', ...Array(columnCount - 2).fill('')]]);
  } else {
    sheet.getRange(3, 1, summary.rows.length, columnCount).setValues(summary.rows);
  }

  sheet.setColumnWidth(1, 50);
  sheet.setColumnWidth(2, 220);
  for (let column = 3; column <= columnCount; column += 1) {
    sheet.setColumnWidth(column, column <= columnCount - 2 ? 130 : 170);
  }
  return sheet;
}

function monthKeyFromSheetName(name) {
  const match = /^(.+) (\d{4})$/.exec(name);
  if (!match) return '';
  const month = MONTH_NAMES.indexOf(match[1]) + 1;
  return month ? `${match[2]}-${String(month).padStart(2, '0')}` : '';
}

function isMonthlySummarySheetName(name) {
  return Boolean(monthKeyFromSheetName(name));
}

function readAttendanceRecords(dataSheet) {
  if (dataSheet.getLastRow() <= 1) return [];
  const rows = dataSheet.getRange(
    2,
    1,
    dataSheet.getLastRow() - 1,
    DATA_HEADERS.length,
  ).getValues();
  return rows.map((row) =>
    Object.fromEntries(DATA_HEADERS.map((header, index) => [header, row[index]])));
}

function groupAttendanceRecordsByMonth(records, timeZone) {
  const grouped = new Map();
  records.forEach((record) => {
    const date = attendanceDateKey(record.attendance_date, timeZone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const monthKey = date.slice(0, 7);
    if (!grouped.has(monthKey)) grouped.set(monthKey, []);
    grouped.get(monthKey).push(record);
  });
  return grouped;
}

function migrateLegacySummarySheet(spreadsheet, currentMonth) {
  const legacySheet = spreadsheet.getSheetByName(LEGACY_SUMMARY_SHEET_NAME);
  const currentSheetName = monthSheetName(currentMonth);
  if (legacySheet && !spreadsheet.getSheetByName(currentSheetName)) {
    legacySheet.setName(currentSheetName);
  }
}

function removeLegacySupportSheets(spreadsheet) {
  [LEGACY_ORDER_SHEET_NAME, LEGACY_CORRECTIONS_SHEET_NAME].forEach((name) => {
    const sheet = spreadsheet.getSheetByName(name);
    if (sheet) spreadsheet.deleteSheet(sheet);
  });
}

function readPreviousMonthOrder(spreadsheet, monthKey) {
  const previousSheets = spreadsheet.getSheets()
    .map((sheet) => ({ sheet, monthKey: monthKeyFromSheetName(sheet.getName()) }))
    .filter((entry) => entry.monthKey && entry.monthKey < monthKey)
    .sort((left, right) => right.monthKey.localeCompare(left.monthKey));
  for (const entry of previousSheets) {
    const metadata = findSummaryMetadata(entry.sheet);
    if (!metadata.participantIdColumn || entry.sheet.getLastRow() < 3) continue;
    const order = new Map();
    entry.sheet.getRange(
      3,
      metadata.participantIdColumn,
      entry.sheet.getLastRow() - 2,
      1,
    ).getDisplayValues().forEach((row, index) => {
      const id = String(row[0] || '').trim();
      if (/^[1-9]\d*$/.test(id) && !order.has(id)) order.set(id, index);
    });
    if (order.size) return order;
  }
  return new Map();
}

function findSummaryMetadata(sheet) {
  const lastColumn = sheet.getLastColumn();
  const headers = lastColumn
    ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0]
    : [];
  const participantIdIndex = headers.indexOf(SUMMARY_PARTICIPANT_ID_HEADER);
  const correctionColumns = new Map();
  const columns = [];
  if (participantIdIndex >= 0) columns.push(participantIdIndex + 1);
  headers.forEach((header, index) => {
    const text = String(header || '');
    const match = new RegExp(
      `^${SUMMARY_OVERRIDE_PREFIX}(\\d{4}-\\d{2}-\\d{2})__(check_in|late_minutes|check_out)$`,
    ).exec(text);
    const totalMatch = new RegExp(`^${SUMMARY_OVERRIDE_PREFIX}total_late_minutes$`).exec(text);
    if (match) {
      correctionColumns.set(attendanceCorrectionKey('', match[1], match[2]), index + 1);
    } else if (totalMatch) {
      correctionColumns.set(attendanceCorrectionKey('', '', 'total_late_minutes'), index + 1);
    } else {
      return;
    }
    columns.push(index + 1);
  });
  const baselineColumns = new Map();
  headers.forEach((header, index) => {
    const text = String(header || '');
    const match = new RegExp(
      `^${SUMMARY_BASELINE_PREFIX}(\\d{4}-\\d{2}-\\d{2})__(check_in|late_minutes|check_out)$`,
    ).exec(text);
    const totalMatch = new RegExp(`^${SUMMARY_BASELINE_PREFIX}total_late_minutes$`).exec(text);
    if (match) {
      baselineColumns.set(attendanceCorrectionKey('', match[1], match[2]), index + 1);
    } else if (totalMatch) {
      baselineColumns.set(attendanceCorrectionKey('', '', 'total_late_minutes'), index + 1);
    } else {
      return;
    }
    columns.push(index + 1);
  });
  return {
    participantIdColumn: participantIdIndex < 0 ? 0 : participantIdIndex + 1,
    correctionColumns,
    baselineColumns,
    columns,
  };
}

function showSummaryMetadataColumns(sheet, columns) {
  if (!columns.length) return;
  const firstColumn = Math.min(...columns);
  const lastColumn = Math.max(...columns);
  sheet.showColumns(firstColumn, lastColumn - firstColumn + 1);
}

function getSummaryDateColumns(sheet, participantIdColumn) {
  const dateColumns = new Map();
  if (participantIdColumn <= 3) return dateColumns;
  const headers = sheet.getRange(1, 3, 1, participantIdColumn - 3).getDisplayValues()[0];
  for (let index = 0; index < headers.length; index += 3) {
    const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(headers[index] || '').trim());
    if (match) {
      dateColumns.set(
        index + 3,
        `${match[3]}-${match[2]}-${match[1]}`,
      );
    }
  }
  return dateColumns;
}

function readMonthlySummaryState(sheet, timeZone) {
  const metadata = findSummaryMetadata(sheet);
  const state = { order: new Map(), corrections: new Map(), metadataColumns: metadata.columns };
  if (!metadata.participantIdColumn || sheet.getLastRow() < 3) return state;
  const lastRow = sheet.getLastRow();
  const rowCount = lastRow - 2;
  const firstMetadataColumn = Math.min(...metadata.columns);
  const lastMetadataColumn = Math.max(...metadata.columns);
  const metadataRows = sheet.getRange(
    3,
    firstMetadataColumn,
    rowCount,
    lastMetadataColumn - firstMetadataColumn + 1,
  ).getDisplayValues();
  const participantIdOffset = metadata.participantIdColumn - firstMetadataColumn;
  const participantIds = metadataRows.map((row) =>
    String(row[participantIdOffset] || '').trim());
  participantIds.forEach((id, index) => {
    if (/^[1-9]\d*$/.test(id) && !state.order.has(id)) state.order.set(id, index);
  });
  metadata.correctionColumns.forEach((column, key) => {
    const [, date, eventType] = key.split('\u0000');
    const columnOffset = column - firstMetadataColumn;
    metadataRows.forEach((row, index) => {
      const participantId = participantIds[index];
      const value = String(row[columnOffset] || '').trim();
      if (!participantId || !value) return;
      const action = value.toLowerCase() === 'clear' ? 'clear' : 'set';
      const correctionValue = action === 'set'
        ? normalizeSummaryCorrectionValue(value, eventType, timeZone, index + 3)
        : '';
      const correctionKey = attendanceCorrectionKey(participantId, date, eventType);
      state.corrections.set(correctionKey, {
        participantId,
        date,
        eventType,
        action,
        value: correctionValue,
      });
    });
  });
  return state;
}

function readSummaryBaselineValues(sheet, metadata, firstRow, lastRow, participantIds) {
  return readSummaryMetadataValues(
    sheet,
    metadata.baselineColumns,
    firstRow,
    lastRow,
    participantIds,
  );
}

function readSummaryOverrideValues(sheet, metadata, firstRow, lastRow, participantIds) {
  return readSummaryMetadataValues(
    sheet,
    metadata.correctionColumns,
    firstRow,
    lastRow,
    participantIds,
  );
}

function readSummaryMetadataValues(sheet, columns, firstRow, lastRow, participantIds) {
  const metadataValues = new Map();
  if (!columns.size) return metadataValues;
  const rowCount = lastRow - firstRow + 1;
  const columnNumbers = Array.from(columns.values());
  const firstMetadataColumn = Math.min(...columnNumbers);
  const lastMetadataColumn = Math.max(...columnNumbers);
  const rows = sheet.getRange(
    firstRow,
    firstMetadataColumn,
    rowCount,
    lastMetadataColumn - firstMetadataColumn + 1,
  ).getDisplayValues();
  columns.forEach((column, key) => {
    const [, date, eventType] = key.split('\u0000');
    const offset = column - firstMetadataColumn;
    rows.forEach((row, index) => {
      const participantId = String(participantIds[index] || '').trim();
      if (!participantId) return;
      metadataValues.set(
        attendanceCorrectionKey(participantId, date, eventType),
        String(row[offset] || '').trim(),
      );
    });
  });
  return metadataValues;
}

function readLegacyParticipantOrder(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(LEGACY_ORDER_SHEET_NAME);
  const order = new Map();
  if (!sheet || sheet.getLastRow() < 2) return order;
  const headers = sheet.getRange(1, 1, 1, ORDER_HEADERS.length).getDisplayValues()[0];
  if (ORDER_HEADERS.some((header, index) => headers[index] !== header)) {
    throw new Error(`Invalid headers in ${LEGACY_ORDER_SHEET_NAME}`);
  }
  sheet.getRange(2, 1, sheet.getLastRow() - 1, ORDER_HEADERS.length)
    .getDisplayValues()
    .forEach((row, index) => {
      const id = String(row[0] || '').trim();
      if (/^[1-9]\d*$/.test(id) && !order.has(id)) order.set(id, index);
    });
  return order;
}

function readLegacyAttendanceCorrections(spreadsheet, timeZone) {
  const sheet = spreadsheet.getSheetByName(LEGACY_CORRECTIONS_SHEET_NAME);
  if (!sheet) return new Map();
  const headers = sheet.getRange(1, 1, 1, CORRECTION_HEADERS.length).getDisplayValues()[0];
  if (CORRECTION_HEADERS.some((header, index) => headers[index] !== header)) {
    throw new Error(`Invalid headers in ${LEGACY_CORRECTIONS_SHEET_NAME}`);
  }
  return readAttendanceCorrections(sheet, timeZone);
}

function saveMonthlySummaryCorrections(sheet, corrections) {
  const metadata = findSummaryMetadata(sheet);
  if (!metadata.participantIdColumn) throw new Error('Monthly summary has no participant IDs.');
  const lastRow = sheet.getLastRow();
  const participantRows = new Map();
  if (lastRow >= 3) {
    sheet.getRange(3, metadata.participantIdColumn, lastRow - 2, 1)
      .getDisplayValues()
      .forEach((row, index) => {
        const id = String(row[0] || '').trim();
        if (id && !participantRows.has(id)) participantRows.set(id, index + 3);
      });
  }
  const dateColumns = getSummaryDateColumns(sheet, metadata.participantIdColumn);
  const firstColumnByDate = new Map(
    Array.from(dateColumns.entries()).map(([column, date]) => [date, column]),
  );
  const firstTotalColumn = 3 + dateColumns.size * DATE_HEADERS.length;
  corrections.forEach((correction) => {
    const row = participantRows.get(correction.participantId);
    const metadataColumn = metadata.correctionColumns.get(
      attendanceCorrectionKey('', correction.date, correction.eventType),
    );
    const firstColumn = correction.eventType === 'total_late_minutes'
      ? firstTotalColumn
      : firstColumnByDate.get(correction.date);
    if (!row || !metadataColumn || !firstColumn) {
      throw new Error(`Could not locate ${correction.eventType} correction cell for ${correction.date || 'total'}.`);
    }
    sheet.getRange(row, metadataColumn)
      .setValue(correction.action === 'inherit'
        ? ''
        : correction.action === 'clear'
          ? 'clear'
          : correction.value);
    const visibleColumn = correction.eventType === 'total_late_minutes'
      ? firstColumn
      : firstColumn + (
        correction.eventType === 'check_in' ? 0
          : correction.eventType === 'late_minutes' ? 1
            : 2
      );
    sheet.getRange(row, visibleColumn)
      .setValue(correction.action === 'clear'
        ? ''
        : correction.eventType.includes('late_minutes')
          ? Number(correction.value)
          : correction.value);
  });
}

function renderMonthlySummary(
  spreadsheet,
  dataSheet,
  summarySheet,
  monthKey,
  allRecords,
  newAttendanceEvents = [],
) {
  const timeZone = spreadsheet.getSpreadsheetTimeZone() || 'Asia/Jakarta';
  const records = allRecords || readAttendanceRecords(dataSheet);
  const previousState = readMonthlySummaryState(summarySheet, timeZone);
  const participantOrder = previousState.order.size
    ? previousState.order
    : readLegacyParticipantOrder(spreadsheet);
  if (!participantOrder.size) {
    const previousOrder = readPreviousMonthOrder(spreadsheet, monthKey);
    previousOrder.forEach((value, key) => participantOrder.set(key, value));
  }
  const corrections = readLegacyAttendanceCorrections(spreadsheet, timeZone);
  previousState.corrections.forEach((value, key) => corrections.set(key, value));
  clearSupersededAttendanceClearCorrections(corrections, newAttendanceEvents);
  const summary = buildMonthlySummary(records, timeZone, monthKey, participantOrder, corrections);
  const firstTotalColumn = 3 + summary.dates.length * DATE_HEADERS.length;
  const lastColumn = firstTotalColumn + TOTAL_HEADERS.length - 1;
  const metadataStartColumn = lastColumn + 1;
  const metadataHeaders = [
    SUMMARY_PARTICIPANT_ID_HEADER,
    ...summary.dates.flatMap((date) => ['check_in', 'late_minutes', 'check_out']
      .map((eventType) => `${SUMMARY_OVERRIDE_PREFIX}${date}__${eventType}`)),
    `${SUMMARY_OVERRIDE_PREFIX}total_late_minutes`,
    ...summary.dates.flatMap((date) => ['check_in', 'late_minutes', 'check_out']
      .map((eventType) => `${SUMMARY_BASELINE_PREFIX}${date}__${eventType}`)),
    `${SUMMARY_BASELINE_PREFIX}total_late_minutes`,
  ];

  const filter = summarySheet.getFilter();
  if (filter) filter.remove();
  showSummaryMetadataColumns(summarySheet, previousState.metadataColumns);
  unmergeSummaryHeaders(summarySheet);
  summarySheet.clear();
  const requiredColumnCount = metadataStartColumn + metadataHeaders.length - 1;
  if (requiredColumnCount > summarySheet.getMaxColumns()) {
    summarySheet.insertColumnsAfter(
      summarySheet.getMaxColumns(),
      requiredColumnCount - summarySheet.getMaxColumns(),
    );
  }

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
  summarySheet.getRange(1, metadataStartColumn, 1, metadataHeaders.length)
    .setValues([metadataHeaders]);
  if (summary.participantIds.length) {
    const metadataRows = summary.participantIds.map((participantId, index) => {
      const totalCorrection = corrections.get(
        attendanceCorrectionKey(participantId, '', 'total_late_minutes'),
      );
      return [
        participantId,
        ...summary.dates.flatMap((date) => ['check_in', 'late_minutes', 'check_out'].map((eventType) => {
          const correction = corrections.get(
            attendanceCorrectionKey(participantId, date, eventType),
          );
          if (!correction) return '';
          return correction.action === 'clear' ? 'clear' : correction.value;
        })),
        totalCorrection
          ? totalCorrection.action === 'clear' ? 'clear' : totalCorrection.value
          : '',
        ...summary.baselineRows[index],
        ...summary.baselineTotalRows[index],
      ];
    });
    summarySheet.getRange(
      3,
      metadataStartColumn,
      metadataRows.length,
      metadataHeaders.length,
    ).setValues(metadataRows);
  }
  summarySheet.hideColumns(metadataStartColumn, metadataHeaders.length);
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
    const key = attendanceCorrectionKey(participantId, date, eventType);
    if (corrections.has(key)) {
      throw new Error(`Koreksi Absensi ganda untuk peserta ${participantId}, tanggal ${date}, ${eventType}.`);
    }
    corrections.set(key, { participantId, date, eventType, action, value: time });
  });
  return corrections;
}

function buildSummaryEditCorrections(
  editedValues,
  rangeFirstRow,
  rangeFirstColumn,
  dataFirstRow,
  participantIds,
  dateByFirstColumn,
  timeZone,
  baselineValues = new Map(),
  existingOverrides = new Map(),
) {
  const corrections = [];
  let unmappedCount = 0;
  editedValues.forEach((row, rowIndex) => {
    const absoluteRow = rangeFirstRow + rowIndex;
    if (absoluteRow < dataFirstRow) return;
    const participantIndex = absoluteRow - dataFirstRow;
    row.forEach((value, columnIndex) => {
      const absoluteColumn = rangeFirstColumn + columnIndex;
      if (absoluteColumn < 3) return;
      const firstTotalColumn = 3 + dateByFirstColumn.size * DATE_HEADERS.length;
      let date = '';
      let columnOffset = -1;
      let eventType = '';
      if (absoluteColumn === firstTotalColumn) {
        eventType = 'total_late_minutes';
      } else {
        columnOffset = (absoluteColumn - 3) % DATE_HEADERS.length;
        const firstDateColumn = absoluteColumn - columnOffset;
        date = dateByFirstColumn.get(firstDateColumn);
        if (!date) return;
        eventType = ['check_in', 'late_minutes', 'check_out'][columnOffset];
      }

      const participantId = String(participantIds[participantIndex] || '').trim();
      if (!/^[1-9]\d*$/.test(participantId)) {
        unmappedCount += 1;
        return;
      }
      const isCleared = value == null || String(value).trim() === '';
      const correctionValue = isCleared
        ? ''
        : normalizeSummaryCorrectionValue(value, eventType, timeZone, absoluteRow);
      const correctionKey = attendanceCorrectionKey(participantId, date, eventType);
      const previousOverride = existingOverrides.get(correctionKey);
      const clearingExplicitOverride = isCleared && previousOverride &&
        previousOverride.toLowerCase() !== 'clear';
      const action = baselineValues.has(correctionKey) &&
          baselineValues.get(correctionKey) === correctionValue && !clearingExplicitOverride
        ? 'inherit'
        : isCleared
          ? 'clear'
          : 'set';
      corrections.push({
        participantId,
        date,
        eventType,
        action,
        value: correctionValue,
      });
    });
  });
  return { corrections, unmappedCount };
}

function attendanceCorrectionKey(participantId, date, eventType) {
  return `${participantId}\u0000${date}\u0000${eventType}`;
}

function clearSupersededAttendanceClearCorrections(corrections, newAttendanceEvents) {
  for (const record of newAttendanceEvents) {
    const eventTypes = record.eventType === 'check_in'
      ? ['check_in', 'late_minutes']
      : record.eventType === 'check_out'
        ? ['check_out']
        : [];
    for (const eventType of eventTypes) {
      const key = attendanceCorrectionKey(record.participantId, record.date, eventType);
      if (corrections.get(key)?.action === 'clear') corrections.delete(key);
    }
  }
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

function normalizeSummaryCorrectionValue(value, eventType, timeZone, rowNumber) {
  if (eventType === 'check_in' || eventType === 'check_out') {
    return normalizeCorrectionTime(value, timeZone, rowNumber);
  }
  const text = String(value).trim();
  const minutes = Number(text);
  if (!text || !Number.isInteger(minutes) || minutes < 0) {
    throw new Error(`Menit keterlambatan pada baris ${rowNumber} harus berupa bilangan bulat nol atau lebih.`);
  }
  return String(minutes);
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
        baselineCheckIn: '',
        checkInTimestamp: null,
        checkOut: '',
        baselineCheckOut: '',
        checkOutTimestamp: null,
        lateMinutes: 0,
        baselineLateMinutes: 0,
        lateMinutesPresent: false,
      };
      participant.days.set(date, day);
    }

    const timestamp = parseTimestamp(record.client_timestamp);
    if (record.event_type === 'check_in') {
      day.checkedIn = true;
      day.lateMinutes = Math.max(day.lateMinutes, Number(record.late_minutes) || 0);
      day.baselineLateMinutes = day.lateMinutes;
      day.lateMinutesPresent = true;
      if (timestamp && (!day.checkInTimestamp || timestamp < day.checkInTimestamp)) {
        day.checkInTimestamp = timestamp;
        day.checkIn = formatClock(record.client_timestamp, timeZone);
        day.baselineCheckIn = day.checkIn;
      }
    } else if (timestamp && (!day.checkOutTimestamp || timestamp > day.checkOutTimestamp)) {
      day.checkOutTimestamp = timestamp;
      day.checkOut = formatClock(record.client_timestamp, timeZone);
      day.baselineCheckOut = day.checkOut;
    }
    dates.add(date);
  }

  for (const correction of corrections.values()) {
    if (correction.eventType !== 'total_late_minutes' &&
        correction.date.slice(0, 7) !== monthKey) continue;
    const participant = participants.get(`id:${correction.participantId}`);
    if (!participant) continue;
    if (correction.eventType === 'total_late_minutes') continue;
    const day = participant?.days.get(correction.date);
    if (!day) continue;
    const value = correction.action === 'clear' ? '' : correction.value;
    if (correction.eventType === 'check_in') day.checkIn = value;
    else if (correction.eventType === 'check_out') day.checkOut = value;
    else if (correction.eventType === 'late_minutes') {
      day.lateMinutes = correction.action === 'clear' ? 0 : Number(correction.value);
      day.lateMinutesPresent = correction.action !== 'clear';
    }
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
  const baselineRows = sortedParticipants.map((participant) => {
    const row = [];
    for (const date of sortedDates) {
      const day = participant.days.get(date);
      row.push(
        day?.baselineCheckIn || '',
        day?.checkedIn ? day.baselineLateMinutes : '',
        day?.baselineCheckOut || '',
      );
    }
    return row;
  });
  const baselineTotalRows = [];
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
        day?.lateMinutesPresent ? day.lateMinutes : '',
        day?.checkOut || '',
      );
    }
    baselineTotalRows[index] = [totalLateMinutes];
    const totalCorrection = corrections.get(
      attendanceCorrectionKey(String(participant.id || ''), '', 'total_late_minutes'),
    );
    row.push(
      totalCorrection
        ? totalCorrection.action === 'clear' ? '' : Number(totalCorrection.value)
        : totalLateMinutes,
      totalAttendance,
    );
    return row;
  });
  return {
    dates: sortedDates,
    rows,
    baselineRows,
    baselineTotalRows,
    participantIds: sortedParticipants.map((participant) => participant.id),
  };
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
