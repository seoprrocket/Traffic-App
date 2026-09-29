// Drive times with live traffic (Google Routes API) or, without a key, typical times (OSRM).
import { store } from './common.mjs';

const GOOGLE = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const MIN = 60000;

export const googleConfigured = () => !!process.env.GOOGLE_MAPS_API_KEY;

/** Reserve n Google calls from today's budget. False when the daily cap is reached. */
async function budget(n) {
  const limit = +(process.env.GOOGLE_DAILY_LIMIT || 400);
  const key = `google/${new Date().toISOString().slice(0, 10)}`;
  const s = store('usage');
  const used = (await s.get(key))?.calls || 0;
  if (used + n > limit) return false;
  await s.setJSON(key, { calls: used + n });
  return true;
}

async function google(a, b, departAt) {
  const bodyObj = {
    origin: { location: { latLng: { latitude: a.lat, longitude: a.lng } } },
    destination: { location: { latLng: { latitude: b.lat, longitude: b.lng } } },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
  };
  if (departAt && departAt > Date.now() + MIN) bodyObj.departureTime = new Date(departAt).toISOString();
  const r = await fetch(GOOGLE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters' },
    body: JSON.stringify(bodyObj),
  });
  const js = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Routes ${r.status}: ${js?.error?.message || ''}`);
  const rt = js.routes?.[0];
  if (!rt) throw new Error('Google found no driving route');
  return { secs: parseInt(rt.duration, 10), staticSecs: parseInt(rt.staticDuration || rt.duration, 10), meters: rt.distanceMeters };
}

async function osrm(a, b) {
  const r = await fetch(`${OSRM}${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`);
  const js = await r.json().catch(() => ({}));
  const rt = js.routes?.[0];
  if (!rt) throw new Error('No driving route found');
  return { secs: Math.round(rt.duration), staticSecs: Math.round(rt.duration), meters: Math.round(rt.distance) };
}

const level = (secs, staticSecs) => {
  const k = secs / Math.max(1, staticSecs);
  return k < 1.15 ? 'light' : k < 1.4 ? 'moderate' : 'heavy';
};
const floorMin = (t) => Math.floor(t / MIN) * MIN;

/**
 * Plan a drive.
 *  - arriveBy set: the latest time to leave (sampling a few departure times around it)
 *  - arriveBy empty: drive time now, and for the next two hours
 * `quick` makes a single call (used by the scheduler).
 */
export async function plan({ start, end, arriveBy = null, buffer = 5, quick = false, departAt = null }) {
  const now = Date.now();
  const buf = Math.max(0, Math.min(120, +buffer || 0)) * MIN;
  const useGoogle = googleConfigured() && (await budget(quick ? 1 : 5));
  const note = googleConfigured() && !useGoogle ? "Today's live-traffic limit was reached, so these are typical times." : null;

  if (!useGoogle) {
    const d = await osrm(start, end);
    const secs = Math.round(d.secs * 1.2);                    // typical time + 20% for traffic you can't see
    const leaveAt = arriveBy ? floorMin(arriveBy - buf - secs * 1000) : null;
    return { traffic: false, source: 'osrm', meters: d.meters, nowSecs: secs, staticSecs: d.staticSecs, level: null,
      arriveBy, leaveAt: leaveAt && Math.max(leaveAt, floorMin(now)), late: !!leaveAt && leaveAt < now,
      lateMin: leaveAt && leaveAt < now ? Math.round((now - leaveAt) / MIN) : 0, samples: [], note };
  }

  const first = departAt && departAt > now + MIN ? departAt : now;
  const d0 = await google(start, end, first);
  const out = { traffic: true, source: 'google', meters: d0.meters, nowSecs: d0.secs, staticSecs: d0.staticSecs,
    level: level(d0.secs, d0.staticSecs), arriveBy, leaveAt: null, late: false, lateMin: 0, samples: [{ departAt: first, secs: d0.secs }], note };

  if (!arriveBy) {
    if (!quick) for (const m of [30, 60, 90, 120]) {
      try { const d = await google(start, end, now + m * MIN); out.samples.push({ departAt: now + m * MIN, secs: d.secs }); } catch { /* skip */ }
    }
    return out;
  }

  const target = arriveBy - buf;
  const latest0 = target - d0.secs * 1000;
  if (latest0 <= now) {
    out.leaveAt = floorMin(now); out.late = true; out.lateMin = Math.max(1, Math.round((now + d0.secs * 1000 - target) / MIN));
    return out;
  }
  if (!quick) {
    for (const t of [latest0 - 30 * MIN, latest0 - 15 * MIN, latest0, latest0 + 10 * MIN]) {
      if (t < now + 2 * MIN) continue;
      try { const d = await google(start, end, t); out.samples.push({ departAt: t, secs: d.secs }); } catch { /* skip */ }
    }
  }
  const s = out.samples.map((x) => ({ ...x, slack: target - (x.departAt + x.secs * 1000) })).sort((a, b) => a.departAt - b.departAt);
  const okIdx = s.map((x) => x.slack >= 0).lastIndexOf(true);
  let leave;
  if (okIdx < 0) leave = now;
  else if (okIdx < s.length - 1) {
    const a = s[okIdx], b = s[okIdx + 1];
    leave = a.departAt + ((b.departAt - a.departAt) * a.slack) / (a.slack - b.slack);   // where the slack hits zero
  } else leave = s[okIdx].departAt + s[okIdx].slack;
  out.leaveAt = floorMin(Math.max(now, leave));
  out.samples = s.map(({ departAt, secs }) => ({ departAt, secs }));
  return out;
}
