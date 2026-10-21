const SUPABASE_URL = 'https://absfiaukhpovsrmkzbdp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFic2ZpYXVraHBvdnNybWt6YmRwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4MzIwODMsImV4cCI6MjEwNzQwODA4M30.gDlLl6LiBJQQOoJllD6Frp4f4zf9UVAHxJSqqreEX5A';
const BUCKET = 'lampiran';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CACHE = { lms_users: [], lms_mk: [], lms_join: [], lms_prog: {} };
const SNAP = { mk: {}, join: {}, prog: {} };
const PCOLS = ['att', 'sub', 'quiz', 'qt', 'nilai', 'kembali', 'qext'];
let SESS = null, WSEQ = 0, PENDING = 0, Q = Promise.resolve(), REFRESHING = false;

const J = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, key) => (o[key] = x[key], o), {}) : x);

function enqueue(fn) {
  PENDING++;
  Q = Q.then(fn)
    .catch(e => { console.error(e); toast('Gagal menyimpan ke server: ' + ((e && e.message) || e)); setTimeout(refresh, 600); })
    .then(() => { PENDING--; });
}

const mkRows = list => {
  const o = {};
  list.forEach(m => { const { id, dosen, ...data } = m; o[id] = { id, dosen, data, s: dosen + '|' + J(data) }; });
  return o;
};
const mkSnap = rows => { const o = {}; Object.keys(rows).forEach(id => { o[id] = rows[id].s; }); return o; };
const joinKeys = list => { const o = {}; list.forEach(j => { o[j.mkId + '|' + j.mhs] = { mk_id: j.mkId, mhs: j.mhs }; }); return o; };
const progRows = obj => {
  const o = {};
  Object.keys(obj).forEach(mk => Object.keys(obj[mk]).forEach(em => {
    const x = obj[mk][em] || {}, cols = {}, s = {};
    PCOLS.forEach(c => { cols[c] = x[c] || {}; s[c] = J(cols[c]); });
    o[mk + '|' + em] = { mk_id: mk, email: em, cols, s };
  }));
  return o;
};
const progSnap = rows => { const o = {}; Object.keys(rows).forEach(k => { o[k] = { mk_id: rows[k].mk_id, email: rows[k].email, s: rows[k].s }; }); return o; };

function syncMk(list) {
  const now = mkRows(list), ups = [], dels = [];
  Object.keys(now).forEach(id => { if (SNAP.mk[id] !== now[id].s) ups.push({ id, dosen: now[id].dosen, data: now[id].data }); });
  Object.keys(SNAP.mk).forEach(id => { if (!now[id]) dels.push(id); });
  SNAP.mk = mkSnap(now);
  if (ups.length) enqueue(async () => { const { error } = await sb.from('mk').upsert(ups); if (error) throw error; });
  if (dels.length) enqueue(async () => { const { error } = await sb.from('mk').delete().in('id', dels); if (error) throw error; });
}

function syncJoin(list) {
  const now = joinKeys(list), by = {};
  Object.keys(SNAP.join).forEach(k => { if (!now[k]) { const r = SNAP.join[k]; (by[r.mk_id] = by[r.mk_id] || []).push(r.mhs); } });
  SNAP.join = now;
  Object.keys(by).forEach(mk => enqueue(async () => { const { error } = await sb.from('bergabung').delete().eq('mk_id', mk).in('mhs', by[mk]); if (error) throw error; }));
}
function syncProg(obj) {
  const now = progRows(obj), ins = [], upd = [], dels = {};
  Object.keys(now).forEach(k => {
    const n = now[k], o = SNAP.prog[k];
    if (!o) { ins.push({ mk_id: n.mk_id, email: n.email, ...n.cols }); return; }
    const ch = PCOLS.filter(c => o.s[c] !== n.s[c]);
    if (ch.length) { const row = { mk_id: n.mk_id, email: n.email }; ch.forEach(c => { row[c] = n.cols[c]; }); upd.push({ key: ch.join(','), row }); }
  });
  Object.keys(SNAP.prog).forEach(k => { if (!now[k]) { const r = SNAP.prog[k]; (dels[r.mk_id] = dels[r.mk_id] || []).push(r.email); } });
  SNAP.prog = progSnap(now);
  const up = async rows => { const { error } = await sb.from('progres').upsert(rows, { onConflict: 'mk_id,email' }); if (error) throw error; };
  if (ins.length) enqueue(() => up(ins));
  const groups = {}; upd.forEach(u => { (groups[u.key] = groups[u.key] || []).push(u.row); });
  Object.keys(groups).forEach(g => enqueue(() => up(groups[g])));
  Object.keys(dels).forEach(mk => enqueue(async () => { const { error } = await sb.from('progres').delete().eq('mk_id', mk).in('email', dels[mk]); if (error) throw error; }));
}

const DB = {
  get(k, d) { const v = CACHE[k]; return v == null ? d : JSON.parse(JSON.stringify(v)); },
  set(k, v) {
    CACHE[k] = v; WSEQ++;
    if (k === 'lms_mk') syncMk(v); else if (k === 'lms_join') syncJoin(v); else if (k === 'lms_prog') syncProg(v);
    return true;
  }
};

