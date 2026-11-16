/* Panel Admin KelasBelajar – semua perubahan data lewat /api/admin (server memakai service role). */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TK = 'kb-admin-token';
  let TOKEN = '', D = null, aktifT = 0, nUrut = 'baru', nHanyaBelum = false, N = null, tab = 'akun', fRole = 'all', qAkun = '', qPel = '', busy = false;
  try { TOKEN = sessionStorage.getItem(TK) || ''; } catch (e) {}

  const P = {
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.7a3.5 3.5 0 0 1 0 6.6M18 14.8c2 .6 3.2 2.2 3.5 5.2"/>',
    cap: '<path d="M2.5 9.5L12 5l9.5 4.5L12 14z"/><path d="M6.5 11.5V16c0 1.5 2.5 3 5.5 3s5.5-1.5 5.5-3v-4.5M21.5 9.5v6"/>',
    pack: '<path d="M9 6V5a3 3 0 0 1 6 0v1"/><rect x="5" y="6" width="14" height="15" rx="4"/><path d="M9 14h6"/>',
    book: '<path d="M4.5 19V5a2 2 0 0 1 2-2h12v15h-12a2 2 0 0 0-2 2z"/><path d="M4.5 19a2 2 0 0 0 2 2h12v-3"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    shield: '<path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff: '<path d="M3 3l18 18M10.6 6a9.5 9.5 0 0 1 1.4-.1c6 0 9.5 6.1 9.5 6.1a16 16 0 0 1-3.3 3.8M6.5 7.2A16 16 0 0 0 2.5 12S6 18.1 12 18.1c1.5 0 2.8-.4 4-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    edit: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    out: '<path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5M16 8l4 4-4 4M20 12H9"/>',
    quote: '<path d="M5 17.5c0-4 1.5-7 5-9M13 17.5c0-4 1.5-7 5-9"/><path d="M5 17.5h4v-4H5zM13 17.5h4v-4h-4z"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>'
  };
  const ic = n => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${P[n]}</svg>`;

  const fmtD = iso => { const t = Date.parse(iso); return t ? new Date(t).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; };
  const fmtDT = iso => { const t = Date.parse(iso); return t ? new Date(t).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Belum pernah';  };
  const ava = (u, cls = '') => `<span class="av ${cls}">${u.foto ? `<img src="${esc(u.foto)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : esc(String(u.nama || '?').trim().charAt(0).toUpperCase())}</span>`;
  const chipRole = r => `<span class="chip ${r === 'Pengajar' ? 'p' : 's'}">${esc(r)}</span>`;

  let tT = 0;
  function toast(m, bad) { const t = $('#toast'); t.textContent = m; t.className = 'on' + (bad ? ' bad' : ''); clearTimeout(tT); tT = setTimeout(() => { t.className = ''; }, 3200); }

  async function api(action, payload = {}) {
    let r, j = {};
    try {
      r = await fetch('/api/admin', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) }, body: JSON.stringify({ action, ...payload }) });
    } catch (e) { throw new Error('Tidak bisa terhubung ke server. Periksa koneksi internet.'); }
    try { j = await r.json(); } catch (e) { j = {}; }
    if (r.status === 401 && action !== 'login') { keluar('Sesi berakhir. Silakan masuk lagi.'); throw new Error('Sesi berakhir.'); }
    if (r.status === 404 && !j.error) throw new Error('API admin tidak ditemukan. Pastikan folder api/ ikut ter-deploy di Vercel.');
    if (!r.ok) throw new Error(j.error || 'Kesalahan server (' + r.status + ').');
    return j;
  }

  /* ---------- aktivitas ---------- */
  const seenOf = u => (D && D.aktif && D.aktif.ada && D.aktif.seen && D.aktif.seen[u.uid]) || '';
  const isOn = u => { const t = Date.parse(seenOf(u)); return !!t && t >= D.aktif.now - 150000; };
  const rel = iso => { const t = Date.parse(iso); if (!t) return 'Belum pernah'; const m = Math.max(0, Math.round((Date.now() - t) / 60000)); if (m < 1) return 'Baru saja'; if (m < 60) return m + ' menit lalu'; const h = Math.round(m / 60); return h < 48 ? h + ' jam lalu' : fmtD(iso); };
  const dot = u => isOn(u) ? '<i class="dot" title="Sedang online"></i>' : '';
  async function segarAktif() {
    if (!TOKEN || !D) return;
    try {
      const j = await api('aktif'); D.aktif = j.aktif;
      const lama = D.notifBelum; D.notifBelum = j.notifBelum;
      setBadgeNotif();
      if (lama != null && j.notifBelum != null && j.notifBelum > lama) toast('Notifikasi baru masuk');
      if (tab === 'not' && !$('#mdl') && (lama == null || j.notifBelum !== lama)) muatNotif();
      const a = $('#sv-h24'), b = $('#sv-on');
      if (a) a.textContent = D.aktif.ada ? D.aktif.h24 : '—';
      if (b) b.textContent = D.aktif.ada ? D.aktif.online : '—';
      if (tab === 'akun' && $('#tAk') && !$('#mdl')) tabelAkun();
    } catch (e) { /* diam-diam */ }
  }

  const NJ = { akun_baru: 'users', akun_hapus: 'trash', akun: 'users', gabung: 'pack', pelajaran: 'book', sistem: 'pulse' };
  function setBadgeNotif() {
    const b = $('#nbAdm'); if (!b) return;
    const n = D && D.notifBelum; b.textContent = n > 99 ? '99+' : String(n || 0); b.hidden = !n;
  }

  /* ---------- derived ---------- */
  const byEmail = () => { const o = {}; D.users.forEach(u => { o[u.email] = u; }); return o; };
  const joinsOf = id => D.join.filter(j => j.pelajaran === id);
  const nPelajaranUser = u => u.role === 'Pengajar' ? D.pelajaran.filter(m => m.pengajar === u.email).length : D.join.filter(j => j.partisipan === u.email).length;

  /* ---------- layar login ---------- */
  function viewLogin(msg) {
    closeModal();
    $('#app').innerHTML = `<div class="lg"><form class="lg-card" id="fLg" novalidate>
      <div class="lg-top"><img src="/assets/logo.svg" alt="" width="60" height="60"><div><div class="lg-t">Kelas<b>Belajar</b></div><span class="badge">${ic('shield')} Admin</span></div></div>
      <h1>Masuk sebagai admin</h1><p class="sub">Area khusus pengelola. Akun admin didaftarkan oleh superadmin melalui database, bukan lewat website.</p>
      <label class="f">Email admin<input type="email" id="aEm" autocomplete="username" required></label>
      <label class="f">Kata sandi<span class="pw"><input type="password" id="aPw" autocomplete="current-password" required><button type="button" id="aEye" aria-label="Tampilkan kata sandi">${ic('eye')}</button></span></label>
      <p class="err" id="aErr" role="alert">${esc(msg || '')}</p>
      <button class="btn lime" type="submit" id="aGo">Masuk</button>
      <a class="lg-back" href="/login">← Kembali ke KelasBelajar</a></form></div>`;
    eyeToggle('#aEye', '#aPw');
    $('#aEm').focus();
    $('#fLg').onsubmit = async e => {
      e.preventDefault();
      const err = $('#aErr'), b = $('#aGo'); err.textContent = '';
      const email = $('#aEm').value.trim(), pass = $('#aPw').value;
      if (!email || !pass) { err.textContent = 'Isi email dan kata sandi admin.'; return; }
      b.disabled = true; b.textContent = 'Memeriksa…';
      try {
        const j = await api('login', { email, pass });
        TOKEN = j.token; try { sessionStorage.setItem(TK, TOKEN); } catch (x) {}
        await mulai();
      } catch (x) { err.textContent = x.message; b.disabled = false; b.textContent = 'Masuk'; $('#aPw').value = ''; $('#aPw').focus(); }
    };
  }
  function eyeToggle(btn, inp) {
    const b = $(btn), i = $(inp); if (!b || !i) return;
    b.onclick = () => { const show = i.type === 'password'; i.type = show ? 'text' : 'password'; b.innerHTML = ic(show ? 'eyeoff' : 'eye'); b.setAttribute('aria-label', show ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'); };
  }
  function keluar(msg) { clearInterval(aktifT); TOKEN = ''; D = null; try { sessionStorage.removeItem(TK); } catch (e) {} viewLogin(msg); }

  /* ---------- dashboard ---------- */
  async function mulai() {
    $('#app').innerHTML = `<header class="hd"><div class="hd-in"><img src="/assets/logo.svg" alt="" width="46" height="46"><div><div class="lg-t">Kelas<b>Belajar</b></div></div><span class="badge" style="margin:0 0 0 4px;background:var(--lime);color:var(--g9)">Admin</span><span class="sp"></span><span class="wh" id="wh"></span><button class="btn" id="bRef" type="button" title="Muat ulang data">${ic('grid')}<span>Muat ulang</span></button><button class="btn" id="bOut" type="button">${ic('out')}<span>Keluar</span></button></div></header>
      <div class="wrap" id="wrap"><div class="loading">Memuat data…</div></div>`;
    try { const pl = JSON.parse(decodeURIComponent(escape(atob(TOKEN.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))))); $('#wh').textContent = pl.nm || pl.em || ''; } catch (e) {}
    $('#bOut').onclick = () => keluar('');
    $('#bRef').onclick = () => muat(true);
    await muat(false);
    clearInterval(aktifT); aktifT = setInterval(segarAktif, 30000);
  }
  async function muat(notif) {
    if (busy) return; busy = true;
    try { D = await api('data'); render(); if (notif) toast('Data diperbarui'); }
    catch (e) { if (TOKEN) $('#wrap').innerHTML = `<div class="panel"><div class="empty">${esc(e.message)}<div style="margin-top:12px"><button class="btn lime" id="bRetry" type="button">Coba lagi</button></div></div></div>`, $('#bRetry').onclick = () => { busy = false; muat(false); }; }
    finally { busy = false; }
  }

  function stat(i, v, l, id, act) { return `<${act ? 'button type="button" data-st="' + act + '"' : 'div'} class="st${act ? ' click' : ''}"><span class="si">${ic(i)}</span><span><span class="sv"${id ? ` id="${id}"` : ''}>${v}</span><span class="sl">${l}</span></span></${act ? 'button' : 'div'}>`; }
  function render() {
    if (!D || !$('#wrap')) return;
    const nT = D.users.filter(u => u.role === 'Pengajar').length, nS = D.users.filter(u => u.role === 'Partisipan').length;
    const A = D.aktif || { ada: false };
    $('#wrap').innerHTML = `<h2>Ringkasan</h2><p class="lead">Kelola akun, pelajaran, dan kata motivasi KelasBelajar.</p>
      <div class="stats">${stat('users', D.users.length, 'Total akun')}${stat('cap', nT, 'Akun pengajar')}${stat('pack', nS, 'Akun partisipan')}${stat('book', D.pelajaran.length, 'Total pelajaran')}${stat('trend', A.ada ? A.h24 : '—', 'Pengunjung 24 jam', 'sv-h24', 'h24')}${stat('pulse', A.ada ? A.online : '—', 'Sedang online', 'sv-on', 'on')}</div>
      ${A.ada ? '' : `<div class="note" style="margin:-8px 0 18px"><b>Data pengunjung belum aktif.</b> ${esc(A.error || 'Tabel belum tersedia.')}</div>`}
      <div class="tabs" role="tablist"><button type="button" role="tab" data-tab="akun" class="${tab === 'akun' ? 'on' : ''}">${ic('users')} Akun</button><button type="button" role="tab" data-tab="pel" class="${tab === 'pel' ? 'on' : ''}">${ic('book')} Pelajaran</button><button type="button" role="tab" data-tab="mot" class="${tab === 'mot' ? 'on' : ''}">${ic('quote')} Kata motivasi</button><button type="button" role="tab" data-tab="not" class="${tab === 'not' ? 'on' : ''}">${ic('pulse')} Notifikasi<span class="tbb" id="nbAdm" hidden></span></button></div>
      <div id="pane"></div>`;
    $('#wrap').querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => { tab = b.dataset.tab; render(); }; });
    $('#wrap').querySelectorAll('[data-st]').forEach(b => { b.onclick = () => daftarAktif(b.dataset.st); });
    ({ akun: paneAkun, pel: panePel, mot: paneMot, not: paneNotif })[tab]();
    setBadgeNotif();
  }

  /* ----- tab Akun ----- */
  function paneAkun() {
    $('#pane').innerHTML = `<div class="panel"><div class="tb"><div class="grow"><input type="search" id="sAk" placeholder="Cari nama, Gmail, No. HP, ID, atau minat belajar…" value="${esc(qAkun)}" aria-label="Cari akun"></div>
      <select id="fRl" aria-label="Filter peran"><option value="all">Semua peran</option><option value="Pengajar">Pengajar</option><option value="Partisipan">Partisipan</option></select>
      <button class="btn lime" id="bAdd" type="button">${ic('plus')} Tambah akun</button></div><div id="tAk"></div></div>`;
    $('#fRl').value = fRole;
    $('#sAk').oninput = e => { qAkun = e.target.value; tabelAkun(); };
    $('#fRl').onchange = e => { fRole = e.target.value; tabelAkun(); };
    $('#bAdd').onclick = formAkun;
    tabelAkun();
  }
  function tabelAkun() {
    const q = qAkun.trim().toLowerCase();
    const rows = D.users.filter(u => (fRole === 'all' || u.role === fRole) && (!q || [u.nama, u.email, u.hp, u.id, u.minat].some(v => String(v || '').toLowerCase().includes(q))));
    $('#tAk').innerHTML = rows.length ? `<div class="tw"><table><thead><tr><th>Nama</th><th>Peran</th><th>Gmail</th><th>No. HP</th><th>Minat belajar</th><th>Pelajaran</th><th>Terdaftar</th><th></th></tr></thead><tbody>${rows.map(u => `<tr>
      <td><div class="who">${ava(u)}<div><b>${esc(u.nama)}</b>${dot(u)}<span class="m">ID: ${esc(u.id || '—')}</span></div></div></td><td>${chipRole(u.role)}</td><td>${esc(u.email)}</td><td>${esc(u.hp || '—')}</td><td>${esc(u.minat || '—')}</td>
      <td>${nPelajaranUser(u)}<span class="m">${u.role === 'Pengajar' ? 'dibuat' : 'diikuti'}</span></td><td style="white-space:nowrap">${fmtD(u.dibuat)}</td>
      <td class="act"><button class="btn ghost sm" type="button" data-det="${esc(u.uid)}">${ic('eye')} Detail</button><button class="btn ghost sm" type="button" data-edt="${esc(u.uid)}">${ic('edit')} Ubah</button><button class="btn red sm" type="button" data-del="${esc(u.uid)}" aria-label="Hapus akun ${esc(u.nama)}" title="Hapus akun">${ic('trash')}</button></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty">${D.users.length ? 'Tidak ada akun yang cocok dengan pencarian.' : 'Belum ada akun.'}</div>`;
    $('#tAk').querySelectorAll('[data-det]').forEach(b => { b.onclick = () => detailAkun(b.dataset.det); });
    $('#tAk').querySelectorAll('[data-edt]').forEach(b => { b.onclick = () => formUbah(b.dataset.edt); });
    $('#tAk').querySelectorAll('[data-del]').forEach(b => { b.onclick = () => hapusAkun(b.dataset.del); });
  }

  /* ----- modal ----- */
  function modal(html, wide) {
    $('#layer').innerHTML = `<div class="mdl" id="mdl"><div class="sheet${wide ? ' wide' : ''}" role="dialog" aria-modal="true"><button class="x" type="button" id="mx" aria-label="Tutup">${ic('x')}</button>${html}</div></div>`;
    $('#mx').onclick = closeModal;
    $('#mdl').onmousedown = e => { if (e.target.id === 'mdl') closeModal(); };
  }
  function closeModal() { const l = $('#layer'); if (l) l.innerHTML = ''; }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  function formAkun() {
    modal(`<h3>Tambah akun</h3><p class="sub">Akun langsung aktif (Gmail dianggap terverifikasi) dan bisa dipakai masuk di halaman login biasa.</p>
      <form id="fAk" novalidate><fieldset class="roles"><legend>Peran</legend><label><input type="radio" name="role" value="Partisipan" checked> Partisipan</label><label><input type="radio" name="role" value="Pengajar"> Pengajar</label></fieldset>
      <div class="fg"><label class="f full">Nama lengkap<input id="nNama" maxlength="100" autocomplete="off" required></label>
      <label class="f">ID<input id="nId" maxlength="30" placeholder="tanda pengenal" autocomplete="off" required></label>
      <label class="f">Minat belajar<input id="nMinat" maxlength="60" placeholder="contoh: teknik informatika" autocomplete="off" required></label>
      <label class="f">Gmail<input type="email" id="nEm" placeholder="nama@gmail.com" autocomplete="off" required></label>
      <label class="f">No. HP<input id="nHp" inputmode="tel" placeholder="08xxxxxxxxxx" autocomplete="off" required></label>
      <label class="f full">Kata sandi (min. 8 karakter)<span class="pw"><input type="password" id="nPw" autocomplete="new-password" required><button type="button" id="nEye" aria-label="Tampilkan kata sandi">${ic('eye')}</button></span></label></div>
      <p class="err" id="nErr" role="alert"></p><div class="btns"><button class="btn ghost" type="button" id="nBatal">Batal</button><button class="btn lime" type="submit" id="nGo">Buat akun</button></div></form>`);
    eyeToggle('#nEye', '#nPw'); $('#nBatal').onclick = closeModal; $('#nNama').focus();
    $('#fAk').onsubmit = async e => {
      e.preventDefault();
      const err = $('#nErr'), go = $('#nGo'); err.textContent = '';
      const d = { role: $('#fAk input[name=role]:checked').value, nama: $('#nNama').value.trim(), id: $('#nId').value.trim(), minat: $('#nMinat').value.trim(), email: $('#nEm').value.trim().toLowerCase(), hp: $('#nHp').value.trim(), pass: $('#nPw').value };
      if (!d.nama) return void (err.textContent = 'Nama lengkap wajib diisi.');
      if (!/^[A-Za-z0-9._-]{3,30}$/.test(d.id)) return void (err.textContent = 'ID harus 3–30 karakter: huruf, angka, titik, strip, atau garis bawah (tanpa spasi).');
      if (d.minat.length < 3) return void (err.textContent = 'Minat belajar wajib diisi (minimal 3 karakter).');
      if (!/^[a-z0-9._%+-]+@gmail\.com$/i.test(d.email)) return void (err.textContent = 'Gunakan alamat Gmail yang valid (akhiran @gmail.com).');
      if (!/^0\d{8,13}$/.test(d.hp)) return void (err.textContent = 'Nomor HP tidak valid. Contoh: 081234567890.');
      if (d.pass.length < 8) return void (err.textContent = 'Kata sandi minimal 8 karakter.');
      go.disabled = true; go.textContent = 'Membuat…';
      try { await api('akun_tambah', d); closeModal(); await muatTenang(); toast('Akun ' + d.nama + ' berhasil dibuat'); }
      catch (x) { err.textContent = x.message; go.disabled = false; go.textContent = 'Buat akun'; }
    };
  }
  async function muatTenang() { D = await api('data'); render(); }

  function detailAkun(uid) {
    const u = D.users.find(x => x.uid === uid); if (!u) return;
    let daftar = '';
    if (u.role === 'Pengajar') {
      const mine = D.pelajaran.filter(m => m.pengajar === u.email);
      daftar = `<div class="sec">Pelajaran yang dibuat (${mine.length})</div>` + (mine.map(m => `<div class="li"><span><b>${esc(m.nama)}</b><div class="m">${m.kelas.length} kelas</div></span><span class="m">${joinsOf(m.id).length} partisipan</span></div>`).join('') || '<div class="m">Belum membuat pelajaran.</div>');
    } else {
      const ik = D.join.filter(j => j.partisipan === u.email);
      daftar = `<div class="sec">Pelajaran yang diikuti (${ik.length})</div>` + (ik.map(j => { const m = D.pelajaran.find(x => x.id === j.pelajaran), k = m && m.kelas.find(x => x.id === j.kelas); return `<div class="li"><span><b>${esc(m ? m.nama : '(pelajaran dihapus)')}</b><div class="m">Pengajar: ${esc(m ? m.pengajarNama || m.pengajar : '—')}</div></span><span class="m">${esc(k ? k.nama : '—')}</span></div>`; }).join('') || '<div class="m">Belum bergabung ke pelajaran.</div>');
    }
    modal(`<div class="head">${ava(u, 'lg')}<div><h3>${esc(u.nama)}</h3>${chipRole(u.role)}</div></div>
      <dl class="dl"><dt>Gmail</dt><dd>${esc(u.email)}</dd><dt>No. HP</dt><dd>${esc(u.hp || '—')}</dd><dt>ID</dt><dd>${esc(u.id || '—')}</dd><dt>Minat belajar</dt><dd>${esc(u.minat || '—')}</dd>
      <dt>Terdaftar</dt><dd>${fmtDT(u.dibuat).replace('Belum pernah', '—')}</dd><dt>Terakhir masuk</dt><dd>${fmtDT(u.last)}</dd><dt>Aktivitas</dt><dd>${!D.aktif || !D.aktif.ada ? '—' : isOn(u) ? '<span class="chip ok">Sedang online</span>' : esc(seenOf(u) ? 'Terakhir aktif ' + rel(seenOf(u)) : 'Belum tercatat')}</dd>
      <dt>Verifikasi Gmail</dt><dd>${u.verified == null ? '—' : u.verified ? '<span class="chip ok">Terverifikasi</span>' : '<span class="chip no">Belum</span>'}</dd><dt>UID</dt><dd style="font-size:12px;color:var(--mu)">${esc(u.uid)}</dd></dl>
      ${daftar}<div class="btns" style="margin-top:16px"><button class="btn ghost" type="button" id="dTut">Tutup</button><button class="btn lime" type="button" id="dEdt">${ic('edit')} Ubah</button><button class="btn red" type="button" id="dDel">${ic('trash')} Hapus akun</button></div>`, true);
    $('#dTut').onclick = closeModal; $('#dDel').onclick = () => hapusAkun(uid); $('#dEdt').onclick = () => formUbah(uid);
  }

  function formUbah(uid) {
    const u = D.users.find(x => x.uid === uid); if (!u) return;
    const mine = D.pelajaran.filter(m => m.pengajar === u.email).length, ikut = D.join.filter(j => j.partisipan === u.email).length;
    modal(`<h3>Ubah akun</h3><p class="sub">${esc(u.nama)} · ${esc(u.email)}</p>
      <form id="fUb" novalidate><fieldset class="roles"><legend>Peran</legend><label><input type="radio" name="role" value="Partisipan"${u.role === 'Partisipan' ? ' checked' : ''}> Partisipan</label><label><input type="radio" name="role" value="Pengajar"${u.role === 'Pengajar' ? ' checked' : ''}> Pengajar</label></fieldset>
      <div class="fg"><label class="f">ID<input id="uId" maxlength="30" value="${esc(u.id || '')}" autocomplete="off" required></label>
      <label class="f">Minat belajar<input id="uMinat" maxlength="60" value="${esc(u.minat || '')}" autocomplete="off" required></label></div>
      <div class="warn" id="uWarn" hidden></div><p class="err" id="uErr" role="alert"></p>
      <div class="btns"><button class="btn ghost" type="button" id="uBatal">Batal</button><button class="btn lime" type="submit" id="uGo">Simpan perubahan</button></div></form>`);
    $('#uBatal').onclick = closeModal;
    const roleNow = () => $('#fUb input[name=role]:checked').value;
    const info = () => {
      const w = $('#uWarn'), r = roleNow(); w.hidden = true; w.innerHTML = '';
      if (r === u.role) return;
      w.hidden = false;
      w.innerHTML = u.role === 'Pengajar'
        ? (mine ? `<b>Belum bisa disimpan.</b> Pengajar ini masih punya <b>${mine} pelajaran</b>. Hapus dulu pelajarannya di tab Pelajaran.` : 'Peran berubah dari <b>Pengajar</b> menjadi <b>Partisipan</b>.')
        : `Peran berubah dari <b>Partisipan</b> menjadi <b>Pengajar</b>.${ikut ? ` Keanggotaan di <b>${ikut} pelajaran</b> beserta absen, tugas, dan nilainya akan <b>dihapus</b>.` : ''}`;
    };
    $('#fUb').querySelectorAll('input[name=role]').forEach(i => { i.onchange = info; });
    $('#fUb').onsubmit = async e => {
      e.preventDefault();
      const err = $('#uErr'), go = $('#uGo'); err.textContent = '';
      const d = { uid, role: roleNow(), id: $('#uId').value.trim(), minat: $('#uMinat').value.trim() };
      if (!/^[A-Za-z0-9._-]{3,30}$/.test(d.id)) return void (err.textContent = 'ID harus 3–30 karakter: huruf, angka, titik, strip, atau garis bawah (tanpa spasi).');
      if (d.minat.length < 3) return void (err.textContent = 'Minat belajar wajib diisi (minimal 3 karakter).');
      go.disabled = true; go.textContent = 'Menyimpan…';
      try { await api('akun_ubah', d); closeModal(); await muatTenang(); toast('Akun ' + u.nama + ' diperbarui'); }
      catch (x) { err.textContent = x.message; go.disabled = false; go.textContent = 'Simpan perubahan'; }
    };
  }

  function daftarAktif(mode) {
    const A = D.aktif; if (!A || !A.ada) { toast('Data pengunjung belum aktif. Jalankan SQL aktivitas.', true); return; }
    const batas = mode === 'on' ? A.now - 150000 : A.now - 86400000;
    const rows = D.users.filter(u => { const t = Date.parse(seenOf(u)); return t && t >= batas; }).sort((a, b) => Date.parse(seenOf(b)) - Date.parse(seenOf(a)));
    modal(`<h3>${mode === 'on' ? 'Sedang online' : 'Pengunjung 24 jam terakhir'}</h3><p class="sub">${rows.length} akun ${mode === 'on' ? 'aktif dalam 2,5 menit terakhir' : 'pernah membuka website dalam 24 jam terakhir'}. Tamu yang belum login tidak terhitung.</p>
      ${rows.length ? rows.map(u => `<div class="li"><span class="who" style="min-width:0">${ava(u)}<span><b>${esc(u.nama)}</b>${dot(u)}<div class="m">${esc(u.email)}</div></span></span><span style="text-align:right">${chipRole(u.role)}<div class="m">${esc(rel(seenOf(u)))}</div></span></div>`).join('') : '<div class="empty">Belum ada.</div>'}
      <div class="btns" style="margin-top:14px"><button class="btn ghost" type="button" id="oTut">Tutup</button></div>`, true);
    $('#oTut').onclick = closeModal;
  }

  function hapusAkun(uid) {
    const u = D.users.find(x => x.uid === uid); if (!u) return;
    const dampak = [];
    if (u.role === 'Pengajar') {
      const mine = D.pelajaran.filter(m => m.pengajar === u.email), nk = mine.reduce((a, m) => a + m.kelas.length, 0), np = new Set(mine.flatMap(m => joinsOf(m.id).map(j => j.partisipan))).size;
      dampak.push(`<b>${mine.length} pelajaran</b> dan <b>${nk} kelas</b> miliknya ikut terhapus (materi, tugas, quiz).`, `<b>${np} partisipan</b> kehilangan kelas tersebut beserta absen, tugas, nilai, dan hasil quiz mereka.`);
    } else {
      dampak.push(`Dikeluarkan dari <b>${D.join.filter(j => j.partisipan === u.email).length} pelajaran</b>; absen, tugas, nilai, dan hasil quiz-nya ikut terhapus.`);
    }
    dampak.push('Akun, profil, dan foto dihapus <b>permanen</b> dan tidak bisa dipulihkan.');
    modal(`<h3>Hapus akun ${esc(u.nama)}?</h3><p class="sub">${esc(u.email)} · ${esc(u.role)}</p><div class="warn"><b>Tindakan ini tidak bisa dibatalkan.</b><ul>${dampak.map(t => `<li>${t}</li>`).join('')}</ul></div>
      <label class="f" style="margin-top:14px">Ketik <b>HAPUS</b> untuk melanjutkan<input id="kH" autocomplete="off"></label><p class="err" id="kErr" role="alert"></p>
      <div class="btns"><button class="btn ghost" type="button" id="kBatal">Batal</button><button class="btn red" type="button" id="kOk">${ic('trash')} Hapus permanen</button></div>`);
    $('#kBatal').onclick = closeModal; $('#kH').focus();
    $('#kOk').onclick = async () => {
      if ($('#kH').value.trim() !== 'HAPUS') { $('#kErr').textContent = 'Ketik HAPUS (huruf kapital) untuk mengonfirmasi.'; return; }
      const b = $('#kOk'); b.disabled = true; b.textContent = 'Menghapus…';
      try { await api('akun_hapus', { uid }); closeModal(); await muatTenang(); toast('Akun ' + u.nama + ' dihapus'); }
      catch (x) { $('#kErr').textContent = x.message; b.disabled = false; b.innerHTML = ic('trash') + ' Hapus permanen'; }
    };
  }

  /* ----- tab Pelajaran ----- */
  function panePel() {
    $('#pane').innerHTML = `<div class="panel"><div class="tb"><div class="grow"><input type="search" id="sPl" placeholder="Cari nama pelajaran atau pengajar…" value="${esc(qPel)}" aria-label="Cari pelajaran"></div></div><div id="tPl"></div></div>`;
    $('#sPl').oninput = e => { qPel = e.target.value; tabelPel(); };
    tabelPel();
  }
  function tabelPel() {
    const q = qPel.trim().toLowerCase(), em = byEmail();
    const rows = D.pelajaran.filter(m => !q || [m.nama, m.kode, m.pengajarNama, m.pengajar].some(v => String(v || '').toLowerCase().includes(q)));
    $('#tPl').innerHTML = rows.length ? `<div class="tw"><table><thead><tr><th>Pelajaran</th><th>Pengajar</th><th>Kelas</th><th>Partisipan</th><th></th></tr></thead><tbody>${rows.map(m => { const t = em[m.pengajar]; return `<tr>
      <td><b>${esc(m.nama)}</b>${m.kode ? `<span class="m">Kode: ${esc(m.kode)}</span>` : ''}</td><td>${esc(t ? t.nama : m.pengajarNama || '—')}<span class="m">${esc(m.pengajar)}</span></td>
      <td>${m.kelas.length}${m.kelas.length ? `<span class="m">${esc(m.kelas.map(k => k.nama).join(', '))}</span>` : ''}</td><td>${joinsOf(m.id).length}</td>
      <td class="act"><button class="btn ghost sm" type="button" data-ang="${esc(m.id)}">${ic('users')} Anggota</button><button class="btn red sm" type="button" data-hp="${esc(m.id)}" aria-label="Hapus pelajaran ${esc(m.nama)}">${ic('trash')} Hapus</button></td></tr>`; }).join('')}</tbody></table></div>`
      : `<div class="empty">${D.pelajaran.length ? 'Tidak ada pelajaran yang cocok.' : 'Belum ada pelajaran yang dibuat pengajar.'}</div>`;
    $('#tPl').querySelectorAll('[data-ang]').forEach(b => { b.onclick = () => anggota(b.dataset.ang); });
    $('#tPl').querySelectorAll('[data-hp]').forEach(b => { b.onclick = () => hapusPel(b.dataset.hp); });
  }
  function anggota(id) {
    const m = D.pelajaran.find(x => x.id === id); if (!m) return;
    const em = byEmail(), js = joinsOf(id), known = new Set(m.kelas.map(k => k.id));
    const grup = m.kelas.map(k => ({ k, rows: js.filter(j => j.kelas === k.id) }));
    const lain = js.filter(j => !known.has(j.kelas)); if (lain.length) grup.push({ k: { nama: 'Tanpa kelas', kode: '' }, rows: lain });
    const tbl = rows => rows.length ? `<div class="tw"><table style="min-width:520px"><thead><tr><th>Nama</th><th>Gmail</th><th>No. HP</th><th>ID</th></tr></thead><tbody>${rows.map(j => { const u = em[j.partisipan]; return `<tr><td>${u ? `<div class="who" style="min-width:0">${ava(u)}<b>${esc(u.nama)}</b></div>` : '<i>(akun dihapus)</i>'}</td><td>${esc(j.partisipan)}</td><td>${esc(u ? u.hp || '—' : '—')}</td><td>${esc(u ? u.id || '—' : '—')}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="m" style="padding:4px 2px">Belum ada partisipan di kelas ini.</div>';
    modal(`<h3>Anggota: ${esc(m.nama)}</h3><p class="sub">Pengajar: ${esc(m.pengajarNama || m.pengajar)} · ${js.length} partisipan di ${m.kelas.length} kelas</p>
      ${grup.length ? grup.map(g => `<div class="kh">${esc(g.k.nama)} ${g.k.kode ? `<span class="chip s">${esc(g.k.kode)}</span>` : ''}<span class="m">${g.rows.length} partisipan</span></div>${tbl(g.rows)}`).join('') : '<div class="m">Pelajaran ini belum punya kelas.</div>'}
      <div class="btns" style="margin-top:16px"><button class="btn ghost" type="button" id="aTut">Tutup</button></div>`, true);
    $('#aTut').onclick = closeModal;
  }
  function hapusPel(id) {
    const m = D.pelajaran.find(x => x.id === id); if (!m) return;
    const n = joinsOf(id).length;
    modal(`<h3>Hapus pelajaran “${esc(m.nama)}”?</h3><p class="sub">Dibuat oleh ${esc(m.pengajarNama || m.pengajar)}</p><div class="warn"><b>Tindakan ini tidak bisa dibatalkan.</b><ul><li><b>${m.kelas.length} kelas</b> beserta seluruh pertemuan, materi, tugas, dan quiz terhapus.</li><li><b>${n} partisipan</b> keluar dari pelajaran ini; absen, tugas, nilai, dan hasil quiz mereka ikut terhapus.</li></ul></div>
      <label class="f" style="margin-top:14px">Ketik <b>HAPUS</b> untuk melanjutkan<input id="kH" autocomplete="off"></label><p class="err" id="kErr" role="alert"></p>
      <div class="btns"><button class="btn ghost" type="button" id="kBatal">Batal</button><button class="btn red" type="button" id="kOk">${ic('trash')} Hapus pelajaran</button></div>`);
    $('#kBatal').onclick = closeModal; $('#kH').focus();
    $('#kOk').onclick = async () => {
      if ($('#kH').value.trim() !== 'HAPUS') { $('#kErr').textContent = 'Ketik HAPUS (huruf kapital) untuk mengonfirmasi.'; return; }
      const b = $('#kOk'); b.disabled = true; b.textContent = 'Menghapus…';
      try { await api('pelajaran_hapus', { id }); closeModal(); await muatTenang(); toast('Pelajaran dihapus'); }
      catch (x) { $('#kErr').textContent = x.message; b.disabled = false; b.innerHTML = ic('trash') + ' Hapus pelajaran'; }
    };
  }

  /* ----- tab Notifikasi ----- */
  const relW = iso => { const t = Date.parse(iso); if (!t) return ''; const m = Math.max(0, Math.round((Date.now() - t) / 60000)); if (m < 1) return 'Baru saja'; if (m < 60) return m + ' menit lalu'; const h = Math.round(m / 60); if (h < 24) return h + ' jam lalu'; const d = Math.round(h / 24); return d < 7 ? d + ' hari lalu' : fmtDT(iso); };
  function paneNotif() {
    $('#pane').innerHTML = `<div class="panel"><div class="tb"><div class="seg" role="group" aria-label="Urutan"><button type="button" data-nu="baru" class="${nUrut === 'baru' ? 'on' : ''}">Terbaru</button><button type="button" data-nu="lama" class="${nUrut === 'lama' ? 'on' : ''}">Terlama</button></div>
      <select id="nFil" aria-label="Filter"><option value="semua">Semua</option><option value="belum">Belum dibaca</option></select><span class="grow"></span>
      <button class="btn ghost sm" type="button" id="nAll">Tandai semua dibaca</button><button class="btn ghost sm" type="button" id="nDel">Hapus yang sudah dibaca</button></div><div id="nList"><div class="loading">Memuat notifikasi…</div></div></div>`;
    $('#nFil').value = nHanyaBelum ? 'belum' : 'semua';
    $('#pane').querySelectorAll('[data-nu]').forEach(b => { b.onclick = () => { nUrut = b.dataset.nu; paneNotif(); }; });
    $('#nFil').onchange = e => { nHanyaBelum = e.target.value === 'belum'; muatNotif(); };
    $('#nAll').onclick = async () => { try { await api('notif_baca', { semua: true }); await muatNotif(); toast('Semua notifikasi ditandai dibaca'); } catch (x) { toast(x.message, true); } };
    $('#nDel').onclick = async () => { try { await api('notif_hapus', { dibaca: true }); await muatNotif(); toast('Notifikasi yang sudah dibaca dihapus'); } catch (x) { toast(x.message, true); } };
    muatNotif();
  }
  async function muatNotif() {
    if (tab !== 'not' || !$('#nList')) return;
    try { N = await api('notif_list', { urut: nUrut, hanyaBelum: nHanyaBelum }); } catch (e) { if ($('#nList')) $('#nList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    if (D) { D.notifBelum = N.belum; setBadgeNotif(); }
    const L = $('#nList'); if (!L) return;
    if (!N.ada) { L.innerHTML = `<div class="note"><b>Notifikasi belum aktif.</b><br>${esc(N.error || '')}</div>`; return; }
    L.innerHTML = N.items.length ? `<ul class="ql">${N.items.map(n => `<li class="qi nt${n.dibaca ? '' : ' unread'}" data-n="${n.id}"><span class="qn">${ic(NJ[n.jenis] || 'pulse')}</span><div class="qt"><b>${esc(n.judul)}</b>${n.isi ? `<div class="m">${esc(n.isi)}</div>` : ''}<div class="m" title="${esc(fmtDT(n.dibuat))}">${esc(relW(n.dibuat))}</div></div><div class="qb">${n.dibaca ? '' : `<button class="btn ghost sm" type="button" data-nb="${n.id}">Tandai dibaca</button>`}<button class="btn red sm" type="button" data-nx="${n.id}" aria-label="Hapus notifikasi" title="Hapus">${ic('trash')}</button></div></li>`).join('')}</ul>`
      : `<div class="empty">${nHanyaBelum ? 'Tidak ada notifikasi yang belum dibaca.' : 'Belum ada notifikasi.'}</div>`;
    L.querySelectorAll('[data-nb]').forEach(b => { b.onclick = async () => { try { await api('notif_baca', { id: +b.dataset.nb }); await muatNotif(); } catch (x) { toast(x.message, true); } }; });
    L.querySelectorAll('[data-nx]').forEach(b => { b.onclick = async () => { try { await api('notif_hapus', { id: +b.dataset.nx }); await muatNotif(); } catch (x) { toast(x.message, true); } }; });
  }

  /* ----- tab Kata motivasi ----- */
  function paneMot() {
    if (!D.quotes) { $('#pane').innerHTML = `<div class="panel"><div class="note"><b>Kata motivasi belum bisa dikelola.</b><br>${esc(D.quotesError || 'Tabel belum tersedia.')}</div></div>`; return; }
    $('#pane').innerHTML = `<div class="panel"><div class="qadd"><label class="f" style="margin:0" for="qNew">Tambah kata motivasi baru</label>
      <div class="row"><textarea id="qNew" maxlength="300" placeholder="Contoh: “Belajar hari ini, berhasil esok hari.” – Nama Tokoh"></textarea><button class="btn lime" type="button" id="qAdd">${ic('plus')} Tambah</button></div>
      <div class="cnt"><span id="qC">0</span>/300 · Kata motivasi tampil bergantian di beranda <b>pengajar</b> dan <b>partisipan</b>, berganti tiap beberapa detik. Total: ${D.quotes.length}.</div><p class="err" id="qErr" role="alert" style="margin:0"></p></div>
      <ul class="ql" id="qL"></ul></div>`;
    $('#qNew').oninput = e => { $('#qC').textContent = e.target.value.length; };
    $('#qAdd').onclick = async () => {
      const t = $('#qNew').value.replace(/\s+/g, ' ').trim(), er = $('#qErr'); er.textContent = '';
      if (t.length < 3) { er.textContent = 'Kata motivasi minimal 3 karakter.'; return; }
      const b = $('#qAdd'); b.disabled = true;
      try { await api('motivasi_tambah', { teks: t }); await muatTenang(); toast('Kata motivasi ditambahkan'); } catch (x) { er.textContent = x.message; b.disabled = false; }
    };
    listMot();
  }
  function listMot() {
    $('#qL').innerHTML = D.quotes.length ? D.quotes.map((q, i) => `<li class="qi" data-q="${q.id}"><span class="qn">${i + 1}</span><div class="qt">${esc(q.teks)}</div><div class="qb"><button class="btn ghost sm" type="button" data-qe="${q.id}">${ic('edit')} Ubah</button><button class="btn red sm" type="button" data-qd="${q.id}" aria-label="Hapus kata motivasi nomor ${i + 1}">${ic('trash')} Hapus</button></div></li>`).join('')
      : '<li class="empty">Belum ada kata motivasi. Beranda akan memakai kata bawaan sampai kamu menambahkannya.</li>';
    $('#qL').querySelectorAll('[data-qe]').forEach(b => { b.onclick = () => editMot(+b.dataset.qe); });
    $('#qL').querySelectorAll('[data-qd]').forEach(b => { b.onclick = () => hapusMot(+b.dataset.qd); });
  }
  function editMot(id) {
    const q = D.quotes.find(x => x.id === id), li = $(`[data-q="${id}"]`); if (!q || !li) return;
    li.querySelector('.qt').innerHTML = `<textarea maxlength="300" id="qEd">${esc(q.teks)}</textarea><p class="err" id="qEe" role="alert" style="margin:4px 0 0"></p>`;
    li.querySelector('.qb').innerHTML = `<button class="btn lime sm" type="button" id="qSv">Simpan</button><button class="btn ghost sm" type="button" id="qCx">Batal</button>`;
    const ta = $('#qEd'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    $('#qCx').onclick = listMot;
    $('#qSv').onclick = async () => {
      const t = ta.value.replace(/\s+/g, ' ').trim(); if (t.length < 3) { $('#qEe').textContent = 'Kata motivasi minimal 3 karakter.'; return; }
      const b = $('#qSv'); b.disabled = true;
      try { await api('motivasi_ubah', { id, teks: t }); await muatTenang(); toast('Kata motivasi diperbarui'); } catch (x) { $('#qEe').textContent = x.message; b.disabled = false; }
    };
  }
  function hapusMot(id) {
    const q = D.quotes.find(x => x.id === id); if (!q) return;
    modal(`<h3>Hapus kata motivasi ini?</h3><p class="sub" style="margin-top:10px">${esc(q.teks)}</p><p class="err" id="kErr" role="alert"></p><div class="btns"><button class="btn ghost" type="button" id="kBatal">Batal</button><button class="btn red" type="button" id="kOk">${ic('trash')} Hapus</button></div>`);
    $('#kBatal').onclick = closeModal;
    $('#kOk').onclick = async () => { const b = $('#kOk'); b.disabled = true; try { await api('motivasi_hapus', { id }); closeModal(); await muatTenang(); toast('Kata motivasi dihapus'); } catch (x) { $('#kErr').textContent = x.message; b.disabled = false; } };
  }

  /* ---------- awal ---------- */
  if (TOKEN) mulai(); else viewLogin('');
})();
