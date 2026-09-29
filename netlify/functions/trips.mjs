// /api/trips — status (GET), and for one phone: register for notifications, save/delete trips, reminders, test.
import { handle, json, body, checkOrigin, point, clip, isId, store, HttpError } from '../lib/common.mjs';
import { device, saveDevice, pushTo, pushConfigured } from '../lib/push.mjs';
import { googleConfigured } from '../lib/traffic.mjs';

export default handle(async (req) => {
  checkOrigin(req);
  if (req.method === 'GET') {
    return json({ ok: true, traffic: googleConfigured(), push: pushConfigured(), vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Use GET or POST.');
  const b = await body(req);
  const act = b.action;
  const trips = store('trips');

  if (act === 'register') {
    const rec = await device(b.device, b.secret, { create: true });
    const sub = b.subscription;
    if (sub && (typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth)) throw new HttpError(400, 'Bad notification subscription.');
    rec.sub = sub ? { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } } : null;
    rec.tz = clip(b.tz, 64) || rec.tz || 'America/New_York';
    await saveDevice(b.device, rec);
    return json({ ok: true, push: !!rec.sub && pushConfigured() });
  }

  await device(b.device, b.secret);                          // every other action needs a registered phone

  if (act === 'test') {
    const sent = await pushTo(b.device, { title: 'Invictus Traffic Radar', body: 'Notifications are working on this phone.', url: './' });
    if (!sent) throw new HttpError(409, 'Could not reach this phone. Turn notifications off and on again.');
    return json({ ok: true });
  }
  if (act === 'save-trip') {
    const t = b.trip || {};
    if (!isId(t.id)) throw new HttpError(400, 'Trip id missing.');
    const arriveBy = +t.arriveBy;
    if (!arriveBy || arriveBy < Date.now()) throw new HttpError(400, 'Set an arrival time in the future.');
    const key = `trip/${b.device}/${t.id}`;
    const old = await trips.get(key);
    await trips.setJSON(key, {
      device: b.device, tz: clip(b.tz, 64) || 'America/New_York',
      trip: { id: t.id, name: clip(t.name, 80) || 'your trip', start: point(t.start), end: point(t.end), arriveBy, buffer: Math.max(0, Math.min(120, +t.buffer || 0)) },
      leaveAt: +t.leaveAt || old?.leaveAt || null, secs: +t.secs || old?.secs || null, checkedAt: Date.now(),
      notified: old && old.trip?.arriveBy === arriveBy ? !!old.notified : false, warned: false,
    });
    return json({ ok: true });
  }
  if (act === 'delete-trip') {
    if (!isId(b.id)) throw new HttpError(400, 'Trip id missing.');
    await trips.delete(`trip/${b.device}/${b.id}`);
    return json({ ok: true });
  }
  if (act === 'remind') {
    const r = b.reminder || {};
    if (!isId(r.id) || !(+r.at > Date.now())) throw new HttpError(400, 'Reminder time must be in the future.');
    await trips.setJSON(`remind/${b.device}/${r.id}`, { device: b.device, at: +r.at, title: clip(r.title, 80), body: clip(r.body, 200), url: clip(r.url, 200) || './' });
    return json({ ok: true });
  }
  if (act === 'cancel-remind') {
    if (!isId(b.id)) throw new HttpError(400, 'Reminder id missing.');
    await trips.delete(`remind/${b.device}/${b.id}`);
    return json({ ok: true });
  }
  throw new HttpError(400, 'Unknown action.');
});

export const config = { path: '/api/trips' };
