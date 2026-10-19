const $ = (s, el = document) => el.querySelector(s);
const list = $('#list');
const msg = $('#msg');
const tpl = $('#item-tpl');

let items = [];
let nowPlayingId = null;
let dragging = false;
let confirmDeleteId = null;   // item whose ✕ has been tapped once

const TYPE_LABEL = {
  youtube: 'YouTube', youtube_playlist: 'YouTube playlist', nasa_image: 'NASA image', nasa_video: 'NASA video', apod: 'APOD', epic: 'EPIC', web: 'Web',
};
const WEB_LABEL = { page: 'Web page', image: 'Camera image', video: 'Web video' };
const typeLabel = (item) => (item.type === 'web' ? (item.payload?.html ? 'HTML' : WEB_LABEL[item.payload?.kind]) : TYPE_LABEL[item.type]) ?? item.type;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function say(text, kind = 'ok') {
  msg.textContent = text;
  msg.className = kind;
  clearTimeout(say.t);
  say.t = setTimeout(() => { msg.textContent = ''; }, 6000);
}

async function busy(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { say(e.message, 'err'); } finally { btn.disabled = false; }
}

// --- Tabs ---------------------------------------------------------------------
document.querySelectorAll('[role=tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[role=tab]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
  });
});

// --- Playlist rendering -------------------------------------------------------
// 90 -> "1:30", 3723 -> "1:02:03"
function clock(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function thumbFor(item) {
  return item.payload?.thumb ?? null;
}

// Don't rebuild the list under someone typing in it; render once they leave the field.
let renderPending = false;
const typing = () => list.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName);
list.addEventListener('focusout', () => setTimeout(() => { if (renderPending && !typing()) render(); }));

function render() {
  if (dragging) return;
  if (typing()) { renderPending = true; return; }
  renderPending = false;
  list.replaceChildren(...items.map((item) => {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.dataset.id = item.id;
    li.classList.toggle('disabled', !item.enabled);
    li.classList.toggle('playing', item.id === nowPlayingId);

    const thumb = $('.thumb', li);
    const t = thumbFor(item);
    if (t) thumb.style.backgroundImage = `url("${t}")`;
    else thumb.textContent = typeLabel(item);

    $('.title', li).textContent = item.title || '(untitled)';
    $('.title', li).title = item.title;
    $('.type', li).textContent = typeLabel(item);
    $('.live', li).hidden = !item.payload?.isLive;
    $('.now', li).hidden = item.id !== nowPlayingId;
    $('.source', li).textContent = item.source;
    if (item.error) {
      $('.error', li).hidden = false;
      $('.error', li).textContent = `⚠ Skipped: ${item.error}`;
    }

    const p = item.payload ?? {};
    const note = item.type === 'web' && !p.html && (
      !p.reachable ? "Couldn't open this link from the Pi to check it, so how it's shown was guessed from the address."
        : p.embedBlocked ? 'This site blocks being shown inside other pages. The kiosk shows it anyway, but “Open player” in a normal browser may show it blank.'
          : '');
    if (note) { $('.note', li).hidden = false; $('.note', li).textContent = note; }

    const reload = $('.reload', li);
    reload.hidden = !(item.type === 'web' && p.kind !== 'video');
    if (!reload.hidden) {
      const input = $('input', reload);
      input.value = p.reloadSec ?? '';
      input.addEventListener('change', () => patch(item.id, { reloadSec: input.value || null }));
    }

    const start = $('.start', li);
    const seekable = item.type === 'nasa_video' || (item.type === 'youtube' && !item.payload?.isLive && !item.payload?.channelId);
    start.hidden = !seekable;
    if (seekable) {
      const input = $('input', start);
      input.value = item.payload?.start ? clock(item.payload.start) : '';
      input.addEventListener('change', () => patch(item.id, { start: input.value }));
    }

    const dur = $('.dur input', li);
    dur.value = item.duration_sec ?? '';
    dur.addEventListener('change', () => patch(item.id, { duration_sec: dur.value || null }));

    if (item.type === 'web' && p.kind === 'page') renderClicks(item, li);

    const en = $('.enabled', li);
    en.checked = item.enabled;
    en.addEventListener('change', () => patch(item.id, { enabled: en.checked }));

    // First tap arms the button ("Delete?"), a second tap deletes.
    const del = $('.del', li);
    if (item.id === confirmDeleteId) {
      del.classList.add('confirm');
      del.textContent = 'Delete?';
      del.title = 'Tap again to delete';
      del.setAttribute('aria-label', `Confirm: delete ${item.title || 'this item'}`);
    }
    del.addEventListener('click', async () => {
      if (confirmDeleteId !== item.id) return armDelete(item.id);
      armDelete(null);
      try { await api(`/api/items/${item.id}`, { method: 'DELETE' }); } catch (e) { say(e.message, 'err'); }
      load();
    });
    return li;
  }));
  $('#count').textContent = items.length ? `(${items.filter((i) => i.enabled).length} of ${items.length} enabled)` : '';
  $('#empty').hidden = items.length > 0;
}

