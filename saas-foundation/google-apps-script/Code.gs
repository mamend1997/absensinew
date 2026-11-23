const DATA_SHEET_NAME = 'Absensi';
const LEGACY_SUMMARY_SHEET_NAME = 'Rekap Bulanan';
const LEGACY_ORDER_SHEET_NAME = 'Urutan Peserta';
const LEGACY_CORRECTIONS_SHEET_NAME = 'Koreksi Absensi';
const PERMISSION_SHEET_PREFIX = 'Izin ';
const PERMISSION_CORRECTIONS_SHEET_NAME = 'Koreksi Izin';
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
  'scheduled_check_out',
];
const LEGACY_DATA_HEADERS = DATA_HEADERS.slice(0, -2);
const SUMMARY_EVENT_HEADERS = ['check_in', 'late_minutes', 'check_out', 'check_out_diff'];
const DATE_HEADERS = ['Masuk', 'Terlambat', 'Keluar', 'Selisih Menit Keluar'];
const TOTAL_HEADERS = ['Total Terlambat', 'Total Hadir', 'Total Selisih Menit Keluar'];
const ORDER_HEADERS = ['participant_id', 'Nama Peserta', 'Kode Peserta'];
const CORRECTION_HEADERS = [
  'participant_id',
  'Nama Peserta',
  'Tanggal',
  'Jenis',
  'Aksi',
  'Waktu Koreksi',
];
const PERMISSION_CORRECTION_HEADERS = [
  'id_unik',
  'participant_id',
  'Tanggal',
  'Jenis',
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
  const summaryLayout = getSummaryDateLayout(summarySheet, participantIdColumn);
  const dateByFirstColumn = summaryLayout.dateColumns;
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
    summaryLayout.stride,
    summaryLayout.firstTotalColumn,
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
          LEGACY_CORRECTIONS_SHEET_NAME,
          PERMISSION_CORRECTIONS_SHEET_NAME].includes(sheet.getName()))
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
      {
        rowNumber: index + 2,
        participantId: String(row[DATA_HEADERS.indexOf('participant_id')] || ''),
        scheduledCheckOut: String(row[DATA_HEADERS.indexOf('scheduled_check_out')] || ''),
      },
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
          !['check_in', 'check_out', 'permission_check_out', 'permission_out', 'permission_in'].includes(record.event_type) ||
          !parseTimestamp(record.client_timestamp) ||
          ((record.event_type === 'check_in' || record.event_type === 'check_out' ||
            record.event_type === 'permission_check_out') &&
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
          scheduledCheckOut: String(record.scheduled_check_out || ''),
        });
      } else {
        if (record.participant_id != null && !existingRecord.participantId) {
          dataSheet.getRange(
            existingRecord.rowNumber,
            DATA_HEADERS.indexOf('participant_id') + 1,
          )
            .setValue(safeCell(record.participant_id));
          existingRecord.participantId = String(record.participant_id);
        }
        existingRecord.scheduledCheckOut = fillMissingScheduledCheckOut(
          dataSheet,
          existingRecord.rowNumber,
          existingRecord.scheduledCheckOut,
          record.scheduled_check_out,
        );
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

function fillMissingScheduledCheckOut(dataSheet, rowNumber, existingValue, newValue) {
  const existing = String(existingValue || '').trim();
  const scheduledCheckOut = String(newValue || '').trim();
  if (existing || !scheduledCheckOut) return existing;
  dataSheet.getRange(
    rowNumber,
    DATA_HEADERS.indexOf('scheduled_check_out') + 1,
  ).setValue(safeCell(scheduledCheckOut));
  return scheduledCheckOut;
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
      const participantIdHeader = String(headers[LEGACY_DATA_HEADERS.length] || '').trim();
      const scheduledCheckOutHeader = String(
        headers[LEGACY_DATA_HEADERS.length + 1] || '',
      ).trim();
      const unexpectedHeaders = headers.slice(LEGACY_DATA_HEADERS.length + 2)
        .some((header) => String(header || '').trim() !== '');
      if (!hasLegacyHeaders ||
          (participantIdHeader && participantIdHeader !== 'participant_id') ||
          (scheduledCheckOutHeader && scheduledCheckOutHeader !== 'scheduled_check_out') ||
          unexpectedHeaders) {
        throw new Error('Invalid data sheet headers');
      }
      sheet.getRange(1, LEGACY_DATA_HEADERS.length + 1)
        .setValue('participant_id');
      sheet.getRange(1, LEGACY_DATA_HEADERS.length + 2)
        .setValue('scheduled_check_out');
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

function buildPermissionSummary(records, timeZone, deletedEventIds = new Set()) {
  const permissionRecords = (records || [])
    .filter((record) => ['permission_out', 'permission_in'].includes(record.event_type))
    .filter((record) => !deletedEventIds.has(String(record.id_unik || '')))
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
  const participantIds = [];
  Array.from(participants.values())
    .sort((left, right) => left.name.localeCompare(right.name))
    .forEach((participant) => {
      const row = [rows.length + 1, participant.name];
      let totalDurationMilliseconds = 0;
      let totalCount = 0;
      sortedDates.forEach((date) => {
        const day = participant.permissionsByDate.get(date);
        if (!day) {
          row.push('', '', '');
          return;
        }
        day.outs.sort((left, right) => left.getTime() - right.getTime());
        day.ins.sort((left, right) => left.getTime() - right.getTime());
        let dayDurationMilliseconds = 0;
        const outValues = [];
        const inValues = [];
        day.outs.forEach((outTimestamp) => {
          const returnTimestamp = day.ins.find((inTimestamp) =>
            inTimestamp.getTime() >= outTimestamp.getTime());
          if (returnTimestamp) {
            day.ins = day.ins.filter((inTimestamp) => inTimestamp !== returnTimestamp);
            const durationMilliseconds = Math.max(
              0,
              returnTimestamp.getTime() - outTimestamp.getTime(),
            );
            dayDurationMilliseconds += durationMilliseconds;
            totalDurationMilliseconds += durationMilliseconds;
            totalCount += 1;
            outValues.push(formatClock(outTimestamp, timeZone));
            inValues.push(formatClock(returnTimestamp, timeZone));
          } else {
            outValues.push(formatClock(outTimestamp, timeZone));
            inValues.push('');
          }
        });
        const dayMinutes = roundDurationMillisecondsToMinutes(dayDurationMilliseconds);
        row.push(outValues.join('\n'), inValues.join('\n'), dayMinutes || '');
      });
      row.push(
        roundDurationMillisecondsToMinutes(totalDurationMilliseconds),
        totalCount,
      );
      rows.push(row);
      participantIds.push(participant.participantId);
    });

  return { topHeaders, subHeaders, rows, sortedDates, participantIds };
}

function renderPermissionSummary(spreadsheet, monthKey, records, timeZone) {
  const sheetName = permissionSheetName(monthKey);
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
  sheet.showSheet();
  sheet.showColumns(1, sheet.getMaxColumns());
  sheet.clear();

  const deletedEventIds = readDeletedPermissionEventIds(spreadsheet);
  const summary = buildPermissionSummary(records, timeZone, deletedEventIds);
  const columnCount = summary.topHeaders.length;
  const participantIdColumn = columnCount + 1;
  if (participantIdColumn > sheet.getMaxColumns()) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      participantIdColumn - sheet.getMaxColumns(),
    );
  }
  sheet.getRange(1, 1, 1, columnCount).setValues([summary.topHeaders]);
  sheet.getRange(2, 1, 1, columnCount).setValues([summary.subHeaders]);
  sheet.getRange(1, participantIdColumn).setValue('__permission_participant_id');
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
    sheet.getRange(3, participantIdColumn, summary.participantIds.length, 1)
      .setValues(summary.participantIds.map((participantId) => [participantId]));
  }

  sheet.setColumnWidth(1, 50);
  sheet.setColumnWidth(2, 220);
  for (let column = 3; column <= columnCount; column += 1) {
    sheet.setColumnWidth(column, column <= columnCount - 2 ? 130 : 170);
  }
  const dataRowCount = Math.max(summary.rows.length, 1);
  for (let index = 0; index < summary.sortedDates.length; index += 1) {
    sheet.getRange(3, 5 + index * 3, dataRowCount, 1).setNumberFormat('0.0');
  }
  sheet.getRange(3, columnCount - 1, dataRowCount, 1).setNumberFormat('0.0');
  sheet.hideColumns(participantIdColumn);
  return sheet;
}

