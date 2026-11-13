'use strict';
/* App Store front end — a small single-page app with hash routing. */

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
let me = null;
let categories = [];
let renderSeq = 0;
let activePlayer = null;

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;

async function api(method, path, body) {
  const opts = { method, headers: { 'X-Store-Client': '1' }, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

const fmtNum = (n) => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n);
const fmtSize = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B';
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function iconHTML(icon, cls = '') {
  icon = icon || { type: 'emoji', emoji: '✨', bg: '#6366f1' };
  const inner = icon.type === 'image' ? `<img src="${esc(icon.data)}" alt="">` : esc(icon.emoji);
  return `<div class="icon ${cls}" style="background:${esc(icon.bg)}">${inner}</div>`;
}

function starsHTML(avg) {
  const full = Math.round(avg);
  return `<span class="stars" aria-label="${avg} out of 5">${'★'.repeat(full)}${'☆'.repeat(5 - full)}</span>`;
}

function getButton(app) {
  if (app.installed) return `<button class="btn get open" data-act="open" data-id="${esc(app.id)}">Open</button>`;
  return `<button class="btn get" data-act="get" data-id="${esc(app.id)}">Get</button>`;
}

function appCard(app) {
  const rating = app.rating.count ? `${starsHTML(app.rating.avg)} ${app.rating.count}` : 'No ratings yet';
  return `<a class="card" href="#/app/${esc(app.id)}">
    ${iconHTML(app.icon)}
    <div class="info">
      <div class="name">${esc(app.name)}</div>
      <div class="tag">${esc(app.tagline || app.category)}</div>
      <div class="meta">${rating} · ${esc(app.category)}</div>
    </div>
    ${getButton(app)}
  </a>`;
}

const gridHTML = (apps, emptyMsg = 'No apps here yet.') =>
  apps.length ? `<div class="grid">${apps.map(appCard).join('')}</div>` : `<div class="empty"><div class="big">🔍</div><p>${esc(emptyMsg)}</p></div>`;

function needSignIn(message) {
  return `<div class="empty"><div class="big">🔐</div><p>${esc(message)}</p>
    <a class="btn primary" href="#/account?next=${enc(location.hash)}">Sign in or create an account</a></div>`;
}

function setView(seq, html) {
  if (seq !== renderSeq) return false;
  view.innerHTML = html;
  return true;
}

function updateNav(section) {
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === section));
  $('#accountLabel').textContent = me ? me.displayName : 'Sign in';
}

// ---------- install / open (delegated) ----------

async function install(id, btn) {
  if (!me) { location.hash = `#/account?next=${enc(location.hash)}`; toast('Sign in to get apps'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    await api('POST', `/api/apps/${enc(id)}/install`);
    toast('Added to My Apps');
    document.querySelectorAll(`[data-act="get"][data-id="${CSS.escape(id)}"]`).forEach((b) => {
      b.outerHTML = `<button class="btn get open" data-act="open" data-id="${esc(id)}">Open</button>`;
    });
    if (location.hash.startsWith('#/app/')) route();
  } catch (e) {
    toast(e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Get'; }
  }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  const id = el.dataset.id;
  if (el.dataset.act === 'get') install(id, el);
  if (el.dataset.act === 'open') location.hash = `#/play/${enc(id)}`;
});

// ---------- the in-store app player ----------
// Apps run inside a sandboxed iframe with an opaque origin, so they can't
// reach the store's account or other apps. Because opaque origins have no
// localStorage, we inject a small shim that gives each app its own
// localStorage, saved by the store on this device.

function safeJSON(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));
}

function storageShim(snapshot) {
  return `<script>(function(){var d=${safeJSON(snapshot)},H=Object.prototype.hasOwnProperty;
function P(){try{parent.postMessage({__appstore:"storage",data:d},"*")}catch(e){}}
function mk(o,persist){var api={getItem:function(k){k=String(k);return H.call(o,k)?o[k]:null},setItem:function(k,v){o[String(k)]=String(v);if(persist)P()},removeItem:function(k){delete o[String(k)];if(persist)P()},clear:function(){for(var k in o)delete o[k];if(persist)P()},key:function(i){var k=Object.keys(o)[i];return k===undefined?null:k}};
return new Proxy(api,{get:function(t,k){if(k==="length")return Object.keys(o).length;if(k in t)return t[k];if(typeof k==="symbol")return undefined;return api.getItem(k)},set:function(t,k,v){api.setItem(k,v);return true},deleteProperty:function(t,k){api.removeItem(k);return true},has:function(t,k){return k in t||H.call(o,k)},ownKeys:function(){return Object.keys(o)},getOwnPropertyDescriptor:function(t,k){if(H.call(o,k))return{value:o[k],enumerable:true,configurable:true,writable:true}}})}
var L=mk(d,true),S=mk({},false);
try{Object.defineProperty(window,"localStorage",{configurable:true,get:function(){return L}})}catch(e){}
try{Object.defineProperty(window,"sessionStorage",{configurable:true,get:function(){return S}})}catch(e){}
})();<\/script>`;
}