// Kept outside the list so re-renders (now-playing updates) don't disarm it.
function armDelete(id) {
  clearTimeout(armDelete.t);
  confirmDeleteId = id;
  if (id != null) armDelete.t = setTimeout(() => armDelete(null), 4000);
  render();
}
// Tapping anywhere else cancels.
document.addEventListener('click', (e) => {
  if (confirmDeleteId != null && !e.target.closest('.del')) armDelete(null);
});

// --- Clicks in web pages --------------------------------------------------------
const openClicks = new Set();   // items whose click editor is open (survives re-renders)
const clickTpl = $('#click-tpl');

function saveClicks(item, clicks) {
  return patch(item.id, { clicks });
}

function renderClicks(item, li) {
  const clicks = item.payload.clicks ?? [];
  const toggle = $('.clicks-toggle', li);
  const panel = $('.clicks-panel', li);
  const open = openClicks.has(item.id);
  toggle.hidden = false;
  toggle.textContent = clicks.length ? `🖱 ${clicks.length} click${clicks.length === 1 ? '' : 's'} ${open ? '▴' : '▾'}` : `🖱 Add clicks ${open ? '▴' : '▾'}`;
  toggle.setAttribute('aria-expanded', String(open));
  panel.hidden = !open;
  toggle.addEventListener('click', () => {
    if (openClicks.has(item.id)) openClicks.delete(item.id); else openClicks.add(item.id);
    render();
  });
  if (!open) return;

  $('.clicks-list', panel).replaceChildren(...clicks.map((c, i) => {
    const row = clickTpl.content.firstElementChild.cloneNode(true);
    $('.c-type', row).value = c.double ? 'double' : '';
    $('.c-x', row).value = c.x;
    $('.c-y', row).value = c.y;
    $('.c-after', row).value = c.after;
    row.addEventListener('change', () => {
      if (![...row.querySelectorAll('input')].every((el) => el.reportValidity())) return;
      const next = clicks.map((x) => ({ ...x }));
      next[i] = { x: Number($('.c-x', row).value), y: Number($('.c-y', row).value), after: Number($('.c-after', row).value), double: $('.c-type', row).value === 'double' };
      saveClicks(item, next);
    });
    $('.c-del', row).addEventListener('click', () => saveClicks(item, clicks.filter((_, k) => k !== i)));
    return row;
  }));
  $('.add-click', panel).addEventListener('click', () => saveClicks(item, [...clicks, { x: 50, y: 50, after: 5, double: false }]));
  $('.pick', panel).addEventListener('click', () => openPicker(item));
  $('.test', panel).addEventListener('click', (e) => busy(e.currentTarget, async () => {
    if (!clicks.length) throw new Error('Add a click first.');
    await api(`/api/items/${item.id}/run-clicks`, { method: 'POST' });
    say('Clicking on the TV now.');
  }));
}

