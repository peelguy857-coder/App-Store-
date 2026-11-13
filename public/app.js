'use strict';
/* App Store front end: a single-page app with hash routing. */

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
let me = null;
let categories = [];
let renderSeq = 0;
let activePlayer = null;

const CAT_STYLE = {
  Games: ['🎮', '#5e5ce6'], Productivity: ['✅', '#0a84ff'], Utilities: ['🧰', '#636366'], Education: ['🎓', '#ff9f0a'],
  Creativity: ['🎨', '#ff375f'], Lifestyle: ['🌿', '#30a46c'], Social: ['💬', '#00a5c8'], Other: ['✨', '#a2845e'],
};

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;

async function api(method, path, body) {
  const opts = { method, headers: { 'X-Store-Client': '1' }, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) { const e = new Error(data.error || `Something went wrong (${res.status})`); e.status = res.status; throw e; }
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

const fmtNum = (n) => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n);
const fmtSize = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B';
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
  return fmtDate(iso);
}

function rgb(hex) { const n = parseInt((hex || '#6366f1').slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function shade(hex, amt) {
  const [r, g, b] = rgb(hex).map((c) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt));
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}
function isLight(hex) { const [r, g, b] = rgb(hex); return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.66; }

function avatarHTML(user, cls = '') {
  if (!user) {
    return `<div class="avatar anon ${cls}"><svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></div>`;
  }
  let h = 0;
  for (const c of user.username) h = (h * 31 + c.charCodeAt(0)) % 360;
  const letter = [...(user.displayName || user.username)][0] || '?';
  return `<div class="avatar ${cls}" style="background:hsl(${h} 62% 50%)">${esc(letter)}</div>`;
}

function iconHTML(icon, cls = '') {
  icon = icon || { type: 'emoji', emoji: '✨', bg: '#6366f1' };
  const inner = icon.type === 'image' ? `<img src="${esc(icon.data)}" alt="">` : esc(icon.emoji);
  const bg = icon.type === 'image' ? icon.bg : `linear-gradient(160deg, ${shade(icon.bg, 0.12)}, ${shade(icon.bg, -0.12)})`;
  return `<div class="icon ${cls}" style="background:${esc(bg)}">${inner}</div>`;
}

const STAR = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2.8l2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 17l-5.8 3.3 1.4-6.4L2.7 9.5l6.5-.7z"/></svg>';
function starsHTML(avg) {
  const full = Math.round(avg);
  return `<span class="stars" aria-label="${avg} out of 5 stars">${'★'.repeat(full)}<span style="opacity:.3">${'★'.repeat(5 - full)}</span></span>`;
}

function getButton(app, extraClass = '') {
  if (app.installed) return `<button class="get open ${extraClass}" data-act="open" data-id="${esc(app.id)}">Open</button>`;
  return `<button class="get ${extraClass}" data-act="get" data-id="${esc(app.id)}">Get</button>`;
}

function rowItem(app, rank) {
  const sub = rank != null || !app.rating.count ? esc(app.tagline || app.category) : `${starsHTML(app.rating.avg)} <span>${app.rating.count}</span>`;
  return `<div class="row-item" data-act="view" data-id="${esc(app.id)}" role="link" tabindex="0">
    ${iconHTML(app.icon)}
    ${rank != null ? `<div class="rank">${rank}</div>` : ''}
    <div class="txt"><b>${esc(app.name)}</b><span>${sub}</span><span>${esc(app.category)}</span></div>
    <div class="get-wrap">${getButton(app)}</div>
  </div>`;
}

function tile(app) {
  return `<div class="tile" data-act="view" data-id="${esc(app.id)}" role="link" tabindex="0">
    ${iconHTML(app.icon)}<b>${esc(app.name)}</b><span>${esc(app.category)}</span></div>`;
}

function featureCard(app, eyebrow) {
  const bg = app.icon && app.icon.bg ? app.icon.bg : '#0b6bf2';
  const light = isLight(bg);
  const style = `--tint:${shade(bg, 0.08)};--tint-2:${shade(bg, -0.38)};--fg:${light ? '#1d1d1f' : '#ffffff'}`;
  return `<a class="feature ${light ? 'light-tint' : ''}" href="#/app/${esc(app.id)}" style="${style}">
    <div class="f-top"><div class="f-eyebrow">${esc(eyebrow)}</div><h2>${esc(app.name)}</h2><p class="f-tag">${esc(app.tagline || app.category)}</p></div>
    <div class="f-art">${iconHTML(app.icon, 'xl')}</div>
    <div class="f-foot">${iconHTML(app.icon, 'xs')}<div class="txt"><b>${esc(app.name)}</b><span>${esc(app.category)}</span></div>${getButton(app, 'on-tint')}</div>
  </a>`;
}

const listHTML = (apps) => `<div class="list">${apps.map((a) => rowItem(a)).join('')}</div>`;

function emptyHTML(art, title, text, action = '') {
  return `<div class="empty"><div class="art">${art}</div><h2>${esc(title)}</h2><p>${esc(text)}</p>${action}</div>`;
}

function largeTitle(title, eyebrow = '') {
  return `<div class="large-title"><div>${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}<h1>${esc(title)}</h1></div>
    <a class="avatar-link" href="#/account" aria-label="Account">${avatarHTML(me)}</a></div>`;
}

function needSignIn(art, title, text) {
  return emptyHTML(art, title, text, `<a class="btn primary" href="#/account?next=${enc(location.hash)}">Sign in or create account</a>`);
}

function setView(seq, html) {
  if (seq !== renderSeq) return false;
  view.innerHTML = html;
  view.style.animation = 'none';
  void view.offsetWidth;
  view.style.animation = '';
  return true;
}

function updateChrome(section) {
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === section));
  $('#accountBtn').innerHTML = avatarHTML(me);
  $('#accountBtn').title = me ? `${me.displayName} (@${me.username})` : 'Sign in';
}

