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
