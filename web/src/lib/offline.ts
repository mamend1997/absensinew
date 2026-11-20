import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Participant, QueuedScan, Settings } from '../types';

interface AttendanceCache extends DBSchema {
  participants: {
    key: string;
    value: Participant;
    indexes: { 'by-qr': string };
  };
  queue: {
    key: string;
    value: QueuedScan;
    indexes: {
      'by-status': QueuedScan['status_sync'];
      'by-date': string;
    };
  };
}

const DATABASE_NAME = 'ruang-hadir-local';
const DATABASE_VERSION = 1;
const SETTINGS_KEY = 'ruang_hadir_settings';
const MASTER_SYNC_CURSOR_PREFIX = 'ruang_hadir_master_sync_cursor_';

export type MasterDataType = 'participants' | 'settings';

let databasePromise: Promise<IDBPDatabase<AttendanceCache>> | undefined;

function database(): Promise<IDBPDatabase<AttendanceCache>> {
  if (!('indexedDB' in window)) {
    throw new Error('Penyimpanan lokal tidak tersedia di browser ini');
  }
  databasePromise ??= openDB<AttendanceCache>(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(db) {
      const participants = db.createObjectStore('participants', { keyPath: 'id' });
      participants.createIndex('by-qr', 'qr_code', { unique: true });
      const queue = db.createObjectStore('queue', { keyPath: 'id_unik' });
      queue.createIndex('by-status', 'status_sync');
      queue.createIndex('by-date', 'attendance_date');
    },
  });
  return databasePromise;
}

export async function getParticipants(): Promise<Participant[]> {
  return (await database()).getAll('participants');
}

export async function replaceParticipants(participants: Participant[]): Promise<void> {
  const db = await database();
  const tx = db.transaction('participants', 'readwrite');
  await tx.store.clear();
  for (const participant of participants) {
    if (participant.is_active === true || participant.is_active === 1) {
      await tx.store.put({ ...participant, id: String(participant.id) });
    }
  }
  await tx.done;
}

export async function mergeParticipantDelta(
  participants: Participant[],
  removedIds: string[] = [],
): Promise<void> {
  const db = await database();
  const tx = db.transaction('participants', 'readwrite');
  for (const participant of participants) {
    const id = String(participant.id);
    if (participant.is_active === true || participant.is_active === 1) {
      await tx.store.put({ ...participant, id });
    } else {
      await tx.store.delete(id);
    }
  }
  for (const id of removedIds) await tx.store.delete(id);
  await tx.done;
}

export function getMasterSyncCursor(type: MasterDataType): string | null {
  return localStorage.getItem(`${MASTER_SYNC_CURSOR_PREFIX}${type}`);
}

export function saveMasterSyncCursor(type: MasterDataType, cursor: string): void {
  localStorage.setItem(`${MASTER_SYNC_CURSOR_PREFIX}${type}`, cursor);
}

export function clearMasterSyncCursors(): void {
  localStorage.removeItem(`${MASTER_SYNC_CURSOR_PREFIX}participants`);
  localStorage.removeItem(`${MASTER_SYNC_CURSOR_PREFIX}settings`);
}

export async function saveSettings(settings: Settings): Promise<void> {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function getSettings(): Settings | null {
  const value = localStorage.getItem(SETTINGS_KEY);
  if (!value) return null;
  try {
    return JSON.parse(value) as Settings;
  } catch (error) {
    console.error('Cache pengaturan lokal tidak dapat dibaca', error);
    localStorage.removeItem(SETTINGS_KEY);
    return null;
  }
}

export async function enqueueScan(scan: QueuedScan): Promise<void> {
  const db = await database();
  const tx = db.transaction('queue', 'readwrite');
  const queued = await tx.store.getAll();
  if (queued.some((item) => item.id_unik === scan.id_unik)) {
    await tx.done;
    return;
  }
  const duplicate = queued.find((item) =>
    item.id_peserta === scan.id_peserta &&
    item.attendance_date === scan.attendance_date &&
    item.jenis_absen === scan.jenis_absen,
  );
  if (duplicate) {
    await tx.done;
    throw new Error(
      `${scan.jenis_absen === 'masuk' ? 'Absensi masuk' : 'Absensi pulang'} peserta ini sudah tercatat pada perangkat hari ini.`,
    );
  }
  await tx.store.put(scan);
  await tx.done;
}

export async function getQueue(): Promise<QueuedScan[]> {
  return (await database()).getAll('queue');
}

export async function getPendingScans(): Promise<QueuedScan[]> {
  const db = await database();
  return db.getAllFromIndex('queue', 'by-status', 'pending');
}

export async function pendingCount(): Promise<number> {
  const db = await database();
  return db.countFromIndex('queue', 'by-status', 'pending');
}

export async function markScansSynced(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await database();
  const tx = db.transaction('queue', 'readwrite');
  for (const id of ids) {
    const scan = await tx.store.get(id);
    if (scan) await tx.store.put({ ...scan, status_sync: 'synced' });
  }
  await tx.done;
}

export async function clearSyncedScans(): Promise<number> {
  const db = await database();
  const tx = db.transaction('queue', 'readwrite');
  const syncedIds = await tx.store.index('by-status').getAllKeys('synced');
  for (const id of syncedIds) await tx.store.delete(id);
  await tx.done;
  return syncedIds.length;
}
