import 'package:scanner_core/scanner_core.dart';
import 'package:test/test.dart';

class MemoryQueueStore implements AttendanceQueueStore {
  List<AttendanceScan> scans = [];

  @override
  Future<List<AttendanceScan>> readAll() async => List.of(scans);

  @override
  Future<void> writeAll(List<AttendanceScan> scans) async {
    this.scans = List.of(scans);
  }
}

AttendanceScan scan(String id) => AttendanceScan(
      idUnik: id,
      participantId: '1',
      participantCode: 'P-1',
      participantName: 'Peserta',
      classroom: 'Kelas 1',
      clientTimestamp: DateTime.utc(2026, 11, 20, 1),
      eventType: ScanEventType.checkIn,
      attendanceStatus: AttendanceStatus.hadir,
      lateMinutes: 0,
    );

void main() {
  test('deduplicates enqueue and marks only server-confirmed IDs synced', () async {
    final store = MemoryQueueStore();
    final queue = OfflineAttendanceQueue(store);
    await queue.enqueue(scan('stable-1'));
    await queue.enqueue(scan('stable-1'));
    await queue.enqueue(scan('stable-2'));

    final report = await queue.syncPending(
      batchSize: 2,
      uploadBatch: (batch) async => {'stable-1', 'not-in-this-batch'},
    );

    expect(report.acceptedCount, 1);
    expect(report.pendingCount, 1);
    expect((await queue.all()).map((item) => item.syncStatus), [
      SyncStatus.synced,
      SyncStatus.pending,
    ]);
  });

  test('leaves scans pending when the request fails', () async {
    final queue = OfflineAttendanceQueue(MemoryQueueStore());
    await queue.enqueue(scan('stable-1'));

    await expectLater(
      queue.syncPending(
        uploadBatch: (_) async => throw StateError('network unavailable'),
      ),
      throwsStateError,
    );
    expect(await queue.pendingCount(), 1);
  });
}
