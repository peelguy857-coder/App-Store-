'use strict';
// App Store server: zero dependencies, just Node.js.
//   node server.js            -> http://localhost:3000
//   PORT=8080 DATA_DIR=./mydata node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DB } = require('./lib/db');
const { seed } = require('./lib/seed');

const CATEGORIES = ['Games', 'Productivity', 'Utilities', 'Education', 'Creativity', 'Lifestyle', 'Social', 'Other'];
const MAX_HTML = 2 * 1024 * 1024;      // 2 MB of app code per version
const MAX_ICON = 300 * 1024;           // 300 KB icon image (data URL)
const MAX_BODY = 3 * 1024 * 1024;
const SESSION_DAYS = 60;               // stay signed in for 60 days, renewed while in use
const SHORT_SESSION_HOURS = 12;        // when "keep me signed in" is off
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // failed sign-in limit window
const LOGIN_MAX_FAILS = 10;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Apps run with an opaque origin, so they can never touch the store's
// cookies, API, or other apps' data.
const APP_SANDBOX = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const newId = (bytes = 6) => crypto.randomBytes(bytes).toString('base64url');
const now = () => new Date().toISOString();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function checkPassword(password, user) {
  if (!user.passHash) return false;
  const a = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  const b = Buffer.from(user.passHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Upload too large (max 3 MB)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...headers,
  });
  res.end(isBuf ? body : JSON.stringify(body));
}

// ---------- validation ----------

