import { useEffect, useMemo, useState } from 'react';
import writeXlsxFile, { type Cell, type SheetData } from 'write-excel-file/browser';
import { api } from '../lib/api';
import type { Participant, ReportResponse, ReportRow } from '../types';

interface DashboardProps {
  participants: Participant[];
  timeZone: string;
}

type DateMode = 'day' | 'month' | 'range';

const cellBorder = { borderColor: '#bdc9c2', borderStyle: 'thin' as const };

const statusNames: Record<ReportRow['status_kehadiran'], string> = {
  hadir: 'Hadir',
  terlambat: 'Terlambat',
  pulang: 'Pulang',
  belum_hadir: 'Belum hadir',
};

function styledCell(
  value: string | number,
  style: Partial<Extract<Cell, { value?: unknown }>> = {},
): Cell {
  return { value, ...style };
}

function headerCell(
  value: string,
  style: Partial<Extract<Cell, { value?: unknown }>> = {},
): Cell {
  return styledCell(value, {
    fontWeight: 'bold',
    backgroundColor: '#eaf2ed',
    align: 'center',
    wrap: true,
    ...cellBorder,
    ...style,
  });
}

function titleRow(title: string, columns: number): Cell[] {
  return [
    styledCell(title, {
      columnSpan: columns,
      fontWeight: 'bold',
      fontSize: 15,
      textColor: '#ffffff',
      backgroundColor: '#157b63',
      align: 'center',
      ...cellBorder,
    }),
    ...Array.from({ length: columns - 1 }, () => null),
  ];
}

function timeLabel(value: string | null, timeZone: string): string {
  if (!value) return '—';
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
    .toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    });
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function monthLabel(value: string): string {
  return new Intl.DateTimeFormat('id-ID', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}-01T00:00:00.000Z`));
}

function dateInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${value.year}-${value.month}-${value.day}`;
}

interface MonthlyParticipant {
  id: string;
  name: string;
  classroom: string;
  records: Map<string, ReportRow>;
}

function monthlyParticipants(rows: ReportRow[]): MonthlyParticipant[] {
  const grouped = new Map<string, MonthlyParticipant>();
  for (const row of rows) {
    let participant = grouped.get(row.participant_id);
    if (!participant) {
      participant = {
        id: row.participant_id,
        name: row.participant_name,
        classroom: row.classroom_name,
        records: new Map(),
      };
      grouped.set(row.participant_id, participant);
    }
    participant.records.set(row.attendance_date, row);
  }
  return [...grouped.values()].sort((left, right) =>
    left.name.localeCompare(right.name, 'id'),
  );
}

function monthDays(month: string): string[] {
  const [year, selectedMonth] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, selectedMonth, 0)).getUTCDate();
  return Array.from({ length: lastDay }, (_value, index) =>
    `${month}-${String(index + 1).padStart(2, '0')}`,
  );
}

function monthlyTableData(
  rows: ReportRow[],
  days: string[],
  timeZone: string,
  heading: string,
  period: string,
): SheetData {
  const totalColumns = 6 + days.length * 3;
  const headerRow: Cell[] = [
    headerCell('No', { rowSpan: 2 }),
    headerCell('Nama', { rowSpan: 2 }),
    headerCell('Kelas', { rowSpan: 2 }),
    ...days.flatMap((day) => [
      headerCell(day.slice(-2), { columnSpan: 3 }),
      null,
      null,
    ]),
    headerCell('Total telat (mnt)', { rowSpan: 2 }),
    headerCell('Total hadir', { rowSpan: 2 }),
    headerCell('Total tidak hadir', { rowSpan: 2 }),
  ];
  const subHeaderRow: Cell[] = [
    null,
    null,
    null,
    ...days.flatMap(() => [
      headerCell('Masuk'),
      headerCell('Terlambat'),
      headerCell('Keluar'),
    ]),
    null,
    null,
    null,
  ];
  const data: SheetData = [
    titleRow(heading, totalColumns),
    titleRow(period, totalColumns),
    headerRow,
    subHeaderRow,
  ];

  monthlyParticipants(rows).forEach((participant, index) => {
    const records = days.map((day) => participant.records.get(day)).filter(Boolean);
    const dailyValues: Cell[] = days.flatMap((day) => {
      const record = participant.records.get(day);
      return [
        record?.masuk_at ? timeLabel(record.masuk_at, timeZone) : '',
        record?.status_kehadiran === 'belum_hadir'
          ? 'Tidak hadir'
          : record?.menit_terlambat
            ? Number(record.menit_terlambat)
            : '',
        record?.pulang_at ? timeLabel(record.pulang_at, timeZone) : '',
      ].map((value) => styledCell(value, { ...cellBorder, align: 'center' }));
    });
    const totalLate = records.reduce(
      (total, record) => total + Number(record?.menit_terlambat ?? 0),
      0,
    );
    const totalPresent = records.filter((record) => Boolean(record?.masuk_at)).length;
    const totalAbsent = records.filter(
      (record) => record?.status_kehadiran === 'belum_hadir',
    ).length;
    data.push([
      styledCell(index + 1, { ...cellBorder, align: 'center' }),
      styledCell(participant.name, cellBorder),
      styledCell(participant.classroom, cellBorder),
      ...dailyValues,
      styledCell(totalLate, { ...cellBorder, align: 'center' }),
      styledCell(totalPresent, { ...cellBorder, align: 'center' }),
      styledCell(totalAbsent, { ...cellBorder, align: 'center' }),
    ]);
  });
  return data;
}

