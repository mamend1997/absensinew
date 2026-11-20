const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertQueuedScan(scan, schoolId) {
  if (!scan || String(scan.sekolah_id) !== String(schoolId)) {
    throw new Error('Scan tidak termasuk sekolah pada antrean perangkat ini.');
  }
  if (!UUID_PATTERN.test(scan.id_unik ?? '')) {
    throw new TypeError('id_unik harus berupa UUID yang valid.');
  }
  if (scan.status_sync !== 'pending') {
    throw new TypeError('Scan baru harus berstatus pending.');
  }
  if (!Number.isFinite(new Date(scan.client_timestamp).getTime())) {
    throw new TypeError('client_timestamp harus berupa timestamp yang valid.');
  }
}

export function createOfflineSyncManager({
  schoolId,
  storage,
  sendBatch,
  batchSize = 100,
}) {
  if (!schoolId) throw new TypeError('schoolId wajib tersedia.');
  if (
    !storage ||
    typeof storage.putPendingIfAbsent !== 'function' ||
    typeof storage.listPending !== 'function' ||
    typeof storage.markSynced !== 'function'
  ) {
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
    const rejectedIds = [];
    let batches = 0;

    while (true) {
      const pending = await storage.listPending({
        sekolah_id: String(schoolId),
        limit: batchSize,
      });
      if (!Array.isArray(pending)) {
        throw new TypeError('Adapter storage harus mengembalikan daftar scan pending.');
      }
      if (pending.length === 0) break;
      if (pending.length > batchSize) {
        throw new RangeError('Adapter storage mengembalikan batch melebihi batas.');
      }
      for (const scan of pending) assertQueuedScan(scan, schoolId);

      const submittedIds = new Set(pending.map((scan) => scan.id_unik));
      const response = await sendBatch({
        sekolah_id: String(schoolId),
        records: pending,
      });
      if (!response || !Array.isArray(response.accepted_ids)) {
        throw new TypeError('Respons sync harus berisi accepted_ids.');
      }

      const accepted = new Set(response.accepted_ids);
      if (accepted.size !== response.accepted_ids.length) {
        throw new TypeError('Respons sync berisi id_unik duplikat.');
      }
      for (const id of accepted) {
        if (!submittedIds.has(id)) {
          throw new Error('Server menerima id_unik yang tidak dikirim pada batch ini.');
        }
      }

      const newlyAccepted = [...accepted];
      const rejected = [...submittedIds].filter((id) => !accepted.has(id));
      if (newlyAccepted.length) {
        await storage.markSynced({
          sekolah_id: String(schoolId),
          ids: newlyAccepted,
        });
        acceptedIds.push(...newlyAccepted);
      }
      rejectedIds.push(...rejected);
      batches += 1;

      if (newlyAccepted.length < pending.length) break;
    }

    return { accepted_ids: acceptedIds, rejected_ids: rejectedIds, batches };
  }

  function syncPending() {
    if (syncInFlight) return syncInFlight;
    syncInFlight = runSync().finally(() => {
      syncInFlight = undefined;
    });
    return syncInFlight;
  }

  return { enqueue, syncPending };
}