function injectShim(html, snapshot) {
  const shim = storageShim(snapshot);
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + shim + html.slice(m.index + m[0].length);
  }
  return shim + html;
}

function readAppData(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; }
}

/** Mounts a full-screen player. Returns a handle with destroy(). */
function mountPlayer({ name, icon, html, storageKey, onClose, buttons = '' }) {
  if (activePlayer) activePlayer.destroy();
  const wrap = document.createElement('div');
  wrap.className = 'player';
  wrap.innerHTML = `<div class="player-bar">
      <button class="iconbtn" data-close>‹ Back</button>
      <div class="title">${iconHTML(icon, 'sm')}<span>${esc(name)}</span></div>
      ${buttons}
      <button class="iconbtn" data-reload title="Restart app">↻ Restart</button>
    </div>
    <iframe title="${esc(name)}" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads" allow="fullscreen; autoplay; clipboard-write; gamepad" allowfullscreen></iframe>`;
  document.body.appendChild(wrap);
  document.body.style.overflow = 'hidden';
  const frame = $('iframe', wrap);
  let saveTimer = null;
  let pending = null;

  const flush = () => {
    clearTimeout(saveTimer);
    if (pending === null) return;
    try { localStorage.setItem(storageKey, JSON.stringify(pending)); }
    catch { toast('This app has stored too much data on this device'); }
    pending = null;
  };
  const load = () => { frame.srcdoc = injectShim(html, readAppData(storageKey)); };
  const onMessage = (e) => {
    if (e.source !== frame.contentWindow || !e.data || e.data.__appstore !== 'storage') return;
    if (typeof e.data.data !== 'object' || e.data.data === null) return;
    pending = e.data.data;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 150);
  };
  window.addEventListener('message', onMessage);
  window.addEventListener('beforeunload', flush);

  const handle = {
    destroy() {
      flush();
      window.removeEventListener('message', onMessage);
      window.removeEventListener('beforeunload', flush);
      wrap.remove();
      document.body.style.overflow = '';
      if (activePlayer === handle) activePlayer = null;
    },
  };
  $('[data-close]', wrap).onclick = () => { handle.destroy(); onClose && onClose(); };
  $('[data-reload]', wrap).onclick = () => { flush(); load(); };
  load();
  frame.focus();
  activePlayer = handle;
  return handle;
}

const appDataKey = (appId) => `appdata:${me ? me.id : 'guest'}:${appId}`;

// ---------- pages ----------

async function pageDiscover(seq) {
  updateNav('discover');
  const { apps } = await api('GET', '/api/apps?sort=popular');
  const byNew = [...apps].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const byRating = [...apps].filter((a) => a.rating.count).sort((a, b) => b.rating.avg - a.rating.avg || b.rating.count - a.rating.count);
  const featured = apps[0];
  setView(seq, `
    ${featured ? `<a class="hero" href="#/app/${esc(featured.id)}">
      ${iconHTML(featured.icon, 'lg')}
      <div><div class="eyebrow">Featured app</div><h1>${esc(featured.name)}</h1>
      <p>${esc(featured.tagline || featured.category)}</p><span class="btn">View app</span></div></a>` : ''}
    <div class="section"><div class="chips">
      ${categories.map((c) => `<a class="chip" href="#/category/${enc(c)}">${esc(c)}</a>`).join('')}
    </div></div>
    <div class="section"><div class="section-head"><h2>Popular</h2><a href="#/browse?sort=popular">See all</a></div>${gridHTML(apps.slice(0, 6), 'No apps have been published yet. Be the first!')}</div>
    <div class="section"><div class="section-head"><h2>New arrivals</h2><a href="#/browse?sort=new">See all</a></div>${gridHTML(byNew.slice(0, 6))}</div>
    ${byRating.length ? `<div class="section"><div class="section-head"><h2>Top rated</h2><a href="#/browse?sort=rating">See all</a></div>${gridHTML(byRating.slice(0, 6))}</div>` : ''}
    <div class="devbanner">
      <div><h2>Made something? Publish it here.</h2>
      <p class="muted" style="margin:6px 0 0">Anyone can be a developer. Upload an HTML app and people can find it, get it, and use it right in the store.</p></div>
      <a class="btn primary" href="#/dev/new">Publish an app</a>
    </div>`);
}