function str(v, field, { min = 0, max = 200 } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min) throw new HttpError(400, min > 1 ? `${field} must be at least ${min} characters` : `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return s;
}

function validIcon(icon) {
  if (!icon || typeof icon !== 'object') return { type: 'emoji', emoji: '✨', bg: '#6366f1' };
  const bg = /^#[0-9a-fA-F]{6}$/.test(icon.bg || '') ? icon.bg : '#6366f1';
  if (icon.type === 'image') {
    const data = String(icon.data || '');
    if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(data)) {
      throw new HttpError(400, 'Icon must be a PNG, JPEG, WebP or GIF image');
    }
    if (data.length > MAX_ICON) throw new HttpError(400, 'Icon image is too large (max ~200 KB)');
    return { type: 'image', data, bg };
  }
  const emoji = str(icon.emoji || '✨', 'Icon emoji', { min: 1, max: 16 });
  return { type: 'emoji', emoji, bg };
}

function validVersion(v) {
  const s = str(v || '1.0.0', 'Version', { min: 1, max: 20 });
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(s)) throw new HttpError(400, 'Version may only use letters, numbers, dots and dashes (e.g. 1.2.0)');
  return s;
}

function validHtml(html) {
  if (typeof html !== 'string' || !html.trim()) throw new HttpError(400, 'App code (HTML) is required');
  if (Buffer.byteLength(html) > MAX_HTML) throw new HttpError(400, 'App code is too large (max 2 MB)');
  return html;
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
}

// ---------- the app ----------

async function createApp({ dataDir = path.join(__dirname, 'data'), databaseUrl = '', seedSamples = true } = {}) {
  const db = await DB.open({ dataDir, databaseUrl });
  const D = db.data;
  if (seedSamples) await seed(db, { newId, now });
  const loginFails = new Map(); // "ip|username" -> { count, first }

  function currentUser(req) {
    const sid = parseCookies(req.headers.cookie).sid;
    const s = sid && D.sessions[sid];
    if (!s) return null;
    if (Date.parse(s.expires) < Date.now()) { delete D.sessions[sid]; db.save(); return null; }
    return D.users[s.userId] || null;
  }

  const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
  function sessionCookie(req, sid, maxAgeSec) {
    const age = maxAgeSec == null ? '' : `; Max-Age=${maxAgeSec}`;
    return `sid=${sid}; HttpOnly; SameSite=Lax; Path=/${age}${isHttps(req) ? '; Secure' : ''}`;
  }

  // Keep remembered sign-ins alive while people use the store.
  function renewSession(req, res) {
    const sid = parseCookies(req.headers.cookie).sid;
    const s = sid && D.sessions[sid];
    if (!s || !s.remember || Date.parse(s.expires) < Date.now()) return;
    if (Date.now() - Date.parse(s.renewed || s.created || 0) < 864e5) return;
    s.renewed = now();
    s.expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    db.save();
    res.setHeader('Set-Cookie', sessionCookie(req, sid, SESSION_DAYS * 86400));
  }

  function clientIp(req) {
    return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  }
  function checkLoginLimit(key) {
    const f = loginFails.get(key);
    if (f && Date.now() - f.first < LOGIN_WINDOW_MS && f.count >= LOGIN_MAX_FAILS) {
      throw new HttpError(429, 'Too many wrong passwords. Wait 15 minutes and try again.');
    }
  }
  function noteLoginFail(key) {
    const f = loginFails.get(key);
    if (!f || Date.now() - f.first >= LOGIN_WINDOW_MS) loginFails.set(key, { count: 1, first: Date.now() });
    else f.count++;
    if (loginFails.size > 10000) loginFails.clear();
  }

  function validPassword(pw) {
    const password = typeof pw === 'string' ? pw : '';
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    if (password.length > 200) throw new HttpError(400, 'Password is too long');
    if (/^\s|\s$/.test(password)) throw new HttpError(400, 'Password can’t start or end with a space');
    return password;
  }

  function requireUser(req) {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'Please sign in first');
    return u;
  }

  function startSession(req, res, user, remember = true) {
    const sid = crypto.randomBytes(32).toString('hex');
    const ms = remember ? SESSION_DAYS * 864e5 : SHORT_SESSION_HOURS * 3600e3;
    D.sessions[sid] = { userId: user.id, created: now(), renewed: now(), expires: new Date(Date.now() + ms).toISOString(), remember: !!remember };
    // Drop this person's expired sessions while we're here.
    for (const [k, s] of Object.entries(D.sessions)) if (Date.parse(s.expires) < Date.now()) delete D.sessions[k];
    db.save();
    res.setHeader('Set-Cookie', sessionCookie(req, sid, remember ? SESSION_DAYS * 86400 : null));
  }

  const publicUser = (u) => u && ({ id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt });

  function rating(appId) {
    const list = D.reviews[appId] || [];
    if (!list.length) return { avg: 0, count: 0 };
    const sum = list.reduce((a, r) => a + r.rating, 0);
    return { avg: Math.round((sum / list.length) * 10) / 10, count: list.length };
  }

  function isInstalled(user, appId) {
    return !!(user && (D.installs[user.id] || []).includes(appId));
  }

  function publicApp(app, user, full = false) {
    const dev = D.users[app.ownerId];
    const out = {
      id: app.id, name: app.name, tagline: app.tagline, category: app.category, icon: app.icon,
      developer: dev ? { id: dev.id, name: dev.displayName } : { id: null, name: 'Unknown' },
      version: app.currentVersion, installs: app.installs, opens: app.opens,
      createdAt: app.createdAt, updatedAt: app.updatedAt, rating: rating(app.id),
      installed: isInstalled(user, app.id), isOwner: !!(user && user.id === app.ownerId),
    };
    if (full) {
      out.description = app.description;
      out.versions = [...app.versions].reverse();
      out.reviews = (D.reviews[app.id] || [])
        .map((r) => ({ ...r, user: publicUser(D.users[r.userId]) }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      out.myReview = user ? (D.reviews[app.id] || []).find((r) => r.userId === user.id) || null : null;
      out.size = (app.versions.find((v) => v.version === app.currentVersion) || {}).size || 0;
    }
    return out;
  }

  function getApp(id) {
    const app = D.apps[id];
    if (!app) throw new HttpError(404, 'App not found');
    return app;
  }

  function ownApp(id, user) {
    const app = getApp(id);
    if (app.ownerId !== user.id) throw new HttpError(403, 'Only the developer of this app can do that');
    return app;
  }

  function listApps({ q = '', category = '', sort = 'popular', developer = '' }, user) {
    let list = Object.values(D.apps);
    if (category) list = list.filter((a) => a.category === category);
    if (developer) list = list.filter((a) => a.ownerId === developer);
    if (q) {
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      list = list.filter((a) => {
        const dev = D.users[a.ownerId];
        const hay = [a.name, a.tagline, a.description, a.category, dev && dev.displayName].join(' ').toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
    }
    const score = {
      popular: (a) => a.installs * 10 + a.opens,
      new: (a) => Date.parse(a.createdAt),
      updated: (a) => Date.parse(a.updatedAt),
      rating: (a) => { const r = rating(a.id); return r.avg * 1000 + r.count; },
      name: null,
    }[sort];
    if (score) list.sort((a, b) => score(b) - score(a));
    else list.sort((a, b) => a.name.localeCompare(b.name));
    return list.map((a) => publicApp(a, user));
  }

  // ---------- routes ----------

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/api/me', (req) => ({ user: publicUser(currentUser(req)) }));
  route('GET', '/api/categories', () => ({ categories: CATEGORIES }));

  route('POST', '/api/auth/signup', async (req, res) => {
    const body = await readBody(req);
    const username = str(body.username, 'Username', { min: 3, max: 24 }).toLowerCase();
    if (!/^[a-z0-9_]+$/.test(username)) throw new HttpError(400, 'Username may only use letters, numbers and _');
    const password = validPassword(body.password);
    if (password.toLowerCase() === username) throw new HttpError(400, 'Pick a password that isn’t your username');
    if (Object.values(D.users).some((u) => u.username === username)) throw new HttpError(409, 'That username is taken');
    const displayName = str(body.displayName || username, 'Display name', { min: 1, max: 40 });
    const { salt, hash } = hashPassword(password);
    const user = { id: newId(), username, displayName, salt, passHash: hash, createdAt: now() };
    D.users[user.id] = user;
    startSession(req, res, user, body.remember !== false);
    return { user: publicUser(user) };
  });

  route('POST', '/api/auth/login', async (req, res) => {
    const body = await readBody(req);
    const username = String(body.username || '').trim().toLowerCase().slice(0, 64);
    const key = clientIp(req) + '|' + username;
    checkLoginLimit(key);
    const user = Object.values(D.users).find((u) => u.username === username);
    if (!user || !checkPassword(String(body.password || ''), user)) {
      noteLoginFail(key);
      throw new HttpError(401, 'Wrong username or password');
    }
    loginFails.delete(key);
    startSession(req, res, user, body.remember !== false);
    return { user: publicUser(user) };
  });

  route('POST', '/api/auth/logout', (req, res) => {
    const sid = parseCookies(req.headers.cookie).sid;
    if (sid) { delete D.sessions[sid]; db.save(); }
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    return { ok: true };
  });

  route('PUT', '/api/me', async (req) => {
    const user = requireUser(req);
    const body = await readBody(req);
    user.displayName = str(body.displayName, 'Display name', { min: 1, max: 40 });
    db.save();
    return { user: publicUser(user) };
  });

  route('PUT', '/api/me/password', async (req, res) => {
    const user = requireUser(req);
    const body = await readBody(req);
    if (!checkPassword(String(body.currentPassword || ''), user)) throw new HttpError(400, 'Your current password is wrong');
    const password = validPassword(body.newPassword);
    if (password.toLowerCase() === user.username) throw new HttpError(400, 'Pick a password that isn’t your username');
    const { salt, hash } = hashPassword(password);
    user.salt = salt; user.passHash = hash;
    // Sign out every other device; keep this one signed in.
    const mine = parseCookies(req.headers.cookie).sid;
    for (const [k, s] of Object.entries(D.sessions)) if (s.userId === user.id && k !== mine) delete D.sessions[k];
    db.save();
    return { ok: true };
  });

  route('POST', '/api/auth/logout-everywhere', (req, res) => {
    const user = requireUser(req);
    for (const [k, s] of Object.entries(D.sessions)) if (s.userId === user.id) delete D.sessions[k];
    db.save();
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    return { ok: true };
  });

  route('GET', '/healthz', () => ({ ok: true, storage: db.kind }));

  route('GET', '/api/apps', (req, res, params, query) => ({
    apps: listApps({
      q: query.get('q') || '', category: query.get('category') || '',
      sort: query.get('sort') || 'popular', developer: query.get('developer') || '',
    }, currentUser(req)),
  }));

  route('GET', '/api/apps/:id', (req, res, { id }) => ({ app: publicApp(getApp(id), currentUser(req), true) }));

  route('POST', '/api/apps', async (req) => {
    const user = requireUser(req);
    const body = await readBody(req);
    const name = str(body.name, 'App name', { min: 1, max: 40 });
    if (Object.values(D.apps).some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      throw new HttpError(409, 'An app with that name already exists — pick another name');
    }
    const category = CATEGORIES.includes(body.category) ? body.category : 'Other';
    const version = validVersion(body.version);
    const html = validHtml(body.html);
    const app = {
      id: newId(), name, slug: slugify(name), ownerId: user.id,
      tagline: str(body.tagline, 'Tagline', { max: 80 }),
      description: str(body.description, 'Description', { max: 4000 }),
      category, icon: validIcon(body.icon),
      currentVersion: version,
      versions: [{ version, notes: str(body.notes || 'First release', 'Release notes', { max: 1000 }), createdAt: now(), size: Buffer.byteLength(html) }],
      installs: 0, opens: 0, createdAt: now(), updatedAt: now(),
    };
    await db.writeCode(app.id, version, html);
    D.apps[app.id] = app;
    db.save();
    return { app: publicApp(app, user, true) };
  });

  route('PUT', '/api/apps/:id', async (req, res, { id }) => {
    const user = requireUser(req);
    const app = ownApp(id, user);
    const body = await readBody(req);
    if (body.name !== undefined) {
      const name = str(body.name, 'App name', { min: 1, max: 40 });
      if (Object.values(D.apps).some((a) => a.id !== app.id && a.name.toLowerCase() === name.toLowerCase())) {
        throw new HttpError(409, 'An app with that name already exists');
      }
      app.name = name; app.slug = slugify(name);
    }
    if (body.tagline !== undefined) app.tagline = str(body.tagline, 'Tagline', { max: 80 });
    if (body.description !== undefined) app.description = str(body.description, 'Description', { max: 4000 });
    if (body.category !== undefined) app.category = CATEGORIES.includes(body.category) ? body.category : 'Other';
    if (body.icon !== undefined) app.icon = validIcon(body.icon);
    if (body.html !== undefined) {
      const html = validHtml(body.html);
      const version = validVersion(body.version);
      if (app.versions.some((v) => v.version === version)) {
        throw new HttpError(409, `Version ${version} already exists — use a new version number`);
      }
      await db.writeCode(app.id, version, html);
      app.versions.push({ version, notes: str(body.notes, 'Release notes', { max: 1000 }), createdAt: now(), size: Buffer.byteLength(html) });
      app.currentVersion = version;
    }
    app.updatedAt = now();
    db.save();
    return { app: publicApp(app, user, true) };
  });

  route('DELETE', '/api/apps/:id', async (req, res, { id }) => {
    const user = requireUser(req);
    const app = ownApp(id, user);
    delete D.apps[app.id];
    delete D.reviews[app.id];
    for (const uid of Object.keys(D.installs)) D.installs[uid] = D.installs[uid].filter((x) => x !== app.id);
    await db.deleteCode(app.id);
    db.save();
    return { ok: true };
  });

  route('POST', '/api/apps/:id/install', (req, res, { id }) => {
    const user = requireUser(req);
    const app = getApp(id);
    const list = (D.installs[user.id] = D.installs[user.id] || []);
    if (!list.includes(app.id)) { list.unshift(app.id); app.installs++; db.save(); }
    return { app: publicApp(app, user) };
  });

  route('DELETE', '/api/apps/:id/install', (req, res, { id }) => {
    const user = requireUser(req);
    const app = getApp(id);
    const list = D.installs[user.id] || [];
    const i = list.indexOf(app.id);
    if (i >= 0) { list.splice(i, 1); app.installs = Math.max(0, app.installs - 1); db.save(); }
    return { app: publicApp(app, user) };
  });

  route('GET', '/api/library', (req) => {
    const user = requireUser(req);
    const apps = (D.installs[user.id] || []).filter((id) => D.apps[id]).map((id) => publicApp(D.apps[id], user));
    return { apps };
  });

  route('POST', '/api/apps/:id/reviews', async (req, res, { id }) => {
    const user = requireUser(req);
    const app = getApp(id);
    if (app.ownerId === user.id) throw new HttpError(400, "You can't review your own app");
    const body = await readBody(req);
    const r = Number(body.rating);
    if (!Number.isInteger(r) || r < 1 || r > 5) throw new HttpError(400, 'Pick a rating from 1 to 5 stars');
    const text = str(body.text, 'Review', { max: 1000 });
    const list = (D.reviews[app.id] = D.reviews[app.id] || []);
    const existing = list.find((x) => x.userId === user.id);
    if (existing) Object.assign(existing, { rating: r, text, updatedAt: now() });
    else list.push({ id: newId(), userId: user.id, rating: r, text, createdAt: now(), updatedAt: now() });
    db.save();
    return { app: publicApp(app, user, true) };
  });

  route('DELETE', '/api/apps/:id/reviews', (req, res, { id }) => {
    const user = requireUser(req);
    getApp(id);
    D.reviews[id] = (D.reviews[id] || []).filter((x) => x.userId !== user.id);
    db.save();
    return { ok: true };
  });

  route('GET', '/api/dev/apps', (req) => {
    const user = requireUser(req);
    return { apps: Object.values(D.apps).filter((a) => a.ownerId === user.id).map((a) => publicApp(a, user, true)) };
  });

  route('GET', '/api/dev/apps/:id/code', async (req, res, { id }) => {
    const user = requireUser(req);
    const app = ownApp(id, user);
    return { version: app.currentVersion, html: (await db.readCode(app.id, app.currentVersion)) || '' };
  });

  // Run an app. Served with a sandbox CSP so even when opened directly it
  // gets an opaque origin. The store also fetches this and runs it in a
  // sandboxed iframe (see public/app.js).
  route('GET', '/run/:id', async (req, res, { id }, query) => {
    const app = getApp(id);
    const version = query.get('v') && app.versions.some((v) => v.version === query.get('v')) ? query.get('v') : app.currentVersion;
    const html = await db.readCode(app.id, version);
    if (html == null) throw new HttpError(404, 'App code missing');
    if (!query.has('preview')) { app.opens++; db.save(); }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': APP_SANDBOX,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(html);
  });

  route('GET', '/download/:id', async (req, res, { id }) => {
    const app = getApp(id);
    const html = (await db.readCode(app.id, app.currentVersion)) || '';
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="${app.slug}-${app.currentVersion.replace(/[^\w.-]/g, '')}.html"`,
      'Content-Security-Policy': APP_SANDBOX,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(html);
  });

  function serveStatic(req, res, pathname) {
    let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (path.extname(pathname)) return send(res, 404, 'Not found');
      file = path.join(PUBLIC_DIR, 'index.html'); // single-page app fallback
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'SAMEORIGIN',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      const isApi = url.pathname.startsWith('/api/');
      // CSRF guard: mutating API calls must carry a custom header, which
      // other sites (and sandboxed apps) cannot send without CORS approval.
      if (isApi && req.method !== 'GET' && req.headers['x-store-client'] !== '1') {
        throw new HttpError(403, 'Missing X-Store-Client header');
      }
      if (isApi) renewSession(req, res);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        const out = await r.handler(req, res, params, url.searchParams);
        if (!res.headersSent) send(res, 200, out, { 'Cache-Control': 'no-store' });
        return;
      }
      if (isApi) throw new HttpError(404, 'Not found');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      serveStatic(req, res, url.pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong' : err.message });
    }
  }

  const server = http.createServer(handle);
  server.db = db;
  return server;
}

module.exports = { createApp, CATEGORIES };

if (require.main === module) {
  (async () => {
    const port = Number(process.env.PORT) || 3000;
    const server = await createApp({
      dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
      databaseUrl: process.env.DATABASE_URL || '',
    });
    server.listen(port, () => console.log(`App Store running at http://localhost:${port} (saving to ${server.db.kind})`));
    const shutdown = async () => { await server.db.close(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })().catch((err) => { console.error('Could not start the App Store:', err.message); process.exit(1); });
}
