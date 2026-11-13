'use strict';
// Tiny JSON-file database. All data lives in memory and is flushed to disk
// atomically (write temp file, then rename) shortly after every change.
// App code (the HTML files developers publish) is stored as separate files.

const fs = require('fs');
const path = require('path');

const EMPTY = () => ({ users: {}, sessions: {}, apps: {}, installs: {}, reviews: {} });

class DB {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.appsDir = path.join(dir, 'apps');
    fs.mkdirSync(this.appsDir, { recursive: true });
    this.data = EMPTY();
    if (fs.existsSync(this.file)) {
      this.data = Object.assign(EMPTY(), JSON.parse(fs.readFileSync(this.file, 'utf8')));
    }
    this._timer = null;
  }

  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => this.flush(), 50);
  }

  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  codePath(appId, version) {
    const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.appsDir, safe(appId), safe(version) + '.html');
  }

  writeCode(appId, version, html) {
    const p = this.codePath(appId, version);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, html);
  }

  readCode(appId, version) {
    try { return fs.readFileSync(this.codePath(appId, version), 'utf8'); }
    catch { return null; }
  }

  deleteCode(appId) {
    fs.rmSync(path.dirname(this.codePath(appId, 'x')), { recursive: true, force: true });
  }
}

module.exports = { DB };
