import 'dart:async';

import 'attendance_scan.dart';

abstract interface class AttendanceQueueStore {
  Future<List<AttendanceScan>> readAll();
  Future<void> writeAll(List<AttendanceScan> scans);
}

typedef BatchUploader = Future<Set<String>> Function(
  List<AttendanceScan> batch,
);

class SyncReport {
  const SyncReport({
    required this.acceptedCount,
    required this.pendingCount,
  });

  final int acceptedCount;
  final int pendingCount;
}

class OfflineAttendanceQueue {
  OfflineAttendanceQueue(this._store);

  final AttendanceQueueStore _store;
  Future<void> _storageTail = Future<void>.value();
  bool _syncInProgress = false;

  Future<T> _withStorageLock<T>(Future<T> Function() operation) {
    final result = Completer<T>();
    _storageTail = _storageTail.then((_) async {
      try {
        result.complete(await operation());
      } catch (error, stackTrace) {
        result.completeError(error, stackTrace);
      }
    });
    return result.future;
  }

  Future<void> enqueue(AttendanceScan scan) => _withStorageLock(() async {
        final scans = await _store.readAll();
        if (scans.any((item) => item.idUnik == scan.idUnik)) return;
        await _store.writeAll([...scans, scan]);
      });

  Future<List<AttendanceScan>> all() =>
      _withStorageLock(() => _store.readAll());

  Future<int> pendingCount() async =>
      (await all()).where((scan) => scan.syncStatus == SyncStatus.pending).length;

  Future<SyncReport> syncPending({
    required BatchUploader uploadBatch,
    int batchSize = 50,
  }) async {
    if (batchSize < 1) {
      throw ArgumentError.value(batchSize, 'batchSize', 'Must be at least 1');
    }
    if (_syncInProgress) {
      throw StateError('A batch sync is already in progress');
    }

    _syncInProgress = true;
    var acceptedCount = 0;
    try {
      final pending = (await all())
          .where((scan) => scan.syncStatus == SyncStatus.pending)
          .toList(growable: false);

      for (var start = 0; start < pending.length; start += batchSize) {
        final end = (start + batchSize < pending.length)
            ? start + batchSize
            : pending.length;
        final batch = pending.sublist(start, end);
        final batchIds = batch.map((scan) => scan.idUnik).toSet();
        final acceptedIds = await uploadBatch(batch);
        final confirmedIds = acceptedIds.intersection(batchIds);
        if (confirmedIds.isEmpty) continue;

        await _withStorageLock(() async {
          final current = await _store.readAll();
          await _store.writeAll([
            for (final scan in current)
              if (confirmedIds.contains(scan.idUnik))
                scan.withSyncStatus(SyncStatus.synced)
              else
                scan,
          ]);
        });
        acceptedCount += confirmedIds.length;
      }

      return SyncReport(
        acceptedCount: acceptedCount,
        pendingCount: await pendingCount(),
      );
    } finally {
      _syncInProgress = false;
    }
  }
}
