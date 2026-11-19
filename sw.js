/* Leonida Journal service worker: offline shell + receives photos shared from other apps. */
const CACHE = 'leonida-v1';
const SHELL = ['./', 'index.html', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('leonida-journal', 1);
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
async function stashShared(request) {
  const form = await request.formData();
  const files = form.getAll('photos').filter(f => f && typeof f !== 'string');
  if (files.length) {
    const db = await openDB();
    await new Promise((res, rej) => {
      const t = db.transaction('inbox', 'readwrite');
      files.forEach(f => t.objectStore('inbox').add({ file: f, name: f.name, at: Date.now() }));
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  }
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(stashShared(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;
  // Fonts: cache after first load so the look survives offline.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  // App files: serve from cache, refresh in the background.
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(res => { if (res.ok) c.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
