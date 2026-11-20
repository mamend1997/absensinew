import 'dart:math';

enum ScanEventType { checkIn, checkOut }

enum AttendanceStatus { hadir, terlambat, pulang }

enum SyncStatus { pending, synced }

class AttendanceScan {
  const AttendanceScan({
    required this.idUnik,
    required this.participantId,
    required this.participantCode,
    required this.participantName,
    required this.classroom,
    required this.clientTimestamp,
    required this.eventType,
    required this.attendanceStatus,
    required this.lateMinutes,
    this.syncStatus = SyncStatus.pending,
  });

  final String idUnik;
  final String participantId;
  final String participantCode;
  final String participantName;
  final String classroom;
  final DateTime clientTimestamp;
  final ScanEventType eventType;
  final AttendanceStatus attendanceStatus;
  final int lateMinutes;
  final SyncStatus syncStatus;

  AttendanceScan withSyncStatus(SyncStatus value) => AttendanceScan(
        idUnik: idUnik,
        participantId: participantId,
        participantCode: participantCode,
        participantName: participantName,
        classroom: classroom,
        clientTimestamp: clientTimestamp,
        eventType: eventType,
        attendanceStatus: attendanceStatus,
        lateMinutes: lateMinutes,
        syncStatus: value,
      );

  Map<String, Object?> toJson() => {
        'id_unik': idUnik,
        'participant_id': participantId,
        'participant_code': participantCode,
        'participant_name': participantName,
        'classroom': classroom,
        'client_timestamp': clientTimestamp.toUtc().toIso8601String(),
        'event_type': eventType == ScanEventType.checkIn ? 'check_in' : 'check_out',
        'attendance_status': attendanceStatus.name,
        'late_minutes': lateMinutes,
        'status_sync': syncStatus.name,
      };

  Map<String, Object?> toSyncJson() => {
        'id_unik': idUnik,
        'id_peserta': int.tryParse(participantId) ?? participantId,
        'jenis_absen': eventType == ScanEventType.checkIn ? 'masuk' : 'pulang',
        'client_timestamp': clientTimestamp.toUtc().toIso8601String(),
        'status_kehadiran': attendanceStatus.name,
        'menit_terlambat': lateMinutes,
      };

  factory AttendanceScan.fromJson(Map<String, Object?> json) {
    final eventType = switch (json['event_type']) {
      'check_in' => ScanEventType.checkIn,
      'check_out' => ScanEventType.checkOut,
      _ => throw FormatException('Unknown event_type: ${json['event_type']}'),
    };
    return AttendanceScan(
      idUnik: json['id_unik'] as String,
      participantId: json['participant_id'].toString(),
      participantCode: json['participant_code'] as String,
      participantName: json['participant_name'] as String,
      classroom: json['classroom'] as String,
      clientTimestamp: DateTime.parse(json['client_timestamp'] as String),
      eventType: eventType,
      attendanceStatus: AttendanceStatus.values.byName(
        json['attendance_status'] as String,
      ),
      lateMinutes: json['late_minutes'] as int,
      syncStatus: SyncStatus.values.byName(
        (json['status_sync'] as String?) ?? SyncStatus.pending.name,
      ),
    );
  }
}

String createIdempotencyKey([Random? random]) {
  final source = random ?? Random.secure();
  final bytes = List<int>.generate(16, (_) => source.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}