function roundDurationMillisecondsToMinutes(durationMilliseconds) {
  if (durationMilliseconds <= 0) return 0;
  return Math.max(0.1, Math.round((durationMilliseconds / 60000) * 10) / 10);
}

function savePermissionSheetEdit(event) {
  const sheet = event.range.getSheet();
  const spreadsheet = event.source;
  const timeZone = spreadsheet.getSpreadsheetTimeZone() || 'Asia/Jakarta';
  const dataSheet = getDataSheet(spreadsheet);
  const records = readAttendanceRecords(dataSheet);
  const metadataColumn = sheet.getLastColumn();
  const editedValues = event.range.getDisplayValues();
  const participantIds = sheet.getRange(
    event.range.getRow(),
    metadataColumn,
    event.range.getNumRows(),
    1,
  ).getDisplayValues();
  const correctionChanges = new Map();
  let invalidEditCount = 0;

  editedValues.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      const rowNumber = event.range.getRow() + rowIndex;
      const columnNumber = event.range.getColumn() + columnIndex;
      if (rowNumber < 3 || columnNumber < 3) return;
      const dateStartColumn = 3 + Math.floor((columnNumber - 3) / 3) * 3;
      const eventOffset = (columnNumber - 3) % 3;
      if (eventOffset === 2) return;
      const dateLabel = String(sheet.getRange(1, dateStartColumn).getDisplayValue() || '').trim();
      const dateMatch = /^(\d{2})-(\d{2})-(\d{4})$/.exec(dateLabel);
      const participantId = String(participantIds[rowIndex] && participantIds[rowIndex][0] || '').trim();
      if (!dateMatch || !participantId) {
        invalidEditCount += 1;
        return;
      }
      const date = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
      const eventType = eventOffset === 0 ? 'permission_out' : 'permission_in';
      const matchingRecords = records
        .filter((record) =>
          String(
            record.participant_id ||
            record.participant_code ||
            record.participant_name ||
            '',
          ).trim() === participantId &&
          attendanceDateKey(record.attendance_date, timeZone) === date &&
          record.event_type === eventType)
        .sort((left, right) => {
          const timeDifference = parseTimestamp(left.client_timestamp) -
            parseTimestamp(right.client_timestamp);
          return timeDifference || String(left.id_unik).localeCompare(String(right.id_unik));
        });
      if (matchingRecords.some((record) => !String(record.id_unik || '').trim())) {
        invalidEditCount += 1;
        return;
      }
      const requestedTimes = parsePermissionTimes(value);
      if (!requestedTimes) {
        invalidEditCount += 1;
        return;
      }
      const desiredEventIds = permissionEventIdsForTimes(
        matchingRecords,
        requestedTimes,
        timeZone,
      );
      if (!desiredEventIds) {
        invalidEditCount += 1;
        return;
      }
      matchingRecords.forEach((record) => {
        correctionChanges.set(String(record.id_unik), {
          id: String(record.id_unik),
          participantId,
          date,
          eventType,
          deleted: !desiredEventIds.has(String(record.id_unik)),
        });
      });
    });
  });

  if (!correctionChanges.size) {
    if (invalidEditCount) {
      spreadsheet.toast(
        'Edit tidak tersimpan. Hapus hanya waktu yang sudah tercatat; waktu baru harus dibuat dengan scan.',
        'Rekap Izin',
        8,
      );
      renderPermissionSummary(spreadsheet, monthKeyFromSheetName(sheet.getName()), records, timeZone);
    }
    return;
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    savePermissionCorrectionChanges(spreadsheet, correctionChanges);
    renderPermissionSummary(
      spreadsheet,
      monthKeyFromSheetName(sheet.getName()),
      records,
      timeZone,
    );
    spreadsheet.toast(
      invalidEditCount
        ? 'Penghapusan waktu tersimpan. Edit lain diabaikan karena waktu tidak cocok dengan scan.'
        : 'Perubahan waktu izin tersimpan dan tidak akan muncul kembali.',
      'Rekap Izin',
      6,
    );
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function parsePermissionTimes(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const times = [];
  for (const rawTime of text.split(/\r?\n/)) {
    const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(rawTime.trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3] || 0);
    if (hour > 23 || minute > 59 || second > 59) return null;
    times.push(`${match[1]}:${match[2]}:${String(second).padStart(2, '0')}`);
  }
  return times;
}

