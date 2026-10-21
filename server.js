// Local development server (Node 18+). Mirrors Vercel: serves the static site and routes /api/* to the
// same serverless handlers. Only public files are served; .env, .git, api/ source etc. are never exposed.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const MAX_BODY = 1_000_000; // 1 MB
const PUBLIC = [/^\/index\.html$/, /^\/app\/[a-z0-9_-]+\.js$/, /^\/data\/[a-z0-9_-]+\.json$/, /^\/lib\/[a-z0-9_-]+\.js$/, /^\/tests\/browser\.html$/, /^\/tests\/[a-z0-9_-]+\.js$/, /^\/favicon\.svg$/, /^\/assets\/[a-z0-9_-]+\.(jpg|png|webp)$/];
const mime = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const routes = { '/api/analyze': './api/analyze.js', '/api/tiktok-review': './api/tiktok-review.js', '/api/health': './api/health.js' };

// Load KEY=value pairs from a local .env without any dependency (values never logged).
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch (e) { /* no .env file */ }

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('too_large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(Object.assign(new Error('bad_json'), { status: 400 })); } });
    req.on('error', reject);
  });
}

// Minimal Vercel-style response helpers.
function wrap(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return res; };
  return res;
}

http.createServer(async (req, res) => {
  wrap(res);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const url = new URL(req.url, 'http://localhost');
  if (routes[url.pathname]) {
    try {
      req.body = req.method === 'POST' ? await readJson(req) : {};
      return await require(routes[url.pathname])(req, res);
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.status === 413 ? 'payload_too_large' : e.status === 400 ? 'bad_json' : 'server_error' });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ error: 'method_not_allowed' });
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!PUBLIC.some(re => re.test(pathname))) { res.statusCode = 404; return res.end('Not found'); }
  const full = path.join(root, pathname);
  fs.readFile(full, (err, buf) => {
    if (err) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', mime[path.extname(full)] || 'application/octet-stream');
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}).listen(port, () => console.log(`TrustLens dev server: http://localhost:${port}`));
