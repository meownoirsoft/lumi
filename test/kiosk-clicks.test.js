import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClicks } from '../lib/kiosk.js';

test('normalizeClicks: defaults, rounding, limits', () => {
  assert.deepEqual(normalizeClicks(null), []);
  assert.deepEqual(normalizeClicks([{ x: '12.345', y: 50 }]), [{ x: 12.3, y: 50, after: 5, double: false }]);
  assert.deepEqual(normalizeClicks([{ x: 0, y: 100, after: 0, double: 1 }]), [{ x: 0, y: 100, after: 0, double: true }]);
  assert.throws(() => normalizeClicks([{ x: 101, y: 5 }]), /percentages/);
  assert.throws(() => normalizeClicks([{ x: 'a', y: 5 }]), /percentages/);
  assert.throws(() => normalizeClicks([{ x: 5, y: 5, after: -1 }]), /After/);
  assert.throws(() => normalizeClicks(Array(11).fill({ x: 1, y: 1 })), /Up to 10/);
  assert.throws(() => normalizeClicks('nope'), /Up to 10/);
});
