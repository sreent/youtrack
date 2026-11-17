/**
 * Push notifications on this device (docs/architecture.md, D47): turning them on and off, and
 * keeping a4a's record of this device in step with the browser's.
 *
 * The browser keeps one push subscription for a4a, whoever signs in. So this device remembers whose
 * it is (OWNER): signed in again as them, it's given to a4a again (a sign-in that ended took a4a's
 * record with it); signed in as someone else, it's dropped, since push was never turned on for them.
 */
import type { PushDevice, PushKey, PushTestResult } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, qs } from '../../api/client';
import { t } from '../../i18n';

const OWNER = 'a4a.push.owner';

export type PushSupport =
  | { kind: 'ready' }
  | { kind: 'unsupported' }
  /** iOS and iPadOS push only to a4a added to the Home Screen, and opened from there. */
  | { kind: 'install-first' };

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function standalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function pushSupport(): PushSupport {
  const has = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIos() && !standalone()) return { kind: 'install-first' };
  return has ? { kind: 'ready' } : { kind: 'unsupported' };
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration('/')) ?? null;
}

/** The browser's subscription for a4a on this device, if there is one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

function remember(owner: string | null) {
  try {
    if (owner) localStorage.setItem(OWNER, owner);
    else localStorage.removeItem(OWNER);
  } catch {
    // Storage refused (a private window): push still works this time, and is asked for again next.
  }
}

function ownerHere(): string | null {
  try {
    return localStorage.getItem(OWNER);
  } catch {
    return null;
  }
}

/** Ask the browser, subscribe with a4a's key, and give the subscription to a4a. */
export async function turnPushOn(me: { id: string }): Promise<PushDevice> {
  const reg = await (navigator.serviceWorker?.ready ?? Promise.reject(new Error(t('notifications.push.thisBrowserHasNoService'))));
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? t('notifications.push.notificationsAreBlockedForA4a')
        : t('notifications.push.notificationsWerenTAllowedTry'),
    );
  }
  const key = await get<PushKey>('/push/key');
  if (!key.enabled || !key.publicKey) throw new Error(t('notifications.push.thisServerSendsNoPush'));
  const applicationServerKey = fromBase64Url(key.publicKey);
  let subscription = await reg.pushManager.getSubscription();
  // One made with another key (the server's key changed) can't take a4a's pushes: start again.
  if (subscription && !sameKey(subscription.options.applicationServerKey, applicationServerKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  const device = await post<PushDevice>('/push/devices', subscription.toJSON());
  remember(me.id);
  return device;
}

/** Turn push off on this device: the browser drops its subscription, and a4a its record. */
export async function turnPushOff(device: PushDevice | undefined): Promise<void> {
  const subscription = await currentSubscription();
  await subscription?.unsubscribe().catch(() => false);
  if (device) await del(`/push/devices/${device.id}`).catch(() => {});
  remember(null);
}

/** Before signing out here: this device stops hearing for whoever was signed in. */
export async function forgetPushHere(): Promise<void> {
  const subscription = await currentSubscription().catch(() => null);
  await subscription?.unsubscribe().catch(() => false);
  remember(null);
}

/**
 * On starting, signed in: the browser's subscription is given again to a4a if it was this person's
 * (a new sign-in's record), and dropped if it was someone else's.
 */
export async function keepPushInStep(me: { id: string }): Promise<void> {
  if (pushSupport().kind !== 'ready' || Notification.permission !== 'granted') return;
  const subscription = await currentSubscription().catch(() => null);
  if (!subscription) return;
  const owner = ownerHere();
  if (owner !== me.id) {
    await subscription.unsubscribe().catch(() => false);
    remember(null);
    return;
  }
  const key = await get<PushKey>('/push/key').catch(() => null);
  if (!key?.publicKey) return;
  if (!sameKey(subscription.options.applicationServerKey, fromBase64Url(key.publicKey))) {
    await turnPushOn(me).catch(() => {});
    return;
  }
  await post('/push/devices', subscription.toJSON()).catch(() => {});
}

export const pushKeys = { devices: (endpoint: string | null) => ['push', 'devices', endpoint] as const, all: ['push'] as const };

/** Your devices, this one marked, once its subscription is known. */
export function usePushDevices(endpoint: string | null, enabled = true) {
  return useQuery({
    queryKey: pushKeys.devices(endpoint),
    enabled,
    queryFn: () => get<PushDevice[]>(`/push/devices${qs({ endpoint: endpoint ?? undefined })}`),
  });
}

export function useRemoveDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => del(`/push/devices/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: pushKeys.all }),
  });
}

export function useTestPush() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<PushTestResult>('/push/test'),
    onSettled: () => void qc.invalidateQueries({ queryKey: pushKeys.all }),
  });
}