// Screenshot picker: show the item on the TV, grab the screen, tap a spot.
const picker = $('#picker');
const pickerImg = $('#picker-img');
const pickerMsg = $('#picker-msg');
let pickerItem = null;

async function takeShot() {
  pickerMsg.textContent = 'Taking a screenshot…';
  const res = await fetch(`/api/kiosk/screenshot?t=${Date.now()}`);
  if (!res.ok) {
    pickerMsg.textContent = (await res.json().catch(() => ({}))).error ?? `Screenshot failed (${res.status})`;
    return;
  }
  URL.revokeObjectURL(pickerImg.src);
  pickerImg.src = URL.createObjectURL(await res.blob());
  $('#picker-dot').hidden = true;
  pickerMsg.textContent = nowPlayingId === pickerItem?.id ? '' : 'The TV is showing a different item. Wait for it, then take a new screenshot.';
}

async function openPicker(item) {
  pickerItem = item;
  pickerImg.removeAttribute('src');
  $('#picker-double').checked = false;
  picker.showModal();
  if (nowPlayingId !== item.id) {
    pickerMsg.textContent = 'Showing it on the TV…';
    try { await api(`/api/items/${item.id}/show`, { method: 'POST' }); } catch (e) { pickerMsg.textContent = e.message; return; }
    // Give the page time to load and fade in.
    await new Promise((r) => setTimeout(r, 6000));
  }
  if (picker.open) await takeShot();
}

pickerImg.addEventListener('click', (e) => {
  if (!pickerItem || !pickerImg.naturalWidth) return;
  const r = pickerImg.getBoundingClientRect();
  const x = Math.round(((e.clientX - r.left) / r.width) * 1000) / 10;
  const y = Math.round(((e.clientY - r.top) / r.height) * 1000) / 10;
  const dot = $('#picker-dot');
  dot.style.left = `${x}%`;
  dot.style.top = `${y}%`;
  dot.hidden = false;
  const latest = items.find((i) => i.id === pickerItem.id) ?? pickerItem;
  const clicks = [...(latest.payload.clicks ?? []), { x, y, after: 5, double: $('#picker-double').checked }];
  openClicks.add(pickerItem.id);
  saveClicks(pickerItem, clicks).then(() => setTimeout(() => picker.close(), 400));
});
$('#picker-refresh').addEventListener('click', (e) => busy(e.currentTarget, takeShot));
$('#picker-cancel').addEventListener('click', () => picker.close());

async function load() {
  try {
    items = await api('/api/items');
    render();
  } catch (e) {
    say(`Couldn't load playlist: ${e.message}`, 'err');
  }
}

async function patch(id, body) {
  try { await api(`/api/items/${id}`, { method: 'PATCH', body }); } catch (e) { say(e.message, 'err'); }
  load();
}

Sortable.create(list, {
  handle: '.handle',
  animation: 150,
  onStart: () => { dragging = true; },
  // Fires on every release, even when a touch drag is cancelled, so the list
  // can never stay frozen waiting for a drag that ended.
  onUnchoose: () => { dragging = false; },
  onEnd: async () => {
    dragging = false;
    const ids = [...list.children].map((li) => Number(li.dataset.id));
    items.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    try { await api('/api/items/order', { method: 'PUT', body: { ids } }); } catch (e) { say(e.message, 'err'); }
    load();
  },
});

// --- Adding -------------------------------------------------------------------
async function add(body, label) {
  const item = await api('/api/items', { method: 'POST', body });
  say(`Added “${item.title || label}”.`);
  load();
  return item;
}

$('#yt-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = e.submitter;
  busy(btn, async () => {
    await add({ kind: 'youtube', input: $('#yt-input').value, isLive: $('#yt-live').checked });
    $('#yt-input').value = '';
    $('#yt-live').checked = false;
  });
});

