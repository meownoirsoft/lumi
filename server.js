import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { parseYouTube, parsePlaylist, parseTime } from './lib/youtube.js';
import { DEFAULT_SCHEDULE, normalizeSchedule, screenState, makeOverride, timeLabel } from './lib/schedule.js';
import { parseWebInput, probe, extractTitle, WEB_KINDS, MAX_HTML_BYTES } from './lib/web.js';
import { searchLibrary, resolveAsset, resolveApod, resolveEpic, resolveChannelLive } from './lib/nasa.js';

const root = dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(join(root, '.env')); } catch { /* no .env is fine */ }

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const db = openDb(process.env.DB_FILE || join(root, 'data', 'window.db'));
const presets = JSON.parse(readFileSync(join(root, 'presets.json'), 'utf8'));

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });
await app.register(fastifyStatic, { root: join(root, 'public') });

// A display never needs these. Denying them here also covers embedded YouTube
// iframes, so nothing on the page can trigger a camera/mic permission prompt.
app.addHook('onSend', async (req, reply) => {
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), display-capture=()');
});

// --- Server-Sent Events hub ---------------------------------------------------
const clients = new Set();
// Changes on every start. Players reload when it changes, so after an update
// they run the new code instead of the page they loaded before it.
const BOOT_ID = randomUUID();
let nowPlaying = null;
// Connected player pages: id -> { ip, visible }. Only a visible player's
// reports count, so a forgotten tab or a covered window can't flag items.
const players = new Map();
const playerList = () => [...players.entries()].map(([id, p]) => ({ id, ...p }));
const isHiddenPlayer = (id) => id != null && players.get(id)?.visible === false;

function broadcast(event, data = {}) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
const changed = () => broadcast('playlist-changed');

app.get('/api/events', (req, reply) => {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ boot: BOOT_ID })}\n\n`);
  res.write(`event: now-playing\ndata: ${JSON.stringify(nowPlaying)}\n\n`);
  res.write(`event: screen\ndata: ${JSON.stringify(screen())}\n\n`);
  clients.add(res);
  const playerId = typeof req.query.player === 'string' ? req.query.player.slice(0, 64) : null;
  if (playerId) {
    players.set(playerId, { ip: req.ip, visible: req.query.visible === '1' });
    broadcast('players', playerList());
  } else {
    res.write(`event: players\ndata: ${JSON.stringify(playerList())}\n\n`);
  }
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.raw.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
    if (playerId && players.delete(playerId)) broadcast('players', playerList());
  });
});

app.post('/api/player-status', async (req) => {
  const p = players.get(String(req.body?.player ?? ''));
  if (p) { p.visible = !!req.body.visible; broadcast('players', playerList()); }
  return { ok: true };
});

// --- Pages --------------------------------------------------------------------
app.get('/', (req, reply) => reply.redirect('/admin'));
app.get('/admin', (req, reply) => reply.sendFile('admin.html'));
app.get('/player', (req, reply) => reply.sendFile('player.html'));

// --- Device info (shown on the player's idle screen) ----------------------------
// Addresses other devices on the network can use to reach the admin page.
app.get('/api/info', () => {
  const ips = Object.entries(networkInterfaces())
    .filter(([name]) => !/^(lo|docker|br-|veth|virbr|tun|tailscale|zt)/.test(name))
    .flatMap(([, addrs]) => addrs ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
  const host = hostname();
  return {
    hostname: host,
    port: PORT,
    adminUrls: [...ips.map((ip) => `http://${ip}:${PORT}/admin`), `http://${host}.local:${PORT}/admin`],
  };
});

// --- Items --------------------------------------------------------------------
// Pasted HTML can be large and is fetched by itself (/api/items/:id/html).
const brief = (item) => (typeof item?.payload?.html === 'string' ? { ...item, payload: { ...item.payload, html: true } } : item);
app.get('/api/items', () => db.listItems().map(brief));
app.get('/api/presets', () => presets);