// ---------- get / open ----------

async function install(id, btn) {
  if (!me) { location.hash = `#/account?next=${enc(location.hash)}`; toast('Sign in to get apps'); return false; }
  if (btn) { btn.disabled = true; btn.textContent = '•••'; }
  try {
    await api('POST', `/api/apps/${enc(id)}/install`);
    toast('Added to My Apps');
    document.querySelectorAll(`[data-act="get"][data-id="${CSS.escape(id)}"]`).forEach((b) => {
      b.disabled = false; b.textContent = 'Open'; b.dataset.act = 'open'; b.classList.add('open');
    });
    if (location.hash.startsWith('#/app/')) route(true);
    return true;
  } catch (e) {
    toast(e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Get'; }
    return false;
  }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  const id = el.dataset.id;
  if (el.dataset.act === 'get') install(id, el);
  else if (el.dataset.act === 'open') location.hash = `#/play/${enc(id)}`;
  else if (el.dataset.act === 'view') location.hash = `#/app/${enc(id)}`;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-act="view"], .home-app')) e.target.click();
  if (e.key === 'Escape' && activePlayer) $('.player [data-close]').click();
});

// ---------- the in-store app player ----------
// Apps run in a sandboxed iframe with no origin of their own, so they can't
// reach the store, anyone's account, or other apps. Opaque origins have no
// localStorage, so a small shim gives each app its own, saved by the store.

function safeJSON(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));
}

function storageShim(snapshot) {
  return '<script>(function(){var d=' + safeJSON(snapshot) + ',H=Object.prototype.hasOwnProperty;' +
  'function P(){try{parent.postMessage({__appstore:"storage",data:d},"*")}catch(e){}}' +
  'function mk(o,p){var api={getItem:function(k){k=String(k);return H.call(o,k)?o[k]:null},setItem:function(k,v){o[String(k)]=String(v);if(p)P()},removeItem:function(k){delete o[String(k)];if(p)P()},clear:function(){for(var k in o)delete o[k];if(p)P()},key:function(i){var k=Object.keys(o)[i];return k===undefined?null:k}};' +
  'return new Proxy(api,{get:function(t,k){if(k==="length")return Object.keys(o).length;if(k in t)return t[k];if(typeof k==="symbol")return undefined;return api.getItem(k)},set:function(t,k,v){api.setItem(k,v);return true},deleteProperty:function(t,k){api.removeItem(k);return true},has:function(t,k){return k in t||H.call(o,k)},ownKeys:function(){return Object.keys(o)},getOwnPropertyDescriptor:function(t,k){if(H.call(o,k))return{value:o[k],enumerable:true,configurable:true,writable:true}}})}' +
  'var L=mk(d,true),S=mk({},false);' +
  'try{Object.defineProperty(window,"localStorage",{configurable:true,get:function(){return L}})}catch(e){}' +
  'try{Object.defineProperty(window,"sessionStorage",{configurable:true,get:function(){return S}})}catch(e){}' +
  '})();<\/script>';
}

function injectShim(html, snapshot) {
  const shim = storageShim(snapshot);
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + shim + html.slice(m.index + m[0].length);
  }
  return shim + html;
}

const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads';

function readAppData(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; }
}