async function pageBrowse(seq, { q = '', category = '', sort, developer = '' }) {
  updateNav(q ? '' : 'discover');
  sort = sort || (q ? 'popular' : 'popular');
  const qs = new URLSearchParams({ q, category, sort, developer });
  const { apps } = await api('GET', `/api/apps?${qs}`);
  let title = 'All apps';
  if (q) title = `Results for “${q}”`;
  else if (category) title = category;
  else if (developer) title = apps[0] ? `Apps by ${apps[0].developer.name}` : 'Developer';
  const sortSel = `<select class="input" id="sortSel" style="width:auto">
    ${[['popular', 'Most popular'], ['new', 'Newest'], ['updated', 'Recently updated'], ['rating', 'Top rated'], ['name', 'Name']]
      .map(([v, l]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  if (!setView(seq, `
    <div class="section-head"><h1>${esc(title)}</h1>${sortSel}</div>
    ${!q && !developer ? `<div class="chips" style="margin-bottom:16px">
      <a class="chip ${!category ? 'on' : ''}" href="#/browse?sort=${enc(sort)}">All</a>
      ${categories.map((c) => `<a class="chip ${c === category ? 'on' : ''}" href="#/category/${enc(c)}">${esc(c)}</a>`).join('')}</div>` : ''}
    <p class="muted small">${apps.length} app${apps.length === 1 ? '' : 's'}</p>
    ${gridHTML(apps, q ? 'Nothing matched your search. Try different words.' : 'No apps here yet.')}`)) return;
  $('#sortSel').onchange = (e) => {
    const p = new URLSearchParams({ sort: e.target.value });
    if (q) p.set('q', q);
    if (category) p.set('category', category);
    if (developer) p.set('developer', developer);
    location.hash = `#/browse?${p}`;
  };
}

