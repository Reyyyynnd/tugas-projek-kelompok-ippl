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
const prefOf = u => ({ fs: 'normal', dl: true, ab: true, nl: true, tour: false, ...((u && u.pref) || {}) });
function applyPref() { const u = Auth.session(); if (document.documentElement) document.documentElement.setAttribute('data-fs', prefOf(u).fs); }
// Info pengguna di bilah atas: nama, lencana peran yang jelas, dan ID
function setMe(u) {
  const g = id => document.getElementById(id);
  g('meAv').textContent = (u.nama || '?').charAt(0).toUpperCase();
  g('meName').textContent = u.nama;
  g('meSub').innerHTML = `<span class="rolechip ${u.role === 'Pengajar' ? 'pg' : 'pt'}">${esc(u.role)}</span><span class="idtxt">ID ${esc(u.id)}</span>`;
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
const TOTAL = 16;
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
const legacyFile = f => !!f && itemsOf(f).length === 0;
// Materi, instruksi tugas, dan instruksi quiz masing-masing bisa berisi sampai 5 lampiran (file atau link). Format lama tetap terbaca.
const asList = v => !v ? [] : Array.isArray(v) ? v : [v];
const fixTipe = it => it.tipe ? it : { ...it, tipe: 'file' };
const matOf = x => asList(x.materi).map(fixTipe), tlOf = x => asList(x.tugasLamp || x.tugasFile).map(fixTipe), qlOf = x => asList(x.quizLamp).map(fixTipe);
const adaQuiz = x => x.quiz.length > 0 || qlOf(x).length > 0;
// Quiz selesai: soal sudah dikerjakan (jika ada soal) DAN quiz tautan/berkas sudah ditandai selesai atau dikirim hasilnya (jika ada)
const quizDone = (p, x) => (!x.quiz.length || p.quiz[x.n] != null) && (!qlOf(x).length || !!p.qext[x.n]);
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
  const k = dkey(m.id, x.n, t), a = `'${m.id}',${x.n},'${t}'`, d = S.draft[k] || [], tot = d.reduce((s2, it) => s2 + (it.size || 0), 0), penuh = d.length >= MAX_LAMP;
  return `<div class="draft"><div class="quote"><b>Lampiran</b> · ${d.length}/${MAX_LAMP} (file atau link)${d.length ? ' · ' + sizeTxt(tot) : ''}</div>
    ${d.map((it, i) => lampRow(it, `<button class="btn ghost sm dng" onclick="hapusDraft(${a},${i})" aria-label="Hapus lampiran ${i + 1}">✕ Hapus</button>`)).join('')}
    ${penuh ? '<div class="quote">Batas 5 lampiran tercapai. Hapus salah satu untuk menambah yang lain.</div>' : `<div class="row" style="margin-top:8px"><input type="file" multiple id="fd-${k}" aria-label="Pilih file" onchange="tambahFile(${a})"></div>
    <div class="row"><input class="lnk" id="ld-${k}" placeholder="https://… (link, mis. Google Drive atau GitHub)" aria-label="Link" onkeydown="if(event.key==='Enter')tambahLink(${a})"><button class="btn ghost sm" onclick="tambahLink(${a})">+ Tambah link</button></div>`}
    <div class="row" style="margin-top:10px"><button class="btn lime" ${d.length ? '' : 'disabled'} onclick="send(${a})">${label}${d.length ? ' (' + d.length + ' lampiran)' : ''}</button></div>
    <div class="quote">Maksimal ${MAX_LAMP} lampiran. Tiap file maks. 1,5 MB, total maks. 3 MB. Lampiran bisa dihapus sebelum dikirim.</div></div>`;
};
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
const dec = m => { const i = [...m.id].reduce((a, c) => a + c.charCodeAt(0), 0) % IC.length; return { ic: IC[i], col: CL[i] }; };
const QUOTE = '“Keberhasilan adalah jumlah usaha kecil yang diulang setiap hari.” – Robert Collier';
const banner = () => U.verified ? '' : '<div class="card warn">⚠️ Gmail kamu belum diverifikasi. <a href="profil.html"><b>Verifikasi sekarang</b></a></div>';
const head = () => heroB() + banner();
const empty = (ic, t, d, btn) => `<div class="card empty-s"><div class="big-ic">${ic}</div><h3>${t}</h3><p class="quote">${d}</p>${btn}</div>`;
const sc = (l, v, ic, bg, c, sub, cls, act) => `<div class="card stat${act ? ' click' : ''}"${act ? ` role="button" tabindex="0" onclick="${act}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}"` : ''}><div><div class="l">${l}</div><div class="v"${c ? ` style="color:${c}"` : ''}>${typeof v === 'number' ? `<span class="cnt" data-to="${v}">${v}</span>` : v}</div>${sub ? `<div class="ssub">${sub}</div>` : ''}</div><div class="ic ${cls || ''}" style="background:${bg}">${ic}</div>${act ? '<span class="more">Lihat detail ›</span>' : ''}</div>`;
const kp = (l, v, s) => `<div class="card kp"><div class="l">${l}</div><div class="v">${v}</div>${s ? `<div class="meta"><span>${s}</span></div>` : ''}</div>`;
const hdr = (m, sub) => { const d = dec(m); return `<div class="row" style="margin-bottom:14px"><div class="ic" style="background:${d.col};width:50px;height:50px;font-size:24px">${d.ic}</div><div><h1 style="font-size:24px">${esc(m.nama)}</h1><div class="quote">${m.kode ? esc(m.kode) + ' · ' : ''}${sub}</div></div></div>`; };
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
  return `<div class="courses">${L.map(m => {
    const d = dec(m); let sub, foot, held;
    if (isDosen) {
      held = m.kelas.length ? totalPert(m) / m.kelas.length : 0; sub = `${m.kelas.length} kelas · ${studentsOf(m.id).length} partisipan`;
      foot = `<span>Pertemuan berjalan ${totalPert(m)} (semua kelas)</span><span>${m.kelas.length ? 'Lihat kelas →' : '<b style="color:var(--red)">Belum ada kelas</b>'}</span>`;
    } else {
      const s2 = stats(m, U.email); held = s2.held; sub = esc(m.dosenNama);
      const mw = [s2.todoT && `${s2.todoT} tugas`, s2.todoQ && `${s2.todoQ} quiz`].filter(Boolean).join(' & ');
      foot = `<span>Pertemuan ${s2.held}/${TOTAL}</span><span>${mw ? `<b style="color:var(--red)">${mw} menunggu</b>` : 'Tugas beres'}</span>`;
    }
    return `<button class="course" onclick="go('course','${m.id}')"><div class="hd"><div class="ic" style="background:${d.col}">${d.ic}</div><div><b>${esc(m.nama)}</b><span class="s">${sub}</span></div></div><div class="bar"><i style="width:${held / TOTAL * 100}%"></i></div><div class="meta">${foot}</div></button>`;
  }).join('')}</div>`;
}