function simpleTableData(
  rows: ReportRow[],
  mode: Exclude<DateMode, 'month'>,
  timeZone: string,
  heading: string,
): SheetData {
  const columns = mode === 'day'
    ? ['No', 'Nama', 'Kelas', 'Masuk', 'Keluar', 'Menit terlambat']
    : ['No', 'Tanggal', 'Nama', 'Kelas', 'Masuk', 'Keluar', 'Menit terlambat'];
  const data: SheetData = [
    titleRow(heading, columns.length),
    Array.from({ length: columns.length }, () => null),
    columns.map((column) => headerCell(column)),
  ];
  rows.forEach((row, index) => {
    const values: Array<string | number> = mode === 'day'
      ? [
        index + 1,
        row.participant_name,
        row.classroom_name,
        row.masuk_at ? timeLabel(row.masuk_at, timeZone) : '',
        row.pulang_at ? timeLabel(row.pulang_at, timeZone) : '',
        Number(row.menit_terlambat),
      ]
      : [
        index + 1,
        dateLabel(row.attendance_date),
        row.participant_name,
        row.classroom_name,
        row.masuk_at ? timeLabel(row.masuk_at, timeZone) : '',
        row.pulang_at ? timeLabel(row.pulang_at, timeZone) : '',
        Number(row.menit_terlambat),
      ];
    data.push(values.map((value, column) =>
      styledCell(value, { ...cellBorder, align: column === 0 || column >= columns.length - 3 ? 'center' : 'left' }),
    ));
  });
  return data;
}

function sheetColumns(count: number, monthly = false) {
  if (!monthly) {
    return [
      { width: 7 },
      ...(count === 7 ? [{ width: 16 }] : []),
      { width: 28 },
      { width: 20 },
      { width: 12 },
      { width: 12 },
      { width: 18 },
    ];
  }
  return [
    { width: 7 },
    { width: 25 },
    { width: 18 },
    ...Array.from({ length: count - 6 }, (_value, index) => ({
      width: index % 3 === 2 ? 11 : 9,
    })),
    { width: 17 },
    { width: 13 },
    { width: 17 },
  ];
}

