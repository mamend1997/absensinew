# Menghubungkan Portal Sekolah ke Google Sheets

Sinkronisasi berjalan otomatis satu arah: scan diterima backend, lalu backend
mengirim catatan ke Apps Script. Jika scanner sedang offline, data baru masuk
ke Sheets setelah antreannya berhasil tersinkron saat perangkat kembali online.

Setiap bulan memiliki tab sendiri dengan nama bulan dan tahun, misalnya
**November 2026** dan **Desember 2026**. Rekap bulan sebelumnya tetap
tersimpan; saat bulan berganti, tab bulan baru dibuat ketika sinkronisasi
berjalan atau pemicu harian memperbarui rekap.

Setiap tab berisi satu baris per peserta. Kolom **No** dan **Nama** diikuti
satu grup tiga kolom untuk setiap tanggal yang memiliki data: **Masuk**,
**Terlambat** (menit), dan **Keluar**. Tanggal ditampilkan `dd-MM-yyyy` dan
diurutkan otomatis. Grup tanggal baru dibuat sebelum **Total Terlambat** dan
**Total Hadir**. Total terlambat menjumlahkan menit keterlambatan, sedangkan
total hadir menghitung tanggal dengan check-in.

Untuk mengatur posisi peserta, pindahkan seluruh baris peserta di tab bulan
aktif. Susunan tersebut dipertahankan saat data baru masuk dan diwariskan ke
tab bulan berikutnya. Kolom metadata di sebelah kanan tabel disembunyikan oleh
script; jangan ditampilkan atau diedit.

Edit sel **Masuk**, **Terlambat**, **Keluar**, **Total Terlambat**, atau
**Total Hadir** langsung untuk menyimpan koreksi. Nilai keterlambatan harus
berupa angka menit nol atau lebih dengan maksimal satu angka desimal; **Total
Hadir** harus berupa bilangan bulat dari 0 sampai 31. Mengosongkan sel **Total
Hadir** akan menghapus angka total dari rekap, dan koreksinya tetap disimpan.
Koreksi dan ID peserta disimpan di kolom metadata tersembunyi pada tab bulan
yang sama, sehingga scan baru tidak mengembalikan nilai yang diedit atau
dihapus. Jangan hapus kolom metadata tersembunyi.

Tab **Absensi** disembunyikan; tab itu menyimpan semua catatan sumber dan ID
sinkronisasi beserta ID peserta yang stabil agar kiriman ulang dan perubahan
kode peserta tidak membuat baris rekap ganda. Setiap rekap dibentuk dari
catatan bulan yang sesuai dan diperbarui saat data untuk bulan tersebut masuk.

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
   **Run**, lalu berikan izin Google yang diminta. Fungsi ini membuat tab
   bulanan untuk data yang sudah ada, menghapus tab lama **Urutan Peserta** dan
   **Koreksi Absensi** setelah memindahkan informasinya, serta memasang pemicu
   penyegaran harian. Pastikan zona waktu proyek Apps Script juga sama dengan
   zona waktu sekolah.
5. Pilih **Deploy → New deployment → Web app**:
   - **Execute as:** akun pemilik spreadsheet.
   - **Who has access:** Anyone, agar backend dapat mengirim request. Secret
     `SYNC_SECRET` tetap wajib untuk menerima data.
   - Klik **Deploy** dan salin URL yang berakhir dengan `/exec`.
6. Di Portal Sekolah, buka **Pengaturan → Sinkronisasi Google Sheets**.
   Masukkan URL `/exec`, masukkan secret yang sama, centang **Aktifkan
   sinkronisasi**, lalu klik **Simpan pengaturan**.
7. Lakukan scan percobaan saat perangkat online. Pastikan data muncul pada tab
   bulan yang sesuai dan jam masuk/keluar berada pada baris nama yang benar.
8. Muat ulang spreadsheet setelah deployment. Untuk menghapus riwayat secara
   permanen, pilih **Rekap Absensi → Reset semua riwayat**, masukkan `RESET_PIN`,
   lalu konfirmasi.
   Menu ini menghapus tab sumber dan seluruh rekap bulanan, lalu menandai waktu
   penghapusan agar backfill lama dari backend tidak mengembalikan catatan.

## Perubahan dan batasan

- Setelah mengubah `Code.gs`, pilih **Deploy → Manage deployments**, edit
  deployment Web app, pilih versi baru, lalu deploy. URL deployment biasanya
  tetap sama. Kemudian jalankan `installDailyRefreshTrigger` sekali lagi agar
  rekap lama dimigrasikan dan tab bantuan lama dihapus.
- Setelah deployment Apps Script dan backend versi terbaru, pilih **Kirim ulang
  riwayat** satu kali dari pengaturan Portal Sekolah. Ini mengisi ID peserta
  stabil pada baris lama tanpa menambah ulang catatan dengan ID unik yang sama,
  sehingga rekap lama dengan kode peserta yang pernah berubah ikut tergabung.
- Tab bernama bulan sebelumnya tidak ditimpa saat bulan berganti. Scan atau
  pemicu harian membuat dan memperbarui tab bulan baru.
- Urutan diatur langsung dengan memindahkan seluruh baris peserta pada tab
  bulan aktif; urutannya tidak mengikuti abjad maupun urutan scan.
- Jangan menambahkan atau menggeser kolom secara manual di **Absensi**. Script
  otomatis menambahkan kolom ID peserta saat memperbarui tab sumber lama.
  Menghapus isi tab bulanan saja tidak menghapus sumbernya; rekap akan
  dibangun kembali. Gunakan menu **Rekap Absensi → Reset semua riwayat**
  untuk menghapus seluruh rekap dan sumber tanpa memunculkan kembali backfill lama.
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