// Ambil semua baris sebuah tabel (Supabase membatasi 1000 baris per permintaan)
async function fetchAll(table, order) {
  const out = [];
  for (let i = 0; ; i += 1000) {
    let q = sb.from(table).select('*');
    order.forEach(c => { q = q.order(c); });
    const { data, error } = await q.range(i, i + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
// Muat semua data milik pengguna yang sedang login (aturan RLS di database menentukan baris mana yang boleh dilihat).
// Mengembalikan false jika belum login. soft=true: batalkan ('stale') bila ada perubahan lokal selama pengambilan data.
async function loadAll(soft) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return false;
  const au = session.user, w0 = WSEQ;
  const [pr, mk, jn, pg] = await Promise.all([
    fetchAll('profiles', ['uid']), fetchAll('mk', ['id']), fetchAll('bergabung', ['mk_id', 'mhs']), fetchAll('progres', ['mk_id', 'email'])
  ]);
  if (soft && WSEQ !== w0) return 'stale';
  const users = pr.map(r => ({
    uid: r.uid, email: r.email, nama: r.nama, role: r.role, id: r.id_user, hp: r.hp, prodi: r.prodi, pref: r.pref || {},
    dibuat: Date.parse(r.dibuat) || null, verified: r.uid === au.id ? !!au.email_confirmed_at : true
  }));
  const me = users.find(u => u.uid === au.id);
  if (!me) { await sb.auth.signOut({ scope: 'local' }); return false; }
  CACHE.lms_users = users;
  CACHE.lms_mk = mk.map(r => ({ ...r.data, id: r.id, dosen: r.dosen }));
  CACHE.lms_join = jn.map(r => ({ mhs: r.mhs, mkId: r.mk_id, kelasId: r.kelas_id, at: Number(r.waktu) }));
  const prog = {};
  pg.forEach(r => { (prog[r.mk_id] = prog[r.mk_id] || {})[r.email] = { att: r.att, sub: r.sub, quiz: r.quiz, qt: r.qt, nilai: r.nilai, kembali: r.kembali, qext: r.qext }; });
  CACHE.lms_prog = prog;
  SESS = me.email;
  SNAP.mk = mkSnap(mkRows(CACHE.lms_mk)); SNAP.join = joinKeys(CACHE.lms_join); SNAP.prog = progSnap(progRows(CACHE.lms_prog));
  return true;
}
async function reloadData() { await Q; return loadAll(); }
// Segarkan data di beranda (saat tab dibuka lagi, pindah menu, atau tiap 60 detik) agar perubahan dari pengguna lain tampil.
// Layar tidak digambar ulang jika ada jendela terbuka, form pertemuan, atau pengguna sedang mengetik.
async function refresh() {
  if (REFRESHING || PENDING > 0 || PAGE !== 'beranda' || !SESS) return;
  REFRESHING = true;
  try {
    const sig = () => J([CACHE.lms_mk, CACHE.lms_join, CACHE.lms_prog, CACHE.lms_users.map(u => [u.uid, u.email, u.pref, u.verified])]);
    const before = sig();
    if (await loadAll(true) !== true) return;
    U = Auth.session() || U; isDosen = !!U && U.role === 'Pengajar';
    const ae = document.activeElement, typing = ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
    if (sig() !== before && !$('#layer').innerHTML && S.view !== 'pert' && !typing) render();
  } catch (e) { console.warn('Segarkan data gagal', e); }
  finally { REFRESHING = false; }
}

const Auth = {
  users() { return CACHE.lms_users; },
  find(email) { const e = String(email || '').trim().toLowerCase(); return CACHE.lms_users.find(u => u.email === e); },
  session() { return SESS ? this.find(SESS) : null; },
  // Hanya No. HP dan preferensi yang boleh diubah pengguna (nama, peran, ID, minat dikunci di database)
  update(email, patch) {
    const u = this.find(email); if (!u) return null;
    Object.assign(u, patch);
    const row = {}; ['hp', 'pref'].forEach(k => { if (k in patch) row[k] = patch[k]; });
    if (Object.keys(row).length) { WSEQ++; enqueue(async () => { const { error } = await sb.from('profiles').update(row).eq('uid', u.uid); if (error) throw error; }); }
    return u;
  },
  requireLogin() { const u = this.session(); if (!u) location.replace('login.html'); return u; },
  async logout() { try { await Q; await sb.auth.signOut(); } catch (e) {} location.href = 'login.html'; }
};

const isGmail = v => /^[a-z0-9._%+-]+@gmail\.com$/i.test(String(v).trim());
const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(t) {
  const e = document.createElement('div');
  e.className = 'toast'; e.setAttribute('role', 'status'); e.textContent = t;
  document.body.appendChild(e); setTimeout(() => e.remove(), 2400);
}

const PAGE=document.body.dataset.page;
// Preferensi pengguna disimpan di data akunnya (u.pref): ukuran teks, pengingat, dan penanda panduan awal sudah dilihat (tour)
const prefOf = u => ({ fs: 'normal', dl: true, ab: true, nl: true, tour: false, rm: false, dh: 24, ...((u && u.pref) || {}) });
function applyPref() {
  const u = Auth.session(), pf = prefOf(u), r = document.documentElement; if (!r) return;
  r.setAttribute('data-fs', pf.fs); r.classList.toggle('no-anim', !!pf.rm);   // ukuran teks & mode kurangi animasi
}
// Info pengguna di bilah atas: nama, lencana peran yang jelas, dan ID
function setMe(u) {
  const g = id => document.getElementById(id);
  g('meAv').textContent = (u.nama || '?').charAt(0).toUpperCase();
  g('meName').textContent = u.nama;
  g('meSub').innerHTML = `<span class="idtxt">ID ${esc(u.id)}</span><span class="rolechip ${u.role === 'Pengajar' ? 'pg' : 'pt'}">${esc(u.role)}</span>`;
  initTop(u);
}
const KONTAK = { email: 'reynanda.p08@gmail.com', wa: '089529235484', waIntl: '6289529235484' };
// Footer (tidak dipasang di halaman login): hanya Bantuan dan Hubungi kami. Di beranda, panduan dibuka langsung; di halaman lain lewat index.html#tour.
function footerHtml() {
  const tur = PAGE === 'beranda' ? `<button class="fl" onclick="startTour()">📖 Panduan penggunaan</button>` : `<a class="fl" href="index.html#tour">📖 Panduan penggunaan</a>`;
  return `<div class="fwrap">
    <span class="fcopy">© ${new Date().getFullYear()} · Semua hak dilindungi</span>
    <div class="fhelp">${tur}</div>
    <div class="fcontact"><span class="fh">Hubungi kami</span><a class="fl" href="mailto:${KONTAK.email}">✉️ ${KONTAK.email}</a><a class="fl" href="https://wa.me/${KONTAK.waIntl}" target="_blank" rel="noopener noreferrer">💬 ${KONTAK.wa}</a></div>
  </div>`;
}
const $=s=>document.querySelector(s);

/* ===== HALAMAN BERANDA, MATA KULIAH, PROGRES (pengajar & partisipan) ===== */
const TOTAL = 16, MAXP = 50;   // TOTAL = jumlah pertemuan bawaan; tiap kelas bisa punya jumlah sendiri (k.total), maksimal MAXP
const totalOf = k => Math.min(MAXP, Math.max(1, Math.floor(+(k && k.total)) || TOTAL));
const cekTotal = v => { const t = Number(v); return Number.isInteger(t) && t >= 1 && t <= MAXP ? t : 0; };
let U = null, isDosen = false;   // diisi setelah data dari Supabase dimuat (lihat bagian paling bawah)
// view: home | courses | course (satu pelajaran) | kelas (satu kelas) | pert (pertemuan kelas) | progress | settings
const S = { view: 'home', cid: null, kid: null, open: {}, edit: null, draft: {}, pf: null, pfKey: null };   // draft = lampiran tugas yang belum dikirim

// Data: pelajaran -> kelas[] -> pert[] (pertemuan milik kelas). Keanggotaan & progres terpisah.
const st = {
  mk: () => DB.get('lms_mk', []), setMk: l => DB.set('lms_mk', l),
  jn: () => DB.get('lms_join', []), setJn: l => DB.set('lms_join', l),
  pr: () => DB.get('lms_prog', {}), setPr: p => DB.set('lms_prog', p)
};
const getMk = id => st.mk().find(m => m.id === id);
const getKelas = (m, kid) => m && m.kelas.find(k => k.id === kid);
const saveMk = m => { const l = st.mk(), i = l.findIndex(x => x.id === m.id); if (i < 0) l.push(m); else l[i] = m; return st.setMk(l); };
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function P(mkId, em) { const x = (st.pr()[mkId] || {})[em] || {}; return { att: x.att || {}, sub: x.sub || {}, quiz: x.quiz || {}, qt: x.qt || {}, nilai: x.nilai || {}, kembali: x.kembali || {}, qext: x.qext || {} }; }
function setP(mkId, em, v) { const a = st.pr(); (a[mkId] = a[mkId] || {})[em] = v; return st.setPr(a); }
const studentsOf = (mkId, kelasId) => st.jn().filter(j => j.mkId === mkId && (!kelasId || j.kelasId === kelasId)).map(j => Auth.find(j.mhs)).filter(Boolean);
const myMk = () => isDosen ? st.mk().filter(m => m.dosen === U.email)
  : st.jn().filter(j => j.mhs === U.email).map(j => getMk(j.mkId)).filter(Boolean);
// kelas & pertemuan milik seorang partisipan
const kelasOf = (m, em) => { const j = st.jn().find(q => q.mhs === em && q.mkId === m.id); return j ? getKelas(m, j.kelasId) : null; };
const pertOf = (m, em) => { const k = kelasOf(m, em); return k ? k.pert : []; };
const pertAt = (mkId, n, kid) => { const m = getMk(mkId); if (!m) return null; const k = kid ? getKelas(m, kid) : kelasOf(m, U.email); return k ? k.pert.find(x => x.n === n) : null; };
const totalPert = m => m.kelas.reduce((a, k) => a + k.pert.length, 0);   // total pertemuan dari semua kelas
const subName = v => typeof v === 'string' ? v : v.nama;
const subAt = v => v && typeof v === 'object' ? v.at : null;
// Pengumpulan lama (sebelum isi berkas disimpan) hanya punya nama berkas, sehingga tidak bisa dibuka pengajar
// Satu pengumpulan bisa berisi beberapa lampiran (file atau link). Format lama (satu file) tetap terbaca.
const itemsOf = f => !f || typeof f === 'string' ? [] : f.items ? f.items : (f.data ? [{ tipe: 'file', nama: f.nama, data: f.data }] : []);
const legacyFile = f => !!f && !f.manual && itemsOf(f).length === 0;
// Materi, instruksi tugas, dan instruksi quiz masing-masing bisa berisi sampai 5 lampiran (file atau link). Format lama tetap terbaca.
const asList = v => !v ? [] : Array.isArray(v) ? v : [v];
const fixTipe = it => it.tipe ? it : { ...it, tipe: 'file' };
const matOf = x => asList(x.materi).map(fixTipe), tlOf = x => asList(x.tugasLamp || x.tugasFile).map(fixTipe), qlOf = x => asList(x.quizLamp).map(fixTipe);
const adaQuiz = x => x.quiz.length > 0 || qlOf(x).length > 0;
// Quiz selesai: soal sudah dikerjakan (jika ada soal) DAN quiz tautan/berkas sudah ditandai selesai atau dikirim hasilnya (jika ada)
// qext[n] bisa berisi { at, items, nilai } (terkirim) atau { kembali } (dikembalikan pengajar, belum dikirim ulang)
const qeOk = qe => !!qe && !qe.kembali;
const quizDone = (p, x) => (!x.quiz.length || p.quiz[x.n] != null) && (!qlOf(x).length || qeOk(p.qext[x.n]));
const MAX_LAMP = 5, MAX_TOTAL = 3 * 1048576;
const sizeTxt = b => b >= 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
function bukaLink(url) { if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer'); else toast('Link tidak valid'); }
const dkey = (mkId, n, t) => mkId + '-' + (t === 'q' ? 'q' : '') + n;
const lampRow = (it, btns) => `<div class="ditem"><span class="dn">${it.tipe === 'link' ? '🔗 ' + esc(it.url) : '📄 ' + esc(it.nama) + (it.size ? ' <small>(' + sizeTxt(it.size) + ')</small>' : '')}</span><span class="row" style="flex-wrap:nowrap;gap:6px">${btns}</span></div>`;
// Daftar lampiran yang bisa dilihat langsung (tanpa mengunduh) atau diunduh
const lampList = (items, kind, mkId, n) => items.map((it, j) => lampRow(it, it.tipe === 'link'
  ? `<button class="btn sm" onclick="lihatRef('${kind}','${mkId}',${n},${j},'')">Buka link</button>`
  : `<button class="btn sm" onclick="lihatRef('${kind}','${mkId}',${n},${j},'')">Lihat</button><button class="btn ghost sm" onclick="unduhRef('${kind}','${mkId}',${n},${j},'')">Unduh</button>`)).join('');
// Menyusun lampiran sebelum dikirim (tugas 't' atau hasil quiz 'q'): tambah file/link, hapus, lalu kirim
const draftUI = (m, x, t, label) => {
  const k = dkey(m.id, x.n, t), a = `'${m.id}',${x.n},'${t}'`, d = S.draft[k] || [], tot = d.reduce((s2, it) => s2 + (it.size || 0), 0), penuh = d.length >= MAX_LAMP, menu = S.dMenu === k, linkOpen = S.dLink === k;
  // Tombol "Tambah lampiran" membuka pilihan File atau Link (sama seperti di sisi pengajar)
  const tambah = penuh ? '<div class="quote">Batas 5 lampiran tercapai. Hapus salah satu untuk menambah yang lain.</div>'
    : `<div class="addwrap"><button type="button" class="addbtn" aria-haspopup="menu" aria-expanded="${menu}" onclick="dMenu('${k}')"><span class="addplus" aria-hidden="true">＋</span>Tambah lampiran<span class="addcar" aria-hidden="true">▾</span></button>${menu ? `<div class="addmenu" role="menu"><button type="button" role="menuitem" class="addopt" onclick="dPilihFile('${k}')"><span class="addic" aria-hidden="true">📎</span><span><b>File</b><small>Unggah dari perangkat · maks. 1,5 MB</small></span></button><button type="button" role="menuitem" class="addopt" onclick="dPilihLink('${k}')"><span class="addic" aria-hidden="true">🔗</span><span><b>Link</b><small>Google Drive, GitHub, dll.</small></span></button></div>` : ''}</div>
    <input type="file" multiple hidden id="fd-${k}" aria-label="Pilih file" onchange="tambahFile(${a})">
    ${linkOpen ? `<div class="row addlink"><input class="lnk" id="ld-${k}" placeholder="https://… (tempel link di sini)" aria-label="Link" onkeydown="if(event.key==='Enter')tambahLink(${a})"><button class="btn ghost sm" onclick="tambahLink(${a})">+ Tambah link</button><button class="btn ghost sm" onclick="dPilihLink('')">Batal</button></div>` : ''}`;
  return `<div class="draft"><div class="bsub">Lampiran <span class="bsm">· ${d.length}/${MAX_LAMP} (file atau link)${d.length ? ' · ' + sizeTxt(tot) : ''}</span></div>
    ${d.map((it, i) => lampRow(it, `<button class="btn ghost sm dng" onclick="hapusDraft(${a},${i})" aria-label="Hapus lampiran ${i + 1}">✕ Hapus</button>`)).join('')}
    ${tambah}
    <div class="row" style="margin-top:10px"><button class="btn lime" ${d.length ? '' : 'disabled'} onclick="send(${a})">${label}${d.length ? ' (' + d.length + ' lampiran)' : ''}</button></div>
    <div class="quote">Maksimal ${MAX_LAMP} lampiran. Tiap file maks. 1,5 MB, total maks. 3 MB. Lampiran bisa dihapus sebelum dikirim.</div></div>`;
};
// Menu "Tambah lampiran" di sisi partisipan (kunci k = dkey pertemuan)
function dMenu(k) { S.dMenu = S.dMenu === k ? null : k; render(); }
function dPilihFile(k) { S.dMenu = null; render(); const i = document.getElementById('fd-' + k); if (i) i.click(); }
function dPilihLink(k) { S.dMenu = null; S.dLink = k || null; render(); if (k) { const i = document.getElementById('ld-' + k); if (i) i.focus(); } }
const MAXB = 1.5 * 1048576;   // batas ukuran berkas
const readFile = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('baca')); r.readAsDataURL(f); });
// Buka berkas apa pun: PDF/gambar dibuka di tab baru, selain itu diunduh
function bytesOf(f) {
  const i = f.data.indexOf(','), mime = (f.data.slice(0, i).match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const b = atob(f.data.slice(i + 1)), a = new Uint8Array(b.length);
  for (let j = 0; j < b.length; j++) a[j] = b.charCodeAt(j);
  return { a, mime };
}
const blobUrl = f => { const { a, mime } = bytesOf(f); return URL.createObjectURL(new Blob([a], { type: mime })); };
// PDF/gambar dibuka di tab baru, selain itu diunduh. unduh=true memaksa unduh.
function bukaBerkas(f, unduh) {
  if (!f || !f.data) { toast('Berkas tidak tersimpan'); return; }
  try {
    const url = blobUrl(f), mime = bytesOf(f).mime;
    if (!unduh && /pdf|^image\//.test(mime) && window.open(url, '_blank')) return;
    const l = document.createElement('a'); l.href = url; l.download = f.nama; document.body.appendChild(l); l.click(); l.remove();
  } catch (e) { toast('Berkas tidak bisa dibuka'); }
}
// Pratinjau langsung di halaman (tanpa mengunduh): PDF, gambar, dan berkas teks/kode
const EXT = f => (f.nama.split('.').pop() || '').toLowerCase();
const EXT_TXT = ['txt', 'java', 'py', 'js', 'ts', 'jsx', 'html', 'htm', 'css', 'json', 'md', 'csv', 'xml', 'c', 'cpp', 'h', 'cs', 'php', 'sql', 'log', 'sh', 'kt', 'rb', 'go', 'ini', 'yml', 'yaml'];
const EXT_IMG = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
let PV_URL = null;
function freePv() { if (PV_URL) { try { URL.revokeObjectURL(PV_URL); } catch (e) {} PV_URL = null; } }
function previewHtml(f) {
  const x = EXT(f);
  try {
    if (x === 'pdf') { PV_URL = blobUrl(f); return `<iframe class="pv" src="${PV_URL}" title="Pratinjau ${esc(f.nama)}"></iframe>`; }
    if (EXT_IMG.includes(x)) return `<div class="pv img"><img src="${esc(f.data)}" alt="${esc(f.nama)}"></div>`;
    if (EXT_TXT.includes(x)) {
      const t = new TextDecoder('utf-8').decode(bytesOf(f).a), cut = t.length > 100000;
      return `<pre class="pv code">${esc(cut ? t.slice(0, 100000) : t)}</pre>${cut ? '<div class="quote">Hanya 100.000 karakter pertama yang ditampilkan. Unduh untuk melihat seluruhnya.</div>' : ''}`;
    }
  } catch (e) { return '<div class="pv none">Berkas tidak bisa ditampilkan. Gunakan tombol Unduh.</div>'; }
  return `<div class="pv none">Format .${esc(x || '?')} (misalnya Word, PowerPoint, Excel, atau ZIP) tidak bisa ditampilkan langsung oleh browser.<br>Gunakan tombol Unduh untuk membukanya.</div>`;
}
// Cari lampiran dari sumbernya: mat=materi, tl=instruksi tugas, ql=instruksi quiz, sub=kiriman tugasku, qx=kiriman quizku
function refItem(kind, mkId, n, j, kid) {
  if (kind === 'sub') return itemsOf(P(mkId, U.email).sub[n])[j];
  if (kind === 'qx') return itemsOf(P(mkId, U.email).qext[n])[j];
  const x = pertAt(mkId, n, kid); if (!x) return null;
  return (kind === 'mat' ? matOf(x) : kind === 'tl' ? tlOf(x) : qlOf(x))[j];
}
async function lihatRef(kind, mkId, n, j, kid) {
  const it0 = refItem(kind, mkId, n, j, kid); if (!it0) return;
  if (it0.tipe === 'link') { bukaLink(it0.url); return; }
  let it; try { it = await withData(it0); } catch (e) { toast('Berkas tidak bisa dibuka'); return; }
  freePv();
  modal(`<button class="btn ghost" onclick="tutupModal()">← Kembali</button><h3 style="margin:12px 0 0;word-break:break-all">${esc(it.nama)}</h3><div class="quote">${it.size ? sizeTxt(it.size) : ''}</div>${previewHtml(it)}
  <div class="row" style="margin-top:12px"><button class="btn ghost sm" onclick="unduhRef('${kind}','${mkId}',${n},${j},'${kid || ''}')">Unduh</button></div>`, 'wide');
}
async function unduhRef(kind, mkId, n, j, kid) {
  const it0 = refItem(kind, mkId, n, j, kid); if (!it0 || it0.tipe === 'link') return;
  try { bukaBerkas(await withData(it0), true); } catch (e) { toast('Berkas tidak bisa diunduh'); }
}

function stats(m, em) {
  const p = P(m.id, em), pt = pertOf(m, em); let tasks = 0, done = 0, todoT = 0, todoQ = 0;
  pt.forEach(x => {
    if (x.tugas) { tasks++; if (p.sub[x.n]) done++; else todoT++; }
    if (adaQuiz(x)) { tasks++; if (quizDone(p, x)) done++; else todoQ++; }
  });
  const hadir = Object.values(p.att).filter(v => v === 'H').length;
  const lewat = pt.filter(x => p.att[x.n] !== 'H' && x.absen && x.absen.dur > 0 && Date.now() >= x.absen.start + x.absen.dur * 60000).length;   // absen sudah ditutup dan tidak dihadiri
  return { hadir, held: pt.length, lewat, tasks, done, todo: tasks - done, todoT, todoQ };
}

// ---------- helper tampilan ----------
const IC = ['📘', '🌐', '🗄️', '💻', '📊', '🧮'], CL = ['#e8f1ff', '#e5f8ec', '#fff3dc', '#ece8ff', '#ffe9ec', '#e2f6f6'];
const dec = m => { const i = [...m.id].reduce((a, c) => a + c.charCodeAt(0), 0) % IC.length; return { ic: IC[i], col: CL[i], i }; };
const QUOTE = '“Keberhasilan adalah jumlah usaha kecil yang diulang setiap hari.” – Robert Collier';
const banner = () => U.verified ? '' : '<div class="card warn">⚠️ Gmail kamu belum diverifikasi. <a href="profil.html"><b>Verifikasi sekarang</b></a></div>';
const head = () => heroB() + banner();
const empty = (ic, t, d, btn) => `<div class="card empty-s"><div class="big-ic">${ic}</div><h3>${t}</h3><p class="quote">${d}</p>${btn}</div>`;
const sc = (l, v, ic, bg, c, sub, cls, act, pop) => `<div class="card stat${act ? ' click' : ''}"${act ? ` role="button" tabindex="0" onclick="${act}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}"` : ''}><div><div class="l">${l}</div><div class="v"${c ? ` style="color:${c}"` : ''}>${typeof v === 'number' ? `<span class="cnt" data-to="${v}">${v}</span>` : v}</div>${sub ? `<div class="ssub">${sub}</div>` : ''}</div><div class="ic ${cls || ''}" style="background:${bg}">${ic}</div>${act ? '<span class="more">Lihat detail ›</span>' : ''}${pop || ''}</div>`;
const kp = (l, v, s) => `<div class="card kp"><div class="l">${l}</div><div class="v">${v}</div>${s ? `<div class="meta"><span>${s}</span></div>` : ''}</div>`;
const cap1 = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const hl = (l, v) => `<span class="hlbl">${l}:</span> ${v}`;   // "Label: nilai" untuk subjudul header
const hdr = (m, sub) => { const d = dec(m); return `<div class="row" style="margin-bottom:14px"><div class="ic" style="background:${d.col};width:50px;height:50px;font-size:24px">${d.ic}</div><div><h1 style="font-size:24px">${esc(m.nama)}${m.kode ? ` <span class="hid">(${esc(m.kode)})</span>` : ''}</h1><div class="hsub">${sub}</div></div></div>`; };
const btnJoin = '<button class="btn lime" onclick="joinModal()">Masuk kelas</button>';
const btnMk = '<button class="btn lime" onclick="mkModal()">Buat pelajaran</button>';
const fmtDt = ts => new Date(ts).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const localIn = ts => new Date(ts - new Date(ts).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const over = ts => !!ts && Date.now() > ts;
const dlChip = ts => ts ? `<span class="chip ${over(ts) ? 'c-no' : 'c-iz'}">Batas: ${fmtDt(ts)}${over(ts) ? ' · sudah lewat' : ''}</span>` : '';

// Absen mandiri: dibuka saat pertemuan dibuat/dibuka ulang, tutup setelah "dur" menit.
const absenOpen = x => !!(x.absen && x.absen.dur > 0 && Date.now() < x.absen.start + x.absen.dur * 60000);
const absenExp = x => x.absen.start + x.absen.dur * 60000;
const fmt = ms => { const t = Math.max(0, Math.ceil(ms / 1000)); return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
const cd = x => `<span data-exp="${absenExp(x)}">${fmt(absenExp(x) - Date.now())}</span>`;

function courseCards(L) {
  return `<div class="courses pcs" id="pcs">${L.map((m, idx) => {
    const d = dec(m); let sub, foot, held, tot = TOTAL, pill = '', pop = '', tip = '';
    if (isDosen) {
      held = m.kelas.length ? totalPert(m) / m.kelas.length : 0; tot = m.kelas.length ? m.kelas.reduce((a, k) => a + totalOf(k), 0) / m.kelas.length : TOTAL; sub = `${studentsOf(m.id).length} partisipan`;
      pill = `<span class="pc-pill">${m.kelas.length} kelas</span>`;
      foot = `<span>Pertemuan berjalan ${totalPert(m)}</span><span>${m.kelas.length ? 'Buka pelajaran →' : '<b style="color:var(--red)">Belum ada kelas</b>'}</span>`;
      // Saat kartu di-hover: daftar kelas yang bisa langsung dibuka (popover di luar kartu, lihat initPcTip)
      tip = `<div class="hv-src" hidden data-dir="auto" data-th="th${d.i}"><div class="hv-head"><span class="hv-ic">🏷️</span><div><b>Pilih kelas</b><small>${esc(m.nama)} · masuk langsung</small></div></div><div class="hv-body">${m.kelas.length
        ? m.kelas.map(k => `<button type="button" class="kchip" onclick="event.stopPropagation();bukaKelasDari('${m.id}','${k.id}')"><i>${esc(k.nama.trim().slice(-1).toUpperCase())}</i><span><b>${esc(k.nama)}</b><small>${studentsOf(m.id, k.id).length} partisipan · ${esc(k.kode)}</small></span><em>→</em></button>`).join('')
        : '<div class="hv-row muted">Belum ada kelas. Klik pelajaran ini untuk membuatnya.</div>'}</div><div class="hv-foot"><span></span><span>Klik pelajaran untuk semua kelas ›</span></div></div>`;
    } else {
      const s2 = stats(m, U.email), p = P(m.id, U.email); held = s2.held; tot = totalOf(kelasOf(m, U.email)); sub = esc(m.dosenNama);
      const mw = [s2.todoT && `${s2.todoT} tugas`, s2.todoQ && `${s2.todoQ} quiz`].filter(Boolean).join(' & ');
      foot = `<span>Pertemuan ${s2.held}/${totalOf(kelasOf(m, U.email))}</span><span>${mw ? `<b style="color:var(--red)">${mw} menunggu</b>` : 'Tugas beres'}</span>`;
      if (pertOf(m, U.email).some(x => absenOpen(x) && !p.att[x.n])) pill = '<span class="pc-pill live">🔔 Absen dibuka</span>';
      // Saat kartu di-hover: ringkasan total pertemuan dan tugas selesai (popover di luar kartu, lihat initPcTip)
      const lw = s2.lewat ? ` · <b class="neg">terlewat ${s2.lewat}</b>` : '';
      tip = `<div class="hv-src" hidden data-dir="auto" data-th="th${d.i}"><div class="hv-head"><span class="hv-ic">${d.ic}</span><div><b>${esc(m.nama)}</b><small>${sub}</small></div></div><div class="hv-body"><div class="pcp-s"><div class="pcs-i"><span>Total pertemuan</span><b>${s2.held}</b><small>${s2.held ? `Hadir ${s2.hadir} kali${lw}` : 'Belum ada pertemuan'}</small></div><div class="pcs-i"><span>Tugas selesai</span><b>${s2.done}<i class="of">/${s2.tasks}</i></b><small>${mw ? `Menunggu: ${mw}` : (s2.tasks ? 'Semua beres 🎉' : 'Belum ada tugas')}</small></div></div></div><div class="hv-foot"><span></span><span>Klik kartu untuk detail ›</span></div></div>`;
    }
    return `<div class="pc th${d.i}" data-n="${esc(m.nama.toLowerCase())}" style="--i:${idx}" role="link" tabindex="0" aria-label="Buka pelajaran ${esc(m.nama)}" onclick="go('course','${m.id}')" onkeydown="if(event.target===this&&(event.key==='Enter'||event.key===' ')){event.preventDefault();go('course','${m.id}')}"><div class="pc-top"><span class="pc-ic">${d.ic}</span>${pill}</div><div class="pc-body"><b>${esc(m.nama)}</b><span class="s">${sub}</span><div class="bar"><i style="width:${Math.min(100, held / tot * 100)}%"></i></div><div class="meta">${foot}</div></div>${pop}${tip}</div>`;
  }).join('')}</div>`;
}
// ===== Popover hover di luar kartu =====
// Kartu yang punya <div class="hv-src" hidden data-dir="right|left|below|auto" data-th="..."> akan memunculkan popover berpanah
// di luar kotaknya saat di-hover atau difokus, dan semua elemen lain di halaman diburamkan. Klik kartu/popover tetap membuka detail.
let hvEl = null, hvCur = null, hvBl = [], hvT = 0, hvPend = null, hvShowT = 0;
const HV_DELAY = 1500;   // jeda (ms) setelah kursor berada di kartu sebelum popover muncul; ubah angka ini untuk mengatur lamanya
// Hitung posisi popover terhadap kartu (r = kotak kartu). Arah yang tidak muat di layar otomatis pindah ke bawah/atas.
function hvPlace(r, dir, w, h, vw, vh, pr) {
  const G = 12, M = 8, fitR = vw - r.right >= w + G + M, fitL = r.left >= w + G + M, cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  if (dir === 'auto') {   // kartu pelajaran: kolom paling kiri -> popover ke kanan, paling kanan -> ke kiri, selain itu -> ke bawah
    const first = pr && r.left - pr.left < 8, last = pr && pr.right - r.right < 8;
    dir = first && !last && fitR ? 'right' : last && !first && fitL ? 'left' : fitR && fitL ? 'below' : fitR && !pr ? 'right' : fitL && !pr ? 'left' : 'below';
  }
  if ((dir === 'right' && !fitR) || (dir === 'left' && !fitL)) dir = 'below';
  let top, left, ax = 0, ay = 0;
  if (dir === 'right' || dir === 'left') {
    left = dir === 'right' ? r.right + G : r.left - G - w;
    top = Math.min(Math.max(M, cy - 28), Math.max(M, vh - h - M));   // kepala popover sejajar dengan tengah kartu
    ay = Math.min(Math.max(20, cy - top), h - 20);
  } else {
    if (r.bottom + G + h > vh - M && r.top - G - h > M) { dir = 'above'; top = r.top - G - h; } else top = r.bottom + G;
    left = Math.min(Math.max(M, cx - w / 2), Math.max(M, vw - w - M));
    ax = Math.min(Math.max(24, cx - left), w - 24);
  }
  return { dir, top, left, ax, ay };
}
// Buramkan semua elemen kecuali kartu yang difokuskan (dan induknya)
function hvBlur(card) {
  hvUnblur();
  let a = card;
  while (a && a !== document.body && a.parentElement) {
    [...a.parentElement.children].forEach(s => {
      if (s !== a && !/^(SCRIPT|STYLE|LINK)$/.test(s.tagName) && !s.classList.contains('hv-tip') && !['layer', 'tour'].includes(s.id) && !s.classList.contains('toast')) { s.classList.add('hv-blur'); hvBl.push(s); }
    });
    a = a.parentElement;
  }
}
function hvUnblur() { hvBl.forEach(s => s.classList.remove('hv-blur')); hvBl = []; }
function cancelPcWait() { clearTimeout(hvShowT); if (hvPend) hvPend.classList.remove('hv-wait'); hvPend = null; }
function hidePcTip() { clearTimeout(hvT); cancelPcWait(); if (hvEl) hvEl.classList.remove('on'); hvUnblur(); hvCur = null; }
function hvLater() { clearTimeout(hvT); hvT = setTimeout(hidePcTip, 160); }
function showPcTip(card) {
  clearTimeout(hvT);
  const src = card.querySelector(':scope > .hv-src'); if (!src) { hidePcTip(); return; }
  if (typeof TOUR !== 'undefined' && TOUR.on) return;
  if (!hvEl) {
    hvEl = document.createElement('div'); hvEl.setAttribute('role', 'tooltip'); document.body.appendChild(hvEl);
    hvEl.addEventListener('mouseenter', () => clearTimeout(hvT));
    hvEl.addEventListener('mouseleave', hvLater);
    hvEl.addEventListener('click', e => { if (e.target.closest('button,a')) return; const c = hvCur; hidePcTip(); if (c) c.click(); });
  }
  hvCur = card;
  hvEl.className = 'hv-tip ' + (src.dataset.th || '');
  hvEl.innerHTML = '<i class="hv-arw"></i>' + src.innerHTML;
  hvBlur(card);
  const r = card.getBoundingClientRect(), dir0 = src.dataset.dir || 'auto';
  hvEl.style.width = '300px';
  const pr = card.parentElement ? card.parentElement.getBoundingClientRect() : null;
  let p = hvPlace(r, dir0, 300, hvEl.offsetHeight, innerWidth, innerHeight, pr), w = 300;
  if (p.dir === 'below' || p.dir === 'above') {   // di bawah/atas kartu, lebar mengikuti kartu
    w = Math.max(300, Math.min(r.width, 420)); hvEl.style.width = w + 'px';
    p = hvPlace(r, p.dir, w, hvEl.offsetHeight, innerWidth, innerHeight, pr);
  }
  hvEl.classList.add('d-' + p.dir);
  hvEl.style.top = p.top + 'px'; hvEl.style.left = p.left + 'px';
  hvEl.style.setProperty('--ax', p.ax + 'px'); hvEl.style.setProperty('--ay', p.ay + 'px');
  const arw = hvEl.firstChild; if (arw) arw.classList.toggle('w', (p.dir === 'right' || p.dir === 'left') && p.ay > 52);
  hvEl.classList.add('on');
}
function initPcTip() {
  document.documentElement.style.setProperty('--hv-delay', HV_DELAY + 'ms');
  const ok = () => window.matchMedia && matchMedia('(hover:hover)').matches;
  const trg = e => { const c = e.target && e.target.closest && e.target.closest('.stat.click, .pc'); return c && c.querySelector(':scope > .hv-src') ? c : null; };
  document.addEventListener('mouseover', e => {
    if (!ok()) return;
    const c = trg(e);
    if (c) {
      clearTimeout(hvT);
      if (c === hvCur || c === hvPend) return;   // popover sudah tampil, atau kartu ini sedang menunggu jeda
      hidePcTip();                                // tutup popover kartu lain dan batalkan penantian sebelumnya
      hvPend = c; c.classList.add('hv-wait');
      hvShowT = setTimeout(() => {
        const k = hvPend; hvPend = null;
        if (k) { k.classList.remove('hv-wait'); if (k.isConnected && k.matches(':hover')) showPcTip(k); }
      }, HV_DELAY);
    } else {
      if (hvPend) cancelPcWait();                 // kursor keluar dari kartu sebelum jeda selesai
      if (hvCur && !(hvEl && hvEl.contains(e.target))) hvLater();
    }
  });
  document.documentElement.addEventListener('mouseleave', () => { cancelPcWait(); hvLater(); });
  document.addEventListener('focusin', e => { const c = trg(e); if (c && ok()) showPcTip(c); });
  document.addEventListener('focusout', () => { if (hvCur) hvLater(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hidePcTip(); });
  document.addEventListener('click', e => { if ((hvCur || hvPend) && trg(e)) hidePcTip(); }, true);
  document.addEventListener('scroll', hidePcTip, true);
  window.addEventListener('resize', hidePcTip);
}
function bukaKelasDari(mkId, kid) { S.cid = mkId; bukaKelas(kid); }   // masuk langsung ke kelas dari daftar pelajaran
function filterPelajaran(q) {
  q = q.trim().toLowerCase(); let n = 0;
  document.querySelectorAll('#pcs .pc').forEach(c => { const ok = !q || c.dataset.n.includes(q); c.hidden = !ok; if (ok) n++; });
  const e = document.getElementById('pEmpty'); if (e) e.hidden = n > 0;
  const c = document.getElementById('pCount'); if (c) c.textContent = `${n} pelajaran`;
}

// ---------- BERANDA ----------
// Ringkasan nyata dari data kelas, absen, dan tugas milik pengguna ini
function ringkas(u) {
  if (u.role === 'Pengajar') {
    const mine = st.mk().filter(m => m.dosen === u.email); let kelas = 0, mhs = 0, pert = 0, kirim = 0, nilai = 0;
    mine.forEach(m => m.kelas.forEach(k => {
      kelas++; pert += k.pert.length; const ss = studentsOf(m.id, k.id); mhs += ss.length;
      k.pert.forEach(x => ss.forEach(w => { const q = P(m.id, w.email); if (x.tugas && q.sub[x.n]) { kirim++; if (!q.nilai[x.n]) nilai++; } const qe = q.qext[x.n]; if (qlOf(x).length && qeOk(qe) && itemsOf(qe).length) { kirim++; if (!qe.nilai) nilai++; } }));
    }));
    return { mine, tiles: [[mine.length, 'Pelajaran diampu'], [kelas, 'Total kelas'], [mhs, 'Partisipan'], [pert, 'Pertemuan dibuat'], [kirim, 'Tugas & quiz terkumpul'], [nilai, 'Perlu dinilai']] };
  }
  const L = st.jn().filter(j => j.mhs === u.email).map(j => getMk(j.mkId)).filter(Boolean); let hadir = 0, held = 0, tasks = 0, done = 0; const skor = [];
  L.forEach(m => { const q = stats(m, u.email); hadir += q.hadir; held += q.held; tasks += q.tasks; done += q.done; Object.values(P(m.id, u.email).nilai).forEach(nl => { if (nl.skor != null) skor.push(nl.skor); }); });
  const avg = skor.length ? Math.round(skor.reduce((x, y) => x + y, 0) / skor.length * 10) / 10 : '—';
  return { mine: L, tiles: [[L.length, 'Pelajaran diikuti'], [hadir + '/' + held, 'Pertemuan dihadiri'], [held ? Math.round(hadir / held * 100) + '%' : '—', 'Tingkat kehadiran'], [done + '/' + tasks, 'Tugas & quiz selesai'], [tasks - done, 'Perlu dikerjakan'], [avg, 'Rata-rata nilai tugas']] };
}

// Tugas/quiz yang batasnya kurang dari 24 jam lagi
const soonHtml = (todo, pf) => {
  const now = Date.now(), t = pf.dl === false ? [] : todo.filter(([m, x, k, dl]) => dl && dl > now && dl - now < (pf.dh || 24) * 36e5);
  return t.length ? `<h2>⏰ Segera berakhir</h2>${t.map(([m, x, k, dl]) => `<button class="todo" onclick="bukaItem('${m.id}',${x.n})"><span class="chip c-no">${k}</span><span><b>${esc(m.nama)}</b> · Pertemuan ${x.n}: ${esc(x.topik)}</span>${dlChip(dl)}</button>`).join('')}` : '';
};
// ---------- elemen Beranda: hero dengan langit animasi, kutipan bergilir, bilah atas ----------
const sapa = () => { const h = new Date().getHours(); return h < 11 ? ['Selamat pagi', '🌅'] : h < 15 ? ['Selamat siang', '☀️'] : h < 18 ? ['Selamat sore', '🌇'] : ['Selamat malam', '🌙']; };
const tglID = () => new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const skyOf = () => { const h = new Date().getHours(); return h < 11 ? 'pagi' : h < 15 ? 'siang' : h < 18 ? 'sore' : 'malam'; };
const QUOTES = [QUOTE,
  '“Pendidikan adalah senjata paling ampuh untuk mengubah dunia.” – Nelson Mandela',
  '“Investasi dalam pengetahuan memberikan bunga terbaik.” – Benjamin Franklin',
  '“Satu-satunya cara melakukan pekerjaan hebat adalah mencintai apa yang kamu lakukan.” – Steve Jobs'];
// Langit di dalam hero: bulan dan bintang berkedip saat malam; matahari berputar dan awan lewat saat siang
function skyHtml(k) {
  if (k === 'malam') return '<div class="sky"><span class="moon"></span>' + Array.from({ length: 16 }, (_, i) => `<i class="star${i % 4 === 0 ? ' big' : ''}" style="left:${42 + (i * 37) % 55}%;top:${6 + (i * 53) % 82}%;animation-delay:${(i * 0.37) % 3}s"></i>`).join('') + '</div>';
  return '<div class="sky"><span class="sun"></span><span class="cloud c1"></span><span class="cloud c2"></span><span class="cloud c3"></span></div>';
}
function heroB() {
  const [g, em] = sapa(), k = skyOf();
  return `<section class="hero-b ${k}">${skyHtml(k)}<span class="blob b1"></span><span class="blob b2"></span>
    <div class="hb-txt"><div class="hb-eyebrow">${em} ${g} · ${tglID()}</div><h1>Selamat datang, ${esc(U.nama)}!</h1><p class="hb-quote" id="hbQuote">${QUOTES[0]}</p></div></section>`;
}
// Cincin mini persentase kehadiran di dalam kartu "Total pertemuan"
const miniRing = pct => `<svg class="mring" viewBox="0 0 60 60" style="--p:${pct}" aria-hidden="true"><circle class="bg" cx="30" cy="30" r="25"/><circle class="fg" cx="30" cy="30" r="25"/></svg><b class="cnt" data-to="${pct}" data-suf="%">${pct}%</b>`;
const SCENE = `<svg viewBox="0 0 232 80" aria-hidden="true">
  <ellipse class="glow" cx="196" cy="42" rx="30" ry="24" fill="#ffe9a8" opacity=".38"/>
  <text class="ide i1" x="62" y="13" font-size="12">💡</text><text class="ide i2" x="62" y="13" font-size="12">✨</text><text class="ide i3" x="62" y="13" font-size="12">📚</text>
  <rect x="0" y="63" width="232" height="5" rx="2.5" fill="#b98450"/><rect x="6" y="68" width="220" height="3" rx="1.5" fill="#000" opacity=".08"/>
  <path d="M28 63V51a16 16 0 0 1 16-16h12a16 16 0 0 1 16 16V63Z" fill="#c6f04e"/>
  <g class="head"><rect x="45" y="30" width="10" height="9" fill="#e8b48c"/><circle cx="50" cy="22" r="13" fill="#f2c5a0"/>
    <path d="M37 20a13 13 0 0 1 26 0q-5-7-13-6-8-1-13 6z" fill="#2b1f1a"/>
    <path d="M36 21a14 14 0 0 1 28 0" stroke="#1f3a4d" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="36" cy="25" r="4" fill="#1f3a4d"/><circle cx="64" cy="25" r="4" fill="#1f3a4d"/>
    <ellipse class="eye" cx="45" cy="24" rx="2" ry="2.6" fill="#1b2b24"/><ellipse class="eye" cx="55" cy="24" rx="2" ry="2.6" fill="#1b2b24"/>
    <path d="M46 30q4 4 8 0" stroke="#1b2b24" stroke-width="2" fill="none" stroke-linecap="round"/></g>
  <g class="type"><path d="M68 46Q78 58 92 59" stroke="#a9d63a" stroke-width="8" fill="none" stroke-linecap="round"/><circle cx="95" cy="59" r="4.5" fill="#f2c5a0"/></g>
  <rect x="88" y="33" width="46" height="28" rx="3.5" fill="#2a343d"/><rect x="91" y="36" width="40" height="22" rx="2" fill="#143d52"/>
  <rect class="ln l1" x="95" y="40" width="26" height="2.6" rx="1.3" fill="#6fe0c5"/><rect class="ln l2" x="95" y="46" width="32" height="2.6" rx="1.3" fill="#ffd166"/><rect class="ln l3" x="95" y="52" width="20" height="2.6" rx="1.3" fill="#ff8fa3"/>
  <path d="M82 63H140l-4-4H86z" fill="#aeb6bf"/>
  <rect x="152" y="51" width="13" height="12" rx="3" fill="#fff"/><path d="M165 54q6 0 6 5t-6 4" stroke="#fff" stroke-width="2.6" fill="none"/>
  <g class="steam" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"><path d="M155 47q-3-4 0-8"/><path d="M161 47q-3-4 0-8" style="animation-delay:-1.2s"/></g>
  <path d="M180 63V47L194 37" stroke="#2c3a46" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M190 30L205 39 198 45 185 36z" fill="#1f3a4d"/><rect x="174" y="61" width="14" height="3" rx="1.5" fill="#2c3a46"/>
  <path d="M211 63L213 52H225L227 63Z" fill="#c8694a"/>
  <g><ellipse class="leaf" cx="214" cy="46" rx="4" ry="9" fill="#3fae68" transform="rotate(-24 214 52)"/><ellipse class="leaf" cx="219" cy="43" rx="4" ry="10" fill="#4fc27a"/><ellipse class="leaf" cx="224" cy="46" rx="4" ry="9" fill="#3fae68" transform="rotate(24 224 52)"/></g>
</svg>`;
// Bilah atas (area putih): jam berjalan, hitung mundur tenggat terdekat, dan pintasan. Tidak mengulang sapaan, tanggal, atau angka yang sudah ada di Beranda.
let TOPU = null, TOP_DL = null;
function initTop(u) {
  TOPU = u;
  const top = document.querySelector('.top'); if (!top) return;
  if (!document.getElementById('topL')) {
    const el = document.createElement('div'); el.id = 'topL'; el.className = 'topL';
    el.innerHTML = '<div class="tclock" id="tClock"></div>' + (PAGE === 'beranda' ? '<div class="tcd" id="tCd" hidden><span>⏳ Tenggat terdekat</span><b id="tCdv"></b></div>' : '')
      + `<div class="tscene">${SCENE}</div>`;
    top.insertBefore(el, top.firstChild);
    setInterval(tickTop, 1000);
  }
  tickTop();
}
function tickTop() {
  const c = document.getElementById('tClock'); if (!c) return;
  const d = new Date(), z = n => String(n).padStart(2, '0');
  c.innerHTML = `${z(d.getHours())}<i>:</i>${z(d.getMinutes())}<small>:${z(d.getSeconds())}</small>`;
  const box = document.getElementById('tCd'); if (!box) return;
  const diff = TOP_DL ? TOP_DL - Date.now() : 0;
  if (diff <= 0) { box.hidden = true; return; }
  const sec = Math.floor(diff / 1000), dd = Math.floor(sec / 86400);
  document.getElementById('tCdv').textContent = (dd ? dd + ' hari ' : '') + `${z(Math.floor(sec % 86400 / 3600))}:${z(Math.floor(sec % 3600 / 60))}:${z(sec % 60)}`;
  box.hidden = false;
}
// Tenggat terdekat dari tugas/quiz partisipan yang belum selesai
function topInfo() {
  TOP_DL = null; if (!U || isDosen) return;
  let best = null;
  myMk().forEach(m => { const p = P(m.id, U.email); pertOf(m, U.email).forEach(x => {
    const c = [];
    if (x.tugas && !p.sub[x.n] && !p.kembali[x.n]) c.push(x.tugasDl);
    if (adaQuiz(x) && !quizDone(p, x)) c.push(x.quizDl);
    c.forEach(t => { if (t && t > Date.now() && (!best || t < best)) best = t; });
  }); });
  TOP_DL = best; tickTop();
}
// Angka naik dari 0 dan kutipan berganti pelan-pelan saat Beranda tampil
let QT = 0;
function fx() {
  if (!QT) QT = setInterval(() => {
    const q = document.getElementById('hbQuote'); if (!q) return;
    q.classList.add('out');
    setTimeout(() => { const i = (QUOTES.indexOf(q.textContent) + 1) % QUOTES.length; q.textContent = QUOTES[i]; q.classList.remove('out'); }, 450);
  }, 9000);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelectorAll('#view .cnt').forEach(el => {
    const to = parseFloat(el.dataset.to), suf = el.dataset.suf || ''; if (isNaN(to)) return;
    const t0 = performance.now(), dur = 900;
    const step = t => { const k = Math.min(1, (t - t0) / dur); el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))) + suf; if (k < 1 && el.isConnected) requestAnimationFrame(step); };
    el.textContent = '0' + suf; requestAnimationFrame(step);
  });
}

function home() {
  const L = myMk();
  if (isDosen) {
    if (!L.length) return head() + empty('🧑‍🏫', 'Kamu belum membuat pelajaran', 'Buat pelajaran dulu, lalu buat kelas (A, B, C…) dan bagikan kode kelasnya ke partisipan.', btnMk);
    const kls = L.reduce((a, m) => a + m.kelas.length, 0), mhs = L.reduce((a, m) => a + studentsOf(m.id).length, 0);
    const nDinilai = ringkas(U).tiles[5][0], pfD = prefOf(U);
    const hero = head();
    return hero + (nDinilai > 0 && pfD.nl !== false ? `<div class="card absen"><div><b>📝 ${nDinilai} tugas/quiz menunggu penilaian</b><div class="quote">Tekan Lihat untuk melihat pelajaran, kelas, dan pertemuan yang perlu dinilai.</div></div><button class="btn lime" onclick="perluDinilaiModal()">Lihat</button></div>` : '') + `<h2>Ringkasan</h2><div class="grid3">${sc('Pelajaran', L.length, '📚', '#e8f1ff', '', '', '', "go('courses')")}${sc('Total kelas', kls, '🏷️', '#fff0d2', '', '', '', "go('courses')")}${sc('Partisipan bergabung', mhs, '🎒', '#dff5e8', '', '', '', "go('courses')")}</div><h2>Pelajaran</h2>${courseCards(L)}`;
  }
  if (!L.length) return head() + empty('🔑', 'Kamu belum bergabung ke kelas mana pun', 'Minta kode kelas ke pengajarmu, lalu masukkan di sini. Progres, pelajaran, dan tugas akan muncul setelah kamu bergabung.', btnJoin);
  const t = L.reduce((a, m) => { const s2 = stats(m, U.email); ['done', 'todo', 'hadir', 'held', 'lewat', 'tasks', 'todoT', 'todoQ'].forEach(k => a[k] += s2[k]); return a; }, { done: 0, todo: 0, hadir: 0, held: 0, lewat: 0, tasks: 0, todoT: 0, todoQ: 0 });
  const pf = prefOf(U), abs = pf.ab === false ? [] : L.flatMap(m => pertOf(m, U.email).filter(x => absenOpen(x) && !P(m.id, U.email).att[x.n]).map(x => ({ m, x })));
  const todo = [];
  L.forEach(m => { const p = P(m.id, U.email); pertOf(m, U.email).forEach(x => { if (x.tugas && !p.sub[x.n]) todo.push([m, x, p.kembali[x.n] ? 'Dikembalikan' : 'Tugas', p.kembali[x.n] ? null : x.tugasDl]); else if (x.tugas && legacyFile(p.sub[x.n])) todo.push([m, x, 'Kirim ulang', null]); if (adaQuiz(x) && !quizDone(p, x)) todo.push([m, x, 'Quiz', x.quizDl]); }); });
  const pct = t.held ? Math.round(t.hadir / t.held * 100) : 0;
  const hero = head();
  const subTodo = !t.todo ? 'Semua sudah beres 🎉' : t.todoT && t.todoQ ? `${t.todoT} tugas · ${t.todoQ} quiz belum selesai` : t.todoT ? 'Belum dikirim' : 'Belum dikerjakan';
  const subHadir = t.held ? `Hadir ${t.hadir} kali dari ${t.held} pertemuan` + (t.lewat ? ` · <b style="color:var(--red)">terlewat ${t.lewat}</b>` : '') : 'Belum ada pertemuan';
  return hero + abs.map(({ m, x }) => `<div class="card absen"><div><b>Absen dibuka · ${esc(m.nama)}</b><div class="quote">Pertemuan ${x.n}: ${esc(x.topik)} · sisa waktu ${cd(x)}</div></div><button class="btn lime" onclick="absenSendiri('${m.id}',${x.n})">Absen sekarang</button></div>`).join('')
    + soonHtml(todo, pf)
    + `<h2>Progres keseluruhan</h2><div class="grid3">${sc('Tugas yang harus diselesaikan', t.todo, '📝', '#fff0d2', t.todo ? 'var(--red)' : '', subTodo, '', "statDetail('todo')", statPop('todo', 'right'))}${sc('Total tugas selesai', t.done, '✅', '#dff5e8', '', t.tasks ? `dari ${t.tasks} tugas &amp; quiz` : '', '', "statDetail('done')", statPop('done', 'below'))}${sc('Total pertemuan', t.held, miniRing(pct), 'transparent', '', subHadir, 'mr', "statDetail('pert')", statPop('pert', 'left'))}</div>`
    + (todo.length ? `<h2>Perlu dikerjakan</h2>${todo.slice(0, 6).map(([m, x, k, dl]) => `<button class="todo" onclick="bukaItem('${m.id}',${x.n})"><span class="chip ${k === 'Quiz' ? 'c-bl' : k === 'Tugas' ? 'c-iz' : 'c-no'}">${k}</span><span><b>${esc(m.nama)}</b> · Pertemuan ${x.n}: ${esc(x.topik)}</span>${dlChip(dl)}</button>`).join('')}` : '')
    + `<h2>Pelajaran</h2>${courseCards(L)}`;
}
// Detail kartu "Progres keseluruhan": daftar tugas/quiz/pertemuan per pelajaran, tiap baris bisa dibuka langsung
function statRows(kind) {
  const rows = [];
  myMk().forEach(m => { const p = P(m.id, U.email); pertOf(m, U.email).forEach(x => {
    if (kind === 'todo') {
      if (x.tugas && !p.sub[x.n]) rows.push({ m, x, chip: p.kembali[x.n] ? ['Dikembalikan', 'c-no'] : ['Tugas', 'c-iz'], dl: p.kembali[x.n] ? null : x.tugasDl });
      if (adaQuiz(x) && !quizDone(p, x)) rows.push({ m, x, chip: ['Quiz', 'c-bl'], dl: x.quizDl });
    } else if (kind === 'done') {
      const nl = p.nilai[x.n];
      if (x.tugas && p.sub[x.n]) rows.push({ m, x, chip: ['Tugas', 'c-ok'], note: nl ? (nl.skor != null ? 'Nilai ' + nl.skor : 'Sudah dinilai') : 'Menunggu penilaian' });
      if (adaQuiz(x) && quizDone(p, x)) { const qe = p.qext[x.n], kirim = qlOf(x).length && qe && itemsOf(qe).length > 0; rows.push({ m, x, chip: ['Quiz', 'c-ok'], note: kirim ? (qe.nilai ? (qe.nilai.skor != null ? 'Nilai ' + qe.nilai.skor : 'Sudah dinilai') : 'Menunggu penilaian') : 'Selesai' }); }
    } else {
      const a = p.att[x.n];
      rows.push({ m, x, chip: a === 'H' ? ['Hadir', 'c-ok'] : a === 'I' ? ['Izin', 'c-iz'] : a === 'A' ? ['Alpa', 'c-no'] : absenOpen(x) ? ['Absen dibuka', 'c-bl'] : x.absen && x.absen.dur > 0 ? ['Terlewat', 'c-no'] : ['Tanpa absen', 'c-wait'] });
    }
  }); });
  return rows;
}
function statDetail(kind) {
  const ttl = { todo: 'Tugas yang harus diselesaikan', done: 'Total tugas selesai', pert: 'Total pertemuan' }[kind];
  const kosong = { todo: 'Semua sudah beres 🎉', done: 'Belum ada tugas atau quiz yang selesai.', pert: 'Belum ada pertemuan.' }[kind];
  const rows = statRows(kind), by = {};
  rows.forEach(r => (by[r.m.id] = by[r.m.id] || { m: r.m, rows: [] }).rows.push(r));
  const hadir = rows.filter(r => r.chip[0] === 'Hadir').length, lewat = rows.filter(r => r.chip[0] === 'Terlewat').length;
  const ringkas = kind === 'pert' ? `Hadir ${hadir} · Terlewat ${lewat} · Total ${rows.length} pertemuan` : `${rows.length} item`;
  const body = rows.length ? Object.values(by).map(g => `<div class="sdg"><div class="sdh">${esc(g.m.nama)}<span>${g.rows.length}</span></div>${g.rows.map(r => `<button class="todo" onclick="tutupModal();bukaItem('${r.m.id}',${r.x.n})"><span class="chip ${r.chip[1]}">${r.chip[0]}</span><span>Pertemuan ${r.x.n}: ${esc(r.x.topik)}</span>${r.note ? `<span class="quote">${r.note}</span>` : ''}${dlChip(r.dl)}</button>`).join('')}</div>`).join('') : `<div class="quote" style="padding:18px 0">${kosong}</div>`;
  modal(`<h3>${ttl}</h3><div class="quote" style="margin-bottom:12px">${ringkas}${rows.length ? ' · tekan salah satu untuk membukanya' : ''}</div>${body}`);
}
// Isi popover kartu "Progres keseluruhan" (muncul di luar kartu saat di-hover; dir = arah munculnya), klik kartu untuk daftar lengkap
function statPop(kind, dir) {
  const rows = statRows(kind), K = { todo: ['📝', 'Tugas yang harus diselesaikan'], done: ['✅', 'Total tugas selesai'], pert: ['🗓️', 'Total pertemuan'] }[kind];
  const show = kind === 'pert' ? rows.slice(-4) : rows.slice(0, 4), sisa = rows.length - show.length;
  const kosong = { todo: 'Semua sudah beres 🎉', done: 'Belum ada yang selesai.', pert: 'Belum ada pertemuan.' }[kind];
  const hadir = rows.filter(r => r.chip[0] === 'Hadir').length, lewat = rows.filter(r => r.chip[0] === 'Terlewat').length;
  const sub = kind === 'pert' ? `Hadir ${hadir} · terlewat ${lewat} · total ${rows.length}` : `${rows.length} item`;
  return `<div class="hv-src" hidden data-dir="${dir}" data-th="k-${kind}"><div class="hv-head"><span class="hv-ic">${K[0]}</span><div><b>${K[1]}</b><small>${sub}</small></div></div><div class="hv-body">${show.length ? show.map(r => `<div class="hv-row"><span class="chip ${r.chip[1]}">${r.chip[0]}</span><span class="spt"><b>${esc(r.m.nama)}</b> · P${r.x.n}: ${esc(r.x.topik)}</span></div>`).join('') : `<div class="hv-row muted">${kosong}</div>`}</div><div class="hv-foot"><span>${sisa > 0 ? `+${sisa} lainnya` : ''}</span><span>Klik kartu untuk lihat semua ›</span></div></div>`;
}
function bukaItem(mkId, n) { S.view = 'course'; S.cid = mkId; S.open[mkId + '-' + n] = true; render(); window.scrollTo(0, 0); }

// ---------- MATA KULIAH ----------
function coursesPage() {
  const L = myMk();
  const act = isDosen ? '<button class="btn lime" onclick="mkModal()">+ Buat pelajaran</button>' : '<button class="btn lime" onclick="joinModal()">+ Masuk kelas</button>';
  const top = `<section class="pg-hero"><span class="pgd d1" aria-hidden="true">📚</span><span class="pgd d2" aria-hidden="true">✏️</span><span class="pgd d3" aria-hidden="true">🎒</span><div class="pgh-txt"><h1>Pelajaran</h1><p class="quote">${isDosen ? 'Arahkan kursor ke pelajaran untuk memilih kelasnya, atau klik pelajaran untuk melihat informasinya.' : 'Pilih pelajaran untuk melihat absen, tugas, materi, dan quiz.'}</p></div>${act}</section>`;
  if (!L.length) return top + (isDosen ? empty('📚', 'Belum ada pelajaran', 'Buat pelajaran, lalu buat kelas beserta kode kelas untuk dibagikan ke partisipan.', btnMk) : empty('🔑', 'Belum ada pelajaran', 'Masuk kelas dengan kode dari pengajar untuk melihat pelajaranmu.', btnJoin));
  return top + `<div class="pg-tools"><label class="pg-search"><span aria-hidden="true">🔍</span><input id="pSearch" type="search" placeholder="Cari pelajaran…" oninput="filterPelajaran(this.value)" autocomplete="off" aria-label="Cari pelajaran"></label><span class="pg-count" id="pCount">${L.length} pelajaran</span></div>${courseCards(L)}<p class="empty" id="pEmpty" hidden>Tidak ada pelajaran yang cocok.</p>`;
}
function coursePage() {
  const m = getMk(S.cid);
  if (!m || !myMk().some(x => x.id === m.id)) { S.view = 'courses'; return coursesPage(); }
  return isDosen ? courseD(m) : courseM(m);
}

// --- tampilan partisipan (hanya nama pelajaran, bukan nama kelas) ---
function courseM(m) {
  const s2 = stats(m, U.email), p = P(m.id, U.email), pt = pertOf(m, U.email), pct = s2.held ? Math.round(s2.hadir / s2.held * 100) : 0;
  return `<button class="back" onclick="go('courses')"><span class="arr" aria-hidden="true">←</span> Kembali ke Semua pelajaran</button>${hdr(m, hl('Pengajar', esc(m.dosenNama)) + (m.jadwal ? ' <span class="hdot">·</span> ' + hl('Jadwal', esc(cap1(m.jadwal))) : ''))}
  <div class="row" style="margin:-4px 0 16px"><button class="btn ghost dng" onclick="keluarModal('${m.id}')">🚪 Keluar dari pelajaran</button></div>
  <div class="grid4">${kp('Kehadiran', `${s2.hadir}<small>/${s2.held}</small>`, pct + '% hadir')}${kp('Total pertemuan', `${s2.held}<small>/${totalOf(kelasOf(m, U.email))}</small>`)}${kp('Tugas selesai', `${s2.done}<small>/${s2.tasks}</small>`)}${kp('Perlu dikerjakan', `<span style="color:${s2.todo ? 'var(--red)' : 'inherit'}">${s2.todo}</span>`)}</div>
  <h2>Daftar pertemuan</h2>${pt.length ? pt.map(x => meetingM(m, x, p)).join('') : '<p class="empty">Pengajar belum membuka pertemuan.</p>'}`;
}
function meetingM(m, x, p) {
  const k = m.id + '-' + x.n, o = S.open[k], a = p.att[x.n], op = absenOpen(x);
  const lbl = { H: ['c-ok', 'Hadir'], I: ['c-iz', 'Izin'], A: ['c-no', 'Alpa'] };
  const bd = a ? `<span class="chip ${lbl[a][0]}">${lbl[a][1]}</span>` : op ? '<span class="chip c-iz">Absen dibuka</span>' : '<span class="chip c-wait">Belum diabsen</span>';
  const tag = [matOf(x).length ? 'Materi' : '', x.tugas ? 'Tugas' + (p.sub[x.n] ? ' ✓' : '') : '', adaQuiz(x) ? 'Quiz' + (quizDone(p, x) ? ' ✓' : '') : ''].filter(Boolean).join(' · ') || 'Tanpa materi/tugas/quiz';
  let body = '';
  if (o) {
    const ab = a ? `Status absenmu: <b>${lbl[a][1]}</b>` : op ? `<div class="row"><span>Sisa waktu absen: <b>${cd(x)}</b></span><button class="btn lime" onclick="absenSendiri('${m.id}',${x.n})">Absen sekarang</button></div>`
      : `<span class="empty">${x.absen && x.absen.dur > 0 ? 'Batas waktu absen sudah lewat. Hubungi pengajar jika perlu diabsen.' : 'Absensi diisi oleh pengajar.'}</span>`;
    body = `<div class="body"><div class="blk"><h4>Absensi</h4>${ab}</div><div class="blk"><h4>Materi</h4>${x.materiDesc ? `<div class="bsub">Deskripsi materi</div><p class="bdesc">${esc(x.materiDesc)}</p>` : ''}${matOf(x).length ? lampList(matOf(x), 'mat', m.id, x.n) : '<span class="empty">Pengajar belum membagikan materi.</span>'}</div>`;
    // pembatas: Absensi dan Materi hanya dilihat, Tugas dan Quiz adalah bagian yang dikerjakan/dikirim partisipan
    if (x.tugas || adaQuiz(x)) body += '<div class="bsep"><span>Perlu dikerjakan</span></div>';
    if (x.tugas) {
      const f = p.sub[x.n], nl = p.nilai[x.n], kb = p.kembali[x.n], lg = legacyFile(f), late = over(x.tugasDl) && !lg && !kb;
      const upload = draftUI(m, x, 't', f || kb ? 'Kirim ulang tugas' : 'Kirim tugas');
      const nilaiHtml = nl && nl.manual ? '<div class="nilai">✅ Ditandai selesai oleh pengajar</div>' : nl ? `<div class="nilai">✅ Sudah dinilai${nl.skor != null ? ` · Nilai <b>${nl.skor}</b>` : ''}${nl.cat ? `<div class="quote">Catatan pengajar: ${esc(nl.cat)}</div>` : ''}</div>` : '<div class="quote" style="margin-top:6px">Menunggu penilaian pengajar.</div>';
      body += `<div class="blk"><h4>Tugas ${dlChip(x.tugasDl)}</h4><div class="bsub">Deskripsi tugas</div><p class="bdesc">${esc(x.tugas)}</p>`
        + (tlOf(x).length ? `<div class="bsub">Instruksi tugas</div>${lampList(tlOf(x), 'tl', m.id, x.n)}<div style="height:8px"></div>` : '')
        + (f
          ? `<div class="row"><span class="chip c-ok">Terkirim</span><span style="font-size:13px">${subAt(f) ? fmtDt(subAt(f)) : ''}</span>${lg || nl || late ? '' : `<button class="btn ghost" onclick="unsend('${m.id}',${x.n})">Kirim ulang</button>`}</div>`
            + (itemsOf(f).length ? `<div class="ditems">${lampList(itemsOf(f), 'sub', m.id, x.n)}</div>` : `<div class="quote">${esc(subName(f))}</div>`)
            + (lg ? '<div class="warnbox">⚠️ Berkas yang kamu kirim sebelumnya tidak tersimpan, jadi pengajar tidak bisa membukanya. Kirim ulang berkasnya (nilai yang sudah ada tetap dipertahankan).</div>' : '')
            + nilaiHtml + (lg ? upload : '')
          : (kb ? `<div class="warnbox">↩️ <b>Tugas dikembalikan pengajar</b> untuk diperbaiki${kb.lama ? ' (berkas sebelumnya: ' + esc(kb.lama) + ')' : ''}.${kb.cat ? `<div class="quote">Catatan pengajar: ${esc(kb.cat)}</div>` : ''}</div>` : '') + (late ? '<span class="empty">Batas waktu pengumpulan sudah lewat. Hubungi pengajar jika perlu.</span>' : upload)) + '</div>';
    }
    if (adaQuiz(x)) {
      const late = over(x.quizDl), sq = p.quiz[x.n], qe0 = p.qext[x.n], qe = qeOk(qe0) ? qe0 : null, qkb = qe0 && qe0.kembali;
      let q = `<div class="blk"><h4>Quiz ${dlChip(x.quizDl)}</h4>${x.quizDesc ? `<div class="bsub">Deskripsi quiz</div><p class="bdesc">${esc(x.quizDesc)}</p>` : ''}`;
      if (x.quiz.length) q += `<div class="row">${sq != null ? `<span class="chip c-bl">Nilai ${sq}</span>${late ? '' : `<button class="btn ghost" onclick="quiz('${m.id}',${x.n})">Kerjakan ulang</button>`}` : late ? '<span class="empty">Batas waktu quiz sudah lewat.</span>' : `<span>Quiz soal dari pengajar (${x.quiz.length} soal).</span><button class="btn lime" onclick="quiz('${m.id}',${x.n})">Kerjakan quiz</button>`}</div>`;
      if (qlOf(x).length) {
        q += `<div class="bsub" style="margin-top:${x.quiz.length ? 10 : 0}px">Instruksi quiz</div>${lampList(qlOf(x), 'ql', m.id, x.n)}`;
        if (qkb) q += `<div class="warnbox">↩️ <b>Hasil quiz dikembalikan pengajar</b> untuk diperbaiki.${qkb.cat ? `<div class="quote">Catatan pengajar: ${esc(qkb.cat)}</div>` : ''}</div>`;
        if (qe) q += `<div class="row" style="margin-top:8px"><span class="chip c-ok">Selesai</span><span style="font-size:13px">${(qe.items || []).length ? 'Hasil dikirim ' : qe.oleh ? 'Ditandai selesai oleh pengajar ' : 'Ditandai selesai '}${fmtDt(qe.at)}</span>${late || qe.nilai || qe.oleh ? '' : `<button class="btn ghost sm" onclick="batalQext('${m.id}',${x.n})">Batalkan</button>`}</div>${(qe.items || []).length ? `<div class="ditems">${lampList(qe.items, 'qx', m.id, x.n)}</div>` : ''}${(qe.items || []).length ? (qe.nilai ? `<div class="nilai">✅ Sudah dinilai${qe.nilai.skor != null ? ` · Nilai <b>${qe.nilai.skor}</b>` : ''}${qe.nilai.cat ? `<div class="quote">Catatan pengajar: ${esc(qe.nilai.cat)}</div>` : ''}</div>` : '<div class="quote" style="margin-top:6px">Menunggu penilaian pengajar.</div>') : ''}`;
        else if (late) q += '<div class="empty">Batas waktu quiz sudah lewat.</div>';
        else q += `<div class="row" style="margin-top:10px"><button class="btn lime" onclick="tandaiQuiz('${m.id}',${x.n})">✓ Tandai selesai</button><span class="quote">atau kirim hasil pengerjaanmu seperti tugas:</span></div>${draftUI(m, x, 'q', 'Kirim hasil quiz')}`;
      }
      body += q + '</div>';
    }
    body += '</div>';
  }
  return `<div class="mt"><button aria-expanded="${!!o}" onclick="tog('${k}')"><div class="n">${x.n}</div><div class="t">${esc(x.topik)}<small>${tag}</small></div>${bd}</button>${body}</div>`;
}
function tog(k) { S.open[k] = !S.open[k]; render(); }
function absenSendiri(mkId, n) {
  const x = pertAt(mkId, n);
  if (!x || !myMk().some(q => q.id === mkId)) return;
  if (!absenOpen(x)) { toast('Batas waktu absen sudah lewat'); render(); return; }
  const p = P(mkId, U.email);
  if (p.att[n]) { toast('Absenmu sudah tercatat'); return; }
  p.att[n] = 'H'; setP(mkId, U.email, p); toast('Absen berhasil ✅'); render();
}
// Lampiran disimpan lengkap (isi berkas) agar pengajar bisa membukanya
async function addFiles(d, files) {
  let msg = '';
  for (const f of files) {
    if (d.length >= MAX_LAMP) { msg = 'Maksimal ' + MAX_LAMP + ' lampiran.'; break; }
    if (f.size > MAXB) { msg = f.name + ' lebih dari 1,5 MB.'; continue; }
    if (d.reduce((a, it) => a + (it.size || 0), 0) + f.size > MAX_TOTAL) { msg = 'Total ukuran lampiran maksimal 3 MB.'; continue; }
    if (d.some(it => it.tipe === 'file' && it.nama === f.name && it.size === f.size)) { msg = f.name + ' sudah ditambahkan.'; continue; }
    d.push({ tipe: 'file', nama: f.name, size: f.size, file: f });   // diunggah ke Supabase Storage saat dikirim/disimpan
  }
  return msg;
}
function addLink(d, v) {
  if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(v)) return 'Masukkan link yang valid, diawali http:// atau https://';
  if (d.length >= MAX_LAMP) return 'Maksimal ' + MAX_LAMP + ' lampiran.';
  if (d.some(it => it.tipe === 'link' && it.url === v)) return 'Link ini sudah ditambahkan.';
  d.push({ tipe: 'link', url: v }); return '';
}
async function tambahFile(mkId, n, t) {
  const k = dkey(mkId, n, t), inp = document.getElementById('fd-' + k);
  if (!inp || !inp.files || !inp.files.length) return;
  const msg = await addFiles(S.draft[k] = S.draft[k] || [], [...inp.files]);
  inp.value = ''; if (msg) toast(msg); render();
}
function tambahLink(mkId, n, t) {
  const k = dkey(mkId, n, t), inp = document.getElementById('ld-' + k); if (!inp) return;
  const msg = addLink(S.draft[k] = S.draft[k] || [], inp.value.trim());
  if (msg) { toast(msg); return; }
  inp.value = ''; S.dLink = null; render();
}
function hapusDraft(mkId, n, t, i) { const d = S.draft[dkey(mkId, n, t)]; if (d) d.splice(i, 1); render(); }
// Berkas disimpan di Supabase Storage (bucket "lampiran"); di database hanya tersimpan nama, ukuran, dan path-nya.
const FILEC = {};
const safeName = n => String(n).normalize('NFKD').replace(/[^\w.\-]+/g, '_').slice(-80) || 'berkas';
async function upItems(list, prefix) {
  const out = [];
  for (const it of list) {
    if (it.tipe === 'link') { out.push({ tipe: 'link', url: it.url }); continue; }
    if (!it.path) {
      if (!it.file) continue;
      const path = prefix + '/' + uid('f') + '-' + safeName(it.nama);
      const { error } = await sb.storage.from(BUCKET).upload(path, it.file, { contentType: it.file.type || 'application/octet-stream' });
      if (error) throw error;
      it.path = path;   // tersimpan di draft supaya tidak diunggah ulang bila pengiriman diulang
    }
    out.push({ tipe: 'file', nama: it.nama, size: it.size, path: it.path });
  }
  return out;
}
// Ambil isi berkas dari Storage (di-cache) dan tempelkan sebagai data URL agar fungsi pratinjau/unduh tetap bisa dipakai.
async function withData(it) {
  if (!it || it.tipe === 'link' || it.data || !it.path) return it;
  if (!FILEC[it.path]) {
    const { data, error } = await sb.storage.from(BUCKET).download(it.path);
    if (error) throw error;
    FILEC[it.path] = await readFile(data);
  }
  return { ...it, data: FILEC[it.path] };
}
let BUSY = false;
async function send(mkId, n, t) {
  if (BUSY) return;
  S.dMenu = null; S.dLink = null;
  const x = pertAt(mkId, n); if (!x) return;
  const k = dkey(mkId, n, t), d = S.draft[k] || [];
  if (!d.length) { toast('Tambahkan minimal satu file atau link dulu'); return; }
  if (t === 'q') { if (over(x.quizDl)) { toast('Batas waktu quiz sudah lewat'); render(); return; } }
  else { const p0 = P(mkId, U.email); if (over(x.tugasDl) && !legacyFile(p0.sub[n]) && !p0.kembali[n]) { toast('Batas waktu pengumpulan sudah lewat'); render(); return; } }
  let items;
  BUSY = true;
  try { toast('Mengirim…'); items = await upItems(d, mkId + '/u/' + U.uid); }
  catch (e) { toast('Gagal mengunggah berkas: ' + ((e && e.message) || e)); return; }
  finally { BUSY = false; }
  const p = P(mkId, U.email);
  if (t === 'q') p.qext[n] = { at: Date.now(), items };
  else {
    const a = items[0];
    p.sub[n] = { nama: (a.tipe === 'link' ? a.url : a.nama) + (items.length > 1 ? ' (+' + (items.length - 1) + ' lainnya)' : ''), at: Date.now(), items };
    delete p.kembali[n];
  }
  setP(mkId, U.email, p);
  S.draft[k] = []; toast(t === 'q' ? 'Hasil quiz terkirim' : 'Tugas terkirim'); render();
}
// Quiz berupa link/file: partisipan cukup menandai selesai
function tandaiQuiz(mkId, n) {
  const x = pertAt(mkId, n); if (!x) return;
  if (over(x.quizDl)) { toast('Batas waktu quiz sudah lewat'); render(); return; }
  const p = P(mkId, U.email); p.qext[n] = { at: Date.now(), items: [] }; setP(mkId, U.email, p); toast('Quiz ditandai selesai ✅'); render();
}
function batalQext(mkId, n) {
  const x = pertAt(mkId, n); if (x && over(x.quizDl)) { toast('Batas waktu sudah lewat'); return; }
  const p = P(mkId, U.email); if (p.qext[n] && p.qext[n].nilai) { toast('Quiz sudah dinilai, tidak bisa dibatalkan'); return; } delete p.qext[n]; setP(mkId, U.email, p); render();
}
function unsend(mkId, n) {
  const x = pertAt(mkId, n), p = P(mkId, U.email);
  if (x && over(x.tugasDl)) { toast('Batas waktu sudah lewat'); return; }
  if (p.nilai[n]) { toast('Tugas sudah dinilai, tidak bisa dikirim ulang'); return; }
  delete p.sub[n]; setP(mkId, U.email, p); render();
}
function quiz(mkId, n) {
  const x = pertAt(mkId, n);
  if (!x) return;
  if (over(x.quizDl)) { toast('Batas waktu quiz sudah lewat'); render(); return; }
  modal(`<h3>Quiz: ${esc(x.topik)}</h3><div class="quote">Pilih satu jawaban per soal. ${x.quizDl ? 'Batas: ' + fmtDt(x.quizDl) : ''}</div>
  ${x.quiz.map((q, i) => `<div class="q"><p>${i + 1}. ${esc(q.q)}</p>${q.o.map((o, j) => `<label><input type="radio" name="q${i}" value="${j}"> ${esc(o)}</label>`).join('')}</div>`).join('')}
  <div class="row"><button class="btn lime" onclick="grade('${mkId}',${n})">Kirim jawaban</button><button class="btn ghost" onclick="tutupModal()">Batal</button></div>`);
}
function grade(mkId, n) {
  const x = pertAt(mkId, n); if (!x) return;
  if (over(x.quizDl)) { toast('Batas waktu quiz sudah lewat'); tutupModal(); render(); return; }
  const qs = x.quiz; let ok = 0, miss = false;
  qs.forEach((q, i) => { const r = document.querySelector(`input[name=q${i}]:checked`); if (!r) { miss = true; return; } if (+r.value === q.a) ok++; });
  if (miss) { toast('Jawab semua soal dulu'); return; }
  const sc2 = Math.round(ok / qs.length * 100), p = P(mkId, U.email); p.quiz[n] = sc2; p.qt[n] = Date.now(); setP(mkId, U.email, p);
  qs.forEach((q, i) => document.querySelectorAll(`input[name=q${i}]`).forEach(r => { const l = r.parentElement; r.disabled = true; if (+r.value === q.a) l.classList.add('ok'); else if (r.checked) l.classList.add('bad'); }));
  document.querySelector('.sheet .row').innerHTML = `<span class="chip c-bl">Nilai kamu: ${sc2}</span><button class="btn" onclick="tutupModal();render()">Selesai</button>`;
}

// --- tampilan pengajar: pelajaran -> daftar kelas ---
function courseD(m) {
  const cards = m.kelas.map(k => {
    const n = studentsOf(m.id, k.id).length;
    return `<button class="course" onclick="bukaKelas('${k.id}')"><div class="hd"><div class="ic" style="background:var(--limeS);font-weight:800">${esc(k.nama.trim().slice(-1).toUpperCase())}</div><div><b>${esc(k.nama)}</b><span class="s">${n} partisipan</span></div><span class="code-pill" style="margin-left:auto">${esc(k.kode)}</span></div><div class="bar"><i style="width:${Math.min(100, k.pert.length / totalOf(k) * 100)}%"></i></div><div class="meta"><span>Pertemuan ${k.pert.length}/${totalOf(k)}</span><span>Buka kelas →</span></div></button>`;
  }).join('');
  return `<button class="back" onclick="go('courses')"><span class="arr" aria-hidden="true">←</span> Kembali ke Semua pelajaran</button>${hdr(m, m.jadwal ? hl('Jadwal', esc(cap1(m.jadwal))) : 'Pelajaran saya')}
  <div class="row" style="margin:-4px 0 16px"><button class="btn ghost" onclick="mkModal('${m.id}')">✏️ Ubah pelajaran</button><button class="btn ghost dng" onclick="hapusMkModal('${m.id}')">🗑 Hapus pelajaran</button></div>
  <div class="grid3">${kp('Kelas', m.kelas.length)}${kp('Partisipan bergabung', studentsOf(m.id).length)}${kp('Pertemuan berjalan', totalPert(m), 'total dari semua kelas')}</div>
  <h2>Kelas</h2>${cards ? `<div class="courses">${cards}</div>` : '<p class="empty">Belum ada kelas. Buat kelas pertama di bawah.</p>'}
  <div class="card" style="margin-top:16px"><b>Buat kelas baru</b><p class="quote">Contoh: nama "Kelas A", kode "PBO-A". Kode inilah yang diberikan ke partisipan. Jumlah pertemuan ditentukan olehmu (1–${MAXP}).</p>
  <div class="two" style="margin-top:10px"><label class="f">Nama kelas<input id="kNama" placeholder="Kelas A" maxlength="30"></label>
  <label class="f">Kode kelas<span class="row" style="flex-wrap:nowrap"><input id="kKode" placeholder="PBO-A" maxlength="16" style="text-transform:uppercase"><button type="button" class="btn ghost" onclick="acak('${m.id}')">Acak</button></span></label></div>
  <label class="f" style="margin-top:10px;max-width:260px">Jumlah pertemuan<input id="kTotal" type="number" min="1" max="${MAXP}" step="1" value="${TOTAL}" inputmode="numeric"></label>
  <p class="err" id="kErr" role="alert"></p><button class="btn lime" style="margin-top:8px" onclick="addKelas('${m.id}')">Tambah kelas</button></div>`;
}
function bukaKelas(kid) { S.view = 'kelas'; S.kid = kid; S.edit = null; S.pfKey = null; S.delMode = false; render(); window.scrollTo(0, 0); }
function bukaPert() { S.view = 'pert'; S.pTab = 'pertemuan'; S.edit = null; S.pfKey = null; S.delMode = false; render(); window.scrollTo(0, 0); }
async function kodeDipakai(kode, kelasId, e) {
  const { data, error } = await sb.rpc('kode_dipakai', { p_kode: kode, p_kelas_id: kelasId });
  if (error) { e.textContent = 'Gagal memeriksa kode: ' + error.message; return true; }
  if (data) { e.textContent = 'Kode ini sudah dipakai kelas lain. Pilih kode yang berbeda.'; return true; }
  return false;
}
function acak(mkId) {
  const m = getMk(mkId);
  const ini = (m.kode || m.nama.split(/\s+/).map(w => w[0]).join('')).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) || 'KLS';
  const l = ($('#kNama').value.trim().slice(-1) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  $('#kKode').value = `${ini}-${l}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}
async function addKelas(mkId) {
  const nama = $('#kNama').value.trim(), kode = $('#kKode').value.trim().toUpperCase(), e = $('#kErr');
  if (!nama) { e.textContent = 'Nama kelas wajib diisi.'; return; }
  if (!/^[A-Z0-9-]{4,16}$/.test(kode)) { e.textContent = 'Kode kelas 4–16 karakter: huruf, angka, atau tanda hubung.'; return; }
  const total = cekTotal($('#kTotal').value);
  if (!total) { e.textContent = 'Jumlah pertemuan harus bilangan bulat 1–' + MAXP + '.'; return; }
  if (await kodeDipakai(kode, null, e)) return;
  const m = getMk(mkId); m.kelas.push({ id: uid('k'), nama, kode, total, pert: [] });
  if (!saveMk(m)) { e.textContent = 'Gagal menyimpan data.'; return; }
  render(); toast('Kelas dibuat (' + total + ' pertemuan). Kode: ' + kode);
}
function salin(kode) {
  try { navigator.clipboard.writeText(kode).then(() => toast('Kode disalin: ' + kode), () => toast('Kode kelas: ' + kode)); } catch (e) { toast('Kode kelas: ' + kode); }
}

// --- tampilan pengajar: satu kelas (kode, jumlah partisipan, pertemuan berjalan) ---
function ctxKelas() {
  const m = getMk(S.cid), k = getKelas(m, S.kid);
  return isDosen && m && k && m.dosen === U.email ? { m, k } : null;
}
// Ringkasan satu partisipan di sebuah kelas: absen, tugas, dan quiz dari seluruh pertemuan
function ringkasMhs(m, k, u) {
  const p = P(m.id, u.email), r = { p, n: k.pert.length, hadir: 0, tN: 0, tD: 0, qN: 0, qD: 0 };
  k.pert.forEach(x => {
    if (p.att[x.n] === 'H') r.hadir++;
    if (x.tugas) { r.tN++; if (p.sub[x.n]) r.tD++; }
    if (adaQuiz(x)) { r.qN++; if (quizDone(p, x)) r.qD++; }
  });
  return r;
}
// Rincian per pertemuan untuk tombol Absen (t='a'), Tugas ('t'), atau Quiz ('q')
function mhList(k, p, t) {
  const lbl = { H: ['c-ok', 'Hadir'], I: ['c-iz', 'Izin'], A: ['c-no', 'Alpa'] };
  const row = (x, chip) => `<div class="mh-row"><span class="mh-n">${x.n}</span><span class="mh-t">${esc(x.topik)}</span>${chip}</div>`;
  if (t === 'a') return k.pert.map(x => { const a = p.att[x.n]; return row(x, a ? `<span class="chip ${lbl[a][0]}">${lbl[a][1]}</span>` : '<span class="chip c-wait">Belum diabsen</span>'); }).join('') || '<div class="mh-empty">Belum ada pertemuan di kelas ini.</div>';
  if (t === 't') return k.pert.filter(x => x.tugas).map(x => { const f = p.sub[x.n], nl = p.nilai[x.n]; return row(x, nl ? `<span class="chip c-ok">Dinilai${nl.skor != null ? ' · ' + nl.skor : ''}</span>` : f ? '<span class="chip c-iz">Terkirim · perlu dinilai</span>' : p.kembali[x.n] ? '<span class="chip c-iz">Dikembalikan</span>' : '<span class="chip c-wait">Belum dikirim</span>'); }).join('') || '<div class="mh-empty">Belum ada tugas yang dibuat.</div>';
  return k.pert.filter(adaQuiz).map(x => row(x, quizDone(p, x) ? `<span class="chip c-bl">${x.quiz.length && p.quiz[x.n] != null ? 'Nilai ' + p.quiz[x.n] : 'Selesai'}</span>` : '<span class="chip c-wait">Belum dikerjakan</span>')).join('') || '<div class="mh-empty">Belum ada quiz yang dibuat.</div>';
}
function tabMhs(key, t) { S.open[key] = S.open[key] === t ? '' : t; render(); }
function partisipanCard(m, k, u, i) {
  const r = ringkasMhs(m, k, u), key = 'prt-' + k.id + '-' + String(u.email).replace(/[^\w@.\-]/g, '_'), tab = S.open[key] || '';
  const tb = (t, l, d, n) => `<button class="btn ghost sm mh-tab${tab === t ? ' on' : ''}" aria-expanded="${tab === t}" onclick="tabMhs('${key}','${t}')">${l} <b>${d}/${n}</b></button>`;
  return `<div class="mh-card"><div class="mh-head"><div class="mh-av" aria-hidden="true">${esc((u.nama || '?').trim().charAt(0).toUpperCase())}</div><div class="mh-info"><b>${esc(u.nama)}</b><span>${esc(u.id)} · ${esc(u.email)}</span></div><button class="btn ghost sm dng" onclick="keluarkanModal(${i})">Keluarkan</button></div>
  <div class="mh-tabs">${tb('a', 'Absen', r.hadir, r.n)}${tb('t', 'Tugas', r.tD, r.tN)}${tb('q', 'Quiz', r.qD, r.qN)}</div>${tab ? `<div class="mh-panel">${mhList(k, r.p, tab)}</div>` : ''}</div>`;
}
let KEL = '';   // email partisipan yang akan dikeluarkan
function keluarkanModal(i) {
  const c = ctxKelas(); if (!c) return; const { m, k } = c, u = studentsOf(m.id, k.id)[i]; if (!u) return;
  KEL = u.email;
  const p = P(m.id, u.email), nA = Object.keys(p.att).length, nT = Object.keys(p.sub).length, nQ = Object.keys(p.quiz).length + Object.keys(p.qext).length;
  modal(`<h3>Keluarkan “${esc(u.nama)}” dari kelas ${esc(k.nama)}?</h3><div class="warnbox" ${merah}>Data belajar partisipan ini di pelajaran akan <b>dihapus</b> dan tidak bisa dikembalikan.</div>
  <ul class="dampak"><li>${nA} catatan absen, ${nT} tugas yang sudah dikirim beserta nilainya, dan ${nQ} hasil quiz ikut terhapus.</li>
  <li>Partisipan bisa bergabung lagi dengan kode kelas <b>${esc(k.kode)}</b>, tetapi data lama tidak kembali.</li></ul>
  <div class="row" style="margin-top:14px"><button class="btn ghost" onclick="tutupModal()">Batal</button><button class="btn red" onclick="keluarkanMhs()">Ya, keluarkan</button></div>`);
}
function keluarkanMhs() {
  const c = ctxKelas(); if (!c || !KEL) return; const { m, k } = c, u = studentsOf(m.id, k.id).find(q => q.email === KEL);
  if (!u) { KEL = ''; tutupModal(); return; }
  st.setJn(st.jn().filter(j => !(j.mkId === m.id && j.mhs === u.email)));
  const pr = st.pr(); if (pr[m.id]) delete pr[m.id][u.email]; st.setPr(pr);
  KEL = ''; tutupModal(); render(); toast(u.nama + ' dikeluarkan dari kelas');
}
function kelasPage() {
  const c = ctxKelas(); if (!c) { S.view = 'courses'; return coursesPage(); }
  const { m, k } = c, ss = studentsOf(m.id, k.id);
  return `<button class="back" onclick="go('course','${m.id}')"><span class="arr" aria-hidden="true">←</span> Kembali ke ${esc(m.nama)}</button>${hdr(m, hl('Kelas', esc(k.nama)))}
  <div class="row" style="margin:-4px 0 16px"><button class="btn ghost" onclick="kelasModal()">✏️ Ubah kelas</button><button class="btn ghost dng" onclick="hapusKelasModal()">🗑 Hapus kelas</button></div>
  <div class="grid3"><div class="card kp"><div class="l">Kode kelas</div><div style="margin:8px 0"><span class="code-pill big">${esc(k.kode)}</span></div><button class="btn ghost" onclick="salin('${esc(k.kode)}')">Salin kode</button></div>
  ${kp('Partisipan bergabung', ss.length)}${kp('Pertemuan berjalan', `${k.pert.length}<small>/${totalOf(k)}</small>`)}</div>
  <div class="row" style="margin-top:18px"><button class="btn lime" onclick="bukaPert()">Info selengkapnya →</button><span class="quote">Atur materi, tugas, quiz, dan absensi untuk ${esc(k.nama)}.</span></div>
  <h2>Partisipan (${ss.length})</h2>${ss.length ? ss.map((u, i) => partisipanCard(m, k, u, i)).join('') : '<div class="card"><span class="empty">Belum ada partisipan yang bergabung. Bagikan kode kelas di atas.</span></div>'}`;
}

// --- tampilan pengajar: pertemuan sebuah kelas ---
const qzText = qz => qz.map(q => [q.q, ...q.o, q.a + 1].join(' | ')).join('\n');
// Penyusun lampiran di form pengajar (materi, instruksi tugas, instruksi quiz). Disimpan di S.pf agar tidak hilang saat tampilan diperbarui.
const ALB = { mat: 'Materi', tl: 'Lampiran instruksi tugas', ql: 'Link / file untuk quiz' };
function pfInit(k, e) {
  const key = (e ? 'e' + e.n : 'n' + k.pert.length) + ':' + k.id;
  if (S.pfKey !== key) { S.pfKey = key; S.pfMenu = null; S.pfLink = null; S.pf = { mat: e ? matOf(e).slice() : [], tl: e ? tlOf(e).slice() : [], ql: e ? qlOf(e).slice() : [] }; }
}
function lampEditorInner(kind) {
  const d = S.pf[kind], tot = d.reduce((a, it) => a + (it.size || 0), 0), penuh = d.length >= MAX_LAMP, menu = S.pfMenu === kind, linkOpen = S.pfLink === kind;
  // Tombol "Tambah lampiran" membuka pilihan File atau Link (bukan lagi kolom unggah dan kolom link yang selalu tampil)
  const tambah = penuh ? '<div class="quote">Batas 5 lampiran tercapai. Hapus salah satu untuk menambah yang lain.</div>'
    : `<div class="addwrap"><button type="button" class="addbtn" aria-haspopup="menu" aria-expanded="${menu}" onclick="pfMenu('${kind}')"><span class="addplus" aria-hidden="true">＋</span>Tambah lampiran<span class="addcar" aria-hidden="true">▾</span></button>${menu ? `<div class="addmenu" role="menu"><button type="button" role="menuitem" class="addopt" onclick="pfPilihFile('${kind}')"><span class="addic" aria-hidden="true">📎</span><span><b>File</b><small>Unggah dari perangkat · maks. 1,5 MB</small></span></button><button type="button" role="menuitem" class="addopt" onclick="pfPilihLink('${kind}')"><span class="addic" aria-hidden="true">🔗</span><span><b>Link</b><small>Google Drive, YouTube, Google Form, dll.</small></span></button></div>` : ''}</div>
    <input type="file" multiple hidden id="pf-f-${kind}" aria-label="Pilih file" onchange="pfFile('${kind}')">
    ${linkOpen ? `<div class="row addlink"><input class="lnk" id="pf-l-${kind}" placeholder="https://… (tempel link di sini)" aria-label="Link" onkeydown="if(event.key==='Enter'){event.preventDefault();pfLink('${kind}')}"><button type="button" class="btn ghost sm" onclick="pfLink('${kind}')">+ Tambah link</button><button type="button" class="btn ghost sm" onclick="pfPilihLink('')">Batal</button></div>` : ''}`;
  return `<div class="quote"><b>${ALB[kind]}</b> · ${d.length}/${MAX_LAMP} (file atau link)${d.length ? ' · ' + sizeTxt(tot) : ''}</div>
    ${d.map((it, i) => lampRow(it, `<button type="button" class="btn ghost sm dng" onclick="pfHapus('${kind}',${i})" aria-label="Hapus lampiran ${i + 1}">✕ Hapus</button>`)).join('')}
    ${tambah}
    <div class="quote">Maksimal ${MAX_LAMP} lampiran (file atau link). Tiap file maks. 1,5 MB, total maks. 3 MB.</div>`;
}
const lampEditor = kind => `<div class="draft" id="ed-${kind}">${lampEditorInner(kind)}</div>`;
const pfRefresh = kind => { const e = document.getElementById('ed-' + kind); if (e) e.innerHTML = lampEditorInner(kind); };
async function pfFile(kind) {
  const inp = document.getElementById('pf-f-' + kind); if (!inp || !inp.files || !inp.files.length || !S.pf) return;
  const msg = await addFiles(S.pf[kind], [...inp.files]); inp.value = ''; if (msg) toast(msg); pfRefresh(kind);
}
function pfLink(kind) {
  const inp = document.getElementById('pf-l-' + kind); if (!inp || !S.pf) return;
  const msg = addLink(S.pf[kind], inp.value.trim()); if (msg) { toast(msg); return; } inp.value = ''; S.pfLink = null; pfRefresh(kind);
}
function pfMenu(kind) { const prev = S.pfMenu; S.pfMenu = prev === kind ? null : kind; if (prev && prev !== kind) pfRefresh(prev); pfRefresh(kind); }
function pfPilihFile(kind) { S.pfMenu = null; pfRefresh(kind); const i = document.getElementById('pf-f-' + kind); if (i) i.click(); }
function pfPilihLink(kind) {
  const prev = S.pfLink; S.pfMenu = null; S.pfLink = kind || null;
  if (prev) pfRefresh(prev);
  if (kind) { pfRefresh(kind); const i = document.getElementById('pf-l-' + kind); if (i) i.focus(); }
}
function pfHapus(kind, i) { if (S.pf) S.pf[kind].splice(i, 1); pfRefresh(kind); }

function pTab(t) { S.pTab = t; S.delMode = false; S.edit = null; S.pfKey = null; S.kQ = ''; S.kN = ''; S.kJ = ''; S.kLim = KPAGE; render(); }
// Tab Pengumpulan: dua tab ringkas (Belum dinilai, Sudah dinilai) selalu terlihat di atas, lengkap dengan
// pencarian partisipan, filter jenis (tugas/quiz), filter pertemuan, dan daftar yang dibatasi per 10 baris.
// Setiap baris diberi label jenisnya. Tugas dan quiz berupa file/link dinilai pengajar; quiz yang hanya ditandai selesai langsung "Selesai".
const KPAGE = 10;
function kumpulItems(m, k, ss) {
  const items = [];
  k.pert.forEach(x => ss.forEach(u => {
    const p = P(m.id, u.email);
    if (x.tugas && p.sub[x.n]) items.push({ x, u, jenis: 'tugas', f: p.sub[x.n], nl: p.nilai[x.n], gr: !p.sub[x.n].manual });
    if (qlOf(x).length) { const qe = p.qext[x.n]; if (qeOk(qe)) items.push({ x, u, jenis: 'quiz', f: qe, nl: qe.nilai, gr: itemsOf(qe).length > 0 }); }
    if (x.quiz.length && p.quiz[x.n] != null) items.push({ x, u, jenis: 'quiz', f: { at: p.qt[x.n] }, nl: null, gr: false, skor: p.quiz[x.n] });
  }));
  return items;
}
// butuh dinilai = ada berkas yang dikirim tapi belum diberi nilai. Quiz yang hanya ditandai selesai tidak perlu dinilai.
const kmpSudah = i => !i.gr || !!i.nl;
// Partisipan yang belum mengirim tugas / belum menyelesaikan quiz (termasuk yang dikembalikan)
function kumpulBelumKirim(m, k, ss) {
  const out = [];
  k.pert.forEach(x => ss.forEach(u => {
    const p = P(m.id, u.email);
    if (x.tugas && !p.sub[x.n]) out.push({ x, u, jenis: 'tugas', kb: !!p.kembali[x.n], bisa: true });
    if (adaQuiz(x) && !quizDone(p, x)) out.push({ x, u, jenis: 'quiz', kb: !!(p.qext[x.n] && p.qext[x.n].kembali), bisa: qlOf(x).length > 0 && !qeOk(p.qext[x.n]) });
  }));
  return out;
}
// Gabungkan tugas & quiz yang belum selesai milik partisipan yang sama di pertemuan yang sama menjadi satu baris
function gabungBelum(list) {
  const g = {};
  list.forEach(i => { const key = i.x.n + '|' + i.u.email; (g[key] = g[key] || { x: i.x, u: i.u, list: [] }).list.push(i); });
  return Object.values(g).sort((a, b) => a.x.n - b.x.n || a.u.nama.localeCompare(b.u.nama));
}
// Tombol "Berikan selesai": kalau hanya satu yang bisa diselesaikan langsung konfirmasi, kalau tugas DAN quiz tampilkan pilihan
// Beranda pengajar: daftar tugas / quiz yang menunggu penilaian di semua pelajaran, kelas, dan pertemuan.
// Tugas dan quiz dipisah (tiap baris satu jenis). "Berikan penilaian" langsung membuka Pengumpulan > Belum dinilai.
function perluDinilaiModal() {
  if (!isDosen) return;
  const list = [];
  st.mk().filter(m => m.dosen === U.email).forEach(m => m.kelas.forEach(k => {
    const n = kumpulItems(m, k, studentsOf(m.id, k.id)).filter(i => i.gr && !i.nl).length;
    if (n) list.push({ m, k, n });
  }));
  list.sort((a, b) => a.m.nama.localeCompare(b.m.nama) || a.k.nama.localeCompare(b.k.nama));
  const row = r => `<div class="pt-row"><div class="pt-who" style="flex:1 1 auto"><b style="font-size:18px;font-weight:800;color:var(--tx);line-height:1.25">${esc(r.m.nama)}</b><span style="color:#4a6356;font-weight:700;font-size:13px;margin-top:2px">Kelas ${esc(r.k.nama)}</span></div><span class="chip c-iz">${r.n} perlu dinilai</span><button class="btn lime sm" onclick="nilaiDariBeranda('${esc(r.m.id)}','${esc(r.k.id)}')">Berikan penilaian</button></div>`;
  modal(`<h3>Menunggu penilaian</h3><div class="quote">Tugas dan quiz dari partisipan yang belum kamu nilai.</div><div style="margin-top:12px">${list.map(row).join('') || '<div class="pt-empty">Tidak ada tugas atau quiz yang menunggu penilaian 🎉</div>'}</div><div class="row" style="margin-top:14px"><button class="btn ghost" onclick="tutupModal()">Tutup</button></div>`);
}
function nilaiDariBeranda(mkId, kid) {
  tutupModal();
  S.view = 'pert'; S.cid = mkId; S.kid = kid; S.edit = null; S.pfKey = null; S.delMode = false;
  S.pTab = 'pengumpulan'; S.kTab = 'belum'; S.kJ = ''; S.kN = ''; S.kQ = ''; S.kLim = KPAGE;
  render(); window.scrollTo(0, 0);
}
function berikanPilih(n, em) {
  const c = ctxKelas(); if (!c) return;
  const g = gabungBelum(kumpulBelumKirim(c.m, c.k, studentsOf(c.m.id, c.k.id)).filter(i => i.x.n === n && i.u.email === em && i.bisa))[0];
  if (!g) { toast('Tidak ada yang perlu diselesaikan'); return; }
  if (g.list.length === 1) { berikanSelesai(n, em, g.list[0].jenis); return; }
  const opt = i => `<button type="button" class="addopt" style="border:1px solid var(--bd);margin-top:8px" onclick="tutupModal();berikanSelesai(${n},'${esc(em)}','${i.jenis}')"><span class="addic" aria-hidden="true">${i.jenis === 'tugas' ? '📝' : '🧠'}</span><span><b>${i.jenis === 'tugas' ? 'Tugas' : 'Quiz'}</b><small>${i.jenis === 'tugas' ? (i.kb ? 'Dikembalikan, belum dikirim ulang' : 'Belum dikirim') : (i.kb ? 'Dikembalikan, belum dikirim ulang' : 'Belum selesai')}</small></span></button>`;
  modal(`<h3>Berikan selesai</h3><div class="quote">${esc(g.u.nama)} · ${esc(g.u.id)} · Pertemuan ${n}</div><p style="margin:12px 0 0">Pilih yang mau ditandai selesai:</p>${g.list.map(opt).join('')}<div class="row" style="margin-top:14px"><button class="btn ghost" onclick="tutupModal()">Batal</button></div>`);
}
// Pengajar membatalkan status "selesai" yang dulu ia berikan sendiri (bukan yang ditandai partisipan)
function batalSelesai(n, i, jenis) {
  const c = ctxKelas(); if (!c || !KUM[i]) return;
  const em = KUM[i], u = Auth.find(em), p = P(c.m.id, em), nama = u ? u.nama : 'partisipan';
  if (jenis === 'tugas') { if (!(p.sub[n] && p.sub[n].manual)) { toast('Tugas ini bukan ditandai oleh pengajar'); return; } }
  else if (!(p.qext[n] && p.qext[n].oleh)) { toast('Quiz ini bukan ditandai oleh pengajar'); return; }
  if (!confirm('Batalkan status selesai ' + jenis + ' milik ' + nama + '?\nStatusnya kembali menjadi belum dikirim.')) return;
  if (jenis === 'tugas') { delete p.sub[n]; delete p.nilai[n]; } else delete p.qext[n];
  setP(c.m.id, em, p); tutupModal(); toast('Status selesai dibatalkan untuk ' + nama); render();
}
function berikanSelesai(n, em, jenis) {
  const c = ctxKelas(); if (!c) return;
  const u = Auth.find(em), x = c.k.pert.find(q => q.n === n); if (!u || !x) return;
  const p = P(c.m.id, em);
  if (!confirm('Tandai ' + jenis + ' Pertemuan ' + n + ' milik ' + u.nama + ' sebagai selesai?\nPartisipan akan melihat statusnya selesai tanpa berkas.')) return;
  const now = Date.now();
  if (jenis === 'tugas') {
    if (p.sub[n]) { toast('Tugas sudah dikirim'); return; }
    p.sub[n] = { nama: 'Ditandai selesai oleh pengajar', at: now, items: [], manual: true };
    p.nilai[n] = { skor: null, cat: '', at: now, manual: true };
    delete p.kembali[n];
  } else {
    if (qeOk(p.qext[n])) { toast('Quiz sudah selesai'); return; }
    p.qext[n] = { at: now, items: [], oleh: 'pengajar' };
  }
  setP(c.m.id, em, p); toast('Ditandai selesai untuk ' + u.nama); render();
}
function kumpulList(m, k, ss) {
  const q = (S.kQ || '').trim().toLowerCase(), nf = S.kN ? +S.kN : 0, jf = S.kJ || '', lim = S.kLim || KPAGE, filt = !!(q || nf || jf);
  const at = i => subAt(i.f) || 0, items = kumpulItems(m, k, ss);
  const row = it => {
    const status = it.gr ? (it.nl ? `<span class="chip c-ok">Dinilai${it.nl.skor != null ? ' · ' + it.nl.skor : ''}</span>` : '<span class="chip c-iz">Perlu dinilai</span>')
      : `<span class="chip c-ok">Selesai${it.skor != null ? ' · ' + it.skor : ''}</span>`;
    const lbl = it.jenis === 'tugas' ? '<span class="chip c-tg">Tugas</span>' : '<span class="chip c-bl">Quiz</span>';
    const ket = it.gr ? (it.nl ? 'Lihat' : 'Nilai') : 'Lihat';
    return `<div class="pt-row"><div class="pt-who"><b>${esc(it.u.nama)}</b><span>${esc(it.u.id)}</span></div><div class="pt-what"><b>Pertemuan ${it.x.n}</b><span>${esc(it.x.topik)}${at(it) ? ' · ' + (it.gr ? 'dikirim ' : 'selesai ') + fmtDt(at(it)) : ''}</span></div>${lbl}${status}<button class="btn ${it.gr && !it.nl ? 'lime' : 'ghost'} sm" onclick="kumpulModal(${it.x.n},'${it.jenis}','${esc(it.u.email)}')">${ket}</button></div>`;
  };
  const lblOf = j => j === 'tugas' ? '<span class="chip c-tg">Tugas</span>' : '<span class="chip c-bl">Quiz</span>';
  const rowKirim = g => `<div class="pt-row"><div class="pt-who"><b>${esc(g.u.nama)}</b><span>${esc(g.u.id)}</span></div><div class="pt-what"><b>Pertemuan ${g.x.n}</b><span>${esc(g.x.topik)}</span></div><span class="kmp-chips">${g.list.map(it => `<span class="kmp-pair">${lblOf(it.jenis)}<span class="chip c-wait">${it.kb ? 'Dikembalikan' : it.jenis === 'tugas' ? 'Belum dikirim' : 'Belum selesai'}</span></span>`).join('')}</span>${g.list.some(i => i.bisa) ? `<button class="btn lime sm" onclick="berikanPilih(${g.x.n},'${esc(g.u.email)}')">Berikan selesai</button>` : ''}</div>`;
  const statusOf = it => it.gr ? (it.nl ? `<span class="chip c-ok">Dinilai${it.nl.skor != null ? ' · ' + it.nl.skor : ''}</span>` : '<span class="chip c-iz">Perlu dinilai</span>') : `<span class="chip c-ok">Selesai${it.skor != null ? ' · ' + it.skor : ''}</span>`;
  const rowSudah = g => `<div class="pt-row"><div class="pt-who"><b>${esc(g.u.nama)}</b><span>${esc(g.u.id)}</span></div><div class="pt-what"><b>Pertemuan ${g.x.n}</b><span>${esc(g.x.topik)}</span></div><span class="kmp-chips">${g.list.map(it => `<span class="kmp-pair">${lblOf(it.jenis)}${statusOf(it)}</span>`).join('')}</span><button class="btn ghost sm" onclick="kumpulModal(${g.x.n},'${[...new Set(g.list.map(i => i.jenis))].join(',')}','${esc(g.u.email)}')">Lihat</button></div>`;
  const sudahItems = () => items.filter(i => kmpSudah(i) && (!jf || i.jenis === jf) && (!nf || i.x.n === nf) && (!q || `${i.u.nama} ${i.u.id} ${i.x.topik} ${i.jenis}`.toLowerCase().includes(q)));
  const kirimItems = () => kumpulBelumKirim(m, k, ss).filter(i => (!jf || i.jenis === jf) && (!nf || i.x.n === nf) && (!q || `${i.u.nama} ${i.u.id} ${i.x.topik} ${i.jenis}`.toLowerCase().includes(q)));
  const rowsFor = tab => {
    if (tab === 'kirim') return gabungBelum(kirimItems()).map(rowKirim);
    if (tab === 'sudah') {
      const g = {};
      sudahItems().forEach(i => { const key = i.x.n + '|' + i.u.email; (g[key] = g[key] || { x: i.x, u: i.u, list: [], t: 0 }).list.push(i); g[key].t = Math.max(g[key].t, at(i)); });
      return Object.values(g).sort((a2, b2) => b2.t - a2.t).map(rowSudah);
    }
    const belum = true;
    return items.filter(i => belum === !kmpSudah(i) && (!jf || i.jenis === jf) && (!nf || i.x.n === nf) && (!q || `${i.u.nama} ${i.u.id} ${i.x.topik} ${i.jenis}`.toLowerCase().includes(q)))
      .sort(belum ? (a2, b2) => at(a2) - at(b2) : (a2, b2) => at(b2) - at(a2)).map(row);
  };
  const rows = rowsFor(S.kTab);
  const kosong = filt ? 'Tidak ada yang cocok di tab ini.' : S.kTab === 'kirim' ? 'Semua partisipan sudah mengirim 🎉' : S.kTab === 'belum' ? 'Tidak ada tugas atau quiz yang menunggu penilaian 🎉' : 'Belum ada tugas atau quiz yang selesai dinilai.';
  // saat mencari/memfilter: tunjukkan juga tab lain yang punya hasil, supaya tidak mengira datanya tidak ada
  const lain = filt ? [['belum', 'Belum dinilai'], ['sudah', 'Sudah dinilai'], ['kirim', 'Belum dikirim']].filter(([id]) => id !== S.kTab).map(([id, l]) => [id, l, id === 'kirim' ? kirimItems().length : id === 'sudah' ? sudahItems().length : rowsFor(id).length]).filter(x => x[2]) : [];
  const hint = lain.length ? `<div class="kmp-hint">Ada juga di: ${lain.map(([id, l, n]) => `<button type="button" onclick="kmpTab('${id}')">${l} (${n})</button>`).join('')}</div>` : '';
  const shown = rows.slice(0, lim), sisa = rows.length - shown.length;
  return `<div class="kmp-sum">Menampilkan ${shown.length} dari ${rows.length}${filt ? ' hasil pencarian' : ''}${S.kTab === 'belum' ? ' · yang paling lama menunggu di atas' : ''}${S.kTab === 'kirim' ? ' · diurutkan per pertemuan' : ''}</div>${hint}${shown.join('') || `<div class="pt-empty">${kosong}</div>`}${sisa > 0 ? `<button class="btn ghost kmp-more" onclick="kmpMore()">Tampilkan ${Math.min(KPAGE, sisa)} lagi · sisa ${sisa}</button>` : ''}`;
}
function kumpulTab(m, k, ss) {
  const tg = k.pert.filter(x => x.tugas), qz = k.pert.filter(adaQuiz);
  if (!tg.length && !qz.length) return '<p class="empty" style="margin-top:16px">Belum ada pertemuan yang memiliki tugas atau quiz.</p>';
  const items = kumpulItems(m, k, ss), nSudah = items.filter(kmpSudah).length, nBelum = items.length - nSudah;
  const nKirim = kumpulBelumKirim(m, k, ss).length;
  if (!['belum', 'sudah', 'kirim'].includes(S.kTab)) S.kTab = nBelum ? 'belum' : nSudah ? 'sudah' : nKirim ? 'kirim' : 'belum';
  const T = [['belum', '📝', 'Belum dinilai', nBelum], ['sudah', '✅', 'Sudah dinilai', nSudah], ['kirim', '⏳', 'Belum dikirim', nKirim]];
  const tabs = `<div class="kmp" role="tablist">${T.map(([id, ic, l, n]) => `<button type="button" role="tab" aria-selected="${S.kTab === id}" data-t="${id}" class="kmp-t${S.kTab === id ? ' on' : ''}${id === 'belum' && n ? ' hot' : ''}" onclick="kmpTab('${id}')"><i aria-hidden="true">${ic}</i><span><b>${n}</b>${l}</span></button>`).join('')}</div>`;
  const opts = k.pert.filter(x => x.tugas || adaQuiz(x)).map(x => `<option value="${x.n}"${+S.kN === x.n ? ' selected' : ''}>Pertemuan ${x.n} · ${esc(x.topik.length > 28 ? x.topik.slice(0, 27) + '…' : x.topik)}</option>`).join('');
  const jopt = [['', 'Semua jenis'], ['tugas', 'Tugas'], ['quiz', 'Quiz']].map(([v, l]) => `<option value="${v}"${(S.kJ || '') === v ? ' selected' : ''}>${l}</option>`).join('');
  const bar = `<div class="kmp-bar"><label class="pg-search"><span aria-hidden="true">🔍</span><input id="kmpQ" type="search" placeholder="Cari nama, ID, atau pembahasan…" value="${esc(S.kQ || '')}" oninput="kmpQ(this.value)" autocomplete="off" aria-label="Cari di pengumpulan"></label><select id="kmpJ" onchange="kmpJ(this.value)" aria-label="Filter jenis">${jopt}</select><select id="kmpN" onchange="kmpN(this.value)" aria-label="Filter pertemuan"><option value="">Semua pertemuan</option>${opts}</select></div>`;
  return `<div class="kmp-sticky">${tabs}${bar}</div><div id="kList">${kumpulList(m, k, ss)}</div>`;
}
function kmpApply() { const c = ctxKelas(), box = document.getElementById('kList'); if (c && box) box.innerHTML = kumpulList(c.m, c.k, studentsOf(c.m.id, c.k.id)); }
function kmpTab(t) {
  S.kTab = t; S.kLim = KPAGE;
  document.querySelectorAll('.kmp-t').forEach(b => { const on = b.dataset.t === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  kmpApply();
}
function kmpQ(v) { S.kQ = v; S.kLim = KPAGE; kmpApply(); }
function kmpN(v) { S.kN = v; S.kLim = KPAGE; kmpApply(); }
function kmpJ(v) { S.kJ = v; S.kLim = KPAGE; kmpApply(); }
function kmpMore() { S.kLim = (S.kLim || KPAGE) + KPAGE; kmpApply(); }
// Tab Absensi: pilih pertemuan, lalu partisipan yang belum absen di atas dan yang sudah absen di bawahnya
function pilihAbsen(n) { S.absN = n; render(); }
function setAbsenMhs(n, i, v) {
  const c = ctxKelas(); if (!c) return; const { m, k } = c, u = studentsOf(m.id, k.id)[i]; if (!u) return;
  const p = P(m.id, u.email); if (v) p.att[n] = v; else delete p.att[n]; setP(m.id, u.email, p);
  toast(`${u.nama}: ${{ H: 'Hadir', I: 'Izin', A: 'Alpa' }[v] || 'Belum diabsen'}`); render();
}
function absenTab(m, k, ss) {
  if (!k.pert.length) return '<p class="empty" style="margin-top:16px">Belum ada pertemuan. Buat pertemuan di tab Pertemuan.</p>';
  if (!k.pert.some(q => q.n === S.absN)) S.absN = k.pert[k.pert.length - 1].n;
  const n = S.absN, x = k.pert.find(q => q.n === n);
  const info = x.absen && x.absen.dur > 0 ? (absenOpen(x) ? `Absen mandiri dibuka · sisa ${cd(x)}` : `Absen mandiri ditutup (${x.absen.dur} mnt)`) : 'Tanpa absen mandiri';
  const pick = `<div class="pt-pick"><span class="pt-lbl">Pertemuan</span>${k.pert.map(q => `<button type="button" class="pt-chip${q.n === n ? ' on' : ''}" title="${esc(q.topik)}" aria-pressed="${q.n === n}" onclick="pilihAbsen(${q.n})">${q.n}</button>`).join('')}</div><div class="quote" style="margin-top:2px"><b>${esc(x.topik)}</b> · ${info}</div>`;
  if (!ss.length) return pick + '<p class="empty" style="margin-top:12px">Belum ada partisipan yang bergabung.</p>';
  const opt = [['', 'Belum diabsen'], ['H', 'Hadir'], ['I', 'Izin'], ['A', 'Alpa']], cls = { H: 'c-ok', I: 'c-iz', A: 'c-no' }, nm = { H: 'Hadir', I: 'Izin', A: 'Alpa' };
  const all = ss.map((u, i) => ({ u, i, cur: P(m.id, u.email).att[n] || '' }));
  const row = r => `<div class="pt-row"><div class="pt-who"><b>${esc(r.u.nama)}</b><span>${esc(r.u.id)}</span></div>${r.cur ? `<span class="chip ${cls[r.cur]}">${nm[r.cur]}</span>` : ''}<select class="pt-sel" onchange="setAbsenMhs(${n},${r.i},this.value)" aria-label="Absensi ${esc(r.u.nama)}">${opt.map(([v, l]) => `<option value="${v}"${r.cur === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`;
  const belum = all.filter(r => !r.cur), sudah = all.filter(r => r.cur);
  return pick + `<h2>Partisipan yang belum absen (${belum.length})</h2>${belum.map(row).join('') || '<div class="pt-empty">Semua partisipan sudah absen 🎉</div>'}<h2>Partisipan yang sudah absen (${sudah.length})</h2>${sudah.map(row).join('') || '<div class="pt-empty">Belum ada partisipan yang absen.</div>'}`;
}
function pertPage() {
  const c = ctxKelas(); if (!c) { S.view = 'courses'; return coursesPage(); }
  const { m, k } = c, ss = studentsOf(m.id, k.id), e = S.edit ? k.pert.find(x => x.n === S.edit) : null, dm = !!S.delMode && !e;
  if (!dm) { S.selMode = false; S.delSel = []; }
  S.delSel = (S.delSel || []).filter(n => k.pert.some(x => x.n === n));
  const sm = dm && !!S.selMode;
  const list = k.pert.map((x, idx) => {
    const ab = x.absen && x.absen.dur > 0 ? (absenOpen(x) ? `Absen dibuka · sisa ${cd(x)}` : `Absen mandiri ditutup (${x.absen.dur} mnt)`) : 'Tanpa absen mandiri';
    const kt = x.tugas ? `Tugas ${ss.filter(u => P(m.id, u.email).sub[x.n]).length}/${ss.length} terkumpul` : '', kq = adaQuiz(x) ? `Quiz ${ss.filter(u => quizDone(P(m.id, u.email), x)).length}/${ss.length} selesai` : '';
    return `<div class="mt${sm && S.delSel.includes(x.n) ? ' picked' : ''}"><div class="prow">${dm ? `<button type="button" class="delx${sm ? ' sel' : ''}${sm && S.delSel.includes(x.n) ? ' on' : ''}" data-n="${x.n}" style="--i:${idx}" onclick="delxTap(${x.n})" aria-label="${sm ? 'Pilih' : 'Hapus'} pertemuan ${x.n}" title="${sm ? 'Pilih' : 'Hapus'} pertemuan ${x.n}"><i class="dx" aria-hidden="true">✕</i><svg class="dk" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg></button>` : ''}<div class="n">${x.n}</div><div class="t">${esc(x.topik)}<small>${[ab, matOf(x).length ? 'Materi ' + matOf(x).length : '', kt, kq].filter(Boolean).join(' · ')}</small></div><button class="btn ghost" onclick="editPert(${x.n})">Edit</button></div></div>`;
  }).join('') || '<p class="empty">Belum ada pertemuan. Tambahkan pertemuan pertama di bawah.</p>';
  // Tombol hapus ikut di dalam kotak daftar pertemuan: "Hapus pertemuan sebelumnya" -> muncul ✕ di tiap nomor + tombol "Batal"
  const foot = k.pert.length && !e ? `<div class="pfoot">${pfootInner(dm, sm, S.delSel.length)}</div>` : '';
  const box = `<div class="card plist${dm ? ' dm' : ''}">${list}${foot}</div>`;
  const tab = S.pTab || 'pertemuan';
  const nBelum = kumpulItems(m, k, ss).filter(i => i.gr && !i.nl).length;
  const tabs = `<div class="pt-tabs" role="tablist">${[['pertemuan', 'Pertemuan'], ['pengumpulan', 'Pengumpulan'], ['absensi', 'Absensi']].map(([id, l]) => `<button type="button" role="tab" aria-selected="${tab === id}" class="pt-tab${tab === id ? ' on' : ''}" onclick="pTab('${id}')">${l}${id === 'pengumpulan' && nBelum ? `<span class="pt-bdg" title="${nBelum} tugas perlu dinilai">${nBelum}</span>` : ''}</button>`).join('')}</div>`;
  const top = `<button class="back" onclick="bukaKelas('${k.id}')"><span class="arr" aria-hidden="true">←</span> Kembali ke ${esc(k.nama)}</button>${hdr(m, hl('Kelas', esc(k.nama)))}${tabs}`;
  if (tab === 'pengumpulan') return top + kumpulTab(m, k, ss);
  if (tab === 'absensi') return top + absenTab(m, k, ss);
  const head2 = top + '<h2>Daftar pertemuan</h2>';
  if (!e && k.pert.length >= totalOf(k)) return head2 + box + `<div class="warnbox" style="margin-top:14px;padding:14px 16px;display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;font-size:14.5px"><div style="flex:1 1 260px"><b style="font-size:16px">📌 Semua ${totalOf(k)} pertemuan kelas ini sudah dibuat</b><div style="margin-top:3px">Perlu menambah pertemuan? Naikkan jumlah pertemuan lewat tombol <b>Ubah kelas</b>.</div></div><button type="button" class="btn lime" onclick="kelasModal()">✏️ Ubah kelas</button></div>`;
  pfInit(k, e);
  const v = e || { topik: '', tugas: '', quiz: [], tugasDl: null, quizDl: null }, dur = e ? (e.absen ? e.absen.dur : 0) : 5;
  const adaQ = e ? adaQuiz(e) : false, tg = box2 => `onchange="document.getElementById('${box2}').hidden=!this.checked"`;
  const dlBox = (chk, box2, inp, ts) => `<label class="chk"><input type="checkbox" id="${chk}" ${ts ? 'checked' : ''} ${tg(box2)}> Pakai batas waktu</label><div id="${box2}" ${ts ? '' : 'hidden'}><label class="f">Batas (tanggal & jam)<input type="datetime-local" id="${inp}" value="${ts ? localIn(ts) : ''}"></label></div>`;
  return head2 + box + `<h2>${e ? 'Edit pertemuan' : 'Tambah pertemuan'}</h2><div class="card" id="pForm"><b>${e ? 'Pertemuan ' + e.n : 'Selanjutnya pertemuan ' + (k.pert.length + 1)}</b>
  <div class="fg" style="margin-top:10px"><label class="f">Judul pembahasan<input id="pTopik" maxlength="80" value="${esc(v.topik)}"></label>
  <label class="f">Atur berapa menit batas absen (isi 0 jika pengajar yang mengabsen)<input id="pDur" type="number" min="0" max="180" value="${dur}"></label>
  ${e ? '<label class="chk"><input type="checkbox" id="pReopen"> Buka ulang absen sekarang (hitung mundur mulai dari sekarang)</label>' : ''}
  <div class="quote" style="margin:4px 0 0"><b>Opsi pertemuan</b> (centang yang dipakai)</div>
  <label class="chk"><input type="checkbox" id="uMateri" ${S.pf.mat.length ? 'checked' : ''} ${tg('bMateri')}> Materi (maks. 5 file atau link)</label>
  <div id="bMateri" class="blk" ${S.pf.mat.length ? '' : 'hidden'}><div class="fg"><label class="f">Deskripsi materi<textarea id="pMatDesc" rows="2" maxlength="300">${esc(v.materiDesc || '')}</textarea></label>${lampEditor('mat')}</div></div>
  <label class="chk"><input type="checkbox" id="uTugas" ${v.tugas ? 'checked' : ''} ${tg('bTugas')}> Tugas (muncul di partisipan sebagai tugas yang harus diselesaikan)</label>
  <div id="bTugas" class="blk" ${v.tugas ? '' : 'hidden'}><div class="fg"><label class="f">Deskripsi tugas<textarea id="pTugas" rows="2" maxlength="300">${esc(v.tugas)}</textarea></label>
  ${lampEditor('tl')}${dlBox('uTgDl', 'bTgDl', 'pTgDl', v.tugasDl)}</div></div>
  <label class="chk"><input type="checkbox" id="uQuiz" ${adaQ ? 'checked' : ''} ${tg('bQuiz')}> Quiz (muncul di partisipan sebagai quiz yang perlu dikerjakan)</label>
  <div id="bQuiz" class="blk" ${adaQ ? '' : 'hidden'}><div class="fg"><div class="quote">Quiz berupa <b>link atau file</b> (mis. Google Form atau berkas soal). Partisipan bisa menandai selesai atau mengirim hasil pengerjaannya.</div>
  <label class="f">Deskripsi quiz<textarea id="pQuizDesc" rows="2" maxlength="300">${esc(v.quizDesc || '')}</textarea></label>
  ${lampEditor('ql')}${dlBox('uQzDl', 'bQzDl', 'pQzDl', v.quizDl)}</div></div>
  <p class="err" id="pErr" role="alert"></p>
  <div class="row"><button class="btn lime" onclick="savePert()">${e ? 'Simpan perubahan' : 'Tambah pertemuan'}</button>${e ? '<button class="btn ghost" onclick="S.edit=null;S.pfKey=null;render()">Batal</button>' : ''}</div></div></div>`;
}
function parseQuiz(txt) {
  const out = [], lines = txt.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const p = lines[i].split('|').map(s2 => s2.trim());
    const a = parseInt(p[p.length - 1], 10), o = p.slice(1, -1);
    if (p.length < 4 || !p[0] || o.length < 2 || o.length > 5 || o.some(x => !x) || !(a >= 1 && a <= o.length))
      return `Format quiz di baris ${i + 1} belum benar. Contoh: Soal | Opsi A | Opsi B | 1`;
    out.push({ q: p[0], o, a: a - 1 });
  }
  return out;
}
function editPert(n) { S.edit = n; S.pTab = 'pertemuan'; render(); const f = document.getElementById('pForm'); if (f && f.scrollIntoView) f.scrollIntoView({ behavior: 'smooth' }); }
async function savePert() {
  if (BUSY) return; BUSY = true;
  try { await savePert0(); } finally { BUSY = false; }
}
async function savePert0() {
  const c = ctxKelas(); if (!c || !S.pf) return;
  const { m, k } = c, e = $('#pErr'), old = S.edit ? k.pert.find(x => x.n === S.edit) : null, topik = $('#pTopik').value.trim();
  const fail = t => { e.textContent = t; };
  if (!topik) return fail('Judul pembahasan wajib diisi.');
  const dur = parseInt($('#pDur').value, 10);
  if (!(dur >= 0 && dur <= 180)) return fail('Batas absen harus 0–180 menit.');
  let tugas = '', qz = [], materi = [], materiDesc = '', quizDesc = '', tugasLamp = [], quizLamp = [], tugasDl = null, quizDl = null;
  const dl = (chk, inp, prev, nama) => {
    if (!$(chk).checked) return null;
    const t = new Date($(inp).value).getTime();
    if (!(t > 0)) throw new Error('Isi tanggal & jam batas waktu ' + nama + '.');
    if (t !== prev && t <= Date.now()) throw new Error('Batas waktu ' + nama + ' harus di masa depan.');
    return t;
  };
  try {
    if ($('#uMateri').checked) { materi = S.pf.mat.slice(); materiDesc = $('#pMatDesc').value.trim(); if (!materi.length) return fail('Tambahkan minimal satu materi (file atau link), atau hilangkan centang Materi.'); }
    if ($('#uTugas').checked) {
      tugas = $('#pTugas').value.trim(); if (!tugas) return fail('Isi deskripsi tugas, atau hilangkan centang Tugas.');
      tugasLamp = S.pf.tl.slice(); tugasDl = dl('#uTgDl', '#pTgDl', old && old.tugasDl, 'tugas');
    }
    if ($('#uQuiz').checked) {
      qz = old && old.quiz ? old.quiz : [];   // soal pilihan ganda lama (jika ada) tetap dipertahankan
      quizLamp = S.pf.ql.slice(); quizDesc = $('#pQuizDesc').value.trim();
      if (!qz.length && !quizLamp.length) return fail('Tambahkan link atau file quiz, atau hilangkan centang Quiz.');
      quizDl = dl('#uQzDl', '#pQzDl', old && old.quizDl, 'quiz');
    }
  } catch (err) { return fail(err.message); }
  try {
    materi = await upItems(materi, m.id + '/materi'); tugasLamp = await upItems(tugasLamp, m.id + '/materi'); quizLamp = await upItems(quizLamp, m.id + '/materi');
  } catch (err) { return fail('Gagal mengunggah berkas: ' + ((err && err.message) || err)); }
  const reopen = old ? $('#pReopen').checked : true;
  const absen = { dur, start: old && old.absen && !reopen ? old.absen.start : Date.now() };
  const data = { topik, tugas, tugasLamp, tugasDl, quiz: qz, quizLamp, quizDl, materi, materiDesc, quizDesc, absen };
  if (old) { Object.assign(old, data); delete old.tugasFile; } else k.pert.push({ n: k.pert.length + 1, ...data });
  if (!saveMk(m)) return fail('Gagal menyimpan data.');
  const msg = old ? 'Pertemuan ' + old.n + ' diperbarui' : 'Pertemuan ' + k.pert.length + ' ditambahkan';
  S.edit = null; S.pfKey = null; S.pf = null; render(); toast(msg);
}
function modeHapus(on) { S.delMode = !!on; S.selMode = false; S.delSel = []; render(); }
// Isi footer daftar pertemuan: (1) Hapus pertemuan sebelumnya -> (2) Pilih + Batal -> (3) Hapus (n) + Batal
function pfootInner(dm, sm, n) {
  if (!dm) return '<button class="btn red" onclick="modeHapus(true)">Hapus pertemuan sebelumnya</button>';
  if (!sm) return '<button class="btn lime" onclick="modePilih()">Pilih</button><button class="btn ghost" onclick="modeHapus(false)">Batal</button><span class="quote" style="margin:0">Tekan ✕ untuk menghapus satu pertemuan, atau tekan Pilih untuk memilih banyak.</span>';
  return `<button class="btn red" id="btnHapusSel" onclick="hapusBanyakModal()" ${n ? '' : 'disabled'}>Hapus${n ? ' (' + n + ')' : ''}</button><button class="btn ghost" onclick="modeHapus(false)">Batal</button><button class="btn ghost" id="btnPilihSemua" onclick="pilihSemua()">${selTotal() && n >= selTotal() ? 'Batal pilih semua' : 'Pilih semua'}</button><span class="quote" style="margin:0" id="selInfo">${n ? n + ' pertemuan dipilih.' : 'Tekan kotak di samping nomor untuk memilih.'}</span>`;
}
function modePilih() {
  S.selMode = true; S.delSel = [];
  const box = document.querySelector('.plist'); if (!box) { render(); return; }
  // tanpa render ulang supaya ✕ berubah mulus menjadi kotak ceklis
  const f = box.querySelector('.pfoot'); if (f) f.innerHTML = pfootInner(true, true, 0);
  box.querySelectorAll('.delx').forEach((b, i) => {
    b.style.setProperty('--i', i); b.classList.add('sel');
    b.setAttribute('aria-label', 'Pilih pertemuan ' + b.dataset.n); b.title = 'Pilih pertemuan ' + b.dataset.n;
  });
}
function delxTap(n) { if (S.selMode) togglePilih(n); else hapusPertModal(n); }
function selTotal() { const c = ctxKelas(); return c ? c.k.pert.length : 0; }
function selUI() {
  const s = S.delSel || [], tot = selTotal();
  document.querySelectorAll('.plist .delx').forEach(b => {
    const on = s.includes(+b.dataset.n); b.classList.toggle('on', on);
    const r = b.closest('.mt'); if (r) r.classList.toggle('picked', on);
  });
  const h = document.getElementById('btnHapusSel'); if (h) { h.disabled = !s.length; h.textContent = 'Hapus' + (s.length ? ' (' + s.length + ')' : ''); }
  const t = document.getElementById('selInfo'); if (t) t.textContent = s.length ? s.length + ' pertemuan dipilih.' : 'Tekan kotak di samping nomor untuk memilih.';
  const p = document.getElementById('btnPilihSemua'); if (p) p.textContent = tot && s.length >= tot ? 'Batal pilih semua' : 'Pilih semua';
}
function togglePilih(n) {
  const s = S.delSel || (S.delSel = []), i = s.indexOf(n);
  if (i >= 0) s.splice(i, 1); else s.push(n);
  selUI();
}
function pilihSemua() {
  const c = ctxKelas(); if (!c) return; const all = c.k.pert.map(x => x.n);
  S.delSel = (S.delSel || []).length >= all.length ? [] : all.slice();
  selUI();
}
function hapusBanyakModal() {
  const c = ctxKelas(); if (!c) return; const { m, k } = c, sel = (S.delSel || []).slice().sort((a, b) => a - b);
  if (!sel.length) return;
  if (sel.length === 1) { hapusPertModal(sel[0]); return; }
  const jml = studentsOf(m.id, k.id).length, sisa = k.pert.length - sel.length;
  modal(`<h3>⚠️ Hapus ${sel.length} pertemuan?</h3><div class="quote">${esc(k.nama)}</div><div class="warnbox" ${merah}>Tindakan ini <b>tidak bisa dibatalkan</b>.</div>
  <ul class="dampak">${sel.map(n => `<li><b>Pertemuan ${n}</b> · ${esc((k.pert.find(q => q.n === n) || {}).topik || '')}</li>`).join('')}
  <li>Materi, tugas, dan quiz di pertemuan tersebut ikut terhapus.</li>
  <li>Absen, tugas yang dikirim, nilai, dan hasil quiz <b>${jml} partisipan</b> di pertemuan tersebut ikut terhapus.</li>
  ${sisa ? `<li>Pertemuan yang tersisa (${sisa}) otomatis diurutkan ulang nomornya.</li>` : ''}</ul>
  <div class="row" style="margin-top:14px"><button class="btn ghost" onclick="tutupModal()">Batal</button><button class="btn red" onclick="hapusBanyak()">Ya, hapus ${sel.length} pertemuan</button></div>`);
}
function hapusBanyak() {
  const c = ctxKelas(); if (!c) return; const { m, k } = c;
  const sel = (S.delSel || []).filter(n => k.pert.some(x => x.n === n)).sort((a, b) => b - a); // dari nomor terbesar agar penomoran tidak bergeser
  if (!sel.length) { tutupModal(); return; }
  const a = st.pr(); sel.forEach(n => hapusPertCore(m, k, a, n));
  saveMk(m); st.setPr(a);
  Object.keys(S.open).forEach(key => { if (key.startsWith(m.id + '-')) delete S.open[key]; });
  S.delMode = false; S.selMode = false; S.delSel = []; S.edit = null; S.pfKey = null; tutupModal(); render(); toast(sel.length + ' pertemuan dihapus');
}
// Hapus satu pertemuan di memori (tanpa simpan/render): geser nomor pertemuan & data partisipan sesudahnya
function hapusPertCore(m, k, a, n) {
  k.pert = k.pert.filter(x => x.n !== n); k.pert.forEach(x => { if (x.n > n) x.n--; });
  const d = a[m.id] || {};
  studentsOf(m.id, k.id).forEach(u => {
    const v = d[u.email]; if (!v) return;
    ['att', 'sub', 'quiz', 'qt', 'nilai', 'qext', 'kembali'].forEach(f => {
      const o = v[f]; if (!o) return; const nw = {};
      Object.keys(o).forEach(key => { const i = +key; if (i < n) nw[key] = o[key]; else if (i > n) nw[i - 1] = o[key]; });
      v[f] = nw;
    });
  });
}
function hapusPertModal(n) {
  const c = ctxKelas(); if (!c) return; const { m, k } = c, x = k.pert.find(q => q.n === n); if (!x) return;
  const jml = studentsOf(m.id, k.id).length, sesudah = k.pert.filter(q => q.n > n).length;
  modal(`<h3>⚠️ Hapus pertemuan ${n}?</h3><div class="quote">${esc(x.topik)} · ${esc(k.nama)}</div><div class="warnbox" ${merah}>Tindakan ini <b>tidak bisa dibatalkan</b>.</div>
  <ul class="dampak"><li>Materi, tugas, dan quiz di pertemuan ini ikut terhapus.</li>
  <li>Absen, tugas yang dikirim, nilai, dan hasil quiz <b>${jml} partisipan</b> di pertemuan ini ikut terhapus.</li>
  ${sesudah ? `<li>${sesudah} pertemuan setelahnya otomatis bergeser nomornya (pertemuan ${n + 1} menjadi pertemuan ${n}, dan seterusnya).</li>` : ''}</ul>
  <div class="row" style="margin-top:14px"><button class="btn ghost" onclick="tutupModal()">Batal</button><button class="btn red" onclick="hapusPert(${n})">Ya, hapus pertemuan ${n}</button></div>`);
}
function hapusPert(n) {
  const c = ctxKelas(); if (!c) return; const { m, k } = c;
  if (!k.pert.some(x => x.n === n)) { tutupModal(); return; }
  const a = st.pr(); hapusPertCore(m, k, a, n);
  saveMk(m); st.setPr(a);
  Object.keys(S.open).forEach(key => { if (key.startsWith(m.id + '-')) delete S.open[key]; });
  S.delMode = false; S.selMode = false; S.delSel = []; S.edit = null; S.pfKey = null; tutupModal(); render(); toast('Pertemuan ' + n + ' dihapus');
}
// Pengumpulan: siapa saja yang sudah mengirim tugas / mengerjakan quiz
let KUM = [], PVJ = 0, KFOC = null;
const kfJ = j => !KFOC || String(KFOC.jenis).split(',').includes(j);
// kumpulModal(n, jenis, email): jika jenis & email diisi, hanya tugas ATAU quiz milik satu partisipan itu yang ditampilkan
function kumpulBack(n) { kumpulModal(n, KFOC && KFOC.jenis, KFOC && KFOC.em); }
function kumpulModal(n, jenis, em) {
  KFOC = jenis ? { jenis, em } : null;
  freePv();
  const c = ctxKelas(); if (!c) return;
  const { m, k } = c, x = k.pert.find(q => q.n === n), ss = studentsOf(m.id, k.id); KUM = ss.map(u => u.email);
  // daftar lampiran satu partisipan; kind: sub = tugas, qx = hasil quiz
  const lampRows = (items, i, kind) => items.map((it, j) => it.tipe === 'link'
    ? `<div class="kf">🔗 <span class="lk">${esc(it.url)}</span><button class="btn sm" onclick="bukaLinkTugas(${n},${i},${j},'${kind}')">Buka link</button></div>`
    : `<div class="kf">📄 ${esc(it.nama)}${it.size ? ' <small>(' + sizeTxt(it.size) + ')</small>' : ''}<button class="btn sm" onclick="lihatTugas(${n},${i},${j},'${kind}')">Lihat</button><button class="btn ghost sm" onclick="unduhTugas(${n},${i},${j},'${kind}')">Unduh</button></div>`).join('');
  const nama = (u, chips, extra) => `<div class="krow"><div class="kh"><div><b>${esc(u.nama)}</b><div class="quote">${esc(u.id)}</div></div><div style="text-align:right">${chips}</div></div>${extra || ''}</div>`;
  let h = `<h3>Pengumpulan · Pertemuan ${n}</h3><div class="quote">${esc(x.topik)} · ${esc(k.nama)}</div>`;
  if (!ss.length) h += '<p class="empty">Belum ada partisipan yang bergabung.</p>';
  else {
    if (x.tugas && kfJ('tugas')) {
      const sent = ss.filter(u => P(m.id, u.email).sub[n]).length, graded = ss.filter(u => P(m.id, u.email).nilai[n]).length;
      h += `<h4 style="margin:16px 0 4px">${KFOC ? 'Tugas' : `Tugas · ${sent}/${ss.length} sudah mengirim · ${graded} dinilai`} ${dlChip(x.tugasDl)}</h4>` + ss.map((u, i) => {
        if (KFOC && KFOC.em !== u.email) return '';
        const p = P(m.id, u.email), f = p.sub[n], nl = p.nilai[n];
        if (!f) return nama(u, p.kembali[n] ? '<span class="chip c-iz">Dikembalikan</span>' : '<span class="chip c-wait">Belum mengirim</span>', p.kembali[n] ? '<div class="quote" style="margin-top:6px">Menunggu dikirim ulang</div>' : '');
        if (f.manual) return nama(u, '<span class="chip c-ok">Selesai</span>', `<div class="quote" style="margin-top:6px">Ditandai selesai oleh pengajar ${fmtDt(f.at)}</div><div class="row" style="margin-top:10px"><button class="btn red sm" onclick="batalSelesai(${n},${i},'tugas')">↩ Batalkan selesai</button></div>`);
        const its = itemsOf(f);
        return nama(u, nl ? `<span class="chip c-ok">Sudah dinilai${nl.skor != null ? ' · ' + nl.skor : ''}</span>` : '<span class="chip c-iz">Perlu dinilai</span>',
          `${subAt(f) ? `<div class="quote" style="margin-top:6px">Dikirim ${fmtDt(subAt(f))} · ${its.length} lampiran</div>` : ''}${its.length ? lampRows(its, i, 'sub') : '<div class="kf"><span class="quote">Berkas lama tidak tersimpan. Partisipan sudah diminta mengirim ulang.</span></div>'}
        <div class="kn"><input id="nl-${i}" type="number" min="0" max="100" placeholder="Nilai 0–100 (boleh kosong)" value="${nl && nl.skor != null ? nl.skor : ''}" aria-label="Nilai ${esc(u.nama)}"><input id="ct-${i}" placeholder="Catatan (opsional)" maxlength="120" value="${nl ? esc(nl.cat || '') : ''}" aria-label="Catatan untuk ${esc(u.nama)}"><button class="btn lime sm" onclick="simpanNilai(${n},${i})">${nl ? 'Perbarui' : 'Simpan penilaian'}</button><button class="btn ghost sm" onclick="kembalikan(${n},${i})">↩ Kembalikan</button></div>`);
      }).join('');
    }
    if (adaQuiz(x) && kfJ('quiz')) {
      const done = ss.filter(u => quizDone(P(m.id, u.email), x)).length;
      h += `<h4 style="margin:16px 0 4px">${KFOC ? 'Quiz' : `Quiz · ${done}/${ss.length} selesai`} ${dlChip(x.quizDl)}</h4>` + ss.map((u, i) => {
        if (KFOC && KFOC.em !== u.email) return '';
        const p = P(m.id, u.email), qe0 = p.qext[n], qe = qeOk(qe0) ? qe0 : null, chips = [];
        if (x.quiz.length) chips.push(p.quiz[n] != null ? `<span class="chip c-bl">Nilai ${p.quiz[n]}</span>` : '<span class="chip c-wait">Soal belum dikerjakan</span>');
        let extra = '';
        if (qlOf(x).length) {
          if (qe) {
            const its = itemsOf(qe), nl = qe.nilai;
            if (its.length) {
              chips.push(nl ? `<span class="chip c-ok">Sudah dinilai${nl.skor != null ? ' · ' + nl.skor : ''}</span>` : '<span class="chip c-iz">Perlu dinilai</span>');
              extra = `<div class="quote" style="margin-top:6px">Hasil dikirim ${fmtDt(qe.at)} · ${its.length} lampiran</div>${lampRows(its, i, 'qx')}${gradeUI(n, i, nl, 'qx')}`;
            } else {
              chips.push('<span class="chip c-ok">Selesai</span>');
              extra = `<div class="quote" style="margin-top:6px">Ditandai selesai ${qe.oleh ? 'oleh pengajar ' : ''}${fmtDt(qe.at)}</div>${qe.oleh ? `<div class="row" style="margin-top:10px"><button class="btn red sm" onclick="batalSelesai(${n},${i},'quiz')">↩ Batalkan selesai</button></div>` : ''}`;
            }
          } else if (qe0 && qe0.kembali) { chips.push('<span class="chip c-iz">Dikembalikan</span>'); extra = '<div class="quote" style="margin-top:6px">Menunggu dikirim ulang</div>'; }
          else chips.push('<span class="chip c-wait">Belum selesai</span>');
        }
        return nama(u, chips.join(' '), extra);
      }).join('');
    }
  }
  modal(h + '<div class="row" style="margin-top:14px"><button class="btn ghost" onclick="tutupModal()">← Kembali ke pertemuan</button></div>');
}
async function lihatTugas(n, i, j, kind) {
  j = j || 0; PVJ = j; kind = kind || 'sub';
  const c = ctxKelas(); if (!c || !KUM[i]) return;
  const { m } = c, u = Auth.find(KUM[i]), p = P(m.id, KUM[i]), fld = kind === 'qx' ? p.qext[n] : p.sub[n], nl = kind === 'qx' ? (fld && fld.nilai) : p.nilai[n], its = itemsOf(fld), it0 = its[j];
  if (!it0 || it0.tipe === 'link') { toast('Berkas tidak tersimpan'); return; }
  let it; try { it = await withData(it0); } catch (e) { toast('Berkas tidak bisa dibuka'); return; }
  freePv();
  const tabs = its.length > 1 ? `<div class="row" style="margin-top:10px">${its.map((q, jj) => `<button class="btn ${jj === j ? '' : 'ghost'} sm" onclick="${q.tipe === 'link' ? `bukaLinkTugas(${n},${i},${jj},'${kind}')` : `lihatTugas(${n},${i},${jj},'${kind}')`}">${q.tipe === 'link' ? '🔗 Link' : '📄 ' + esc(q.nama.length > 22 ? q.nama.slice(0, 20) + '…' : q.nama)}</button>`).join('')}</div>` : '';
  const ctrl = kind === 'qx' ? gradeUI(n, i, nl, 'qx', true, j)
    : `<div class="kn" style="margin-top:12px"><input id="nl-${i}" type="number" min="0" max="100" placeholder="Nilai 0–100 (boleh kosong)" value="${nl && nl.skor != null ? nl.skor : ''}" aria-label="Nilai ${esc(u.nama)}"><input id="ct-${i}" placeholder="Catatan (opsional)" maxlength="120" value="${nl ? esc(nl.cat || '') : ''}" aria-label="Catatan untuk ${esc(u.nama)}"><button class="btn lime sm" onclick="simpanNilai(${n},${i},true)">${nl ? 'Perbarui' : 'Simpan penilaian'}</button><button class="btn ghost sm" onclick="unduhTugas(${n},${i},${j})">Unduh</button><button class="btn ghost sm" onclick="kembalikan(${n},${i},true)">↩ Kembalikan</button></div>`;
  modal(`<button class="btn ghost" onclick="kumpulBack(${n})">← Kembali ke daftar pengumpulan</button><h3 style="margin:12px 0 0;word-break:break-all">${esc(it.nama)}</h3><div class="quote">${esc(u.nama)} · ${esc(u.id)}${subAt(fld) ? ' · ' + fmtDt(subAt(fld)) : ''}${kind === 'qx' && fld && fld.at ? ' · ' + fmtDt(fld.at) : ''}</div>${tabs}
  ${previewHtml(it)}${ctrl}`, 'wide');
}
async function unduhTugas(n, i, j, kind) {
  const c = ctxKelas(); if (!c || !KUM[i]) return;
  const p = P(c.m.id, KUM[i]), it0 = itemsOf(kind === 'qx' ? p.qext[n] : p.sub[n])[j || 0];
  if (!it0 || it0.tipe === 'link') return;
  try { bukaBerkas(await withData(it0), true); } catch (e) { toast('Berkas tidak bisa diunduh'); }
}
function bukaLinkTugas(n, i, j, kind) {
  const c = ctxKelas(); if (!c || !KUM[i]) return;
  const p = P(c.m.id, KUM[i]), it = itemsOf(kind === 'qx' ? p.qext[n] : p.sub[n])[j || 0];
  if (it && it.tipe === 'link') bukaLink(it.url);
}
// Kolom nilai + catatan + tombol untuk hasil quiz (kind 'qx'), sama seperti penilaian tugas
function gradeUI(n, i, nl, kind, pv, j) {
  const pf = kind === 'qx' ? 'q' : '', u = Auth.find(KUM[i]), nm = u ? esc(u.nama) : '', kd = kind || 'sub';
  return `<div class="kn"${pv ? ' style="margin-top:12px"' : ''}><input id="${pf}nl-${i}" type="number" min="0" max="100" placeholder="Nilai 0–100 (boleh kosong)" value="${nl && nl.skor != null ? nl.skor : ''}" aria-label="Nilai ${nm}"><input id="${pf}ct-${i}" placeholder="Catatan (opsional)" maxlength="120" value="${nl ? esc(nl.cat || '') : ''}" aria-label="Catatan untuk ${nm}"><button class="btn lime sm" onclick="simpanNilai(${n},${i},${!!pv},'${kd}')">${nl ? 'Perbarui' : 'Simpan penilaian'}</button>${pv ? `<button class="btn ghost sm" onclick="unduhTugas(${n},${i},${j || 0},'${kd}')">Unduh</button>` : ''}<button class="btn ghost sm" onclick="kembalikan(${n},${i},${!!pv},'${kd}')">↩ Kembalikan</button></div>`;
}
function kembalikan(n, i, pv, kind) {
  const c = ctxKelas(); if (!c || !KUM[i]) return;
  const q = kind === 'qx', em = KUM[i], u = Auth.find(em), p = P(c.m.id, em), f = q ? p.qext[n] : p.sub[n], nama = u ? u.nama : 'partisipan';
  if (q ? !(qeOk(f) && itemsOf(f).length) : !f) { toast(q ? 'Partisipan belum mengirim hasil quiz' : 'Partisipan belum mengirim tugas'); return; }
  if (!confirm((q ? 'Kembalikan hasil quiz ' : 'Kembalikan tugas ') + nama + '?\nBerkas yang sudah dikirim dihapus dan nilainya dibatalkan, lalu partisipan bisa mengirim ulang.\nIsi kolom Catatan dulu kalau ingin memberi alasan.')) return;
  const ct = document.getElementById((q ? 'q' : '') + 'ct-' + i), cat = ct ? ct.value.trim() : '';
  if (q) {
    const its = itemsOf(f), a0 = its[0];
    p.qext[n] = { kembali: { cat, lama: a0 ? (a0.tipe === 'link' ? a0.url : a0.nama) + (its.length > 1 ? ' (+' + (its.length - 1) + ' lainnya)' : '') : '', at: Date.now() } };
  } else {
    p.kembali[n] = { cat, lama: subName(f), at: Date.now() };
    delete p.sub[n]; delete p.nilai[n];
  }
  setP(c.m.id, em, p);
  toast((q ? 'Hasil quiz' : 'Tugas') + ' dikembalikan ke ' + nama); render(); kumpulBack(n);
}
// Pengajar memberi nilai (0–100, boleh dikosongkan = hanya ditandai "sudah dinilai") dan catatan
function simpanNilai(n, i, pv, kind) {
  const c = ctxKelas(); if (!c || !KUM[i]) return;
  const q = kind === 'qx', pf = q ? 'q' : '';
  const raw = document.getElementById(pf + 'nl-' + i).value.trim(), cat = document.getElementById(pf + 'ct-' + i).value.trim();
  let skor = null;
  if (raw !== '') { skor = Number(raw); if (!(skor >= 0 && skor <= 100)) { toast('Nilai harus antara 0 dan 100'); return; } skor = Math.round(skor * 10) / 10; }
  const p = P(c.m.id, KUM[i]);
  let baru = false;   // true = penilaian pertama (dari tab Belum dinilai) -> jendela ditutup otomatis
  if (q) {
    const qe = p.qext[n];
    if (!(qeOk(qe) && itemsOf(qe).length)) { toast('Partisipan belum mengirim hasil quiz'); return; }
    baru = !qe.nilai; qe.nilai = { skor, cat, at: Date.now() };
  } else {
    if (!p.sub[n]) { toast('Partisipan belum mengirim tugas'); return; }
    baru = !p.nilai[n]; p.nilai[n] = { skor, cat, at: Date.now() };
  }
  setP(c.m.id, KUM[i], p);
  toast('Penilaian disimpan'); render(); if (baru) { tutupModal(); return; } if (pv) lihatTugas(n, i, PVJ, q ? 'qx' : 'sub'); else kumpulBack(n);
}
let ABS = [];
function absenModal(n) {
  const c = ctxKelas(); if (!c) return;
  const { m, k } = c, ss = studentsOf(m.id, k.id); ABS = ss.map(u => u.email);
  const opt = [['', 'Belum diabsen'], ['H', 'Hadir'], ['I', 'Izin'], ['A', 'Alpa']];
  modal(`<h3>Absensi pertemuan ${n}</h3><div class="quote">${esc(k.nama)}. Kamu bisa mengubah absensi kapan saja, termasuk setelah batas waktu absen mandiri lewat.</div>
  ${ss.length ? ss.map((u, i) => { const cur = P(m.id, u.email).att[n] || ''; return `<div class="arow"><div><b>${esc(u.nama)}</b><div class="quote">${esc(u.id)}</div></div><select id="ab-${i}" aria-label="Absensi ${esc(u.nama)}">${opt.map(([v, l]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`; }).join('') : '<p class="empty">Belum ada partisipan yang bergabung.</p>'}
  <div class="row" style="margin-top:14px">${ss.length ? `<button class="btn lime" onclick="saveAbsen(${n})">Simpan absensi</button>` : ''}<button class="btn ghost" onclick="tutupModal()">← Kembali ke pertemuan</button></div>`);
}
function saveAbsen(n) {
  const c = ctxKelas(); if (!c) return;
  ABS.forEach((em, i) => { const v = document.getElementById('ab-' + i).value, p = P(c.m.id, em); if (v) p.att[n] = v; else delete p.att[n]; setP(c.m.id, em, p); });
  tutupModal(); toast('Absensi disimpan'); render();
}

// ---------- BUAT MATA KULIAH & MASUK KELAS ----------
function mkModal(id) {
  const m = id ? getMk(id) : null;
  if (id && (!m || m.dosen !== U.email)) return;
  modal(`<h3>${m ? 'Ubah pelajaran' : 'Buat pelajaran'}</h3><div class="quote">${m ? 'Perubahan langsung terlihat oleh partisipan di kelasmu.' : 'Setelah dibuat, kamu bisa membuat kelas A, B, C… beserta kodenya.'}</div>
  <div class="fg" style="margin-top:12px"><label class="f">Nama pelajaran<input id="mNama" placeholder="Pemrograman Berorientasi Objek" maxlength="60" value="${m ? esc(m.nama) : ''}"></label>
  <div class="two"><label class="f">ID pelajaran (opsional)<input id="mKode" placeholder="mis. PLJ-01" maxlength="12" value="${m ? esc(m.kode || '') : ''}"></label><label class="f">Jadwal (opsional)<input id="mJadwal" placeholder="Selasa, 08.00–10.30" maxlength="40" value="${m ? esc(m.jadwal || '') : ''}"></label></div>
  <p class="err" id="mErr" role="alert"></p>
  <div class="row"><button class="btn lime" onclick="createMk(${m ? `'${m.id}'` : ''})">${m ? 'Simpan perubahan' : 'Buat pelajaran'}</button><button class="btn ghost" onclick="tutupModal()">Batal</button></div></div>`);
  $('#mNama').focus();
}
function createMk(id) {
  const nama = $('#mNama').value.trim(), e = $('#mErr'), old = id ? getMk(id) : null;
  if (id && (!old || old.dosen !== U.email)) return;
  if (!nama) { e.textContent = 'Nama pelajaran wajib diisi.'; return; }
  if (st.mk().some(m => m.dosen === U.email && m.id !== id && m.nama.toLowerCase() === nama.toLowerCase())) { e.textContent = 'Kamu sudah punya pelajaran dengan nama ini.'; return; }
  const data = { nama, kode: $('#mKode').value.trim(), jadwal: $('#mJadwal').value.trim() };
  if (old) {
    Object.assign(old, data);
    if (!saveMk(old)) { e.textContent = 'Gagal menyimpan data.'; return; }
    tutupModal(); toast('Pelajaran diperbarui'); render(); return;
  }
  const m = { id: uid('mk'), ...data, dosen: U.email, dosenNama: U.nama, kelas: [] };
  if (!saveMk(m)) { e.textContent = 'Gagal menyimpan data.'; return; }
  tutupModal(); toast('Pelajaran dibuat. Sekarang buat kelasnya.'); go('course', m.id);
}
const merah = 'style="border-color:#e8a0a0;background:#fdeaea"';
function hapusMkModal(id) {
  const m = getMk(id); if (!m || m.dosen !== U.email) return;
  modal(`<h3>⚠️ Hapus pelajaran “${esc(m.nama)}”?</h3><div class="warnbox" ${merah}>Tindakan ini <b>tidak bisa dibatalkan</b>.</div>
  <ul class="dampak"><li><b>${m.kelas.length} kelas</b> dan <b>${totalPert(m)} pertemuan</b> (materi, tugas, quiz) ikut terhapus.</li>
  <li><b>${studentsOf(m.id).length} partisipan</b> keluar dari pelajaran ini dan kehilangan absen, tugas yang dikirim, nilai, dan hasil quiz mereka.</li></ul>
  <div class="row" style="margin-top:14px"><button class="btn ghost" onclick="tutupModal()">Batal</button><button class="btn red" onclick="hapusMk('${m.id}')">Ya, hapus pelajaran</button></div>`);
}
function hapusMk(id) {
  const m = getMk(id); if (!m || m.dosen !== U.email) return;
  st.setMk(st.mk().filter(x => x.id !== id)); st.setJn(st.jn().filter(j => j.mkId !== id));
  const pr = st.pr(); delete pr[id]; st.setPr(pr);
  tutupModal(); toast('Pelajaran dihapus'); go('courses');
}
function kelasModal() {
  const c = ctxKelas(); if (!c) return; const { k } = c;
  modal(`<h3>Ubah kelas</h3><div class="quote">Partisipan yang sudah bergabung tetap berada di kelas ini. Kode baru hanya berlaku untuk yang bergabung berikutnya.</div>
  <div class="fg" style="margin-top:12px"><label class="f">Nama kelas<input id="eKNama" value="${esc(k.nama)}" maxlength="30"></label>
  <label class="f">Kode kelas<input id="eKKode" value="${esc(k.kode)}" maxlength="16" style="text-transform:uppercase"></label>
  <label class="f">Jumlah pertemuan<input id="eKTotal" type="number" min="${Math.max(1, k.pert.length)}" max="${MAXP}" step="1" value="${totalOf(k)}" inputmode="numeric"><small class="quote">Sudah dibuat ${k.pert.length} pertemuan, jadi jumlahnya tidak bisa kurang dari itu.</small></label>
  <p class="err" id="eKErr" role="alert"></p>
  <div class="row"><button class="btn lime" onclick="simpanKelas()">Simpan perubahan</button><button class="btn ghost" onclick="tutupModal()">Batal</button></div></div>`);
}
async function simpanKelas() {
  const c = ctxKelas(); if (!c) return; const { m, k } = c, e = $('#eKErr');
  const nama = $('#eKNama').value.trim(), kode = $('#eKKode').value.trim().toUpperCase();
  if (!nama) { e.textContent = 'Nama kelas wajib diisi.'; return; }
  if (!/^[A-Z0-9-]{4,16}$/.test(kode)) { e.textContent = 'Kode kelas 4–16 karakter: huruf, angka, atau tanda hubung.'; return; }
  const total = cekTotal($('#eKTotal').value);
  if (!total) { e.textContent = 'Jumlah pertemuan harus bilangan bulat 1–' + MAXP + '.'; return; }
  if (total < k.pert.length) { e.textContent = 'Kelas ini sudah punya ' + k.pert.length + ' pertemuan. Hapus pertemuan dulu jika ingin menguranginya.'; return; }
  if (await kodeDipakai(kode, k.id, e)) return;
  k.nama = nama; k.kode = kode; k.total = total;
  if (!saveMk(m)) { e.textContent = 'Gagal menyimpan data.'; return; }
  tutupModal(); toast('Kelas diperbarui'); render();
}
function hapusKelasModal() {
  const c = ctxKelas(); if (!c) return; const { m, k } = c;
  modal(`<h3>⚠️ Hapus kelas “${esc(k.nama)}”?</h3><div class="warnbox" ${merah}>Tindakan ini <b>tidak bisa dibatalkan</b>.</div>
  <ul class="dampak"><li><b>${k.pert.length} pertemuan</b> (materi, tugas, quiz) di kelas ini ikut terhapus.</li>
  <li><b>${studentsOf(m.id, k.id).length} partisipan</b> keluar dari kelas ini dan kehilangan absen, tugas yang dikirim, nilai, dan hasil quiz mereka.</li>
  <li>Kode <b>${esc(k.kode)}</b> tidak bisa dipakai lagi untuk bergabung.</li></ul>
  <div class="row" style="margin-top:14px"><button class="btn ghost" onclick="tutupModal()">Batal</button><button class="btn red" onclick="hapusKelas()">Ya, hapus kelas</button></div>`);
}
function hapusKelas() {
  const c = ctxKelas(); if (!c) return; const { m, k } = c, ss = studentsOf(m.id, k.id);
  m.kelas = m.kelas.filter(x => x.id !== k.id); saveMk(m);
  st.setJn(st.jn().filter(j => !(j.mkId === m.id && j.kelasId === k.id)));
  const pr = st.pr(); ss.forEach(u => { if (pr[m.id]) delete pr[m.id][u.email]; }); st.setPr(pr);
  tutupModal(); toast('Kelas dihapus'); go('course', m.id);
}
// Partisipan keluar dari pelajaran (= keluar dari kelas yang dimasuki)
function keluarModal(mkId) {
  const m = getMk(mkId); if (!m || !myMk().some(x => x.id === mkId)) return;
  const p = P(mkId, U.email), nA = Object.keys(p.att).length, nT = Object.keys(p.sub).length, nQ = Object.keys(p.quiz).length;
  modal(`<h3>Keluar dari “${esc(m.nama)}”?</h3><div class="warnbox" ${merah}>Data belajarmu di pelajaran ini akan <b>dihapus</b>.</div>
  <ul class="dampak"><li>${nA} catatan absen, ${nT} tugas yang sudah dikirim, nilai, dan ${nQ} hasil quiz-mu ikut terhapus.</li>
  <li>Kamu bisa bergabung lagi dengan kode kelas dari pengajar, tetapi data lama tidak kembali.</li></ul>
  <div class="row" style="margin-top:14px"><button class="btn ghost" onclick="tutupModal()">Batal</button><button class="btn red" onclick="keluarMk('${m.id}')">Ya, keluar dari pelajaran</button></div>`);
}
function keluarMk(mkId) {
  if (!myMk().some(x => x.id === mkId)) return;
  st.setJn(st.jn().filter(j => !(j.mhs === U.email && j.mkId === mkId)));
  const pr = st.pr(); if (pr[mkId]) delete pr[mkId][U.email]; st.setPr(pr);
  Object.keys(S.draft).forEach(k => { if (k.startsWith(mkId + '-')) delete S.draft[k]; });
  tutupModal(); toast('Kamu sudah keluar dari pelajaran'); go('courses');
}
function joinModal() {
  modal(`<h3>Masuk kelas</h3><div class="quote">Masukkan kode kelas yang diberikan pengajarmu.</div>
  <div class="fg" style="margin-top:12px"><label class="f">Kode kelas<input id="jKode" placeholder="contoh: PBO-A" maxlength="16" autocomplete="off" style="text-transform:uppercase"></label>
  <p class="err" id="jErr" role="alert"></p>
  <div class="row"><button class="btn lime" onclick="joinKelas()">Masuk kelas</button><button class="btn ghost" onclick="tutupModal()">Batal</button></div></div>`);
  $('#jKode').focus();
}
async function joinKelas() {
  const kode = $('#jKode').value.trim().toUpperCase(), e = $('#jErr');
  if (!kode) { e.textContent = 'Masukkan kode kelas.'; return; }
  e.textContent = '';
  // Pencarian kode dan pendaftaran ke kelas dilakukan di server (fungsi join_by_code), jadi daftar semua kelas tidak perlu dibuka.
  const { data, error } = await sb.rpc('join_by_code', { p_kode: kode });
  if (error) {
    const t = error.message || '';
    e.textContent = t.includes('NOT_FOUND') ? 'Kode kelas tidak ditemukan. Periksa kembali kode dari pengajarmu.'
      : t.includes('SUDAH') ? 'Kamu sudah bergabung di pelajaran ini.' : 'Gagal bergabung: ' + t;
    return;
  }
  await reloadData();
  tutupModal(); toast('Berhasil bergabung: ' + data.nama); go('courses');
}

// ---------- PROGRES & PENGATURAN ----------
// ---------- PROGRES ----------
// Halaman Progres: ringkasan besar dengan cincin animasi, lencana (partisipan), kartu per pelajaran yang bisa dibuka,
// deretan titik pertemuan, dan (pengajar) daftar partisipan per kelas yang diurutkan dari yang paling butuh perhatian.
const pgPct = (a, b) => b ? Math.round(a / b * 100) : 0;
const pgComb = (h, hd, d, t) => { const c = []; if (hd) c.push(h / hd * 100); if (t) c.push(d / t * 100); return c.length ? Math.round(c.reduce((x, y) => x + y, 0) / c.length) : 0; };
const pgCn = v => `<span data-count="${v}">${v}</span>`;
const pgRing = (pct, lab, sz) => `<div class="prg-ring" style="--sz:${sz || 120}px" role="img" aria-label="${lab} ${pct}%"><svg viewBox="0 0 100 100" aria-hidden="true"><circle class="t" cx="50" cy="50" r="42"/><circle class="p" cx="50" cy="50" r="42" style="stroke-dashoffset:${(263.9 * (1 - pct / 100)).toFixed(1)}"/></svg><div><b>${pgCn(pct)}%</b>${lab ? `<small>${lab}</small>` : ''}</div></div>`;
const pgMeter = (ic, l, val, pct, tone) => `<div class="prg-m"><div class="prg-ml"><span>${ic} ${l}</span><b>${val}</b></div><div class="prg-bar ${tone}"><i style="width:${pct}%"></i></div></div>`;
const pgLevel = (pct, has) => !has ? ['🌱', 'Belum mulai', 'Progresmu muncul setelah ada pertemuan dan tugas.'] : pct >= 100 ? ['🏆', 'Juara Kelas', 'Sempurna! Semua target tercapai, pertahankan ya.'] : pct >= 75 ? ['🔥', 'Hampir Sempurna', 'Tinggal sedikit lagi, kamu keren!'] : pct >= 50 ? ['💪', 'Pelajar Tangguh', 'Sudah separuh jalan, terus melaju.'] : pct >= 25 ? ['🚀', 'Mulai Melaju', 'Awal yang bagus, jangan lewatkan pertemuan berikutnya.'] : ['🌱', 'Pemanasan', 'Ayo mulai kumpulkan progres, satu langkah kecil dulu.'];
function pgTog(key) {
  S.open[key] = !S.open[key];   // buka/tutup tanpa render ulang supaya animasinya tidak diulang
  const el = document.querySelector(`[data-pg="${key}"]`); if (el) { el.classList.toggle('open', !!S.open[key]); const b = el.querySelector('.prg-top'); if (b) b.setAttribute('aria-expanded', !!S.open[key]); }
}
function pgBadge(t, ok, d) { toast((ok ? '🎉 ' : '🔒 ') + t + ' — ' + (ok ? 'sudah kamu dapatkan' : 'belum: ' + d)); }
function pgHero(ic, title, sub, chips, ring) {
  return `<section class="prg-hero"><div class="prg-bg" aria-hidden="true"><i></i><i></i><i></i><span class="prg-f a">📈</span><span class="prg-f b">⭐</span><span class="prg-f c">🎯</span></div>
  <div class="prg-ht"><span class="prg-pill"><b class="prg-ico">${ic}</b>${title}</span><h1>Progres belajar</h1><p>${sub}</p><div class="prg-chips">${chips}</div></div>${ring}</section>`;
}
// status absen sebuah pertemuan untuk partisipan: [kelas warna, label]
function pgAbsen(x, p) {
  const a = p.att[x.n];
  if (a === 'H') return ['ok', 'Hadir']; if (a === 'I') return ['iz', 'Izin']; if (a === 'A') return ['no', 'Alpa'];
  if (absenOpen(x)) return ['live', 'Absen dibuka'];
  if (x.absen && x.absen.dur > 0) return ['no', 'Terlewat'];
  return ['wait', 'Belum diabsen'];
}
function progress() {
  const L = myMk();
  if (!L.length) return '<h1>Progres belajar</h1>' + empty('📈', 'Belum ada progres', isDosen ? 'Progres kelas muncul setelah kamu membuat kelas dan partisipan bergabung.' : 'Progres muncul setelah kamu bergabung ke kelas.', isDosen ? btnMk : btnJoin);
  return isDosen ? progressD(L) : progressM(L);
}
function progressM(L) {
  const rows = L.map(m => ({ m, k: kelasOf(m, U.email), s: stats(m, U.email), pt: pertOf(m, U.email), p: P(m.id, U.email) }));
  const T = rows.reduce((a, r) => ({ hadir: a.hadir + r.s.hadir, held: a.held + r.s.held, done: a.done + r.s.done, tasks: a.tasks + r.s.tasks, lewat: a.lewat + r.s.lewat }), { hadir: 0, held: 0, done: 0, tasks: 0, lewat: 0 });
  const all = pgComb(T.hadir, T.held, T.done, T.tasks), has = T.held > 0 || T.tasks > 0, [lic, ltl, lsub] = pgLevel(all, has);
  const chips = `<span class="prg-chip">🗓️ Hadir ${T.hadir}/${T.held}</span><span class="prg-chip">📝 Selesai ${T.done}/${T.tasks}</span>${T.tasks - T.done > 0 ? `<span class="prg-chip alert">⏳ ${T.tasks - T.done} belum selesai</span>` : (T.tasks ? '<span class="prg-chip ok">✅ Semua beres</span>' : '')}`;
  const bd = [
    ['🌱', 'Langkah Pertama', 'hadir atau menyelesaikan satu tugas', T.hadir > 0 || T.done > 0],
    ['🎯', 'Rajin Hadir', 'kehadiran minimal 80%', T.held > 0 && pgPct(T.hadir, T.held) >= 80],
    ['🔥', 'Hadir Terus', 'hadir di semua pertemuan', T.held > 0 && T.hadir === T.held],
    ['✅', 'Tugas Tuntas', 'semua tugas dan quiz selesai', T.tasks > 0 && T.done === T.tasks]
  ];
  const badges = `<h2 class="prg-h">Lencana kamu <small>${bd.filter(b => b[3]).length}/${bd.length}</small></h2><div class="prg-badges">${bd.map((b, i) => `<button type="button" class="prg-badge${b[3] ? ' got' : ''}" style="--i:${i}" onclick="pgBadge('${b[1]}',${b[3]},'${b[2]}')" aria-label="Lencana ${b[1]}: ${b[3] ? 'sudah didapat' : 'belum, ' + b[2]}"><span class="bi">${b[3] ? b[0] : '🔒'}</span><b>${b[1]}</b><small>${b[2]}</small></button>`).join('')}</div>`;
  const cards = rows.map((r, idx) => {
    const { m, k, s, pt, p } = r, d = dec(m), key = 'prg-' + m.id, open = S.open[key] === undefined ? L.length === 1 : !!S.open[key];
    const ap = pgPct(s.hadir, s.held), tp = pgPct(s.done, s.tasks), cp = pgComb(s.hadir, s.held, s.done, s.tasks), tot = k ? totalOf(k) : Math.max(TOTAL, pt.length);
    const dots = pt.map((x, i) => { const [c, l] = pgAbsen(x, p); return `<button type="button" class="prg-dot ${c}" style="--i:${i}" title="Pertemuan ${x.n}: ${esc(x.topik)} · ${l}" aria-label="Pertemuan ${x.n}: ${l}" onclick="bukaItem('${m.id}',${x.n})">${x.n}</button>`; }).join('') + Array.from({ length: Math.max(0, tot - pt.length) }, (_, i) => `<span class="prg-dot future" style="--i:${pt.length + i}" aria-hidden="true"></span>`).join('');
    const chip = (c, l) => `<span class="chip c-${c}">${l}</span>`;
    const detail = pt.map(x => {
      const [ac, al] = pgAbsen(x, p), f = p.sub[x.n], nl = p.nilai[x.n];
      const tg = x.tugas ? (nl ? chip('ok', 'Dinilai' + (nl.skor != null ? ' · ' + nl.skor : '')) : f ? chip('bl', 'Terkirim') : p.kembali[x.n] ? chip('iz', 'Dikembalikan') : chip('wait', 'Tugas belum')) : '';
      const qz = adaQuiz(x) ? (quizDone(p, x) ? chip('bl', 'Quiz selesai') : chip('wait', 'Quiz belum')) : '';
      return `<button type="button" class="prg-row" onclick="bukaItem('${m.id}',${x.n})"><span class="prg-n">${x.n}</span><span class="prg-t">${esc(x.topik)}</span><span class="prg-cs">${chip(ac === 'live' ? 'ok' : ac, al)}${tg}${qz}</span></button>`;
    }).join('') || '<div class="prg-empty">Belum ada pertemuan di pelajaran ini.</div>';
    return `<div class="prg-card prg-rise${open ? ' open' : ''}" style="--i:${idx}" data-pg="${key}"><button type="button" class="prg-top" aria-expanded="${open}" onclick="pgTog('${key}')"><span class="prg-ic" style="background:${d.col}">${d.ic}</span><span class="prg-nm"><b>${esc(m.nama)}</b><small>${esc(m.dosenNama)}${s.held ? ` · Pertemuan ${s.held}/${tot}` : ''}</small></span>${pgRing(cp, '', 64)}<span class="prg-chev" aria-hidden="true">▾</span></button>
      <div class="prg-ms">${pgMeter('🗓️', 'Kehadiran', `${s.hadir}/${s.held} · ${ap}%`, ap, 'ab')}${pgMeter('📝', 'Tugas & quiz selesai', `${s.done}/${s.tasks} · ${tp}%`, tp, 'tg')}</div>
      <div class="prg-dots" aria-label="Pertemuan">${dots || '<span class="prg-empty">Belum ada pertemuan.</span>'}</div>
      <div class="prg-det"><div class="prg-in"><div class="prg-leg"><span><i class="ok"></i>Hadir</span><span><i class="no"></i>Terlewat/Alpa</span><span><i class="iz"></i>Izin</span><span><i class="wait"></i>Belum</span></div>${detail}<div class="row" style="margin-top:12px"><button class="btn lime sm" onclick="go('course','${m.id}')">Buka pelajaran →</button></div></div></div></div>`;
  }).join('');
  return pgHero(lic, ltl, lsub, chips, pgRing(all, 'keseluruhan', 132)) + badges + `<h2 class="prg-h">Per pelajaran <small>tekan kartu untuk rincian</small></h2><div class="prg-list">${cards}</div>`;
}
function progressD(L) {
  const cmb = a => pgComb(a.h, a.hd, a.d, a.t);
  const Z = () => ({ h: 0, hd: 0, d: 0, t: 0, n: 0, att: 0 });
  const G = Z();
  const cards = L.map((m, idx) => {
    const M = Z(), d = dec(m);
    const krows = m.kelas.map(k => {
      const ss = studentsOf(m.id, k.id), K = Z(); K.n = ss.length;
      const ps = ss.map(u => { const s = stats(m, u.email); K.h += s.hadir; K.hd += s.held; K.d += s.done; K.t += s.tasks; return { u, s, c: pgComb(s.hadir, s.held, s.done, s.tasks) }; }).sort((a, b) => a.c - b.c);
      const low = ps.filter(q => (q.s.held || q.s.tasks) && q.c < 50).length; K.low = low;
      M.h += K.h; M.hd += K.hd; M.d += K.d; M.t += K.t; M.n += K.n; M.low = (M.low || 0) + low;
      const key = 'prg-k-' + k.id, open = !!S.open[key], ap = pgPct(K.h, K.hd), tp = pgPct(K.d, K.t), cp = cmb(K);
      const plist = ps.map(q => `<div class="prg-pr"><div class="prg-pw"><b>${esc(q.u.nama)}</b><span>${esc(q.u.id)}</span></div><div class="prg-pm">${pgMeter('🗓️', 'Hadir', `${q.s.hadir}/${q.s.held}`, pgPct(q.s.hadir, q.s.held), 'ab')}${pgMeter('📝', 'Tugas/quiz', `${q.s.done}/${q.s.tasks}`, pgPct(q.s.done, q.s.tasks), 'tg')}</div>${(q.s.held || q.s.tasks) && q.c < 50 ? '<span class="chip c-no">Perlu perhatian</span>' : (q.s.held || q.s.tasks) && q.c >= 80 ? '<span class="chip c-ok">Baik</span>' : ''}</div>`).join('') || '<div class="prg-empty">Belum ada partisipan yang bergabung.</div>';
      return `<div class="prg-k${open ? ' open' : ''}" data-pg="${key}"><button type="button" class="prg-top" aria-expanded="${open}" onclick="pgTog('${key}')"><span class="prg-kn">${esc(k.nama.trim().slice(-1).toUpperCase())}</span><span class="prg-nm"><b>${esc(k.nama)}</b><small>${K.n} partisipan · Pertemuan ${k.pert.length}/${totalOf(k)}${low ? ` · <em>${low} perlu perhatian</em>` : ''}</small></span><span class="prg-mini">${pgMeter('🗓️', 'Hadir', ap + '%', ap, 'ab')}${pgMeter('📝', 'Tugas/quiz', tp + '%', tp, 'tg')}</span><span class="prg-chev" aria-hidden="true">▾</span></button>
        <div class="prg-det"><div class="prg-in"><div class="prg-plist">${plist}</div><div class="row" style="margin-top:12px"><button class="btn lime sm" onclick="bukaKelasDari('${m.id}','${k.id}')">Buka kelas →</button></div></div></div></div>`;
    }).join('') || '<div class="prg-empty">Belum ada kelas di pelajaran ini.</div>';
    G.h += M.h; G.hd += M.hd; G.d += M.d; G.t += M.t; G.n += M.n; G.low = (G.low || 0) + (M.low || 0);
    return `<div class="prg-card prg-rise" style="--i:${idx}"><div class="prg-top static"><span class="prg-ic" style="background:${d.col}">${d.ic}</span><span class="prg-nm"><b>${esc(m.nama)}</b><small>${m.kelas.length} kelas · ${M.n} partisipan</small></span>${pgRing(cmb(M), '', 64)}</div>${krows}</div>`;
  }).join('');
  const all = cmb(G), has = G.hd > 0 || G.t > 0, [lic, ltl, lsub] = pgLevel(all, has);
  const chips = `<span class="prg-chip">🎒 ${G.n} partisipan</span><span class="prg-chip">🗓️ Rata-rata hadir ${pgPct(G.h, G.hd)}%</span><span class="prg-chip">📝 Tugas/quiz ${pgPct(G.d, G.t)}%</span>${G.low ? `<span class="prg-chip alert">⚠️ ${G.low} perlu perhatian</span>` : (has ? '<span class="prg-chip ok">✅ Semua partisipan baik</span>' : '')}`;
  return pgHero(lic, ltl, has ? 'Rata-rata kelas-kelasmu. Buka kelas untuk melihat siapa yang butuh perhatian.' : lsub, chips, pgRing(all, 'rata-rata', 132)) + `<h2 class="prg-h">Per pelajaran <small>tekan kelas untuk melihat partisipan</small></h2><div class="prg-list">${cards}</div>`;
}
// Angka di halaman Progres naik perlahan dari 0 (dimatikan bila pengguna memilih mengurangi animasi)
function prgFx(root) {
  if ((window.matchMedia && matchMedia('(prefers-reduced-motion:reduce)').matches) || document.documentElement.classList.contains('no-anim')) return;
  (root || document.querySelector('#view')).querySelectorAll('[data-count]').forEach(el => {
    const to = +el.dataset.count; if (!(to > 0)) return;
    const t0 = performance.now(), dur = 1000;
    const tick = now => { const k = Math.min(1, (now - t0) / dur); el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))); if (k < 1 && el.isConnected) requestAnimationFrame(tick); };
    el.textContent = 0; requestAnimationFrame(tick);
  });
}
// Pengaturan: akun, tampilan, pengingat, panduan, bantuan
function setPref(k, v) {
  U.pref = { ...prefOf(U), [k]: v }; Auth.update(U.email, { pref: U.pref });
  applyPref(); render(); toast('Pengaturan disimpan');
}
// ---------- PENGATURAN ----------
// Halaman Pengaturan: ringkasan akun + kesiapan di atas, lalu menu samping (Tampilan, Pengingat, Akun, Bantuan) dengan penanda yang
// bergeser dan panel yang berganti dengan animasi. Perubahan disimpan langsung di tempat (stSet) tanpa memuat ulang halaman.
const SXI = {
  type: '<path d="M4 7V5h16v2M9 19h6M12 5v14"/>',
  bell: '<path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 2h16zM10 21a2 2 0 0 0 4 0"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  out: '<path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5M16 8l4 4-4 4M20 12H9"/>',
  undo: '<path d="M4 4v6h6M4.5 15a8 8 0 1 0 2-8.5L4 10"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  id: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6.5 16c.5-1.5 1.7-2 2.5-2s2 .5 2.5 2M14 10h4M14 14h3"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M16 6l3 3M14 8l2 2"/>',
  motion: '<path d="M4 12c3-6 5-6 8 0s5 6 8 0"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  play: '<path d="M8 5l11 7-11 7z"/>'
};
const sxi = n => `<svg class="sxi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SXI[n]}</svg>`;
const ST_FAQ = {
  Partisipan: [
    ['Bagaimana cara bergabung ke kelas?', 'Buka menu Pelajaran, tekan Masuk kelas, lalu masukkan kode kelas dari pengajarmu.'],
    ['Tombol absen tidak bisa ditekan, kenapa?', 'Absen mandiri hanya bisa ditekan selama waktunya dibuka pengajar (ada hitung mundur). Jika waktunya sudah habis, minta pengajar mengabsenmu.'],
    ['Berapa batas lampiran tugas?', 'Maksimal 5 lampiran berupa file atau link. Tiap file maks. 1,5 MB dan total maks. 3 MB. Lampiran bisa dihapus sebelum dikirim.'],
    ['Tugasku dikembalikan pengajar, apa yang harus dilakukan?', 'Perbaiki tugasnya, lalu kirim ulang dari pertemuan yang sama. Catatan pengajar tampil di bawah tugasmu.'],
    ['Bagaimana cara keluar dari pelajaran?', 'Buka halaman pelajarannya lalu tekan Keluar dari pelajaran. Absen, tugas, dan nilaimu di pelajaran itu akan terhapus.']
  ],
  Pengajar: [
    ['Bagaimana membuat kelas dan membagikan kodenya?', 'Buka Pelajaran, buat pelajaran, lalu tambah kelasnya (A, B, C). Bagikan kode kelas ke partisipan agar mereka bisa bergabung.'],
    ['Di mana saya menilai tugas?', 'Buka kelas, tekan Info selengkapnya, lalu pilih tab Pengumpulan. Tugas yang menunggu penilaian ada di tab Belum dinilai.'],
    ['Bagaimana mengubah status absensi partisipan?', 'Di Info selengkapnya, buka tab Absensi, pilih pertemuannya, lalu ubah status tiap partisipan kapan saja.'],
    ['Bagaimana mengeluarkan partisipan dari kelas?', 'Buka kelasnya, lalu pada daftar Partisipan tekan Keluarkan di samping nama partisipan.'],
    ['Bisakah saya menghapus pertemuan?', 'Bisa. Di tab Pertemuan tekan Hapus pertemuan sebelumnya, lalu pilih satu atau banyak pertemuan. Tindakan ini tidak bisa dibatalkan.']
  ]
};
// Kesiapan akun: tiap butir bisa ditekan untuk langsung menuntaskannya
function stChecks() {
  const pf = prefOf(U), rem = isDosen ? pf.nl !== false : (pf.ab !== false || pf.dl !== false);
  return [
    { ok: !!U.verified, t: 'Gmail terverifikasi', act: "go('profil')" },
    { ok: !!pf.tour, t: 'Panduan sudah dilihat', act: 'startTour()' },
    { ok: rem, t: 'Pengingat aktif', act: "sxTab('pengingat')" }
  ];
}
function stScoreHtml() {
  const c = stChecks(), pct = Math.round(c.filter(x => x.ok).length / c.length * 100);
  return `${pgRing(pct, 'siap', 112)}<div class="sx-chk">${c.map(x => `<button type="button" class="sx-ck${x.ok ? ' ok' : ''}" onclick="${x.act}"><i aria-hidden="true">${x.ok ? sxi('check') : ''}</i><span>${x.t}</span></button>`).join('')}</div>`;
}
// contoh tampilan pengingat di Beranda mengikuti pilihan pengguna
function sxSample(pf) {
  if (isDosen) return pf.nl !== false ? '<span class="sx-chip warn">3 tugas menunggu penilaian</span>' : '<span class="sx-chip off">Pengingat dimatikan</span>';
  const c = [];
  if (pf.ab !== false) c.push('<span class="sx-chip live">Absen sedang dibuka</span>');
  if (pf.dl !== false) c.push(`<span class="sx-chip warn">Batas tugas dalam ${pf.dh || 24} jam</span>`);
  return c.join('') || '<span class="sx-chip off">Semua pengingat dimatikan</span>';
}
// penanda menu samping bergeser ke tab yang aktif
function sxInd() {
  const nav = document.getElementById('sxNav'); if (!nav) return;
  const b = nav.querySelector('button.on'), ind = nav.querySelector('.sx-ind'); if (!b || !ind) return;
  ind.style.setProperty('--x', b.offsetLeft + 'px'); ind.style.setProperty('--y', b.offsetTop + 'px');
  ind.style.setProperty('--w', b.offsetWidth + 'px'); ind.style.setProperty('--h', b.offsetHeight + 'px');
}
function sxTab(id) {
  S.sxTab = id;
  document.querySelectorAll('.sx-tab').forEach(b => { const on = b.dataset.t === id; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  document.querySelectorAll('.sx-panel').forEach(p => p.classList.toggle('on', p.id === 'sxp-' + id));
  sxInd();
  const p = document.getElementById('sxp-' + id); if (p && id === 'akun') prgFx(p);
  const n = document.getElementById('sxNav'); if (n && n.scrollIntoView && window.innerWidth <= 820) n.scrollIntoView({ block: 'nearest' });
}
function stFlash() {
  const el = document.getElementById('stSaved'); if (!el) return;
  el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  clearTimeout(stFlash.t); stFlash.t = setTimeout(() => el.classList.remove('on'), 1800);
}
// simpan satu pengaturan langsung dan perbarui tampilan di tempat (tanpa render ulang halaman)
function stSet(k, v) {
  U.pref = { ...prefOf(U), [k]: v }; Auth.update(U.email, { pref: U.pref }); applyPref();
  const pf = prefOf(U);
  document.querySelectorAll('.sx-seg').forEach(sg => {
    const val = String(pf[sg.dataset.k]); let idx = 0;
    sg.querySelectorAll('button').forEach((b, i) => { const on = b.dataset.v === val; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); if (on) idx = i; });
    sg.style.setProperty('--idx', idx);
  });
  const sc = document.getElementById('stScore'); if (sc) { sc.innerHTML = stScoreHtml(); prgFx(sc); }
  const sm = document.getElementById('sxSample'); if (sm) sm.innerHTML = sxSample(pf);
  stFlash();
}
function stFaq(i) { const el = document.getElementById('stq' + i); if (!el) return; const on = !el.classList.contains('open'); el.classList.toggle('open', on); const b = el.querySelector('.sx-q'); if (b) b.setAttribute('aria-expanded', on); }
function stResetModal() {
  modal(`<h3>Kembalikan pengaturan awal?</h3><p class="quote">Ukuran teks, animasi, dan pengingat kembali ke bawaan. Akun, pelajaran, dan datamu tidak berubah.</p><div class="row" style="margin-top:14px"><button class="btn ghost" onclick="tutupModal()">Batal</button><button class="btn red" onclick="stReset()">Ya, kembalikan</button></div>`);
}
function stReset() {
  U.pref = { ...prefOf(U), fs: 'normal', rm: false, dh: 24, dl: true, ab: true, nl: true }; Auth.update(U.email, { pref: U.pref });
  applyPref(); tutupModal(); render(); toast('Pengaturan dikembalikan ke awal');
}
function settings() {
  const pf = prefOf(U), isD = isDosen, L = myMk(), tab = S.sxTab || 'tampilan';
  const seg = (k, opts, cur, aa) => { const i = Math.max(0, opts.findIndex(o => String(o[0]) === String(cur))); return `<div class="sx-seg" data-k="${k}" style="--n:${opts.length};--idx:${i}" role="group"><i class="th" aria-hidden="true"></i>${opts.map(([v, l, s]) => `<button type="button" class="${String(v) === String(cur) ? 'on' : ''}" data-v="${v}" aria-pressed="${String(v) === String(cur)}" onclick="stSet('${k}',${typeof v === 'number' ? v : `'${v}'`})">${aa ? `<span style="font-size:${s}px">Aa</span>` : ''}${l}</button>`).join('')}</div>`; };
  const sw = (ic, k, t, d, on) => `<label class="sx-row"><span class="sx-ic">${sxi(ic)}</span><span class="sx-tx"><b>${t}</b><small>${d}</small></span><span class="sx-sw"><input type="checkbox" role="switch" ${on ? 'checked' : ''} onchange="stSet('${k}',this.checked)" aria-label="${t}"><i aria-hidden="true"></i></span></label>`;
  const kv = (ic, l, v) => `<div class="sx-kv"><span class="sx-ic">${sxi(ic)}</span><span class="sx-kl">${l}</span><span class="sx-kvv">${v}</span></div>`;
  let tiles;
  if (isD) {
    const kls = L.reduce((a, m) => a + m.kelas.length, 0), prt = L.reduce((a, m) => a + totalPert(m), 0), mhsU = new Set();
    L.forEach(m => m.kelas.forEach(k => studentsOf(m.id, k.id).forEach(u => mhsU.add(u.email))));
    tiles = [['Pelajaran', L.length], ['Kelas', kls], ['Partisipan', mhsU.size], ['Pertemuan dibuat', prt]];
  } else {
    const T = L.reduce((a, m) => { const s = stats(m, U.email); return { h: a.h + s.hadir, hd: a.hd + s.held, d: a.d + s.done }; }, { h: 0, hd: 0, d: 0 });
    tiles = [['Pelajaran diikuti', L.length], ['Pertemuan dihadiri', T.h], ['Tugas & quiz selesai', T.d], ['Total pertemuan', T.hd]];
  }
  const faq = (ST_FAQ[isD ? 'Pengajar' : 'Partisipan']).map(([q, a], i) => `<div class="sx-fq" id="stq${i}"><button type="button" class="sx-q" aria-expanded="false" onclick="stFaq(${i})"><span>${q}</span>${sxi('chev')}</button><div class="sx-a"><div><p>${a}</p></div></div></div>`).join('');
  const steps = isD
    ? [['Partisipan mengirim tugas', 'Tugas masuk ke tab Pengumpulan di kelas terkait.'], ['Jumlahnya muncul di Beranda', 'Kartu pengingat menampilkan banyaknya tugas yang belum dinilai.'], ['Kamu menilai tugasnya', 'Setelah dinilai, jumlahnya berkurang otomatis.']]
    : [['Pengajar membuka absen', 'Kartu Absen sekarang muncul di Beranda lengkap dengan hitung mundur.'], ['Batas waktu mendekat', 'Tugas atau quiz yang batasnya masuk jendela pengingat tampil di Beranda.'], ['Kamu menyelesaikannya', 'Setelah dikirim atau ditandai selesai, pengingatnya hilang otomatis.']];
  const tips = isD ? ['Keluar dari akun setelah memakai perangkat bersama.', 'Bagikan kode kelas hanya kepada partisipan kelasmu.', 'Jangan membagikan kata sandi kepada siapa pun.'] : ['Keluar dari akun setelah memakai perangkat bersama.', 'Gunakan Gmail pribadimu agar akun tidak tertukar.', 'Jangan membagikan kata sandi kepada siapa pun.'];
  const gear = (cls, r, n, sw2) => `<svg class="sx-gear ${cls}" viewBox="0 0 100 100" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="50" cy="50" r="${r}" stroke-width="12" stroke-dasharray="${(2 * Math.PI * r / (n * 2)).toFixed(2)} ${(2 * Math.PI * r / (n * 2)).toFixed(2)}"/><circle cx="50" cy="50" r="${r - 8}" stroke-width="3"/><circle cx="50" cy="50" r="9" stroke-width="3"/></svg>`;
  const tabs = [['tampilan', 'type', 'Tampilan', 'Ukuran teks dan gerakan'], ['pengingat', 'bell', 'Pengingat', 'Apa yang diingatkan'], ['akun', 'user', 'Akun', 'Data dan keamanan'], ['bantuan', 'help', 'Bantuan', 'Tanya jawab dan kontak']];
  const panelH = (t, d) => `<div class="sx-ph"><h2>${t}</h2><p>${d}</p></div>`;
  return `<section class="sx-hero"><div class="sx-bg" aria-hidden="true">${gear('g1', 38, 12)}${gear('g2', 26, 8)}<i></i><i></i></div>
    <div class="sx-me"><div class="sx-av" aria-hidden="true"><span>${esc((U.nama || '?').trim().charAt(0).toUpperCase())}</span></div>
      <div class="sx-who"><span class="sx-pill">Pengaturan</span><h1>${esc(U.nama)}</h1>
        <p><span class="sx-tag">${esc(U.role)}</span><span class="sx-tag">ID ${esc(U.id)}</span></p>
        <p class="sx-mail">${esc(U.email)}${U.verified ? `<span class="sx-ver">${sxi('check')}Terverifikasi</span>` : ''}</p>
        <div class="sx-acts"><button class="btn lime sm" onclick="go('profil')">Buka profil</button><button class="btn sm sx-out" onclick="Auth.logout()">Keluar</button><span class="sx-saved" id="stSaved" role="status" aria-live="polite">${sxi('check')}Tersimpan</span></div></div></div>
    <div class="sx-score" id="stScore">${stScoreHtml()}</div></section>
  <div class="sx-body">
    <nav class="sx-nav" id="sxNav" role="tablist" aria-label="Bagian pengaturan"><i class="sx-ind" aria-hidden="true"></i>${tabs.map(([id, ic, l, d], i) => `<button type="button" role="tab" class="sx-tab${tab === id ? ' on' : ''}" data-t="${id}" aria-selected="${tab === id}" style="--i:${i}" onclick="sxTab('${id}')"><span class="sx-ti">${sxi(ic)}</span><span class="sx-tt"><b>${l}</b><small>${d}</small></span></button>`).join('')}</nav>
    <div class="sx-panels">
      <section class="sx-panel${tab === 'tampilan' ? ' on' : ''}" id="sxp-tampilan" role="tabpanel">${panelH('Tampilan', 'Atur ukuran teks dan gerakan. Berlaku di semua halaman.')}
        <div class="sx-2"><div class="sx-ctl">
          <div class="sx-blk"><div class="sx-lb">Ukuran teks</div>${seg('fs', [['kecil', 'Kecil', 13], ['normal', 'Normal', 16], ['besar', 'Besar', 19]], pf.fs, true)}</div>
          ${sw('motion', 'rm', 'Kurangi animasi', 'Matikan gerakan dan efek peralihan. Cocok jika animasi terasa mengganggu.', !!pf.rm)}
          <button type="button" class="sx-link" onclick="stResetModal()">${sxi('undo')}Kembalikan pengaturan awal</button></div>
          <div class="sx-prev" aria-hidden="true"><div class="sx-win"><i></i><i></i><i></i></div>
            <div class="sx-pvbody"><div class="sx-pvside"><span></span><span class="on"></span><span></span></div>
              <div class="sx-pvmain"><b>Contoh judul halaman</b><p>Beginilah isi halaman terlihat dengan ukuran teks yang kamu pilih.</p>
                <div class="sx-pvrow"><span class="n">1</span><div><b>Pertemuan pertama</b><small>Absen mandiri · Tugas 1/3</small></div><span class="chip c-ok">Hadir</span></div><span class="btn lime sm">Tombol utama</span></div></div></div></div></section>
      <section class="sx-panel${tab === 'pengingat' ? ' on' : ''}" id="sxp-pengingat" role="tabpanel">${panelH('Pengingat', 'Pilih apa saja yang diingatkan di Beranda.')}
        <div class="sx-2"><div class="sx-ctl">
          ${isD ? sw('bell', 'nl', 'Tugas perlu dinilai', 'Tampilkan jumlah tugas yang belum dinilai di Beranda.', pf.nl !== false)
            : sw('bell', 'ab', 'Absen dibuka', 'Tampilkan kartu Absen sekarang di Beranda saat pengajar membuka absen.', pf.ab !== false) + sw('bell', 'dl', 'Batas waktu segera berakhir', 'Tampilkan tugas dan quiz yang batas waktunya sudah dekat.', pf.dl !== false)
              + `<div class="sx-blk"><div class="sx-lb">Jendela pengingat batas waktu</div>${seg('dh', [[6, '6 jam'], [12, '12 jam'], [24, '24 jam'], [48, '48 jam'], [72, '72 jam']], pf.dh || 24, false)}</div>`}
          <div class="sx-sample"><small>Contoh di Beranda</small><div id="sxSample">${sxSample(pf)}</div></div></div>
          <ol class="sx-steps">${steps.map(([t, d], i) => `<li style="--i:${i}"><span class="sx-sn">${i + 1}</span><div><b>${t}</b><small>${d}</small></div></li>`).join('')}</ol></div></section>
      <section class="sx-panel${tab === 'akun' ? ' on' : ''}" id="sxp-akun" role="tabpanel">${panelH('Akun', 'Data akunmu dan ringkasan aktivitas.')}
        <div class="sx-tiles">${tiles.map(([l, n], i) => `<div class="sx-tile" style="--i:${i}"><b>${pgCn(n)}</b><small>${l}</small></div>`).join('')}</div>
        <div class="sx-2"><div class="sx-ctl">${kv('user', 'Nama', esc(U.nama))}${kv('id', 'Peran', esc(U.role) + ' · ' + esc(U.id))}${kv('mail', 'Gmail', esc(U.email) + (U.verified ? ' <span class="chip c-ok">Terverifikasi</span>' : ' <span class="chip c-no">Belum terverifikasi</span>'))}${kv('key', 'Kata sandi', 'Ubah lewat halaman profil')}
          <div class="row" style="margin-top:10px"><button class="btn ghost" onclick="go('profil')">Buka profil</button><button class="btn ghost dng" onclick="Auth.logout()">${sxi('out')}Keluar</button></div></div>
          <div class="sx-tips"><div class="sx-lb">${sxi('shield')}Tips keamanan</div>${tips.map(t => `<p>${sxi('check')}<span>${t}</span></p>`).join('')}</div></div></section>
      <section class="sx-panel${tab === 'bantuan' ? ' on' : ''}" id="sxp-bantuan" role="tabpanel">${panelH('Bantuan', 'Jawaban cepat dan cara menghubungi kami.')}
        <div class="sx-2"><div class="sx-faq">${faq}</div>
          <div class="sx-help"><button type="button" class="sx-hb" onclick="startTour()"><i>${sxi('compass')}</i><span><b>Panduan penggunaan</b><small>Tur singkat yang menyorot menu utama</small></span>${sxi('play')}</button>
            <a class="sx-hb" href="mailto:${KONTAK.email}"><i>${sxi('mail')}</i><span><b>Email</b><small>${KONTAK.email}</small></span>${sxi('arrow')}</a>
            <a class="sx-hb" href="https://wa.me/${KONTAK.waIntl}" target="_blank" rel="noopener noreferrer"><i>${sxi('chat')}</i><span><b>WhatsApp</b><small>${KONTAK.wa}</small></span>${sxi('arrow')}</a>
          </div></div></section>
    </div></div>`;
}

// ---------- PANDUAN SPOTLIGHT (panduan penggunaan awal) ----------
// Menyorot menu utama satu per satu dengan latar gelap dan membuka halaman menunya otomatis.
// Muncul otomatis sekali untuk pengguna baru (penanda u.pref.tour disimpan di akun) dan bisa dibuka lagi dari Pengaturan atau footer.
// Tombol Lewati/Kembali/Lanjut berada di bilah tetap di bawah layar, jadi posisinya tidak berpindah antar langkah.
const TOUR = { on: false, i: 0, steps: [], raf: 0, key: '', prev: null, v0: null };
const TR_BAR = 92; // area bawah layar yang disisihkan untuk bilah tombol
function tourSteps() {
  const nm = esc((U.nama || '').split(' ')[0] || 'kamu'), N = i => `#nav button:nth-child(${i})`, d = isDosen;
  return [
    { h: `Selamat datang, ${nm}! 😉`, p: `Karena kamu orang baru di sini, ini adalah tutorial yang menyorot dan menjelaskan cara memakainya sebagai ${d ? 'pengajar' : 'partisipan'}.` },
    { v: 'home', t: N(1), h: 'Beranda', p: d ? 'Berisi ringkasan pertemuan dalam pelajaran termasuk pengingat jumlah tugas yang belum dinilai.' : 'Lihat pengingat absen yang sedang dibuka, tugas, atau quiz yang segera berakhir serta progres belajarmu.' },
    { v: 'courses', t: N(2), h: 'Pelajaran', p: 'Di dalam menu pelajaran terdapat beberapa fitur seperti:', l: d
      ? ['<b>Buat pelajaran</b> lalu di dalam pelajaran yang sudah dibuat bisa membuat kelasnya, contoh A, B, C', 'Bagikan kode kelas ke partisipan agar mereka bisa bergabung', 'Pelajaran dan kelas yang sudah dibuat bisa dihapus permanen dan progres yang ada di dalamnya tidak dapat dikembalikan lagi, <b>maka berhati-hatilah</b> dan pastikan pilihan Anda sudah benar']
      : ['Tekan masuk kelas lalu masukkan kode kelas dari pengajarmu', 'Setelah bergabung pelajaran akan muncul di sini lengkap dengan absen, materi, tugas, dan quiz jika pengajarmu membuat pertemuan baru'] },
    d ? { v: 'courses', h: 'Setelah kelas berhasil dibuat', p: 'Buka kelas dan tekan info selengkapnya lalu atur pertemuan, ada beberapa fitur di dalamnya seperti:', l: ['<b>Tambah pertemuan</b>: jika di dalam pertemuan ada materi, tugas, atau quiz maka centang opsinya dan berikan maksimal 5 file atau link', '<b>Pengumpulan</b>: file yang sudah dikumpulkan oleh partisipan dapat dilihat langsung tanpa mengunduhnya dan pengajar bisa memberikan nilai, catatan, atau mengembalikan file yang sudah dikumpulkan partisipan jika terdapat kesalahan', '<b>Absensi</b>: status kehadiran partisipan bisa diubah kapan saja'] }
      : { v: 'courses', h: 'Di dalam pelajaran', p: 'Buka pelajaranmu, lalu pilih pertemuan untuk:', l: ['<b>Absen</b>: tekan absen jika pengajarmu membuat pertemuan baru, jika waktu absen sudah habis minta pengajar mengabsenmu', '<b>Materi</b>: lihat materi yang dibuat dosenmu tanpa mengunduh atau bisa diunduh', '<b>Tugas</b>: tambahkan file atau link maksimal 5, jika ada yang salah hapus saja lalu tekan kirim tugas dan jika dosen mengembalikan tugasmu perbaiki tugasnya dan kirim ulang tugas tersebut', '<b>Quiz</b>: quiz berupa link atau file, jika quiz berupa link dan sudah selesai maka tekan tandai selesai, atau jika berupa file dan instruksi maka kamu bisa mengirimkan file quiz yang sudah kamu kerjakan', '<span class="tr-red">Keluar dari pelajaran akan menghapus absen, tugas, dan nilaimu di pelajaran itu.</span>'] },
    { v: 'progress', t: N(3), h: 'Progres', p: d ? 'Lihat semua persentase kehadiran partisipan, penyelesaian tugas, dan quiz di tiap kelas' : 'Lihat semua persentase kehadiran dan tugas di setiap pelajaran' },
    { v: 'settings', t: N(4), h: 'Pengaturan', p: 'Ubah ukuran teks dan terapkan pengingat, lihat data akunmu atau ulangi panduan ini kapan saja' },
    { v: 'home', t: '.meTop', h: 'Profil', p: 'Tekan namamu di pojok atas ini untuk membuka halaman profil untuk mengubah kontak dan mengatur keamanan akunmu' },
    { t: '.foot .fcontact', sc: 'center', h: 'Butuh bantuan?', p: `Hubungi kami lewat Email atau WhatsApp di sini jika ada kendala atau saran. Selamat ${d ? 'mengajar' : 'belajar'} ✨` }
  ];
}
function startTour() {
  if (PAGE !== 'beranda' || !U || TOUR.on) return;
  tutupModal();
  TOUR.on = true; TOUR.steps = tourSteps(); TOUR.prev = document.activeElement; TOUR.v0 = S.view;
  // ruang kosong di bawah halaman supaya footer bisa digulir ke atas bilah tombol
  const pad = document.createElement('div'); pad.id = 'trPad'; pad.style.cssText = 'height:130px;background:#0c2a1f';
  document.body.appendChild(pad);
  const r = document.createElement('div');
  r.id = 'tour'; r.className = 'tr nohole'; r.setAttribute('role', 'dialog'); r.setAttribute('aria-modal', 'true'); r.setAttribute('aria-labelledby', 'trH');
  r.innerHTML = '<div class="tr-dim"></div><div class="tr-hole"></div><div class="tr-tip" id="trTip" tabindex="-1"></div>'
    + '<div class="tr-bar" id="trBar"><button class="tr-skip" id="trSkip" onclick="endTour()">Lewati</button><div class="tr-dots" id="trDots" aria-hidden="true"></div>'
    + '<button class="btn ghost" id="trPrev" onclick="tourGo(-1)">Kembali</button><button class="btn lime" id="trNext" onclick="tourGo(1)">Mulai</button></div>';
  document.body.appendChild(r);
  document.addEventListener('keydown', tourKey, true);
  tourShow(0);
  const tip = $('#trTip'); tip.style.transition = 'none'; tourPlace(); void tip.offsetWidth; tip.style.transition = ''; tip.classList.add('rdy');
  tourLoop();
}
function tourShow(i) {
  const s = TOUR.steps[i], n = TOUR.steps.length, last = i === n - 1, tip = $('#trTip');
  TOUR.i = i; TOUR.key = '';
  if (s.v && S.view !== s.v) go(s.v);   // buka halaman menu yang sedang dijelaskan
  tip.classList.toggle('mid', !s.t);
  tip.innerHTML = `<div class="tr-n">Langkah ${i + 1} dari ${n}</div><h3 id="trH">${s.h}</h3><p>${s.p}</p>${s.l ? '<ul>' + s.l.map(x => `<li>${x}</li>`).join('') + '</ul>' : ''}`;
  $('#trDots').innerHTML = TOUR.steps.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('');
  $('#trPrev').style.visibility = i ? 'visible' : 'hidden';
  $('#trSkip').style.visibility = last ? 'hidden' : 'visible';
  $('#trNext').textContent = last ? 'Selesai' : i ? 'Lanjut' : 'Mulai';
  tip.scrollTop = 0;
  const el = s.t && document.querySelector(s.t);
  if (el) el.scrollIntoView({ block: s.sc || 'nearest', inline: 'nearest', behavior: 'smooth' });
  $('#trNext').focus({ preventScroll: true });
}
function tourGo(d) { const j = TOUR.i + d; if (j >= TOUR.steps.length) return endTour(); if (j >= 0) tourShow(j); }
// Posisi lubang sorotan dan kotak penjelasan dihitung ulang tiap frame agar tetap pas saat halaman bergulir, diubah ukurannya, atau digambar ulang
function tourPlace() {
  const root = $('#tour'), tip = $('#trTip'); if (!root || !tip) return;
  const s = TOUR.steps[TOUR.i], hole = root.querySelector('.tr-hole');
  const el = s.t ? document.querySelector(s.t) : null, r = el ? el.getBoundingClientRect() : null, ok = !!r && r.width > 0 && r.height > 0;
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight - TR_BAR, tw = tip.offsetWidth, th = tip.offsetHeight;
  const key = [ok ? [r.left, r.top, r.width, r.height].map(Math.round).join(',') : '-', vw, vh, tw, th, TOUR.i].join('|');
  if (key === TOUR.key) return;
  TOUR.key = key;
  root.classList.toggle('nohole', !ok);
  const m = 12; let x, y;
  if (ok) {
    const p = 6, g = 14, cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    hole.style.cssText = `left:${r.left - p}px;top:${r.top - p}px;width:${r.width + 2 * p}px;height:${r.height + 2 * p}px`;
    const o = {
      right: [r.right + p + g, cy - th / 2, vw - (r.right + p + g) - m >= tw],
      bottom: [cx - tw / 2, r.bottom + p + g, vh - (r.bottom + p + g) - m >= th],
      top: [cx - tw / 2, r.top - p - g - th, r.top - p - g - m >= th],
      left: [r.left - p - g - tw, cy - th / 2, r.left - p - g - m >= tw]
    };
    const k = (vw <= 820 ? ['bottom', 'top', 'right', 'left'] : ['right', 'bottom', 'top', 'left']).find(q => o[q][2]);
    [x, y] = k ? o[k] : [cx - tw / 2, vh - th - m];
  } else {
    hole.style.cssText = `left:${vw / 2}px;top:${(vh + TR_BAR) / 2}px;width:0;height:0`;
    x = (vw - tw) / 2; y = (vh - th) / 2;
  }
  tip.style.left = Math.max(m, Math.min(x, vw - tw - m)) + 'px';
  tip.style.top = Math.max(m, Math.min(y, vh - th - m)) + 'px';
}
function tourLoop() { if (!TOUR.on) return; tourPlace(); TOUR.raf = requestAnimationFrame(tourLoop); }
function tourKey(e) {
  if (!TOUR.on) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endTour(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); tourGo(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); tourGo(-1); }
  else if (e.key === 'Tab') {
    const f = [...$('#trBar').querySelectorAll('button')].filter(b => b.style.visibility !== 'hidden'), n = f.length; if (!n) return;
    e.preventDefault();
    const i = f.indexOf(document.activeElement);
    f[i < 0 ? (e.shiftKey ? n - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + n) % n].focus();
  }
}
function endTour() {
  if (!TOUR.on) return;
  TOUR.on = false; cancelAnimationFrame(TOUR.raf);
  document.removeEventListener('keydown', tourKey, true);
  const r = $('#tour'); if (r) r.remove();
  const pad = $('#trPad'); if (pad) pad.remove();
  if (U && !prefOf(U).tour) { U.pref = { ...prefOf(U), tour: true }; Auth.update(U.email, { pref: U.pref }); }
  const v0 = TOUR.v0; TOUR.v0 = null;
  if (['home', 'courses', 'progress', 'settings'].includes(v0) && S.view !== v0) go(v0);   // kembali ke halaman semula
  window.scrollTo(0, 0);
  const pv = TOUR.prev; TOUR.prev = null;
  if (pv && pv !== document.body && document.contains(pv) && pv.focus) pv.focus({ preventScroll: true });
}

// ---------- RENDER ----------
function renderNav() {
  const it = [['home', '🏠', 'Beranda'], ['courses', '📚', 'Pelajaran'], ['progress', '📈', 'Progres'], ['settings', '⚙️', 'Pengaturan'], ['profil', '👤', 'Profil']];
  const inCourses = ['courses', 'course', 'kelas', 'pert'].includes(S.view);
  $('#nav').innerHTML = it.map(([v, i, l]) => `<button class="${(S.view === v || (inCourses && v === 'courses')) ? 'on' : ''}" onclick="go('${v}')">${i} ${l}</button>`).join('');
}
function go(v, id) {
  if (v === 'profil') { location.href = 'profil.html'; return; }
  S.view = v; S.edit = null; S.pfKey = null; if (id) S.cid = id;
  render(); window.scrollTo(0, 0); refresh();
}
function render() {
  hidePcTip();
  renderNav();
  const v = S.view;
  $('#view').innerHTML = v === 'home' ? home() : v === 'courses' ? coursesPage() : v === 'course' ? coursePage() : v === 'kelas' ? kelasPage() : v === 'pert' ? pertPage() : v === 'progress' ? progress() : settings();
  $('#view').classList.toggle('is-home', v === 'home'); topInfo(); document.body.classList.toggle('me-off', v === 'settings'); if (v === 'home') fx(); if (v === 'progress' || v === 'settings') prgFx();
  if (v === 'settings') { sxInd(); requestAnimationFrame(sxInd); }
}
function tutupModal() { freePv(); $('#layer').innerHTML = ''; }
function modal(h, cls) { $('#layer').innerHTML = `<div class="modal" onclick="if(event.target===this)tutupModal()"><div class="sheet ${cls || ''}" role="dialog" aria-modal="true"><button class="xbtn" onclick="tutupModal()" aria-label="Tutup jendela">✕</button>${h}</div></div>`; }
function initBeranda() {
  initPcTip();
  const tutupMenu = () => { const k = S.pfMenu; if (k) { S.pfMenu = null; pfRefresh(k); } if (S.dMenu) { S.dMenu = null; render(); } };
  document.addEventListener('click', e => { if ((S.pfMenu || S.dMenu) && !(e.target.closest && e.target.closest('.addwrap'))) tutupMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') tutupMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') tutupModal(); });
  const h = location.hash.slice(1);
  if (['home', 'courses', 'progress', 'settings'].includes(h)) S.view = h;
  const paksaTur = h === 'tour';
  if (paksaTur) history.replaceState(null, '', location.pathname + location.search);
  setMe(U);
  render();
  // Panduan spotlight muncul otomatis sekali untuk pengguna yang belum pernah melihatnya
  if (paksaTur || !prefOf(U).tour) setTimeout(startTour, 500);
  // hitung mundur absen; saat habis, tampilan partisipan dimuat ulang (pengajar: hanya angka, agar form tidak terhapus)
  setInterval(() => {
    let habis = false;
    document.querySelectorAll('[data-exp]').forEach(el => {
      const ms = +el.getAttribute('data-exp') - Date.now();
      if (ms <= 0) { if (isDosen) el.textContent = '00:00'; else habis = true; } else el.textContent = fmt(ms);
    });
    if (habis) render();
  }, 1000);
}

/* ===== HALAMAN LOGIN ===== */
// Petunjuk gulir: muncul bila isi panel putih masih panjang ke bawah (hanya saat panel itu yang bisa digulir)
function initScrollHint() {
  const sc = document.querySelector('.pscroll'), box = document.querySelector('.box'), panel = document.querySelector('.panel');
  if (!sc || !panel) return;
  let f = document.querySelector('.pfade');          // dibuat otomatis bila belum ada di login.html
  if (!f) { f = document.createElement('div'); f.className = 'pfade'; f.setAttribute('aria-hidden', 'true'); panel.appendChild(f); }
  const upd = () => {
    const can = getComputedStyle(sc).overflowY === 'auto' && sc.scrollHeight - sc.clientHeight > 8;
    f.classList.toggle('on', can && sc.scrollHeight - sc.scrollTop - sc.clientHeight > 8);
  };
  sc.addEventListener('scroll', upd, { passive: true });
  window.addEventListener('resize', upd);
  if (window.ResizeObserver && box) new ResizeObserver(upd).observe(box);
  upd();
}
function initLogin(){

if (new URLSearchParams(location.search).has('dihapus')) toast('Akun kamu sudah dihapus permanen.');

function showTab(reg) {
  $('#fLogin').hidden = reg;
  $('#fReg').hidden = !reg;
  $('#tLogin').classList.toggle('on', !reg);
  $('#tReg').classList.toggle('on', reg);
  $('#tLogin').setAttribute('aria-selected', !reg);
  $('#tReg').setAttribute('aria-selected', reg);
  document.querySelector('.auth').classList.toggle('reg', reg);
}
$('#tLogin').onclick = () => showTab(false);
$('#tReg').onclick = () => showTab(true);
$('#toReg').onclick = e => { e.preventDefault(); showTab(true); };
$('#toLogin').onclick = e => { e.preventDefault(); showTab(false); };

function role() { return document.querySelector('input[name=role]:checked').value; }

// ---- Masuk ----
$('#fLogin').addEventListener('submit', async e => {
  e.preventDefault();
  const el = $('#eLogin'), btn = e.target.querySelector('button[type=submit]');
  el.style.color = ''; el.textContent = '';
  const email = $('#lEmail').value.trim().toLowerCase(), pass = $('#lPass').value;
  if (!email || !pass) { el.textContent = 'Isi email dan kata sandi.'; return; }
  btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  btn.disabled = false;
  if (error) {
    el.textContent = /not confirmed/i.test(error.message) ? 'Gmail belum diverifikasi. Buka email dari KelasBelajar dan klik tautan konfirmasinya.'
      : error.status === 400 ? 'Email atau kata sandi salah.' : 'Gagal masuk: ' + error.message;
    return;
  }
  location.href = 'index.html';
});

// ---- Daftar ----
$('#fReg').addEventListener('submit', async e => {
  e.preventDefault();
  const err = m => { $('#eReg').textContent = m; };
  const d = {
    nama: $('#rNama').value.trim(), email: $('#rEmail').value.trim().toLowerCase(),
    id: $('#rId').value.trim(), hp: $('#rHp').value.trim(), prodi: $('#rProdi').value.trim(),
    role: role()
  };
  const p1 = $('#rPass').value, p2 = $('#rPass2').value;
  if (!d.nama) return err('Nama lengkap wajib diisi.');
  if (!isGmail(d.email)) return err('Gunakan alamat Gmail yang valid (akhiran @gmail.com).');
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(d.id)) return err('ID harus 3–30 karakter: huruf, angka, titik, strip, atau garis bawah (tanpa spasi).');
  if (d.prodi.length < 3) return err('Minat belajar wajib diisi (minimal 3 karakter).');
  if (!/^0\d{8,13}$/.test(d.hp)) return err('Nomor HP tidak valid. Contoh: 081234567890.');
  if (p1.length < 8) return err('Kata sandi minimal 8 karakter.');
  if (p1 !== p2) return err('Konfirmasi kata sandi tidak sama.');
  if (!$('#rOk').checked) return err('Centang pernyataan bahwa nama lengkap, peran, dan minat belajar sudah benar.');
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true; err('');
  const { data, error } = await sb.auth.signUp({
    email: d.email, password: p1,
    options: { emailRedirectTo: location.origin + '/profil.html', data: { nama: d.nama, role: d.role, id_user: d.id, hp: d.hp, prodi: d.prodi } }
  });
  btn.disabled = false;
  if (error) return err(/registered|exists/i.test(error.message) ? 'Email ini sudah terdaftar. Silakan masuk.' : 'Gagal mendaftar: ' + error.message);
  if (data.user && data.user.identities && data.user.identities.length === 0) return err('Email ini sudah terdaftar. Silakan masuk.');
  if (data.session) { location.href = 'profil.html?baru=1'; return; }   // lanjut ke profil
  // Fitur "Confirm email" di Supabase aktif: akun bisa dipakai setelah tautan di email diklik.
  showTab(false); $('#lEmail').value = d.email;
  const el = $('#eLogin'); el.style.color = '#1a7f4b';
  el.textContent = '✅ Akun dibuat. Kami mengirim email konfirmasi ke ' + d.email + '. Klik tautan di email itu, lalu masuk di sini.';
});

}

