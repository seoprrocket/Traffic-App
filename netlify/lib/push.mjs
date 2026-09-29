// Phone notifications (Web Push). Devices are anonymous: a random id plus a secret only that phone knows.
import webpush from 'web-push';
import { store, sha256, HttpError, isId } from './common.mjs';

let ready = null;
export function pushConfigured() {
  if (ready !== null) return ready;
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return (ready = false);
  let subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  if (!/^(mailto:|https:)/.test(subject)) subject = 'mailto:' + subject;
  try { webpush.setVapidDetails(subject, pub, priv); ready = true; } catch (e) { console.error('VAPID keys are invalid', e.message); ready = false; }
  return ready;
}

/** Look up a device and check its secret. `create` makes it on first use. */
export async function device(id, secret, { create = false } = {}) {
  if (!isId(id) || typeof secret !== 'string' || secret.length < 16) throw new HttpError(400, 'Missing device id.');
  const s = store('devices');
  const rec = await s.get(`device/${id}`);
  if (!rec) {
    if (!create) throw new HttpError(404, 'This phone is not registered yet.');
    const fresh = { secretHash: sha256(secret), sub: null, createdAt: Date.now() };
    await s.setJSON(`device/${id}`, fresh);
    return fresh;
  }
  if (rec.secretHash !== sha256(secret)) throw new HttpError(403, 'Device key does not match.');
  return rec;
}
export async function saveDevice(id, rec) { await store('devices').setJSON(`device/${id}`, rec); }

/** Send to one device. Returns true if delivered. Removes subscriptions the phone has revoked. */
export async function pushTo(id, payload) {
  if (!pushConfigured()) return false;
  const s = store('devices');
  const rec = await s.get(`device/${id}`);
  if (!rec?.sub) return false;
  try {
    await webpush.sendNotification(rec.sub, JSON.stringify(payload), { TTL: 1800, urgency: 'high' });
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) { rec.sub = null; await s.setJSON(`device/${id}`, rec); }
    else console.error('push failed', e.statusCode, e.body);
    return false;
  }
}
