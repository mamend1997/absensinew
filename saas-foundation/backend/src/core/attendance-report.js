export function aggregateAttendanceReport(records) {
  const rows = new Map();
  for (const record of records) {
    const key = `${record.attendance_date}:${record.participant_id}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        attendance_date: String(record.attendance_date).slice(0, 10),
        participant_id: String(record.participant_id),
        participant_code: record.participant_code,
        participant_name: record.participant_name,
        classroom_name: record.classroom_name,
        check_in_at: null,
        check_out_at: null,
        attendance_status: null,
        late_minutes: 0,
      };
      rows.set(key, row);
    }

    const timestamp = String(record.client_timestamp_utc);
    if (record.event_type === 'check_in') {
      if (!row.check_in_at || timestamp < row.check_in_at) {
        row.check_in_at = timestamp;
        row.attendance_status = record.attendance_status;
        row.late_minutes = Number(record.late_minutes) || 0;
      }
    } else if (record.event_type === 'check_out' &&
        (!row.check_out_at || timestamp > row.check_out_at)) {
      row.check_out_at = timestamp;
      if (!row.attendance_status) row.attendance_status = 'pulang';
    }
  }
  return [...rows.values()].sort((left, right) =>
    left.attendance_date.localeCompare(right.attendance_date) ||
    left.classroom_name.localeCompare(right.classroom_name) ||
    left.participant_name.localeCompare(right.participant_name),
  );
}