function mountPlayer({ name, icon, html, storageKey, onClose, buttons = '' }) {
  if (activePlayer) activePlayer.destroy();
  const wrap = document.createElement('div');
  wrap.className = 'player';
  wrap.innerHTML = `<div class="player-bar">
      <button class="pbtn" data-close>Done</button>
      <div class="title">${iconHTML(icon, 'xs')}<span>${esc(name)}</span></div>
      ${buttons}
      <button class="pbtn" data-reload title="Restart app" aria-label="Restart app">↻</button>
    </div>
    <iframe title="${esc(name)}" sandbox="${SANDBOX}" allow="fullscreen; autoplay; clipboard-write; gamepad" allowfullscreen></iframe>`;
  document.body.appendChild(wrap);
  document.body.style.overflow = 'hidden';
  const frame = $('iframe', wrap);
  let saveTimer = null;
  let pending = null;
  const flush = () => {
    clearTimeout(saveTimer);
    if (pending === null) return;
    try { localStorage.setItem(storageKey, JSON.stringify(pending)); } catch { toast('This app saved too much data on this device'); }
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
  window.addEventListener('pagehide', flush);
  const handle = {
    destroy() {
      flush();
      window.removeEventListener('message', onMessage);
      window.removeEventListener('pagehide', flush);
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

// ---------- Discover ----------

async function pageDiscover(seq) {
  updateChrome('discover');
  const { apps } = await api('GET', '/api/apps?sort=popular');
  const byNew = [...apps].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const byRating = apps.filter((a) => a.rating.count).sort((a, b) => b.rating.avg - a.rating.avg || b.rating.count - a.rating.count);
  const featured = [];
  if (apps[0]) featured.push([apps[0], 'Most popular']);
  const fresh = byNew.find((a) => !featured.some(([f]) => f.id === a.id));
  if (fresh) featured.push([fresh, 'New this week']);
  const date = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  if (!apps.length) {
    setView(seq, largeTitle('Discover', date) + emptyHTML('🛍️', 'The store is empty', 'No one has published an app yet. Be the first!', '<a class="btn primary" href="#/dev/new">Publish an app</a>'));
    return;
  }
  setView(seq, `
    ${largeTitle('Discover', date)}
    <div class="features">${featured.map(([a, e]) => featureCard(a, e)).join('')}</div>
    <div class="section"><div class="pills">${categories.map((c) => `<a class="pill" href="#/category/${enc(c)}">${CAT_STYLE[c] ? CAT_STYLE[c][0] : ''} ${esc(c)}</a>`).join('')}</div></div>
    <div class="section"><div class="section-head"><div><h2>Top Charts</h2><p>Most downloaded right now</p></div><a class="see-all" href="#/browse?sort=popular">See All</a></div>
      <div class="charts">${apps.slice(0, 9).map((a, i) => rowItem(a, i + 1)).join('')}</div></div>
    <div class="section"><div class="section-head"><div><h2>New & Noteworthy</h2><p>Fresh from developers</p></div><a class="see-all" href="#/browse?sort=new">See All</a></div>
      <div class="shelf">${byNew.slice(0, 12).map(tile).join('')}</div></div>
    ${byRating.length ? `<div class="section"><div class="section-head"><div><h2>Loved by people</h2><p>The highest-rated apps</p></div><a class="see-all" href="#/browse?sort=rating">See All</a></div>
      ${listHTML(byRating.slice(0, 6))}</div>` : ''}
    <div class="callout">
      <div class="art">${apps.slice(0, 3).map((a) => iconHTML(a.icon)).join('')}</div>
      <div><h2>Made something? Put it in the store.</h2>
      <p>Anyone can be a developer. Upload an HTML app and people can find it, get it, and use it right here, with nothing to install.</p></div>
      <a class="btn primary" href="#/dev/new">Publish an app</a>
    </div>`);
}

// ---------- Search & browse ----------

async function pageSearch(seq, q) {
  updateChrome('search');
  let results = '';
  if (q) {
    const { apps } = await api('GET', `/api/apps?q=${enc(q)}`);
    results = apps.length ? `<p class="muted small" style="margin:-8px 0 8px">${apps.length} result${apps.length === 1 ? '' : 's'}</p>${listHTML(apps)}`
      : emptyHTML('🔍', 'No results', `Nothing matched “${q}”. Try different words.`);
  }
  if (!setView(seq, `
    ${largeTitle('Search')}
    <form class="bigsearch" id="bigSearch" role="search">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="m20 20-3.6-3.6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
      <input id="bigSearchInput" type="search" placeholder="Apps, games, developers" value="${esc(q)}" aria-label="Search apps" autocomplete="off">
    </form>
    ${results || `<div class="section-head plain"><h2>Browse categories</h2></div>
      <div class="cat-grid">${categories.map((c) => { const [e, col] = CAT_STYLE[c] || ['✨', '#636366'];
        return `<a class="cat-card" href="#/category/${enc(c)}" style="background:linear-gradient(140deg, ${shade(col, 0.1)}, ${shade(col, -0.25)})"><span class="e">${e}</span>${esc(c)}</a>`; }).join('')}</div>`}`)) return;
  const input = $('#bigSearchInput');
  $('#bigSearch').onsubmit = (e) => { e.preventDefault(); location.hash = `#/search?q=${enc(input.value.trim())}`; };
  if (!q && window.matchMedia('(min-width: 761px)').matches) input.focus();
}

async function pageBrowse(seq, { category = '', sort, developer = '' }) {
  updateChrome('discover');
  sort = sort || 'popular';
  const { apps } = await api('GET', `/api/apps?${new URLSearchParams({ category, sort, developer })}`);
  let title = 'All Apps';
  if (category) title = category;
  else if (developer) title = apps[0] ? apps[0].developer.name : 'Developer';
  const sorts = [['popular', 'Popular'], ['new', 'Newest'], ['rating', 'Top Rated'], ['updated', 'Updated'], ['name', 'A–Z']];
  const base = new URLSearchParams();
  if (developer) base.set('developer', developer);
  if (!setView(seq, `
    ${largeTitle(title, developer ? 'Developer' : category ? 'Category' : '')}
    ${!developer ? `<div class="pills" style="margin-bottom:14px"><a class="pill ${!category ? 'on' : ''}" href="#/browse?sort=${enc(sort)}">All</a>
      ${categories.map((c) => `<a class="pill ${c === category ? 'on' : ''}" href="#/category/${enc(c)}?sort=${enc(sort)}">${esc(c)}</a>`).join('')}</div>` : ''}
    <div class="row" style="justify-content:space-between;margin-bottom:6px">
      <span class="muted small">${apps.length} app${apps.length === 1 ? '' : 's'}</span>
      <select class="input" id="sortSel" style="width:auto;height:36px;padding:0 12px;font-size:14px" aria-label="Sort">
        ${sorts.map(([v, l]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    ${apps.length ? listHTML(apps) : emptyHTML('🗂️', 'Nothing here yet', 'No apps in this category yet.')}`)) return;
  $('#sortSel').onchange = (e) => {
    const p = new URLSearchParams(base);
    p.set('sort', e.target.value);
    location.hash = category ? `#/category/${enc(category)}?${p}` : `#/browse?${p}`;
  };
}

// ---------- App page ----------

async function pageApp(seq, id) {
  updateChrome('discover');
  const { app } = await api('GET', `/api/apps/${enc(id)}`);
  const r = app.rating;
  const hist = [5, 4, 3, 2, 1].map((n) => app.reviews.filter((x) => x.rating === n).length);
  const maxH = Math.max(1, ...hist);
  const [catEmoji] = CAT_STYLE[app.category] || ['✨'];

  let reviewForm = '';
  if (!me) reviewForm = `<p class="muted" style="margin-top:14px"><a href="#/account?next=${enc(location.hash)}" style="color:var(--accent)">Sign in</a> to rate and review this app.</p>`;
  else if (!app.isOwner) {
    const mine = app.myReview;
    reviewForm = `<form class="write-review form" id="reviewForm">
      <div class="row" style="justify-content:space-between"><b>${mine ? 'Your review' : 'Tap to rate'}</b>
        <div class="star-pick" id="starPick">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">${STAR}</button>`).join('')}</div></div>
      <textarea id="reviewText" rows="3" maxlength="1000" placeholder="Tell others what you think (optional)">${esc(mine ? mine.text : '')}</textarea>
      <div class="row"><button class="btn primary sm" type="submit">${mine ? 'Update review' : 'Post review'}</button>
        ${mine ? '<button class="btn ghost sm" type="button" id="delReview" style="color:var(--danger)">Delete</button>' : ''}
        <span class="error" id="reviewErr"></span></div></form>`;
  }

  if (!setView(seq, `
    <div class="app-head">
      ${iconHTML(app.icon, 'lg')}
      <div class="meta">
        <h1>${esc(app.name)}</h1>
        <div class="tagline">${esc(app.tagline)}</div>
        <a class="dev" href="#/browse?developer=${enc(app.developer.id || '')}">${esc(app.developer.name)}</a>
        <div class="app-actions">
          ${app.installed ? `<button class="get open" data-act="open" data-id="${esc(app.id)}">Open</button>`
            : `<button class="get" data-act="get" data-id="${esc(app.id)}">Get</button><button class="btn sm" data-act="open" data-id="${esc(app.id)}">Try it</button>`}
          <a class="icon-action" href="/download/${esc(app.id)}" download title="Download the app’s file" aria-label="Download"><svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
          ${app.isOwner ? `<a class="btn sm" href="#/dev/edit/${esc(app.id)}">Edit app</a>` : ''}
        </div>
      </div>
    </div>

    <div class="info-strip">
      <div><span class="cap">${r.count} Rating${r.count === 1 ? '' : 's'}</span><b>${r.count ? r.avg.toFixed(1) : '—'}</b><span class="sub">${r.count ? starsHTML(r.avg) : 'Not rated yet'}</span></div>
      <div><span class="cap">Downloads</span><b>${fmtNum(app.installs)}</b><span class="sub">people</span></div>
      <div><span class="cap">Category</span><b>${catEmoji}</b><span class="sub">${esc(app.category)}</span></div>
      <div><span class="cap">Developer</span><b>👤</b><span class="sub">${esc(app.developer.name)}</span></div>
      <div><span class="cap">Size</span><b>${fmtSize(app.size).split(' ')[0]}</b><span class="sub">${fmtSize(app.size).split(' ')[1]}</span></div>
      <div><span class="cap">Opens</span><b>${fmtNum(app.opens)}</b><span class="sub">times</span></div>
    </div>

    <div class="section"><div class="preview-row">
      <div class="phone" aria-label="Live preview"><div class="notch"></div><div class="screen"><iframe id="previewFrame" title="Preview of ${esc(app.name)}" sandbox="allow-scripts" tabindex="-1"></iframe></div></div>
      <div class="preview-text">
        <div class="section-head plain"><h2>About this app</h2></div>
        <div class="prose">${esc(app.description || 'The developer hasn’t added a description yet.')}</div>
        <p class="muted small" style="margin-top:18px">The preview on the left is the real app running. Tap ${app.installed ? 'Open' : 'Get'} to use it full screen.</p>
      </div>
    </div></div>

    <div class="section"><div class="section-head"><h2>Ratings & Reviews</h2></div>
      <div class="ratings">
        <div><div class="big">${r.count ? r.avg.toFixed(1) : '—'}</div><div class="outof">out of 5</div></div>
        <div class="hist">${hist.map((n, i) => `<div><span class="lbl">${'★'.repeat(5 - i)}</span><span class="bar"><i style="width:${(n / maxH) * 100}%"></i></span></div>`).join('')}</div>
        <div class="count">${r.count} rating${r.count === 1 ? '' : 's'}</div>
      </div>
      ${app.reviews.length ? `<div class="reviews">${app.reviews.map((rv) => `<div class="review">
        <div class="rh"><b>${esc(rv.user ? rv.user.displayName : 'Someone')}</b><span>${ago(rv.updatedAt)}</span></div>
        ${starsHTML(rv.rating)}${rv.text ? `<p>${esc(rv.text)}</p>` : ''}</div>`).join('')}</div>` : ''}
      ${reviewForm}
    </div>

    <div class="section"><div class="section-head"><h2>What’s New</h2><span class="muted small">Version History</span></div>
      <ul class="versions">${app.versions.map((v) => `<li><div class="vh"><b>Version ${esc(v.version)}</b><span>${fmtDate(v.createdAt)}</span></div><div class="prose" style="margin-top:4px">${esc(v.notes)}</div></li>`).join('')}</ul></div>

    <div class="section"><div class="section-head"><h2>Information</h2></div>
      <dl class="info-table">
        <div><dt>Developer</dt><dd>${esc(app.developer.name)}</dd></div>
        <div><dt>Category</dt><dd>${esc(app.category)}</dd></div>
        <div><dt>Size</dt><dd>${fmtSize(app.size)}</dd></div>
        <div><dt>Version</dt><dd>${esc(app.version)}</dd></div>
        <div><dt>Released</dt><dd>${fmtDate(app.createdAt)}</dd></div>
        <div><dt>Updated</dt><dd>${fmtDate(app.updatedAt)}</dd></div>
      </dl></div>`)) return;

  // Live preview (doesn't count as an open, and doesn't save anything).
  fetch(`/run/${enc(app.id)}?preview=1`).then((res) => res.ok ? res.text() : '').then((html) => {
    const f = $('#previewFrame');
    if (f && html) f.srcdoc = injectShim(html, {});
  }).catch(() => {});

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
        route(true);
      } catch (err) { $('#reviewErr').textContent = err.message; }
    };
    const del = $('#delReview');
    if (del) del.onclick = async () => { await api('DELETE', `/api/apps/${enc(app.id)}/reviews`); toast('Review deleted'); route(true); };
  }
}

async function pagePlay(seq, id) {
  const { app } = await api('GET', `/api/apps/${enc(id)}`);
  const res = await fetch(`/run/${enc(id)}`);
  if (!res.ok) throw new Error('This app couldn’t be loaded');
  const html = await res.text();
  if (seq !== renderSeq) return;
  view.innerHTML = '';
  const extra = app.installed || !me ? '' : '<button class="pbtn done" id="playerGet">Get</button>';
  mountPlayer({
    name: app.name, icon: app.icon, html, storageKey: appDataKey(app.id), buttons: extra,
    onClose: () => { if (history.length > 1) history.back(); else location.hash = `#/app/${enc(app.id)}`; },
  });
  const g = $('#playerGet');
  if (g) g.onclick = async () => { if (await install(app.id)) g.remove(); };
}

// ---------- My Apps ----------

async function pageLibrary(seq) {
  updateChrome('library');
  if (!me) return setView(seq, largeTitle('My Apps') + needSignIn('📱', 'Your apps live here', 'Sign in to keep the apps you get, on any device.'));
  const { apps } = await api('GET', '/api/library');
  setView(seq, `${largeTitle('My Apps', `${apps.length} app${apps.length === 1 ? '' : 's'}`)}
    ${apps.length ? `<div class="home-grid">${apps.map((a) => `
      <button class="home-app" data-act="open" data-id="${esc(a.id)}" title="Open ${esc(a.name)}">${iconHTML(a.icon)}<span>${esc(a.name)}</span></button>`).join('')}</div>
      <div class="section"><div class="section-head"><h2>Manage</h2></div>${listHTML(apps)}</div>`
    : emptyHTML('📱', 'No apps yet', 'Apps you get from the store show up here.', '<a class="btn primary" href="#/">Discover apps</a>')}`);
}

// ---------- Account ----------

function strengthOf(pw) {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  return pw.length < 8 ? 1 : Math.max(2, s);
}
const STRENGTH_LABEL = ['', 'Too short', 'Okay', 'Good', 'Strong'];

function passwordField(id, label, autocomplete, withMeter) {
  return `<div><label for="${id}">${label}</label>
    <div class="pw-wrap"><input class="input" type="password" id="${id}" autocomplete="${autocomplete}" required minlength="${withMeter ? 8 : 1}" maxlength="200">
    <button type="button" class="pw-toggle" data-for="${id}">Show</button></div>
    ${withMeter ? `<div class="strength" id="${id}-meter"><i></i><i></i><i></i><i></i></div><span class="hint" id="${id}-hint">At least 8 characters. Longer is stronger.</span>` : ''}</div>`;
}

function wirePasswordFields(root) {
  root.querySelectorAll('.pw-toggle').forEach((b) => {
    b.onclick = () => { const i = $('#' + b.dataset.for, root); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show'; };
  });
  root.querySelectorAll('.strength').forEach((m) => {
    const id = m.id.replace(/-meter$/, '');
    const input = $('#' + id, root);
    input.addEventListener('input', () => {
      const s = strengthOf(input.value);
      m.className = 'strength' + (s ? ' s' + s : '');
      $('#' + id + '-hint', root).textContent = input.value ? STRENGTH_LABEL[s] + (s === 1 ? ': use at least 8 characters' : '') : 'At least 8 characters. Longer is stronger.';
    });
  });
}

async function pageAccount(seq, next, startMode) {
  updateChrome('account');
  if (me) return pageProfile(seq);
  let mode = startMode === 'signup' ? 'signup' : 'login';
  const draw = () => {
    if (!setView(seq, `<div class="auth">
      <img class="logo" src="/icon.svg" alt="">
      <h1>${mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
      <p>${mode === 'login' ? 'Sign in with your username and password.' : 'One account to get apps, write reviews and publish your own.'}</p>
      <div class="segmented" role="tablist">
        <button type="button" class="${mode === 'login' ? 'on' : ''}" data-mode="login" role="tab">Sign In</button>
        <button type="button" class="${mode === 'signup' ? 'on' : ''}" data-mode="signup" role="tab">Create Account</button>
      </div>
      <form id="authForm">
        <div><label for="un">Username</label><input class="input" type="text" id="un" autocomplete="username" autocapitalize="none" spellcheck="false" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_]+" placeholder="e.g. alex_codes"></div>
        ${mode === 'signup' ? '<div><label for="dn">Name</label><input class="input" type="text" id="dn" autocomplete="nickname" maxlength="40" placeholder="Shown on your apps and reviews (optional)"></div>' : ''}
        ${passwordField('pw', 'Password', mode === 'login' ? 'current-password' : 'new-password', mode === 'signup')}
        <label class="check"><input type="checkbox" id="remember" checked> Keep me signed in on this device</label>
        <span class="error" id="authErr"></span>
        <button class="btn primary block" type="submit">${mode === 'login' ? 'Sign In' : 'Create Account'}</button>
      </form>
      <p class="fine">${mode === 'signup' ? 'Usernames use letters, numbers and _. Your password is stored securely and never shown to anyone.' : 'New here? Tap Create Account above.'}</p>
    </div>`)) return;
    view.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => { mode = b.dataset.mode; draw(); }; });
    wirePasswordFields(view);
    $('#authForm').onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('#authForm [type=submit]');
      const body = { username: $('#un').value.trim(), password: $('#pw').value, remember: $('#remember').checked };
      if (mode === 'signup') body.displayName = $('#dn').value.trim();
      btn.disabled = true;
      try {
        ({ user: me } = await api('POST', mode === 'login' ? '/api/auth/login' : '/api/auth/signup', body));
        toast(mode === 'login' ? `Welcome back, ${me.displayName}` : `Welcome, ${me.displayName}!`);
        location.hash = next || '#/';
      } catch (err) { $('#authErr').textContent = err.message; btn.disabled = false; }
    };
    if (window.matchMedia('(min-width: 761px)').matches) $('#un').focus();
  };
  draw();
}

