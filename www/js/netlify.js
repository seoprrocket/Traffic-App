// Talks to the Netlify Functions (live traffic, phone notifications, Share drive).
// Every feature has a fallback, so the app still works on a plain drag-and-drop deploy.
import { S, persist } from './store.js';
import { uuid } from './util.js';

let status = null;
/** { ok, traffic, push, vapidPublicKey } — ok:false when the functions aren't deployed. */
export async function apiStatus(force) {
  if (status && !force) return status;
  try {
    const r = await fetch('/api/trips', { cache: 'no-store' });
    status = r.ok ? await r.json() : { ok: false };
  } catch { status = { ok: false }; }
  status.traffic = !!status.traffic; status.push = !!status.push;
  return status;
}

export async function api(path, body) {
  let r;
  try { r = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch { throw new Error('offline'); }
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  if (!r.ok) throw new Error(r.status === 404 && !j?.error ? 'not-deployed' : j?.error || `Server error ${r.status}`);
  return j;
}

/** This phone's anonymous id + secret for notifications. */
export function creds() {
  if (!S.db.device) { S.db.device = { id: 'd_' + uuid().replace(/-/g, ''), secret: uuid() + uuid() }; persist(); }
  return { device: S.db.device.id, secret: S.db.device.secret };
}
export const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';

// ---------------------------------------------------------------- phone notifications
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

/** 'on' | 'off' | 'install' (iPhone needs Home Screen first) | 'unsupported' | 'server' (not set up) | 'denied' */
export async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return isIOS() && !standalone() ? 'install' : 'unsupported';
  const st = await apiStatus();
  if (!st.ok || !st.push) return 'server';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  return sub && S.db.pushOn ? 'on' : 'off';
}

function b64ToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function enablePush() {
  const state = await pushState();
  if (state === 'install') throw new Error('On iPhone, add Ticket Radar to your Home Screen first (Share → Add to Home Screen), then turn notifications on from there.');
  if (state === 'unsupported') throw new Error("This browser can't receive notifications. Try Chrome, or add the app to your Home Screen.");
  if (state === 'server') throw new Error('Notifications aren\'t set up on the site yet. See step 2 of the setup page.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them for this site in your phone settings.');
  const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('sw.js'));
  await navigator.serviceWorker.ready;
  const st = await apiStatus();
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(st.vapidPublicKey) }));
  await api('trips', { action: 'register', ...creds(), subscription: sub.toJSON(), tz: tz() });
  S.db.pushOn = true; persist();
}
export async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) await sub.unsubscribe();
    await api('trips', { action: 'register', ...creds(), subscription: null, tz: tz() });
  } catch { /* already off */ }
  S.db.pushOn = false; persist();
}
export const testPush = () => api('trips', { action: 'test', ...creds() });

/** Keep the server's copy of a trip in step, so it can notify you when to leave. Silent if unavailable. */
export async function pushTrip(p) {
  if (!S.db.pushOn || !p.arriveBy || !p.start) return false;
  try {
    await api('trips', { action: 'save-trip', ...creds(), tz: tz(), trip: { id: p.id, name: p.name, start: p.start, end: p.end, arriveBy: p.arriveBy, buffer: p.buffer, leaveAt: p.leaveAt, secs: p.secs } });
    return true;
  } catch { return false; }
}
export async function unpushTrip(id) { if (S.db.pushOn) { try { await api('trips', { action: 'delete-trip', ...creds(), id }); } catch { /* gone */ } } }
export async function pushReminder(r) {
  if (!S.db.pushOn) return false;
  try { await api('trips', { action: 'remind', ...creds(), reminder: r }); return true; } catch { return false; }
}
export async function unpushReminder(id) { if (S.db.pushOn) { try { await api('trips', { action: 'cancel-remind', ...creds(), id }); } catch { /* gone */ } } }
