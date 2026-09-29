// /api/share — Share drive. The driver's phone posts its position and ETA; anyone with the link can view.
import { handle, json, body, checkOrigin, store, sha256, token, clip, HttpError } from '../lib/common.mjs';

const MIN = 60000;
const num = (v, lo, hi) => { const n = +v; return isFinite(n) && n >= lo && n <= hi ? n : null; };
function clean(d = {}) {
  return {
    name: clip(d.name, 40) || 'Your friend',
    destLabel: clip(d.destLabel, 120),
    dest: d.dest && num(d.dest.lat, -90, 90) != null ? { lat: +d.dest.lat, lng: +d.dest.lng } : null,
    lat: num(d.lat, -90, 90), lng: num(d.lng, -180, 180), heading: num(d.heading, 0, 360),
    eta: num(d.eta, 0, 8e15), arriveBy: num(d.arriveBy, 0, 8e15), mph: num(d.mph, 0, 200),
  };
}

export default handle(async (req) => {
  checkOrigin(req);
  const s = store('shares');
  if (req.method === 'GET') {
    const t = new URL(req.url).searchParams.get('t') || '';
    if (!/^[A-Za-z0-9_-]{8,20}$/.test(t)) throw new HttpError(404, 'This link is not valid.');
    const x = await s.get(`share/${t}`);
    if (!x || x.expiresAt < Date.now()) throw new HttpError(404, 'This drive has ended.');
    const { secretHash, ...pub } = x;
    return json(pub);
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Use GET or POST.');
  const b = await body(req);
  if (typeof b.secret !== 'string' || b.secret.length < 16) throw new HttpError(400, 'Missing secret.');
  const now = Date.now();

  if (b.action === 'start') {
    const t = token(12);
    await s.setJSON(`share/${t}`, { ...clean(b.data), secretHash: sha256(b.secret), startedAt: now, updatedAt: now, expiresAt: now + 4 * 60 * MIN, ended: false });
    return json({ token: t });
  }
  if (!/^[A-Za-z0-9_-]{8,20}$/.test(b.token || '')) throw new HttpError(400, 'Missing share token.');
  const key = `share/${b.token}`;
  const x = await s.get(key);
  if (!x) throw new HttpError(404, 'That share has expired.');
  if (x.secretHash !== sha256(b.secret)) throw new HttpError(403, 'Not your share.');
  if (b.action === 'update') {
    const d = clean({ ...x, ...b.data });
    await s.setJSON(key, { ...x, ...d, updatedAt: now, expiresAt: Math.max(x.expiresAt, now + 2 * 60 * MIN), ended: false });
    return json({ ok: true });
  }
  if (b.action === 'end') {
    await s.setJSON(key, { ...x, ended: true, arrived: !!b.arrived, updatedAt: now, expiresAt: now + 30 * MIN });
    return json({ ok: true });
  }
  throw new HttpError(400, 'Unknown action.');
});

export const config = { path: '/api/share' };
