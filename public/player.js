// Kiosk player: plays enabled playlist items in order, forever.
// Each item is mounted into the hidden layer, shown once it's actually playing,
// then crossfaded in. Playlist edits arrive over SSE and apply from the next item.

// A Pi can take a while to start YouTube, especially right after boot.
const READY_TIMEOUT_MS = 45_000;
// One-off hiccups (slow start, stall, network blip) are only flagged in the
// admin page once an item has hit this many in a row.
const FLAG_AFTER_HICCUPS = 3;
const STALL_LIMIT_MS = 60_000;
const RETRY_MS = 10_000;
const RELOAD_AFTER_MS = 24 * 60 * 60 * 1000;

const layers = [document.getElementById('layer-a'), document.getElementById('layer-b')];
const idle = document.getElementById('idle');

// Idle screen: show where to reach the admin page from a phone, as text and a
// QR code. Looked up each time, since the Pi's IP address can change.
async function showIdleInfo() {
  let urls = [`${location.origin}/admin`];
  try {
    const info = await api('/api/info');
    if (info.adminUrls?.length) urls = info.adminUrls;
  } catch { /* offline: fall back to this page's own address */ }
  const qrBox = document.getElementById('idle-qr');
  if (window.qrcode) {
    const qr = window.qrcode(0, 'M');
    qr.addData(urls[0]);
    qr.make();
    qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }
  // The first address (what the QR opens) plus the hostname.local one, if different.
  const shown = urls.length > 1 ? [urls[0], urls[urls.length - 1]] : urls;
  document.getElementById('idle-urls').replaceChildren(...shown.map((u) => {
    const span = document.createElement('span');
    span.textContent = u.replace(/^http:\/\//, '');
    return span;
  }));
}

let playlist = [];
let settings = {};
let front = 0;            // index into layers of the visible layer
let current = null;       // { item, slot }
let lastIndex = -1;
let busy = false;
let failStreak = 0;
// Outside the screen schedule the player stops and shows black, so nothing
// streams while the display is asleep.
let screenOn = true;
const sleepCover = document.getElementById('sleep');
// Identifies this player to the server, which shows connected players in the
// admin page and ignores reports from players that aren't on screen.
const PLAYER_ID = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const visible = () => document.visibilityState === 'visible';
const hiccups = new Map();   // item id -> consecutive one-off failures
let retryTimer = null;
const bootedAt = Date.now();

// --- helpers ------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);

function withTimeout(p, ms, msg) {
  return Promise.race([p, sleep(ms).then(() => { throw new Error(msg); })]);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status}`);
  return body;
}
const post = (path, body) => api(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...body, player: PLAYER_ID }),
}).catch(() => {});

// A deferred "ended" signal each mount resolves (finished) or rejects (failed).
function makeSlot() {
  let finish, fail;
  const ended = new Promise((res, rej) => { finish = res; fail = rej; });
  ended.catch(() => {});
  const cleanups = [];
  return {
    ended, finish, fail,
    onDestroy: (fn) => cleanups.push(fn),
    destroy: () => { for (const fn of cleanups.splice(0)) { try { fn(); } catch {} } },
  };
}

function timer(slot, seconds) {
  const t = setTimeout(slot.finish, seconds * 1000);
  slot.onDestroy(() => clearTimeout(t));
}

// Fail the slot if playback position stops moving for STALL_LIMIT_MS.
function stallWatch(slot, getTime) {
  let last = -1, since = Date.now();
  const iv = setInterval(() => {
    const t = getTime();
    if (t !== last) { last = t; since = Date.now(); }
    else if (Date.now() - since > STALL_LIMIT_MS) slot.fail(new Error('Playback stalled'));
  }, 5000);
  slot.onDestroy(() => clearInterval(iv));
}

function caption(layer, text) {
  if (!text || settings.show_captions === '0') return;
  const c = document.createElement('div');
  c.className = 'caption';
  c.textContent = text;
  layer.append(c);
}

// --- YouTube ------------------------------------------------------------------
let ytApi;
function loadYouTubeApi() {
  ytApi ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytApi = null; reject(new Error('Could not load YouTube API (offline?)')); };
    document.head.append(s);
  });
  return ytApi;
}

const YT_ERRORS = {
  2: 'Invalid video ID',
  5: 'HTML5 player error',
  100: 'Video removed or private',
  101: 'Owner does not allow embedding',
  150: 'Owner does not allow embedding',
  153: 'Missing referrer — open the player over http(s), not file://',
};

// One video, a channel's current live stream (channelId), or a whole playlist
// (listId) played first to last before moving on.
async function mountYouTube(layer, { videoId, channelId, listId, start = 0, isLive }, maxSec, liveSec) {
  const YT = await loadYouTubeApi();
  const slot = makeSlot();

  // We build the iframe ourselves (rather than letting YT.Player do it) so the
  // referrer policy and autoplay permissions are set before the first request.
  const params = new URLSearchParams({
    enablejsapi: '1', autoplay: '1', mute: '1', controls: '0', playsinline: '1',
    rel: '0', iv_load_policy: '3', cc_load_policy: '0', disablekb: '1', fs: '0', modestbranding: '1',
    origin: location.origin,
  });
  if (start) params.set('start', String(start));
  if (channelId) videoId = (await api(`/api/resolve/channel-live/${channelId}`)).videoId;
  if (listId) { videoId = 'videoseries'; params.set('list', listId); }

  const iframe = document.createElement('iframe');
  iframe.src = `https://www.youtube.com/embed/${videoId}?${params}`;
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  layer.append(iframe);

  let player;
  const ready = new Promise((resolve, reject) => {
    player = new YT.Player(iframe, {
      events: {
        onReady: (e) => { e.target.mute(); e.target.playVideo(); },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING) resolve();
          if (e.data === YT.PlayerState.ENDED && !(listId && playNextInList())) slot.finish();
        },
        onError: (e) => {
          const err = new Error(YT_ERRORS[e.data] || `YouTube error ${e.data}`);
          // Removed, private, can't be embedded, bad ID: retrying won't help.
          err.permanent = [2, 100, 101, 150, 153].includes(e.data);
          if (listId && playNextInList()) {
            console.warn('[window] playlist: skipping a video:', err.message);
            return;
          }
          reject(err);
          slot.fail(err);
        },
      },
    });
  });
  slot.onDestroy(() => { player?.destroy?.(); iframe.remove(); });

  // Move to the next video in the playlist; false once the last one is done.
  function playNextInList() {
    const i = player.getPlaylistIndex?.() ?? -1;
    const n = player.getPlaylist?.()?.length ?? 0;
    if (i < 0 || i >= n - 1) return false;
    player.playVideoAt(i + 1);
    return true;
  }

  slot.ready = ready.then(() => {
    const live = !listId && (isLive || channelId || player.getDuration?.() === 0);
    const cap = live ? (maxSec || liveSec) : maxSec;
    if (cap) timer(slot, cap);
    stallWatch(slot, () => player.getCurrentTime?.());
  });
  return slot;
}

