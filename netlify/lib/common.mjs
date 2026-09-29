// Shared helpers for Ticket Radar's Netlify Functions.
import { getStore } from '@netlify/blobs';
import { createHash, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------- storage (Netlify Blobs)
// TR_MEMORY_BLOBS=1 swaps in an in-memory store for local tests.
const mem = new Map();
function memStore(name) {
  const k = (key) => `${name}:${key}`;
  return {
    async get(key) { const v = mem.get(k(key)); return v === undefined ? null : JSON.parse(v); },
    async setJSON(key, value) { mem.set(k(key), JSON.stringify(value)); },
    async delete(key) { mem.delete(k(key)); },
    async list({ prefix = '' } = {}) {
      return { blobs: [...mem.keys()].filter((x) => x.startsWith(`${name}:${prefix}`)).map((x) => ({ key: x.slice(name.length + 1) })) };
    },
  };
}
export function store(name) {
  if (process.env.TR_MEMORY_BLOBS === '1') return memStore(name);
  const s = getStore({ name, consistency: 'strong' });
  return {
    get: (key) => s.get(key, { type: 'json' }),
    setJSON: (key, value) => s.setJSON(key, value),
    delete: (key) => s.delete(key),
    list: (opts) => s.list(opts),
  };
}

// ---------------------------------------------------------------- http
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** Only this site's pages may call the functions (protects your Google quota). */
export function checkOrigin(req) {
  const o = req.headers.get('origin');
  if (!o) return;                                            // same-origin GETs and server calls send no Origin
  const ok = [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.DEPLOY_URL].filter(Boolean);
  if (ok.includes(o) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return;
  throw new HttpError(403, 'Not allowed from this site.');
}
export async function body(req) {
  try { return await req.json(); } catch { throw new HttpError(400, 'Send JSON.'); }
}
export function handle(fn) {
  return async (req, ctx) => {
    try { return await fn(req, ctx); }
    catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      return json({ error: status === 500 ? 'Something went wrong. Try again in a minute.' : e.message }, status);
    }
  };
}

// ---------------------------------------------------------------- small utils
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
export const token = (n = 12) => randomBytes(n).toString('base64url').slice(0, n);
export const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);
export function point(p) {
  const lat = +p?.lat, lng = +p?.lng;
  if (!isFinite(lat) || !isFinite(lng) || lat < 17 || lat > 72 || lng < -170 || lng > -60) throw new HttpError(400, 'Location is missing or outside the US.');
  return { lat, lng, label: typeof p.label === 'string' ? p.label.slice(0, 160) : '' };
}
export const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');
const R = 6371000, rad = (x) => (x * Math.PI) / 180;
export function dist(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function clock(ms, tz) {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || 'America/New_York' });
}