/* ===== HALAMAN PROFIL ===== */
function initProfil(){
let editing = null, pwOpen = false, timer = null, first = true;   // editing: 'data' | 'kontak' | null

if (!Auth.requireLogin()) return;
$('#bOut').onclick = () => Auth.logout();

// Banner profil: cincin kelengkapan profil mengelilingi avatar (terisi sambil menghitung naik) + 3 langkah yang tercentang satu per satu.
function pfScene(u, nMk) {
  const nm = String(u.nama || '?').trim(), ini = esc(nm.charAt(0).toUpperCase());
  const fn = esc(nm.split(/\s+/)[0].replace(/^./, c => c.toUpperCase()));
  const steps = [
    [!!u.verified, 'Gmail terverifikasi', 'Gmail belum terverifikasi', 'shield'],
    [!!String(u.hp || '').trim(), 'No. HP tersimpan', 'No. HP belum diisi', 'mail'],
    [nMk > 0, u.role === 'Pengajar' ? 'Sudah punya pelajaran' : 'Sudah bergabung ke kelas', u.role === 'Pengajar' ? 'Belum punya pelajaran' : 'Belum bergabung ke kelas', 'compass']
  ];
  const done = steps.filter(s => s[0]).length, pct = Math.round(done / steps.length * 100), C = 2 * Math.PI * 50;
  const pesan = done === steps.length ? 'Profilmu sudah lengkap.' : `Tinggal ${steps.length - done} langkah lagi supaya profilmu lengkap.`;
  return `<section class="pfk${done === steps.length ? ' full' : ''}" aria-label="Ringkasan profil" style="--p:${pct / 100};--c:${C.toFixed(1)}">
    <div class="pfk-id">
      <div class="pfk-ring">
        <svg viewBox="0 0 112 112" aria-hidden="true"><circle class="trk" cx="56" cy="56" r="50"/><circle class="bar" cx="56" cy="56" r="50"/></svg>
        <span class="pfk-orbit" aria-hidden="true"><i></i></span>
        <span class="pfk-av" aria-hidden="true">${ini}</span>
        <span class="pfk-pct" role="img" aria-label="Kelengkapan profil ${pct} persen"><b>${pct}</b>%</span>
      </div>
      <div class="pfk-txt"><h1>${esc(sapa()[0])}, ${fn}</h1><p>${esc(u.role)} · ID ${esc(u.id)}</p><p class="pfk-msg">${pesan}</p></div>
    </div>
    <ul class="pfk-list">${steps.map((s, i) => `<li class="${s[0] ? 'ok' : 'no'}" style="--i:${i}"><span class="ck">${sxi(s[0] ? 'check' : s[3])}</span>${s[0] ? s[1] : s[2]}</li>`).join('')}</ul>
  </section>`;
}

function render() {
  const u = Auth.session();
  if (!u) { location.replace('login.html'); return; }
  const idLabel = 'ID';
  setMe(u);

  const baru = new URLSearchParams(location.search).has('baru') && !u.verified;

  // Verifikasi Gmail dilakukan Supabase lewat tautan di email. Kartu ini hanya muncul bila Gmail belum terverifikasi.
  const verif = u.verified ? '' : `<div class="card pfull">
        <div class="row" style="justify-content:space-between"><b>Verifikasi Gmail</b><span class="chip c-no">Belum terverifikasi</span></div>
        <p class="quote">Kami mengirim email konfirmasi ke <b>${esc(u.email)}</b>. Buka emailnya, klik tautan verifikasi, lalu tekan Muat ulang status.</p>
        <div class="row"><button class="btn lime" id="bSend">Kirim ulang email verifikasi</button><button class="btn ghost" id="bCek">Muat ulang status</button></div>
        <p class="err" id="eKode" role="alert"></p>
      </div>`;


  // Data diri terkunci setelah pendaftaran; hanya Kontak (No. HP dan Gmail) yang bisa diubah.
  const dataCard = `<div class="card pf-card" style="--i:1"><div class="pf-h"><span class="pf-hi">${sxi('id')}</span><b>Data diri</b></div>
        <dl class="kv">
          <dt>Nama lengkap</dt><dd>${esc(u.nama)}</dd>
          <dt>Peran</dt><dd>${esc(u.role)}</dd>
          <dt>${idLabel}</dt><dd>${esc(u.id)}</dd>
          <dt>Minat belajar</dt><dd>${esc(u.prodi)}</dd>
        </dl>
        <p class="lock">🔒 Nama lengkap, peran, dan minat belajar tidak dapat diubah setelah pendaftaran.</p></div>`;

  const kontakCard = editing === 'kontak'
    ? `<form id="fKontak" class="card pf-card" style="--i:2" novalidate><div class="pf-h"><span class="pf-hi">${sxi('mail')}</span><b>Ubah kontak</b></div>
        <label class="f">No. HP<input id="eHp" value="${esc(u.hp)}" inputmode="tel" maxlength="16"></label>
        <label class="f">Gmail<input type="email" id="eEmail" value="${esc(u.email)}" autocomplete="email"></label>
        <p class="lock" style="margin:0">Jika Gmail diganti, kamu akan masuk dengan Gmail baru dan perlu memverifikasinya ulang.</p>
        <p class="err" id="eKontak" role="alert"></p>
        <div class="row"><button class="btn lime" type="submit">Simpan</button><button class="btn ghost" type="button" id="bBatalK">Batal</button></div></form>`
    : `<div class="card pf-card" style="--i:2"><div class="row" style="justify-content:space-between"><div class="pf-h"><span class="pf-hi">${sxi('mail')}</span><b>Kontak saya</b></div><button class="btn ghost" id="bEditK">Ubah</button></div>
        <dl class="kv"><dt>No. HP</dt><dd>${esc(u.hp)}</dd><dt>Email</dt><dd>${esc(u.email)}</dd></dl>
        <p class="lock">✏️ No. HP dan Gmail masih bisa diubah. Gmail dipakai untuk masuk dan verifikasi.</p></div>`;

  const r = ringkas(u), isD = u.role === 'Pengajar';
  const aktivitas = `<div class="card pf-card" style="--i:3"><div class="pf-h"><span class="pf-hi">${sxi('compass')}</span><b>${isD ? 'Ringkasan mengajar' : 'Ringkasan belajar'}</b></div>
    <div class="tiles">${r.tiles.map(([n, l], i) => `<div class="tile" style="--i:${i}"><b>${n}</b><span>${l}</span></div>`).join('')}</div></div>`;

  const tgl = u.dibuat ? new Date(u.dibuat).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
  const aman = `<div class="card pf-card" style="--i:4"><div class="pf-h"><span class="pf-hi">${sxi('shield')}</span><b>Keamanan akun</b></div>
    <dl class="kv"><dt>Akun dibuat</dt><dd>${tgl}</dd><dt>Kata sandi</dt><dd>••••••••</dd></dl>
    ${pwOpen ? `<form id="fPw" novalidate style="margin-top:14px">
      <label class="f">Kata sandi saat ini<input type="password" id="pwOld" autocomplete="current-password"></label>
      <label class="f">Kata sandi baru (min. 8 karakter)<input type="password" id="pwNew" autocomplete="new-password"></label>
      <label class="f">Ulangi kata sandi baru<input type="password" id="pwNew2" autocomplete="new-password"></label>
      <p class="err" id="ePw" role="alert"></p>
      <div class="row"><button class="btn lime" type="submit">Simpan kata sandi</button><button class="btn ghost" type="button" id="bPwBatal">Batal</button></div></form>`
      : '<button class="btn ghost" id="bPw" style="margin-top:14px">Ubah kata sandi</button>'}</div>`;

  const mkItems = r.mine.length ? `<div class="mkgrid">${r.mine.map((m, mi) => {
    const d = dec(m);
    const sub = isD ? (m.kelas.map(k => `<span class="code-pill">${esc(k.nama)} · ${esc(k.kode)}</span>`).join(' ') || '<span class="quote">Belum ada kelas</span>') : `<span class="quote">Pengajar: ${esc(m.dosenNama)}</span>`;
    return `<div class="mkitem" style="--i:${mi}"><div class="ic" style="background:${d.col}">${d.ic}</div><div style="min-width:0"><b>${esc(m.nama)}</b><div class="mkb">${sub}</div></div></div>`;
  }).join('')}</div>`
    : `<p class="quote" style="margin:12px 0 0">${isD ? 'Belum ada pelajaran. Buat pelajaran dan kelas di menu Pelajaran.' : 'Belum bergabung ke kelas mana pun. Masukkan kode kelas dari pengajar di menu Pelajaran.'}</p>`;
  const mkCard = `<div class="card pfull pf-card" style="--i:5"><div class="row" style="justify-content:space-between"><div class="pf-h"><span class="pf-hi">${sxi('type')}</span><b>${isD ? 'Pelajaran yang saya ampu' : 'Pelajaran saya'}</b></div><a class="btn ghost" href="index.html#courses">Buka pelajaran →</a></div>${mkItems}</div>`;

  const hapusCard = `<div class="card danger pfull pf-card" style="--i:6"><div class="row" style="justify-content:space-between;align-items:center"><div style="min-width:0;flex:1 1 260px"><b>Hapus akun permanen</b><p class="quote" style="margin:4px 0 0">Menghapus akun akan menghapus seluruh data milikmu dan tidak bisa dibatalkan.</p></div><button class="btn red" id="bHapus">Hapus akun permanen</button></div></div>`;

  const scene = pfScene(u, r.mine.length);
  const anim = first; first = false; $('#view').classList.toggle('pf-in', anim);

  $('#view').innerHTML = `
    ${scene}
    ${baru ? '<div class="card note">🎉 Akun berhasil dibuat. Satu langkah lagi: verifikasi Gmail kamu di bawah ini.</div>' : ''}
    ${verif}
    <div class="pcols">${dataCard}${kontakCard}${aktivitas}${aman}</div>
    ${mkCard}${hapusCard}`;

  bind(u);
  if (anim) pfCount();
}

// Angka di profil menghitung naik saat halaman pertama dibuka (dilewati bila animasi dikurangi)
function pfCount() {
  if (document.documentElement.classList.contains('no-anim') || (window.matchMedia && matchMedia('(prefers-reduced-motion:reduce)').matches)) return;
  document.querySelectorAll('#view .tile b, #view .pfk-pct b').forEach(el => {
    const t = el.textContent; if (!/\d/.test(t)) return;
    const t0 = performance.now(), D = 900;
    const step = now => {
      const k = Math.min(1, (now - t0) / D), e = 1 - Math.pow(1 - k, 3);
      el.textContent = k < 1 ? t.replace(/\d+(\.\d+)?/g, m => { const v = parseFloat(m) * e; return m.includes('.') ? v.toFixed(1) : Math.round(v); }) : t;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function bind(u) {
  const on = (id, fn) => { const e = $(id); if (e) e.onclick = fn; };
  on('#bSend', async () => {
    const b = $('#bSend'), say = m => { $('#eKode').textContent = m; };
    b.disabled = true; say('');
    const { error } = await sb.auth.resend({ type: 'signup', email: u.email, options: { emailRedirectTo: location.origin + '/profil.html' } });
    if (error) { say('Gagal mengirim email: ' + error.message); setTimeout(() => { b.disabled = false; }, 5000); return; }
    toast('Email verifikasi dikirim ke ' + u.email);
    setTimeout(() => { b.disabled = false; }, 60000);
  });
  on('#bCek', async () => { try { await sb.auth.refreshSession(); } catch (e) {} location.href = 'profil.html'; });
  on('#bEditK', () => { editing = 'kontak'; pwOpen = false; render(); });
  on('#bBatalK', () => { editing = null; render(); });
  on('#bPw', () => { pwOpen = true; editing = null; render(); });
  on('#bPwBatal', () => { pwOpen = false; render(); });
  on('#bHapus', () => hapusModal());
  const fk = $('#fKontak');
  if (fk) fk.onsubmit = async e => {
    e.preventDefault();
    const err = m => { $('#eKontak').textContent = m; };
    const hp = $('#eHp').value.trim(), em = $('#eEmail').value.trim().toLowerCase(), ganti = em !== u.email;
    if (!/^0\d{8,13}$/.test(hp)) return err('Nomor HP tidak valid. Contoh: 081234567890.');
    if (!isGmail(em)) return err('Gunakan alamat Gmail yang valid (akhiran @gmail.com).');
    if (ganti) {
      // Supabase mengirim email konfirmasi ke Gmail baru; Gmail baru berlaku setelah tautannya diklik.
      const { error } = await sb.auth.updateUser({ email: em }, { emailRedirectTo: location.origin + '/profil.html' });
      if (error) return err(/already|registered|exists/i.test(error.message) ? 'Gmail ini sudah dipakai akun lain.' : 'Gagal mengganti Gmail: ' + error.message);
    }
    Auth.update(u.email, { hp });
    editing = null; render();
    toast(ganti ? 'Email konfirmasi dikirim ke Gmail baru. Gmail berganti setelah kamu klik tautannya.' : 'Kontak diperbarui');
  };
  const fp = $('#fPw');
  if (fp) fp.onsubmit = async e => {
    e.preventDefault();
    const say = m => { $('#ePw').textContent = m; };
    const lama = $('#pwOld').value, baru = $('#pwNew').value, ulang = $('#pwNew2').value;
    const chk = await sb.auth.signInWithPassword({ email: u.email, password: lama });
    if (chk.error) return say('Kata sandi saat ini salah.');
    if (baru.length < 8) return say('Kata sandi baru minimal 8 karakter.');
    if (baru === lama) return say('Kata sandi baru harus berbeda dari yang lama.');
    if (baru !== ulang) return say('Konfirmasi kata sandi baru tidak sama.');
    const { error } = await sb.auth.updateUser({ password: baru });
    if (error) return say('Gagal mengubah kata sandi: ' + error.message);
    pwOpen = false; render(); toast('Kata sandi diperbarui');
  };
}

// Hapus akun permanen: peringatan dampak + ketik HAPUS + kata sandi
function dampak(u) {
  const out = ['Akunmu beserta seluruh datamu (nama, kontak, kata sandi) dihapus dan <b>tidak bisa dipulihkan</b>.'];
  if (u.role === 'Pengajar') {
    const mine = st.mk().filter(m => m.dosen === u.email); let kelas = 0, pert = 0, mhs = 0;
    mine.forEach(m => { kelas += m.kelas.length; mhs += studentsOf(m.id).length; m.kelas.forEach(k => { pert += k.pert.length; }); });
    out.push(`<b>${mine.length} pelajaran</b>, <b>${kelas} kelas</b>, dan <b>${pert} pertemuan</b> (materi, tugas, quiz) ikut terhapus.`);
    out.push(`<b>${mhs} partisipan</b> akan kehilangan kelasnya beserta absen, tugas yang dikirim, nilai, dan hasil quiz mereka.`);
  } else {
    const n = st.jn().filter(j => j.mhs === u.email).length;
    out.push(`Kamu keluar dari <b>${n} pelajaran</b>; absen, tugas yang dikirim, nilai, dan hasil quiz-mu ikut terhapus.`);
  }
  out.push('Gmail dan ID ini bisa dipakai mendaftar lagi, tetapi data lama tidak akan kembali.');
  return out;
}
function hapusModal() {
  const u = Auth.session(); if (!u) return;
  $('#layer').innerHTML = `<div class="modal" id="mdl"><div class="sheet" role="dialog" aria-modal="true" aria-label="Hapus akun permanen"><button class="xbtn" id="xHapus" aria-label="Tutup jendela">✕</button>
    <h3>⚠️ Hapus akun secara permanen?</h3>
    <div class="warnbox" style="border-color:#e8a0a0;background:#fdeaea">Tindakan ini <b>tidak bisa dibatalkan</b>. Baca dampaknya sebelum melanjutkan:</div>
    <ul class="dampak">${dampak(u).map(t => `<li>${t}</li>`).join('')}</ul>
    <div class="fg" style="margin-top:12px"><label class="f">Ketik <b>HAPUS</b> untuk melanjutkan<input id="hKonf" autocomplete="off"></label>
    <label class="f">Kata sandi saat ini<input type="password" id="hPw" autocomplete="current-password"></label>
    <p class="err" id="eHapus" role="alert"></p>
    <div class="row"><button class="btn ghost" id="bHapusBatal">Batal, simpan akunku</button><button class="btn red" id="bHapusOk">Hapus akun permanen</button></div></div></div></div>`;
  const tutup = () => { $('#layer').innerHTML = ''; };
  $('#xHapus').onclick = tutup; $('#bHapusBatal').onclick = tutup;
  $('#mdl').onclick = e => { if (e.target.id === 'mdl') tutup(); };
  $('#bHapusOk').onclick = async () => {
    const say = m => { $('#eHapus').textContent = m; };
    if ($('#hKonf').value.trim() !== 'HAPUS') return say('Ketik HAPUS (huruf kapital) untuk mengonfirmasi.');
    const chk = await sb.auth.signInWithPassword({ email: u.email, password: $('#hPw').value });
    if (chk.error) return say('Kata sandi salah.');
    const { error } = await sb.rpc('delete_my_account');
    if (error) return say('Gagal menghapus akun: ' + error.message);
    try { await sb.auth.signOut({ scope: 'local' }); } catch (e) {}
    location.href = 'login.html?dihapus=1';
  };
  $('#hKonf').focus();
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#layer').innerHTML = ''; });
render();

}

/* ===== JALANKAN HALAMAN YANG AKTIF ===== */
const ftEl = PAGE === 'login' ? null : $('#foot'); if (ftEl) ftEl.innerHTML = footerHtml();   // login: tanpa footer
(async function boot() {
  try {
    if (/GANTI/.test(SUPABASE_URL) || /GANTI/.test(SUPABASE_ANON_KEY)) throw new Error('Konfigurasi Supabase belum diisi. Buka app.js lalu isi SUPABASE_URL dan SUPABASE_ANON_KEY.');
    if (PAGE === 'login') {
      const { data: { session } } = await sb.auth.getSession();
      if (session) { location.replace('index.html'); return; }
      initLogin(); initScrollHint(); return;
    }
    if (!(await loadAll())) { location.replace('login.html'); return; }
    applyPref();
    if (PAGE === 'beranda') {
      U = Auth.session(); isDosen = U.role === 'Pengajar';
      initBeranda();
      document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
      setInterval(() => { if (!document.hidden) refresh(); }, 60000);
    }
    if (PAGE === 'profil') initProfil();
  } catch (e) {
    console.error(e);
    document.body.innerHTML = '<div style="padding:40px;font-family:system-ui,sans-serif;max-width:560px"><h2>Gagal memuat data</h2><p>' + esc((e && e.message) || e) + '</p><p>Periksa koneksi internet dan konfigurasi Supabase, lalu muat ulang halaman.</p></div>';
  }
})();
