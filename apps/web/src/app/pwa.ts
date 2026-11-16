/**
 * a4a as an installed app (docs/architecture.md, D47): its service worker, a new version waiting
 * to take over, and whether the device is online. The worker itself is sw/service-worker.js.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';

const listeners = new Set<() => void>();
let waiting: ServiceWorker | null = null;
let askedToTakeOver = false;

function setWaiting(worker: ServiceWorker | null) {
  waiting = worker;
  for (const l of listeners) l();
}

/** Register the service worker, in a build (the dev server has none), and watch for new versions. */
export function startServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  // Reload when the version the page asked for takes over; not when the first one takes charge.
  sw.addEventListener('controllerchange', () => {
    if (askedToTakeOver) window.location.reload();
  });
  window.addEventListener('load', () => {
    sw.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((registration) => {
        // A new version is ready when it has installed beside one already in charge.
        const watch = (worker: ServiceWorker | null) => {
          if (!worker) return;
          const check = () => {
            if (worker.state === 'installed' && sw.controller) setWaiting(worker);
          };
          worker.addEventListener('statechange', check);
          check();
        };
        watch(registration.waiting);
        registration.addEventListener('updatefound', () => watch(registration.installing));
        // Look for a new build hourly, and when a4a comes back to the front.
        const look = () => void registration.update().catch(() => {});
        setInterval(look, 60 * 60_000);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') look();
        });
      })
      .catch(() => {
        // Without it, a4a works as a page: no offline shell, no push.
      });
  });
}

/** Take the new version now: it takes over, and the page reloads into it. */
export function takeNewVersion(): void {
  if (!waiting) {
    window.location.reload();
    return;
  }
  askedToTakeOver = true;
  waiting.postMessage({ type: 'take-over' });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Whether a new version of a4a has installed and waits for the next start. */
export const useNewVersionReady = () => useSyncExternalStore(subscribe, () => waiting !== null, () => false);

const onOnline = (l: () => void) => {
  window.addEventListener('online', l);
  window.addEventListener('offline', l);
  return () => {
    window.removeEventListener('online', l);
    window.removeEventListener('offline', l);
  };
};

/** Whether the device says it's online. */
export const useOnline = () => useSyncExternalStore(onOnline, () => navigator.onLine, () => true);

/** A tapped push notification opens its page here, as a link in a4a would (the worker asks). */
export function useOpenFromNotifications(): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const sw = navigator.serviceWorker;
    const onMessage = (e: MessageEvent<{ type?: string; url?: string }>) => {
      if (e.data?.type === 'open' && typeof e.data.url === 'string' && e.data.url.startsWith('/')) navigate(e.data.url);
    };
    sw.addEventListener('message', onMessage);
    return () => sw.removeEventListener('message', onMessage);
  }, [navigate]);
}

/** The installed app's icon shows what's unread, where the platform draws a badge. */
export function useAppBadge(unread: number | undefined): void {
  useEffect(() => {
    if (unread === undefined || !('setAppBadge' in navigator)) return;
    const done = unread > 0 ? navigator.setAppBadge(unread) : navigator.clearAppBadge();
    done.catch(() => {});
  }, [unread]);
}