function pageProfile(seq) {
  if (!setView(seq, `${largeTitle('Account')}
    <div class="settings">
      <div class="profile-card">${avatarHTML(me, 'lg')}<div style="min-width:0"><h2>${esc(me.displayName)}</h2><p>@${esc(me.username)}</p>
        ${me.createdAt ? `<p class="small">Member since ${fmtDate(me.createdAt)}</p>` : ''}</div></div>

      <div class="group-title">Quick links</div>
      <div class="link-list">
        <a href="#/library">My Apps <span class="chev">›</span></a>
        <a href="#/dev">Developer dashboard <span class="chev">›</span></a>
      </div>

      <div class="group-title">Profile</div>
      <form class="group form" id="profileForm">
        <div class="field"><label for="dn">Name</label><input type="text" id="dn" maxlength="40" value="${esc(me.displayName)}">
          <span class="hint">Shown as your developer name and on your reviews.</span></div>
        <div class="field"><div class="row"><button class="btn primary sm" type="submit">Save name</button><span class="error" id="profErr"></span></div></div>
      </form>

      <div class="group-title">Password</div>
      <form class="group form" id="pwForm">
        <div class="field">${passwordField('curPw', 'Current password', 'current-password', false)}</div>
        <div class="field">${passwordField('newPw', 'New password', 'new-password', true)}</div>
        <div class="field"><div class="row"><button class="btn primary sm" type="submit">Change password</button><span class="error" id="pwErr"></span></div>
          <span class="hint">Changing your password signs you out on your other devices.</span></div>
      </form>

      <div class="group-title">Sign out</div>
      <div class="link-list">
        <button id="logout" class="danger">Sign out on this device</button>
        <button id="logoutAll" class="danger">Sign out on all devices</button>
      </div>
    </div>`)) return;
  wirePasswordFields(view);
  $('#profileForm').onsubmit = async (e) => {
    e.preventDefault();
    try { ({ user: me } = await api('PUT', '/api/me', { displayName: $('#dn').value })); toast('Name saved'); route(true); }
    catch (err) { $('#profErr').textContent = err.message; }
  };
  $('#pwForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/me/password', { currentPassword: $('#curPw').value, newPassword: $('#newPw').value });
      toast('Password changed');
      route(true);
    } catch (err) { $('#pwErr').textContent = err.message; }
  };
  $('#logout').onclick = async () => { await api('POST', '/api/auth/logout'); me = null; toast('Signed out'); location.hash = '#/'; };
  $('#logoutAll').onclick = async () => { await api('POST', '/api/auth/logout-everywhere'); me = null; toast('Signed out on all devices'); location.hash = '#/'; };
}

