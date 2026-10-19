import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWebInput, classify, frameBlocked, extractTitle } from '../lib/web.js';

test('parseWebInput: links', () => {
  assert.deepEqual(parseWebInput('https://example.com/cam'), { url: 'https://example.com/cam' });
  assert.deepEqual(parseWebInput('  example.com '), { url: 'https://example.com/' });
  assert.deepEqual(parseWebInput('192.168.1.20:8080/video.mjpg'), { url: 'http://192.168.1.20:8080/video.mjpg' });
  assert.deepEqual(parseWebInput('http://camera/snap.jpg'), { url: 'http://camera/snap.jpg' });
  assert.deepEqual(parseWebInput('localhost:8000'), { url: 'http://localhost:8000/' });
  assert.deepEqual(parseWebInput('porch-cam.local/snap.jpg'), { url: 'http://porch-cam.local/snap.jpg' });
  assert.equal(parseWebInput(''), null);
  assert.equal(parseWebInput('not a link'), null);
  assert.equal(parseWebInput('camera'), null);
  assert.equal(parseWebInput('javascript:alert(1)'), null);
  assert.equal(parseWebInput('file:///etc/passwd'), null);
});

test('parseWebInput: pasted HTML', () => {
  assert.deepEqual(parseWebInput('<h1>Hi</h1>'), { html: '<h1>Hi</h1>' });
});

test('classify by content type, then by address', () => {
  assert.equal(classify('text/html; charset=utf-8', 'https://a.com/'), 'page');
  assert.equal(classify('image/jpeg', 'https://a.com/x'), 'image');
  assert.equal(classify('multipart/x-mixed-replace; boundary=frame', 'https://a.com/x'), 'image');
  assert.equal(classify('video/mp4', 'https://a.com/x'), 'video');
  assert.equal(classify('application/vnd.apple.mpegurl', 'https://a.com/x'), 'video');
  assert.equal(classify('', 'https://a.com/live/index.m3u8?token=1'), 'video');
  assert.equal(classify('', 'https://a.com/cam/snapshot.jpg'), 'image');
  assert.equal(classify('application/octet-stream', 'https://a.com/clip.mp4'), 'video');
  assert.equal(classify('', 'https://a.com/'), 'page');
});

test('frameBlocked', () => {
  const h = (o) => new Headers(o);
  assert.equal(frameBlocked(h({})), false);
  assert.equal(frameBlocked(h({ 'X-Frame-Options': 'DENY' })), true);
  assert.equal(frameBlocked(h({ 'X-Frame-Options': 'SAMEORIGIN' })), true);
  assert.equal(frameBlocked(h({ 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'self'" })), true);
  assert.equal(frameBlocked(h({ 'Content-Security-Policy': 'frame-ancestors *' })), false);
  assert.equal(frameBlocked(h({ 'Content-Security-Policy': "default-src 'self'" })), false);
});

test('extractTitle', () => {
  assert.equal(extractTitle('<html><head><title>\n Harbour  Cam &amp; Weather </title>'), 'Harbour Cam & Weather');
  assert.equal(extractTitle('<p>no title</p>'), null);
});