// --- Stills & video ------------------------------------------------------------
function mountImage(layer, url, seconds, captionText) {
  const slot = makeSlot();
  const img = new Image();
  img.className = 'still kenburns';
  img.style.setProperty('--kb-dur', `${seconds}s`);
  img.referrerPolicy = 'no-referrer';
  img.src = url;
  layer.append(img);
  caption(layer, captionText);
  slot.ready = img.decode().catch(() => { throw new Error('Image failed to load'); })
    .then(() => timer(slot, seconds));
  slot.onDestroy(() => { img.src = ''; });
  return slot;
}

let hlsLib;
function loadHls() {
  hlsLib ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/hls.light.min.js';
    s.onload = () => resolve(window.Hls);
    s.onerror = () => { hlsLib = null; reject(new Error('Could not load the HLS player')); };
    document.head.append(s);
  });
  return hlsLib;
}

// A video file, or an HLS (.m3u8) stream. A stream with no end (a live camera)
// plays for liveSec unless maxSec is set.
async function mountVideo(layer, url, maxSec, captionText, start = 0, { hls = false, liveSec = 0 } = {}) {
  const slot = makeSlot();
  const v = document.createElement('video');
  Object.assign(v, { muted: true, autoplay: true, playsInline: true, preload: 'auto' });
  v.setAttribute('muted', '');
  // Use the browser's own HLS support when it has it, otherwise hls.js.
  if (hls && !v.canPlayType('application/vnd.apple.mpegurl')) {
    const Hls = await loadHls();
    if (!Hls.isSupported()) throw Object.assign(new Error('This browser cannot play HLS streams'), { permanent: true });
    const h = new Hls({ startPosition: start || -1, liveDurationInfinity: true });
    h.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      const err = new Error(d.details === 'manifestLoadError'
        ? 'Stream unreachable, or its server doesn’t let other pages play it'
        : `Stream error: ${d.details}`);
      err.permanent = d.type === Hls.ErrorTypes.NETWORK_ERROR && [401, 403, 404].includes(d.response?.code);
      slot.fail(err);
    });
    h.loadSource(url);
    h.attachMedia(v);
    slot.onDestroy(() => h.destroy());
  } else {
    v.src = start ? `${url}#t=${start}` : url;
  }
  layer.append(v);
  caption(layer, captionText);
  slot.ready = new Promise((resolve, reject) => {
    v.addEventListener('playing', resolve, { once: true });
    v.addEventListener('error', () => {
      const err = new Error(v.error?.code === 4 ? 'Video format not supported' : 'Video failed to load');
      err.permanent = v.error?.code === 4;
      reject(err);
    }, { once: true });
    slot.ended.catch(reject);
    v.play().catch(() => {});
  }).then(() => {
    const cap = maxSec || (Number.isFinite(v.duration) ? 0 : liveSec);
    if (cap) timer(slot, cap);
    stallWatch(slot, () => v.currentTime);
  });
  v.addEventListener('ended', slot.finish);
  v.addEventListener('error', () => slot.fail(new Error('Video playback error')));
  slot.onDestroy(() => { v.pause(); v.removeAttribute('src'); v.load(); });
  return slot;
}

