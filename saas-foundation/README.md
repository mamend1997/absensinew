# Fondasi SaaS Multi-Tenant Ruang Hadir

Fondasi Tahap 1 ini terpisah dari aplikasi absensi yang sedang berjalan di
`backend/`, `web/`, dan `mobile/`. Tidak ada API atau login aktif yang berubah.
Kode inti tidak membutuhkan Flutter, Android SDK, maupun dependency eksternal.

## Struktur tujuan

```text
D:\absensi\
├─ backend\                         # API aplikasi yang saat ini berjalan
├─ web\                             # portal sekolah yang saat ini berjalan
├─ mobile\                          # modul scanner yang saat ini berjalan
└─ saas-foundation\
   ├─ database\
   │  └─ schema.sql                 # skema MySQL 8 multi-tenant + seed aman
   ├─ backend\
   │  ├─ src\
   │  │  ├─ core\
   │  │  │  ├─ school-code.js       # generator/validator kode 4 digit
   │  │  │  ├─ permissions.js       # pemeriksaan role dan tenant
   │  │  │  ├─ attendance.js        # aturan hadir/telat/pulang + model scan
   │  │  │  ├─ offline-sync.js      # antrean terisolasi dan batch idempotent
   │  │  ├─ routes\
   │  │  │  ├─ super-admin.js       # Tahap 2: login/pengelolaan tenant
   │  │  │  ├─ school-auth.js       # Tahap 2: login dengan kode sekolah
   │  │  │  ├─ roles.js              # Tahap 2: role dan permission dinamis
   │  │  │  ├─ participants.js      # Tahap 2: master peserta per tenant
   │  │  │  ├─ attendance.js        # Tahap 2: sync batch dan rekap
   │  │  │  └─ devices.js            # Tahap 2: API key perangkat
   │  │  └─ middleware\
   │  │     ├─ tenant-context.js     # tenant dari sesi/perangkat tepercaya
   │  │     └─ require-permission.js
   │  ├─ test\
   │  │  └─ core.test.js             # tes fondasi yang tersedia sekarang
   │  └─ package.json
   ├─ web\
   │  ├─ super-admin\                # Tahap 3: portal platform di jalur terpisah
   │  └─ school-portal\              # Tahap 3: dashboard dan login sekolah
   ├─ mobile\
   │  └─ school-scanner\             # Tahap 3: scanner; APK pada Tahap 4
   └─ README.md
```

Folder route, middleware, portal, dan scanner pada pohon adalah struktur tujuan
Tahap 2–3, bukan stub yang sudah aktif. Fondasi yang benar-benar dibuat pada
Tahap 1 adalah schema dan empat modul inti di `backend/src/core/`.

## Jalankan tes inti

```powershell
cd saas-foundation
npm.cmd test
```

## Backend Tahap 2 (Express + MySQL)

Backend ini berjalan terpisah di `backend/`; aplikasi root, web, mobile, dan
`D:\absensi\backend` tidak digunakan atau diubah.

1. Gunakan Node.js 22.5+ dan MySQL 8+. Buat database khusus kosong serta akun
   MySQL dengan hak akses minimum untuk database tersebut.
2. Buat database MySQL khusus, misalnya `absensi_saas`, lalu jalankan
   `mysql -u <admin> -p absensi_saas < database\schema.sql` dari
   `D:\absensi\saas-foundation` (di PowerShell, jalankan perintah impor melalui
   `cmd /c` agar `<` menjadi input redirection).
3. Dari `backend\`, jalankan `Copy-Item .env.example .env`, lalu isi koneksi MySQL.
   Buat secret JWT dengan `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`
   dan masukkan sebagai `JWT_SECRET`. Server gagal mulai bila secret tidak ada
   atau kurang dari 32 byte. Jangan gunakan contoh placeholder.
4. Jalankan `npm.cmd install`, kemudian provisioning sekali:
   ```powershell
   $env:BOOTSTRAP_SUPER_ADMIN_PASSWORD = Read-Host "Password Super Admin"
   $env:BOOTSTRAP_SCHOOL_ADMIN_PASSWORD = Read-Host "Password Admin Sekolah"
   npm.cmd run provision
   Remove-Item Env:BOOTSTRAP_SUPER_ADMIN_PASSWORD,Env:BOOTSTRAP_SCHOOL_ADMIN_PASSWORD
   ```
   Password tidak memiliki default; gunakan minimal 12 karakter dan simpan di
   secret manager. Username awal dapat diubah lewat
   `BOOTSTRAP_SUPER_ADMIN_USERNAME` / `BOOTSTRAP_SCHOOL_ADMIN_USERNAME`.
5. Jalankan `npm.cmd start` atau `npm.cmd run dev`. Health check:
   `GET http://127.0.0.1:4100/api/health`. Tes: `npm.cmd test`.

