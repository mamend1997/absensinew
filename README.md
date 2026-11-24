# Sistem Absensi Semi-Online

Proyek ini disiapkan agar logika dan web dapat dibangun tanpa Flutter SDK. Tahap 1
menyediakan skema serta domain scanner, Tahap 2 backend, dan Tahap 3 dashboard
serta scanner web. Tahap 4 menyiapkan panduan pembungkus Android Capacitor.

## Struktur proyek

```text
absensi/
├── backend/
│   ├── .env.example
│   ├── package.json
│   ├── database/
│   │   ├── schema.sql                 # MySQL/MariaDB
│   │   └── schema.sqlite.sql          # SQLite untuk pengembangan lokal
│   ├── src/
│   │   ├── config/
│   │   ├── middleware/
│   │   ├── routes/
│   │   └── services/
│   ├── scripts/
│   └── test/
├── mobile/
│   └── scanner_core/                  # Dart murni, tanpa dependency Flutter
│       ├── lib/src/
│       └── test/
├── web/
│   ├── android/                      # proyek native Capacitor Android
│   ├── public/
│   ├── src/
│   ├── src/components/
│   ├── src/lib/
│   ├── capacitor.config.json
│   └── package.json
└── README.md
```

Backend tersedia di `backend/src`; dashboard dan scanner web ada di `web/src`.
Antrean browser disimpan di IndexedDB dan memakai kontrak serta aturan yang sama
dengan domain murni di `mobile/scanner_core`.

## Skema dan seed

- MySQL/MariaDB: jalankan `backend/database/schema.sql`.
- SQLite lokal: jalankan `backend/database/schema.sqlite.sql`.
- Kedua skema membuat tabel akun, unit/kelas, peserta, PIN menu Admin, pengaturan
  scanner, dan log absensi, serta seed pengaturan operasional dan peserta contoh.
- Akun admin tidak diberi password default di SQL. Buat akun awal menggunakan
  CLI interaktif `npm run user:create`; kredensial tidak tertanam di repository.
- Pengaturan awal menggunakan zona waktu `Asia/Jakarta`, batas masuk `08:00:00`,
  toleransi 0 menit, dan jam pulang `15:00:00`. Sesuaikan sebelum digunakan.
- Halaman **Pengaturan** menyediakan batas masuk, toleransi, dan jam pulang
  untuk setiap hari dalam pekan. Batas masuk khusus dapat ditetapkan untuk
  peserta tertentu pada hari tertentu, misalnya pukul `06:45`; toleransinya
  mengikuti aturan umum hari tersebut. Jadwal dan pengecualian tersimpan lokal
  pada perangkat scanner dan divalidasi kembali oleh server saat sinkronisasi.

## Aturan inti scanner

- QR/barcode peserta dicari dari snapshot master lokal, sehingga identitas dapat
  ditampilkan tanpa koneksi internet. Adapter aplikasi wajib memperbarui snapshot
  master saat online.
- Waktu scan adalah waktu perangkat saat kejadian (`client_timestamp`), disimpan
  sebagai UTC ISO-8601. UI dapat menampilkan waktu lokal.
- Adapter aplikasi harus memilih aturan hari dan pengecualian peserta dari
  tanggal kejadian dalam zona waktu pengaturan sebelum menghitung keterlambatan.
  Nilai ini tidak boleh ditafsirkan memakai zona waktu server secara implisit.
- Keterlambatan dimulai setelah batas masuk ditambah toleransi. Selisih setelah
  batas+toleransi dibulatkan ke atas ke menit penuh; scan pada/lebih awal dari
  ambang adalah `hadir` dengan 0 menit. Scan pulang sebelum jam pulang ditolak
  server; scan valid memakai status `pulang`.
- Setiap scan mempunyai UUID v4 `id_unik` yang disimpan bersama antrean; UUID itu
  tidak berubah saat dikirim ulang. Status lokal dimulai `pending`.
- Sinkronisasi mengirim batch dan hanya mengubah ID yang secara eksplisit
  dikonfirmasi server menjadi `synced`. Kegagalan request diteruskan ke pemanggil;
  item yang belum dikonfirmasi tetap `pending`.