export default function Dashboard({ participants, timeZone }: DashboardProps) {
  const [dateMode, setDateMode] = useState<DateMode>('month');
  const [month, setMonth] = useState(() => dateInTimeZone(timeZone).slice(0, 7));
  const [selectedDate, setSelectedDate] = useState(() => dateInTimeZone(timeZone));
  const [startDate, setStartDate] = useState(() => dateInTimeZone(timeZone));
  const [endDate, setEndDate] = useState(() => dateInTimeZone(timeZone));
  const [unitId, setUnitId] = useState('');
  const [classroomId, setClassroomId] = useState('');
  const [status, setStatus] = useState('');
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [page, setPage] = useState(0);
  const pageSize = 25;

  const units = useMemo(
    () => [...new Map(participants.map((item) => [item.unit_id, item.unit_name])).entries()],
    [participants],
  );
  const classrooms = useMemo(
    () => [...new Map(
      participants
        .filter((item) => !unitId || item.unit_id === unitId)
        .map((item) => [item.classroom_id, item.classroom_name]),
    ).entries()],
    [participants, unitId],
  );

  useEffect(() => {
    const params = new URLSearchParams();
    if (dateMode === 'month') {
      const [year, selectedMonth] = month.split('-');
      params.set('year', year);
      params.set('month', String(Number(selectedMonth)));
    } else if (dateMode === 'day') {
      params.set('start_date', selectedDate);
      params.set('end_date', selectedDate);
    } else {
      params.set('start_date', startDate);
      params.set('end_date', endDate);
    }
    if (unitId) params.set('unit_id', unitId);
    if (classroomId) params.set('classroom_id', classroomId);
    if (status) params.set('status', status);

    let active = true;
    setLoading(true);
    setError('');
    api<ReportResponse>(`/absensi/rekap?${params}`)
      .then((result) => {
        if (active) {
          setReport(result);
          setPage(0);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Rekap tidak dapat dimuat');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [dateMode, month, selectedDate, startDate, endDate, unitId, classroomId, status]);

  const rows = report?.rows ?? [];
  const visibleRows = rows.slice(page * pageSize, (page + 1) * pageSize);
  const pages = Math.ceil(rows.length / pageSize);
  const selectedUnit = units.find(([id]) => id === unitId)?.[1];
  const selectedClassroom = classrooms.find(([id]) => id === classroomId)?.[1];
  const scopeLabel = [selectedUnit && `Unit: ${selectedUnit}`, selectedClassroom && `Kelas: ${selectedClassroom}`]
    .filter(Boolean)
    .join(' · ');
  const days = dateMode === 'month' ? monthDays(month) : [];
  const printDayChunks = days.reduce<string[][]>((chunks, day, index) => {
    if (index % 7 === 0) chunks.push([]);
    chunks.at(-1)?.push(day);
    return chunks;
  }, []);
  const monthParticipants = dateMode === 'month' ? monthlyParticipants(rows) : [];

  async function exportExcel() {
    if (!rows.length) return;
    setExporting(true);
    setExportError('');
    try {
      let data: SheetData;
      let columns: Array<{ width: number }>;
      let sheetName: string;
      let fileName: string;
      if (dateMode === 'month') {
        const periodHeading = [
          `Bulan: ${monthLabel(month)}`,
          scopeLabel,
          status && `Status: ${statusNames[status as ReportRow['status_kehadiran']] ?? status}`,
        ].filter(Boolean).join(' · ');
        data = monthlyTableData(
          rows,
          days,
          timeZone,
          'REKAP ABSENSI',
          periodHeading,
        );
        columns = sheetColumns(6 + days.length * 3, true);
        sheetName = 'Rekap Bulanan';
        fileName = `rekap-absensi-${month}.xlsx`;
      } else {
        const heading = dateMode === 'day'
          ? `REKAP ABSENSI HARIAN - ${dateLabel(selectedDate)}`
          : `REKAP ABSENSI ${dateLabel(startDate)} s.d. ${dateLabel(endDate)}`;
        data = simpleTableData(rows, dateMode, timeZone, heading);
        columns = sheetColumns(dateMode === 'day' ? 6 : 7);
        sheetName = dateMode === 'day' ? 'Rekap Harian' : 'Rekap Rentang';
        fileName = dateMode === 'day'
          ? `rekap-absensi-${selectedDate}.xlsx`
          : `rekap-absensi-${startDate}-sd-${endDate}.xlsx`;
      }
      if (scopeLabel && dateMode !== 'month') {
        data.splice(1, 0, titleRow(scopeLabel, data[0].length));
      }
      await writeXlsxFile([{
        sheet: sheetName,
        data,
        columns,
        orientation: 'landscape',
        showGridLines: false,
      }]).toFile(fileName);
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : 'File Excel gagal dibuat.');
    } finally {
      setExporting(false);
    }
  }

  const printHeading = dateMode === 'month'
    ? `Bulan: ${monthLabel(month)}`
    : dateMode === 'day'
      ? `Tanggal: ${dateLabel(selectedDate)}`
      : `Periode: ${dateLabel(startDate)} - ${dateLabel(endDate)}`;

  return (
    <section className="page-content report-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">RINGKASAN KEHADIRAN</p>
          <h1>Rekap absensi</h1>
          <p className="muted">Pantau kehadiran dan keterlambatan dalam satu tampilan.</p>
        </div>
        <div className="heading-actions no-print">
          <button className="button secondary" onClick={() => window.print()}>Cetak</button>
          <button className="button primary" disabled={!rows.length || exporting} onClick={() => void exportExcel()}>
            {exporting ? 'Membuat Excel…' : 'Ekspor Excel'}
          </button>
        </div>
      </div>

      <div className="filter-card no-print">
        <div className="filter-top">
          <div className="segmented">
            <button className={dateMode === 'day' ? 'selected' : ''} onClick={() => setDateMode('day')}>
              Harian
            </button>
            <button className={dateMode === 'month' ? 'selected' : ''} onClick={() => setDateMode('month')}>
              Bulanan
            </button>
            <button className={dateMode === 'range' ? 'selected' : ''} onClick={() => setDateMode('range')}>
              Rentang tanggal
            </button>
          </div>
          {dateMode === 'month' ? (
            <label className="filter-field">
              Bulan
              <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
            </label>
          ) : dateMode === 'day' ? (
            <label className="filter-field">
              Tanggal
              <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
            </label>
          ) : (
            <>
              <label className="filter-field">
                Dari
                <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
              </label>
              <label className="filter-field">
                Sampai
                <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
              </label>
            </>
          )}
          <label className="filter-field">
            Unit
            <select value={unitId} onChange={(event) => { setUnitId(event.target.value); setClassroomId(''); }}>
              <option value="">Semua unit</option>
              {units.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          <label className="filter-field">
            Kelas
            <select value={classroomId} onChange={(event) => setClassroomId(event.target.value)}>
              <option value="">Semua kelas</option>
              {classrooms.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          <label className="filter-field">
            Status
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">Semua status</option>
              <option value="hadir">Hadir tepat waktu</option>
              <option value="terlambat">Terlambat</option>
              <option value="pulang">Sudah pulang</option>
              <option value="belum_hadir">Belum hadir</option>
            </select>
          </label>
        </div>
        {error && <div className="notice error">{error}</div>}
        {exportError && <div className="notice error">{exportError}</div>}
      </div>

      <div className="stat-grid">
        <article className="stat-card">
          <span className="stat-label">Hadir tepat waktu</span>
          <strong>{report?.summary.hadir_tepat_waktu ?? '—'}</strong>
          <span className="stat-caption">peserta</span>
        </article>
        <article className="stat-card warm">
          <span className="stat-label">Terlambat</span>
          <strong>{report?.summary.terlambat ?? '—'}</strong>
          <span className="stat-caption">{report?.summary.total_menit_terlambat ?? 0} menit akumulasi</span>
        </article>
        <article className="stat-card blue">
          <span className="stat-label">Sudah pulang</span>
          <strong>{report?.summary.pulang ?? '—'}</strong>
          <span className="stat-caption">catatan pulang</span>
        </article>
        <article className="stat-card neutral">
          <span className="stat-label">Belum hadir</span>
          <strong>{report?.summary.belum_hadir ?? '—'}</strong>
          <span className="stat-caption">peserta / hari</span>
        </article>
      </div>

      <div className="table-card">
        <div className="table-heading">
          <div>
            <h2>Daftar kehadiran</h2>
            <p className="muted">
              {report ? `${report.filters.start_date} — ${report.filters.end_date} · ${rows.length} baris` : 'Memuat data…'}
            </p>
          </div>
          {loading && <span className="loading-dot">Memuat…</span>}
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Tanggal</th><th>Peserta</th><th>Kelas / Unit</th>
                <th>Status</th><th>Masuk</th><th>Telat</th><th>Pulang</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, index) => (
                <tr key={`${row.participant_id}-${row.attendance_date}-${index}`}>
                  <td>{row.attendance_date}</td>
                  <td>
                    <strong>{row.participant_name}</strong>
                    <small>{row.participant_code}</small>
                  </td>
                  <td>{row.classroom_name}<small>{row.unit_name}</small></td>
                  <td><span className={`status-pill status-${row.status_kehadiran}`}>
                    {statusNames[row.status_kehadiran]}
                  </span></td>
                  <td>{row.scan_method ?? '—'}</td>
                  <td>{timeLabel(row.masuk_at, timeZone)}</td>
                  <td>{row.menit_terlambat ? `${row.menit_terlambat} mnt` : '—'}</td>
                  <td>{timeLabel(row.pulang_at, timeZone)}</td>
                </tr>
              ))}
              {!visibleRows.length && !loading && (
                <tr><td className="empty-row" colSpan={7}>Tidak ada data untuk filter ini.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="pagination no-print">
            <span>Halaman {page + 1} dari {pages}</span>
            <div className="heading-actions">
              <button className="button secondary small" disabled={page === 0} onClick={() => setPage(page - 1)}>Sebelumnya</button>
              <button className="button secondary small" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Berikutnya</button>
            </div>
          </div>
        )}
      </div>

      <div className="report-print-area">
        {dateMode === 'month' ? (
          <div className="monthly-print-pages">
            {printDayChunks.map((chunk, chunkIndex) => {
              const startDay = Number(chunk[0]?.slice(-2) ?? 0);
              const endDay = Number(chunk.at(-1)?.slice(-2) ?? 0);
              const period = `${printHeading} · Tanggal ${startDay}-${endDay}${scopeLabel ? ` · ${scopeLabel}` : ''}`;
              return (
                <section className="monthly-print-page" key={chunkIndex}>
                  <h1>Rekap Absensi Bulanan</h1>
                  <p>{period}</p>
                  <table className="monthly-print-table">
                    <thead>
                      <tr>
                        <th rowSpan={2}>No</th>
                        <th rowSpan={2}>Nama</th>
                        <th rowSpan={2}>Kelas</th>
                        {chunk.map((day) => (
                          <th key={day} colSpan={3}>{day.slice(-2)}</th>
                        ))}
                        <th rowSpan={2}>Total telat (mnt)</th>
                        <th rowSpan={2}>Total hadir</th>
                        <th rowSpan={2}>Total tidak hadir</th>
                      </tr>
                      <tr>
                        {chunk.flatMap((day) => ['Masuk', 'Terlambat', 'Keluar'].map((label) => (
                          <th key={`${day}-${label}`}>{label}</th>
                        )))}
                      </tr>
                    </thead>
                    <tbody>
                      {monthParticipants.map((participant, index) => {
                        const records = [...participant.records.values()];
                        const totalLate = records.reduce(
                          (total, record) => total + Number(record.menit_terlambat),
                          0,
                        );
                        const totalPresent = records.filter((record) => Boolean(record.masuk_at)).length;
                        const totalAbsent = records.filter(
                          (record) => record.status_kehadiran === 'belum_hadir',
                        ).length;
                        return (
                          <tr key={participant.id}>
                            <td>{index + 1}</td>
                            <td>{participant.name}</td>
                            <td>{participant.classroom}</td>
                            {chunk.flatMap((day) => {
                              const record = participant.records.get(day);
                              return [
                                record?.masuk_at ? timeLabel(record.masuk_at, timeZone) : '',
                                record?.status_kehadiran === 'belum_hadir'
                                  ? 'Tidak hadir'
                                  : record?.menit_terlambat
                                    ? String(record.menit_terlambat)
                                    : '',
                                record?.pulang_at ? timeLabel(record.pulang_at, timeZone) : '',
                              ].map((value, cellIndex) => (
                                <td key={`${day}-${cellIndex}`}>{value}</td>
                              ));
                            })}
                            <td>{totalLate}</td>
                            <td>{totalPresent}</td>
                            <td>{totalAbsent}</td>
                          </tr>
                        );
                      })}
                      {!monthParticipants.length && (
                        <tr><td colSpan={chunk.length * 3 + 6}>Tidak ada data untuk filter ini.</td></tr>
                      )}
                    </tbody>
                  </table>
                </section>
              );
            })}
          </div>
        ) : (
          <section className="simple-print-page">
            <h1>Rekap Absensi</h1>
            <p>{printHeading}{scopeLabel ? ` · ${scopeLabel}` : ''}</p>
            <table className="simple-print-table">
              <thead>
                <tr>
                  <th>No</th>
                  {dateMode === 'range' && <th>Tanggal</th>}
                  <th>Nama</th><th>Kelas</th><th>Masuk</th><th>Keluar</th><th>Menit terlambat</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.participant_id}-${row.attendance_date}-${index}`}>
                    <td>{index + 1}</td>
                    {dateMode === 'range' && <td>{dateLabel(row.attendance_date)}</td>}
                    <td>{row.participant_name}</td>
                    <td>{row.classroom_name}</td>
                    <td>{row.masuk_at ? timeLabel(row.masuk_at, timeZone) : ''}</td>
                    <td>{row.pulang_at ? timeLabel(row.pulang_at, timeZone) : ''}</td>
                    <td>{row.menit_terlambat || ''}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={dateMode === 'day' ? 6 : 7}>Tidak ada data.</td></tr>}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </section>
  );
}