// ---------- BERANDA ----------
// Ringkasan nyata dari data kelas, absen, dan tugas milik pengguna ini
function ringkas(u) {
  if (u.role === 'Pengajar') {
    const mine = st.mk().filter(m => m.dosen === u.email); let kelas = 0, mhs = 0, pert = 0, kirim = 0, nilai = 0;
    mine.forEach(m => m.kelas.forEach(k => {
      kelas++; pert += k.pert.length; const ss = studentsOf(m.id, k.id); mhs += ss.length;
      k.pert.filter(x => x.tugas).forEach(x => ss.forEach(w => { const q = P(m.id, w.email); if (q.sub[x.n]) { kirim++; if (!q.nilai[x.n]) nilai++; } }));
    }));
    return { mine, tiles: [[mine.length, 'Pelajaran diampu'], [kelas, 'Total kelas'], [mhs, 'Partisipan'], [pert, 'Pertemuan dibuat'], [kirim, 'Tugas terkumpul'], [nilai, 'Perlu dinilai']] };
  }
  const L = st.jn().filter(j => j.mhs === u.email).map(j => getMk(j.mkId)).filter(Boolean); let hadir = 0, held = 0, tasks = 0, done = 0; const skor = [];
  L.forEach(m => { const q = stats(m, u.email); hadir += q.hadir; held += q.held; tasks += q.tasks; done += q.done; Object.values(P(m.id, u.email).nilai).forEach(nl => { if (nl.skor != null) skor.push(nl.skor); }); });
  const avg = skor.length ? Math.round(skor.reduce((x, y) => x + y, 0) / skor.length * 10) / 10 : '—';
  return { mine: L, tiles: [[L.length, 'Pelajaran diikuti'], [hadir + '/' + held, 'Pertemuan dihadiri'], [held ? Math.round(hadir / held * 100) + '%' : '—', 'Tingkat kehadiran'], [done + '/' + tasks, 'Tugas & quiz selesai'], [tasks - done, 'Perlu dikerjakan'], [avg, 'Rata-rata nilai tugas']] };
}