async function pageApp(seq, id) {
  updateNav('discover');
  const { app } = await api('GET', `/api/apps/${enc(id)}`);
  const r = app.rating;
  const actions = [];
  if (app.installed) {
    actions.push(`<button class="btn primary" data-act="open" data-id="${esc(app.id)}">Open</button>`);
    actions.push(`<button class="btn" id="removeBtn">Remove from My Apps</button>`);
  } else {
    actions.push(`<button class="btn primary" data-act="get" data-id="${esc(app.id)}">Get</button>`);
    actions.push(`<button class="btn" data-act="open" data-id="${esc(app.id)}">Try it</button>`);
  }
  actions.push(`<a class="btn" href="/download/${esc(app.id)}" download>⬇ Download</a>`);
  if (app.isOwner) actions.push(`<a class="btn" href="#/dev/edit/${esc(app.id)}">✎ Edit app</a>`);

  let reviewForm = '';
  if (!me) reviewForm = `<p class="muted"><a href="#/account?next=${enc(location.hash)}" style="color:var(--accent)">Sign in</a> to rate and review this app.</p>`;
  else if (!app.isOwner) {
    const mine = app.myReview;
    reviewForm = `<form class="form" id="reviewForm" style="margin-bottom:10px">
      <div class="field"><label>${mine ? 'Update your review' : 'Rate this app'}</label>
        <div class="star-pick" id="starPick">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div></div>
      <div class="field"><textarea id="reviewText" rows="3" maxlength="1000" placeholder="What did you think? (optional)">${esc(mine ? mine.text : '')}</textarea></div>
      <div class="row"><button class="btn primary" type="submit">${mine ? 'Update review' : 'Post review'}</button>
      ${mine ? '<button class="btn danger" type="button" id="delReview">Delete my review</button>' : ''}
      <span class="error" id="reviewErr"></span></div></form>`;
  }

  if (!setView(seq, `
    <div class="detail-head">
      ${iconHTML(app.icon, 'lg')}
      <div style="min-width:0">
        <h1>${esc(app.name)}</h1>
        <div class="muted">${esc(app.tagline)}</div>
        <a class="dev" href="#/browse?developer=${enc(app.developer.id || '')}">${esc(app.developer.name)}</a>
        <div class="detail-actions">${actions.join('')}</div>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><b>${r.count ? r.avg.toFixed(1) + ' ★' : '—'}</b><span>${r.count} rating${r.count === 1 ? '' : 's'}</span></div>
      <div class="stat"><b>${fmtNum(app.installs)}</b><span>Downloads</span></div>
      <div class="stat"><b>${fmtNum(app.opens)}</b><span>Opens</span></div>
      <div class="stat"><b>${esc(app.version)}</b><span>Version</span></div>
      <div class="stat"><b>${fmtSize(app.size)}</b><span>Size</span></div>
      <div class="stat"><b><a href="#/category/${enc(app.category)}">${esc(app.category)}</a></b><span>Category</span></div>
    </div>
    <div class="section"><div class="section-head"><h2>About this app</h2></div>
      <div class="panel desc">${esc(app.description || 'The developer has not added a description yet.')}</div></div>
    <div class="section"><div class="section-head"><h2>What’s new</h2></div>
      <div class="panel"><ul class="versions">${app.versions.map((v) => `<li><b>Version ${esc(v.version)}</b> <span class="muted small">· ${fmtDate(v.createdAt)}</span><div class="desc">${esc(v.notes)}</div></li>`).join('')}</ul></div></div>
    <div class="section"><div class="section-head"><h2>Ratings & reviews</h2></div>
      <div class="panel">${reviewForm}
        ${app.reviews.length ? app.reviews.map((rv) => `<div class="review"><div class="review-head"><b>${esc(rv.user ? rv.user.displayName : 'Someone')}</b><span class="muted small">${fmtDate(rv.updatedAt)}</span></div>
          ${starsHTML(rv.rating)}${rv.text ? `<div class="desc">${esc(rv.text)}</div>` : ''}</div>`).join('') : '<p class="muted">No reviews yet.</p>'}
      </div></div>`)) return;

  const removeBtn = $('#removeBtn');
  if (removeBtn) removeBtn.onclick = async () => {
    await api('DELETE', `/api/apps/${enc(app.id)}/install`);
    toast('Removed from My Apps');
    route();
  };

  const form = $('#reviewForm');
  if (form) {
    let rating = app.myReview ? app.myReview.rating : 0;
    const paint = () => form.querySelectorAll('#starPick button').forEach((b) => b.classList.toggle('on', +b.dataset.n <= rating));
    form.querySelectorAll('#starPick button').forEach((b) => { b.onclick = () => { rating = +b.dataset.n; paint(); }; });
    paint();
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', `/api/apps/${enc(app.id)}/reviews`, { rating, text: $('#reviewText').value });
        toast('Thanks for your review!');
        route();
      } catch (err) { $('#reviewErr').textContent = err.message; }
    };
    const del = $('#delReview');
    if (del) del.onclick = async () => { await api('DELETE', `/api/apps/${enc(app.id)}/reviews`); toast('Review deleted'); route(); };
  }
}

async function pagePlay(seq, id) {
  const { app } = await api('GET', `/api/apps/${enc(id)}`);
  const res = await fetch(`/run/${enc(id)}`);
  if (!res.ok) throw new Error('Could not load this app');
  const html = await res.text();
  if (seq !== renderSeq) return;
  view.innerHTML = '';
  const extra = app.installed || !me ? '' : `<button class="iconbtn" id="playerGet">Get</button>`;
  mountPlayer({
    name: app.name, icon: app.icon, html, storageKey: appDataKey(app.id), buttons: extra,
    onClose: () => { if (history.length > 1) history.back(); else location.hash = `#/app/${enc(app.id)}`; },
  });
  const g = $('#playerGet');
  if (g) g.onclick = async () => { await install(app.id); g.remove(); };
}

async function pageLibrary(seq) {
  updateNav('library');
  if (!me) return setView(seq, `<h1>My Apps</h1>${needSignIn('Sign in to see the apps you’ve downloaded.')}`);
  const { apps } = await api('GET', '/api/library');
  setView(seq, `<div class="section-head"><h1>My Apps</h1><span class="muted small">${apps.length} app${apps.length === 1 ? '' : 's'}</span></div>
    ${apps.length ? `<div class="panel" style="padding:24px"><div class="home-grid">${apps.map((a) => `
      <div class="home-app" data-act="open" data-id="${esc(a.id)}" role="button" tabindex="0" title="Open ${esc(a.name)}">
        ${iconHTML(a.icon)}<span>${esc(a.name)}</span></div>`).join('')}</div></div>
      <p class="muted small" style="margin-top:12px">Tap an app to open it. To remove an app, open its store page.</p>`
    : `<div class="empty"><div class="big">📱</div><p>You haven’t downloaded any apps yet.</p><a class="btn primary" href="#/">Discover apps</a></div>`}`);
}