// --- Web pages & camera feeds ---------------------------------------------------
// A web page, framed without letting it navigate the kiosk away (no
// allow-top-navigation). Pasted HTML also gets no same-origin access, so its
// scripts can't reach this server's API.
function mountPage(layer, src, seconds, reloadSec, { trusted = true } = {}) {
  const slot = makeSlot();
  const iframe = document.createElement('iframe');
  iframe.sandbox = trusted
    ? 'allow-scripts allow-same-origin allow-forms allow-presentation'
    : 'allow-scripts allow-forms';
  iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
  iframe.src = src;
  layer.append(iframe);
  // A frame that's refused or offline still fires "load" (with an error page),
  // so this can only catch pages that never finish loading.
  slot.ready = new Promise((resolve) => iframe.addEventListener('load', resolve, { once: true }))
    .then(() => {
      timer(slot, seconds);
      if (reloadSec) {
        const iv = setInterval(() => { iframe.src = src; }, reloadSec * 1000);
        slot.onDestroy(() => clearInterval(iv));
      }
    });
  slot.onDestroy(() => { iframe.src = 'about:blank'; iframe.remove(); });
  return slot;
}

// A camera image: an MJPEG stream (plays by itself) or a snapshot, which is
// fetched again every reloadSec and swapped in once loaded, so it never flickers.
function mountFeedImage(layer, url, seconds, reloadSec) {
  const slot = makeSlot();
  const img = new Image();
  img.className = 'still';
  img.src = url;
  layer.append(img);
  // decode() doesn't settle for MJPEG streams, so wait for the first frame instead.
  slot.ready = new Promise((resolve, reject) => {
    const iv = setInterval(() => { if (img.naturalWidth) { clearInterval(iv); resolve(); } }, 250);
    img.addEventListener('error', () => { clearInterval(iv); reject(new Error('Image failed to load')); }, { once: true });
    slot.onDestroy(() => clearInterval(iv));
  }).then(() => {
    timer(slot, seconds);
    if (!reloadSec) return;
    const iv = setInterval(() => {
      const next = new Image();
      const u = new URL(url);
      u.searchParams.set('_dw', Date.now());
      next.onload = () => { img.src = next.src; };
      next.src = u.href;
    }, reloadSec * 1000);
    slot.onDestroy(() => clearInterval(iv));
  });
  slot.onDestroy(() => { img.src = ''; });
  return slot;
}

