// Service worker MÍNIMO — su única misión real es el SHARE TARGET (Task 1): recibir ficheros
// compartidos desde otra app (Adobe Scan / Lens / cámara «documento» → PDF, o imágenes), guardarlos
// en una Cache temporal y redirigir a la app, que los sube al Inbox con su token. NO cachea la app
// (la API necesita datos en vivo); el handler de fetch existe sobre todo para ser "instalable".
const SHARE_CACHE = 'compartidos-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (req.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(recibirCompartido(event));
    return;
  }
  // Resto: red directa (sin caché). Dejar pasar.
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
