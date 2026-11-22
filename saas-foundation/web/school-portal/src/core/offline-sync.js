const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class NetworkUnavailableError extends Error {
  constructor() {
    super('Tidak dapat terhubung ke server. Periksa koneksi internet, lalu coba lagi.');
    this.name = 'NetworkUnavailableError';
  }
}

export function isNetworkUnavailableError(error) {
  return error instanceof NetworkUnavailableError ||
    (error instanceof TypeError &&
      /failed to fetch|network error|network request failed|load failed/i.test(error.message));
}

function assertQueuedScan(scan, schoolId) {
  if (!scan || String(scan.sekolah_id) !== String(schoolId)) {
    throw new Error('Scan tidak termasuk sekolah pada antrean perangkat ini.');
  }
  if (!UUID_PATTERN.test(scan.id_unik ?? '')) throw new TypeError('id_unik harus berupa UUID yang valid.');
  if (scan.status_sync !== 'pending') throw new TypeError('Scan baru harus berstatus pending.');
  if (!Number.isFinite(new Date(scan.client_timestamp).getTime())) {
    throw new TypeError('client_timestamp harus berupa timestamp yang valid.');
  }
}

export function createOfflineSyncManager({ schoolId, storage, sendBatch, batchSize = 100 }) {
  if (!schoolId) throw new TypeError('schoolId wajib tersedia.');
  if (!storage || typeof storage.putPendingIfAbsent !== 'function' ||
      typeof storage.listPending !== 'function' || typeof storage.markSynced !== 'function') {
    throw new TypeError('Adapter storage antrean tidak lengkap.');
  }
  if (typeof sendBatch !== 'function') throw new TypeError('sendBatch wajib berupa fungsi.');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new RangeError('batchSize harus berupa bilangan bulat antara 1 dan 100.');
  }
  let syncInFlight;

  async function enqueue(scan) {
    assertQueuedScan(scan, schoolId);
    return storage.putPendingIfAbsent({
      sekolah_id: String(schoolId),
      scan: { ...scan, sekolah_id: String(schoolId) },
    });
  }

  async function runSync() {
    const acceptedIds = [];
    const ignoredIds = [];
    const ignoredDetails = [];
    const rejectedIds = [];
    let batches = 0;
    while (true) {
      const pending = await storage.listPending({ sekolah_id: String(schoolId), limit: batchSize });
      if (!Array.isArray(pending)) {
        throw new TypeError('Adapter storage harus mengembalikan daftar scan pending.');
      }
      if (!pending.length) break;
      if (pending.length > batchSize) throw new RangeError('Adapter storage mengembalikan batch melebihi batas.');
      for (const scan of pending) assertQueuedScan(scan, schoolId);
      const submittedIds = new Set(pending.map((scan) => scan.id_unik));
      const response = await sendBatch({ sekolah_id: String(schoolId), records: pending });
      if (!response || !Array.isArray(response.accepted_ids)) {
        throw new TypeError('Respons sync harus berisi accepted_ids.');
      }
      const accepted = new Set(response.accepted_ids);
      const ignoredList = response.ignored_ids ?? [];
      if (!Array.isArray(ignoredList)) {
        throw new TypeError('Respons sync berisi ignored_ids yang tidak valid.');
      }
      const detailsList = response.ignored ?? [];
      if (!Array.isArray(detailsList)) {
        throw new TypeError('Respons sync berisi ignored yang tidak valid.');
      }
      const ignored = new Set(ignoredList);
      if (accepted.size !== response.accepted_ids.length) {
        throw new TypeError('Respons sync berisi id_unik duplikat.');
      }
      if (ignored.size !== ignoredList.length || [...accepted].some((id) => ignored.has(id))) {
        throw new TypeError('Respons sync berisi id_unik ignored yang duplikat atau diterima.');
      }
      for (const id of accepted) {
        if (!submittedIds.has(id)) throw new Error('Server menerima id_unik yang tidak dikirim pada batch ini.');
      }
      for (const id of ignored) {
        if (!submittedIds.has(id)) throw new Error('Server mengabaikan id_unik yang tidak dikirim pada batch ini.');
      }
      const detailIds = new Set();
      for (const detail of detailsList) {
        if (!detail || typeof detail.id_unik !== 'string' || typeof detail.reason !== 'string' ||
            !ignored.has(detail.id_unik) || detailIds.has(detail.id_unik)) {
          throw new TypeError('Respons sync berisi detail scan yang diabaikan tidak valid.');
        }
        detailIds.add(detail.id_unik);
      }
      if (detailsList.length && detailsList.length !== ignored.size) {
        throw new TypeError('Respons sync tidak memberikan detail untuk setiap scan yang diabaikan.');
      }
      const newlyAccepted = [...accepted];
      const newlyIgnored = [...ignored];
      const rejected = [...submittedIds].filter((id) => !accepted.has(id) && !ignored.has(id));
      if (newlyIgnored.length && typeof storage.markIgnored !== 'function') {
        throw new TypeError('Adapter storage harus mendukung penghapusan scan yang diabaikan server.');
      }
      if (newlyAccepted.length) {
        await storage.markSynced({ sekolah_id: String(schoolId), ids: newlyAccepted });
        acceptedIds.push(...newlyAccepted);
      }
      if (newlyIgnored.length) {
        await storage.markIgnored({ sekolah_id: String(schoolId), ids: newlyIgnored });
        ignoredIds.push(...newlyIgnored);
        ignoredDetails.push(...detailsList);
      }
      rejectedIds.push(...rejected);
      batches += 1;
      if (newlyAccepted.length + newlyIgnored.length < pending.length) break;
    }

    return {
      accepted_ids: acceptedIds,
      ignored_ids: ignoredIds,
      ignored_details: ignoredDetails,
      rejected_ids: rejectedIds,
      batches,
    };
  }

  function syncPending() {
    if (syncInFlight) return syncInFlight;
    syncInFlight = runSync().finally(() => { syncInFlight = undefined; });
    return syncInFlight;
  }
  return { enqueue, syncPending };
}