- Server memiliki unique constraint pada `id_unik`, memproses batch
  secara idempotent, dan mengembalikan daftar ID yang diterima. Constraint unik
  peserta/tanggal/jenis scan juga mencegah scan masuk atau pulang ganda.

Kontrak sinkronisasi `POST /api/absensi/sync-batch` menerima
`{ "records": [<AttendanceScan.toSyncJson()>] }` (atau array langsung), dengan
`id_unik`, `id_peserta`, `jenis_absen`, `client_timestamp`,
`status_kehadiran`, dan `menit_terlambat`; `scan_method` opsional bernilai
`SCAN_QR` atau `MANUAL_INPUT` (jika tidak dikirim dianggap `SCAN_QR`). Respons berisi
`{ "accepted_ids": ["..."], "rejected": [] }`. ID mencakup catatan baru dan retry
identik; benturan ID berbeda, status yang tidak sesuai pengaturan, dan scan
harian duplikat ditolak. Nilai status/menit divalidasi ulang server dari waktu
kejadian dan pengaturan operasional.

## Tahap 2: menjalankan backend

Perlu Node.js 22.5 atau lebih baru (adapter SQLite menggunakan `node:sqlite`).
Di terminal VS Code:

```powershell
cd backend
npm.cmd install
Copy-Item .env.example .env
```

Ganti `JWT_SECRET` di `.env` dengan secret acak minimal 32 karakter. SQLite
digunakan secara default dan membuat file lokal pada `SQLITE_PATH`. Untuk MySQL,
ubah `DB_DRIVER=mysql`, isi koneksi MySQL, dan buat database `absensi` beserta
user yang memiliki hak DDL/DML sebelum inisialisasi. Berikutnya:

```powershell
npm.cmd run db:init
npm.cmd run user:create -- --username=admin --name="Administrator" --role=admin
npm.cmd start
```

Perintah pembuatan akun meminta password secara interaktif; buat akun operator
dengan `--role=operator --classroom-id=<ID kelas>`. Tidak ada password default
atau akun admin seed. `npm.cmd test` menjalankan tes API dengan SQLite sementara.

### Konversi dump MySQL ke SQLite

Untuk membuat file SQLite staging baru dari dump SQL MySQL tanpa menimpa file
database yang sudah ada, jalankan dari folder `backend`:

```powershell
node scripts/import-mysql-dump-sqlite.js --input <dump.sql> --output <file-baru.sqlite>
```

Importer menolak file output yang sudah ada, memvalidasi integritas SQLite dan
foreign key, serta hanya menerima pernyataan dump yang didukung. File hasil
adalah salinan staging; proses ini tidak mengubah database sumber atau
mengalihkan aplikasi.

### Backend SaaS dengan SQLite

Backend `saas-foundation/backend` kini dapat memakai SQLite melalui
`DB_DRIVER=sqlite`; skema SaaS tanpa data ada di
`saas-foundation/database/schema.sqlite.sql`. Untuk pengembangan lokal, gunakan
`SQLITE_PATH=./data/absensi_saas.sqlite`. Backend SaaS membutuhkan Node.js
22.13 atau lebih baru. File SQLite hasil konversi memuat data produksi dan
tidak boleh dimasukkan ke GitHub.
Perubahan skema SaaS berikutnya juga harus dicatat pada
`saas-foundation/database/schema.sqlite.sql`; startup akan gagal jelas jika
kolom wajib belum tersedia.

Untuk Railway, siapkan persistent volume (misalnya mount `/data`), lalu atur
`DB_DRIVER=sqlite` dan `SQLITE_PATH=/data/absensi_saas.sqlite` pada service SaaS.
Gunakan satu replica saja karena SQLite tidak cocok untuk beberapa instance
yang menulis ke file yang sama. Sebelum cutover, ekspor ulang MySQL terbaru,
buat dan validasi file SQLite baru, salin ke volume, lalu alihkan service dalam
jendela pemeliharaan. Pertahankan MySQL dan backup untuk rollback sampai
verifikasi data serta alur aplikasi selesai. Jangan mengubah konfigurasi
Railway atau menghapus MySQL sebelum cutover direncanakan dan diuji.

### Endpoint Tahap 2

