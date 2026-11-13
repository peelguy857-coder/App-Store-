'use strict';
// Storage for the store. All metadata lives in memory and is written out
// shortly after each change. Two places it can be written to:
//
//   * Files (default): DATA_DIR/db.json plus DATA_DIR/apps/<id>/<version>.html.
//   * PostgreSQL: set DATABASE_URL. Everything is kept in one key/value
//     table, so any hosted Postgres works (Render, Neon, Supabase, ...).
//
// Hosting services often wipe local files when they restart, so use
// DATABASE_URL (or a persistent disk) for a store people rely on.

const fs = require('fs');
const path = require('path');

const EMPTY = () => ({ users: {}, sessions: {}, apps: {}, installs: {}, reviews: {} });
const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');

class FileBackend {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.appsDir = path.join(dir, 'apps');
    fs.mkdirSync(this.appsDir, { recursive: true });
  }
  async load() { return fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : null; }
  async saveData(json) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, this.file);
  }
  codePath(appId, version) { return path.join(this.appsDir, safe(appId), safe(version) + '.html'); }
  async writeCode(appId, version, html) {
    const p = this.codePath(appId, version);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, html);
  }
  async readCode(appId, version) {
    try { return fs.readFileSync(this.codePath(appId, version), 'utf8'); } catch { return null; }
  }
  async deleteCode(appId) { fs.rmSync(path.join(this.appsDir, safe(appId)), { recursive: true, force: true }); }
  async close() {}
}

class PgBackend {
  constructor(url) {
    const { Pool } = require('pg');
    const local = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) || /host=\/|sslmode=disable/.test(url);
    this.pool = new Pool({ connectionString: url, max: 5, ssl: local ? false : { rejectUnauthorized: false } });
  }
  async init() {
    await this.pool.query('CREATE TABLE IF NOT EXISTS appstore_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  }
  async put(key, value) {
    await this.pool.query(
      'INSERT INTO appstore_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      [key, value]);
  }
  async get(key) {
    const r = await this.pool.query('SELECT value FROM appstore_kv WHERE key = $1', [key]);
    return r.rows.length ? r.rows[0].value : null;
  }
  async load() { await this.init(); return this.get('db'); }
  async saveData(json) { await this.put('db', json); }
  async writeCode(appId, version, html) { await this.put(`code:${appId}:${version}`, html); }
  async readCode(appId, version) { return this.get(`code:${appId}:${version}`); }
  async deleteCode(appId) { await this.pool.query('DELETE FROM appstore_kv WHERE key LIKE $1', [`code:${appId.replace(/[%_\\]/g, '\\$&')}:%`]); }
  async close() { await this.pool.end(); }
}

class DB {
  static async open({ dataDir, databaseUrl } = {}) {
    const backend = databaseUrl ? new PgBackend(databaseUrl) : new FileBackend(dataDir);
    const db = new DB(backend);
    const raw = await backend.load();
    if (raw) db.data = Object.assign(EMPTY(), JSON.parse(raw));
    db.kind = databaseUrl ? 'postgres' : 'files';
    return db;
  }

  constructor(backend) {
    this.backend = backend;
    this.data = EMPTY();
    this._timer = null;
    this._writing = Promise.resolve();
  }

  /** Schedule a write of the metadata (batched). */
  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 50);
  }

  /** Write the metadata now. Writes are queued so they never overlap. */
  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    const json = JSON.stringify(this.data);
    this._writing = this._writing
      .then(() => this.backend.saveData(json))
      .catch((err) => console.error('Saving the store failed:', err.message));
    return this._writing;
  }

  writeCode(appId, version, html) { return this.backend.writeCode(appId, version, html); }
  readCode(appId, version) { return this.backend.readCode(appId, version); }
  deleteCode(appId) { return this.backend.deleteCode(appId); }
  async close() { await this.flush(); await this.backend.close(); }
}

module.exports = { DB };
