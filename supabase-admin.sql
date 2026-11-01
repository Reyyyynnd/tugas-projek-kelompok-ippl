-- =====================================================================
-- KelasBelajar – Panel Admin
-- Jalankan SEKALI di Supabase: SQL Editor -> New query -> tempel -> Run
-- Membuat: tabel "admins" (daftar akun admin) dan tabel "motivasi" (kata motivasi di beranda).
-- Tabel lain (profiles, mk, bergabung, progres) TIDAK diubah.
-- =====================================================================

create table if not exists public.motivasi (
  id     bigint generated always as identity primary key,
  teks   text not null check (char_length(btrim(teks)) between 3 and 300),
  dibuat timestamptz not null default now()
);

alter table public.motivasi enable row level security;

-- Semua orang yang membuka website boleh MEMBACA kata motivasi.
-- Tidak ada policy tambah/ubah/hapus: hanya panel admin (service role) yang bisa mengubahnya.
drop policy if exists "motivasi dibaca semua" on public.motivasi;
create policy "motivasi dibaca semua" on public.motivasi
  for select using (true);

-- Isi awal (sama dengan kata motivasi bawaan di beranda). Hanya diisi jika tabel masih kosong.
insert into public.motivasi (teks)
select t from (values
  ($q$“Keberhasilan adalah jumlah usaha kecil yang diulang setiap hari.” – Robert Collier$q$),
  ($q$“Pendidikan adalah senjata paling ampuh untuk mengubah dunia.” – Nelson Mandela$q$),
  ($q$“Investasi dalam pengetahuan memberikan bunga terbaik.” – Benjamin Franklin$q$),
  ($q$“Satu-satunya cara melakukan pekerjaan hebat adalah mencintai apa yang kamu lakukan.” – Steve Jobs$q$)
) as v(t)
where not exists (select 1 from public.motivasi);

-- =====================================================================
-- DAFTAR ADMIN  (hanya SUPERADMIN yang mengelola ini lewat Supabase)
-- Admin TIDAK bisa mendaftar lewat website. Cara menambah admin:
--   1) Supabase -> Authentication -> Users -> Add user -> Create new user
--      (isi email + kata sandi, centang "Auto Confirm User")
--   2) Jalankan SQL di bawah (ganti email dan nama):
--
--      insert into public.admins (uid, nama)
--      select id, 'Nama Admin' from auth.users where email = 'admin@gmail.com';
--
-- Mencabut akses admin:   delete from public.admins where uid = (select id from auth.users where email = 'admin@gmail.com');
-- =====================================================================
create table if not exists public.admins (
  uid    uuid primary key references auth.users(id) on delete cascade,
  nama   text,
  dibuat timestamptz not null default now()
);

-- RLS aktif TANPA policy apa pun: tabel ini tidak bisa dibaca/diubah dari browser
-- (hanya server panel admin dengan service role dan SQL Editor yang bisa).
alter table public.admins enable row level security;

-- =====================================================================
-- BUAT AKUN ADMIN LANGSUNG DARI SQL EDITOR (oleh superadmin)
-- Prasyarat: trigger handle_new_user sudah diperbaiki (akun tanpa peran tidak dibuatkan profil).
-- Cara pakai (ganti isinya):
--   select public.buat_admin('admin@gmail.com', 'KataSandi123', 'Nama Admin', 'admin01', '198001012005011001', '081234567890');
-- Argumen: email, kata sandi (min. 8), nama, ID, NIP, nomor HP. Akun langsung aktif dan bisa masuk di /admin.
-- =====================================================================
alter table public.admins
  add column if not exists email   text,
  add column if not exists id_user text,
  add column if not exists nip     text,
  add column if not exists hp      text;

create or replace function public.buat_admin(p_email text, p_password text, p_nama text, p_id text, p_nip text, p_hp text)
returns text
language plpgsql
set search_path = public, extensions, auth
as $fn$
declare
  v_id    uuid := gen_random_uuid();
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Email tidak valid'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Kata sandi minimal 8 karakter'; end if;
  if btrim(coalesce(p_nama, '')) = '' then raise exception 'Nama wajib diisi'; end if;
  if exists (select 1 from auth.users where lower(email) = v_email) then raise exception 'Email % sudah terdaftar', v_email; end if;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
          crypt(p_password, gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text,
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
          'email', now(), now(), now());

  insert into public.admins (uid, nama, email, id_user, nip, hp)
  values (v_id, btrim(p_nama), v_email, nullif(btrim(p_id), ''), nullif(btrim(p_nip), ''), nullif(btrim(p_hp), ''));

  return 'Admin dibuat: ' || v_email;
end
$fn$;

-- WAJIB: fungsi ini tidak boleh bisa dipanggil dari browser/website, hanya dari SQL Editor.
revoke all on function public.buat_admin(text, text, text, text, text, text) from public, anon, authenticated;

-- =====================================================================
-- PENGUNJUNG & YANG SEDANG ONLINE  (dibaca panel admin)
-- Website mengirim "detak" (fungsi ping) tiap 60 detik saat pengguna yang sudah login membuka tab.
--   Sedang online      = detak terakhir <= 2,5 menit lalu
--   Pengunjung 24 jam  = akun yang aktif dalam 24 jam terakhir (dihitung per akun, tanpa dobel)
-- Tamu yang belum login tidak terhitung.
-- =====================================================================
create table if not exists public.aktivitas (
  uid       uuid primary key references auth.users(id) on delete cascade,
  last_seen timestamptz not null default now()
);
alter table public.aktivitas enable row level security;   -- tanpa policy: tidak bisa diakses langsung dari browser

create or replace function public.ping()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null then return; end if;
  insert into public.aktivitas (uid, last_seen) values (auth.uid(), now())
  on conflict (uid) do update set last_seen = now();
end
$fn$;
revoke all on function public.ping() from public, anon;
grant execute on function public.ping() to authenticated;