// ---------- Developer ----------

async function pageDev(seq) {
  updateChrome('dev');
  if (!me) return setView(seq, largeTitle('Developer') + needSignIn('🛠️', 'Anyone can be a developer', 'Sign in to publish your apps to the store.'));
  const { apps } = await api('GET', '/api/dev/apps');
  const t = apps.reduce((x, a) => ({ i: x.i + a.installs, o: x.o + a.opens }), { i: 0, o: 0 });
  setView(seq, `
    ${largeTitle('Developer', `Publishing as ${me.displayName}`)}
    <div class="stat-tiles">
      <div class="stat-tile"><span>Apps</span><b>${apps.length}</b></div>
      <div class="stat-tile"><span>Downloads</span><b>${fmtNum(t.i)}</b></div>
      <div class="stat-tile"><span>Opens</span><b>${fmtNum(t.o)}</b></div>
    </div>
    <div class="section"><div class="section-head"><h2>Your apps</h2><a class="btn primary sm" href="#/dev/new">+ New app</a></div>
    ${apps.length ? `<div class="dev-apps">${apps.map((a) => `
      <div class="dev-app">${iconHTML(a.icon, 'sm')}
        <div class="txt"><b>${esc(a.name)}</b> <span class="muted small">v${esc(a.version)} · ${esc(a.category)}</span>
          <div class="nums"><span>${fmtNum(a.installs)} downloads</span><span>${fmtNum(a.opens)} opens</span><span>${a.rating.count ? '★ ' + a.rating.avg.toFixed(1) : 'No ratings'}</span></div></div>
        <a class="btn sm" href="#/app/${esc(a.id)}">View</a><a class="btn sm primary" href="#/dev/edit/${esc(a.id)}">Update</a>
      </div>`).join('')}</div>`
    : emptyHTML('🚀', 'Publish your first app', 'It takes a minute. Start from our template if you like.', '<a class="btn primary" href="#/dev/new">Publish an app</a>')}</div>
    <div class="section"><div class="section-head"><h2>How publishing works</h2></div>
      <ol class="steps">
        <li><span><b>Make your app as one .html file</b> with its HTML, CSS and JavaScript inside (up to 2 MB). Embed images as data URLs.</span></li>
        <li><span><b>Publish it here.</b> Give it a name, icon and description, then upload or paste your code. Preview it first if you like.</span></li>
        <li><span><b>People get it and use it in the store.</b> Nothing to install and no developer mode. <code>localStorage</code> works and is kept for each person.</span></li>
        <li><span><b>Ship updates any time</b> with a new version number. Everyone gets it the next time they open your app.</span></li>
      </ol>
      <p class="muted small" style="margin-top:14px">Apps run in a secure sandbox, so they can’t reach anyone’s account or other apps.</p></div>`);
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
    // localStorage works inside the store and is saved for each person.
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
    <div class="field"><span class="label">Icon</span>
      <div class="icon-edit">
        <div id="iconPreview">${iconHTML(icon, 'md')}</div>
        <input type="text" class="input emoji-in" id="f-emoji" maxlength="16" value="${esc(icon.type === 'emoji' ? icon.emoji : '✨')}" aria-label="Icon emoji">
        <input type="color" id="f-bg" value="${esc(icon.bg)}" aria-label="Icon color">
        <label class="btn sm">Upload image<input type="file" id="f-iconfile" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label>
      </div>
      <span class="hint">Type an emoji and pick a color, or upload a square image.</span></div>
    <div class="field"><label for="f-desc">Description</label><textarea id="f-desc" rows="5" maxlength="4000" placeholder="What does your app do? Who is it for?">${esc(app.description)}</textarea></div>`;
}

function wireListing(root, initialIcon) {
  let icon = initialIcon || { type: 'emoji', emoji: '✨', bg: '#6366f1' };
  const redraw = () => { $('#iconPreview', root).innerHTML = iconHTML(icon, 'md'); };
  $('#f-emoji', root).oninput = (e) => { icon = { type: 'emoji', emoji: e.target.value || '✨', bg: icon.bg }; redraw(); };
  $('#f-bg', root).oninput = (e) => { icon = { ...icon, bg: e.target.value }; redraw(); };
  $('#f-iconfile', root).onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { icon = { type: 'image', data: await shrinkImage(file), bg: icon.bg }; redraw(); }
    catch { toast('Couldn’t read that image'); }
  };
  return () => ({ name: $('#f-name', root).value, tagline: $('#f-tag', root).value, category: $('#f-cat', root).value, description: $('#f-desc', root).value, icon });
}

function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
      let data = c.toDataURL('image/png');
      if (data.length > 200 * 1024) data = c.toDataURL('image/jpeg', 0.85);
      URL.revokeObjectURL(img.src);
      resolve(data);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function codeFields({ version = '1.0.0', html = '', isUpdate = false } = {}) {
  return `
    <div class="row">
      <div class="field" style="flex:0 1 160px"><label for="f-ver">Version</label><input type="text" id="f-ver" maxlength="20" value="${esc(version)}" required></div>
      <div class="field"><label for="f-notes">${isUpdate ? 'What’s new' : 'Release notes'}</label><input type="text" id="f-notes" maxlength="1000" placeholder="${isUpdate ? 'Bug fixes and improvements' : 'First release'}"></div>
    </div>
    <div class="field"><label for="f-code">App code (HTML)</label>
      <div class="row">
        <label class="btn sm">Upload .html file<input type="file" id="f-file" accept=".html,.htm,text/html" hidden></label>
        ${isUpdate ? '' : '<button type="button" class="btn sm" id="f-starter">Use starter template</button>'}
        <button type="button" class="btn sm" id="f-preview">▶ Preview</button>
        <span class="muted small" id="f-size"></span>
      </div>
      <textarea class="code" id="f-code" spellcheck="false" placeholder="Paste your app’s HTML here, or upload a file.">${esc(html)}</textarea>
      <span class="hint">Your whole app in one HTML file (CSS and JavaScript inside). Max 2 MB.</span></div>`;
}

function wireCode(root, getMeta) {
  const ta = $('#f-code', root);
  const size = () => { $('#f-size', root).textContent = ta.value ? fmtSize(new Blob([ta.value]).size) : ''; };
  ta.oninput = size;
  ta.onkeydown = (e) => { if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); } };
  $('#f-file', root).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { toast('That file is over 2 MB'); return; }
    ta.value = await f.text();
    size();
    toast(`Loaded ${f.name}`);
  };
  const starter = $('#f-starter', root);
  if (starter) starter.onclick = () => { ta.value = STARTER; size(); };
  $('#f-preview', root).onclick = () => {
    if (!ta.value.trim()) { toast('Add some code first'); return; }
    const m = getMeta();
    mountPlayer({ name: `Preview · ${m.name || 'Untitled'}`, icon: m.icon, html: ta.value, storageKey: `appdata:preview:${me.id}` });
  };
  size();
}

async function pageDevNew(seq) {
  updateChrome('dev');
  if (!me) return setView(seq, largeTitle('New App') + needSignIn('🚀', 'Sign in to publish', 'Create a free account and publish your app in minutes.'));
  if (!setView(seq, `
    <a href="#/dev" class="see-all">‹ Developer</a>
    ${largeTitle('New App')}
    <form class="form" id="newForm">
      <div class="group-title" style="margin-top:0">Store listing</div>
      <div class="group">${listingFields()}</div>
      <div class="group-title">Your app</div>
      <div class="group">${codeFields()}</div>
      <div class="form-actions"><button class="btn primary" type="submit" id="pubBtn">Publish to Store</button><span class="error" id="formErr"></span></div>
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
      const { app } = await api('POST', '/api/apps', { ...getMeta(), version: $('#f-ver').value, notes: $('#f-notes').value || 'First release', html: $('#f-code').value });
      toast(`${app.name} is live!`);
      location.hash = `#/app/${enc(app.id)}`;
    } catch (err) { $('#formErr').textContent = err.message; btn.disabled = false; }
  };
}

