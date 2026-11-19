'use strict';
/* Leonida Field Journal — everything stays on this device (IndexedDB). */

// ---------- storage ----------
const DB_NAME = 'leonida-journal', DB_VER = 1;
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      ['items', 'sessions', 'blobs'].forEach(s => { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('inbox')) d.createObjectStore('inbox', { keyPath: 'id', autoIncrement: true });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    let out;
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const idb = {
  all: s => tx(s, 'readonly', st => st.getAll()),
  get: (s, k) => tx(s, 'readonly', st => st.get(k)),
  put: (s, v) => tx(s, 'readwrite', st => st.put(v)),
  del: (s, k) => tx(s, 'readwrite', st => st.delete(k)),
  clear: s => tx(s, 'readwrite', st => st.clear()),
};

// ---------- state ----------
const S = {
  items: [], sessions: [], meta: {},
  tab: 'home', prevTab: 'home', placeId: null, surprise: false,
  feedFilter: 'all', feedQuery: '', mapFilter: 'all', mapSel: null, mapFocus: null,
  mapMode: 'view', pinReturn: null, pinPlace: null, pinPrevTab: 'home',
  draft: null, sheetOpen: false, sheetFn: null, viewer: null,
};
const OFFICIAL_AREAS = ['Vice City', 'Leonida Keys', 'Grassrivers', 'Port Gellhorn', 'Ambrosia', 'Mount Kalaga'];
const KINDS = ['Motel', 'Diner', 'Gas station', 'Marina', 'Shack', 'House', 'Bar', 'Store', 'Beach'];
const TIMES = ['Dawn', 'Day', 'Dusk', 'Night'];

const $ = s => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byId = id => S.items.find(i => i.id === id);
const places = () => S.items.filter(i => i.type === 'place');
const photosFor = pid => S.items.filter(i => i.type === 'photo' && i.placeId === pid).sort((a, b) => b.createdAt - a.createdAt);
const activeSession = () => S.sessions.find(s => !s.end);
const sessionById = id => S.sessions.find(s => s.id === id);
const maxSessionN = () => S.sessions.reduce((m, s) => Math.max(m, s.n), 0);

async function saveItem(it) {
  const i = S.items.findIndex(x => x.id === it.id);
  if (i >= 0) S.items[i] = it; else S.items.push(it);
  await idb.put('items', it);
  askPersist();
}
async function deleteItem(id) {
  const it = byId(id);
  S.items = S.items.filter(x => x.id !== id);
  await idb.del('items', id);
  if (it && it.blobId) { await idb.del('blobs', it.blobId); dropURL(it.blobId); }
}
async function setMeta(key, value) { S.meta[key] = value; await idb.put('meta', { key, value }); }
async function saveSession(s) {
  const i = S.sessions.findIndex(x => x.id === s.id);
  if (i >= 0) S.sessions[i] = s; else S.sessions.push(s);
  await idb.put('sessions', s);
}
let persistAsked = false;
function askPersist() {
  if (persistAsked) return; persistAsked = true;
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* ignore */ }
}

// ---------- images ----------
const urlCache = new Map();
async function blobURL(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const rec = await idb.get('blobs', id);
  if (!rec) return '';
  const u = URL.createObjectURL(rec.blob);
  urlCache.set(id, u);
  return u;
}
function dropURL(id) { const u = urlCache.get(id); if (u) { URL.revokeObjectURL(u); urlCache.delete(id); } }
async function hydrate(root) {
  const imgs = (root || document).querySelectorAll('img[data-blob]');
  for (const img of imgs) { if (!img.getAttribute('src')) { const u = await blobURL(img.dataset.blob); if (u) img.src = u; } }
}
async function compress(file, max) {
  max = max || 1920;
  try {
    const bmp = await createImageBitmap(file);
    const sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * sc), h = Math.round(bmp.height * sc);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', 0.86));
  } catch (e) { return file; }
}
async function storeBlob(blob, id) {
  id = id || uid();
  await idb.put('blobs', { id, blob });
  return id;
}
function pickFiles(input) {
  return new Promise(res => {
    const el = $(input);
    el.value = '';
    el.onchange = () => res(Array.from(el.files || []));
    el.click();
  });
}

