/**
 * a4a's service worker (docs/architecture.md, D47). The build writes it as /sw.js (vite.config.ts),
 * with BUILD, the build's own id, and SHELL, the files of the app shell, above this.
 *
 * What it keeps, and why that's safe:
 * - Only the app shell: index.html and the build's own files (scripts, styles, fonts), its icons
 *   and manifest. They're the same for everyone and hold nobody's data: what a person sees comes
 *   from the API, and the API is never kept here. So nothing outlives a sign-out, and nothing of
 *   one person's is ever shown to another on the same device.
 * - A page is the network's when it answers within a few seconds, and the kept shell's otherwise:
 *   then a4a opens offline, or on a poor connection, and says so, rather than failing.
 * - A new build is fetched and kept beside the old one, and takes over on the next start, or when
 *   the page asks ("a new version is ready"); the old one's files go then.
 *
 * Push: what a push carries is drawn as a notification, one per issue (its tag), and tapping it
 * opens the issue in a4a's window, or a new one. The badge follows what's unread.
 */
/* global BUILD, SHELL */
const CACHE = `a4a-shell-${BUILD}`;
/** Paths that are always the network's, never kept: the API, MCP, provisioning, sign-in flows. */
const NEVER = /^\/(api|mcp|scim|oauth|\.well-known)(\/|$)/;
/** How long a page waits for the network before the kept shell answers. */
const PATIENCE_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('a4a-shell-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  // The page's "Reload" on "a new version is ready": this build takes over now.
  if (event.data && event.data.type === 'take-over') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || NEVER.test(url.pathname)) return;
  if (request.mode === 'navigate') {
    event.respondWith(page(request));
    return;
  }
  if (SHELL.includes(url.pathname)) event.respondWith(kept(request, url.pathname));
});

/** A page: the network's within PATIENCE_MS, else the kept shell, which the app then fills. */
async function page(request) {
  const network = fetch(request);
  network.catch(() => {}); // answered by the shell when it's late; its failure is no news then
  const shell = async () => (await caches.open(CACHE)).match('/index.html');
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), PATIENCE_MS);
  });
  try {
    const answer = await Promise.race([network, late]);
    if (answer) return answer;
    return (await shell()) || (await network);
  } catch {
    return (await shell()) || Response.error();
  } finally {
    clearTimeout(timer);
  }
}

/** A file of the shell: kept, so it's there offline; fetched if this build somehow lacks it. */
async function kept(request, path) {
  const cache = await caches.open(CACHE);
  return (await cache.match(path)) || fetch(request);
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const shown = self.registration.showNotification(data.title || 'a4a', {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: Boolean(data.tag && data.renotify),
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/inbox' },
  });
  const badge = typeof data.unread === 'number' && 'setAppBadge' in self.navigator ? setBadge(data.unread) : null;
  event.waitUntil(Promise.all([shown, badge]));
});

function setBadge(n) {
  return (n > 0 ? self.navigator.setAppBadge(n) : self.navigator.clearAppBadge()).catch(() => {});
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || '/inbox';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        // The app opens it in place, as a link within it would.
        await open.focus();
        open.postMessage({ type: 'open', url: path });
        return;
      }
      await self.clients.openWindow(path);
    })(),
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // The browser renewed the subscription: tell a4a the new one, in place of the old, while the
  // sign-in that turned push on lasts (a4a refuses it otherwise, and push is off until turned on).
  event.waitUntil(
    (async () => {
      const key = await fetch('/api/v1/push/key', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null));
      if (!key || !key.publicKey) return;
      const subscription =
        event.newSubscription || (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(key.publicKey) }));
      await fetch('/api/v1/push/devices', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...subscription.toJSON(), ...(event.oldSubscription ? { oldEndpoint: event.oldSubscription.endpoint } : {}) }),
      });
    })().catch(() => {}),
  );
});

function fromBase64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
