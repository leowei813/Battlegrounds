/**
 * 絕地求生 雲端存檔伺服器（零相依，Node 18+）
 *
 *   npm run server
 *
 * 環境變數：
 *   PORT         監聽埠（預設 8787）
 *   DATA_DIR     存檔目錄（預設 server/data）
 *   STATIC_DIR   一併提供的前端靜態檔（預設 dist，存在才啟用）
 *   CORS_ORIGIN  允許的前端來源，逗號分隔（預設 *）
 *
 * API（Authorization: Bearer <token>，token = sha256("jdqs-secret:" + 同步碼)）
 *   GET  /api/health
 *   GET  /api/saves/:id/meta      → { rev, updatedAt, deviceId, deviceName }
 *   GET  /api/saves/:id           → { meta, data }
 *   PUT  /api/saves/:id           ← { baseRev, deviceId, deviceName, data, force? }
 *                                 → 200 { meta } | 409 { meta } | 403
 *   GET  /api/saves/:id/events?token=…   Server-Sent Events：其他裝置寫入時即時推送 meta
 *
 * 多人世界（玩家自願公開的據點與探索隊伍）：
 *   PUT    /api/world/players/:id   ← { name, civ, bases[], trips[] }（Bearer = 玩家 token 雜湊）
 *   DELETE /api/world/players/:id   停止公開
 *   GET    /api/world/nearby?lat=&lon=&km=&exclude=   附近玩家（km 最大 20）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SaveStore } from './SaveStore.js';
import { WorldStore } from './WorldStore.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(ROOT, '..', 'dist'));
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim());
const MAX_BODY = 2 * 1024 * 1024;
const RATE_LIMIT = 120; // 每 IP 每分鐘請求數

const ID_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const store = new SaveStore(DATA_DIR);
const world = new WorldStore(DATA_DIR);
/** @type {Map<string, Set<http.ServerResponse>>} */
const watchers = new Map();
const hits = new Map();

function cors(req, res) {
  const origin = req.headers.origin;
  if (CORS_ORIGINS.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function rateLimited(req) {
  const ip = req.socket.remoteAddress || '?';
  const now = Date.now();
  const h = hits.get(ip) || { start: now, n: 0 };
  if (now - h.start > 60000) Object.assign(h, { start: now, n: 0 });
  h.n += 1;
  hits.set(ip, h);
  return h.n > RATE_LIMIT;
}

function bearer(req) {
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(req.headers.authorization || '');
  return m ? m[1].toLowerCase() : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function broadcast(id, meta) {
  const set = watchers.get(id);
  if (!set) return;
  const msg = `event: rev\ndata: ${JSON.stringify(meta)}\n\n`;
  set.forEach((res) => res.write(msg));
}

function watch(req, res, id, token) {
  const rec = store.read(id);
  if (!rec || !SaveStore.matches(rec, token)) return json(res, 403, { error: 'forbidden' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 5000\nevent: rev\ndata: ${JSON.stringify(SaveStore.meta(rec))}\n\n`);
  if (!watchers.has(id)) watchers.set(id, new Set());
  watchers.get(id).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    watchers.get(id)?.delete(res);
    if (!watchers.get(id)?.size) watchers.delete(id);
  });
  return null;
}

async function handleWorld(req, res, url) {
  if (url.pathname === '/api/world/nearby' && req.method === 'GET') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    const km = Math.min(20, Math.max(0.5, Number(url.searchParams.get('km')) || 5));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error: 'invalid position' });
    return json(res, 200, { players: world.nearby(lat, lon, km, String(url.searchParams.get('exclude') || '')) });
  }
  const m = /^\/api\/world\/players\/([^/]+)$/.exec(url.pathname);
  if (!m || !ID_RE.test(m[1])) return json(res, 404, { error: 'not found' });
  const token = bearer(req);
  if (!token) return json(res, 401, { error: 'unauthorized' });
  if (req.method === 'PUT') {
    const result = world.put(m[1], token, await readBody(req));
    if (result === 'forbidden') return json(res, 403, { error: 'forbidden' });
    if (result === 'invalid') return json(res, 400, { error: 'invalid body' });
    return json(res, 200, { ok: true });
  }
  if (req.method === 'DELETE') {
    return world.remove(m[1], token) === 'forbidden' ? json(res, 403, { error: 'forbidden' }) : json(res, 200, { ok: true });
  }
  return json(res, 405, { error: 'method not allowed' });
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') return json(res, 200, { ok: true, time: Date.now(), world: true });
  if (url.pathname.startsWith('/api/world/')) return handleWorld(req, res, url);
  const m = /^\/api\/saves\/([^/]+)(\/meta|\/events)?$/.exec(url.pathname);
  if (!m || !ID_RE.test(m[1])) return json(res, 404, { error: 'not found' });
  const [, id, sub] = m;

  if (sub === '/events' && req.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    if (!TOKEN_RE.test(token)) return json(res, 403, { error: 'forbidden' });
    return watch(req, res, id, token);
  }

  const token = bearer(req);
  if (!token) return json(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET') {
    const rec = store.read(id);
    if (!rec) return json(res, 404, { error: 'not found' });
    if (!SaveStore.matches(rec, token)) return json(res, 403, { error: 'forbidden' });
    return json(res, 200, sub === '/meta' ? { meta: SaveStore.meta(rec) } : { meta: SaveStore.meta(rec), data: rec.data });
  }

  if (req.method === 'PUT' && !sub) {
    const body = await readBody(req);
    if (!body || typeof body.data !== 'object' || !Number.isInteger(body.baseRev)) {
      return json(res, 400, { error: 'invalid body' });
    }
    const result = store.put(id, token, {
      baseRev: body.baseRev,
      deviceId: String(body.deviceId || '').slice(0, 64),
      deviceName: String(body.deviceName || '').slice(0, 64),
      data: body.data,
      force: body.force === true,
    });
    if (result.status === 'forbidden') return json(res, 403, { error: 'forbidden' });
    if (result.status === 'conflict') return json(res, 409, { meta: result.meta });
    broadcast(id, result.meta);
    return json(res, 200, { meta: result.meta });
  }
  return json(res, 405, { error: 'method not allowed' });
}

function serveStatic(req, res, url) {
  if (!fs.existsSync(STATIC_DIR)) return json(res, 404, { error: 'not found' });
  const safe = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(STATIC_DIR, safe);
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + path.sep)) return json(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(STATIC_DIR, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      cors(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      if (rateLimited(req)) return json(res, 429, { error: 'too many requests' });
      return await handleApi(req, res, url);
    }
    return serveStatic(req, res, url);
  } catch (err) {
    console.error('[server]', err);
    return json(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`☁️  雲端存檔伺服器啟動：http://localhost:${PORT}`);
  console.log(`   存檔目錄：${DATA_DIR}`);
  if (fs.existsSync(STATIC_DIR)) console.log(`   前端靜態檔：${STATIC_DIR}`);
});