function mountSlideshow(layer, images, totalSec) {
  const slot = makeSlot();
  const box = document.createElement('div');
  box.className = 'slideshow';
  layer.append(box);
  const per = Math.max(2, totalSec / images.length);
  const imgs = images.map(({ url }) => {
    const img = new Image();
    img.className = 'still';
    img.loading = 'eager';
    img.src = url;
    box.append(img);
    return img;
  });
  const cap = document.createElement('div');
  cap.className = 'caption';
  if (settings.show_captions !== '0') layer.append(cap);

  let i = 0;
  const show = () => {
    imgs.forEach((img, k) => img.classList.toggle('on', k === i));
    cap.textContent = images[i].caption;
  };
  slot.ready = imgs[0].decode().catch(() => { throw new Error('EPIC image failed to load'); }).then(() => {
    show();
    const iv = setInterval(() => {
      i += 1;
      if (i >= imgs.length) return slot.finish();
      show();
    }, per * 1000);
    slot.onDestroy(() => clearInterval(iv));
  });
  slot.onDestroy(() => imgs.forEach((img) => { img.src = ''; }));
  return slot;
}

// --- Dispatch -----------------------------------------------------------------
async function mount(item, layer) {
  const p = item.payload ?? {};
  const still = num(item.duration_sec, num(settings.still_duration_sec, 30));
  const live = num(settings.live_duration_sec, 1800);
  const max = item.duration_sec || 0;

  switch (item.type) {
    case 'youtube':
    case 'youtube_playlist':
      return mountYouTube(layer, p, max, live);
    case 'nasa_image':
      return mountImage(layer, p.url, still, item.title);
    case 'nasa_video':
      return mountVideo(layer, p.url, max, item.title, p.start);
    case 'apod': {
      const a = await api('/api/resolve/apod');
      if (a.kind === 'youtube') return mountYouTube(layer, { videoId: a.videoId, start: a.start }, max, live);
      if (a.kind === 'video') return mountVideo(layer, a.url, max, a.caption);
      return mountImage(layer, a.url, still, `APOD ${a.date}: ${a.caption}`);
    }
    case 'web': {
      const secs = num(item.duration_sec, num(settings.web_duration_sec, 300));
      const reload = num(p.reloadSec, 0);
      if (p.kind === 'image') return mountFeedImage(layer, p.url, secs, reload);
      if (p.kind === 'video') return mountVideo(layer, p.url, max, null, 0, { hls: p.hls, liveSec: secs });
      if (p.html) return mountPage(layer, `/api/items/${item.id}/html`, secs, reload, { trusted: false });
      return mountPage(layer, p.url, secs, reload);
    }
    case 'epic': {
      const e = await api('/api/resolve/epic');
      return mountSlideshow(layer, e.images, num(item.duration_sec, num(settings.epic_duration_sec, 60)));
    }
    default:
      throw new Error(`Unknown item type ${item.type}`);
  }
}

// --- Playlist & loop ----------------------------------------------------------
async function refresh() {
  try {
    const [items, s] = await Promise.all([api('/api/items'), api('/api/settings')]);
    playlist = items.filter((i) => i.enabled);
    settings = s;
    return true;
  } catch {
    return false; // offline — keep whatever we had
  }
}

function pickNext() {
  if (!playlist.length) return null;
  const cur = current ? playlist.findIndex((i) => i.id === current.item.id) : -1;
  // If the current item was removed or disabled, continue from where it used to be.
  const base = cur >= 0 ? cur : lastIndex < 0 ? -1 : Math.min(lastIndex, playlist.length) - 1;
  const idx = (base + 1 + playlist.length) % playlist.length;
  lastIndex = idx;
  return playlist[idx];
}

function scheduleRetry(ms) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(advance, ms);
}

// Show a warning in the admin page only when it's worth acting on: problems
// that won't fix themselves, or an item that keeps failing.
function reportFailure(item, err) {
  // A hidden tab or covered window can't start video, so its failures say
  // nothing about the item; keep quiet and let the visible player report.
  if (!visible()) return;
  if (err.permanent) {
    post(`/api/items/${item.id}/error`, { error: err.message });
    return;
  }
  const n = (hiccups.get(item.id) ?? 0) + 1;
  hiccups.set(item.id, n);
  if (n >= FLAG_AFTER_HICCUPS) {
    post(`/api/items/${item.id}/error`, { error: `Failed ${n} times in a row (${err.message})` });
  }
}