$('#web-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    await add({ kind: 'web', input: $('#web-input').value, as: $('#web-as').value || undefined, reloadSec: $('#web-reload').value || null });
    $('#web-input').value = '';
    $('#web-reload').value = '';
    $('#web-as').value = '';
  });
});

$('#html-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    await add({ kind: 'web', input: $('#html-input').value }, 'HTML page');
    $('#html-input').value = '';
  });
});

document.querySelectorAll('[data-add-kind]').forEach((btn) => {
  btn.addEventListener('click', () => busy(btn, () => add({ kind: btn.dataset.addKind })));
});

async function loadPresets() {
  const presets = await api('/api/presets').catch(() => []);
  $('#presets').replaceChildren(...presets.map((p) => {
    const row = document.createElement('div');
    row.className = 'feed';
    row.innerHTML = '<div><strong></strong> <span class="badge live">LIVE</span><p class="hint"></p></div><button class="btn">Add</button>';
    $('strong', row).textContent = p.title;
    $('.hint', row).textContent = p.note ?? '';
    const btn = $('button', row);
    btn.addEventListener('click', () => busy(btn, () => add({ kind: 'youtube_channel_live', channelId: p.channelId, title: p.title })));
    return row;
  }));
}

$('#lib-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = e.submitter;
  const out = $('#lib-results');
  busy(btn, async () => {
    out.replaceChildren();
    const results = await api(`/api/nasa/search?q=${encodeURIComponent($('#lib-q').value)}&type=${$('#lib-type').value}`);
    if (!results.length) return say('No results.', 'err');
    out.replaceChildren(...results.map((r) => {
      const card = document.createElement('div');
      card.className = 'result';
      card.innerHTML = '<img alt="" loading="lazy"><div class="r-title"></div><div class="r-date"></div><button class="btn">Add</button>';
      $('img', card).src = r.thumb ?? '';
      $('.r-title', card).textContent = r.title;
      card.title = r.description;
      $('.r-date', card).textContent = `${r.mediaType} · ${r.date ?? ''}`;
      const add_ = $('button', card);
      add_.addEventListener('click', () => busy(add_, async () => {
        await add({ kind: 'nasa', nasaId: r.nasaId, title: r.title, thumb: r.thumb });
        add_.textContent = 'Added ✓';
      }));
      return card;
    }));
  });
});

// --- Settings -----------------------------------------------------------------
const sf = $('#settings-form');
async function loadSettings() {
  const s = await api('/api/settings').catch(() => ({}));
  for (const [k, v] of Object.entries(s)) {
    const el = sf.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = v === '1';
    else el.value = v;
  }
}
sf.addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    const body = {};
    for (const el of sf.elements) {
      if (!el.name) continue;
      body[el.name] = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
    }
    await api('/api/settings', { method: 'PUT', body });
    say('Settings saved.');
  });
});

// --- Screen schedule ------------------------------------------------------------
const DAYS = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [0, 'Sunday']];
const schedForm = $('#schedule-form');
const schedDays = $('#sched-days');
let screenOn = true;

function renderScreen(st) {
  screenOn = st.on;
  const el = $('#screen-state');
  el.className = `screen-state ${st.on ? 'on' : 'off'}`;
  const parts = [st.on ? 'Screen is on' : 'Screen is off'];
  if (st.reason === 'manual') parts[0] += st.on ? ' (switched on by hand)' : ' (switched off by hand)';
  if (st.next) parts.push(`${st.next.on ? 'turns on' : 'turns off'} ${/^\d/.test(st.next.label) ? 'at ' : ''}${st.next.label}`);
  else if (st.reason === 'schedule' && !st.on) parts.push('no on times are scheduled');
  el.textContent = parts.join(' · ');
  $('#screen-toggle').textContent = st.on ? 'Turn off now' : 'Turn on now';
  $('#clock').textContent = st.clock ? `Time on the Pi: ${st.clock}` : '';
}

