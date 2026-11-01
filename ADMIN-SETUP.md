# Panel Admin KelasBelajar — cara memasang

- Halaman utama **https://kelasbelajar.vercel.app** → login Partisipan & Pengajar
- Halaman admin **https://kelasbelajar.vercel.app/admin** → hanya muncul kalau URL-nya diketik langsung (tidak ada tautan ke sana dari website)

Admin **tidak bisa mendaftar lewat website**. Akun admin dibuat oleh superadmin langsung di Supabase.

## 1. Jalankan SQL (sekali saja)
Supabase → **SQL Editor** → New query → tempel isi `supabase-admin.sql` → **Run**.
Membuat tabel `admins` (daftar admin), `motivasi` (kata motivasi), dan `aktivitas` + fungsi `ping()` (data pengunjung & online). Tabel lain tidak diubah. Aman dijalankan ulang.

## 2. Isi 1 Environment Variable di Vercel
Vercel → project → **Settings → Environment Variables**:

| Nama | Isi |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → **service_role** (rahasia!) |

Lalu **Deployments → Redeploy**.

> ⚠️ Jangan menaruh `service_role` di `app.js`/file browser mana pun. Kunci itu hanya dipakai `api/admin.js` di server Vercel.

## 3. Buat akun admin (oleh superadmin, di SQL Editor)
```sql
select public.buat_admin('admin@gmail.com', 'KataSandi123', 'Nama Admin', 'admin01', '198001012005011001', '081234567890');
```
Isi: email, kata sandi (min. 8), nama, ID, NIP, nomor HP. Akun langsung aktif dan bisa masuk di `/admin`.
(Syarat: trigger `handle_new_user` sudah diperbaiki agar akun tanpa peran tidak dibuatkan profil.)

Mencabut admin sekaligus menghapus akunnya:
```sql
delete from auth.users where email = 'admin@gmail.com';
```
Ganti kata sandi admin:
```sql
update auth.users set encrypted_password = extensions.crypt('SandiBaru123', extensions.gen_salt('bf')) where email = 'admin@gmail.com';
```

## 4. Upload semua file ke GitHub
Termasuk folder `api/`, `admin.html`, `admin.js`, `admin.css`, `vercel.json`, `assets/logo.svg`.

## Yang bisa dilakukan admin
- Tambah, ubah (peran, ID, minat belajar), dan hapus akun pengajar/partisipan; lihat detail (Gmail, No. HP, ID, minat belajar, terakhir masuk, dll.)
- Lihat total akun, pengajar, partisipan, pelajaran, pengunjung 24 jam, dan yang sedang online (titik hijau)
- Lihat anggota partisipan tiap pelajaran/kelas; hapus pelajaran buatan pengajar
- Tambah / ubah / hapus kata motivasi di beranda pengajar dan partisipan

## Catatan
- Salah login 8 kali → dikunci 15 menit. Sesi admin 8 jam.
- Akun admin tidak punya profil pengajar/partisipan, jadi tidak bisa dipakai masuk di halaman login biasa.
- Tes lokal: gunakan `vercel dev` (folder `api/` tidak jalan jika hanya membuka file HTML).
