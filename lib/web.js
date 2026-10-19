// Web pages, camera feeds and pasted HTML. A link is probed once when it's
// added to decide how the player shows it:
//   page   any web page, in a sandboxed iframe
//   image  a still or camera snapshot (optionally reloaded every N seconds),
//          or an MJPEG camera stream, which <img> plays natively
//   video  an MP4/WebM file or an HLS (.m3u8) stream

export const WEB_KINDS = ['page', 'image', 'video'];
export const MAX_HTML_BYTES = 256 * 1024;

// A link, or a pasted HTML document. Bare hostnames get https://, or http://
// for IP addresses and .local names.
export function parseWebInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('<')) return { html: raw };
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(raw) && !/^[^:/]+:\d/.test(raw);
  let url;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  // Without a scheme, insist on something that looks like a host ("example.com",
  // an IP address, localhost) so a typo isn't taken for a LAN hostname.
  // A single-word LAN hostname works with http:// in front (http://camera/…).
  if (!hasScheme && !/[.:]/.test(url.hostname) && url.hostname !== 'localhost') return null;
  // Cameras on the local network rarely speak HTTPS.
  if (!hasScheme && /^(localhost|[\d.]+|\[[\da-f:]+\]|.+\.local)$/i.test(url.hostname)) url.protocol = 'http:';
  return { url: url.href };
}

const isHls = (type, url) => /mpegurl/i.test(type) || /\.m3u8(\?|#|$)/i.test(url);

// Pick a kind from the response's Content-Type, falling back to the file
// extension when there's no usable type (or the probe failed).
export function classify(contentType, url) {
  const type = String(contentType ?? '').toLowerCase();
  if (isHls(type, url)) return 'video';
  if (type.startsWith('multipart/x-mixed-replace') || type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type && !type.startsWith('application/octet-stream')) return 'page';
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ''; } })();
  if (/\.(jpe?g|png|gif|webp|avif|bmp|mjpe?g|cgi)$/.test(path) || /mjpe?g|snapshot|still/.test(path)) return 'image';
  if (/\.(mp4|webm|ogv|mov|m4v)$/.test(path)) return 'video';
  return 'page';
}

// Whether the site asks browsers not to show it inside another page. The kiosk
// ignores this (see kiosk/frame-extension), but an ordinary browser won't.
export function frameBlocked(headers) {
  const xfo = String(headers.get('x-frame-options') ?? '').toLowerCase();
  if (xfo.includes('deny') || xfo.includes('sameorigin')) return true;
  const fa = /frame-ancestors([^;]*)/i.exec(headers.get('content-security-policy') ?? '');
  return !!fa && !/(^|\s)(\*|https?:)(\s|$)/.test(fa[1]);
}

export function extractTitle(html) {
  const m = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(html);
  if (!m) return null;
  return m[1]
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ').trim() || null;
}

// Read at most `limit` bytes of a body (a camera stream never ends).
async function readSome(res, limit) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Probe a link: { kind, title, hls, embedBlocked, reachable }. Never throws; a
// site that turns away the server (bot checks, logins) may still work in the
// player, so an unreachable link is guessed from its address instead.
export async function probe(url) {
  const fallback = { kind: classify('', url), title: null, hls: isHls('', url), embedBlocked: false, reachable: false };
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux aarch64) DigitalWindow', Accept: '*/*', 'Accept-Language': 'en' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return fallback;
  }
  if (!res.ok) { res.body?.cancel().catch(() => {}); return fallback; }
  const type = res.headers.get('content-type') ?? '';
  const kind = classify(type, res.url || url);
  let title = null;
  if (kind === 'page' && /html/i.test(type)) {
    title = extractTitle(await readSome(res, 64 * 1024).catch(() => ''));
  } else {
    res.body?.cancel().catch(() => {});
  }
  return {
    kind,
    title,
    hls: isHls(type, res.url || url),
    embedBlocked: kind === 'page' && frameBlocked(res.headers),
    reachable: true,
  };
}