async function pageAccount(seq, next) {
  updateNav('account');
  if (me) {
    if (!setView(seq, `<div class="auth"><div class="panel">
      <h1 style="margin-bottom:4px">${esc(me.displayName)}</h1><p class="muted" style="margin-top:0">@${esc(me.username)}</p>
      <form class="form" id="profileForm">
        <div class="field"><label for="dn">Display name (shown as your developer name)</label><input type="text" id="dn" maxlength="40" value="${esc(me.displayName)}"></div>
        <div class="row"><button class="btn primary">Save</button><span class="error" id="profErr"></span></div>
      </form>
      <div class="row" style="margin-top:18px"><a class="btn" href="#/library">My Apps</a><a class="btn" href="#/dev">Developer dashboard</a>
      <button class="btn danger" id="logout">Sign out</button></div></div></div>`)) return;
    $('#profileForm').onsubmit = async (e) => {
      e.preventDefault();
      try { ({ user: me } = await api('PUT', '/api/me', { displayName: $('#dn').value })); toast('Saved'); route(); }
      catch (err) { $('#profErr').textContent = err.message; }
    };
    $('#logout').onclick = async () => { await api('POST', '/api/auth/logout'); me = null; toast('Signed out'); location.hash = '#/'; };
    return;
  }
  let mode = 'login';
  const draw = () => {
    if (!setView(seq, `<div class="auth"><div class="panel">
      <div class="tabs"><button class="btn ${mode === 'login' ? 'primary' : ''}" data-mode="login">Sign in</button>
      <button class="btn ${mode === 'signup' ? 'primary' : ''}" data-mode="signup">Create account</button></div>
      <form class="form" id="authForm">
        <div class="field"><label for="un">Username</label><input type="text" id="un" autocomplete="username" required minlength="3" maxlength="24"></div>
        ${mode === 'signup' ? '<div class="field"><label for="dn">Display name</label><input type="text" id="dn" maxlength="40" placeholder="How people will see you (optional)"></div>' : ''}
        <div class="field"><label for="pw">Password</label><input type="password" id="pw" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required minlength="6">
        ${mode === 'signup' ? '<span class="hint">At least 6 characters.</span>' : ''}</div>
        <button class="btn primary">${mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <span class="error" id="authErr"></span>
      </form>
      <p class="muted small">One account lets you download apps, write reviews, and publish your own apps as a developer.</p></div></div>`)) return;
    view.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => { mode = b.dataset.mode; draw(); }; });
    $('#authForm').onsubmit = async (e) => {
      e.preventDefault();
      const body = { username: $('#un').value, password: $('#pw').value };
      if (mode === 'signup') body.displayName = $('#dn').value;
      try {
        ({ user: me } = await api('POST', mode === 'login' ? '/api/auth/login' : '/api/auth/signup', body));
        toast(mode === 'login' ? `Welcome back, ${me.displayName}` : `Welcome, ${me.displayName}!`);
        location.hash = next || '#/';
      } catch (err) { $('#authErr').textContent = err.message; }
    };
    $('#un').focus();
  };
  draw();
}

