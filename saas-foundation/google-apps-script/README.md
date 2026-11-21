# Sinkronisasi Google Sheets

1. Buat atau buka spreadsheet tujuan, lalu pilih **Extensions → Apps Script**.
2. Salin isi `Code.gs` ke editor Apps Script.
3. Buka **Project Settings → Script Properties** dan tambahkan `SYNC_SECRET` dengan secret acak minimal 24 karakter. Gunakan nilai yang sama pada pengaturan Google Sheets di Portal Sekolah.
4. Pilih **Deploy → New deployment → Web app**, jalankan sebagai akun pemilik spreadsheet, dan atur akses agar backend dapat mengirim request ke deployment. Salin URL deployment `/exec`.
5. Di Portal Sekolah, buka **Pengaturan → Sinkronisasi Google Sheets**, masukkan URL `/exec` dan secret, centang aktifkan, lalu simpan.

Backend hanya menerima URL deployment HTTPS `script.google.com/macros/s/.../exec`. Data absensi yang diterima server akan diteruskan otomatis satu arah. Kolom `id_unik` dipakai untuk mencegah baris ganda saat perangkat mengirim ulang batch yang sama. Jangan membagikan secret atau menaruhnya di aplikasi scanner.