Super Admin dan akun sekolah mempunyai token dan endpoint login terpisah. Setiap
request sekolah membaca ulang user, role/permissions, status sekolah, dan kode
sekolah; reset kode membatalkan token lama. Perangkat mengautentikasi dengan
`x-device-key`, menyimpan hash SHA-256 saja di database, dan kunci hanya
ditampilkan satu kali ketika perangkat dibuat. API tidak menggunakan `school_id`
dari body sebagai identitas tenant. Sekolah baru melalui Super Admin wajib
menyertakan `initial_admin` (`username`, `display_name`, `password` minimal 12
karakter), dan sistem membuat role operasional serta jadwal default.

Super Admin dapat mengunggah logo platform di panelnya. Logo PNG, JPEG, atau
WebP maksimal 1 MB disimpan pada tabel `platform_branding` dan digunakan sebagai
favicon di portal Super Admin serta portal sekolah. Endpoint publik
`GET /api/branding/logo` menyajikan gambar favicon; unggah dan hapus logo
menggunakan `PUT`/`DELETE /api/super-admin/branding/logo` dengan autentikasi
Super Admin. Tabel branding dibuat otomatis saat backend mulai, juga tercantum
di `database/schema.sql`.

Super Admin juga dapat mengatur endpoint WhatsApp gateway HTTPS yang menerima
`POST` JSON `{ "phone": "...", "message": "..." }` dengan header Bearer. Token
gateway dienkripsi dengan AES-GCM sebelum disimpan; OTP pendaftaran berlaku
5 menit, dibatasi 5 percobaan verifikasi, dan permintaannya dibatasi per nomor
serta IP. Pendaftaran mandiri membuat sekolah trial 30 hari setelah OTP benar.
Username Admin sekolah baru adalah nomor WhatsApp yang telah dinormalisasi.
Kata sandi harus memiliki minimal 8 karakter, huruf besar, angka, dan simbol.

Link unduhan APK Google Drive dapat diatur Super Admin dan tampil pada menu
“Unduh APK” di portal sekolah setelah dipasang. Untuk saat ini link file harus
mengarah ke Google Drive, dan akses berbagi file perlu mengizinkan akun sekolah
mengunduhnya.

## Menyiapkan APK portal sekolah dengan Capacitor

Portal terbaru di `web/school-portal` sudah memiliki konfigurasi Capacitor Android.
Aplikasi ini memakai `https://localhost` sebagai origin Android untuk mendukung
konteks aman kamera. API harus tersedia melalui HTTPS dan konfigurasi `CORS_ORIGINS`
backend perlu mengizinkan `https://localhost` selain origin portal web.
Scanner menggunakan kamera depan dan mode scan cepat secara default; arah kamera,
mode cepat/seimbang, serta field scanner barcode USB/Bluetooth dapat diatur pada
Pengaturan dan disimpan lokal per perangkat. Jika field USB/Bluetooth dinonaktifkan,
field tersebut disembunyikan dari layar scanner.

1. Pasang Android Studio, JDK 21, Android SDK Platform 36, Build-Tools, dan
   Platform-Tools. Node.js 22.5 atau lebih baru diperlukan.
2. Dari `saas-foundation/web`, instal dependency workspace dan isi URL backend
   publik sebelum membangun. Nilai URL bukan rahasia; jangan memasukkan API key:
   ```powershell
   npm.cmd install
   $env:VITE_API_BASE_URL = "https://<domain-api>/api"
   npm.cmd run android:sync --workspace school-portal
   ```
3. Buka proyek Android Studio:
   ```powershell
   npm.cmd run android:open --workspace school-portal
   ```
   Untuk membuat APK debug dari terminal, jalankan
   `.\gradlew.bat assembleDebug` di `web/school-portal/android`. APK berada di
   `android/app/build/outputs/apk/debug/app-debug.apk`.
4. Uji login, izin kamera, scan, antrean offline, dan sinkronisasi saat online
   pada perangkat Android. Build membutuhkan Android SDK/JDK; `cap sync` saja
   belum menghasilkan APK.

APK release perlu ditandatangani dengan keystore privat yang disimpan di luar
version control. Jangan membagikan atau menanam rahasia backend di dalam APK.

Pembayaran sekolah menggunakan Xendit, Duitku, atau Kasera. Kasera diatur dari
Super Admin → Pengaturan payment gateway: masukkan API key live dan webhook
signing secret, lalu daftarkan URL yang ditampilkan sebagai endpoint webhook
Kasera untuk event `payment.paid`. Backend memverifikasi header
`Kasera-Signature-V1` memakai raw body dan batas waktu lima menit sebelum
mengaktifkan langganan. Kasera menggunakan hosted checkout di
`https://pay.kasera.id/v1/transactions`; untuk nominal di atas Rp1.000.000,
gunakan provider lain karena API Kasera mewajibkan attestasi pengiriman.
Spesifikasi API: https://pay.kasera.id/v1/openapi.json.