- `POST /api/auth/login`, `GET /api/auth/me`
- `GET /api/auth/menu-pin/status`, `POST /api/auth/menu-pin/setup`,
  `POST /api/auth/menu-pin/verify`, admin: `PUT /api/auth/menu-pin/change`
- `GET /api/peserta` (snapshot peserta aktif), admin: `POST`, `PUT /:id`,
  `DELETE /:id` (nonaktifkan), `POST /import` (upsert berdasarkan kode peserta)
- Admin: `GET/POST /api/kelas`, `PUT/DELETE /api/kelas/:id`; kelas yang masih
  dipakai peserta atau akun operator tidak dapat dihapus.
- `GET /api/pengaturan`, admin: `PUT /api/pengaturan`
- `POST /api/absensi/sync-batch`, `GET /api/absensi/rekap`
- Respons rekap mempunyai `summary` dan baris harian peserta, termasuk yang
  belum hadir. Filter menggunakan `start_date`/`end_date` atau `month`/`year`,
  `classroom_id`, `unit_id`, dan `status`. Maksimum rentang 366 hari dengan
  batas hasil 50.000 peserta-hari per request.

Semua endpoint kecuali health check dan login meminta header `Authorization:
Bearer <token>`. Operator dibatasi pada kelas yang terhubung dengan akunnya.
Pembatasan percobaan masuk berlaku hanya pada endpoint login, sedangkan
percobaan PIN memiliki batas tersendiri; pemeriksaan status PIN tidak memakai
batas percobaan yang sama.

Sinkronisasi master peserta dan pengaturan mengembalikan `sync_cursor`; kirim
cursor sebagai `updated_since` untuk mengambil delta. Peserta nonaktif dan
perpindahan kelas ditangani sebagai penghapusan lokal tanpa membagikan identitas
peserta di luar kelas Operator.

Menu Admin **Audit & Backup** menampilkan riwayat pembuatan/perubahan/
penonaktifan peserta dan kelas, pengaturan operasional, absensi baru, serta
ekspor/pemulihan cadangan. Catatan aktivitas ditulis dalam transaksi bersama
perubahannya dan berisi akun, waktu, IP, entitas, serta nilai sebelum/sesudah
yang relevan. Endpoint Admin `GET /api/admin-tools/activity-logs` menyediakan
log berpaginasi.

Cadangan diunduh sebagai JSON dari `GET /api/admin-tools/backup`; file ini
mencakup seluruh tabel sistem, termasuk hash kredensial akun dan audit, sehingga
wajib disimpan di lokasi aman. Restore melalui
`POST /api/admin-tools/backup/restore` menerima hanya format/version backup
sistem yang dikenal, maksimal 25 MB/300.000 baris, dan menolak cadangan tanpa
Admin aktif. Restore menggantikan seluruh data aktif dalam transaksi, lalu
mempertahankan log lokal yang sudah ada, menambahkan log dari backup tanpa
duplikasi ID, dan mencatat aktivitas restore. Dari panel, Admin harus memilih file dan mengetik
`PULIHKAN DATABASE` sebelum konfirmasi.

Admin juga dapat menjadwalkan backup harian dari menu **Audit & Backup**. Atur
`BACKUP_DIRECTORY` pada environment backend ke direktori pada persistent volume
privat (misalnya `/data/backups` di Railway), lalu isi waktu dan kredensial Bot
Telegram serta Chat ID pada panel. Jam mengikuti `APP_TIMEZONE`. File backup
disimpan terenkripsi AES-256-GCM di volume tersebut; bot hanya menerima
notifikasi status dan tidak pernah menerima file, data peserta, atau hash akun.
Kunci enkripsi diturunkan dari `JWT_SECRET`, jadi secret itu harus tetap stabil
dan backup perlu disalin secara aman ke penyimpanan terpisah untuk pemulihan
bencana. Backup terakhir dapat diunduh terenkripsi dari panel Admin. Untuk
memulihkannya, gunakan `node scripts/decrypt-scheduled-backup.js <file.enc>
<backup.json>` dari folder `backend` dengan `JWT_SECRET` yang sama, lalu unggah
JSON hasil dekripsi pada panel Restore. File hasil dekripsi memuat data pribadi
dan hash kredensial; simpan dan hapus dengan aman setelah pemulihan. Backup JSON
manual tetap berisi hash kredensial dan harus disimpan dengan aman.