function permissionEventIdsForTimes(records, requestedTimes, timeZone) {
  const unusedRecords = records.slice();
  const desiredEventIds = new Set();
  for (const requestedTime of requestedTimes) {
    const matchIndex = unusedRecords.findIndex((record) =>
      formatClock(record.client_timestamp, timeZone) === requestedTime);
    if (matchIndex < 0) return null;
    const [record] = unusedRecords.splice(matchIndex, 1);
    desiredEventIds.add(String(record.id_unik));
  }
  return desiredEventIds;
}

function getPermissionCorrectionSheet(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(PERMISSION_CORRECTIONS_SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(PERMISSION_CORRECTIONS_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, PERMISSION_CORRECTION_HEADERS.length)
      .setValues([PERMISSION_CORRECTION_HEADERS]);
  } else {
    const headers = sheet.getRange(1, 1, 1, PERMISSION_CORRECTION_HEADERS.length)
      .getDisplayValues()[0];
    if (PERMISSION_CORRECTION_HEADERS.some((header, index) => headers[index] !== header)) {
      throw new Error(`Invalid headers in ${PERMISSION_CORRECTIONS_SHEET_NAME}`);
    }
  }
  return sheet;
}

function readDeletedPermissionEventIds(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(PERMISSION_CORRECTIONS_SHEET_NAME);
  if (!sheet || sheet.getLastRow() <= 1) return new Set();
  const headers = sheet.getRange(1, 1, 1, PERMISSION_CORRECTION_HEADERS.length)
    .getDisplayValues()[0];
  if (PERMISSION_CORRECTION_HEADERS.some((header, index) => headers[index] !== header)) {
    throw new Error(`Invalid headers in ${PERMISSION_CORRECTIONS_SHEET_NAME}`);
  }
  return new Set(sheet.getRange(
    2,
    1,
    sheet.getLastRow() - 1,
    PERMISSION_CORRECTION_HEADERS.length,
  ).getDisplayValues()
    .filter((row) => String(row[0] || '').trim())
    .map((row) => String(row[0]).trim()));
}

