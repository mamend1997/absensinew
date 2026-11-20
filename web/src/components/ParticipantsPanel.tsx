import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Papa from 'papaparse';
import QRCode from 'qrcode';
import readXlsxFile from 'read-excel-file/browser';
import writeXlsxFile from 'write-excel-file/browser';
import { api } from '../lib/api';
import type { Participant } from '../types';

interface ParticipantsPanelProps {
  participants: Participant[];
  onRefresh: () => Promise<void>;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

interface ParticipantForm {
  participant_code: string;
  full_name: string;
  classroom_id: string;
  qr_code: string;
  guardian_phone: string;
}

interface Classroom {
  id: string;
  name: string;
  unit_id: string;
  unit_name: string;
}

interface Unit {
  id: string;
  name: string;
}

interface ClassroomForm {
  name: string;
  unit_id: string;
}

interface PrintableQrCard {
  id: string;
  participantCode: string;
  name: string;
  classroom: string;
  qrCode: string;
  image: string;
}

type MassQrPrintMode = 'card' | 'qr-only';

const emptyForm: ParticipantForm = {
  participant_code: '',
  full_name: '',
  classroom_id: '',
  qr_code: '',
  guardian_phone: '',
};

export default function ParticipantsPanel({
  participants,
  onRefresh,
  showToast,
}: ParticipantsPanelProps) {
  const [form, setForm] = useState<ParticipantForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [qrPreview, setQrPreview] = useState<{ value: string; image: string } | null>(null);
  const [massQrCards, setMassQrCards] = useState<PrintableQrCard[] | null>(null);
  const [massQrPrintMode, setMassQrPrintMode] = useState<MassQrPrintMode>('card');
  const [printingSelected, setPrintingSelected] = useState(false);
  const [search, setSearch] = useState('');
  const [classrooms, setClassrooms] = useState<Classroom[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [classroomForm, setClassroomForm] = useState<ClassroomForm>({ name: '', unit_id: '' });
  const [editingClassroomId, setEditingClassroomId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.body.classList.toggle('print-qr', Boolean(qrPreview || massQrCards));
    return () => document.body.classList.remove('print-qr');
  }, [massQrCards, qrPreview]);
  const refreshClassrooms = useCallback(async () => {
    const result = await api<{ classrooms: Classroom[]; units: Unit[] }>('/kelas');
    setClassrooms(result.classrooms.map((classroom) => ({
      ...classroom,
      id: String(classroom.id),
      unit_id: String(classroom.unit_id),
    })));
    setUnits(result.units.map((unit) => ({ ...unit, id: String(unit.id) })));
    setClassroomForm((current) => ({
      ...current,
      unit_id: current.unit_id || String(result.units[0]?.id ?? ''),
    }));
  }, []);
  useEffect(() => {
    void refreshClassrooms().catch((error: unknown) =>
      showToast(error instanceof Error ? error.message : 'Daftar kelas gagal dimuat.', 'error'),
    );
  }, [refreshClassrooms, showToast]);

  const visible = participants.filter((participant) => {
    const query = search.toLocaleLowerCase();
    return !query ||
      participant.full_name.toLocaleLowerCase().includes(query) ||
      participant.participant_code.toLocaleLowerCase().includes(query) ||
      (participant.guardian_phone ?? '').toLocaleLowerCase().includes(query) ||
      participant.classroom_name.toLocaleLowerCase().includes(query);
  });
  const allVisibleSelected = visible.length > 0 &&
    visible.every((participant) => selectedIds.has(participant.id));

  function updateForm(
    field: 'full_name' | 'classroom_id' | 'qr_code' | 'guardian_phone',
    value: string,
  ) {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function edit(participant: Participant) {
    setEditingId(participant.id);
    setForm({
      participant_code: participant.participant_code,
      full_name: participant.full_name,
      classroom_id: participant.classroom_id,
      qr_code: participant.qr_code,
      guardian_phone: participant.guardian_phone ?? '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = {
        ...form,
        participant_code: editingId ? form.participant_code : `P-${crypto.randomUUID()}`,
        classroom_id: Number(form.classroom_id),
        qr_code: form.qr_code.trim(),
      };
      if (editingId) {
        await api(`/peserta/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/peserta', { method: 'POST', body: JSON.stringify(payload) });
      }
      setForm(emptyForm);
      setEditingId(null);
      await onRefresh();
      showToast(editingId ? 'Data peserta diperbarui.' : 'Peserta berhasil ditambahkan.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Data peserta gagal disimpan.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove(participant: Participant) {
    if (!window.confirm(`Nonaktifkan peserta ${participant.full_name}?`)) return;
    try {
      await api(`/peserta/${participant.id}`, { method: 'DELETE' });
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(participant.id);
        return next;
      });
      await onRefresh();
      showToast('Peserta dinonaktifkan.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Peserta gagal dihapus.', 'error');
    }
  }

  async function removeSelected() {
    const ids = [...selectedIds];
    if (!ids.length || !window.confirm(`Nonaktifkan ${ids.length} peserta terpilih?`)) return;
    setBulkBusy(true);
    try {
      const result = await api<{ deleted: number }>('/peserta/bulk', {
        method: 'DELETE',
        body: JSON.stringify({ ids }),
      });
      setSelectedIds(new Set());
      await onRefresh();
      showToast(`${result.deleted} peserta berhasil dihapus.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Peserta terpilih gagal dihapus.', 'error');
    } finally {
      setBulkBusy(false);
    }
  }

  function toggleVisibleSelection(checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const participant of visible) {
        if (checked) next.add(participant.id);
        else next.delete(participant.id);
      }
      return next;
    });
  }

  async function submitClassroom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = {
        name: classroomForm.name.trim(),
        unit_id: Number(classroomForm.unit_id),
      };
      if (editingClassroomId) {
        await api(`/kelas/${editingClassroomId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await api('/kelas', { method: 'POST', body: JSON.stringify(payload) });
      }
      setClassroomForm({ name: '', unit_id: units[0]?.id ?? '' });
      setEditingClassroomId(null);
      await refreshClassrooms();
      await onRefresh();
      showToast(editingClassroomId ? 'Kelas berhasil diperbarui.' : 'Kelas berhasil ditambahkan.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Kelas gagal disimpan.', 'error');
    } finally {
      setBusy(false);
    }
  }

  function editClassroom(classroom: Classroom) {
    setEditingClassroomId(classroom.id);
    setClassroomForm({ name: classroom.name, unit_id: classroom.unit_id });
  }

  async function removeClassroom(classroom: Classroom) {
    if (!window.confirm(`Hapus kelas ${classroom.name}? Kelas yang masih dipakai tidak dapat dihapus.`)) return;
    try {
      await api(`/kelas/${classroom.id}`, { method: 'DELETE' });
      await refreshClassrooms();
      showToast('Kelas berhasil dihapus.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Kelas gagal dihapus.', 'error');
    }
  }

  async function downloadTemplate() {
    try {
      await writeXlsxFile([
        {
          sheet: 'Peserta',
          columns: [{ width: 28 }, { width: 22 }, { width: 24 }, { width: 28 }, { width: 22 }],
          data: [
            ['full_name', 'unit_name', 'classroom_name', 'qr_code', 'guardian_phone'],
            ['', '', '', '', ''],
          ],
        },
        {
          sheet: 'Referensi Kelas',
          columns: [{ width: 22 }, { width: 24 }],
          data: [
            ['unit_name', 'classroom_name'],
            ...classrooms.map((classroom) => [classroom.unit_name, classroom.name]),
          ],
        },
        {
          sheet: 'Petunjuk',
          columns: [{ width: 24 }, { width: 16 }, { width: 64 }],
          data: [
            ['Kolom', 'Wajib', 'Keterangan'],
            ['full_name', 'Ya', 'Nama lengkap peserta.'],
            ['unit_name', 'Ya', 'Salin nama unit dari sheet Referensi Kelas.'],
            ['classroom_name', 'Ya', 'Salin nama kelas dari sheet Referensi Kelas.'],
            ['qr_code', 'Ya', 'Isi unik yang terkandung pada QR atau barcode peserta.'],
            ['guardian_phone', 'Tidak', 'Nomor WhatsApp orang tua/wali dalam format internasional, misalnya 62812...'],
            ['', '', 'Jangan ubah nama kolom pada sheet Peserta.'],
          ],
        },
      ]).toFile('template-peserta.xlsx');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Template Excel gagal dibuat.', 'error');
    }
  }

  async function showQr(value: string) {
    try {
      const image = await QRCode.toDataURL(value, {
        width: 280,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#173a34', light: '#ffffff' },
      });
      setMassQrCards(null);
      setQrPreview({ value, image });
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Kode QR gagal dibuat.', 'error');
    }
  }

  async function printSelectedQr(mode: MassQrPrintMode) {
    const selected = participants.filter((participant) => selectedIds.has(participant.id));
    if (!selected.length) return;
    setPrintingSelected(true);
    try {
      const cards = await Promise.all(selected.map(async (participant) => ({
        id: participant.id,
        participantCode: participant.participant_code,
        name: participant.full_name,
        classroom: participant.classroom_name,
        qrCode: participant.qr_code,
        image: await QRCode.toDataURL(participant.qr_code, {
          width: 360,
          margin: 2,
          errorCorrectionLevel: 'M',
          color: { dark: '#173a34', light: '#ffffff' },
        }),
      })));
      setQrPreview(null);
      setMassQrPrintMode(mode);
      setMassQrCards(cards);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Kode QR massal gagal dibuat.', 'error');
    } finally {
      setPrintingSelected(false);
    }
  }

  async function importParticipants(file?: File) {
    if (!file) return;
    setBusy(true);
    try {
      let rawRows: Record<string, unknown>[];
      if (file.name.toLocaleLowerCase().endsWith('.csv')) {
        const parsed = await new Promise<Papa.ParseResult<Record<string, string>>>((resolve, reject) => {
          Papa.parse<Record<string, string>>(file, {
            header: true,
            skipEmptyLines: true,
            complete: resolve,
            error: reject,
          });
        });
        if (parsed.errors.length) throw new Error(parsed.errors[0].message);
        rawRows = parsed.data;
      } else {
        const sheets = await readXlsxFile(file);
        const rows = sheets[0]?.data ?? [];
        const headers = rows[0]?.map((header) => String(header ?? '').trim()) ?? [];
        if (!headers.length) throw new Error('Sheet Excel tidak memiliki baris header.');
        rawRows = rows.slice(1).filter((row) => row.some((value) => String(value ?? '').trim()))
          .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
      }
      const records = rawRows.map((row) => {
        const participantCode = String(row.participant_code ?? '').trim();
        const classroomIdText = String(row.classroom_id ?? '').trim();
        return {
          participant_code: participantCode || undefined,
          full_name: String(row.full_name ?? '').trim(),
          classroom_id: classroomIdText ? Number(classroomIdText) : undefined,
          classroom_name: String(row.classroom_name ?? '').trim() || undefined,
          unit_name: String(row.unit_name ?? '').trim() || undefined,
          qr_code: String(row.qr_code ?? '').trim() || participantCode || undefined,
          guardian_phone: String(row.guardian_phone ?? '').trim() || undefined,
        };
      });
      if (records.some((row) =>
        !row.full_name || !row.qr_code ||
        (!row.classroom_id && !(row.classroom_name && row.unit_name)) ||
        (row.classroom_id !== undefined &&
          (!Number.isInteger(row.classroom_id) || row.classroom_id < 1))
      )) {
        throw new Error('Setiap baris perlu full_name, qr_code, serta classroom_id atau pasangan unit_name dan classroom_name.');
      }
      const result = await api<{ imported: number }>('/peserta/import', {
        method: 'POST',
        body: JSON.stringify({ participants: records }),
      });
      await onRefresh();
      showToast(`${result.imported} baris peserta diimpor.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Impor Excel/CSV gagal.', 'error');
    } finally {
      setBusy(false);
      if (uploadRef.current) uploadRef.current.value = '';
    }
  }

  return (
    <section className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">MASTER DATA</p>
          <h1>Peserta</h1>
          <p className="muted">Kelola identitas, kelas, dan kode untuk pemindaian.</p>
        </div>
        <div className="heading-actions no-print">
          <input
            ref={uploadRef}
            type="file"
            accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            hidden
            onChange={(event) => void importParticipants(event.target.files?.[0])}
          />
          <button type="button" className="button secondary" disabled={busy} onClick={() => uploadRef.current?.click()}>
            Impor Excel/CSV
          </button>
          <button type="button" className="button secondary" disabled={busy} onClick={() => void downloadTemplate()}>
            Template Excel
          </button>
        </div>
      </div>

      <div className="split-layout">
        <form className="panel-card form-stack" onSubmit={(event) => void submit(event)}>
          <div className="panel-heading">
            <div>
              <h2>{editingId ? 'Ubah peserta' : 'Tambah peserta'}</h2>
              <p className="muted">Isi nama, kelas, dan kode QR/barcode peserta.</p>
            </div>
            {editingId && <button type="button" className="text-button" onClick={() => { setEditingId(null); setForm(emptyForm); }}>Batal</button>}
          </div>
          <label>
            Nama lengkap
            <input required value={form.full_name} onChange={(event) => updateForm('full_name', event.target.value)} placeholder="Nama peserta" />
          </label>
          <label>
            Kelas
            <select required value={form.classroom_id} onChange={(event) => updateForm('classroom_id', event.target.value)}>
              <option value="">Pilih kelas</option>
            {classrooms.map((classroom) => (
              <option key={classroom.id} value={classroom.id}>
                {classroom.name} · {classroom.unit_name}
              </option>
            ))}
            </select>
          </label>
          <label>
            Isi QR / barcode
            <input required value={form.qr_code} onChange={(event) => updateForm('qr_code', event.target.value)} placeholder="Nilai unik untuk dipindai" />
          </label>
          <label>
            Nomor WhatsApp orang tua / wali
            <input
              type="tel"
              maxLength={32}
              value={form.guardian_phone}
              onChange={(event) => updateForm('guardian_phone', event.target.value)}
              placeholder="Contoh: 62812…"
            />
          </label>
          <button className="button primary" disabled={busy || !classrooms.length}>
            {busy ? 'Menyimpan…' : editingId ? 'Simpan perubahan' : 'Simpan peserta'}
          </button>
          {!classrooms.length && <div className="notice">Belum ada kelas. Tambahkan kelas di bagian Kelola kelas.</div>}
        </form>

        <div className="panel-card list-panel">
          <div className="panel-heading">
            <div><h2>Daftar peserta</h2><p className="muted">{participants.length} peserta aktif</p></div>
            <input className="search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cari nama / kode…" />
          </div>
          <div className="participant-bulk-actions no-print">
            <label>
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={(event) => toggleVisibleSelection(event.target.checked)}
              />
              Pilih semua yang ditampilkan
            </label>
            {selectedIds.size > 0 && (
              <div className="heading-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={printingSelected}
                  onClick={() => void printSelectedQr('card')}
                >
                  {printingSelected ? 'Menyiapkan…' : `Cetak kartu QR (${selectedIds.size})`}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={printingSelected}
                  onClick={() => void printSelectedQr('qr-only')}
                >
                  {printingSelected ? 'Menyiapkan…' : `Cetak QR saja (${selectedIds.size})`}
                </button>
                <button
                  type="button"
                  className="button danger-button"
                  disabled={bulkBusy}
                  onClick={() => void removeSelected()}
                >
                  {bulkBusy ? 'Menghapus…' : `Hapus terpilih (${selectedIds.size})`}
                </button>
              </div>
            )}
          </div>
          <div className="participant-list">
            {visible.map((participant) => (
              <article className="participant-row" key={participant.id}>
                <input
                  type="checkbox"
                  aria-label={`Pilih ${participant.full_name}`}
                  checked={selectedIds.has(participant.id)}
                  onChange={(event) => setSelectedIds((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(participant.id);
                    else next.delete(participant.id);
                    return next;
                  })}
                />
                <div className="avatar">{participant.full_name.slice(0, 1).toUpperCase()}</div>
                <div className="participant-info">
                  <strong>{participant.full_name}</strong>
                  <span>
                    {participant.participant_code} · {participant.classroom_name}
                    {participant.guardian_phone ? ` · Wali: ${participant.guardian_phone}` : ''}
                  </span>
                </div>
                <div className="heading-actions no-print">
                  <button className="icon-button" title="Tampilkan QR" onClick={() => void showQr(participant.qr_code)}>QR</button>
                  <button className="icon-button" title="Ubah" onClick={() => edit(participant)}>Ubah</button>
                  <button className="icon-button danger-text" title="Nonaktifkan" onClick={() => void remove(participant)}>Hapus</button>
                </div>
              </article>
            ))}
            {!visible.length && <div className="empty-row">Peserta tidak ditemukan.</div>}
          </div>
        </div>
      </div>

      <section className="panel-card class-management-panel">
        <div className="panel-heading">
          <div>
            <h2>Kelola kelas</h2>
            <p className="muted">Tambah, ubah, atau hapus kelas, misalnya X AKL.</p>
          </div>
        </div>
        <form className="classroom-form" onSubmit={(event) => void submitClassroom(event)}>
          <label>
            Nama kelas
            <input
              required
              maxLength={100}
              value={classroomForm.name}
              onChange={(event) => setClassroomForm({ ...classroomForm, name: event.target.value })}
              placeholder="Contoh: X AKL"
            />
          </label>
          <label>
            Unit
            <select
              required
              value={classroomForm.unit_id}
              onChange={(event) => setClassroomForm({ ...classroomForm, unit_id: event.target.value })}
            >
              <option value="">Pilih unit</option>
              {units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
            </select>
          </label>
          <div className="heading-actions">
            <button type="submit" className="button primary" disabled={busy || !units.length}>
              {busy ? 'Menyimpan…' : editingClassroomId ? 'Simpan kelas' : 'Tambah kelas'}
            </button>
            {editingClassroomId && (
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  setEditingClassroomId(null);
                  setClassroomForm({ name: '', unit_id: units[0]?.id ?? '' });
                }}
              >
                Batal
              </button>
            )}
          </div>
        </form>
        <div className="classroom-list">
          {classrooms.map((classroom) => (
            <article className="classroom-row" key={classroom.id}>
              <div><strong>{classroom.name}</strong><span>{classroom.unit_name}</span></div>
              <div className="heading-actions">
                <button type="button" className="icon-button" onClick={() => editClassroom(classroom)}>Ubah</button>
                <button type="button" className="icon-button danger-text" onClick={() => void removeClassroom(classroom)}>Hapus</button>
              </div>
            </article>
          ))}
          {!classrooms.length && <div className="empty-row">Belum ada kelas.</div>}
        </div>
      </section>

      {qrPreview && (
        <div className="modal-backdrop" role="presentation" onClick={() => setQrPreview(null)}>
          <section className="qr-modal" role="dialog" aria-modal="true" aria-label="Kode QR peserta" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setQrPreview(null)} aria-label="Tutup">×</button>
            <p className="eyebrow">KODE PESERTA</p>
            <img src={qrPreview.image} alt={`Kode QR ${qrPreview.value}`} />
            <strong>{qrPreview.value}</strong>
            <button className="button secondary" onClick={() => window.print()}>Cetak QR</button>
          </section>
        </div>
      )}
      {massQrCards && (
        <div
          className="modal-backdrop mass-qr-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMassQrCards(null);
          }}
        >
          <section
            className={`mass-qr-modal${massQrPrintMode === 'qr-only' ? ' qr-only-modal' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-label={`Cetak ${massQrCards.length} ${massQrPrintMode === 'qr-only' ? 'QR' : 'kartu QR'} peserta`}
          >
            <div className="mass-qr-toolbar no-print">
              <div>
                <p className="eyebrow">{massQrPrintMode === 'qr-only' ? 'QR SAJA' : 'KARTU PESERTA'}</p>
                <strong>{massQrCards.length} {massQrPrintMode === 'qr-only' ? 'QR' : 'kartu QR'} siap dicetak</strong>
                <small>Layout A4; pilih cetak atau simpan sebagai PDF.</small>
              </div>
              <div className="heading-actions">
                <button className="button primary" onClick={() => window.print()}>Cetak / Simpan PDF</button>
                <button className="button secondary" onClick={() => setMassQrCards(null)}>Tutup</button>
              </div>
            </div>
            <div className={massQrPrintMode === 'qr-only' ? 'qr-only-grid' : 'qr-card-grid'}>
              {massQrCards.map((card) => (
                massQrPrintMode === 'qr-only' ? (
                  <article className="qr-only-item" key={card.id}>
                    <img src={card.image} alt={`QR ${card.name}`} />
                    <strong>{card.name}</strong>
                  </article>
                ) : (
                  <article className="qr-id-card" key={card.id}>
                    <img src={card.image} alt={`QR ${card.name}`} />
                    <div className="qr-id-card-copy">
                      <strong>{card.name}</strong>
                      <span>ID: {card.participantCode}</span>
                      <small>{card.classroom}</small>
                      <code>{card.qrCode}</code>
                    </div>
                  </article>
                )
              ))}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