async function pageDevEdit(seq, id) {
  updateChrome('dev');
  if (!me) return setView(seq, largeTitle('Edit App') + needSignIn('🛠️', 'Sign in', 'Sign in to manage your apps.'));
  const [{ app }, code] = await Promise.all([api('GET', `/api/apps/${enc(id)}`), api('GET', `/api/dev/apps/${enc(id)}/code`)]);
  if (!setView(seq, `
    <a href="#/dev" class="see-all">‹ Developer</a>
    <div class="app-head" style="margin:14px 0 6px;align-items:center">${iconHTML(app.icon, 'sm')}
      <div class="meta"><h1 style="font-size:26px">${esc(app.name)}</h1><span class="muted small">Version ${esc(app.version)}</span></div>
      <a class="btn sm" href="#/app/${esc(app.id)}">View in Store</a></div>
    <form class="form" id="codeForm">
      <div class="group-title">Release a new version</div>
      <div class="group">${codeFields({ version: bumpVersion(app.version), html: code.html, isUpdate: true })}</div>
      <div class="form-actions"><button class="btn primary" type="submit" id="relBtn">Publish Update</button><span class="error" id="codeErr"></span></div>
    </form>
    <form class="form" id="listingForm">
      <div class="group-title">Store listing</div>
      <div class="group">${listingFields(app)}</div>
      <div class="form-actions"><button class="btn" type="submit">Save Listing</button><span class="error" id="listErr"></span></div>
    </form>
    <div class="group-title">Remove</div>
    <div class="link-list" style="max-width:760px"><button id="delApp" class="danger">Delete this app from the store</button></div>`)) return;

  const listingForm = $('#listingForm');
  const getMeta = wireListing(listingForm, app.icon);
  listingForm.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('PUT', `/api/apps/${enc(app.id)}`, getMeta()); toast('Listing saved'); route(true); }
    catch (err) { $('#listErr').textContent = err.message; }
  };
  const codeForm = $('#codeForm');
  wireCode(codeForm, getMeta);
  codeForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#relBtn');
    btn.disabled = true;
    try {
      const { app: up } = await api('PUT', `/api/apps/${enc(app.id)}`, { version: $('#f-ver').value, notes: $('#f-notes').value || 'Bug fixes and improvements', html: $('#f-code').value });
      toast(`Version ${up.version} is live!`);
      route(true);
    } catch (err) { $('#codeErr').textContent = err.message; btn.disabled = false; }
  };
  const del = $('#delApp');
  del.onclick = async () => {
    if (!del.dataset.armed) {
      del.dataset.armed = '1';
      del.textContent = 'Tap again to delete for everyone';
      setTimeout(() => { delete del.dataset.armed; del.textContent = 'Delete this app from the store'; }, 4000);
      return;
    }
    await api('DELETE', `/api/apps/${enc(app.id)}`);
    toast('App deleted');
    location.hash = '#/dev';
  };
}

