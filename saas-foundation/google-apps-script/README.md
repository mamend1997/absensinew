# Menghubungkan Portal Sekolah ke Google Sheets

Sinkronisasi berjalan otomatis satu arah: scan diterima backend, lalu backend
mengirim catatan ke Apps Script. Jika scanner sedang offline, data baru masuk
ke Sheets setelah antreannya berhasil tersinkron saat perangkat kembali online.

Tab **Rekap Bulanan** menampilkan satu baris per peserta untuk bulan berjalan.
Kolom **No** dan **Nama** diikuti satu grup tiga kolom untuk setiap tanggal
yang memiliki data: **Masuk**, **Terlambat** (menit), dan **Keluar**. Tanggal
ditampilkan `dd-MM-yyyy` dan otomatis diurutkan; ketika data tanggal baru
diterima, grup tiga kolomnya dibuat otomatis sebelum **Total Terlambat** dan
**Total Hadir**. Total terlambat menjumlahkan menit keterlambatan, sedangkan
total hadir menghitung tanggal dengan check-in.

Tab **Urutan Peserta** menyimpan susunan baris rekap secara terpisah dari
riwayat scan. Setelah peserta muncul di rekap, pindahkan seluruh barisnya di
tab ini untuk mengatur urutannya. Baris peserta baru ditambahkan di bagian
bawah (urut ID peserta), tanpa mengubah urutan yang sudah Anda atur. Jangan
mengedit kolom `participant_id`; nama dan kode diperbarui dari data aplikasi.

Jangan mengedit langsung waktu di **Rekap Bulanan**, karena rekap dibuat ulang
saat data baru masuk. Untuk koreksi permanen, tambahkan satu baris di
**Koreksi Absensi**:

| Kolom | Isi |
| --- | --- |
| `participant_id` | ID peserta dari tab **Urutan Peserta** |
| `Nama Peserta` | Nama untuk membantu mengenali peserta |
| `Tanggal` | Tanggal absensi |
| `Jenis` | `check_in` untuk Masuk atau `check_out` untuk Keluar |
| `Aksi` | `set` untuk mengisi/mengganti waktu, atau `clear` untuk mengosongkannya |
| `Waktu Koreksi` | Waktu `HH:mm` atau `HH:mm:ss`; wajib untuk aksi `set` |

Koreksi tetap dipakai saat rekap dibangun ulang, termasuk setelah scan baru.
Untuk membatalkan koreksi, hapus seluruh baris koreksi terkait. Jangan
membuat lebih dari satu baris untuk peserta, tanggal, dan jenis absensi yang
sama.

Tab **Absensi** disembunyikan; tab itu menyimpan semua catatan sumber dan ID
sinkronisasi beserta ID peserta yang stabil agar kiriman ulang dan perubahan
kode peserta tidak membuat baris rekap ganda. Rekap dibentuk dari catatan bulan
berjalan dan diperbarui setiap batch absensi diterima.

## Pemasangan

1. Buat spreadsheet Google baru khusus untuk sekolah. Atur zona waktu spreadsheet
   agar sama dengan zona waktu sekolah (umumnya `Asia/Jakarta`).
2. Dari spreadsheet, pilih **Ekstensi → Apps Script**. Ganti isi `Code.gs`
   dengan isi file ini, lalu simpan.
3. Di Apps Script, buka **Project Settings → Script Properties**, tambahkan:
   - Property: `SYNC_SECRET`
   - Value: secret acak minimal 24 karakter. Jangan taruh secret di scanner,
     APK, atau dokumen publik. Contoh membuat secret di PowerShell:
     ```powershell
     $bytes = New-Object byte[] 32
     [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
     [Convert]::ToBase64String($bytes)
     ```
   - Property: `RESET_PIN`
   - Value: PIN pilihan Anda, 4–6 angka. PIN ini diminta sebelum reset riwayat
     dan berbeda dari secret sinkronisasi.