// Tugas/quiz yang batasnya kurang dari 24 jam lagi
const soonHtml = (todo, pf) => {
  const now = Date.now(), t = pf.dl === false ? [] : todo.filter(([m, x, k, dl]) => dl && dl > now && dl - now < 864e5);
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
    return hero + (nDinilai > 0 && pfD.nl !== false ? `<div class="card absen"><div><b>📝 ${nDinilai} tugas menunggu penilaian</b><div class="quote">Buka Pelajaran, pilih kelas, lalu Pertemuan → Pengumpulan.</div></div><button class="btn lime" onclick="go('courses')">Buka pelajaran</button></div>` : '') + `<h2>Ringkasan</h2><div class="grid3">${sc('Pelajaran', L.length, '📚', '#e8f1ff', '', '', '', "go('courses')")}${sc('Total kelas', kls, '🏷️', '#fff0d2', '', '', '', "go('courses')")}${sc('Partisipan bergabung', mhs, '🎒', '#dff5e8', '', '', '', "go('courses')")}</div><h2>Pelajaran</h2>${courseCards(L)}`;
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
    + `<h2>Progres keseluruhan</h2><div class="grid3">${sc('Tugas yang harus diselesaikan', t.todo, '📝', '#fff0d2', t.todo ? 'var(--red)' : '', subTodo, '', "statDetail('todo')")}${sc('Total tugas selesai', t.done, '✅', '#dff5e8', '', t.tasks ? `dari ${t.tasks} tugas &amp; quiz` : '', '', "statDetail('done')")}${sc('Total pertemuan', t.held, miniRing(pct), 'transparent', '', subHadir, 'mr', "statDetail('pert')")}</div>`
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
      if (adaQuiz(x) && quizDone(p, x)) rows.push({ m, x, chip: ['Quiz', 'c-ok'], note: 'Selesai' });
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
function bukaItem(mkId, n) { S.view = 'course'; S.cid = mkId; S.open[mkId + '-' + n] = true; render(); window.scrollTo(0, 0); }

// ---------- MATA KULIAH ----------
function coursesPage() {
  const L = myMk();
  const top = `<div class="row" style="justify-content:space-between"><div><h1>Pelajaran</h1><p class="quote">${isDosen ? 'Pilih pelajaran, lalu kelasnya untuk mengatur pertemuan.' : 'Pilih pelajaran untuk melihat absen, tugas, materi, dan quiz.'}</p></div>${isDosen ? '<button class="btn lime" onclick="mkModal()">+ Buat pelajaran</button>' : '<button class="btn lime" onclick="joinModal()">+ Masuk kelas</button>'}</div>`;
  if (!L.length) return top + (isDosen ? empty('📚', 'Belum ada pelajaran', 'Buat pelajaran, lalu buat kelas beserta kode kelas untuk dibagikan ke partisipan.', btnMk) : empty('🔑', 'Belum ada pelajaran', 'Masuk kelas dengan kode dari pengajar untuk melihat pelajaranmu.', btnJoin));
  return top + `<div style="margin-top:16px">${courseCards(L)}</div>`;
}
function coursePage() {
  const m = getMk(S.cid);
  if (!m || !myMk().some(x => x.id === m.id)) { S.view = 'courses'; return coursesPage(); }
  return isDosen ? courseD(m) : courseM(m);
}

// --- tampilan partisipan (hanya nama pelajaran, bukan nama kelas) ---
function courseM(m) {
  const s2 = stats(m, U.email), p = P(m.id, U.email), pt = pertOf(m, U.email), pct = s2.held ? Math.round(s2.hadir / s2.held * 100) : 0;
  return `<button class="back" onclick="go('courses')"><span class="arr" aria-hidden="true">←</span> Kembali ke Semua pelajaran</button>${hdr(m, 'Pengajar: ' + esc(m.dosenNama) + (m.jadwal ? ' · ' + esc(m.jadwal) : ''))}
  <div class="row" style="margin:-4px 0 16px"><button class="btn ghost dng" onclick="keluarModal('${m.id}')">🚪 Keluar dari pelajaran</button></div>
  <div class="grid4">${kp('Kehadiran', `${s2.hadir}<small>/${s2.held}</small>`, pct + '% hadir')}${kp('Total pertemuan', `${s2.held}<small>/${TOTAL}</small>`)}${kp('Tugas selesai', `${s2.done}<small>/${s2.tasks}</small>`)}${kp('Perlu dikerjakan', `<span style="color:${s2.todo ? 'var(--red)' : 'inherit'}">${s2.todo}</span>`)}</div>
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
    body = `<div class="body"><div class="blk"><h4>Absensi</h4>${ab}</div><div class="blk"><h4>Materi</h4>${matOf(x).length ? lampList(matOf(x), 'mat', m.id, x.n) : '<span class="empty">Pengajar belum membagikan materi.</span>'}</div>`;
    if (x.tugas) {
      const f = p.sub[x.n], nl = p.nilai[x.n], kb = p.kembali[x.n], lg = legacyFile(f), late = over(x.tugasDl) && !lg && !kb;
      const upload = draftUI(m, x, 't', f || kb ? 'Kirim ulang tugas' : 'Kirim tugas');
      const nilaiHtml = nl ? `<div class="nilai">✅ Sudah dinilai${nl.skor != null ? ` · Nilai <b>${nl.skor}</b>` : ''}${nl.cat ? `<div class="quote">Catatan pengajar: ${esc(nl.cat)}</div>` : ''}</div>` : '<div class="quote" style="margin-top:6px">Menunggu penilaian pengajar.</div>';
      body += `<div class="blk"><h4>Tugas pertemuan ${x.n} ${dlChip(x.tugasDl)}</h4><p style="margin:0 0 8px">${esc(x.tugas)}</p>`
        + (tlOf(x).length ? `<div class="quote"><b>Instruksi tugas</b></div>${lampList(tlOf(x), 'tl', m.id, x.n)}<div style="height:8px"></div>` : '')
        + (f
          ? `<div class="row"><span class="chip c-ok">Terkirim</span><span style="font-size:13px">${subAt(f) ? fmtDt(subAt(f)) : ''}</span>${lg || nl || late ? '' : `<button class="btn ghost" onclick="unsend('${m.id}',${x.n})">Kirim ulang</button>`}</div>`
            + (itemsOf(f).length ? `<div class="ditems">${lampList(itemsOf(f), 'sub', m.id, x.n)}</div>` : `<div class="quote">${esc(subName(f))}</div>`)
            + (lg ? '<div class="warnbox">⚠️ Berkas yang kamu kirim sebelumnya tidak tersimpan, jadi pengajar tidak bisa membukanya. Kirim ulang berkasnya (nilai yang sudah ada tetap dipertahankan).</div>' : '')
            + nilaiHtml + (lg ? upload : '')
          : (kb ? `<div class="warnbox">↩️ <b>Tugas dikembalikan pengajar</b> untuk diperbaiki${kb.lama ? ' (berkas sebelumnya: ' + esc(kb.lama) + ')' : ''}.${kb.cat ? `<div class="quote">Catatan pengajar: ${esc(kb.cat)}</div>` : ''}</div>` : '') + (late ? '<span class="empty">Batas waktu pengumpulan sudah lewat. Hubungi pengajar jika perlu.</span>' : upload)) + '</div>';
    }
    if (adaQuiz(x)) {
      const late = over(x.quizDl), sq = p.quiz[x.n], qe = p.qext[x.n];
      let q = `<div class="blk"><h4>Quiz ${dlChip(x.quizDl)}</h4>`;
      if (x.quiz.length) q += `<div class="row">${sq != null ? `<span class="chip c-bl">Nilai ${sq}</span>${late ? '' : `<button class="btn ghost" onclick="quiz('${m.id}',${x.n})">Kerjakan ulang</button>`}` : late ? '<span class="empty">Batas waktu quiz sudah lewat.</span>' : `<span>Quiz soal dari pengajar (${x.quiz.length} soal).</span><button class="btn lime" onclick="quiz('${m.id}',${x.n})">Kerjakan quiz</button>`}</div>`;
      if (qlOf(x).length) {
        q += `<div class="quote" style="margin-top:${x.quiz.length ? 10 : 0}px"><b>Instruksi / link quiz</b></div>${lampList(qlOf(x), 'ql', m.id, x.n)}`;
        if (qe) q += `<div class="row" style="margin-top:8px"><span class="chip c-ok">Selesai</span><span style="font-size:13px">${(qe.items || []).length ? 'Hasil dikirim ' : 'Ditandai selesai '}${fmtDt(qe.at)}</span>${late ? '' : `<button class="btn ghost sm" onclick="batalQext('${m.id}',${x.n})">Batalkan</button>`}</div>${(qe.items || []).length ? `<div class="ditems">${lampList(qe.items, 'qx', m.id, x.n)}</div>` : ''}`;
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
  inp.value = ''; render();
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
  const p = P(mkId, U.email); delete p.qext[n]; setP(mkId, U.email, p); render();
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
    return `<button class="course" onclick="bukaKelas('${k.id}')"><div class="hd"><div class="ic" style="background:var(--limeS);font-weight:800">${esc(k.nama.trim().slice(-1).toUpperCase())}</div><div><b>${esc(k.nama)}</b><span class="s">${n} partisipan</span></div><span class="code-pill" style="margin-left:auto">${esc(k.kode)}</span></div><div class="bar"><i style="width:${k.pert.length / TOTAL * 100}%"></i></div><div class="meta"><span>Pertemuan ${k.pert.length}/${TOTAL}</span><span>Buka kelas →</span></div></button>`;
  }).join('');
  return `<button class="back" onclick="go('courses')"><span class="arr" aria-hidden="true">←</span> Kembali ke Semua pelajaran</button>${hdr(m, esc(m.jadwal || 'Pelajaran saya'))}
  <div class="row" style="margin:-4px 0 16px"><button class="btn ghost" onclick="mkModal('${m.id}')">✏️ Ubah pelajaran</button><button class="btn ghost dng" onclick="hapusMkModal('${m.id}')">🗑 Hapus pelajaran</button></div>
  <div class="grid3">${kp('Kelas', m.kelas.length)}${kp('Partisipan bergabung', studentsOf(m.id).length)}${kp('Pertemuan berjalan', totalPert(m), 'total dari semua kelas')}</div>
  <h2>Kelas</h2>${cards ? `<div class="courses">${cards}</div>` : '<p class="empty">Belum ada kelas. Buat kelas pertama di bawah.</p>'}
  <div class="card" style="margin-top:16px"><b>Buat kelas baru</b><p class="quote">Contoh: nama "Kelas A", kode "PBO-A". Kode inilah yang diberikan ke partisipan.</p>
  <div class="two" style="margin-top:10px"><label class="f">Nama kelas<input id="kNama" placeholder="Kelas A" maxlength="30"></label>
  <label class="f">Kode kelas<span class="row" style="flex-wrap:nowrap"><input id="kKode" placeholder="PBO-A" maxlength="16" style="text-transform:uppercase"><button type="button" class="btn ghost" onclick="acak('${m.id}')">Acak</button></span></label></div>
  <p class="err" id="kErr" role="alert"></p><button class="btn lime" style="margin-top:8px" onclick="addKelas('${m.id}')">Tambah kelas</button></div>`;
}
function bukaKelas(kid) { S.view = 'kelas'; S.kid = kid; S.edit = null; S.pfKey = null; render(); window.scrollTo(0, 0); }
function bukaPert() { S.view = 'pert'; S.edit = null; S.pfKey = null; render(); window.scrollTo(0, 0); }
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
  if (await kodeDipakai(kode, null, e)) return;
  const m = getMk(mkId); m.kelas.push({ id: uid('k'), nama, kode, pert: [] });
  if (!saveMk(m)) { e.textContent = 'Gagal menyimpan data.'; return; }
  render(); toast('Kelas dibuat. Kode: ' + kode);
}
function salin(kode) {
  try { navigator.clipboard.writeText(kode).then(() => toast('Kode disalin: ' + kode), () => toast('Kode kelas: ' + kode)); } catch (e) { toast('Kode kelas: ' + kode); }
}

// --- tampilan pengajar: satu kelas (kode, jumlah partisipan, pertemuan berjalan) ---
function ctxKelas() {
  const m = getMk(S.cid), k = getKelas(m, S.kid);
  return isDosen && m && k && m.dosen === U.email ? { m, k } : null;
}
function kelasPage() {
  const c = ctxKelas(); if (!c) { S.view = 'courses'; return coursesPage(); }
  const { m, k } = c, ss = studentsOf(m.id, k.id);
  return `<button class="back" onclick="go('course','${m.id}')"><span class="arr" aria-hidden="true">←</span> Kembali ke ${esc(m.nama)}</button>${hdr(m, 'Kelas: ' + esc(k.nama))}
  <div class="row" style="margin:-4px 0 16px"><button class="btn ghost" onclick="kelasModal()">✏️ Ubah kelas</button><button class="btn ghost dng" onclick="hapusKelasModal()">🗑 Hapus kelas</button></div>
  <div class="grid3"><div class="card kp"><div class="l">Kode kelas</div><div style="margin:8px 0"><span class="code-pill big">${esc(k.kode)}</span></div><button class="btn ghost" onclick="salin('${esc(k.kode)}')">Salin kode</button></div>
  ${kp('Partisipan bergabung', ss.length)}${kp('Pertemuan berjalan', `${k.pert.length}<small>/${TOTAL}</small>`)}</div>
  <div class="row" style="margin-top:18px"><button class="btn lime" onclick="bukaPert()">Info selengkapnya →</button><span class="quote">Atur materi, tugas, quiz, dan absensi untuk ${esc(k.nama)}.</span></div>
  <h2>Partisipan (${ss.length})</h2><div class="card">${ss.length ? ss.map(u => `<div class="srow"><b>${esc(u.nama)}</b><span>${esc(u.id)} · ${esc(u.email)}</span></div>`).join('') : '<span class="empty">Belum ada partisipan yang bergabung. Bagikan kode kelas di atas.</span>'}</div>`;
}

// --- tampilan pengajar: pertemuan sebuah kelas ---
const qzText = qz => qz.map(q => [q.q, ...q.o, q.a + 1].join(' | ')).join('\n');
// Penyusun lampiran di form pengajar (materi, instruksi tugas, instruksi quiz). Disimpan di S.pf agar tidak hilang saat tampilan diperbarui.
const ALB = { mat: 'Materi', tl: 'Lampiran instruksi tugas', ql: 'Link / file untuk quiz' };
function pfInit(k, e) {
  const key = (e ? 'e' + e.n : 'n' + k.pert.length) + ':' + k.id;
  if (S.pfKey !== key) { S.pfKey = key; S.pf = { mat: e ? matOf(e).slice() : [], tl: e ? tlOf(e).slice() : [], ql: e ? qlOf(e).slice() : [] }; }
}
function lampEditorInner(kind) {
  const d = S.pf[kind], tot = d.reduce((a, it) => a + (it.size || 0), 0), penuh = d.length >= MAX_LAMP;
  return `<div class="quote"><b>${ALB[kind]}</b> · ${d.length}/${MAX_LAMP} (file atau link)${d.length ? ' · ' + sizeTxt(tot) : ''}</div>
    ${d.map((it, i) => lampRow(it, `<button type="button" class="btn ghost sm dng" onclick="pfHapus('${kind}',${i})" aria-label="Hapus lampiran ${i + 1}">✕ Hapus</button>`)).join('')}
    ${penuh ? '<div class="quote">Batas 5 lampiran tercapai. Hapus salah satu untuk menambah yang lain.</div>' : `<div class="row" style="margin-top:8px"><input type="file" multiple id="pf-f-${kind}" aria-label="Pilih file" onchange="pfFile('${kind}')"></div>
    <div class="row"><input class="lnk" id="pf-l-${kind}" placeholder="https://… (link, mis. Google Drive, YouTube, Google Form)" aria-label="Link" onkeydown="if(event.key==='Enter'){event.preventDefault();pfLink('${kind}')}"><button type="button" class="btn ghost sm" onclick="pfLink('${kind}')">+ Tambah link</button></div>`}
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
  const msg = addLink(S.pf[kind], inp.value.trim()); if (msg) { toast(msg); return; } inp.value = ''; pfRefresh(kind);
}
function pfHapus(kind, i) { if (S.pf) S.pf[kind].splice(i, 1); pfRefresh(kind); }

function pertPage() {
  const c = ctxKelas(); if (!c) { S.view = 'courses'; return coursesPage(); }
  const { m, k } = c, ss = studentsOf(m.id, k.id), e = S.edit ? k.pert.find(x => x.n === S.edit) : null;
  const list = k.pert.map(x => {
    const ab = x.absen && x.absen.dur > 0 ? (absenOpen(x) ? `Absen dibuka · sisa ${cd(x)}` : `Absen mandiri ditutup (${x.absen.dur} mnt)`) : 'Tanpa absen mandiri';
    const kt = x.tugas ? `Tugas ${ss.filter(u => P(m.id, u.email).sub[x.n]).length}/${ss.length} terkumpul` : '', kq = adaQuiz(x) ? `Quiz ${ss.filter(u => quizDone(P(m.id, u.email), x)).length}/${ss.length} selesai` : '';
    return `<div class="mt"><div class="prow"><div class="n">${x.n}</div><div class="t">${esc(x.topik)}<small>${[ab, matOf(x).length ? 'Materi ' + matOf(x).length : '', kt, kq].filter(Boolean).join(' · ')}</small></div>${x.tugas || adaQuiz(x) ? `<button class="btn ghost" onclick="kumpulModal(${x.n})">Pengumpulan</button>` : ''}<button class="btn ghost" onclick="absenModal(${x.n})">Absensi</button><button class="btn ghost" onclick="editPert(${x.n})">Edit</button></div></div>`;
  }).join('') || '<p class="empty">Belum ada pertemuan. Tambahkan pertemuan pertama di bawah.</p>';
  const del = k.pert.length && !e ? '<button class="btn ghost" style="margin-top:4px" onclick="delPert()">Hapus pertemuan terakhir</button>' : '';
  const head2 = `<button class="back" onclick="bukaKelas('${k.id}')"><span class="arr" aria-hidden="true">←</span> Kembali ke ${esc(k.nama)}</button>${hdr(m, 'Pertemuan · ' + esc(k.nama) + ' · ' + ss.length + ' partisipan')}<h2>Daftar pertemuan</h2>`;
  if (!e && k.pert.length >= TOTAL) return head2 + list + del + '<p class="empty" style="margin-top:14px">Semua 16 pertemuan kelas ini sudah dibuat.</p>';
  pfInit(k, e);
  const v = e || { topik: '', tugas: '', quiz: [], tugasDl: null, quizDl: null }, dur = e ? (e.absen ? e.absen.dur : 0) : 5;
  const adaQ = e ? adaQuiz(e) : false, tg = box => `onchange="document.getElementById('${box}').hidden=!this.checked"`;
  const dlBox = (chk, box, inp, ts) => `<label class="chk"><input type="checkbox" id="${chk}" ${ts ? 'checked' : ''} ${tg(box)}> Pakai batas waktu</label><div id="${box}" ${ts ? '' : 'hidden'}><label class="f">Batas (tanggal & jam)<input type="datetime-local" id="${inp}" value="${ts ? localIn(ts) : ''}"></label></div>`;
  return head2 + list + del + `<div class="card" id="pForm" style="margin-top:16px"><b>${e ? 'Edit pertemuan ' + e.n : 'Tambah pertemuan ' + (k.pert.length + 1)} · ${esc(k.nama)}</b>
  <div class="fg" style="margin-top:10px"><label class="f">Topik<input id="pTopik" maxlength="80" value="${esc(v.topik)}"></label>
  <label class="f">Batas absen mandiri (menit) — partisipan bisa absen sendiri selama waktu ini. Isi 0 jika pengajar yang mengabsen.<input id="pDur" type="number" min="0" max="180" value="${dur}"></label>
  ${e ? '<label class="chk"><input type="checkbox" id="pReopen"> Buka ulang absen sekarang (hitung mundur mulai dari sekarang)</label>' : ''}
  <div class="quote" style="margin:4px 0 0"><b>Opsi pertemuan</b> (centang yang dipakai)</div>
  <label class="chk"><input type="checkbox" id="uMateri" ${S.pf.mat.length ? 'checked' : ''} ${tg('bMateri')}> Materi (maks. 5 file atau link)</label>
  <div id="bMateri" class="blk" ${S.pf.mat.length ? '' : 'hidden'}>${lampEditor('mat')}</div>
  <label class="chk"><input type="checkbox" id="uTugas" ${v.tugas ? 'checked' : ''} ${tg('bTugas')}> Tugas (muncul di partisipan sebagai tugas yang harus diselesaikan)</label>
  <div id="bTugas" class="blk" ${v.tugas ? '' : 'hidden'}><div class="fg"><label class="f">Deskripsi / instruksi tugas<textarea id="pTugas" rows="2" maxlength="300">${esc(v.tugas)}</textarea></label>
  ${lampEditor('tl')}${dlBox('uTgDl', 'bTgDl', 'pTgDl', v.tugasDl)}</div></div>
  <label class="chk"><input type="checkbox" id="uQuiz" ${adaQ ? 'checked' : ''} ${tg('bQuiz')}> Quiz (muncul di partisipan sebagai quiz yang perlu dikerjakan)</label>
  <div id="bQuiz" class="blk" ${adaQ ? '' : 'hidden'}><div class="fg"><div class="quote">Quiz bisa berupa <b>soal di sini</b>, <b>link / file</b> (mis. Google Form atau berkas soal), atau keduanya. Untuk link/file, partisipan bisa menandai selesai atau mengirim hasil pengerjaannya.</div>
  ${lampEditor('ql')}
  <label class="f">Soal pilihan ganda (opsional) — satu soal per baris: <code>Soal | Opsi A | Opsi B | Opsi C | nomor jawaban benar</code><textarea id="pQuiz" rows="4" placeholder="Apa itu enkapsulasi? | Menyembunyikan data | Mewarisi kelas | Membuat objek | 1">${esc(qzText(v.quiz))}</textarea></label>${dlBox('uQzDl', 'bQzDl', 'pQzDl', v.quizDl)}</div></div>
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
function editPert(n) { S.edit = n; render(); const f = document.getElementById('pForm'); if (f && f.scrollIntoView) f.scrollIntoView({ behavior: 'smooth' }); }
async function savePert() {
  if (BUSY) return; BUSY = true;
  try { await savePert0(); } finally { BUSY = false; }
}
async function savePert0() {
  const c = ctxKelas(); if (!c || !S.pf) return;
  const { m, k } = c, e = $('#pErr'), old = S.edit ? k.pert.find(x => x.n === S.edit) : null, topik = $('#pTopik').value.trim();
  const fail = t => { e.textContent = t; };
  if (!topik) return fail('Topik wajib diisi.');
  const dur = parseInt($('#pDur').value, 10);
  if (!(dur >= 0 && dur <= 180)) return fail('Batas absen harus 0–180 menit.');
  let tugas = '', qz = [], materi = [], tugasLamp = [], quizLamp = [], tugasDl = null, quizDl = null;
  const dl = (chk, inp, prev, nama) => {
    if (!$(chk).checked) return null;
    const t = new Date($(inp).value).getTime();
    if (!(t > 0)) throw new Error('Isi tanggal & jam batas waktu ' + nama + '.');
    if (t !== prev && t <= Date.now()) throw new Error('Batas waktu ' + nama + ' harus di masa depan.');
    return t;
  };
  try {
    if ($('#uMateri').checked) { materi = S.pf.mat.slice(); if (!materi.length) return fail('Tambahkan minimal satu materi (file atau link), atau hilangkan centang Materi.'); }
    if ($('#uTugas').checked) {
      tugas = $('#pTugas').value.trim(); if (!tugas) return fail('Isi deskripsi tugas, atau hilangkan centang Tugas.');
      tugasLamp = S.pf.tl.slice(); tugasDl = dl('#uTgDl', '#pTgDl', old && old.tugasDl, 'tugas');
    }
    if ($('#uQuiz').checked) {
      const q = parseQuiz($('#pQuiz').value);
      if (typeof q === 'string') return fail(q);
      qz = q; quizLamp = S.pf.ql.slice();
      if (!qz.length && !quizLamp.length) return fail('Isi soal quiz atau tambahkan link/file quiz, atau hilangkan centang Quiz.');
      quizDl = dl('#uQzDl', '#pQzDl', old && old.quizDl, 'quiz');
    }
  } catch (err) { return fail(err.message); }
  try {
    materi = await upItems(materi, m.id + '/materi'); tugasLamp = await upItems(tugasLamp, m.id + '/materi'); quizLamp = await upItems(quizLamp, m.id + '/materi');
  } catch (err) { return fail('Gagal mengunggah berkas: ' + ((err && err.message) || err)); }
  const reopen = old ? $('#pReopen').checked : true;
  const absen = { dur, start: old && old.absen && !reopen ? old.absen.start : Date.now() };
  const data = { topik, tugas, tugasLamp, tugasDl, quiz: qz, quizLamp, quizDl, materi, absen };
  if (old) { Object.assign(old, data); delete old.tugasFile; } else k.pert.push({ n: k.pert.length + 1, ...data });
  if (!saveMk(m)) return fail('Gagal menyimpan data.');
  const msg = old ? 'Pertemuan ' + old.n + ' diperbarui' : 'Pertemuan ' + k.pert.length + ' ditambahkan';
  S.edit = null; S.pfKey = null; S.pf = null; render(); toast(msg);
}
function delPert() {
  const c = ctxKelas(); if (!c) return;
  if (!confirm('Hapus pertemuan terakhir beserta absen, tugas, dan nilai quiz-nya?')) return;
  const { m, k } = c, n = k.pert.length; k.pert.pop(); saveMk(m);
  const a = st.pr(), d = a[m.id] || {};
  studentsOf(m.id, k.id).forEach(u => { const v = d[u.email]; if (v) ['att', 'sub', 'quiz', 'qt', 'nilai', 'qext', 'kembali'].forEach(f => { if (v[f]) delete v[f][n]; }); });
  st.setPr(a); render();
}
// Pengumpulan: siapa saja yang sudah mengirim tugas / mengerjakan quiz
let KUM = [], PVJ = 0;
function kumpulModal(n) {
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
    if (x.tugas) {
      const sent = ss.filter(u => P(m.id, u.email).sub[n]).length, graded = ss.filter(u => P(m.id, u.email).nilai[n]).length;
      h += `<h4 style="margin:16px 0 4px">Tugas · ${sent}/${ss.length} sudah mengirim · ${graded} dinilai ${dlChip(x.tugasDl)}</h4>` + ss.map((u, i) => {
        const p = P(m.id, u.email), f = p.sub[n], nl = p.nilai[n];
        if (!f) return nama(u, p.kembali[n] ? '<span class="chip c-iz">Dikembalikan</span>' : '<span class="chip c-wait">Belum mengirim</span>', p.kembali[n] ? '<div class="quote" style="margin-top:6px">Menunggu dikirim ulang</div>' : '');
        const its = itemsOf(f);
        return nama(u, nl ? `<span class="chip c-ok">Sudah dinilai${nl.skor != null ? ' · ' + nl.skor : ''}</span>` : '<span class="chip c-iz">Perlu dinilai</span>',
          `${subAt(f) ? `<div class="quote" style="margin-top:6px">Dikirim ${fmtDt(subAt(f))} · ${its.length} lampiran</div>` : ''}${its.length ? lampRows(its, i, 'sub') : '<div class="kf"><span class="quote">Berkas lama tidak tersimpan. Partisipan sudah diminta mengirim ulang.</span></div>'}
        <div class="kn"><input id="nl-${i}" type="number" min="0" max="100" placeholder="Nilai 0–100 (boleh kosong)" value="${nl && nl.skor != null ? nl.skor : ''}" aria-label="Nilai ${esc(u.nama)}"><input id="ct-${i}" placeholder="Catatan (opsional)" maxlength="120" value="${nl ? esc(nl.cat || '') : ''}" aria-label="Catatan untuk ${esc(u.nama)}"><button class="btn lime sm" onclick="simpanNilai(${n},${i})">${nl ? 'Perbarui' : 'Simpan penilaian'}</button><button class="btn ghost sm" onclick="kembalikan(${n},${i})">↩ Kembalikan</button></div>`);
      }).join('');
    }
    if (adaQuiz(x)) {
      const done = ss.filter(u => quizDone(P(m.id, u.email), x)).length;
      h += `<h4 style="margin:16px 0 4px">Quiz · ${done}/${ss.length} selesai ${dlChip(x.quizDl)}</h4>` + ss.map((u, i) => {
        const p = P(m.id, u.email), qe = p.qext[n], chips = [];
        if (x.quiz.length) chips.push(p.quiz[n] != null ? `<span class="chip c-bl">Nilai ${p.quiz[n]}</span>` : '<span class="chip c-wait">Soal belum dikerjakan</span>');
        let extra = '';
        if (qlOf(x).length) {
          if (qe) { const its = itemsOf(qe); chips.push('<span class="chip c-ok">Selesai</span>'); extra = `<div class="quote" style="margin-top:6px">${its.length ? 'Hasil dikirim ' : 'Ditandai selesai '}${fmtDt(qe.at)}${its.length ? ' · ' + its.length + ' lampiran' : ''}</div>${lampRows(its, i, 'qx')}`; }
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
  const { m } = c, u = Auth.find(KUM[i]), p = P(m.id, KUM[i]), fld = kind === 'qx' ? p.qext[n] : p.sub[n], nl = p.nilai[n], its = itemsOf(fld), it0 = its[j];
  if (!it0 || it0.tipe === 'link') { toast('Berkas tidak tersimpan'); return; }
  let it; try { it = await withData(it0); } catch (e) { toast('Berkas tidak bisa dibuka'); return; }
  freePv();
  const tabs = its.length > 1 ? `<div class="row" style="margin-top:10px">${its.map((q, jj) => `<button class="btn ${jj === j ? '' : 'ghost'} sm" onclick="${q.tipe === 'link' ? `bukaLinkTugas(${n},${i},${jj},'${kind}')` : `lihatTugas(${n},${i},${jj},'${kind}')`}">${q.tipe === 'link' ? '🔗 Link' : '📄 ' + esc(q.nama.length > 22 ? q.nama.slice(0, 20) + '…' : q.nama)}</button>`).join('')}</div>` : '';
  const ctrl = kind === 'qx' ? `<div class="row" style="margin-top:12px"><button class="btn ghost sm" onclick="unduhTugas(${n},${i},${j},'qx')">Unduh</button></div>`
    : `<div class="kn" style="margin-top:12px"><input id="nl-${i}" type="number" min="0" max="100" placeholder="Nilai 0–100 (boleh kosong)" value="${nl && nl.skor != null ? nl.skor : ''}" aria-label="Nilai ${esc(u.nama)}"><input id="ct-${i}" placeholder="Catatan (opsional)" maxlength="120" value="${nl ? esc(nl.cat || '') : ''}" aria-label="Catatan untuk ${esc(u.nama)}"><button class="btn lime sm" onclick="simpanNilai(${n},${i},true)">${nl ? 'Perbarui' : 'Simpan penilaian'}</button><button class="btn ghost sm" onclick="unduhTugas(${n},${i},${j})">Unduh</button><button class="btn ghost sm" onclick="kembalikan(${n},${i},true)">↩ Kembalikan</button></div>`;
  modal(`<button class="btn ghost" onclick="kumpulModal(${n})">← Kembali ke daftar pengumpulan</button><h3 style="margin:12px 0 0;word-break:break-all">${esc(it.nama)}</h3><div class="quote">${esc(u.nama)} · ${esc(u.id)}${subAt(fld) ? ' · ' + fmtDt(subAt(fld)) : ''}${kind === 'qx' && fld && fld.at ? ' · ' + fmtDt(fld.at) : ''}</div>${tabs}
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
function kembalikan(n, i, pv) {
  const c = ctxKelas(); if (!c || !KUM[i]) return;
  const em = KUM[i], u = Auth.find(em), p = P(c.m.id, em), f = p.sub[n], nama = u ? u.nama : 'partisipan';
  if (!f) { toast('Partisipan belum mengirim tugas'); return; }
  if (!confirm('Kembalikan tugas ' + nama + '?\nBerkas yang sudah dikirim dihapus dan nilainya dibatalkan, lalu partisipan bisa mengirim ulang.\nIsi kolom Catatan dulu kalau ingin memberi alasan.')) return;
  const ct = document.getElementById('ct-' + i);
  p.kembali[n] = { cat: ct ? ct.value.trim() : '', lama: subName(f), at: Date.now() };
  delete p.sub[n]; delete p.nilai[n]; setP(c.m.id, em, p);
  toast('Tugas dikembalikan ke ' + nama); render(); kumpulModal(n);
}
// Pengajar memberi nilai (0–100, boleh dikosongkan = hanya ditandai "sudah dinilai") dan catatan
function simpanNilai(n, i, pv) {
  const c = ctxKelas(); if (!c || !KUM[i]) return;
  const raw = document.getElementById('nl-' + i).value.trim(), cat = document.getElementById('ct-' + i).value.trim();
  let skor = null;
  if (raw !== '') { skor = Number(raw); if (!(skor >= 0 && skor <= 100)) { toast('Nilai harus antara 0 dan 100'); return; } skor = Math.round(skor * 10) / 10; }
  const p = P(c.m.id, KUM[i]);
  if (!p.sub[n]) { toast('Partisipan belum mengirim tugas'); return; }
  p.nilai[n] = { skor, cat, at: Date.now() }; setP(c.m.id, KUM[i], p);
  toast('Penilaian disimpan'); render(); if (pv) lihatTugas(n, i, PVJ); else kumpulModal(n);
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
  <p class="err" id="eKErr" role="alert"></p>
  <div class="row"><button class="btn lime" onclick="simpanKelas()">Simpan perubahan</button><button class="btn ghost" onclick="tutupModal()">Batal</button></div></div>`);
}
async function simpanKelas() {
  const c = ctxKelas(); if (!c) return; const { m, k } = c, e = $('#eKErr');
  const nama = $('#eKNama').value.trim(), kode = $('#eKKode').value.trim().toUpperCase();
  if (!nama) { e.textContent = 'Nama kelas wajib diisi.'; return; }
  if (!/^[A-Z0-9-]{4,16}$/.test(kode)) { e.textContent = 'Kode kelas 4–16 karakter: huruf, angka, atau tanda hubung.'; return; }
  if (await kodeDipakai(kode, k.id, e)) return;
  k.nama = nama; k.kode = kode;
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
function progress() {
  const L = myMk(), top = '<h1>Progres belajar</h1>';
  if (!L.length) return top + empty('📈', 'Belum ada progres', isDosen ? 'Progres kelas muncul setelah kamu membuat kelas dan partisipan bergabung.' : 'Progres muncul setelah kamu bergabung ke kelas.', isDosen ? btnMk : btnJoin);
  const bar = (l, r, p, c) => `<div class="meta"><span>${l}</span><span>${r}</span></div><div class="bar" style="margin-top:4px"><i style="width:${p}%${c ? ';background:' + c : ''}"></i></div>`;
  return top + '<h2>Per pelajaran</h2><div class="courses">' + L.map(m => {
    if (!isDosen) {
      const s2 = stats(m, U.email), p = s2.held ? Math.round(s2.hadir / s2.held * 100) : 0;
      return `<div class="card"><b>${esc(m.nama)}</b>${bar('Kehadiran', p + '%', p)}${bar('Tugas & quiz selesai', s2.done + '/' + s2.tasks, s2.tasks ? s2.done / s2.tasks * 100 : 0, 'var(--amb)')}</div>`;
    }
    const rows = m.kelas.map(k => {
      const ss = studentsOf(m.id, k.id), tasks = k.pert.reduce((a, x) => a + (x.tugas ? 1 : 0) + (adaQuiz(x) ? 1 : 0), 0); let h = 0, d = 0;
      ss.forEach(u => { const s2 = stats(m, u.email); h += s2.hadir; d += s2.done; });
      const ap = ss.length && k.pert.length ? Math.round(h / (ss.length * k.pert.length) * 100) : 0, tp = ss.length && tasks ? Math.round(d / (ss.length * tasks) * 100) : 0;
      return `<div class="meta"><span><b>${esc(k.nama)}</b> · ${ss.length} partisipan</span><span>Hadir ${ap}% · Tugas/quiz ${tp}%</span></div>`;
    }).join('') || '<p class="empty">Belum ada kelas.</p>';
    return `<div class="card"><b>${esc(m.nama)}</b>${rows}</div>`;
  }).join('') + '</div>';
}
// Pengaturan: akun, tampilan, pengingat, panduan, bantuan
function setPref(k, v) {
  U.pref = { ...prefOf(U), [k]: v }; Auth.update(U.email, { pref: U.pref });
  applyPref(); render(); toast('Pengaturan disimpan');
}
function settings() {
  const pf = prefOf(U), isD = isDosen;
  const seg = (v, l) => `<button class="seg ${pf.fs === v ? 'on' : ''}" onclick="setPref('fs','${v}')" aria-pressed="${pf.fs === v}">${l}</button>`;
  const sw = (k, l, d) => `<label class="chk sw"><input type="checkbox" ${pf[k] !== false ? 'checked' : ''} onchange="setPref('${k}',this.checked)"><span><b>${l}</b><div class="quote">${d}</div></span></label>`;
  return `<h1>Pengaturan</h1><p class="quote">Atur akun, tampilan, pengingat, dan data aplikasimu.</p>
  <div class="pcols">
    <div class="card"><b>Akun</b><dl class="kv"><dt>Nama</dt><dd>${esc(U.nama)}</dd><dt>Peran</dt><dd>${esc(U.role)} · ${esc(U.id)}</dd><dt>Gmail</dt><dd>${esc(U.email)} ${U.verified ? '<span class="chip c-ok">Terverifikasi</span>' : '<span class="chip c-no">Belum terverifikasi</span>'}</dd></dl>
      <div class="row" style="margin-top:14px"><button class="btn ghost" onclick="go('profil')">Buka profil</button><button class="btn ghost dng" onclick="Auth.logout()">Keluar</button></div></div>
    <div class="card"><b>Tampilan</b><p class="quote" style="margin:6px 0 12px">Ukuran teks pada isi halaman. Berlaku di semua halaman.</p><div class="segs" role="group" aria-label="Ukuran teks">${seg('kecil', 'Kecil')}${seg('normal', 'Normal')}${seg('besar', 'Besar')}</div>
      <p class="lock">Contoh: tulisan ini berubah ukurannya sesuai pilihanmu.</p></div>
    <div class="card"><b>Pengingat</b>${isD ? sw('nl', 'Tugas perlu dinilai', 'Tampilkan jumlah tugas yang belum dinilai di beranda.')
      : sw('ab', 'Absen dibuka', 'Tampilkan kartu Absen sekarang di beranda saat pengajar membuka absen.') + sw('dl', 'Batas waktu segera berakhir', 'Tampilkan tugas dan quiz yang batasnya kurang dari 24 jam di beranda.')}</div>
  </div>
  <div class="card pfull"><b>Panduan penggunaan</b><p class="quote" style="margin:6px 0 12px">Tur singkat yang menyorot menu-menu utama dan menjelaskan cara memakainya.</p>
    <div class="row"><button class="btn lime" onclick="startTour()">▶ Mulai panduan</button></div></div>
  <div class="card pfull"><b>Bantuan & tentang</b><p class="quote" style="margin:6px 0 12px">Ada kendala atau saran? Hubungi kami.</p>
    <div class="row"><a class="btn ghost" href="mailto:${KONTAK.email}">✉️ ${KONTAK.email}</a><a class="btn ghost" href="https://wa.me/${KONTAK.waIntl}" target="_blank" rel="noopener noreferrer">💬 WhatsApp ${KONTAK.wa}</a></div>
    <p class="lock">KelasBelajar versi 1.0</p></div>`;
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
    { t: '.meTop', h: 'Profil', p: 'Tekan namamu di pojok atas ini untuk membuka halaman profil untuk mengubah kontak dan mengatur keamanan akunmu' },
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
  renderNav();
  const v = S.view;
  $('#view').innerHTML = v === 'home' ? home() : v === 'courses' ? coursesPage() : v === 'course' ? coursePage() : v === 'kelas' ? kelasPage() : v === 'pert' ? pertPage() : v === 'progress' ? progress() : settings();
  $('#view').classList.toggle('is-home', v === 'home'); topInfo(); if (v === 'home') fx();
}
function tutupModal() { freePv(); $('#layer').innerHTML = ''; }
function modal(h, cls) { $('#layer').innerHTML = `<div class="modal" onclick="if(event.target===this)tutupModal()"><div class="sheet ${cls || ''}" role="dialog" aria-modal="true"><button class="xbtn" onclick="tutupModal()" aria-label="Tutup jendela">✕</button>${h}</div></div>`; }
function initBeranda() {
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
let editing = null, pwOpen = false, timer = null;   // editing: 'data' | 'kontak' | null

if (!Auth.requireLogin()) return;
$('#bOut').onclick = () => Auth.logout();

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
  const dataCard = `<div class="card"><b>Data diri</b>
        <dl class="kv">
          <dt>Nama lengkap</dt><dd>${esc(u.nama)}</dd>
          <dt>Peran</dt><dd>${esc(u.role)}</dd>
          <dt>${idLabel}</dt><dd>${esc(u.id)}</dd>
          <dt>Minat belajar</dt><dd>${esc(u.prodi)}</dd>
        </dl>
        <p class="lock">🔒 Nama lengkap, peran, dan minat belajar tidak dapat diubah setelah pendaftaran.</p></div>`;

  const kontakCard = editing === 'kontak'
    ? `<form id="fKontak" class="card" novalidate><b>Ubah kontak</b>
        <label class="f">No. HP<input id="eHp" value="${esc(u.hp)}" inputmode="tel" maxlength="16"></label>
        <label class="f">Gmail<input type="email" id="eEmail" value="${esc(u.email)}" autocomplete="email"></label>
        <p class="lock" style="margin:0">Jika Gmail diganti, kamu akan masuk dengan Gmail baru dan perlu memverifikasinya ulang.</p>
        <p class="err" id="eKontak" role="alert"></p>
        <div class="row"><button class="btn lime" type="submit">Simpan</button><button class="btn ghost" type="button" id="bBatalK">Batal</button></div></form>`
    : `<div class="card"><div class="row" style="justify-content:space-between"><b>Kontak saya</b><button class="btn ghost" id="bEditK">Ubah</button></div>
        <dl class="kv"><dt>No. HP</dt><dd>${esc(u.hp)}</dd><dt>Email</dt><dd>${esc(u.email)}</dd></dl>
        <p class="lock">✏️ No. HP dan Gmail masih bisa diubah. Gmail dipakai untuk masuk dan verifikasi.</p></div>`;

  const r = ringkas(u), isD = u.role === 'Pengajar';
  const aktivitas = `<div class="card"><b>${isD ? 'Ringkasan mengajar' : 'Ringkasan belajar'}</b>
    <div class="tiles">${r.tiles.map(([n, l]) => `<div class="tile"><b>${n}</b><span>${l}</span></div>`).join('')}</div></div>`;

  const tgl = u.dibuat ? new Date(u.dibuat).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
  const aman = `<div class="card"><b>Keamanan akun</b>
    <dl class="kv"><dt>Akun dibuat</dt><dd>${tgl}</dd><dt>Kata sandi</dt><dd>••••••••</dd></dl>
    ${pwOpen ? `<form id="fPw" novalidate style="margin-top:14px">
      <label class="f">Kata sandi saat ini<input type="password" id="pwOld" autocomplete="current-password"></label>
      <label class="f">Kata sandi baru (min. 8 karakter)<input type="password" id="pwNew" autocomplete="new-password"></label>
      <label class="f">Ulangi kata sandi baru<input type="password" id="pwNew2" autocomplete="new-password"></label>
      <p class="err" id="ePw" role="alert"></p>
      <div class="row"><button class="btn lime" type="submit">Simpan kata sandi</button><button class="btn ghost" type="button" id="bPwBatal">Batal</button></div></form>`
      : '<button class="btn ghost" id="bPw" style="margin-top:14px">Ubah kata sandi</button>'}</div>`;

  const mkItems = r.mine.length ? `<div class="mkgrid">${r.mine.map(m => {
    const d = dec(m);
    const sub = isD ? (m.kelas.map(k => `<span class="code-pill">${esc(k.nama)} · ${esc(k.kode)}</span>`).join(' ') || '<span class="quote">Belum ada kelas</span>') : `<span class="quote">Pengajar: ${esc(m.dosenNama)}</span>`;
    return `<div class="mkitem"><div class="ic" style="background:${d.col}">${d.ic}</div><div style="min-width:0"><b>${esc(m.nama)}</b><div class="mkb">${sub}</div></div></div>`;
  }).join('')}</div>`
    : `<p class="quote" style="margin:12px 0 0">${isD ? 'Belum ada pelajaran. Buat pelajaran dan kelas di menu Pelajaran.' : 'Belum bergabung ke kelas mana pun. Masukkan kode kelas dari pengajar di menu Pelajaran.'}</p>`;
  const mkCard = `<div class="card pfull"><div class="row" style="justify-content:space-between"><b>${isD ? 'Pelajaran yang saya ampu' : 'Pelajaran saya'}</b><a class="btn ghost" href="index.html#courses">Buka pelajaran →</a></div>${mkItems}</div>`;

  const hapusCard = `<div class="card danger pfull"><div class="row" style="justify-content:space-between;align-items:center"><div style="min-width:0;flex:1 1 260px"><b>Hapus akun permanen</b><p class="quote" style="margin:4px 0 0">Menghapus akun akan menghapus seluruh data milikmu dan tidak bisa dibatalkan.</p></div><button class="btn red" id="bHapus">Hapus akun permanen</button></div></div>`;

  $('#view').innerHTML = `
    <div class="row" style="margin-bottom:6px"><div class="av big">${esc(u.nama.charAt(0).toUpperCase())}</div>
      <div><h1 style="font-size:24px">${esc(u.nama)}</h1>
      <span class="chip c-bl">${esc(u.role)}</span> ${u.verified ? '<span class="chip c-ok">Gmail terverifikasi</span>' : '<span class="chip c-no">Gmail belum terverifikasi</span>'}</div></div>
    ${baru ? '<div class="card note">🎉 Akun berhasil dibuat. Satu langkah lagi: verifikasi Gmail kamu di bawah ini.</div>' : ''}
    ${verif}
    <div class="pcols">${dataCard}${kontakCard}${aktivitas}${aman}</div>
    ${mkCard}${hapusCard}`;

  bind(u);
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