async function youtubeMeta(videoId) {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error('This video does not allow embedding (owner disabled it).'), { statusCode: 422 });
  }
  if (!res.ok) throw Object.assign(new Error('Video not found, or it is private.'), { statusCode: 422 });
  return res.json();
}

// Title/thumbnail via oEmbed, plus the video count from the playlist page
// (best effort; it's only shown in the admin list).
async function playlistMeta(listId) {
  const page = `https://www.youtube.com/playlist?list=${listId}`;
  const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(page)}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw Object.assign(new Error('Playlist not found, or it is private.'), { statusCode: 422 });
  const meta = await res.json();
  let count = null;
  try {
    const html = await fetch(page, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(10000) }).then((r) => r.text());
    const m = /"stats":\[\{"runs":\[\{"text":"([\d,]+)"\},\{"text":" videos?"/.exec(html);
    if (m) count = Number(m[1].replace(/,/g, ''));
  } catch { /* count is optional */ }
  return { ...meta, count };
}

const bad = (msg) => Object.assign(new Error(msg), { statusCode: 400 });
const optInt = (v) => (v === undefined || v === null || v === '' ? null : Math.max(1, parseInt(v, 10) || 0) || null);

app.post('/api/items', async (req) => {
  const b = req.body ?? {};
  const kind = b.kind ?? 'youtube';
  let item;

  const pl = kind === 'youtube' ? parsePlaylist(b.input) : null;
  if (pl) {
    if (pl.isMix) throw bad("That's a YouTube Mix, which is generated per viewer and can't be embedded. Use a regular playlist link (youtube.com/playlist?list=PL…).");
    const meta = await playlistMeta(pl.listId);
    item = db.addItem({
      type: 'youtube_playlist',
      title: meta.title,
      source: [meta.author_name, meta.count != null && `${meta.count} video${meta.count === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || 'YouTube',
      payload: { listId: pl.listId, count: meta.count, thumb: meta.thumbnail_url },
      duration_sec: optInt(b.duration_sec),
    });
  } else if (kind === 'youtube') {
    const yt = parseYouTube(b.input);
    if (!yt) throw bad("That doesn't look like a YouTube video or playlist link, or an 11-character video ID.");
    const meta = await youtubeMeta(yt.videoId);
    const isLive = yt.isLive || !!b.isLive;
    item = db.addItem({
      type: 'youtube',
      title: meta.title,
      source: meta.author_name ?? 'YouTube',
      payload: { videoId: yt.videoId, start: yt.start, isLive, thumb: `https://i.ytimg.com/vi/${yt.videoId}/hqdefault.jpg` },
      duration_sec: optInt(b.duration_sec),
    });
  } else if (kind === 'youtube_channel_live') {
    if (!/^UC[\w-]{22}$/.test(b.channelId ?? '')) throw bad('Invalid channel ID.');
    item = db.addItem({
      type: 'youtube',
      title: b.title || 'Channel live stream',
      source: 'YouTube live',
      payload: { channelId: b.channelId, isLive: true },
      duration_sec: optInt(b.duration_sec),
    });
  } else if (kind === 'nasa') {
    if (!b.nasaId) throw bad('nasaId is required.');
    const asset = await resolveAsset(b.nasaId);
    item = db.addItem({
      type: asset.kind === 'video' ? 'nasa_video' : 'nasa_image',
      title: b.title || b.nasaId,
      source: 'NASA Image and Video Library',
      payload: { nasaId: b.nasaId, url: asset.url, thumb: b.thumb || asset.thumb },
      duration_sec: optInt(b.duration_sec),
    });
  } else if (kind === 'web') {
    const web = parseWebInput(b.input);
    if (!web) throw bad("That doesn't look like a web address (https://…) or an HTML page (starting with <).");
    const reloadSec = optInt(b.reloadSec);
    if (web.html) {
      if (Buffer.byteLength(web.html) > MAX_HTML_BYTES) throw bad(`That HTML is too big (the limit is ${MAX_HTML_BYTES / 1024} KB).`);
      item = db.addItem({
        type: 'web',
        title: b.title || extractTitle(web.html) || 'HTML page',
        source: 'Pasted HTML',
        payload: { kind: 'page', html: web.html, reloadSec },
        duration_sec: optInt(b.duration_sec),
      });
    } else {
      const p = await probe(web.url);
      const as = WEB_KINDS.includes(b.as) ? b.as : p.kind;
      const { host, pathname } = new URL(web.url);
      // Cameras rarely have a page title; their file name ("video.mjpg") says more than the host.
      const file = decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '');
      item = db.addItem({
        type: 'web',
        title: b.title || p.title || (file && as !== 'page' ? file : host),
        source: host,
        payload: { kind: as, url: web.url, hls: as === 'video' && p.hls, reloadSec, embedBlocked: as === 'page' && p.embedBlocked, reachable: p.reachable },
        duration_sec: optInt(b.duration_sec),
      });
    }
  } else if (kind === 'apod') {
    item = db.addItem({ type: 'apod', title: 'Astronomy Picture of the Day', source: 'NASA APOD', duration_sec: optInt(b.duration_sec) });
  } else if (kind === 'epic') {
    item = db.addItem({ type: 'epic', title: 'EPIC — Earth from a million miles', source: 'NASA EPIC / DSCOVR', duration_sec: optInt(b.duration_sec) });
  } else {
    throw bad(`Unknown kind "${kind}".`);
  }
  changed();
  return brief(item);
});

// Item types whose start point can be set (live streams and playlists can't seek).
const START_TYPES = new Set(['youtube', 'nasa_video']);

app.patch('/api/items/:id', async (req, reply) => {
  const id = Number(req.params.id);
  if (!db.getItem(id)) return reply.code(404).send({ error: 'Not found' });
  const b = req.body ?? {};
  const patch = {};
  if ('title' in b) patch.title = String(b.title).slice(0, 300);
  if ('enabled' in b) patch.enabled = !!b.enabled;
  if ('duration_sec' in b) patch.duration_sec = optInt(b.duration_sec);
  if ('isLive' in b) patch.payload = { ...db.getItem(id).payload, isLive: !!b.isLive };
  if ('reloadSec' in b) {
    if (db.getItem(id).type !== 'web') throw bad('Only web items can reload.');
    patch.payload = { ...(patch.payload ?? db.getItem(id).payload), reloadSec: optInt(b.reloadSec) };
  }
  if ('start' in b) {
    if (!START_TYPES.has(db.getItem(id).type)) throw bad('This item has no start time.');
    const raw = String(b.start ?? '').trim();
    const start = parseTime(raw);
    if (raw && !start && !/^[0:]+s?$/.test(raw)) throw bad('Start time should look like 90, 1:30 or 1m30s.');
    patch.payload = { ...(patch.payload ?? db.getItem(id).payload), start };
  }
  const item = db.updateItem(id, patch);
  changed();
  return brief(item);
});

// Pasted HTML, served from here so the player can frame it.
app.get('/api/items/:id/html', async (req, reply) => {
  const item = db.getItem(Number(req.params.id));
  if (item?.type !== 'web' || typeof item.payload.html !== 'string') return reply.code(404).send({ error: 'Not found' });
  // The player frames it sandboxed; the CSP keeps it sandboxed when opened directly,
  // so its scripts never run with this server's origin.
  return reply.type('text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Content-Security-Policy', 'sandbox allow-scripts allow-forms')
    .send(item.payload.html);
});

app.delete('/api/items/:id', async (req, reply) => {
  if (!db.deleteItem(Number(req.params.id))) return reply.code(404).send({ error: 'Not found' });
  changed();
  return { ok: true };
});

app.put('/api/items/order', async (req) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.every(Number.isInteger)) throw bad('ids must be an array of integers.');
  db.reorder(ids);
  changed();
  return { ok: true };
});