async function loadScreen() {
  try { renderScreen(await api('/api/screen')); } catch { /* shown again on the next event */ }
}

$('#screen-toggle').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  renderScreen(await api('/api/screen', { method: 'POST', body: { on: !screenOn } }));
}));

function syncScheduleEnabled() {
  const on = $('#sched-enabled').checked;
  schedDays.classList.toggle('off', !on);
  for (const row of schedDays.querySelectorAll('[data-day]')) {
    const dayOn = on && $('.day-on', row).checked;
    $('.day-on', row).disabled = !on;
    for (const t of row.querySelectorAll('input[type=time]')) t.disabled = !dayOn;
  }
}

async function loadSchedule() {
  const sched = await api('/api/schedule').catch(() => null);
  if (!sched) return;
  $('#sched-enabled').checked = sched.enabled;
  schedDays.replaceChildren(...DAYS.flatMap(([d, name]) => {
    const day = sched.days[d];
    const row = document.createElement('div');
    row.style.display = 'contents';
    row.dataset.day = d;
    row.innerHTML = '<label class="check day"><input type="checkbox" class="day-on"> <span></span></label>'
      + '<label>On <input type="time" class="t-on" required></label>'
      + '<label>Off <input type="time" class="t-off" required></label>';
    $('span', row).textContent = name;
    $('.day-on', row).checked = day.enabled;
    $('.t-on', row).value = day.on;
    $('.t-off', row).value = day.off;
    $('.day-on', row).addEventListener('change', syncScheduleEnabled);
    return row;
  }));
  syncScheduleEnabled();
}
$('#sched-enabled').addEventListener('change', syncScheduleEnabled);

// Messages show next to the Save button: the main one is out of sight up the page.
schedForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter, out = $('#sched-msg');
  btn.disabled = true;
  try {
    const days = [];
    for (const row of schedDays.querySelectorAll('[data-day]')) {
      days[Number(row.dataset.day)] = { enabled: $('.day-on', row).checked, on: $('.t-on', row).value, off: $('.t-off', row).value };
    }
    await api('/api/schedule', { method: 'PUT', body: { enabled: $('#sched-enabled').checked, days } });
    out.textContent = 'Schedule saved.';
    out.className = 'ok';
  } catch (err) {
    out.textContent = err.message;
    out.className = 'err';
  } finally {
    btn.disabled = false;
  }
});

// --- Live updates -------------------------------------------------------------
// Changes made elsewhere (another phone, the player reporting errors) arrive as
// server events. Phones drop this connection when the screen sleeps, so also
// reload whenever it reconnects or the page comes back into view.
const events = new EventSource('/api/events');
events.addEventListener('playlist-changed', load);
events.addEventListener('open', load);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
events.addEventListener('players', (e) => {
  const list = JSON.parse(e.data) ?? [];
  const onScreen = list.filter((p) => p.visible).length;
  const el = $('#players');
  el.classList.toggle('warn', list.length !== 1 || onScreen !== 1);
  if (!list.length) {
    el.textContent = '● No player connected';
    el.title = 'Nothing is showing the playlist. Is the display on and the kiosk running?';
  } else if (list.length === 1) {
    el.textContent = onScreen ? '● Player on screen' : '● Player connected but not visible';
    el.title = list[0].ip;
  } else {
    el.textContent = `● ${list.length} players open (${onScreen} on screen)`;
    el.title = `Close /player in other tabs or devices: ${list.map((p) => `${p.ip}${p.visible ? '' : ' (hidden)'}`).join(', ')}`;
  }
});
events.addEventListener('screen', (e) => renderScreen(JSON.parse(e.data)));
// Keeps the Pi's clock and "turns off at…" current while the page is open.
setInterval(() => { if (!document.hidden) loadScreen(); }, 60_000);
events.addEventListener('now-playing', (e) => {
  nowPlayingId = JSON.parse(e.data)?.id ?? null;
  render();
});

load();
loadPresets();
loadSettings();
loadSchedule();