// ---------- router ----------

async function route(keepScroll) {
  const seq = ++renderSeq;
  if (activePlayer) activePlayer.destroy();
  const raw = location.hash.slice(1) || '/';
  const [path, qs = ''] = raw.split('?');
  const query = new URLSearchParams(qs);
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  $('#searchInput').value = parts[0] === 'search' ? query.get('q') || '' : '';
  if (keepScroll !== true) window.scrollTo(0, 0);
  try {
    switch (parts[0]) {
      case undefined: return await pageDiscover(seq);
      case 'search': return await pageSearch(seq, query.get('q') || '');
      case 'browse': return await pageBrowse(seq, Object.fromEntries(query));
      case 'category': return await pageBrowse(seq, { category: parts[1], sort: query.get('sort') });
      case 'app': return await pageApp(seq, parts[1]);
      case 'play': return await pagePlay(seq, parts[1]);
      case 'library': return await pageLibrary(seq);
      case 'account': return await pageAccount(seq, query.get('next'), query.get('mode'));
      case 'dev':
        if (parts[1] === 'new') return await pageDevNew(seq);
        if (parts[1] === 'edit') return await pageDevEdit(seq, parts[2]);
        return await pageDev(seq);
      default:
        setView(seq, emptyHTML('🧭', 'Page not found', 'That page doesn’t exist.', '<a class="btn primary" href="#/">Go to the store</a>'));
    }
  } catch (err) {
    setView(seq, emptyHTML('⚠️', err.status === 404 ? 'App not found' : 'Something went wrong',
      err.status === 404 ? 'That app isn’t in the store. It may have been removed.' : err.message, '<a class="btn primary" href="#/">Back to the store</a>'));
  }
}

$('#searchForm').onsubmit = (e) => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  location.hash = `#/search${q ? `?q=${enc(q)}` : ''}`;
};

window.addEventListener('hashchange', () => route());

(async function init() {
  try {
    const [m, c] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/categories')]);
    me = m.user;
    categories = c.categories;
  } catch { /* offline: route() shows the error */ }
  updateChrome('');
  route();
})();
