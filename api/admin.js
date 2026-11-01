'use strict';
/* =====================================================================
   API Panel Admin KelasBelajar  (Vercel Serverless Function: /api/admin)
   - Satu endpoint, semua aksi lewat POST { action, ... }.
   - Akun admin = akun Supabase Auth yang didaftarkan SUPERADMIN lewat database (tabel "admins").
     Tidak ada pendaftaran admin lewat website. Login diverifikasi ke Supabase, lalu server memberi
     token bertanda tangan (berlaku 8 jam) dan tiap permintaan dicek lagi: akun masih ada di tabel admins?
   - Akses ke Supabase memakai SUPABASE_SERVICE_ROLE_KEY yang HANYA ada di server ini.
   Environment variable wajib: SUPABASE_SERVICE_ROLE_KEY
   Opsional: SUPABASE_URL (bawaan: proyek yang dipakai app.js)
   ===================================================================== */
const crypto = require('crypto');

const SB_URL = () => String(process.env.SUPABASE_URL || 'https://absfiaukhpovsrmkzbdp.supabase.co').replace(/\/+$/, '');
const cfg = () => {
  const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  // kunci penanda tangan token diturunkan dari service role key (tidak perlu env tambahan)
  return { SRK, SECRET: SRK ? crypto.createHash('sha256').update('kb-admin|' + SRK).digest('hex') : '' };
};
const TTL_MS = 8 * 60 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------- token & login ---------- */
const sign = (payload, secret) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url');
};
const verify = (tok, secret) => {
  const [body, sig] = String(tok || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p && p.adm === 1 && p.exp > Date.now() && UUID.test(String(p.uid)) ? p : null; } catch (e) { return null; }
};
const FAILS = new Map();
const ipOf = req => String(((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || '?').trim();
const isBlocked = ip => { const f = FAILS.get(ip); if (!f) return false; if (Date.now() > f.until) { FAILS.delete(ip); return false; } return f.n >= 8; };
const addFail = ip => { const f = FAILS.get(ip) || { n: 0, until: 0 }; f.n++; f.until = Date.now() + 15 * 60 * 1000; FAILS.set(ip, f); };

/* ---------- Supabase (service role) ---------- */
async function sbFetch(path, { method = 'GET', body, headers = {} } = {}) {
  const k = cfg().SRK;
  const r = await fetch(SB_URL() + path, {
    method,
    headers: { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const txt = await r.text();
  let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = txt; }
  if (!r.ok) {
    const e = new Error((j && (j.message || j.msg || j.error_description || j.error)) || ('HTTP ' + r.status));
    e.status = r.status; e.detail = j; e.code = j && j.code; throw e;
  }
  return j;
}
const rest = (p, o) => sbFetch('/rest/v1/' + p, o);
async function restAll(table, query) {
  const out = [];
  for (let i = 0; ; i += 1000) {
    const rows = await rest(`${table}?${query}&limit=1000&offset=${i}`);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
const inList = arr => 'in.(' + arr.map(v => '"' + String(v).replace(/"/g, '\\"') + '"').join(',') + ')';
async function delIn(table, col, vals) {
  for (let i = 0; i < vals.length; i += 100) {
    await rest(`${table}?${col}=${enc(inList(vals.slice(i, i + 100)))}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  }
}
async function authInfo() {
  const out = {};
  try {
    for (let p = 1; p <= 20; p++) {
      const j = await sbFetch(`/auth/v1/admin/users?page=${p}&per_page=1000`);
      const arr = (j && j.users) || [];
      arr.forEach(u => { out[u.id] = { last: u.last_sign_in_at || null, verified: !!u.email_confirmed_at }; });
      if (arr.length < 1000) break;
    }
  } catch (e) { /* info tambahan saja */ }
  return out;
}

/* ---------- validasi (sama dengan form daftar di website) ---------- */
const isGmail = v => /^[a-z0-9._%+-]+@gmail\.com$/i.test(String(v || '').trim());
const MKID = /^[A-Za-z0-9_-]{1,64}$/;
const bad = msg => { const e = new Error(msg); e.status = 400; e.user = true; return e; };

function cekAkun(b) {
  const d = {
    nama: String(b.nama || '').trim(), role: String(b.role || ''), id: String(b.id || '').trim(),
    prodi: String(b.prodi || '').trim(), email: String(b.email || '').trim().toLowerCase(),
    hp: String(b.hp || '').trim(), pass: String(b.pass || '')
  };
  if (!['Partisipan', 'Pengajar'].includes(d.role)) throw bad('Peran harus Partisipan atau Pengajar.');
  if (!d.nama || d.nama.length > 100) throw bad('Nama lengkap wajib diisi (maks. 100 karakter).');
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(d.id)) throw bad('ID harus 3–30 karakter: huruf, angka, titik, strip, atau garis bawah (tanpa spasi).');
  if (d.prodi.length < 3 || d.prodi.length > 60) throw bad('Minat belajar wajib diisi (3–60 karakter).');
  if (!isGmail(d.email)) throw bad('Gunakan alamat Gmail yang valid (akhiran @gmail.com).');
  if (!/^0\d{8,13}$/.test(d.hp)) throw bad('Nomor HP tidak valid. Contoh: 081234567890.');
  if (d.pass.length < 8 || d.pass.length > 72) throw bad('Kata sandi 8–72 karakter.');
  return d;
}

/* ---------- aktivitas (pengunjung & online) ---------- */
const ONLINE_MS = 150 * 1000, H24_MS = 24 * 3600 * 1000;
async function aksiAktif() {
  try {
    const rows = await restAll('aktivitas', 'select=uid,last_seen&order=uid.asc');
    const now = Date.now(), seen = {}; let h24 = 0, online = 0;
    rows.forEach(r => {
      const t = Date.parse(r.last_seen); if (!t) return;
      seen[r.uid] = r.last_seen;
      if (now - t <= H24_MS) h24++;
      if (now - t <= ONLINE_MS) online++;
    });
    return { aktif: { ada: true, h24, online, seen, now } };
  } catch (e) {
    return { aktif: { ada: false, error: e.status === 404 || /aktivitas|schema cache|relation/i.test(e.message) ? 'Tabel "aktivitas" belum dibuat. Jalankan file supabase-admin.sql di Supabase SQL Editor.' : e.message } };
  }
}

/* ---------- aksi ---------- */
async function aksiData() {
  const [pr, mk, jn, au] = await Promise.all([
    restAll('profiles', 'select=uid,email,nama,role,id_user,hp,prodi,dibuat,pref&order=dibuat.asc'),
    restAll('mk', 'select=id,dosen,data&order=id.asc'),
    restAll('bergabung', 'select=mk_id,mhs,kelas_id,waktu&order=mk_id.asc'),
    authInfo()
  ]);
  const users = pr.map(r => ({
    uid: r.uid, email: r.email, nama: r.nama, role: r.role, id: r.id_user, hp: r.hp, prodi: r.prodi, dibuat: r.dibuat || null,
    foto: r.pref && typeof r.pref.foto === 'string' && /^https?:\/\//.test(r.pref.foto) ? r.pref.foto : '',
    last: au[r.uid] ? au[r.uid].last : null, verified: au[r.uid] ? au[r.uid].verified : null
  }));
  const pel = mk.map(m => {
    const d = m.data || {};
    return {
      id: m.id, dosen: m.dosen, nama: d.nama || '(tanpa nama)', kode: d.kode || '', dosenNama: d.dosenNama || '',
      kelas: (d.kelas || []).map(k => ({ id: k.id, nama: k.nama, kode: k.kode, pert: (k.pert || []).length }))
    };
  });
  const join = jn.map(j => ({ mk: j.mk_id, mhs: j.mhs, kelas: j.kelas_id }));
  let quotes = null, quotesError = '';
  try { quotes = await restAll('motivasi', 'select=id,teks&order=id.asc'); }
  catch (e) { quotesError = e.status === 404 || /motivasi|schema cache|relation/i.test(e.message) ? 'Tabel "motivasi" belum dibuat. Jalankan file supabase-admin.sql di Supabase SQL Editor.' : e.message; }
  const { aktif } = await aksiAktif();
  return { users, mk: pel, join, quotes, quotesError, aktif };
}

async function aksiBuatAkun(b) {
  const d = cekAkun(b);
  const dupE = await rest(`profiles?email=eq.${enc(d.email)}&select=uid&limit=1`);
  if (dupE.length) throw bad('Gmail ini sudah terdaftar.');
  const dupI = await rest(`profiles?id_user=eq.${enc(d.id)}&select=uid&limit=1`);
  if (dupI.length) throw bad('ID ini sudah dipakai akun lain.');
  let u;
  try {
    u = await sbFetch('/auth/v1/admin/users', {
      method: 'POST',
      body: { email: d.email, password: d.pass, email_confirm: true, user_metadata: { nama: d.nama, role: d.role, id_user: d.id, hp: d.hp, prodi: d.prodi } }
    });
  } catch (e) {
    if (/already|registered|exists/i.test(e.message)) throw bad('Gmail ini sudah terdaftar.');
    if (/Database error/i.test(e.message)) throw bad('Akun gagal dibuat: ID atau Gmail sudah dipakai, atau data tidak valid.');
    throw e;
  }
  const uid = u && (u.id || (u.user && u.user.id));
  const ada = await rest(`profiles?uid=eq.${enc(uid)}&select=uid&limit=1`);
  if (!ada.length) {
    await rest('profiles', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: { uid, email: d.email, nama: d.nama, role: d.role, id_user: d.id, hp: d.hp, prodi: d.prodi } });
  }
  return { ok: true, uid };
}

async function aksiUbahAkun(b) {
  const uid = String(b.uid || '');
  if (!UUID.test(uid)) throw bad('ID akun tidak valid.');
  const role = String(b.role || ''), id = String(b.id || '').trim(), prodi = String(b.prodi || '').trim();
  if (!['Partisipan', 'Pengajar'].includes(role)) throw bad('Peran harus Partisipan atau Pengajar.');
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(id)) throw bad('ID harus 3–30 karakter: huruf, angka, titik, strip, atau garis bawah (tanpa spasi).');
  if (prodi.length < 3 || prodi.length > 60) throw bad('Minat belajar wajib diisi (3–60 karakter).');
  const prof = (await rest(`profiles?uid=eq.${enc(uid)}&select=uid,email,role,id_user&limit=1`))[0];
  if (!prof) throw bad('Akun tidak ditemukan.');
  if (id !== prof.id_user) {
    const dup = await rest(`profiles?id_user=eq.${enc(id)}&uid=neq.${enc(uid)}&select=uid&limit=1`);
    if (dup.length) throw bad('ID ini sudah dipakai akun lain.');
  }
  let keluar = 0;
  if (role !== prof.role) {
    if (prof.role === 'Pengajar') {
      const n = (await rest(`mk?dosen=eq.${enc(prof.email)}&select=id`)).length;
      if (n) throw bad(`Pengajar ini masih punya ${n} pelajaran. Hapus pelajarannya dulu di tab Pelajaran sebelum mengubah perannya menjadi Partisipan.`);
    } else {
      keluar = (await rest(`bergabung?mhs=eq.${enc(prof.email)}&select=mk_id`)).length;
      await rest(`progres?email=eq.${enc(prof.email)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      await rest(`bergabung?mhs=eq.${enc(prof.email)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }
  }
  try { await rest(`profiles?uid=eq.${enc(uid)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { role, id_user: id, prodi } }); }
  catch (e) { if (e.code === '23505') throw bad('ID ini sudah dipakai akun lain.'); throw e; }
  try { // samakan data bawaan akun login (tidak wajib)
    const cur = await sbFetch(`/auth/v1/admin/users/${enc(uid)}`);
    await sbFetch(`/auth/v1/admin/users/${enc(uid)}`, { method: 'PUT', body: { user_metadata: { ...((cur && cur.user_metadata) || {}), role, id_user: id, prodi } } });
  } catch (e) { /* abaikan */ }
  return { ok: true, keluar };
}

async function aksiHapusAkun(b) {
  const uid = String(b.uid || '');
  if (!UUID.test(uid)) throw bad('ID akun tidak valid.');
  const prof = (await rest(`profiles?uid=eq.${enc(uid)}&select=uid,email,role&limit=1`))[0];
  let pelajaran = 0;
  if (prof) {
    if (prof.role === 'Pengajar') {
      const ids = (await rest(`mk?dosen=eq.${enc(prof.email)}&select=id`)).map(m => m.id);
      pelajaran = ids.length;
      if (ids.length) { await delIn('progres', 'mk_id', ids); await delIn('bergabung', 'mk_id', ids); await delIn('mk', 'id', ids); }
    }
    await rest(`progres?email=eq.${enc(prof.email)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    await rest(`bergabung?mhs=eq.${enc(prof.email)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    await rest(`profiles?uid=eq.${enc(uid)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  }
  try { await sbFetch(`/storage/v1/object/foto/${uid}/avatar.jpg`, { method: 'DELETE' }); } catch (e) { /* foto mungkin tidak ada */ }
  try { await sbFetch(`/auth/v1/admin/users/${enc(uid)}`, { method: 'DELETE' }); }
  catch (e) { if (e.status !== 404) throw e; }
  return { ok: true, pelajaran };
}

async function aksiHapusPelajaran(b) {
  const id = String(b.id || '');
  if (!MKID.test(id)) throw bad('ID pelajaran tidak valid.');
  await delIn('progres', 'mk_id', [id]);
  await delIn('bergabung', 'mk_id', [id]);
  await delIn('mk', 'id', [id]);
  return { ok: true };
}

const cekTeks = v => {
  const t = String(v || '').replace(/\s+/g, ' ').trim();
  if (t.length < 3 || t.length > 300) throw bad('Kata motivasi harus 3–300 karakter.');
  return t;
};
const cekNomor = v => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw bad('ID motivasi tidak valid.'); return n; };

async function jalankan(action, b) {
  switch (action) {
    case 'data': return aksiData();
    case 'akun_tambah': return aksiBuatAkun(b);
    case 'akun_ubah': return aksiUbahAkun(b);
    case 'akun_hapus': return aksiHapusAkun(b);
    case 'aktif': return aksiAktif();
    case 'pelajaran_hapus': return aksiHapusPelajaran(b);
    case 'motivasi_tambah': { const r = await rest('motivasi?select=id,teks', { method: 'POST', headers: { Prefer: 'return=representation' }, body: { teks: cekTeks(b.teks) } }); return { ok: true, item: r[0] }; }
    case 'motivasi_ubah': { const r = await rest(`motivasi?id=eq.${cekNomor(b.id)}&select=id,teks`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: { teks: cekTeks(b.teks) } }); if (!r.length) throw bad('Kata motivasi tidak ditemukan.'); return { ok: true, item: r[0] }; }
    case 'motivasi_hapus': { await rest(`motivasi?id=eq.${cekNomor(b.id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); return { ok: true }; }
    default: throw bad('Aksi tidak dikenal.');
  }
}

async function cariAdmin(uid) {
  try { return (await rest(`admins?uid=eq.${enc(uid)}&select=uid,nama&limit=1`))[0] || null; }
  catch (e) {
    if (e.status === 404 || /admins|schema cache|relation/i.test(e.message)) { const x = new Error('Tabel "admins" belum dibuat. Jalankan file supabase-admin.sql di Supabase SQL Editor.'); x.status = 500; x.user = true; throw x; }
    throw e;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const send = (c, o) => res.status(c).json(o);
  if (req.method !== 'POST') return send(405, { error: 'Metode tidak diizinkan.' });
  const c = cfg();
  if (!c.SRK) return send(500, { error: 'Konfigurasi server belum lengkap. Isi environment variable SUPABASE_SERVICE_ROLE_KEY di Vercel lalu deploy ulang.' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b && typeof b === 'object' ? b : {};
  const action = String(b.action || '');

  try {
    if (action === 'login') {
      const ip = ipOf(req);
      if (isBlocked(ip)) return send(429, { error: 'Terlalu banyak percobaan gagal. Coba lagi dalam 15 menit.' });
      const gagal = async () => { addFail(ip); await sleep(900); return send(401, { error: 'Email atau kata sandi salah, atau akun ini bukan admin.' }); };
      const email = String(b.email || '').trim().toLowerCase(), pass = String(b.pass || '');
      if (!email || !pass) return gagal();
      let au = null;
      try { au = await sbFetch('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: pass } }); } catch (e) { if (!(e.status >= 400 && e.status < 500)) throw e; }
      const uid = au && au.user && au.user.id;
      const adm = uid ? await cariAdmin(uid) : null;
      if (!adm) return gagal();
      FAILS.delete(ip);
      const exp = Date.now() + TTL_MS, nama = adm.nama || '';
      return send(200, { token: sign({ adm: 1, uid, em: email, nm: nama, exp }, c.SECRET), exp, email, nama });
    }

    const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const p = verify(tok, c.SECRET);
    if (!p) return send(401, { error: 'Sesi tidak valid atau sudah berakhir. Silakan masuk lagi.' });
    if (!(await cariAdmin(p.uid))) return send(401, { error: 'Akun ini sudah tidak terdaftar sebagai admin.' });
    return send(200, await jalankan(action, b));
  } catch (e) {
    console.error('[admin]', action, e && e.message);
    if (e && e.user) return send(e.status || 400, { error: e.message });
    return send(500, { error: 'Terjadi kesalahan pada server: ' + (e && e.message ? e.message : 'tidak diketahui') });
  }
};
