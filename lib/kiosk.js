// Remote control of the kiosk's Chromium through its DevTools port, which the
// launcher opens on localhost only (kiosk/chromium-kiosk.sh). Used to click
// inside web pages (a script can't click into another site's page, and a
// synthetic click wouldn't count as a real one for fullscreen or play
// buttons), and to screenshot the TV so clicks can be placed by tapping.

const unavailable = (why) => Object.assign(
  new Error(`Can't reach the kiosk browser (${why}). Clicks and screenshots only work on the Pi's own screen; if this is the Pi, re-run the installer and reboot.`),
  { statusCode: 503 },
);

export function kioskControl(port = 9222) {
  async function playerTarget() {
    let targets;
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    } catch {
      throw unavailable('no DevTools port');
    }
    const t = targets.find((x) => x.type === 'page' && new URL(x.url).pathname === '/player');
    if (!t) throw unavailable('the player isn\'t open');
    return t;
  }

  // Open a DevTools session on the player tab, run fn(send), close it.
  async function session(fn) {
    const t = await playerTarget();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(unavailable('connection refused'));
    });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    try {
      return await Promise.race([
        fn(send),
        new Promise((_, reject) => setTimeout(() => reject(unavailable('timed out')), 10_000)),
      ]);
    } finally {
      ws.close();
    }
  }

  return {
    // A real (trusted) click or double-click at x%, y% of the screen.
    click: (xPct, yPct, double = false) => session(async (send) => {
      const { cssVisualViewport: vp } = await send('Page.getLayoutMetrics');
      const x = Math.round((xPct / 100) * vp.clientWidth);
      const y = Math.round((yPct / 100) * vp.clientHeight);
      const at = { x, y, button: 'left' };
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, clickCount: 1 });
      if (double) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, clickCount: 2 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, clickCount: 2 });
      }
      // Move away so hover-only controls (play bars, menus) fade out again.
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.clientWidth - 1, y: vp.clientHeight - 1 });
    }),

    screenshot: () => session(async (send) => {
      const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
      return Buffer.from(data, 'base64');
    }),
  };
}

// Validate a list of clicks from the admin page: [{ x, y, after, double }].
export function normalizeClicks(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 10) throw Object.assign(new Error('Up to 10 clicks per item.'), { statusCode: 400 });
  return list.map((c) => {
    const x = Number(c?.x), y = Number(c?.y), after = Number(c?.after ?? 5);
    if (!(x >= 0 && x <= 100 && y >= 0 && y <= 100)) throw Object.assign(new Error('Click positions are percentages from 0 to 100.'), { statusCode: 400 });
    if (!(after >= 0 && after <= 3600)) throw Object.assign(new Error('"After" should be 0 to 3600 seconds.'), { statusCode: 400 });
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, after: Math.round(after * 10) / 10, double: !!c.double };
  });
}