Xendit, Duitku, dan Kasera dapat diatur dari Super Admin atau menggunakan
fallback environment pada `backend\.env.example` (jangan commit secret). Saat
pengaturan disimpan melalui portal Super Admin, URL publik portal dan API
disimpan otomatis dari origin yang sedang digunakan. Pastikan alamat tersebut
merupakan HTTPS publik dan dapat menerima callback provider.
Atur callback Xendit ke
`/api/payments/xendit/callback` dan callback Duitku ke
`/api/payments/duitku/callback`; callback Xendit harus menggunakan token yang
sama dengan `XENDIT_CALLBACK_TOKEN`. Atur harga paket melalui menu Super Admin;
default-nya Rp50.000/bulan dan Rp1.000.000 untuk Lifetime. Status pesanan hanya
diaktifkan setelah callback provider lolos verifikasi dan nominalnya cocok.
Sekolah yang kedaluwarsa masih dapat masuk ke halaman langganan untuk membayar,
tetapi endpoint operasional tetap ditolak sampai pembayaran terkonfirmasi.

Portal sekolah menyediakan pengaturan gateway WhatsApp per sekolah. Alamat
gateway dan token Bearer disimpan secara tenant-scoped; token dienkripsi sebelum
disimpan. Rahasia `JWT_SECRET` harus dijaga tetap stabil karena digunakan untuk
menurunkan kunci enkripsi token tersimpan.

Nomor WA peserta dapat disimpan dari form Peserta atau template impor Excel.
Jika check-in baru tercatat terlambat dan gateway sekolah aktif, backend
mengantrikan notifikasi ke nomor peserta; pengiriman dicoba ulang jika gateway
sementara gagal.

Master peserta mendukung impor `.xlsx` melalui menu Peserta. Unduh template
terlebih dahulu untuk mendapatkan referensi ID kelas; impor dibatasi 500 peserta
per file. Jadwal masuk khusus peserta dapat disimpan per hari dan ikut tersimpan
di cache lokal scanner untuk perhitungan saat offline.

Konfigurasi `.env` hanya dibaca backend; jangan commit file tersebut. Endpoint
pengelolaan memakai permissions yang telah diseed schema; tidak ada perubahan
pada skema inti.

Super Admin dapat menjadwalkan backup harian database platform pada panel
Super Admin. Atur `BACKUP_DIRECTORY` ke persistent volume privat Railway dan
`BACKUP_TIMEZONE` ke zona waktu yang diinginkan sebelum mengaktifkan jadwal.
File tersimpan dengan AES-256-GCM; Telegram hanya menerima status dan tidak
menerima data tenant atau file backup. Backup terakhir dapat diunduh terenkripsi
dari panel. Untuk membuka file, gunakan
`node scripts/decrypt-platform-backup.js <file.enc> <backup.json>` dari folder
`backend` dengan `JWT_SECRET` yang sama. JSON hasil dekripsi berisi data seluruh
sekolah dan hash kredensial, sehingga harus disimpan serta diproses dengan aman.

## Skema dan seed

`database/schema.sql` menyiapkan tabel Super Admin global; sekolah dan status
langganan; users, role dan permissions; unit, kelas, peserta; pengaturan jam,
jadwal mingguan dan hari libur; perangkat scanner; pengecualian izin/sakit;
log absensi idempotent; dan log audit. Semua tabel data sekolah membawa
`sekolah_id`; relasi menggunakan foreign key gabungan agar baris dari tenant
lain tidak dapat direferensikan.

Kode sekolah selalu disimpan sebagai teks empat digit agar nol di depan tidak
hilang. Seed sekolah contoh memakai `4829`; seed ini hanya untuk database baru.
Generator sekolah baru memakai sumber kriptografis dan pengecekan bentrok.
Unique index database tetap wajib sebagai perlindungan dari pembuatan serentak;
Tahap 2 akan menangani retry jika insert berbenturan.

Seed membuat akun bootstrap Super Admin dan Admin Sekolah dalam status
nonaktif dengan hash placeholder yang tidak dapat dipakai untuk login. Sebelum
aktivasi, provisioning Tahap 2 wajib mengisi hash bcrypt baru melalui secret
operator dan mengaktifkan akun. Tidak ada password default yang ditanam.

## Batas keamanan tenant

- Jalur Super Admin terpisah dari login sekolah; tabel `super_admins` adalah
  satu-satunya tabel global.
- Kode sekolah mengidentifikasi sekolah saat login, tetapi bukan rahasia atau
  pengganti password. Keanggotaan user dan role harus diverifikasi server-side.
- API mengambil `sekolah_id` dari sesi/token atau API key perangkat yang sudah
  diverifikasi—jangan mempercayai `sekolah_id` mentah dari body request.
- Permission role berasal dari database dan diikat ke role pada sekolah yang
  sama. `permissions.js` menolak tenant yang berbeda.
- Database menyimpan hash API key perangkat. Di perangkat, kunci perlu
  disimpan di secure storage yang sesuai platform dan dapat dicabut.
- `offline-sync.js` mensyaratkan adapter storage terisolasi per sekolah,
  menjaga `id_unik` dan `client_timestamp`, mengirim batch maksimal 100, dan
  hanya menandai ID yang dikonfirmasi server sebagai `synced`.