Notifikasi hanya dibuat untuk absensi baru setelah record tersimpan dalam
transaksi. Nomor wali diatur melalui `guardian_phone` pada master peserta; nomor
Admin diatur melalui `NOTIFICATION_ADMIN_PHONE`. Admin sekolah dapat mengatur
URL HTTPS gateway dan Bearer token melalui **Pengaturan → Gateway WhatsApp**.
Token disimpan terenkripsi dan tidak ditampilkan kembali; konfigurasi URL hanya
menerima host HTTPS publik. Backend mengirim `POST` ber-header
`Authorization: Bearer <token>` dan body `{ "to", "message", "event" }` melalui
outbox dengan retry. Environment lama `WHATSAPP_GATEWAY_URL` dan
`WHATSAPP_GATEWAY_TOKEN` masih menjadi fallback sampai Admin menyimpan atau
menghapus konfigurasi akun sekolah. `NOTIFICATION_LATE_MINUTES=0` mengirim
notifikasi untuk setiap status terlambat. Jangan simpan token gateway di repository.

## Tahap 3: menjalankan web dan scanner

Web menggunakan React, TypeScript, Vite, IndexedDB, ZXing untuk browser, dan
plugin ML Kit saat berjalan di Capacitor Android. Di terminal VS Code:

```powershell
cd web
npm.cmd install
npm.cmd run dev
```

Jalankan backend di terminal lain pada port 3000. Vite meneruskan `/api` ke
backend lokal. Login memerlukan jaringan untuk pertama kali; setelah itu token,
master peserta, jam operasional, dan antrean scan tersedia lokal. Jika jaringan
putus, pemindaian masih dapat mengenali peserta yang sudah tersimpan. Perangkat
menyinkronkan batch (maksimal 100 record) saat koneksi tersedia, dan hanya
`accepted_ids` yang menjadi `synced`.

Dashboard menyediakan rekap harian, rentang tanggal, dan bulanan dengan filter
unit/kelas/status. Ekspor menghasilkan file Excel `.xlsx` berbentuk tabel;
rekap harian dan rentang memuat waktu masuk/pulang dan menit terlambat,
sedangkan rekap bulanan mengelompokkan Masuk/Keluar/Telat per hari serta total
telat, hadir, dan tidak hadir. Cetak/Save as PDF hanya menampilkan tabel laporan;
rekap bulanan dicetak per kelompok tujuh hari agar tetap terbaca. Tabel ringkasan
layar menampilkan Masuk, Telat, dan Pulang tanpa kolom metode scan. Halaman Admin
mengelola peserta, kelas, impor, tampilan/cetak QR, dan pengaturan operasional.
Unduh template Excel dari halaman Peserta; kolom yang diisi adalah `full_name`,
`unit_name`, `classroom_name`, dan `qr_code` (kode peserta internal dibuat
otomatis). Impor juga menerima CSV dengan header
`participant_code,full_name,classroom_id,qr_code`. Daftar peserta mendukung pilih
semua dan hapus terpilih. Pilih peserta untuk mencetak kartu QR A4 massal yang
memuat nama, kode peserta, kelas, serta gambar dan teks QR, atau pilih **Cetak
QR saja** untuk mencetak kode QR dengan nama tepat di bawah masing-masing kode.
Keduanya dapat dicetak atau disimpan sebagai PDF.

Setelah login di layar lebar (900 px ke atas), Admin langsung melihat Rekap
Absensi untuk pemantauan dari PC; di layar kecil dan untuk Operator, aplikasi
membuka scanner. Admin dapat berpindah halaman melalui ikon hamburger. Pilihan
tema Oranye, Hijau (tema awal), dan Putih tersedia pada menu serta tersimpan
lokal di browser. Tema mengubah latar halaman, kartu, formulir, dan scanner
dengan warna teks yang disesuaikan agar tetap terbaca. Admin mengatur PIN 4 angka saat pertama membuka menu, lalu
dapat mengganti PIN di halaman Pengaturan. PIN disimpan sebagai hash di backend.
Operator tetap dibatasi ke halaman scanner sesuai role akunnya.