async function pageDev(seq) {
  updateNav('dev');
  if (!me) return setView(seq, `<h1>Developer</h1>${needSignIn('Anyone can be a developer. Sign in to publish your apps to the store.')}`);
  const { apps } = await api('GET', '/api/dev/apps');
  const totals = apps.reduce((t, a) => ({ installs: t.installs + a.installs, opens: t.opens + a.opens }), { installs: 0, opens: 0 });
  setView(seq, `
    <div class="section-head"><div><h1>Developer dashboard</h1><p class="muted" style="margin:4px 0 0">Publishing as <b>${esc(me.displayName)}</b></p></div>
      <a class="btn primary" href="#/dev/new">+ Publish new app</a></div>
    <div class="stats" style="margin-top:8px">
      <div class="stat"><b>${apps.length}</b><span>Apps</span></div>
      <div class="stat"><b>${fmtNum(totals.installs)}</b><span>Downloads</span></div>
      <div class="stat"><b>${fmtNum(totals.opens)}</b><span>Opens</span></div>
    </div>
    <div class="section">${apps.length ? `<div class="panel" style="padding:4px 4px">${apps.map((a) => `
      <div class="dev-row">${iconHTML(a.icon, 'sm')}
        <div class="info"><b>${esc(a.name)}</b> <span class="muted small">v${esc(a.version)} · ${esc(a.category)}</span>
          <div class="nums"><span>⬇ ${fmtNum(a.installs)}</span><span>▶ ${fmtNum(a.opens)}</span><span>★ ${a.rating.count ? a.rating.avg.toFixed(1) + ` (${a.rating.count})` : '—'}</span></div></div>
        <a class="btn sm" href="#/app/${esc(a.id)}">Store page</a>
        <a class="btn sm primary" href="#/dev/edit/${esc(a.id)}">Edit / Update</a>
      </div>`).join('')}</div>`
    : `<div class="empty"><div class="big">🛠️</div><p>You haven’t published any apps yet.</p><a class="btn primary" href="#/dev/new">Publish your first app</a></div>`}</div>
    <div class="section"><div class="panel"><h2 style="font-size:17px">How publishing works</h2>
      <ul class="muted" style="margin:10px 0 0;padding-left:20px">
        <li>An app is a single <b>.html</b> file — put your HTML, CSS and JavaScript all in it (up to 2 MB). Images can be embedded as data URLs.</li>
        <li>People get your app from the store and use it right there — no installs or developer mode on their device.</li>
        <li><code>localStorage</code> works as normal and is saved per user, per app.</li>
        <li>Apps run in a secure sandbox: they can’t access people’s accounts or other apps.</li>
        <li>Ship updates any time by releasing a new version. Everyone gets it the next time they open your app.</li>
      </ul></div></div>`);
}

const STARTER = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>My App</title>
  <style>
    body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #eef2ff; }
    .box { text-align: center; }
    button { font-size: 20px; padding: 12px 28px; border: 0; border-radius: 12px; background: #4f46e5; color: white; cursor: pointer; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Hello from my app 👋</h1>
    <p>You clicked <b id="count">0</b> times.</p>
    <button id="btn">Click me</button>
  </div>
  <script>
    // localStorage works inside the store — it's saved for each user.
    let count = Number(localStorage.getItem('clicks')) || 0;
    const el = document.getElementById('count');
    el.textContent = count;
    document.getElementById('btn').onclick = () => {
      count++;
      el.textContent = count;
      localStorage.setItem('clicks', count);
    };
  <\/script>
</body>
</html>
`;

function bumpVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || '');
  return m ? `${m[1]}.${m[2]}.${+m[3] + 1}` : '';
}

function listingFields(app = {}) {
  const icon = app.icon || { type: 'emoji', emoji: '✨', bg: '#6366f1' };
  return `
    <div class="field"><label for="f-name">App name</label><input type="text" id="f-name" maxlength="40" required value="${esc(app.name)}"></div>
    <div class="field"><label for="f-tag">Tagline</label><input type="text" id="f-tag" maxlength="80" placeholder="One short line about your app" value="${esc(app.tagline)}"></div>
    <div class="field"><label for="f-cat">Category</label><select id="f-cat">${categories.map((c) => `<option ${c === app.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
    <div class="field"><label>Icon</label>
      <div class="icon-edit">
        <div id="iconPreview">${iconHTML(icon)}</div>
        <input type="text" class="input emoji-in" id="f-emoji" maxlength="16" value="${esc(icon.type === 'emoji' ? icon.emoji : '✨')}" aria-label="Icon emoji">
        <input type="color" id="f-bg" value="${esc(icon.bg)}" aria-label="Icon background color">
        <label class="btn sm">Upload image<input type="file" id="f-iconfile" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label>
      </div>
      <span class="hint">Type an emoji and pick a background color, or upload a square image.</span></div>
    <div class="field"><label for="f-desc">Description</label><textarea id="f-desc" rows="5" maxlength="4000" placeholder="What does your app do? Who is it for?">${esc(app.description)}</textarea></div>`;
}

function wireListing(root, initialIcon) {
  let icon = initialIcon || { type: 'emoji', emoji: '✨', bg: '#6366f1' };
  const redraw = () => { $('#iconPreview', root).innerHTML = iconHTML(icon); };
  $('#f-emoji', root).oninput = (e) => { icon = { type: 'emoji', emoji: e.target.value || '✨', bg: icon.bg }; redraw(); };
  $('#f-bg', root).oninput = (e) => { icon = { ...icon, bg: e.target.value }; redraw(); };
  $('#f-iconfile', root).onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { icon = { type: 'image', data: await shrinkImage(file), bg: icon.bg }; redraw(); }
    catch { toast('Could not read that image'); }
  };
  return () => ({
    name: $('#f-name', root).value, tagline: $('#f-tag', root).value, category: $('#f-cat', root).value,
    description: $('#f-desc', root).value, icon,
  });
}

function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const size = 256;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      const s = Math.min(img.width, img.height);
      g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      let data = c.toDataURL('image/png');
      if (data.length > 200 * 1024) data = c.toDataURL('image/jpeg', 0.85);
      URL.revokeObjectURL(img.src);
      resolve(data);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function codeFields({ version = '1.0.0', notes = '', html = '', isUpdate = false } = {}) {
  return `
    <div class="row">
      <div class="field" style="max-width:180px"><label for="f-ver">Version</label><input type="text" id="f-ver" maxlength="20" value="${esc(version)}" required></div>
      <div class="field"><label for="f-notes">${isUpdate ? 'What’s new in this version' : 'Release notes'}</label><input type="text" id="f-notes" maxlength="1000" value="${esc(notes)}" placeholder="${isUpdate ? 'Bug fixes and improvements' : 'First release'}"></div>
    </div>
    <div class="field"><label for="f-code">App code (HTML)</label>
      <div class="row">
        <label class="btn sm">Upload .html file<input type="file" id="f-file" accept=".html,.htm,text/html" hidden></label>
        ${isUpdate ? '' : '<button type="button" class="btn sm" id="f-starter">Use starter template</button>'}
        <button type="button" class="btn sm" id="f-preview">▶ Preview</button>
        <span class="muted small" id="f-size"></span>
      </div>
      <textarea class="code" id="f-code" spellcheck="false" placeholder="Paste your app’s HTML here, or upload a file.">${esc(html)}</textarea>
      <span class="hint">Your whole app in one HTML file (inline CSS & JS). Max 2 MB.</span></div>`;
}

function wireCode(root, getMeta) {
  const ta = $('#f-code', root);
  const size = () => { $('#f-size', root).textContent = ta.value ? fmtSize(new Blob([ta.value]).size) : ''; };
  ta.oninput = size;
  ta.onkeydown = (e) => {
    if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); }
  };
  $('#f-file', root).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { toast('That file is over 2 MB'); return; }
    ta.value = await f.text();
    size();
    toast(`Loaded ${f.name}`);
  };
  const starter = $('#f-starter', root);
  if (starter) starter.onclick = () => {
    if (ta.value.trim() && !confirm('Replace the current code with the starter template?')) return;
    ta.value = STARTER;
    size();
  };
  $('#f-preview', root).onclick = () => {
    if (!ta.value.trim()) { toast('Add some code first'); return; }
    const m = getMeta();
    mountPlayer({ name: `Preview · ${m.name || 'Untitled'}`, icon: m.icon, html: ta.value, storageKey: `appdata:preview:${me.id}` });
  };
  size();
}

