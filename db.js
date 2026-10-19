import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const ITEM_TYPES = ['youtube', 'youtube_playlist', 'nasa_image', 'nasa_video', 'apod', 'epic', 'web'];

const DEFAULT_SETTINGS = {
  still_duration_sec: '30',
  live_duration_sec: '1800',
  epic_duration_sec: '60',
  web_duration_sec: '300',
  show_captions: '1',
};

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');

  // node:sqlite has no transaction helper; wrap fn in BEGIN/COMMIT.
  const transaction = (fn) => (...args) => {
    db.exec('BEGIN');
    try {
      const out = fn(...args);
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      position     INTEGER NOT NULL,
      type         TEXT NOT NULL,
      title        TEXT NOT NULL DEFAULT '',
      source       TEXT NOT NULL DEFAULT '',
      payload      TEXT NOT NULL DEFAULT '{}',
      duration_sec INTEGER,
      enabled      INTEGER NOT NULL DEFAULT 1,
      error        TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const seed = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) seed.run(k, v);

  const row = (r) => r && { ...r, payload: JSON.parse(r.payload), enabled: !!r.enabled };

  const q = {
    list: db.prepare('SELECT * FROM items ORDER BY position, id'),
    get: db.prepare('SELECT * FROM items WHERE id = ?'),
    maxPos: db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM items'),
    insert: db.prepare(`INSERT INTO items (position, type, title, source, payload, duration_sec, enabled)
                        VALUES (@position, @type, @title, @source, @payload, @duration_sec, @enabled)`),
    del: db.prepare('DELETE FROM items WHERE id = ?'),
    setPos: db.prepare('UPDATE items SET position = ? WHERE id = ?'),
    settings: db.prepare('SELECT key, value FROM settings'),
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    delSetting: db.prepare('DELETE FROM settings WHERE key = ?'),
    setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };

  return {
    listItems: () => q.list.all().map(row),
    getItem: (id) => row(q.get.get(id)),

    addItem({ type, title = '', source = '', payload = {}, duration_sec = null, enabled = true }) {
      const position = q.maxPos.get().m + 1;
      const { lastInsertRowid } = q.insert.run({
        position, type, title, source, payload: JSON.stringify(payload),
        duration_sec, enabled: enabled ? 1 : 0,
      });
      return row(q.get.get(lastInsertRowid));
    },

    updateItem(id, patch) {
      const allowed = ['title', 'duration_sec', 'enabled', 'error', 'payload'];
      const sets = [];
      const vals = {};
      for (const k of allowed) {
        if (!(k in patch)) continue;
        let v = patch[k];
        if (k === 'enabled') v = v ? 1 : 0;
        if (k === 'payload') v = JSON.stringify(v);
        sets.push(`${k} = @${k}`);
        vals[k] = v;
      }
      if (sets.length) db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = @id`).run({ ...vals, id });
      return row(q.get.get(id));
    },

    deleteItem: (id) => q.del.run(id).changes > 0,

    reorder: transaction((ids) => {
      ids.forEach((id, i) => q.setPos.run(i, id));
    }),

    getSettings: () => Object.fromEntries(q.settings.all().filter((r) => r.key in DEFAULT_SETTINGS).map((r) => [r.key, r.value])),
    setSettings: transaction((obj) => {
      for (const [k, v] of Object.entries(obj)) {
        if (k in DEFAULT_SETTINGS) q.setSetting.run(k, String(v));
      }
    }),

    // Structured values (the screen schedule and its override), stored as JSON
    // alongside the settings but not editable through setSettings.
    getJson(key, fallback = null) {
      const r = q.getSetting.get(key);
      return r ? JSON.parse(r.value) : fallback;
    },
    setJson(key, value) {
      if (value == null) q.delSetting.run(key);
      else q.setSetting.run(key, JSON.stringify(value));
    },
  };
}
