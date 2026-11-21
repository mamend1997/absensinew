const SHEET_NAME = 'Absensi';
const HEADERS = [
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
    const sheet = spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
    if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
    const lastRow = sheet.getLastRow();
    const existing = new Set(lastRow > 1
      ? sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues().flat()
      : []);
    const acceptedIds = [];
    for (const record of request.records) {
      if (!record || typeof record.id_unik !== 'string' || !record.id_unik) {
        return jsonResponse({ ok: false, error: 'invalid_record', accepted_ids: acceptedIds });
      }
      if (!existing.has(record.id_unik)) {
        sheet.appendRow(HEADERS.map((header) => safeCell(record[header])));
        existing.add(record.id_unik);
      }
      acceptedIds.push(record.id_unik);
    }
    return jsonResponse({ ok: true, accepted_ids: acceptedIds });
  } catch (error) {
    return jsonResponse({ ok: false, error: 'sync_failed', accepted_ids: [] });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function safeCell(value) {
  const text = value == null ? '' : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