async function pageDevNew(seq) {
  updateNav('dev');
  if (!me) return setView(seq, `<h1>Publish an app</h1>${needSignIn('Sign in to publish apps.')}`);
  if (!setView(seq, `
    <a href="#/dev" class="muted">‹ Developer dashboard</a>
    <h1 style="margin:8px 0 18px">Publish a new app</h1>
    <form class="form" id="newForm">
      <div class="panel form">${listingFields()}</div>
      <div class="panel form">${codeFields()}</div>
      <div class="row"><button class="btn primary" type="submit" id="pubBtn">Publish to store</button><span class="error" id="formErr"></span></div>
    </form>`)) return;
  const form = $('#newForm');
  const getMeta = wireListing(form);
  wireCode(form, getMeta);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#pubBtn');
    btn.disabled = true;
    $('#formErr').textContent = '';
    try {
      const { app } = await api('POST', '/api/apps', {
        ...getMeta(), version: $('#f-ver').value, notes: $('#f-notes').value || 'First release', html: $('#f-code').value,
      });
      toast(`${app.name} is live in the store!`);
      location.hash = `#/app/${enc(app.id)}`;
    } catch (err) { $('#formErr').textContent = err.message; btn.disabled = false; }
  };
}

async function pageDevEdit(seq, id) {
  updateNav('dev');
  if (!me) return setView(seq, `<h1>Edit app</h1>${needSignIn('Sign in to manage your apps.')}`);
  const [{ app }, code] = await Promise.all([api('GET', `/api/apps/${enc(id)}`), api('GET', `/api/dev/apps/${enc(id)}/code`)]);
  if (!setView(seq, `
    <a href="#/dev" class="muted">‹ Developer dashboard</a>
    <div class="row" style="margin:8px 0 18px">${iconHTML(app.icon, 'sm')}<h1>${esc(app.name)}</h1><span class="muted">v${esc(app.version)}</span>
      <a class="btn sm" href="#/app/${esc(app.id)}" style="margin-left:auto">View in store</a></div>
    <div class="section-head"><h2>Store listing</h2></div>
    <form class="panel form" id="listingForm">${listingFields(app)}
      <div class="row"><button class="btn primary" type="submit">Save listing</button><span class="error" id="listErr"></span></div></form>
    <div class="section"><div class="section-head"><h2>Release a new version</h2></div>
    <form class="panel form" id="codeForm">
      <p class="muted" style="margin:0">Edit your code below (it starts as version ${esc(app.version)}) or upload a new file, then publish the update.</p>
      ${codeFields({ version: bumpVersion(app.version), html: code.html, isUpdate: true })}
      <div class="row"><button class="btn primary" type="submit" id="relBtn">Publish update</button><span class="error" id="codeErr"></span></div></form></div>
    <div class="section"><div class="section-head"><h2>Danger zone</h2></div>
    <div class="panel row"><div style="flex:1">Remove this app from the store for everyone. This can’t be undone.</div>
      <button class="btn danger" id="delApp">Delete app</button></div></div>`)) return;

  const listingForm = $('#listingForm');
  const getMeta = wireListing(listingForm, app.icon);
  listingForm.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('PUT', `/api/apps/${enc(app.id)}`, getMeta()); toast('Listing saved'); route(); }
    catch (err) { $('#listErr').textContent = err.message; }
  };
  const codeForm = $('#codeForm');
  wireCode(codeForm, getMeta);
  codeForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#relBtn');
    btn.disabled = true;
    try {
      const { app: updated } = await api('PUT', `/api/apps/${enc(app.id)}`, {
        version: $('#f-ver').value, notes: $('#f-notes').value || 'Bug fixes and improvements', html: $('#f-code').value,
      });
      toast(`Version ${updated.version} is live!`);
      route();
    } catch (err) { $('#codeErr').textContent = err.message; btn.disabled = false; }
  };
  $('#delApp').onclick = async () => {
    if (!confirm(`Delete “${app.name}” from the store? Everyone who downloaded it will lose it.`)) return;
    await api('DELETE', `/api/apps/${enc(app.id)}`);
    toast('App deleted');
    location.hash = '#/dev';
  };
}

