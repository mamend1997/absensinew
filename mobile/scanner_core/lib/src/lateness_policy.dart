import 'attendance_scan.dart';
import 'participant.dart';

class LatenessResult {
  const LatenessResult(this.status, this.minutes);

  final AttendanceStatus status;
  final int minutes;
}

LatenessResult calculateCheckInStatus({
  required DateTime clientTimestamp,
  required DateTime scheduledDeadline,
  int toleranceMinutes = 0,
}) {
  if (toleranceMinutes < 0) {
    throw ArgumentError.value(toleranceMinutes, 'toleranceMinutes');
  }
  final threshold = scheduledDeadline.add(Duration(minutes: toleranceMinutes));
  if (clientTimestamp.isBefore(threshold) ||
      clientTimestamp.isAtSameMomentAs(threshold)) {
    return const LatenessResult(AttendanceStatus.hadir, 0);
  }

  final lateSeconds =
      clientTimestamp.difference(threshold).inSeconds;
  final lateMinutes = (lateSeconds + 59) ~/ 60;
  return LatenessResult(AttendanceStatus.terlambat, lateMinutes);
}

AttendanceScan createAttendanceScan({
  required Participant participant,
  required ScanEventType eventType,
  required DateTime clientTimestamp,
  required DateTime scheduledDeadline,
  int toleranceMinutes = 0,
  String? idUnik,
}) {
  final lateness = eventType == ScanEventType.checkIn
      ? calculateCheckInStatus(
          clientTimestamp: clientTimestamp,
          scheduledDeadline: scheduledDeadline,
          toleranceMinutes: toleranceMinutes,
        )
      : const LatenessResult(AttendanceStatus.pulang, 0);

  return AttendanceScan(
    idUnik: idUnik ?? createIdempotencyKey(),
    participantId: participant.id,
    participantCode: participant.code,
    participantName: participant.name,
    classroom: participant.classroom,
    clientTimestamp: clientTimestamp,
    eventType: eventType,
    attendanceStatus: lateness.status,
    lateMinutes: lateness.minutes,
  );
}
