// Production server for the public website: serves the built site (dist/)
// and nothing else. No dependencies. Applies the security headers from
// dist/_headers, answers 404 for the paths listed in dist/_redirects,
// compresses text and WebAssembly, and supports range requests (video seeking).
//
//   PORT=8000 node serve.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const DIST = process.env.SITE_DIST ? path.resolve(process.env.SITE_DIST) : path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const PORT = Number(process.env.PORT ?? 8000);
const HOST = process.env.HOST ?? '0.0.0.0';

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`[website] ${DIST} has no index.html`);
  process.exit(1);
}

// "/*" style patterns from _headers / _redirects → RegExp
const pattern = (p) => new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

const headerRules = [];
{
  let cur = null;
  for (const line of fs.readFileSync(path.join(DIST, '_headers'), 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\S/.test(line)) headerRules.push((cur = { re: pattern(line.trim()), headers: {} }));
    else if (cur && line.includes(':')) {
      const i = line.indexOf(':');
      cur.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
}
const blocked = fs
  .readFileSync(path.join(DIST, '_redirects'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#') && /\s404!?$/.test(l))
  .map((l) => pattern(l.split(/\s+/)[0]));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream',
};
const COMPRESS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.xml', '.txt', '.svg', '.wasm', '.bin']);
const compressed = new Map(); // `${file}:${encoding}` → Buffer

const headersFor = (urlPath) => {
  const h = {};
  for (const r of headerRules) if (r.re.test(urlPath)) Object.assign(h, r.headers);
  return h;
};

const resolve = (urlPath) => {
  const rel = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(DIST, rel);
  if (!file.startsWith(DIST)) return null;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  else if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
};

const notFound = (res, base) => {
  const page = path.join(DIST, '404.html');
  res.writeHead(404, { ...base, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(fs.existsSync(page) ? fs.readFileSync(page) : 'Not found');
};

http
  .createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://site');
      const p = url.pathname;
      const base = headersFor(p);
      delete base['Cache-Control'];
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { ...base, allow: 'GET, HEAD' });
        return res.end();
      }
      if (blocked.some((re) => re.test(p)) || p.split('/').some((seg) => seg.startsWith('.') && seg.length > 1)) return notFound(res, base);
      // directories without a trailing slash: /create → /create/
      const asDir = path.join(DIST, decodeURIComponent(p));
      if (!p.endsWith('/') && asDir.startsWith(DIST) && fs.existsSync(asDir) && fs.statSync(asDir).isDirectory()) {
        res.writeHead(301, { ...base, location: p + '/' + url.search });
        return res.end();
      }
      const file = resolve(p);
      if (!file) return notFound(res, base);
      const ext = path.extname(file);
      const headers = {
        ...headersFor(p),
        'content-type': TYPES[ext] ?? 'application/octet-stream',
        // unhashed files (the page and its entry script) are always revalidated, so a new build shows at once
        'cache-control': headersFor(p)['Cache-Control'] ?? 'no-cache',
        vary: 'accept-encoding',
      };
      delete headers['Cache-Control'];
      const size = fs.statSync(file).size;
      const accept = String(req.headers['accept-encoding'] ?? '');
      const enc = COMPRESS.has(ext) ? (/\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null) : null;
      // files compressed ahead of time (file.br / file.gz) are sent as they are
      const pre = enc && fs.existsSync(`${file}.${enc === 'br' ? 'br' : 'gz'}`) ? `${file}.${enc === 'br' ? 'br' : 'gz'}` : null;
      if (pre) {
        const n = fs.statSync(pre).size;
        res.writeHead(200, { ...headers, 'content-encoding': enc, 'content-length': n });
        if (req.method === 'HEAD') return res.end();
        return void fs.createReadStream(pre).pipe(res);
      }
      if (enc && size > 2_000_000) {
        // large files without a compressed copy go out as they are rather than tie up the server
        res.writeHead(200, { ...headers, 'accept-ranges': 'bytes', 'content-length': size });
        if (req.method === 'HEAD') return res.end();
        return void fs.createReadStream(file).pipe(res);
      }
      if (enc) {
        const key = `${file}:${enc}`;
        if (!compressed.has(key)) {
          const raw = fs.readFileSync(file);
          compressed.set(key, enc === 'br' ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }) : zlib.gzipSync(raw, { level: 9 }));
        }
        const body = compressed.get(key);
        res.writeHead(200, { ...headers, 'content-encoding': enc, 'content-length': body.length });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      // ranges (videos)
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start >= size || start > end) {
          res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
          return res.end();
        }
        res.writeHead(206, { ...headers, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
        if (req.method === 'HEAD') return res.end();
        return void fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...headers, 'accept-ranges': 'bytes', 'content-length': size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      console.error('[website]', e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  })
  .listen(PORT, HOST, () => console.log(`[website] serving ${DIST} on http://${HOST}:${PORT}`));
