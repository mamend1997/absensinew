import 'package:scanner_core/scanner_core.dart';
import 'package:test/test.dart';

void main() {
  group('calculateCheckInStatus', () {
    final deadline = DateTime(2026, 11, 20, 8);

    test('is present through the exact deadline', () {
      expect(
        calculateCheckInStatus(
          clientTimestamp: deadline,
          scheduledDeadline: deadline,
        ).status,
        AttendanceStatus.hadir,
      );
    });

    test('rounds a positive partial minute up', () {
      final result = calculateCheckInStatus(
        clientTimestamp: deadline.add(const Duration(seconds: 1)),
        scheduledDeadline: deadline,
      );
      expect(result.status, AttendanceStatus.terlambat);
      expect(result.minutes, 1);
    });

    test('applies tolerance before counting late minutes', () {
      final result = calculateCheckInStatus(
        clientTimestamp: deadline.add(const Duration(minutes: 6)),
        scheduledDeadline: deadline,
        toleranceMinutes: 5,
      );
      expect(result.status, AttendanceStatus.terlambat);
      expect(result.minutes, 1);
    });
  });
}
