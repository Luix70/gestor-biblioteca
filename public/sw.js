// Service worker: (1) SHARE TARGET (recibir ficheros compartidos de Adobe Scan/Lens/cámara → Inbox) y
// (2) CACHÉ DE LA APP para que cargue SIN RED (NFC offline: ver dónde recolocar un libro sin servidor).
// Estrategia NETWORK-FIRST para la "cáscara" (HTML + estáticos): online siempre trae lo último (los
// despliegues se ven al instante), y solo si no hay red se sirve la copia cacheada. La API (/api) y los
// recursos en vivo (/recursos) NUNCA se cachean (necesitan datos frescos).
const SHARE_CACHE = 'compartidos-v1';
const APP_CACHE = 'app-v2';
const PRECACHE = ['/', '/index.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(PRECACHE).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.filter((k) => k !== APP_CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (req.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(recibirCompartido(event));
    return;
  }
  if (req.method !== 'GET' || url.origin !== location.origin) return;          // otros orígenes / mutaciones: red directa
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/recursos/')) return; // datos en vivo: nunca caché
  // Cáscara de la app + estáticos: NETWORK-FIRST con respaldo en caché (para cargar sin red).
  event.respondWith((async () => {
    try {
      const net = await fetch(req);
      if (net && net.ok) { const c = await caches.open(APP_CACHE); c.put(req, net.clone()); }
      return net;
    } catch (_) {
      const hit = await caches.match(req);
      if (hit) return hit;
      if (req.mode === 'navigate') {                                            // navegación offline → index cacheado
        const idx = (await caches.match('/index.html')) || (await caches.match('/'));
        if (idx) return idx;
      }
      throw _;
    }
  })());
});

async function recibirCompartido(event) {
  try {
    const fd = await event.request.formData();
    const files = fd.getAll('files').filter((f) => f && f.size);
    const cache = await caches.open(SHARE_CACHE);
    for (const k of await cache.keys()) await cache.delete(k);   // limpiar restos
    const metas = [];
    let i = 0;
    for (const f of files) {
      const tipo = f.type || 'application/octet-stream';
      const ext = tipo === 'application/pdf' ? '.pdf' : (tipo.startsWith('image/') ? '.' + (tipo.split('/')[1] || 'jpg') : '');
      const nombre = f.name || ('compartido-' + Date.now() + '-' + i + ext);
      await cache.put(new Request('/__shared__/' + i), new Response(f, { headers: { 'Content-Type': tipo } }));
      metas.push({ i, nombre, type: tipo });
      i++;
    }
    await cache.put(new Request('/__shared__/index.json'),
      new Response(JSON.stringify(metas), { headers: { 'Content-Type': 'application/json' } }));
    return Response.redirect('/?compartido=1', 303);
  } catch (_) {
    return Response.redirect('/?compartido=error', 303);
  }
}