// ---------- router ----------

async function route() {
  const seq = ++renderSeq;
  if (activePlayer) activePlayer.destroy();
  const raw = location.hash.slice(1) || '/';
  const [path, qs = ''] = raw.split('?');
  const query = new URLSearchParams(qs);
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  $('#searchInput').value = parts[0] === 'browse' ? query.get('q') || '' : '';
  window.scrollTo(0, 0);
  try {
    switch (parts[0]) {
      case undefined: return await pageDiscover(seq);
      case 'browse': return await pageBrowse(seq, Object.fromEntries(query));
      case 'category': return await pageBrowse(seq, { category: parts[1], sort: query.get('sort') });
      case 'app': return await pageApp(seq, parts[1]);
      case 'play': return await pagePlay(seq, parts[1]);
      case 'library': return await pageLibrary(seq);
      case 'account': return await pageAccount(seq, query.get('next'));
      case 'dev':
        if (parts[1] === 'new') return await pageDevNew(seq);
        if (parts[1] === 'edit') return await pageDevEdit(seq, parts[2]);
        return await pageDev(seq);
      default:
        setView(seq, '<div class="empty"><div class="big">🤷</div><p>Page not found.</p><a class="btn primary" href="#/">Go to the store</a></div>');
    }
  } catch (err) {
    setView(seq, `<div class="empty"><div class="big">⚠️</div><p>${esc(err.status === 404 ? 'That app doesn’t exist (it may have been removed).' : err.message)}</p>
      <a class="btn primary" href="#/">Back to the store</a></div>`);
  }
}

$('#searchForm').onsubmit = (e) => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  location.hash = q ? `#/browse?q=${enc(q)}` : '#/browse';
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.home-app')) e.target.click();
  if (e.key === 'Escape' && activePlayer) $('.player [data-close]').click();
});

window.addEventListener('hashchange', route);

(async function init() {
  try {
    const [m, c] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/categories')]);
    me = m.user;
    categories = c.categories;
  } catch { /* offline — route() will show the error */ }
  route();
})();
