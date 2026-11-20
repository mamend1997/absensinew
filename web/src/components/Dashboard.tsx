import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { Participant, ReportResponse, ReportRow } from '../types';

interface DashboardProps {
  participants: Participant[];
}

type DateMode = 'month' | 'range';

const today = new Date();
const currentMonth = today.toISOString().slice(0, 7);
const currentDate = today.toISOString().slice(0, 10);

const statusNames: Record<ReportRow['status_kehadiran'], string> = {
  hadir: 'Hadir',
  terlambat: 'Terlambat',
  pulang: 'Pulang',
  belum_hadir: 'Belum hadir',
};

function safeCsvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(rows: ReportRow[]) {
  const columns = [
    'Tanggal',
    'Kode peserta',
    'Nama',
    'Kelas',
    'Unit',
    'Status',
    'Metode masuk',
    'Metode pulang',
    'Menit terlambat',
    'Waktu masuk',
    'Waktu pulang',
  ];
  const data = rows.map((row) => [
    row.attendance_date,
    row.participant_code,
    row.participant_name,
    row.classroom_name,
    row.unit_name,
    statusNames[row.status_kehadiran],
    row.scan_method ?? '',
    row.checkout_scan_method ?? '',
    row.menit_terlambat,
    row.masuk_at ?? '',
    row.pulang_at ?? '',
  ]);
  const content = `\uFEFF${[columns, ...data].map((line) => line.map(safeCsvCell).join(',')).join('\r\n')}`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  link.download = `rekap-absensi-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function timeLabel(value: string | null): string {
  if (!value) return '—';
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
    .toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

export default function Dashboard({ participants }: DashboardProps) {
  const [dateMode, setDateMode] = useState<DateMode>('month');
  const [month, setMonth] = useState(currentMonth);
  const [startDate, setStartDate] = useState(currentDate);
  const [endDate, setEndDate] = useState(currentDate);
  const [unitId, setUnitId] = useState('');
  const [classroomId, setClassroomId] = useState('');
  const [status, setStatus] = useState('');
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
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
  }, [dateMode, month, startDate, endDate, unitId, classroomId, status]);

  const rows = report?.rows ?? [];
  const visibleRows = rows.slice(page * pageSize, (page + 1) * pageSize);
  const pages = Math.ceil(rows.length / pageSize);

  return (
    <section className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">RINGKASAN KEHADIRAN</p>
          <h1>Rekap absensi</h1>
          <p className="muted">Pantau kehadiran dan keterlambatan dalam satu tampilan.</p>
        </div>
        <div className="heading-actions no-print">
          <button className="button secondary" onClick={() => window.print()}>Cetak</button>
          <button className="button primary" disabled={!rows.length} onClick={() => downloadCsv(rows)}>
            Ekspor CSV
          </button>
        </div>
      </div>

      <div className="filter-card no-print">
        <div className="filter-top">
          <div className="segmented">
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
                <th>Status</th><th>Metode masuk</th><th>Masuk</th><th>Telat</th>
                <th>Metode pulang</th><th>Pulang</th>
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
                  <td>{timeLabel(row.masuk_at)}</td>
                  <td>{row.menit_terlambat ? `${row.menit_terlambat} mnt` : '—'}</td>
                  <td>{row.checkout_scan_method ?? '—'}</td>
                  <td>{timeLabel(row.pulang_at)}</td>
                </tr>
              ))}
              {!visibleRows.length && !loading && (
                <tr><td className="empty-row" colSpan={9}>Tidak ada data untuk filter ini.</td></tr>
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
    </section>
  );
}