// ---------- time helpers ----------
function ago(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  if (d < 172800) return 'yesterday';
  if (d < 7 * 86400) return Math.floor(d / 86400) + ' days ago';
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function dur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function totalHours() {
  const ms = S.sessions.reduce((t, s) => t + ((s.end || Date.now()) - s.start), 0);
  const h = ms / 3600000;
  return h < 10 ? (Math.round(h * 10) / 10) + 'h' : Math.round(h) + 'h';
}
function sessionLabel(sid) { const s = sessionById(sid); return s ? 'Session ' + s.n : ''; }

// ---------- areas (spoiler-free spell check) ----------
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function checkArea(raw) {
  const t = String(raw || '').trim();
  if (!t) return { state: 'empty', name: '' };
  const n = norm(t);
  const pool = OFFICIAL_AREAS.map(name => ({ name, src: 'official' }))
    .concat((S.meta.customAreas || []).map(name => ({ name, src: 'yours' })));
  let best = null;
  for (const p of pool) {
    const pn = norm(p.name);
    let d = pn === n ? 0 : lev(n, pn);
    if (d > 0 && pn.length >= 6 && n.startsWith(pn)) d = 0.5; // e.g. "Mount Kalaga National Park"
    const tol = pn.length <= 6 ? 1 : 2;
    if (d <= tol && (!best || d < best.d)) best = Object.assign({ d }, p);
  }
  if (best) return { state: 'ok', name: best.name, src: best.src, changed: best.name !== t };
  return { state: 'unknown', name: t };
}
function usedAreas() {
  const set = new Set();
  S.items.forEach(i => { if (i.area) set.add(i.area); });
  return Array.from(set).sort();
}

// ---------- icons ----------
const sv = (d, w, extra) => `<svg width="${w || 20}" height="${w || 20}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra || ''}>${d}</svg>`;
const I = {
  pin: sv('<path d="M12 21s7-6.2 7-11.5a7 7 0 0 0-14 0C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  eye: sv('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>'),
  note: sv('<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
  cam: sv('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', 18),
  star: sv('<path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4l-5.5 2.9 1-6.2L3 9.7l6.2-.9z"/>', 18),
  starF: sv('<path fill="currentColor" d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4l-5.5 2.9 1-6.2L3 9.7l6.2-.9z"/>', 18),
  back: sv('<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4h-4"/>', 16),
  x: sv('<path d="M6 6l12 12M18 6 6 18"/>', 18),
  chev: sv('<path d="m9 6 6 6-6 6"/>'),
  left: sv('<path d="m15 6-6 6 6 6"/>'),
  edit: sv('<path d="M4 20h4L19 9l-4-4L4 16z"/>', 18),
  gear: sv('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>',
  stop: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  shuffle: sv('<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>', 15),
  plus: sv('<path d="M12 5v14M5 12h14"/>', 18),
};

// ---------- toast ----------
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2200);
}

// ---------- layers (Android back button) ----------
function pushLayer(name) { history.pushState({ layer: name }, ''); }
let ignorePops = 0;
window.addEventListener('popstate', () => {
  if (ignorePops) { ignorePops--; return; }
  if (S.viewer) { hideViewer(); return; }
  if (S.sheetOpen) { hideSheet(); return; }
  if (S.mapMode === 'pin') { finishPin(S.pinSaveFlag); S.pinSaveFlag = false; return; }
  if (S.tab === 'place') { S.tab = S.prevTab || 'home'; S.surprise = false; render(); return; }
  if (S.tab !== 'home') { S.tab = 'home'; render(); return; }
  history.back(); // nothing left to close: leave the app
});
function openSub(tab) { if (S.tab !== 'feed' && S.tab !== 'settings') pushLayer('sub'); S.tab = tab; render(); $('#view').scrollTop = 0; }

// ---------- rendering ----------
function render() {
  const v = $('#view');
  const nav = $('#nav');
  document.querySelectorAll('#nav [data-tab]').forEach(b => {
    const on = b.dataset.tab === S.tab || (b.dataset.tab === 'home' && (S.tab === 'feed' || S.tab === 'settings'));
    b.classList.toggle('on', on);
  });
  nav.classList.toggle('hidden-nav', S.tab === 'place');
  v.classList.toggle('full', S.tab === 'place');
  const fn = { home: renderHome, feed: renderFeed, map: renderMap, photos: renderPhotos, radio: renderRadio, place: renderPlace, settings: renderSettings }[S.tab] || renderHome;
  v.innerHTML = fn();
  if (S.tab === 'map') setupMap(); else M.canvas = null;
  hydrate(v);
}

function itemRow(it) {
  if (it.type === 'photo') {
    const p = it.placeId && byId(it.placeId);
    return `<button class="row" data-act="openItem" data-id="${it.id}">
      <div class="pol"><img class="ph" data-blob="${it.blobId}" alt=""></div>
      <div class="body"><div class="t typed">${esc(it.caption || 'Untitled photo')}</div>
      <div class="m">${p ? `<span class="area">${esc(p.name)}</span> · ` : ''}Photo · ${ago(it.createdAt)}</div></div></button>`;
  }
  if (it.type === 'place') {
    const color = it.mark === 'fav' ? 'var(--pink)' : it.mark === 'back' ? 'var(--orange)' : 'var(--teal)';
    return `<button class="row" data-act="openItem" data-id="${it.id}">
      <div class="disc" style="color:${color}">${I.pin}</div>
      <div class="body"><div class="t">${esc(it.name)}</div>
      <div class="m">${it.area ? `<span class="area">${esc(it.area)}</span> · ` : ''}${esc(it.kind || 'Place')} · ${ago(it.createdAt)}</div></div></button>`;
  }
  if (it.type === 'detail') {
    return `<button class="row" data-act="openItem" data-id="${it.id}">
      <div class="disc" style="color:var(--orange)">${I.eye}</div>
      <div class="body"><div class="t typed">${esc(it.text)}</div>
      <div class="m">${it.area ? `<span class="area">${esc(it.area)}</span> · ` : ''}Detail · ${ago(it.createdAt)}</div></div></button>`;
  }
  if (it.type === 'song') {
    const meta = [it.station, it.note].filter(Boolean).map(esc).join(' · ') || 'Song · ' + ago(it.createdAt);
    return `<button class="row" data-act="openItem" data-id="${it.id}">
      <div class="disc" style="color:var(--pink)">${I.note}</div>
      <div class="body"><div class="t">${esc(it.title)}${it.artist ? ' — ' + esc(it.artist) : ''}</div>
      <div class="m">${meta}</div></div></button>`;
  }
  return '';
}

function lastVisit(p) {
  const vs = p.visits || [];
  return vs.reduce((m, v) => (v.at > m.at ? v : m), vs[0] || { at: p.createdAt, sessionId: p.sessionId });
}
function staleList() {
  const curN = maxSessionN();
  return places().filter(p => p.mark === 'fav' || p.mark === 'back').map(p => {
    const lv = lastVisit(p); const s = sessionById(lv.sessionId);
    const gap = s ? curN - s.n : 0;
    return { p, lv, stale: gap >= 2 || Date.now() - lv.at > 3 * 86400000 };
  }).filter(x => x.stale).sort((a, b) => a.lv.at - b.lv.at);
}

function renderHome() {
  const a = activeSession();
  const ps = places();
  const songs = S.items.filter(i => i.type === 'song').length;
  const nt = S.meta.nextTime;
  const recent = S.items.slice().sort((x, y) => y.createdAt - x.createdAt).slice(0, 6);
  const stale = staleList().slice(0, 2);
  const session = a
    ? `<button class="pill live" data-act="endSession" aria-label="End session ${a.n}">${I.stop} ${dur(Date.now() - a.start)} · End</button>`
    : `<button class="pill" data-act="startSession">${I.play} Start session</button>`;
  const next = nt && nt.text
    ? `<button class="postcard tilt-l" data-act="editNext" style="border:none;text-align:left;width:100%;margin-top:22px">
        <div class="stamp">NEXT TIME</div><div class="typed">${esc(nt.text)}</div>
        <div class="inkmuted">— ${nt.fromN ? 'end of Session ' + nt.fromN : 'note to self'}, ${ago(nt.at)}</div></button>`
    : `<button class="postcard tilt-l" data-act="editNext" style="border:none;text-align:left;width:100%;margin-top:22px">
        <div class="stamp">NEXT TIME</div><div class="typed">${S.items.length ? 'Nothing planned. Tap to leave yourself a note for next session.' : 'Your journal is empty. When something in Leonida catches your eye, tap ＋ and keep it.'}</div></button>`;
  const staleHTML = ps.length ? `
    <div class="sechead"><div class="label">Haven't been back</div>
      ${ps.length >= 2 ? `<button class="pill small pink" data-act="surprise">${I.shuffle} Surprise me</button>` : ''}</div>
    ${stale.length ? `<div class="grid2">${stale.map((x, i) => `
      <button class="mini-post ${i ? 'tilt-r' : 'tilt-l'}" data-act="openPlace" data-id="${x.p.id}">
        <b>${esc(x.p.name)}</b><span>${x.p.mark === 'fav' ? '★ · ' : '↻ · '}last visit ${sessionLabel(x.lv.sessionId) || ago(x.lv.at)}</span></button>`).join('')}</div>`
      : `<div class="empty" style="padding:12px">Your favourites and come-back places are all fresh. They'll show here once they've been waiting a while.</div>`}` : '';
  return `<div class="wrap">
    <div class="top">
      <div><div class="brand">Leonida</div><div class="sub">${a ? 'Session ' + a.n + ' · live' : 'Field journal'}</div></div>
      <div style="display:flex;gap:8px;align-items:center"><button class="icon-btn" data-act="settings" aria-label="Settings and backup">${I.gear}</button>${session}</div>
    </div>
    ${next}
    <div class="stats">
      <div class="stat"><b>${ps.length}</b><span class="label">Places</span></div>
      <div class="stat"><b>${songs}</b><span class="label">Songs</span></div>
      <div class="stat"><b>${totalHours()}</b><span class="label">In Leonida</span></div>
    </div>
    ${staleHTML}
    <div class="sechead"><div class="label">Recent</div>${S.items.length ? '<button class="linkbtn" data-act="seeAll">See all</button>' : ''}</div>
    <div class="feed">${recent.length ? recent.map(itemRow).join('') : '<div class="empty">Nothing yet. Start a session, go explore, and log what you notice.</div>'}</div>
  </div>`;
}

function feedListHTML() {
  const q = S.feedQuery.trim().toLowerCase();
  const f = S.feedFilter;
  const list = S.items.filter(i => f === 'all' || i.type === f).filter(i => {
    if (!q) return true;
    const vtext = (i.visits || []).map(v => v.note).join(' ');
    return [i.name, i.area, i.kind, i.text, i.title, i.artist, i.station, i.note, i.caption, vtext].join(' ').toLowerCase().includes(q);
  }).sort((a, b) => b.createdAt - a.createdAt);
  return list.length ? list.map(itemRow).join('') : '<div class="empty">Nothing matches.</div>';
}
function renderFeed() {
  const f = S.feedFilter;
  const chips = [['all', 'All'], ['place', 'Places'], ['detail', 'Details'], ['song', 'Songs'], ['photo', 'Photos']]
    .map(([v, l]) => `<button class="chip ${f === v ? 'on' : ''}" data-act="feedFilter" data-v="${v}">${l}</button>`).join('');
  return `<div class="wrap">
    <div class="top"><h1 class="page">Journal</h1><button class="icon-btn" data-act="tab" data-v="home" aria-label="Back to home">${I.left}</button></div>
    <input class="search" id="feedSearch" type="search" placeholder="Search your notes" value="${esc(S.feedQuery)}" aria-label="Search your notes">
    <div class="hscroll" style="margin-top:12px">${chips}</div>
    <div class="feed" id="feedList" style="margin-top:16px">${feedListHTML()}</div>
  </div>`;
}

function renderPhotos() {
  const ph = S.items.filter(i => i.type === 'photo').sort((a, b) => b.createdAt - a.createdAt);
  return `<div class="wrap">
    <div class="top"><div><h1 class="page">Photos</h1><div class="sub" style="margin-top:4px">${ph.length} kept</div></div>
      <button class="pill pink" data-act="newPhoto">${I.plus} Add</button></div>
    ${ph.length ? `<div class="pgrid">${ph.map(p => `<button data-act="photoView" data-id="${p.id}" data-set="all"><img data-blob="${p.blobId}" alt="${esc(p.caption || 'In-game photo')}"><span>${esc(p.caption || '')}</span></button>`).join('')}</div>`
      : `<div class="empty" style="margin-top:20px">No photos yet.<br><br>On the PS5, turn on auto-upload for captures. Then in the PlayStation App on your phone, open a capture, tap Share and pick Leonida Journal.</div>`}
  </div>`;
}

function renderRadio() {
  const songs = S.items.filter(i => i.type === 'song');
  const groups = {};
  songs.forEach(s => { const k = s.station || 'No station noted'; (groups[k] = groups[k] || []).push(s); });
  const keys = Object.keys(groups).sort((a, b) => (a === 'No station noted') - (b === 'No station noted') || a.localeCompare(b));
  return `<div class="wrap">
    <div class="top"><div><h1 class="page">Radio</h1><div class="sub" style="margin-top:4px">${songs.length} songs kept</div></div>
      <button class="pill pink" data-act="newSong">${I.plus} Song</button></div>
    ${songs.length ? keys.map(k => `<div class="station"><div class="label" style="margin-bottom:8px">${esc(k)}</div>
      <div class="feed">${groups[k].sort((a, b) => b.createdAt - a.createdAt).map(itemRow).join('')}</div></div>`).join('')
      : '<div class="empty" style="margin-top:20px">Hear something good on the radio? Tap ＋ Song and note where you were driving.</div>'}
  </div>`;
}

function renderPlace() {
  const p = byId(S.placeId);
  if (!p) { S.tab = 'home'; return renderHome(); }
  const ph = photosFor(p.id);
  const vs = (p.visits || []).slice().sort((a, b) => b.at - a.at);
  const songs = S.items.filter(i => i.type === 'song' && i.placeId === p.id);
  const details = S.items.filter(i => i.type === 'detail' && i.placeId === p.id);
  const times = p.times || [];
  const markTag = p.mark === 'fav' ? '<span class="tag fav">★ Favourite</span>' : '';
  return `<div class="wrap" style="padding-bottom:40px">
    <div class="top" style="padding-top:max(14px,env(safe-area-inset-top));margin:0 -8px">
      <button class="icon-btn" data-act="back" aria-label="Back">${I.left}</button>
      <div style="display:flex;gap:8px">
        <button class="icon-btn" data-act="favToggle" aria-label="${p.mark === 'fav' ? 'Remove from favourites' : 'Add to favourites'}" style="color:${p.mark === 'fav' ? 'var(--pink)' : 'var(--text)'}">${p.mark === 'fav' ? I.starF : I.star}</button>
        <button class="icon-btn" data-act="editPlace" aria-label="Edit place">${I.edit}</button>
      </div>
    </div>
    ${S.surprise ? `<div class="banner"><span>Surprise pick. Go back tonight?</span><span style="display:flex;gap:6px"><button data-act="surprise">Another</button><button data-act="surpriseNext">Next time</button></span></div>` : ''}
    ${ph.length ? `<div class="carousel">${ph.map((x, i) => `<button class="bigpol" style="border:none" data-act="photoView" data-id="${x.id}" data-set="place"><img data-blob="${x.blobId}" alt="${esc(x.caption || p.name)}"><span class="cap">${esc(x.caption || '')}</span><span class="n">${i + 1} / ${ph.length}</span></button>`).join('')}</div>
      <button class="linkbtn" data-act="addPlacePhoto" style="margin-top:-12px">＋ Add photo</button>`
      : `<button class="nophoto" data-act="addPlacePhoto">${I.cam} Add a photo of this place</button>`}
    <div class="ptitle">${esc(p.name)}</div>
    <div class="chips">
      ${p.area ? `<span class="tag area">${esc(p.area)}</span>` : ''}
      ${p.kind ? `<span class="tag kind">${esc(p.kind)}</span>` : ''}
      ${markTag}
      <button class="tag ${p.mark === 'back' ? 'back' : 'off'}" data-act="backToggle">↻ Come back</button>
    </div>
    <div class="field" style="margin-top:18px"><div class="label">Best time to go</div>
      <div class="chips">${TIMES.map(t => `<button class="chip ${times.includes(t) ? 'on' : ''}" data-act="placeTime" data-v="${t}">${t}</button>`).join('')}
      <button class="chip ${p.rain ? 'on' : 'dash'}" data-act="placeRain">${p.rain ? 'Rain' : '+ Rain'}</button></div></div>
    <div class="field" style="margin-top:18px"><div class="label">Visits · ${vs.length}</div>
      ${vs.map(v => `<button class="visit" style="border:none;text-align:left;width:100%" data-act="editVisit" data-id="${v.id}"><strong>${esc(sessionLabel(v.sessionId) || new Date(v.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}${v.time && v.time.length ? ', ' + esc(v.time.join('/').toLowerCase()) : ''} —</strong> ${v.note ? esc(v.note) : '<em>No note.</em>'}</button>`).join('')}
    </div>
    ${songs.length ? `<div class="field" style="margin-top:18px"><div class="label">Heard here</div><div class="feed">${songs.map(itemRow).join('')}</div></div>` : ''}
    ${details.length ? `<div class="field" style="margin-top:18px"><div class="label">Details noticed here</div><div class="feed">${details.map(itemRow).join('')}</div></div>` : ''}
    <div class="actions">
      <button class="primary" style="height:52px" data-act="imBack">I'm back here</button>
      <button class="sec" data-act="onMap">${p.pin ? 'On map' : 'Pin it'}</button>
    </div>
  </div>`;
}

function renderSettings() {
  const custom = S.meta.customAreas || [];
  const lb = S.meta.lastBackup;
  return `<div class="wrap">
    <div class="top"><h1 class="page">Settings</h1><button class="icon-btn" data-act="tab" data-v="home" aria-label="Back to home">${I.left}</button></div>
    <div class="setrow"><div class="label">Backup</div>
      <p>Your journal lives only on this phone. Save a backup now and then: if Chrome's data is cleared or you change phones, a backup is the only copy.${lb ? ' Last backup: ' + ago(lb) + '.' : ' No backup yet.'}</p>
      <div class="two"><button class="ghost teal" data-act="exportShare">Send to Drive…</button><button class="ghost" data-act="exportFile">Save file</button></div>
      <button class="ghost" data-act="importFile">Restore from a backup file</button></div>
    <div class="setrow"><div class="label">Map image</div>
      <p>${M.img ? 'Map image set. Only the areas around your pins are ever revealed.' : 'No map image yet. Pins and the fog still work; once a reliable full map of Leonida is out, add the image here and your uncovered patches will show the real map.'}</p>
      <div class="two"><button class="ghost teal" data-act="setMap">${M.img ? 'Replace image' : 'Choose image'}</button>${M.img ? '<button class="ghost danger" data-act="removeMap">Remove</button>' : ''}</div></div>
    <div class="setrow"><div class="label">Areas you added</div>
      <p>Names you kept even though they weren't on the official list. They'll be spell-checked like official ones.</p>
      ${custom.length ? `<div class="chips">${custom.map(a => `<button class="chip" data-act="rmArea" data-v="${esc(a)}" aria-label="Remove ${esc(a)}">${esc(a)} ✕</button>`).join('')}</div>` : '<p>None yet.</p>'}</div>
    <div class="setrow"><p>Leonida Field Journal · no accounts, no tracking, nothing leaves this phone unless you send a backup.</p></div>
  </div>`;
}

// ---------- sheet ----------
function openSheet(fn) {
  S.sheetFn = fn;
  if (!S.sheetOpen) { S.sheetOpen = true; pushLayer('sheet'); }
  renderSheet();
  $('#sheet').classList.add('on'); $('#scrim').classList.add('on');
  $('#sheet').scrollTop = 0;
}
function renderSheet() { $('#sheetInner').innerHTML = '<div class="grab"></div>' + S.sheetFn(); hydrate($('#sheetInner')); }
function hideSheet() {
  S.sheetOpen = false;
  $('#sheet').classList.remove('on'); $('#scrim').classList.remove('on');
}
function closeSheet() { if (S.sheetOpen) history.back(); }
const sheetHead = t => `<div class="sheet-head"><h2>${t}</h2><button class="icon-btn" data-act="closeSheet" aria-label="Close" style="background:var(--surface2)">${I.x}</button></div>`;

// capture
function openCapture(type, existing, preset) {
  preset = preset || {};
  if (existing) {
    S.draft = JSON.parse(JSON.stringify(existing));
    S.draft.mode = 'edit'; S.draft.photos = []; S.draft.areaKeep = false;
  } else {
    S.draft = { mode: 'new', type: type || 'place', name: '', area: '', kind: '', note: '', mark: 'found', times: [], rain: false, pin: null,
      photos: preset.photos || [], placeId: preset.placeId || '', title: preset.title || '', artist: preset.artist || '', station: '', text: '', caption: '', areaKeep: false };
    if (preset.note) S.draft.note = preset.note;
  }
  openSheet(captureHTML);
}
function placeOptions(sel) {
  const ps = places().sort((a, b) => a.name.localeCompare(b.name));
  return `<option value="">— Not linked to a place —</option>` + ps.map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}${p.area ? ' · ' + esc(p.area) : ''}</option>`).join('');
}
function areaField(d) {
  return `<div class="field"><label class="label" for="cArea">Area</label>
    <input id="cArea" list="areaList" value="${esc(d.area)}" autocomplete="off" autocapitalize="words" placeholder="Where in Leonida?">
    <datalist id="areaList">${usedAreas().map(a => `<option value="${esc(a)}">`).join('')}</datalist>
    <div class="areastat" id="areaStat">${areaStatHTML(d)}</div></div>`;
}
function areaStatHTML(d) {
  const r = checkArea(d.area);
  if (r.state === 'empty') return '';
  if (r.state === 'ok') return r.changed
    ? `<span class="ok" style="color:var(--teal)">✓ Saved as <strong>${esc(r.name)}</strong> — ${r.src === 'official' ? 'official spelling' : 'as you spelled it before'}</span>`
    : `<span style="color:var(--teal)">✓ ${r.src === 'official' ? 'Official area' : 'One of your areas'}</span>`;
  if (d.areaKeep) return `<span style="color:var(--orange)">Keeping “${esc(r.name)}” as typed</span>`;
  return `<span style="color:var(--orange)">Not on the official list.</span><button data-act="keepArea">Keep as typed</button>`;
}
function thumbsHTML(d) {
  if (!d.photos.length) return '';
  return `<div class="thumbs">${d.photos.map((p, i) => `<div class="tb"><img src="${p.url}" alt=""><button class="x" data-act="rmPhoto" data-v="${i}" aria-label="Remove photo">✕</button></div>`).join('')}</div>`;
}
function captureHTML() {
  const d = S.draft;
  const isNew = d.mode === 'new';
  const titles = { place: 'place', detail: 'detail', song: 'song', photo: 'photo' };
  let h = sheetHead(isNew ? 'New entry' : 'Edit ' + titles[d.type]);
  if (isNew) h += `<div class="seg">${[['place', 'Place'], ['detail', 'Detail'], ['song', 'Song'], ['photo', 'Photo']].map(([v, l]) => `<button class="${d.type === v ? 'on' : ''}" data-act="cType" data-v="${v}">${l}</button>`).join('')}</div>`;
  if (d.type === 'place') {
    const kinds = KINDS.concat(S.meta.customKinds || []);
    if (d.kind && !kinds.includes(d.kind)) kinds.push(d.kind);
    h += `<div class="field"><label class="label" for="cName">Name it</label><input id="cName" value="${esc(d.name)}" placeholder="e.g. Motel by the highway" autocapitalize="sentences"></div>`;
    h += areaField(d);
    h += `<div class="field"><div class="label">Kind</div><div class="chips">${kinds.map(k => `<button class="chip ${d.kind === k ? 'on' : ''}" data-act="cKind" data-v="${esc(k)}">${esc(k)}</button>`).join('')}<button class="chip dash" data-act="cKindOther">+ Other</button></div></div>`;
    if (isNew) h += `<div class="field"><label class="label" for="cNote">Note</label><textarea id="cNote" class="paper" placeholder="What made you stop here?">${esc(d.note)}</textarea></div>`;
    h += `<div class="marks">
      <button class="fav ${d.mark === 'fav' ? 'on' : ''}" data-act="cMark" data-v="fav">${I.star}Favourite</button>
      <button class="back ${d.mark === 'back' ? 'on' : ''}" data-act="cMark" data-v="back">${I.back}Come back</button>
      <button class="found ${d.mark === 'found' ? 'on' : ''}" data-act="cMark" data-v="found">Just found</button></div>`;
    h += `<div class="field"><div class="label">Best time to go</div><div class="chips">${TIMES.map(t => `<button class="chip ${d.times.includes(t) ? 'on' : ''}" data-act="cTime" data-v="${t}">${t}</button>`).join('')}<button class="chip ${d.rain ? 'on' : 'dash'}" data-act="cRain">${d.rain ? 'Rain' : '+ Rain'}</button></div></div>`;
    h += thumbsHTML(d);
    h += `<div class="two"><button class="ghost" data-act="cPhoto">${I.cam}${isNew ? 'Add photo' : 'Add more photos'}</button><button class="ghost ${d.pin ? '' : 'teal'}" data-act="cPin">${I.pin}${d.pin ? 'Pinned ✓ Move' : 'Pin on map'}</button></div>`;
  } else if (d.type === 'detail') {
    h += `<div class="field"><label class="label" for="cText">What did you notice?</label><textarea id="cText" class="paper" placeholder="A sign, a person, a building, something overheard…">${esc(d.text)}</textarea></div>`;
    h += areaField(d);
    h += `<div class="field"><label class="label" for="cPlace">At a place?</label><select id="cPlace">${placeOptions(d.placeId)}</select></div>`;
    if (isNew) { h += thumbsHTML(d); h += `<button class="ghost" data-act="cPhoto">${I.cam}Add photo</button>`; }
  } else if (d.type === 'song') {
    if (d.mode === 'new' && !d.title) h += `<div style="font-size:13px;color:var(--muted);line-height:1.5">Faster: identify it with Shazam or Google, tap <b>Share</b> there and pick <b>Leonida</b>. It lands here filled in.</div>`;
    h += `<div class="field"><label class="label" for="cTitle">Song</label><input id="cTitle" value="${esc(d.title)}" placeholder="Title"></div>`;
    h += `<div class="two"><div class="field"><label class="label" for="cArtist">Artist</label><input id="cArtist" value="${esc(d.artist)}"></div>
      <div class="field"><label class="label" for="cStation">Station</label><input id="cStation" value="${esc(d.station)}" list="stationList" autocomplete="off"></div></div>
      <datalist id="stationList">${Array.from(new Set(S.items.filter(i => i.station).map(i => i.station))).map(s => `<option value="${esc(s)}">`).join('')}</datalist>`;
    h += `<div class="field"><label class="label" for="cNote">Where / what mood</label><input id="cNote" value="${esc(d.note)}" placeholder="e.g. night drive on the causeway"></div>`;
    h += `<div class="field"><label class="label" for="cPlace">Heard at a place?</label><select id="cPlace">${placeOptions(d.placeId)}</select></div>`;
  } else if (d.type === 'photo') {
    h += thumbsHTML(d);
    h += `<button class="ghost teal" data-act="cPhoto">${I.cam}${d.photos.length ? 'Add more' : 'Choose photos'}</button>`;
    h += `<div class="field"><label class="label" for="cCaption">Caption</label><input id="cCaption" value="${esc(d.caption)}" placeholder="One line, like on a polaroid"></div>`;
    h += `<div class="field"><label class="label" for="cPlace">Which place?</label><select id="cPlace">${placeOptions(d.placeId)}</select></div>`;
  }
  h += `<button class="primary" data-act="cSave">${isNew ? 'Save to journal' : 'Save changes'}</button>`;
  if (!isNew) h += `<button class="ghost danger" data-act="cDelete">Delete ${titles[d.type]}</button>`;
  return h;
}
function readForm() {
  const d = S.draft; if (!d) return;
  const val = id => { const el = document.getElementById(id); return el ? el.value : undefined; };
  const map = { cName: 'name', cArea: 'area', cNote: 'note', cText: 'text', cPlace: 'placeId', cTitle: 'title', cArtist: 'artist', cStation: 'station', cCaption: 'caption' };
  for (const id in map) { const v = val(id); if (v !== undefined) d[map[id]] = v; }
}
async function addDraftPhotos() {
  readForm();
  const files = await pickFiles('#filePick');
  if (!files.length) return;
  toast('Adding ' + files.length + (files.length > 1 ? ' photos…' : ' photo…'));
  for (const f of files) { const b = await compress(f); S.draft.photos.push({ blob: b, url: URL.createObjectURL(b) }); }
  renderSheet();
}
async function savePhotosFromDraft(d, placeId, caption, sid) {
  for (const ph of d.photos) {
    const blobId = await storeBlob(ph.blob);
    await saveItem({ id: uid(), type: 'photo', blobId, caption: caption || '', placeId: placeId || '', createdAt: Date.now(), sessionId: sid });
  }
}
async function saveCapture() {
  readForm();
  const d = S.draft; const now = Date.now(); const a = activeSession(); const sid = a ? a.id : null;
  // area validation (place / detail)
  let area = '';
  if (d.type === 'place' || d.type === 'detail') {
    const r = checkArea(d.area);
    if (r.state === 'unknown' && !d.areaKeep) { toast('Check the area spelling, or tap “Keep as typed”'); const st = $('#areaStat'); if (st) st.innerHTML = areaStatHTML(d); return; }
    area = r.name;
    if (r.state === 'unknown' && d.areaKeep) { const c = (S.meta.customAreas || []).slice(); if (!c.includes(area)) { c.push(area); await setMeta('customAreas', c); } }
  }
  if (d.type === 'place') {
    if (!d.name.trim()) { toast('Give the place a name'); return; }
    if (d.mode === 'new') {
      const p = { id: uid(), type: 'place', name: d.name.trim(), area, kind: d.kind, mark: d.mark, times: d.times, rain: d.rain, pin: d.pin, createdAt: now, sessionId: sid,
        visits: [{ id: uid(), at: now, sessionId: sid, time: d.times.slice(), note: d.note.trim() }] };
      await saveItem(p);
      await savePhotosFromDraft(d, p.id, '', sid);
      toast('Saved. ' + (p.pin ? 'It’s on your map.' : 'Pin it later from its page.'));
    } else {
      const p = byId(d.id);
      Object.assign(p, { name: d.name.trim(), area, kind: d.kind, mark: d.mark, times: d.times, rain: d.rain, pin: d.pin });
      await saveItem(p);
      await savePhotosFromDraft(d, p.id, '', sid);
      toast('Updated');
    }
  } else if (d.type === 'detail') {
    if (!d.text.trim()) { toast('Write what you noticed'); return; }
    const it = d.mode === 'new' ? { id: uid(), type: 'detail', createdAt: now, sessionId: sid } : byId(d.id);
    Object.assign(it, { text: d.text.trim(), area, placeId: d.placeId });
    await saveItem(it);
    if (d.mode === 'new') await savePhotosFromDraft(d, d.placeId, d.text.trim().slice(0, 60), sid);
    toast('Saved');
  } else if (d.type === 'song') {
    if (!d.title.trim()) { toast('Add the song title'); return; }
    const it = d.mode === 'new' ? { id: uid(), type: 'song', createdAt: now, sessionId: sid } : byId(d.id);
    Object.assign(it, { title: d.title.trim(), artist: d.artist.trim(), station: d.station.trim(), note: d.note.trim(), placeId: d.placeId });
    await saveItem(it);
    toast('Song kept');
  } else if (d.type === 'photo') {
    if (!d.photos.length) { toast('Choose at least one photo'); return; }
    await savePhotosFromDraft(d, d.placeId, d.caption.trim(), sid);
    toast(d.photos.length > 1 ? d.photos.length + ' photos saved' : 'Photo saved');
  }
  S.draft = null;
  closeSheet();
  render();
}
async function deleteFromDraft() {
  const d = S.draft;
  if (d.type === 'place') {
    if (!confirm('Delete this place, its visits and its photos? This can’t be undone.')) return;
    for (const ph of photosFor(d.id)) await deleteItem(ph.id);
    for (const it of S.items.filter(i => i.placeId === d.id)) { it.placeId = ''; await saveItem(it); }
    await deleteItem(d.id);
    S.draft = null;
    if (S.tab === 'place') { hideSheet(); S.tab = S.prevTab || 'home'; ignorePops = 1; history.go(-2); }
    else closeSheet();
    render(); toast('Place deleted');
    return;
  }
  if (!confirm('Delete this ' + d.type + '?')) return;
  await deleteItem(d.id);
  S.draft = null; closeSheet(); render(); toast('Deleted');
}

// sessions
async function startSession() {
  const s = { id: uid(), n: maxSessionN() + 1, start: Date.now(), end: null, notes: '' };
  await saveSession(s); askPersist();
  render(); toast('Session ' + s.n + ' started. Enjoy Leonida.');
}
function endSessionSheet() {
  const a = activeSession(); if (!a) return;
  openSheet(() => `${sheetHead('End Session ' + a.n)}
    <div class="label" style="text-transform:none;letter-spacing:0;font-size:13px">${Date.now() - a.start > 8 * 3600000 ? 'This session has been open since ' + new Date(a.start).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) + '. It’ll be ended at your last entry so your hours stay honest.' : dur(Date.now() - a.start) + ' in Leonida'}</div>
    <div class="field"><label class="label" for="eWhere">Where did you go?</label><textarea id="eWhere" class="paper" placeholder="Where you drove, what you found…"></textarea></div>
    <div class="field"><label class="label" for="eNext">Next time</label><textarea id="eNext" class="paper" placeholder="One thing to do next session">${esc((S.meta.nextTime && S.meta.nextTime.text) || '')}</textarea></div>
    <button class="primary" data-act="eSave">End session</button>`);
}
async function endSessionSave() {
  const a = activeSession(); if (!a) return;
  a.end = Date.now(); a.notes = ($('#eWhere').value || '').trim();
  if (a.end - a.start > 8 * 3600000) {
    let last = 0;
    S.items.forEach(i => { if (i.sessionId === a.id) last = Math.max(last, i.createdAt); (i.visits || []).forEach(v => { if (v.sessionId === a.id) last = Math.max(last, v.at); }); });
    a.end = last ? last + 20 * 60000 : a.start + 2 * 3600000;
    toast('Looks like this one was left running, so I ended it at your last entry');
  }
  await saveSession(a);
  const nt = ($('#eNext').value || '').trim();
  await setMeta('nextTime', nt ? { text: nt, fromN: a.n, at: Date.now() } : null);
  closeSheet(); render(); toast('Session ' + a.n + ' logged');
}
function nextSheet() {
  const nt = S.meta.nextTime;
  openSheet(() => `${sheetHead('Next time')}
    <div class="field"><label class="label" for="nText">Note to your next session</label><textarea id="nText" class="paper" style="min-height:110px">${esc((nt && nt.text) || '')}</textarea></div>
    <button class="primary" data-act="nSave">Save</button>${nt && nt.text ? '<button class="ghost" data-act="nClear">Clear it (done)</button>' : ''}`);
}

// visits
function visitSheet(place, visit) {
  S.draft = { visitPlace: place.id, visitId: visit ? visit.id : null, times: visit ? (visit.time || []).slice() : [], note: visit ? visit.note : '', photos: [] };
  const multiple = (place.visits || []).length > 1;
  openSheet(() => {
    const d = S.draft;
    return `${sheetHead(visit ? 'Edit visit' : 'Back at ' + esc(place.name))}
      <div class="field"><div class="label">Time of day</div><div class="chips">${TIMES.map(t => `<button class="chip ${d.times.includes(t) ? 'on' : ''}" data-act="vTime" data-v="${t}">${t}</button>`).join('')}</div></div>
      <div class="field"><label class="label" for="vNote">What's different this time?</label><textarea id="vNote" class="paper">${esc(d.note)}</textarea></div>
      ${visit ? '' : thumbsHTML(d) + `<button class="ghost" data-act="vPhoto">${I.cam}Add photo</button>`}
      <button class="primary" data-act="vSave">${visit ? 'Save' : 'Log this visit'}</button>
      ${visit && multiple ? '<button class="ghost danger" data-act="vDelete">Delete this visit</button>' : ''}`;
  });
}
async function saveVisit() {
  const d = S.draft; const p = byId(d.visitPlace);
  d.note = ($('#vNote').value || '').trim();
  const a = activeSession(); const sid = a ? a.id : null;
  if (d.visitId) {
    const v = p.visits.find(x => x.id === d.visitId); v.note = d.note; v.time = d.times;
  } else {
    p.visits = p.visits || [];
    p.visits.push({ id: uid(), at: Date.now(), sessionId: sid, time: d.times, note: d.note });
    d.times.forEach(t => { if (!(p.times || []).includes(t)) p.times = (p.times || []).concat(t); });
    await savePhotosFromDraft(d, p.id, '', sid);
  }
  await saveItem(p);
  S.draft = null; closeSheet(); render();
  toast(d.visitId ? 'Visit updated' : 'Visit ' + p.visits.length + ' logged');
}

// surprise
function surprise() {
  const a = activeSession();
  const ps = places().filter(p => p.id !== S.placeId);
  if (!ps.length) { toast('Save a few more places first'); return; }
  const weighted = [];
  ps.forEach(p => {
    const lv = lastVisit(p);
    if (a && lv.sessionId === a.id) return;
    let w = p.mark === 'back' ? 3 : p.mark === 'fav' ? 2 : 1;
    w += Math.min(3, Math.floor((Date.now() - lv.at) / (2 * 86400000)));
    for (let i = 0; i < w; i++) weighted.push(p);
  });
  const pool = weighted.length ? weighted : ps;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  S.surprise = true;
  openPlace(pick.id);
}
function openPlace(id) {
  if (S.tab !== 'place') { S.prevTab = S.tab; pushLayer('place'); }
  S.tab = 'place'; S.placeId = id;
  render(); $('#view').scrollTop = 0;
}

// ---------- photo viewer ----------
function openViewer(id, set) {
  let list;
  if (set === 'place') list = photosFor(byId(id).placeId);
  else list = S.items.filter(i => i.type === 'photo').sort((a, b) => b.createdAt - a.createdAt);
  S.viewer = { list: list.map(p => p.id), i: Math.max(0, list.findIndex(p => p.id === id)) };
  pushLayer('viewer');
  renderViewer();
  $('#viewer').classList.remove('hidden');
}
function renderViewer() {
  const v = S.viewer; const p = byId(v.list[v.i]);
  if (!p) { hideViewer(); return; }
  $('#viewer').innerHTML = `<div class="vtop">
      <button class="icon-btn" data-act="vClose" aria-label="Close">${I.x}</button>
      <span style="align-self:center;color:var(--muted);font-size:13px">${v.i + 1} / ${v.list.length}</span>
      <button class="icon-btn" data-act="vDel" aria-label="Delete photo" style="color:#F08BA0">${sv('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', 18)}</button></div>
    <div class="vimg"><img data-blob="${p.blobId}" alt="${esc(p.caption || 'In-game photo')}"></div>
    <div class="vbot">
      <div class="two"><button class="ghost" data-act="vPrev" ${v.i ? '' : 'disabled'}>‹ Newer</button><button class="ghost" data-act="vNext" ${v.i < v.list.length - 1 ? '' : 'disabled'}>Older ›</button></div>
      <div class="field"><label class="label" for="vCap">Caption</label><input id="vCap" value="${esc(p.caption || '')}" placeholder="Add a caption"></div>
      <div class="field"><label class="label" for="vPlace">Place</label><select id="vPlace">${placeOptions(p.placeId)}</select></div>
      <div style="font-size:12px;color:var(--muted)">${ago(p.createdAt)}${p.sessionId ? ' · ' + sessionLabel(p.sessionId) : ''}</div>
    </div>`;
  hydrate($('#viewer'));
  let capT; $('#vCap').oninput = e => { clearTimeout(capT); const val = e.target.value.trim(); capT = setTimeout(async () => { p.caption = val; await saveItem(p); }, 400); };
  $('#vPlace').onchange = async e => { p.placeId = e.target.value; await saveItem(p); toast('Linked'); };
}
function hideViewer() { S.viewer = null; $('#viewer').classList.add('hidden'); $('#viewer').innerHTML = ''; render(); }

// ---------- map ----------
const M = { img: null, W: 1000, H: 1300, s: 1, ox: 0, oy: 0, fit: 1, dpr: 1, canvas: null, ctx: null, off: document.createElement('canvas'),
  ptrs: new Map(), drag: null, pinch: null, moved: false, temp: null, inited: false, raf: 0 };
async function loadMapImage() {
  const rec = await idb.get('blobs', 'map');
  M.img = null; M.W = 1000; M.H = 1300;
  if (rec) {
    const img = new Image();
    await new Promise(r => { img.onload = r; img.onerror = r; img.src = URL.createObjectURL(rec.blob); });
    if (img.naturalWidth) { M.img = img; M.W = img.naturalWidth; M.H = img.naturalHeight; }
  }
  M.inited = false;
}
function mapPins() {
  const f = S.mapFilter;
  return places().filter(p => p.pin).filter(p => f === 'all' || (f === 'fav' && p.mark === 'fav') || (f === 'back' && p.mark === 'back') || (p.times || []).includes(f));
}
function renderMap() {
  const n = places().filter(p => p.pin).length;
  const pinMode = S.mapMode === 'pin';
  const chips = [['all', 'All'], ['fav', '★ Favourites'], ['back', '↻ Come back'], ['Night', 'Best at night'], ['Dawn', 'Best at dawn'], ['Dusk', 'Best at dusk'], ['Day', 'Best by day']]
    .map(([v, l]) => `<button class="chip ${S.mapFilter === v ? 'on' : ''}" data-act="mapFilter" data-v="${v}">${l}</button>`).join('');
  return `<div id="mapwrap"><canvas id="mapc"></canvas>
    <div class="maptop"><div class="brand">My Leonida</div>
      <div style="font-size:13px;color:var(--muted);margin-top:4px">${pinMode ? 'Pin mode' : n + (n === 1 ? ' place' : ' places') + ' uncovered · the rest stays dark'}</div>
      ${pinMode ? '' : `<div class="hscroll">${chips}</div>`}</div>
    ${!n && !pinMode ? '<div class="maphint">Your map is dark.<br>Pin places as you find them and it slowly fills in.</div>' : ''}
    <div class="mapzoom"><button data-act="zin" aria-label="Zoom in">+</button><button data-act="zout" aria-label="Zoom out">−</button></div>
    <div id="mapbottom">${mapBottomHTML()}</div></div>`;
}
function mapBottomHTML() {
  if (S.mapMode === 'pin') {
    const name = S.pinReturn === 'capture' ? (S.draft && S.draft.name) : (byId(S.pinPlace) || {}).name;
    return `<div class="mapbar"><div class="typed">${M.temp ? 'Pin placed. Drag the map or tap again to adjust.' : `Glance at the in-game map, then tap roughly where <b>${esc(name || 'this place')}</b> is.`}</div>
      <div class="two"><button data-act="pinCancel" style="background:transparent;border:1.5px solid var(--ink);color:var(--ink)">Cancel</button>
      <button data-act="pinSave" style="background:var(--pink);color:var(--bg)" ${M.temp ? '' : 'disabled'}>Save pin</button></div></div>`;
  }
  const p = S.mapSel && byId(S.mapSel);
  if (!p) return '';
  const ph = photosFor(p.id)[0];
  const bits = [(p.times || []).length ? 'Best at ' + p.times.join('/').toLowerCase() : '', (p.visits || []).length + ' visit' + ((p.visits || []).length === 1 ? '' : 's'), (n => n ? n + (n === 1 ? ' photo' : ' photos') : '')(photosFor(p.id).length)].filter(Boolean).join(' · ');
  return `<button class="mapcard" data-act="openPlace" data-id="${p.id}">
    <div class="pol">${ph ? `<img class="ph" data-blob="${ph.blobId}" alt="">` : '<div class="ph"></div>'}</div>
    <div class="body" style="flex:1;min-width:0"><div style="font-size:15px;font-weight:700">${esc(p.name)}</div>
      <div style="font-size:12px;margin-top:4px">${p.area ? `<span style="color:var(--teal);font-weight:600">${esc(p.area)}</span> ` : ''}${p.mark === 'back' ? '<span style="color:var(--orange)">↻ Come back</span>' : p.mark === 'fav' ? '<span style="color:var(--pink)">★ Favourite</span>' : ''}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:4px">${bits}</div></div>${I.chev}</button>`;
}
function updateMapBottom() { const el = $('#mapbottom'); if (el) { el.innerHTML = mapBottomHTML(); hydrate(el); } }
function toScreen(nx, ny) { return [M.ox + nx * M.W * M.s, M.oy + ny * M.H * M.s]; }
function toNorm(sx, sy) { return [(sx - M.ox) / (M.W * M.s), (sy - M.oy) / (M.H * M.s)]; }
function sizeCanvas() {
  const c = M.canvas; if (!c) return;
  const r = c.getBoundingClientRect();
  M.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  c.width = Math.max(1, Math.round(r.width * M.dpr)); c.height = Math.max(1, Math.round(r.height * M.dpr));
  M.cw = r.width; M.ch = r.height;
  const fit = Math.min(r.width / M.W, (r.height - 120) / M.H) * 0.95;
  if (!M.inited || !isFinite(M.s)) {
    M.fit = fit; M.s = fit;
    M.ox = (r.width - M.W * M.s) / 2; M.oy = 120 + (r.height - 120 - M.H * M.s) / 2;
    M.inited = true;
  } else M.fit = fit;
}
function setupMap() {
  M.canvas = $('#mapc'); M.ctx = M.canvas.getContext('2d');
  sizeCanvas();
  if (S.mapFocus) {
    const p = byId(S.mapFocus);
    if (p && p.pin) { M.s = Math.max(M.s, M.fit * 2.5); const [sx, sy] = toScreen(p.pin.x, p.pin.y); M.ox += M.cw / 2 - sx; M.oy += M.ch * 0.45 - sy; }
    S.mapFocus = null;
  }
  if (S.mapFocusPt) {
    const pt = S.mapFocusPt; M.s = Math.max(M.s, M.fit * 2.5);
    const [sx, sy] = toScreen(pt.x, pt.y); M.ox += M.cw / 2 - sx; M.oy += M.ch * 0.45 - sy;
    S.mapFocusPt = null;
  }
  const c = M.canvas;
  c.onpointerdown = e => {
    c.setPointerCapture(e.pointerId);
    M.ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (M.ptrs.size === 1) { M.drag = { x: e.offsetX, y: e.offsetY, ox: M.ox, oy: M.oy }; M.moved = false; M.pinch = null; }
    if (M.ptrs.size === 2) {
      const [a, b] = Array.from(M.ptrs.values());
      M.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s: M.s, ox: M.ox, oy: M.oy };
      M.moved = true;
    }
  };
  c.onpointermove = e => {
    if (!M.ptrs.has(e.pointerId)) return;
    M.ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (M.ptrs.size >= 2 && M.pinch) {
      const [a, b] = Array.from(M.ptrs.values());
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const s = clampScale(M.pinch.s * d / M.pinch.d);
      const wx = (M.pinch.mx - M.pinch.ox) / M.pinch.s, wy = (M.pinch.my - M.pinch.oy) / M.pinch.s;
      M.s = s; M.ox = mx - wx * s; M.oy = my - wy * s;
      queueDraw();
    } else if (M.drag) {
      const dx = e.offsetX - M.drag.x, dy = e.offsetY - M.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) M.moved = true;
      if (M.moved) { M.ox = M.drag.ox + dx; M.oy = M.drag.oy + dy; queueDraw(); }
    }
  };
  const up = e => {
    if (!M.ptrs.has(e.pointerId)) return;
    M.ptrs.delete(e.pointerId);
    if (M.ptrs.size === 1) { const r = Array.from(M.ptrs.values())[0]; M.drag = { x: r.x, y: r.y, ox: M.ox, oy: M.oy }; M.pinch = null; return; }
    if (M.ptrs.size === 0) { if (!M.moved && e.type === 'pointerup') mapTap(e.offsetX, e.offsetY); M.drag = null; M.pinch = null; }
  };
  c.onpointerup = up; c.onpointercancel = up;
  c.onwheel = e => { e.preventDefault(); zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.15 : 1 / 1.15); };
  drawMap();
}
function clampScale(s) { return Math.min(M.fit * 12, Math.max(M.fit * 0.6, s)); }
function zoomAt(x, y, f) {
  const s = clampScale(M.s * f); const wx = (x - M.ox) / M.s, wy = (y - M.oy) / M.s;
  M.s = s; M.ox = x - wx * s; M.oy = y - wy * s; queueDraw();
}
function queueDraw() { if (!M.raf) M.raf = requestAnimationFrame(() => { M.raf = 0; drawMap(); }); }
function mapTap(x, y) {
  if (S.mapMode === 'pin') {
    const [nx, ny] = toNorm(x, y);
    M.temp = { x: Math.min(1, Math.max(0, nx)), y: Math.min(1, Math.max(0, ny)) };
    drawMap(); updateMapBottom(); return;
  }
  let hit = null, best = 26;
  for (const p of mapPins()) { const [sx, sy] = toScreen(p.pin.x, p.pin.y); const d = Math.hypot(sx - x, sy - y); if (d < best) { best = d; hit = p; } }
  S.mapSel = hit ? hit.id : null;
  drawMap(); updateMapBottom();
}
function drawMap() {
  const c = M.canvas; if (!c) return;
  const ctx = M.ctx, dpr = M.dpr, cw = M.cw, ch = M.ch;
  const pinMode = S.mapMode === 'pin';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0B0A0F'; ctx.fillRect(0, 0, cw, ch);
  ctx.fillStyle = '#1C1924';
  const step = 14, offx = ((M.ox % step) + step) % step, offy = ((M.oy % step) + step) % step;
  for (let x = offx; x < cw; x += step) for (let y = offy; y < ch; y += step) ctx.fillRect(x, y, 1.4, 1.4);
  const mw = M.W * M.s, mh = M.H * M.s;
  if (pinMode) {
    if (M.img) { ctx.globalAlpha = 0.4; ctx.drawImage(M.img, M.ox, M.oy, mw, mh); ctx.globalAlpha = 1; }
    else { ctx.fillStyle = '#15131B'; ctx.fillRect(M.ox, M.oy, mw, mh); }
    ctx.strokeStyle = '#3A3245'; ctx.lineWidth = 1; ctx.strokeRect(M.ox, M.oy, mw, mh);
  }
  // reveal circles
  const pts = places().filter(p => p.pin).map(p => p.pin);
  if (pinMode && M.temp) pts.push(M.temp);
  if (pts.length) {
    const off = M.off; off.width = c.width; off.height = c.height;
    const o = off.getContext('2d'); o.setTransform(dpr, 0, 0, dpr, 0, 0);
    const R = Math.max(40, 0.085 * Math.min(mw, mh * 1.3));
    for (const pt of pts) {
      const [sx, sy] = toScreen(pt.x, pt.y);
      const g = o.createRadialGradient(sx, sy, 0, sx, sy, R);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.5, 'rgba(255,255,255,0.95)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      o.fillStyle = g; o.beginPath(); o.arc(sx, sy, R, 0, Math.PI * 2); o.fill();
    }
    o.globalCompositeOperation = 'source-in';
    if (M.img) o.drawImage(M.img, M.ox, M.oy, mw, mh);
    else { o.fillStyle = '#1F3338'; o.fillRect(0, 0, cw, ch); }
    o.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(off, 0, 0); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  // pins
  const pins = pinMode ? places().filter(p => p.pin && p.id !== S.pinPlace) : mapPins();
  for (const p of pins) {
    const [sx, sy] = toScreen(p.pin.x, p.pin.y);
    const sel = p.id === S.mapSel;
    const col = p.mark === 'fav' ? '#F2789A' : p.mark === 'back' ? '#F0A35E' : '#EDE2CC';
    if (sel) { ctx.fillStyle = 'rgba(240,163,94,0.25)'; ctx.beginPath(); ctx.arc(sx, sy, 22, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = sel ? '#EDE2CC' : '#0B0A0F'; ctx.beginPath(); ctx.arc(sx, sy, sel ? 13 : 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(sx, sy, sel ? 9 : 7, 0, Math.PI * 2); ctx.fill();
  }
  if (pinMode && M.temp) {
    const [sx, sy] = toScreen(M.temp.x, M.temp.y);
    ctx.fillStyle = '#EDE2CC'; ctx.beginPath(); ctx.arc(sx, sy, 14, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#F2789A'; ctx.beginPath(); ctx.arc(sx, sy, 9, 0, Math.PI * 2); ctx.fill();
  }
}
window.addEventListener('resize', () => { if (M.canvas) { sizeCanvas(); drawMap(); } });

function startPinMode(ret, placeId) {
  S.pinReturn = ret; S.pinPlace = placeId || null;
  S.pinPrevTab = S.tab === 'place' ? S.prevTab : S.tab;
  const existing = ret === 'capture' ? S.draft.pin : (byId(placeId) || {}).pin;
  M.temp = existing ? Object.assign({}, existing) : null;
  if (S.tab === 'place') history.replaceState({ layer: 'pin' }, ''); else pushLayer('pin');
  S.mapMode = 'pin'; S.tab = 'map'; S.mapSel = null;
  if (existing) S.mapFocusPt = existing;
  render();
}
async function finishPin(save) {
  const pt = M.temp; S.mapMode = 'view'; M.temp = null;
  if (S.pinReturn === 'capture') {
    if (save && pt) S.draft.pin = pt;
    S.tab = S.pinPrevTab; render(); openSheet(captureHTML);
  } else {
    const p = byId(S.pinPlace);
    if (save && pt && p) { p.pin = pt; await saveItem(p); toast('Pinned. A little more of Leonida uncovered.'); }
    if (p) { S.tab = S.pinPrevTab; openPlace(p.id); } else { S.tab = 'map'; render(); }
  }
}

// ---------- backup ----------
const toDataURL = blob => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
async function exportData(share) {
  toast('Packing your journal…');
  const blobs = await idb.all('blobs');
  const enc = [];
  for (const b of blobs) enc.push({ id: b.id, data: await toDataURL(b.blob) });
  const data = { app: 'leonida-journal', version: 1, exportedAt: new Date().toISOString(), items: S.items, sessions: S.sessions, meta: S.meta, blobs: enc };
  const name = 'leonida-journal-' + new Date().toISOString().slice(0, 10) + '.json';
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  try {
    if (share && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Leonida Journal backup' });
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    await setMeta('lastBackup', Date.now());
    render(); toast('Backup ready');
  } catch (e) { if (e && e.name !== 'AbortError') toast('Backup didn’t finish: ' + e.message); }
}
async function importData() {
  const files = await pickFiles('#backupPick'); if (!files.length) return;
  let data;
  try { data = JSON.parse(await files[0].text()); } catch (e) { toast('That file isn’t a journal backup'); return; }
  if (!data || data.app !== 'leonida-journal') { toast('That file isn’t a Leonida Journal backup'); return; }
  if (!confirm('Replace everything in this journal with the backup from ' + (data.exportedAt || '').slice(0, 10) + '?')) return;
  for (const s of ['items', 'sessions', 'meta', 'blobs']) await idb.clear(s);
  for (const it of data.items || []) await idb.put('items', it);
  for (const s of data.sessions || []) await idb.put('sessions', s);
  for (const k in (data.meta || {})) await idb.put('meta', { key: k, value: data.meta[k] });
  for (const b of data.blobs || []) { const blob = await (await fetch(b.data)).blob(); await idb.put('blobs', { id: b.id, blob }); }
  urlCache.forEach(u => URL.revokeObjectURL(u)); urlCache.clear();
  await loadAll(); await loadMapImage();
  S.tab = 'home'; render(); toast('Journal restored');
}

// ---------- shared photos (from PS App share sheet) ----------
// Turns text shared from Shazam, Google, YouTube Music, Spotify etc. into a song title + artist.
function parseSong(raw) {
  let t = String(raw || '').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(i used shazam to discover|check out|listen to|now playing:?|i'?m listening to)\s+/i, '')
       .replace(/\s*(on|via) (shazam|spotify|youtube music|youtube|apple music|soundcloud|google)\b.*$/i, '')
       .replace(/[.!\s]+$/, '');
  let m = t.match(/^["“]?(.+?)["”]?\s+by\s+(.+)$/i);
  if (m) return { title: m[1].trim(), artist: m[2].trim() };
  m = t.match(/^(.+?)\s+[-–—·]\s+(.+)$/);
  if (m) return { title: m[1].trim(), artist: m[2].trim() };
  return { title: t, artist: '' };
}
async function checkInbox() {
  const inbox = await idb.all('inbox');
  if (!inbox.length) return;
  const photos = []; let song = null;
  for (const rec of inbox) {
    if (rec.file) { const b = await compress(rec.file); photos.push({ blob: b, url: URL.createObjectURL(b) }); }
    else if (rec.text && !song) song = parseSong(rec.text);
    await idb.del('inbox', rec.id);
  }
  if (photos.length) openCapture('photo', null, { photos });
  else if (song) { openCapture('song', null, song); toast('Got it from the share. Add the station?'); }
}

// ---------- events ----------
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act],[data-tab]');
  if (!t || t.disabled) return;
  const act = t.dataset.act, v = t.dataset.v, id = t.dataset.id;
  if (t.dataset.tab) { if (S.tab === 'feed' || S.tab === 'settings') { ignorePops = 1; history.back(); } S.tab = t.dataset.tab; S.surprise = false; if (S.mapMode === 'pin' && S.tab !== 'map') { S.mapMode = 'view'; M.temp = null; } render(); $('#view').scrollTop = 0; return; }
  const p = S.tab === 'place' ? byId(S.placeId) : null;
  switch (act) {
    case 'tab': if (v === 'home' && (S.tab === 'feed' || S.tab === 'settings')) history.back(); else { S.tab = v; render(); } break;
    case 'new': openCapture('place'); break;
    case 'newSong': openCapture('song'); break;
    case 'newPhoto': openCapture('photo'); setTimeout(addDraftPhotos, 250); break;
    case 'settings': openSub('settings'); break;
    case 'seeAll': openSub('feed'); break;
    case 'startSession': startSession(); break;
    case 'endSession': endSessionSheet(); break;
    case 'eSave': endSessionSave(); break;
    case 'editNext': nextSheet(); break;
    case 'nSave': { const txt = ($('#nText').value || '').trim(); await setMeta('nextTime', txt ? { text: txt, fromN: null, at: Date.now() } : null); closeSheet(); render(); break; }
    case 'nClear': await setMeta('nextTime', null); closeSheet(); render(); toast('Crossed off'); break;
    case 'surprise': surprise(); break;
    case 'surpriseNext': if (p) { await setMeta('nextTime', { text: 'Go back to ' + p.name + (p.area ? ' in ' + p.area : '') + ((p.times || []).length ? ', at ' + p.times.join(' or ').toLowerCase() : '') + '.', fromN: null, at: Date.now() }); S.surprise = false; render(); toast('Set as next time'); } break;
    case 'openPlace': openPlace(id); break;
    case 'openItem': { const it = byId(id); if (!it) break; if (it.type === 'place') openPlace(id); else if (it.type === 'photo') openViewer(id, 'all'); else openCapture(it.type, it); break; }
    case 'feedFilter': S.feedFilter = v; render(); break;
    case 'mapFilter': S.mapFilter = v; S.mapSel = null; render(); break;
    case 'back': history.back(); break;
    case 'favToggle': p.mark = p.mark === 'fav' ? 'found' : 'fav'; await saveItem(p); render(); break;
    case 'backToggle': p.mark = p.mark === 'back' ? 'found' : 'back'; await saveItem(p); render(); break;
    case 'placeTime': p.times = (p.times || []).includes(v) ? p.times.filter(x => x !== v) : (p.times || []).concat(v); await saveItem(p); render(); break;
    case 'placeRain': p.rain = !p.rain; await saveItem(p); render(); break;
    case 'editPlace': openCapture('place', p); break;
    case 'addPlacePhoto': {
      const files = await pickFiles('#filePick'); if (!files.length) break;
      const a = activeSession();
      for (const f of files) { const b = await compress(f); const blobId = await storeBlob(b); await saveItem({ id: uid(), type: 'photo', blobId, caption: '', placeId: p.id, createdAt: Date.now(), sessionId: a ? a.id : null }); }
      render(); toast('Photo added'); break;
    }
    case 'imBack': visitSheet(p, null); break;
    case 'editVisit': visitSheet(p, p.visits.find(x => x.id === id)); break;
    case 'onMap': if (p.pin) { S.mapSel = p.id; S.mapFocus = p.id; S.mapFilter = 'all'; S.tab = 'map'; S.surprise = false; history.replaceState({ layer: 'root' }, ''); render(); } else startPinMode('place', p.id); break;
    case 'photoView': openViewer(id, t.dataset.set); break;
    case 'vClose': history.back(); break;
    case 'vPrev': S.viewer.i--; renderViewer(); break;
    case 'vNext': S.viewer.i++; renderViewer(); break;
    case 'vDel': {
      if (!confirm('Delete this photo?')) break;
      const pid = S.viewer.list[S.viewer.i]; await deleteItem(pid);
      S.viewer.list.splice(S.viewer.i, 1); if (S.viewer.i >= S.viewer.list.length) S.viewer.i--;
      if (!S.viewer.list.length) history.back(); else renderViewer();
      toast('Photo deleted'); break;
    }
    case 'zin': zoomAt(M.cw / 2, M.ch / 2, 1.4); break;
    case 'zout': zoomAt(M.cw / 2, M.ch / 2, 1 / 1.4); break;
    case 'pinCancel': S.pinSaveFlag = false; history.back(); break;
    case 'pinSave': S.pinSaveFlag = true; history.back(); break;
    case 'exportFile': exportData(false); break;
    case 'exportShare': exportData(true); break;
    case 'importFile': importData(); break;
    case 'setMap': {
      const files = await pickFiles('#mapPick'); if (!files.length) break;
      toast('Loading map…');
      const b = await compress(files[0], 4096); await storeBlob(b, 'map'); await loadMapImage(); render(); toast('Map image set'); break;
    }
    case 'removeMap': if (confirm('Remove the map image? Your pins stay.')) { await idb.del('blobs', 'map'); await loadMapImage(); render(); } break;
    case 'rmArea': { const c = (S.meta.customAreas || []).filter(a => a !== v); await setMeta('customAreas', c); render(); break; }
    // sheet: capture
    case 'closeSheet': closeSheet(); break;
    case 'cType': readForm(); S.draft.type = v; renderSheet(); break;
    case 'cKind': readForm(); S.draft.kind = S.draft.kind === v ? '' : v; renderSheet(); break;
    case 'cKindOther': {
      readForm(); const k = (prompt('What kind of place?') || '').trim(); if (!k) break;
      const ck = (S.meta.customKinds || []).slice(); if (!KINDS.includes(k) && !ck.includes(k)) { ck.push(k); await setMeta('customKinds', ck); }
      S.draft.kind = k; renderSheet(); break;
    }
    case 'cMark': readForm(); S.draft.mark = v; renderSheet(); break;
    case 'cTime': readForm(); S.draft.times = S.draft.times.includes(v) ? S.draft.times.filter(x => x !== v) : S.draft.times.concat(v); renderSheet(); break;
    case 'cRain': readForm(); S.draft.rain = !S.draft.rain; renderSheet(); break;
    case 'cPhoto': addDraftPhotos(); break;
    case 'rmPhoto': readForm(); S.draft.photos.splice(+v, 1); renderSheet(); break;
    case 'cPin': readForm(); history.back(); setTimeout(() => startPinMode('capture'), 80); break;
    case 'keepArea': S.draft.areaKeep = true; $('#areaStat').innerHTML = areaStatHTML(S.draft); break;
    case 'cSave': saveCapture(); break;
    case 'cDelete': deleteFromDraft(); break;
    // sheet: visits
    case 'vTime': S.draft.note = ($('#vNote').value || ''); S.draft.times = S.draft.times.includes(v) ? S.draft.times.filter(x => x !== v) : S.draft.times.concat(v); renderSheet(); break;
    case 'vPhoto': {
      S.draft.note = ($('#vNote').value || '');
      const files = await pickFiles('#filePick');
      for (const f of files) { const b = await compress(f); S.draft.photos.push({ blob: b, url: URL.createObjectURL(b) }); }
      renderSheet(); break;
    }
    case 'vSave': saveVisit(); break;
    case 'vDelete': {
      if (!confirm('Delete this visit note?')) break;
      const pl = byId(S.draft.visitPlace); pl.visits = pl.visits.filter(x => x.id !== S.draft.visitId); await saveItem(pl);
      S.draft = null; closeSheet(); render(); break;
    }
  }
});
document.addEventListener('input', e => {
  if (e.target.id === 'cArea' && S.draft) { S.draft.area = e.target.value; S.draft.areaKeep = false; const st = $('#areaStat'); if (st) st.innerHTML = areaStatHTML(S.draft); }
  if (e.target.id === 'feedSearch') {
    S.feedQuery = e.target.value;
    const el = $('#feedList'); if (el) { el.innerHTML = feedListHTML(); hydrate(el); }
  }
});
$('#scrim').addEventListener('click', closeSheet);
// Swipe the sheet down to close it.
(function () {
  const sh = $('#sheet'); let y0 = null, dy = 0, active = false;
  sh.addEventListener('touchstart', e => {
    if (sh.scrollTop > 0 || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) { y0 = null; return; }
    y0 = e.touches[0].clientY; dy = 0; active = false;
  }, { passive: true });
  sh.addEventListener('touchmove', e => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 8 && sh.scrollTop <= 0) { active = true; sh.style.transition = 'none'; sh.style.transform = 'translateY(' + dy + 'px)'; e.preventDefault(); }
  }, { passive: false });
  sh.addEventListener('touchend', () => {
    if (y0 == null) return;
    sh.style.transition = ''; sh.style.transform = '';
    if (active && dy > 110) closeSheet();
    y0 = null; active = false;
  });
})();

// ---------- boot ----------
async function loadAll() {
  S.items = await idb.all('items');
  S.sessions = await idb.all('sessions');
  const meta = await idb.all('meta');
  S.meta = {}; meta.forEach(m => { S.meta[m.key] = m.value; });
}
async function boot() {
  try { db = await openDB(); } catch (e) {
    $('#view').innerHTML = '<div class="wrap"><div class="empty" style="margin-top:40px">This browser won’t let the journal store data here. Open it in Chrome on your phone.</div></div>';
    return;
  }
  history.replaceState({ layer: 'root' }, '', location.search.includes('shared') ? location.pathname : location.href);
  await loadAll();
  await loadMapImage();
  render();
  await checkInbox();
  setInterval(() => { if (S.tab === 'home' && activeSession() && !S.sheetOpen) render(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkInbox(); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