4. Di editor Apps Script, pilih fungsi `installDailyRefreshTrigger`, klik
   **Run**, lalu berikan izin Google yang diminta. Ini membuat tab rekap dan
   pemicu penyegaran harian. Pastikan zona waktu proyek Apps Script juga sama
   dengan zona waktu sekolah.
5. Pilih **Deploy → New deployment → Web app**:
   - **Execute as:** akun pemilik spreadsheet.
   - **Who has access:** Anyone, agar backend dapat mengirim request. Secret
     `SYNC_SECRET` tetap wajib untuk menerima data.
   - Klik **Deploy** dan salin URL yang berakhir dengan `/exec`.
6. Di Portal Sekolah, buka **Pengaturan → Sinkronisasi Google Sheets**.
   Masukkan URL `/exec`, masukkan secret yang sama, centang **Aktifkan
   sinkronisasi**, lalu klik **Simpan pengaturan**.
7. Lakukan scan percobaan saat perangkat online. Pastikan nama peserta muncul
   satu kali dan jam masuk/keluar berada pada baris nama yang benar di tab
   **Rekap Bulanan**. Tab **Urutan Peserta** dan **Koreksi Absensi** dibuat
   otomatis saat rekap pertama kali diperbarui.
8. Muat ulang spreadsheet setelah deployment. Untuk menghapus riwayat secara
   permanen, pilih **Rekap Absensi → Reset semua riwayat**, masukkan `RESET_PIN`,
   lalu konfirmasi.
   Menu ini menghapus tab sumber serta rekap, dan menandai waktu penghapusan
   agar backfill lama dari backend tidak mengembalikan catatan tersebut.
   Susunan di **Urutan Peserta** tetap disimpan; koreksi di **Koreksi Absensi**
   dihapus bersama riwayat.

## Perubahan dan batasan

- Setelah mengubah `Code.gs`, pilih **Deploy → Manage deployments**, edit
  deployment Web app, pilih versi baru, lalu deploy. URL deployment biasanya
  tetap sama.
- Setelah deployment Apps Script dan backend versi terbaru, pilih **Kirim ulang
  riwayat** satu kali dari pengaturan Portal Sekolah. Ini mengisi ID peserta
  stabil pada baris lama tanpa menambah ulang catatan dengan ID unik yang sama,
  sehingga rekap lama dengan kode peserta yang pernah berubah ikut tergabung.
- Sheet menampilkan bulan berjalan saja; saat bulan berganti, tab rekap akan
  menampilkan bulan baru setelah penyegaran harian atau batch absensi berikutnya.
- Mengubah urutan peserta dilakukan di **Urutan Peserta**, bukan di rekap;
  urutannya tidak mengikuti abjad maupun urutan scan.
- Jangan menambahkan atau menggeser kolom secara manual di **Absensi**. Script
  otomatis menambahkan kolom ID peserta saat memperbarui tab sumber lama.
  Menghapus isi tab **Rekap Bulanan** saja tidak menghapus sumbernya; rekap akan
  dibangun kembali. Gunakan menu **Rekap Absensi → Reset semua riwayat**
  untuk menghapus keduanya tanpa memunculkan kembali backfill lama.
- Setelah integrasi diaktifkan dan disimpan, backend otomatis mengirim riwayat
  absensi lama secara bertahap serta meneruskan absensi baru. Tidak diperlukan
  tombol kirim riwayat. Jika Google sementara tidak dapat dijangkau, backend
  menyimpan posisi sinkronisasi dan mencoba kembali otomatis.
- Jika ada scan offline, tanggal dan waktu kejadian asli tetap dipakai saat
  catatan akhirnya masuk ke server dan Google Sheets.
- Jika sinkronisasi gagal, lihat status sinkronisasi di pengaturan portal;
  backend akan mencoba kembali otomatis. Jangan menghapus tab **Absensi**;
  tab tersebut dibutuhkan untuk mencegah duplikasi.
- Jangan membagikan secret. Backend menyimpannya terenkripsi dan tidak
  menanamkannya di APK.