Untuk build web produksi, salin `.env.production.example` menjadi
`.env.production` dan ganti alamat API ke URL HTTPS yang dapat dijangkau perangkat:

```powershell
Copy-Item .env.production.example .env.production
# Edit VITE_API_BASE_URL di .env.production
npm.cmd run build
```

Atur `WEB_ORIGIN` backend agar mengizinkan origin dashboard produksi serta
`https://localhost` untuk aplikasi Capacitor. Jangan memakai HTTP API dari app
HTTPS karena WebView dapat memblokir mixed content. Akses kamera browser juga
memerlukan `localhost` atau HTTPS.

## Deploy dashboard dan API ke Railway

Buat dua service dari repo yang sama:

1. **API**: root directory `backend`, build command `npm ci`, start command
   `npm start`, dan health check `/api/health`.
2. Untuk MySQL, isi `DB_DRIVER=mysql`, `MYSQL_HOST`, `MYSQL_PORT`,
   `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, `JWT_SECRET` (acak,
   minimal 32 karakter), dan `WEB_ORIGIN` (domain dashboard HTTPS). Setelah
   database tersedia, jalankan `npm run db:init` pada service API.
   Jika API akan dipindahkan ke SQLite, pasang persistent volume pada `/data`,
   atur `DB_DRIVER=sqlite` dan `SQLITE_PATH=/data/absensi.sqlite`, serta
   gunakan satu replica. Konversi dump MySQL terbaru menjadi file SQLite baru
   dan salin file itu ke volume sebelum mengalihkan service; jangan mulai dari
   database kosong untuk migrasi data. Pertahankan MySQL sampai verifikasi dan
   rollback selesai.
3. **Web**: root directory `web`, build command `npm ci && npm run build`,
   start command `npm run preview -- --host 0.0.0.0 --port $PORT`, dan
   `VITE_API_BASE_URL=https://<domain-api>/api`.

Gunakan domain Railway web untuk membuka dashboard dari PC. Buat akun Admin
melalui `npm run user:create`; jangan menaruh password, JWT secret, atau
kredensial database di repo.

Scanner memilih Masuk/Pulang berdasarkan riwayat scan hari itu; Pulang hanya
tersedia setelah Masuk dan ketika jam pulang dimulai. Cooldown tiga detik
menolak ulang event peserta yang sama, tetapi tidak menahan event Masuk/Pulang
berbeda yang sah. Scanner menerima QR/barcode dari kamera dan scanner USB/
Bluetooth mode keyboard wedge melalui bidang input berakhiran Enter. Input
manual tersedia dari menu hamburger setelah verifikasi PIN dan mencari peserta
dari master lokal; laporan mencatat metode `MANUAL_INPUT`. Scanner juga memakai
kamera belakang, bunyi notifikasi,
indikator jaringan, antrean pending, serta sinkronisasi otomatis saat jaringan
kembali. Di scanner ponsel, tombol **Hapus riwayat** hanya menghapus salinan
lokal yang sudah berstatus terkirim; data server tidak dihapus dan antrean
pending tetap aman di perangkat. Pada browser, kamera memakai ZXing; Android
memakai scanner ML Kit native.
TTS menggunakan bahasa
Indonesia dan memprioritaskan suara perempuan bila tersedia pada perangkat.
Pesan sambutan dapat diubah dari pengaturan dan bergerak dari kanan ke kiri.
Hari, tanggal lengkap beserta tahun, dan jam pada header scanner ditampilkan
lebih besar agar mudah terbaca.
Setelah scan berhasil, nama peserta dan ceklis hijau tampil selama 1,8 detik
bersamaan dengan bunyi/TTS. Layar scanner tidak bergulir; kotak riwayat
menampilkan tiga baris sekaligus dan dapat digulir untuk entri lainnya.

## Tahap 4: SDK Android dan APK release

Proyek memakai Capacitor Android; Flutter SDK tidak diperlukan. Folder proyek
native sudah dibuat di `web/android`. Jika perlu dibuat ulang pada checkout yang
belum memiliki folder itu:

```powershell
cd web
npm.cmd install
npm.cmd run build
npx.cmd cap add android
```

### Instalasi SDK

