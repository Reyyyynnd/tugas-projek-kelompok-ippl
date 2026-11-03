# cara membuka halaman user

- Halaman utama **https://kelasbelajar.vercel.app** → login user biasa
- Halaman admin **https://kelasbelajar.vercel.app/admin** → login admin

# membuat akun admin

```sql
select public.buat_admin('Gmail', 'KataSandi', 'Nama Lengkap', 'Id', 'NIP', 'No_HP');
```

# mengontrol admin

Mencabut admin sekaligus menghapus akunnya:

```sql
delete from auth.users where email = 'admin@gmail.com';
```

Ganti kata sandi admin:

```sql
update auth.users set encrypted_password = extensions.crypt('SandiBaru123', extensions.gen_salt('bf')) where email = 'admin@gmail.com';
```

# yang bisa dilakukan admin

- Tambah & hapus akun pengajar/partisipan; lihat detail (Gmail, No. HP, ID, minat belajar, terakhir masuk, dll.)
- Lihat total akun, pengajar, partisipan, pelajaran, kelas
- Lihat anggota partisipan tiap pelajaran/kelas; hapus pelajaran buatan pengajar
- Tambah / ubah / hapus kata motivasi di beranda pengajar dan partisipan

# catatan

- Salah login 8 kali → dikunci 15 menit. Sesi admin 8 jam.
- Akun admin tidak punya profil pengajar/partisipan, jadi tidak bisa dipakai masuk di halaman login biasa.


## Sistem Notifikasi (pengguna & admin)
Jalankan `supabase-notifikasi.sql` di Supabase SQL Editor (sekali; aman diulang). File ini membuat tabel `notifikasi`
dan trigger otomatis, jadi notifikasi muncul meski aksinya dilakukan dari halaman mana pun.
Halaman pengguna: menu **Notifikasi** (+ lonceng di bilah atas) dengan urutan Terbaru/Terlama, filter, tandai dibaca, dan hapus.
Panel admin: tab **Notifikasi**.

| Kejadian | Penerima |
|---|---|
| Daftar akun, verifikasi Gmail | pengguna ("selamat datang", "Gmail terverifikasi"), admin |
| Ganti kata sandi, Gmail, No. HP, nama, ID, minat belajar, foto, pengaturan | pengguna itu sendiri (Gmail juga ke admin) |
| Admin mengubah peran/ID/minat belajar | pengguna yang bersangkutan |
| Bergabung / keluar / dikeluarkan dari kelas | partisipan, pengajar kelas, admin |
| Partisipan absen, kirim tugas, kerjakan quiz | partisipan (konfirmasi) + pengajar |
| Pengajar menilai tugas/quiz, mengembalikan tugas, mencatat kehadiran, menandai selesai | partisipan bersangkutan (+ catatan untuk pengajar) |
| Pengajar menambah materi / tugas / quiz / membuka absen | semua partisipan di kelas itu |
| Pelajaran / kelas dibuat atau dihapus | pengajar, admin (anggota kelas diberi tahu saat pelajaran dihapus) |
| Akun dihapus | admin |

Catatan: notifikasi hanya tercatat untuk kejadian SETELAH SQL dijalankan. Notifikasi lebih dari 90 hari dibersihkan otomatis.
Jangan upload `supabase-*.sql` ke GitHub/Vercel (tidak dibutuhkan website).