function savePermissionCorrectionChanges(spreadsheet, changes) {
  const sheet = getPermissionCorrectionSheet(spreadsheet);
  const existingRows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, PERMISSION_CORRECTION_HEADERS.length)
      .getDisplayValues()
    : [];
  const rowsById = new Map(existingRows
    .filter((row) => String(row[0] || '').trim())
    .map((row) => [String(row[0]).trim(), row]));
  changes.forEach((change) => {
    if (change.deleted) {
      rowsById.set(change.id, [
        change.id,
        change.participantId,
        change.date,
        change.eventType,
      ]);
    } else {
      rowsById.delete(change.id);
    }
  });
  sheet.clearContents();
  sheet.getRange(1, 1, 1, PERMISSION_CORRECTION_HEADERS.length)
    .setValues([PERMISSION_CORRECTION_HEADERS]);
  const rows = Array.from(rowsById.values());
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, PERMISSION_CORRECTION_HEADERS.length).setValues(rows);
  }
  sheet.hideSheet();
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
      `^${SUMMARY_OVERRIDE_PREFIX}(\\d{4}-\\d{2}-\\d{2})__(check_in|late_minutes|check_out|check_out_diff)$`,
    ).exec(text);
    const totalMatch = new RegExp(
      `^${SUMMARY_OVERRIDE_PREFIX}(total_late_minutes|total_attendance|total_checkout_diff)$`,
    ).exec(text);
    if (match) {
      correctionColumns.set(attendanceCorrectionKey('', match[1], match[2]), index + 1);
    } else if (totalMatch) {
      correctionColumns.set(attendanceCorrectionKey('', '', totalMatch[1]), index + 1);
    } else {
      return;
    }
    columns.push(index + 1);
  });
  const baselineColumns = new Map();
  headers.forEach((header, index) => {
    const text = String(header || '');
    const match = new RegExp(
      `^${SUMMARY_BASELINE_PREFIX}(\\d{4}-\\d{2}-\\d{2})__(check_in|late_minutes|check_out|check_out_diff)$`,
    ).exec(text);
    const totalMatch = new RegExp(
      `^${SUMMARY_BASELINE_PREFIX}(total_late_minutes|total_attendance|total_checkout_diff)$`,
    ).exec(text);
    if (match) {
      baselineColumns.set(attendanceCorrectionKey('', match[1], match[2]), index + 1);
    } else if (totalMatch) {
      baselineColumns.set(attendanceCorrectionKey('', '', totalMatch[1]), index + 1);
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
  return getSummaryDateLayout(sheet, participantIdColumn).dateColumns;
}

function getSummaryDateLayout(sheet, participantIdColumn) {
  const dateColumns = new Map();
  if (participantIdColumn <= 3) {
    return {
      dateColumns,
      stride: DATE_HEADERS.length,
      firstTotalColumn: 3,
    };
  }
  const headers = sheet.getRange(1, 3, 1, participantIdColumn - 3).getDisplayValues()[0];
  for (let index = 0; index < headers.length; index += 1) {
    const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(headers[index] || '').trim());
    if (match) {
      dateColumns.set(
        index + 3,
        `${match[3]}-${match[2]}-${match[1]}`,
      );
    }
  }
  const totalHeaderIndex = headers.findIndex((header) => String(header || '').trim() === TOTAL_HEADERS[0]);
  const firstTotalColumn = totalHeaderIndex >= 0
    ? totalHeaderIndex + 3
    : 3 + dateColumns.size * DATE_HEADERS.length;
  return {
    dateColumns,
    stride: dateColumns.size ? (firstTotalColumn - 3) / dateColumns.size : DATE_HEADERS.length,
    firstTotalColumn,
  };
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
  const summaryLayout = getSummaryDateLayout(sheet, metadata.participantIdColumn);
  const dateColumns = summaryLayout.dateColumns;
  const firstColumnByDate = new Map(
    Array.from(dateColumns.entries()).map(([column, date]) => [date, column]),
  );
  const firstTotalColumn = summaryLayout.firstTotalColumn;
  corrections.forEach((correction) => {
    const row = participantRows.get(correction.participantId);
    const metadataColumn = metadata.correctionColumns.get(
      attendanceCorrectionKey('', correction.date, correction.eventType),
    );
    const firstColumn = correction.eventType === 'total_late_minutes'
      ? firstTotalColumn
      : correction.eventType === 'total_attendance'
        ? firstTotalColumn + 1
        : correction.eventType === 'total_checkout_diff'
          ? firstTotalColumn + 2
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
    const visibleColumn = ['total_late_minutes', 'total_attendance', 'total_checkout_diff']
      .includes(correction.eventType)
      ? firstColumn
      : firstColumn + (
        correction.eventType === 'check_in' ? 0
          : correction.eventType === 'late_minutes' ? 1
            : correction.eventType === 'check_out' ? 2
              : 3
      );
    sheet.getRange(row, visibleColumn)
      .setValue(correction.action === 'clear'
        ? ''
        : [
          'late_minutes',
          'total_late_minutes',
          'total_attendance',
          'check_out_diff',
          'total_checkout_diff',
        ].includes(correction.eventType)
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
    ...summary.dates.flatMap((date) => SUMMARY_EVENT_HEADERS
      .map((eventType) => `${SUMMARY_OVERRIDE_PREFIX}${date}__${eventType}`)),
    `${SUMMARY_OVERRIDE_PREFIX}total_late_minutes`,
    `${SUMMARY_OVERRIDE_PREFIX}total_attendance`,
    `${SUMMARY_OVERRIDE_PREFIX}total_checkout_diff`,
    ...summary.dates.flatMap((date) => SUMMARY_EVENT_HEADERS
      .map((eventType) => `${SUMMARY_BASELINE_PREFIX}${date}__${eventType}`)),
    `${SUMMARY_BASELINE_PREFIX}total_late_minutes`,
    `${SUMMARY_BASELINE_PREFIX}total_attendance`,
    `${SUMMARY_BASELINE_PREFIX}total_checkout_diff`,
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
  summarySheet.getRange(1, firstTotalColumn + 2, 2, 1).merge().setValue(TOTAL_HEADERS[2]);
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
      const attendanceCorrection = corrections.get(
        attendanceCorrectionKey(participantId, '', 'total_attendance'),
      );
      const checkoutDiffCorrection = corrections.get(
        attendanceCorrectionKey(participantId, '', 'total_checkout_diff'),
      );
      return [
        participantId,
        ...summary.dates.flatMap((date) => SUMMARY_EVENT_HEADERS.map((eventType) => {
          const correction = corrections.get(
            attendanceCorrectionKey(participantId, date, eventType),
          );
          if (!correction) return '';
          return correction.action === 'clear' ? 'clear' : correction.value;
        })),
        totalCorrection
          ? totalCorrection.action === 'clear' ? 'clear' : totalCorrection.value
          : '',
        attendanceCorrection
          ? attendanceCorrection.action === 'clear' ? 'clear' : attendanceCorrection.value
          : '',
        checkoutDiffCorrection
          ? checkoutDiffCorrection.action === 'clear' ? 'clear' : checkoutDiffCorrection.value
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
  const dataRowCount = Math.max(summary.rows.length, 1);
  summary.dates.forEach((_date, index) => {
    summarySheet.getRange(3, 4 + index * DATE_HEADERS.length, dataRowCount, 1)
      .setNumberFormat('0.0');
    summarySheet.getRange(3, 6 + index * DATE_HEADERS.length, dataRowCount, 1)
      .setNumberFormat('+0.#;-0.#;0');
  });
  summarySheet.getRange(3, firstTotalColumn, dataRowCount, 1).setNumberFormat('0.0');
  summarySheet.getRange(3, firstTotalColumn + 2, dataRowCount, 1)
    .setNumberFormat('+0.#;-0.#;0');
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
  summarySheet.setColumnWidth(firstTotalColumn + 2, 150);
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
  dateStride = DATE_HEADERS.length,
  firstTotalColumn = 3 + dateByFirstColumn.size * DATE_HEADERS.length,
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
      let date = '';
      let eventType = '';
      if (absoluteColumn === firstTotalColumn) {
        eventType = 'total_late_minutes';
      } else if (absoluteColumn === firstTotalColumn + 1) {
        eventType = 'total_attendance';
      } else if (absoluteColumn === firstTotalColumn + 2) {
        eventType = 'total_checkout_diff';
      } else {
        const firstDateColumn = Array.from(dateByFirstColumn.keys())
          .filter((column) => column <= absoluteColumn)
          .sort((left, right) => right - left)[0];
        if (firstDateColumn == null || absoluteColumn >= firstDateColumn + dateStride) return;
        const columnOffset = absoluteColumn - firstDateColumn;
        date = dateByFirstColumn.get(firstDateColumn);
        if (!date) return;
        eventType = SUMMARY_EVENT_HEADERS[columnOffset];
        if (!eventType) return;
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
      ? ['check_in', 'late_minutes', 'total_late_minutes', 'total_attendance']
      : ['check_out', 'permission_check_out'].includes(record.eventType)
        ? ['check_out', 'check_out_diff', 'total_checkout_diff']
        : [];
    for (const eventType of eventTypes) {
      const correctionDate = eventType.startsWith('total_') ? '' : record.date;
      const key = attendanceCorrectionKey(record.participantId, correctionDate, eventType);
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
  if (eventType === 'check_out_diff' || eventType === 'total_checkout_diff') {
    if (!text || !Number.isFinite(minutes) || Math.abs(minutes) > 65535 ||
        Math.abs(minutes * 10 - Math.round(minutes * 10)) > 1e-8) {
      throw new Error(`Selisih menit keluar pada baris ${rowNumber} harus berupa angka antara -65535 dan 65535 dengan maksimal satu angka desimal.`);
    }
    return String(Math.round(minutes * 10) / 10);
  }
  if (eventType === 'total_attendance') {
    if (!text || !Number.isInteger(minutes) || minutes < 0 || minutes > 31) {
      throw new Error(`Total hadir pada baris ${rowNumber} harus berupa bilangan bulat dari 0 sampai 31.`);
    }
    return String(minutes);
  }
  if (!text || !Number.isFinite(minutes) || minutes < 0 || minutes > 65535 ||
      Math.abs(minutes * 10 - Math.round(minutes * 10)) > 1e-8) {
    throw new Error(`Menit keterlambatan pada baris ${rowNumber} harus berupa angka nol atau lebih dengan maksimal satu angka desimal.`);
  }
  return String(roundMinutesToTenth(minutes));
}

function compareParticipantIds(left, right) {
  const leftId = String(left).replace(/^0+(?=\d)/, '');
  const rightId = String(right).replace(/^0+(?=\d)/, '');
  return leftId.length - rightId.length || leftId.localeCompare(rightId);
}

function clockSeconds(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(String(value || ''));
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0);
}

function checkoutDifferenceMinutes(actualClock, scheduledClock) {
  const actualSeconds = clockSeconds(actualClock);
  const scheduledSeconds = clockSeconds(scheduledClock);
  if (actualSeconds == null || scheduledSeconds == null) return null;
  const difference = actualSeconds - scheduledSeconds;
  return Math.sign(difference) * Math.round(Math.abs(difference) / 6) / 10;
}

function buildMonthlySummary(records, timeZone, monthKey, participantOrder = new Map(), corrections = new Map()) {
  const dates = new Set();
  const participants = new Map();

  for (const record of records) {
    const date = attendanceDateKey(record.attendance_date, timeZone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 7) !== monthKey) continue;
    if (!['check_in', 'check_out', 'permission_check_out'].includes(record.event_type)) continue;

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
        checkOutDiff: null,
        baselineCheckOutDiff: null,
        scheduledCheckOut: '',
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
      day.scheduledCheckOut = String(record.scheduled_check_out || '');
      day.checkOutDiff = checkoutDifferenceMinutes(day.checkOut, day.scheduledCheckOut);
      day.baselineCheckOutDiff = day.checkOutDiff;
    }
    dates.add(date);
  }

  for (const correction of corrections.values()) {
    if (!['total_late_minutes', 'total_attendance', 'total_checkout_diff'].includes(correction.eventType) &&
        correction.date.slice(0, 7) !== monthKey) continue;
    const participant = participants.get(`id:${correction.participantId}`);
    if (!participant) continue;
    if (['total_late_minutes', 'total_attendance', 'total_checkout_diff'].includes(correction.eventType)) continue;
    const day = participant?.days.get(correction.date);
    if (!day) continue;
    const value = correction.action === 'clear' ? '' : correction.value;
    if (correction.eventType === 'check_in') day.checkIn = value;
    else if (correction.eventType === 'check_out') day.checkOut = value;
    else if (correction.eventType === 'check_out_diff') {
      day.checkOutDiff = correction.action === 'clear' ? null : Number(correction.value);
    }
    else if (correction.eventType === 'late_minutes') {
      day.lateMinutes = correction.action === 'clear' ? 0 : Number(correction.value);
      day.lateMinutesPresent = correction.action !== 'clear';
    }
  }

  participants.forEach((participant) => {
    participant.days.forEach((day, date) => {
      const correctionKey = attendanceCorrectionKey(
        String(participant.id || ''),
        date,
        'check_out_diff',
      );
      if (!corrections.has(correctionKey)) {
        day.checkOutDiff = checkoutDifferenceMinutes(day.checkOut, day.scheduledCheckOut);
      }
    });
  });

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
        day?.baselineCheckOutDiff ?? '',
      );
    }
    return row;
  });
  const baselineTotalRows = [];
  const rows = sortedParticipants.map((participant, index) => {
    let totalLateMinutes = 0;
    let totalAttendance = 0;
    let totalCheckoutDiff = 0;
    let baselineTotalCheckoutDiff = 0;
    let checkoutDiffCount = 0;
    let baselineCheckoutDiffCount = 0;
    const row = [index + 1, participant.name];
    for (const date of sortedDates) {
      const day = participant.days.get(date);
      if (day && day.checkedIn) {
        totalAttendance += 1;
        totalLateMinutes += day.lateMinutes;
      }
      if (day?.checkOutDiff != null) {
        totalCheckoutDiff += day.checkOutDiff;
        checkoutDiffCount += 1;
      }
      if (day?.baselineCheckOutDiff != null) {
        baselineTotalCheckoutDiff += day.baselineCheckOutDiff;
        baselineCheckoutDiffCount += 1;
      }
      row.push(
        day?.checkIn || '',
        day?.lateMinutesPresent ? day.lateMinutes : '',
        day?.checkOut || '',
        day?.checkOutDiff ?? '',
      );
    }
    baselineTotalRows[index] = [
      roundMinutesToTenth(totalLateMinutes),
      totalAttendance,
      baselineCheckoutDiffCount
        ? Math.round(baselineTotalCheckoutDiff * 10) / 10
        : '',
    ];
    const totalCorrection = corrections.get(
      attendanceCorrectionKey(String(participant.id || ''), '', 'total_late_minutes'),
    );
    const attendanceCorrection = corrections.get(
      attendanceCorrectionKey(String(participant.id || ''), '', 'total_attendance'),
    );
    const checkoutDiffCorrection = corrections.get(
      attendanceCorrectionKey(String(participant.id || ''), '', 'total_checkout_diff'),
    );
    row.push(
      totalCorrection
        ? totalCorrection.action === 'clear' ? '' : Number(totalCorrection.value)
        : roundMinutesToTenth(totalLateMinutes),
      attendanceCorrection
        ? attendanceCorrection.action === 'clear' ? '' : Number(attendanceCorrection.value)
        : totalAttendance,
      checkoutDiffCorrection
        ? checkoutDiffCorrection.action === 'clear' ? '' : Number(checkoutDiffCorrection.value)
        : checkoutDiffCount
          ? Math.round(totalCheckoutDiff * 10) / 10
          : '',
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

function roundMinutesToTenth(minutes) {
  return Math.round((Number(minutes) + Number.EPSILON) * 10) / 10;
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