function stopPlayback() {
  clearTimeout(retryTimer);
  current?.slot.destroy();
  current = null;
  layers.forEach((l) => { l.classList.remove('show'); l.replaceChildren(); });
}

function setScreen(on) {
  if (on === screenOn) return;
  screenOn = on;
  sleepCover.hidden = on;
  // Starting over picks up the item that was playing when the screen went off.
  if (on) advance();
  else stopPlayback();
}

async function advance() {
  if (busy || !screenOn) return;
  busy = true;
  clearTimeout(retryTimer);
  try {
    if (Date.now() - bootedAt > RELOAD_AFTER_MS) return location.reload();

    const item = pickNext();
    if (!item) {
      stopPlayback();
      if (idle.hidden) showIdleInfo();
      idle.hidden = false;
      return scheduleRetry(RETRY_MS);
    }

    const back = layers[1 - front];
    back.replaceChildren();
    let slot;
    try {
      slot = await mount(item, back);
      await withTimeout(slot.ready, READY_TIMEOUT_MS, 'Timed out waiting for playback to start');
      if (!screenOn) throw Object.assign(new Error('Screen turned off'), { quiet: true });
    } catch (err) {
      slot?.destroy();
      back.replaceChildren();
      if (err.quiet || !screenOn) return;
      console.warn('[window] skipping', item.id, item.title, err.message);
      reportFailure(item, err);
      failStreak += 1;
      // Pretend we played it so pickNext moves past it.
      current = { item, slot: current?.slot ?? makeSlot() };
      // Every item failing in a row usually means we're offline: back off.
      return scheduleRetry(failStreak >= playlist.length ? RETRY_MS : 0);
    }

    failStreak = 0;
    hiccups.delete(item.id);
    idle.hidden = true;
    const old = current?.slot;
    back.classList.add('show');
    layers[front].classList.remove('show');
    const oldLayer = layers[front];
    front = 1 - front;
    current = { item, slot };
    setTimeout(() => { old?.destroy(); if (!oldLayer.classList.contains('show')) oldLayer.replaceChildren(); }, 1400);

    if (visible()) post('/api/now-playing', { id: item.id });
    slot.ended.then(
      () => { if (current?.slot === slot) advance(); },
      (err) => {
        if (current?.slot !== slot) return;
        reportFailure(item, err);
        advance();
      },
    );
  } finally {
    busy = false;
  }
}

// Live updates from the admin page.
const events = new EventSource(`/api/events?player=${PLAYER_ID}&visible=${visible() ? 1 : 0}`);
// The reconnect URL carries the visibility from page load, so resend it.
events.addEventListener('open', () => post('/api/player-status', { visible: visible() }));
document.addEventListener('visibilitychange', () => {
  post('/api/player-status', { visible: visible() });
  if (visible() && current) post('/api/now-playing', { id: current.item.id });
});
// The server restarted (after an update, say): reload to pick up new player
// code. The first hello just records which server this page came from.
let serverBoot = null;
events.addEventListener('hello', (e) => {
  const { boot } = JSON.parse(e.data) ?? {};
  if (serverBoot && boot && boot !== serverBoot) location.reload();
  serverBoot ??= boot;
});
events.addEventListener('screen', (e) => setScreen(JSON.parse(e.data)?.on !== false));
events.addEventListener('playlist-changed', async () => {
  await refresh();
  // If the current item was disabled or deleted, move on now.
  if (current && !playlist.some((i) => i.id === current.item.id)) advance();
  else if (!current) advance();
});

// Handy when testing on a desktop: → skips, R reloads.
addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') advance();
  if (e.key === 'r') location.reload();
});

await refresh();
// Start dark if the screen is scheduled off, rather than flashing a video first.
await api('/api/screen').then((s) => { screenOn = s.on !== false; sleepCover.hidden = screenOn; }, () => {});
advance();
