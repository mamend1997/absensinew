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

export function aggregatePermissionAttendanceReport(records) {
  const groups = new Map();
  for (const record of records) {
    if (!['permission_out', 'permission_in'].includes(record.event_type)) continue;
    const key = `${record.attendance_date}:${record.participant_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        attendance_date: String(record.attendance_date).slice(0, 10),
        participant_id: String(record.participant_id),
        participant_name: record.participant_name,
        participant_code: record.participant_code,
        classroom_name: record.classroom_name,
        events: [],
      });
    }
    const timestamp = String(record.client_timestamp_utc);
    const normalizedTimestamp = /(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp)
      ? timestamp
      : `${timestamp.replace(' ', 'T')}Z`;
    groups.get(key).events.push({
      id: record.id_unik,
      event_type: record.event_type,
      timestamp: normalizedTimestamp,
      timestamp_ms: Date.parse(normalizedTimestamp),
    });
  }

  const rows = [];
  for (const group of groups.values()) {
    group.events.sort((left, right) =>
      left.timestamp_ms - right.timestamp_ms || left.id.localeCompare(right.id),
    );
    const outings = [];
    for (const event of group.events) {
      if (event.event_type === 'permission_out') {
        const outing = {
          id: event.id,
          return_id: null,
          attendance_date: group.attendance_date,
          participant_id: group.participant_id,
          participant_name: group.participant_name,
          participant_code: group.participant_code,
          classroom_name: group.classroom_name,
          permission_out_at: event.timestamp,
          permission_in_at: null,
          duration_minutes: null,
          duration_ms: null,
          timestamp_ms: event.timestamp_ms,
        };
        outings.push(outing);
        continue;
      }

      const outing = outings.find((item) =>
        item.return_id === null && item.timestamp_ms <= event.timestamp_ms,
      );
      if (!outing) continue;
      outing.return_id = event.id;
      outing.permission_in_at = event.timestamp;
      outing.duration_ms = event.timestamp_ms - outing.timestamp_ms;
      outing.duration_minutes = Math.round(outing.duration_ms / 6000) / 10;
    }
    rows.push(...outings);
  }

  return rows.sort((left, right) =>
    left.attendance_date.localeCompare(right.attendance_date) ||
    left.classroom_name.localeCompare(right.classroom_name) ||
    left.participant_name.localeCompare(right.participant_name) ||
    left.timestamp_ms - right.timestamp_ms,
  ).map(({ timestamp_ms: _timestamp, ...row }) => row);
}
