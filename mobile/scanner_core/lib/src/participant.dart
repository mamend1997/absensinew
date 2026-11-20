class Participant {
  const Participant({
    required this.id,
    required this.code,
    required this.name,
    required this.classroom,
    required this.qrCode,
    this.isActive = true,
  });

  final String id;
  final String code;
  final String name;
  final String classroom;
  final String qrCode;
  final bool isActive;

  factory Participant.fromJson(Map<String, Object?> json) {
    final active = json['is_active'];
    return Participant(
      id: json['id'].toString(),
      code: json['participant_code'] as String,
      name: json['full_name'] as String,
      classroom: json['classroom_name'] as String,
      qrCode: json['qr_code'] as String,
      isActive: active == null || active == true || active == 1,
    );
  }
}

abstract interface class ParticipantCacheStore {
  Future<List<Participant>> readAll();
  Future<void> replaceAll(List<Participant> participants);
}

class LocalParticipantDirectory {
  LocalParticipantDirectory(this._store);

  final ParticipantCacheStore _store;
  Map<String, Participant> _byQrCode = {};

  Future<void> load() async {
    final participants = await _store.readAll();
    _byQrCode = {
      for (final participant in participants)
        if (participant.isActive && participant.qrCode.isNotEmpty)
          participant.qrCode: participant,
    };
  }

  Participant? findByQrCode(String qrCode) => _byQrCode[qrCode];

  Future<void> replaceSnapshot(List<Participant> participants) async {
    await _store.replaceAll(participants);
    _byQrCode = {
      for (final participant in participants)
        if (participant.isActive && participant.qrCode.isNotEmpty)
          participant.qrCode: participant,
    };
  }
}
