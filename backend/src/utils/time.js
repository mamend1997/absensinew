export function localDateTimeParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    seconds:
      Number(values.hour) * 3600 +
      Number(values.minute) * 60 +
      Number(values.second),
  };
}

export function toSqlUtc(date) {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

export function fromSqlUtc(value) {
  if (value instanceof Date) return value.toISOString();
  const normalized = String(value).replace(' ', 'T');
  return new Date(`${normalized}Z`).toISOString();
}

export function addCalendarDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