// --- Player reporting ---------------------------------------------------------
app.post('/api/now-playing', async (req) => {
  if (isHiddenPlayer(req.body?.player)) return { ok: true, ignored: 'player not visible' };
  const id = Number(req.body?.id);
  nowPlaying = { id, at: Date.now() };
  const item = db.getItem(id);
  if (item?.error) { db.updateItem(id, { error: null }); changed(); }
  broadcast('now-playing', nowPlaying);
  return { ok: true };
});

app.post('/api/items/:id/error', async (req) => {
  if (isHiddenPlayer(req.body?.player)) return { ok: true, ignored: 'player not visible' };
  const id = Number(req.params.id);
  const item = db.getItem(id);
  const msg = String(req.body?.error ?? 'Playback failed').slice(0, 300);
  if (item && item.error !== msg) { db.updateItem(id, { error: msg }); changed(); }
  return { ok: true };
});

// --- Settings -----------------------------------------------------------------
app.get('/api/settings', () => db.getSettings());
app.put('/api/settings', async (req) => {
  db.setSettings(req.body ?? {});
  changed();
  return db.getSettings();
});

// --- Screen schedule ----------------------------------------------------------
// The player blanks itself while the screen is "off", and the kiosk polls
// /api/screen/power to put the display itself to sleep (see kiosk/screen-power.sh).
const schedule = () => db.getJson('schedule', DEFAULT_SCHEDULE);
function screen() {
  const now = Date.now();
  const s = screenState(schedule(), db.getJson('screen_override'), now);
  if (s.next) s.next.label = timeLabel(s.next.at, now);
  return { ...s, clock: timeLabel(now, now) };
}

