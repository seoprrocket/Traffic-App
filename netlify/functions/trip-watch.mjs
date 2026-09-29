// Runs every 5 minutes: re-checks traffic for saved trips, sends "time to leave" and reminder notifications,
// and clears expired share links.
import { store, clock } from '../lib/common.mjs';
import { plan } from '../lib/traffic.mjs';
import { pushTo } from '../lib/push.mjs';

const MIN = 60000;

export async function watch(now = Date.now()) {
  const s = store('trips');
  const log = { checked: 0, pushed: 0, removed: 0 };
  const { blobs } = await s.list({ prefix: 'trip/' });
  for (const { key } of blobs) {
    const rec = await s.get(key);
    if (!rec) continue;
    const t = rec.trip;
    if (t.arriveBy < now - 60 * MIN) { await s.delete(key); log.removed++; continue; }
    if (rec.notified || t.arriveBy - now > 4 * 60 * MIN) continue;

    const soon = rec.leaveAt && rec.leaveAt - now < 40 * MIN;
    if (!rec.leaveAt || now - (rec.checkedAt || 0) >= (soon ? 5 : 15) * MIN - 30000) {
      try {
        const p = await plan({ start: t.start, end: t.end, arriveBy: t.arriveBy, buffer: t.buffer, quick: true,
          departAt: rec.leaveAt && rec.leaveAt > now ? rec.leaveAt : null });
        const prev = rec.leaveAt;
        Object.assign(rec, { leaveAt: p.leaveAt, secs: p.nowSecs, checkedAt: now });
        log.checked++;
        if (!rec.warned && prev && p.leaveAt < prev - 10 * MIN && p.leaveAt - now > 15 * MIN) {
          rec.warned = true;
          if (await pushTo(rec.device, { title: `Traffic is building: leave by ${clock(p.leaveAt, rec.tz)}`,
            body: `${t.name}: about ${Math.round(p.nowSecs / 60)} min now. Arrive by ${clock(t.arriveBy, rec.tz)}.`, url: './#route', tag: 'trip-' + t.id })) log.pushed++;
        }
      } catch (e) { console.error('trip check failed', key, e.message); }
    }
    if (rec.leaveAt && now >= rec.leaveAt - 5 * MIN) {
      rec.notified = true;
      const late = rec.leaveAt < now - 2 * MIN;
      if (await pushTo(rec.device, {
        title: late ? `Leave now for ${t.name}` : `Time to leave for ${t.name}`,
        body: `About ${Math.round((rec.secs || 0) / 60)} min with traffic. Arrive by ${clock(t.arriveBy, rec.tz)}.`,
        url: './#route', tag: 'trip-' + t.id, requireInteraction: true })) log.pushed++;
    }
    await s.setJSON(key, rec);
  }

  const due = await s.list({ prefix: 'remind/' });
  for (const { key } of due.blobs) {
    const r = await s.get(key);
    if (!r) continue;
    if (r.at <= now) {
      if (await pushTo(r.device, { title: r.title, body: r.body, url: r.url, tag: key })) log.pushed++;
      await s.delete(key);
    }
  }

  const shares = store('shares');
  const sl = await shares.list({ prefix: 'share/' });
  for (const { key } of sl.blobs) {
    const x = await shares.get(key);
    if (!x || x.expiresAt < now) { await shares.delete(key); log.removed++; }
  }
  return log;
}

export default async () => {
  const log = await watch();
  console.log('trip-watch', JSON.stringify(log));
};

export const config = { schedule: '*/5 * * * *' };
