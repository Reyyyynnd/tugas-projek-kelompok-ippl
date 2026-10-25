// Server lokal untuk mencoba KelasBelajar dengan alamat bersih (/beranda, /pelajaran, /progres, /pengaturan, /profil)
// seperti di Vercel. Aturannya dibaca dari vercel.json, jadi selalu sama dengan situs asli.
// Cara pakai:  node server.js   lalu buka  http://localhost:3000
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = __dirname, PORT = +process.env.PORT || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')); } catch (e) { console.warn('vercel.json tidak terbaca, aturan alamat tidak dipakai.'); }
// "/pelajaran/:path*" -> ^/pelajaran(?:/.*)?$ ; "/beranda" -> ^/beranda$
const toRe = src => { const wild = /\/:\w+\*$/.test(src), base = src.replace(/\/:\w+\*$/, ''); return new RegExp('^' + base.replace(/[.+?^${}()|[\]\\]/g, '\\$&') + (wild ? '(?:/.*)?' : '') + '$'); };
const rules = (cfg.rewrites || []).map(r => ({ re: toRe(r.source), to: r.destination }));
const send = (res, code, body, type, extra) => { res.writeHead(code, Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': 'kb-clean-' + PORT + '=1; Path=/; SameSite=Lax' }, extra || {})); res.end(body); };
const isFile = f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p; try { p = decodeURIComponent(u.pathname); } catch (e) { return send(res, 400, 'Alamat tidak valid'); }
  // /index.html -> /  dan /profil.html -> /profil (cleanUrls)
  if (cfg.cleanUrls && /\.html$/.test(p)) { const clean = p.replace(/\/index\.html$/, '/').replace(/\.html$/, '') || '/'; return send(res, 302, '', 'text/plain', { Location: clean + u.search }); }
  let file = null;
  const direct = path.join(ROOT, p);
  if (direct.startsWith(ROOT) && isFile(direct)) file = direct;
  else if (p === '/' && isFile(path.join(ROOT, 'index.html'))) file = path.join(ROOT, 'index.html');
  else {
    const rw = rules.find(r => r.re.test(p));
    if (rw) file = path.join(ROOT, rw.to);
    else if (cfg.cleanUrls && isFile(path.join(ROOT, p + '.html'))) file = path.join(ROOT, p + '.html');
  }
  if (!file || !file.startsWith(ROOT) || !isFile(file)) return send(res, 404, '404 - halaman tidak ditemukan');
  fs.readFile(file, (err, buf) => err ? send(res, 500, 'Gagal membaca file') : send(res, 200, buf, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'));
}).listen(PORT, () => console.log('KelasBelajar berjalan di http://localhost:' + PORT + '  (tekan Ctrl+C untuk berhenti)'));