let lastScreenOn = screen().on;
function screenChanged() {
  const s = screen();
  lastScreenOn = s.on;
  broadcast('screen', s);
  return s;
}
// Catch scheduled changes as they happen, and drop overrides that have run out.
setInterval(() => {
  const o = db.getJson('screen_override');
  if (o?.until != null && Date.now() >= o.until) db.setJson('screen_override', null);
  if (screen().on !== lastScreenOn) screenChanged();
}, 10_000).unref();

app.get('/api/screen', () => screen());
app.get('/api/screen/power', (req, reply) => reply.type('text/plain').send(screen().on ? 'on' : 'off'));
app.post('/api/screen', async (req) => {
  if (typeof req.body?.on !== 'boolean') throw bad('on must be true or false.');
  db.setJson('screen_override', makeOverride(schedule(), req.body.on));
  return screenChanged();
});
app.get('/api/schedule', () => schedule());
app.put('/api/schedule', async (req) => {
  const s = normalizeSchedule(req.body);
  db.setJson('schedule', s);
  // A new schedule starts clean rather than inheriting an old "on/off now".
  db.setJson('screen_override', null);
  screenChanged();
  return s;
});

// --- NASA ---------------------------------------------------------------------
app.get('/api/nasa/search', async (req) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) throw bad('Enter a search term.');
  return searchLibrary(q, req.query.type);
});
app.get('/api/nasa/asset/:nasaId', (req) => resolveAsset(req.params.nasaId));
app.get('/api/resolve/apod', () => resolveApod());
app.get('/api/resolve/epic', () => resolveEpic());
app.get('/api/resolve/channel-live/:channelId', (req) => {
  if (!/^UC[\w-]{22}$/.test(req.params.channelId)) throw bad('Invalid channel ID.');
  return resolveChannelLive(req.params.channelId);
});

app.setErrorHandler((err, req, reply) => {
  const code = err.statusCode ?? 502;
  if (code >= 500) req.log.error(err);
  reply.code(code).send({ error: err.message });
});

await app.listen({ port: PORT, host: HOST });
