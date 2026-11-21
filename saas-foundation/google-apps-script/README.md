# Menghubungkan Portal Sekolah ke Google Sheets

Sinkronisasi berjalan otomatis satu arah: scan diterima backend, lalu backend
mengirim catatan ke Apps Script. Jika scanner sedang offline, data baru masuk
ke Sheets setelah antreannya berhasil tersinkron saat perangkat kembali online.

Tab yang terlihat hanya **Rekap Bulanan**. Isinya adalah satu baris per peserta
per tanggal pada bulan berjalan, dengan tanggal, kelas, waktu masuk/pulang,
status, dan menit keterlambatan. Rekap diperbarui setiap batch absensi diterima
dan disegarkan setiap hari. Tab **Absensi** disembunyikan; tab itu menyimpan
ID sinkronisasi agar kiriman ulang tidak membuat data ganda.

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
7. Lakukan scan percobaan saat perangkat online. Pastikan baris absensi hari
   tersebut muncul di tab **Rekap Bulanan**.

## Perubahan dan batasan

- Setelah mengubah `Code.gs`, pilih **Deploy → Manage deployments**, edit
  deployment Web app, pilih versi baru, lalu deploy. URL deployment biasanya
  tetap sama.
- Sheet menampilkan bulan berjalan saja; saat bulan berganti, tab rekap akan
  menampilkan bulan baru setelah penyegaran harian atau batch absensi berikutnya.
- Riwayat sebelum integrasi diaktifkan tidak dikirim otomatis. Integrasi
  mengirim absensi baru yang diterima server setelah konfigurasi aktif.
- Jika ada scan offline, tanggal dan waktu kejadian asli tetap dipakai saat
  catatan akhirnya masuk ke server dan Google Sheets.
- Jika backend tidak mendapat respons sukses dari Apps Script, sinkron batch
  dilaporkan gagal agar scanner dapat mencoba kembali. Jangan menghapus tab
  **Absensi**; tab tersebut dibutuhkan untuk mencegah duplikasi.
- Jangan membagikan secret. Backend menyimpannya terenkripsi dan tidak
  menanamkannya di APK.