1. Instal **Android Studio stable** dan **Node.js 22.5+**.
2. Android Studio → **Tools → SDK Manager**: pasang Android SDK Platform **36**,
   Android SDK Build-Tools **36.0.0**, Android SDK Platform-Tools, dan Android SDK
   Command-line Tools (latest). `compileSdk` dan `targetSdk` proyek saat ini 36;
   minimum Android yang didukung 24.
3. Gunakan JDK bawaan Android Studio (JBR) atau JDK 21. Atur environment untuk
   terminal PowerShell VS Code (sesuaikan lokasi instalasi):

```powershell
$env:JAVA_HOME = "$env:ProgramFiles\Android\Android Studio\jbr"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:Path"
java -version
adb version
sdkmanager --licenses
```

Jika `sdkmanager` belum ditemukan, pasang Command-line Tools melalui SDK Manager,
lalu buka terminal baru. Set API backend HTTPS pada `.env.production` sebelum
build; `cap sync` menyalin aset web terbaru ke proyek Android.

### Build debug dan uji perangkat

```powershell
cd web
npm.cmd run build
npx.cmd cap sync android
Push-Location android
.\gradlew.bat assembleDebug
Pop-Location
adb devices
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
```

Debug APK tersedia di
`web/android/app/build/outputs/apk/debug/app-debug.apk`. Pada perangkat, login
saat online, izinkan kamera, pastikan peserta dan pengaturan telah tersimpan,
aktifkan mode pesawat, scan peserta, lalu hidupkan jaringan dan tunggu
sinkronisasi otomatis berjalan. Periksa bahwa pending turun dan rekap server
terbarui.

### APK release bertanda tangan dan lebih ramping

Buat keystore satu kali; simpan cadangan aman dan jangan commit ke repository:

```powershell
cd web
keytool -genkeypair -v -keystore "$HOME\absensi-release.jks" -alias absensi -keyalg RSA -keysize 2048 -validity 10000
Copy-Item android\keystore.properties.example android\keystore.properties
```

Edit `android\keystore.properties`: set `storeFile` ke path absolut keystore
(gunakan slash, misalnya `C:/Users/Nama/absensi-release.jks`) dan isi password
keystore serta alias. File ini sudah dikecualikan dari Git. Jangan membagikan
keystore atau password; kehilangan keystore dapat menghalangi pembaruan aplikasi
yang sama.

```powershell
cd web
npm.cmd run build
npx.cmd cap sync android
Push-Location android
.\gradlew.bat clean assembleRelease
Pop-Location
$apk = "android\app\build\outputs\apk\release\app-release.apk"
& "$env:ANDROID_HOME\build-tools\36.0.0\apksigner.bat" verify --verbose $apk
Get-Item $apk | Select-Object FullName, Length
adb install -r $apk
```

APK release bertanda tangan berada di
`web/android/app/build/outputs/apk/release/app-release.apk`. Konfigurasi Gradle
release sudah mengaktifkan R8 (`minifyEnabled`) dan `shrinkResources`; uji kamera,
login, antrean offline, sync, dan ekspor di build release karena optimasi perlu
diverifikasi pada perangkat nyata. Simpan file signing hanya lokal.

Capacitor menghasilkan satu APK Android universal; opsi Flutter
`--split-per-abi` tidak berlaku. Untuk ukuran kecil, pertahankan aset ringan,
hindari dependensi/plugin native yang tidak dipakai, dan tinjau ukuran APK hasil
rilis. Plugin scanner ML Kit memang menambah ukuran dibanding WebView kosong,
tetapi memberi pemindaian kamera native yang lebih andal. Untuk distribusi Play
Store, `.\gradlew.bat bundleRelease` menghasilkan AAB (bukan APK instalasi
langsung).

APK belum dibangun di lingkungan ini karena Android SDK/JDK belum diverifikasi
tersedia. Instruksi di atas menyiapkan langkah build setelah SDK dipasang.

## Menjalankan tes domain

Jika Dart SDK tersedia, dari folder `mobile/scanner_core` jalankan:

```powershell
dart pub get
dart test
```

Perintah ini hanya menguji logika Dart murni; tidak memerlukan Flutter atau
Android SDK. Build APK dilakukan melalui Capacitor seperti panduan Tahap 4.
