// Small helpers used everywhere.

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n) => '$' + Math.round(n || 0).toLocaleString();
export const today = () => new Date().toLocaleDateString('en-CA');
export const DC = [38.9072, -77.0369];

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));

const R = 6371000, rad = (x) => (x * Math.PI) / 180;
export function dist(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (Math.round((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}
export function angleDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
export function segDist(p, a, b) {
  const k = Math.cos(rad(p.lat)) * 111320, m = 110540;
  const ax = (a.lng - p.lng) * k, ay = (a.lat - p.lat) * m, bx = (b.lng - p.lng) * k, by = (b.lat - p.lat) * m;
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? -(ax * dx + ay * dy) / l : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export const DIRS = [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]];
export function parseHeading(text) {
  if (!text) return null;
  const t = String(text).toUpperCase();
  const m = t.match(/\b(NE|NW|SE|SW|N|S|E|W)\s*\/\s*B\b/) || t.match(/\b(NE|NW|SE|SW|N|S|E|W)B\b/);
  if (m) return Object.fromEntries(DIRS)[m[1]];
  const w = t.match(/\b(NORTH|SOUTH|EAST|WEST)\s*-?\s*BOUND\b/);
  return w ? Object.fromEntries(DIRS)[w[1][0]] : null;
}
export const headingName = (h) => (h == null ? 'any direction' : DIRS.reduce((best, d) => (angleDiff(d[1], h) < angleDiff(best[1], h) ? d : best))[0] + '-bound');
const SPOKEN = { N: 'northbound', NE: 'northeast-bound', E: 'eastbound', SE: 'southeast-bound', S: 'southbound', SW: 'southwest-bound', W: 'westbound', NW: 'northwest-bound' };
/** Nearest compass point: "NE". */
export const compassPoint = (h) => (h == null ? null : DIRS.reduce((best, d) => (angleDiff(d[1], h) < angleDiff(best[1], h) ? d : best))[0]);
/** "northbound" — how a direction is read aloud. */
export const headingSpoken = (h) => (h == null ? '' : SPOKEN[compassPoint(h)]);

// ---- Street names: is this camera on the road I'm driving? -------------------
const ABBR = { AVE: 'AVENUE', AV: 'AVENUE', AVN: 'AVENUE', ST: 'STREET', STR: 'STREET', RD: 'ROAD', BLVD: 'BOULEVARD', BLV: 'BOULEVARD', PKWY: 'PARKWAY', PKY: 'PARKWAY', PWY: 'PARKWAY', HWY: 'HIGHWAY', DR: 'DRIVE', LN: 'LANE', PL: 'PLACE', CT: 'COURT', TER: 'TERRACE', TERR: 'TERRACE', CIR: 'CIRCLE', EXPY: 'EXPRESSWAY', EXPWY: 'EXPRESSWAY', FWY: 'FREEWAY', TPKE: 'TURNPIKE', RTE: 'ROUTE', RT: 'ROUTE', MT: 'MOUNT', FT: 'FORT', MTN: 'MOUNTAIN', SQ: 'SQUARE', TRL: 'TRAIL', WY: 'WAY' };
const TYPES = new Set(['AVENUE', 'STREET', 'ROAD', 'BOULEVARD', 'PARKWAY', 'HIGHWAY', 'DRIVE', 'LANE', 'PLACE', 'COURT', 'TERRACE', 'CIRCLE', 'EXPRESSWAY', 'FREEWAY', 'TURNPIKE', 'PIKE', 'ROUTE', 'SQUARE', 'TRAIL', 'WAY', 'BRIDGE']);
const NOISE = new Set(['NW', 'NE', 'SW', 'SE', 'N', 'S', 'E', 'W', 'NB', 'SB', 'EB', 'WB', 'NORTHBOUND', 'SOUTHBOUND', 'EASTBOUND', 'WESTBOUND', 'BOUND', 'NORTHWEST', 'NORTHEAST', 'SOUTHWEST', 'SOUTHEAST', 'NORTH', 'SOUTH', 'EAST', 'WEST', 'BLK', 'BLOCK', 'THE', 'OF', 'AT', 'IN', 'ON', 'NEAR', 'AND', 'INTERSECTION', 'CAMERA', 'SPEED', 'ZONE', 'SCHOOL']);
/** Tokens that name the street a camera (or road) is on; the part before "@", "&", "between"… */
export function streetTokens(s) {
  if (!s) return [];
  const first = String(s).toUpperCase().replace(/\b(NE|NW|SE|SW|N|S|E|W)\s*\/\s*B\b/g, ' ').split(/[@&,;\/()]|\bBTW\b|\bBETWEEN\b|\bFROM\b|\bTO\b|\bAND\b|\bAT\b|\bNEAR\b|\bBEFORE\b|\bAFTER\b/)[0];
  return first.replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !NOISE.has(w) && !/^\d+$/.test(w)).map((w) => ABBR[w] || w);
}
/** true = same street, false = clearly a different street, null = can't tell (one side unknown). */
export function sameStreet(a, b) {
  const x = streetTokens(a), y = streetTokens(b);
  if (!x.length || !y.length) return null;
  const nx = x.filter((w) => !TYPES.has(w)), ny = y.filter((w) => !TYPES.has(w));
  if (!nx.length || !ny.length) return null;
  if (nx[0] !== ny[0]) return false;
  const tx = x.find((w) => TYPES.has(w)), ty = y.find((w) => TYPES.has(w));
  return tx && ty && tx !== ty ? false : true;
}

/** Distance as it should be read aloud: "600 feet", "1.2 miles". */
export function sayDist(m) {
  const mi = m / 1609.34;
  if (mi < 0.2) return `${Math.max(50, Math.round((m * 3.281) / 50) * 50)} feet`;
  const v = mi < 10 ? +mi.toFixed(1) : Math.round(mi);
  return `${v} ${v === 1 ? 'mile' : 'miles'}`;
}
export function fmtDist(m) { const mi = m / 1609.34; return mi < 0.2 ? Math.round(m * 3.281) + ' ft' : mi.toFixed(mi < 10 ? 1 : 0) + ' mi'; }
export function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' d ago';
}
export const stamp = (t) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const streetKey = (s) => (s || 'Unknown').replace(/^Example\s*[—-]\s*/i, '').trim() || 'Unknown';
export const fineRange = (f) => (!f ? 'unknown' : f < 100 ? 'under $100' : f < 200 ? '$100–199' : f < 300 ? '$200–299' : '$300+');

export function toast(msg, ms = 2800) {
  const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}

export function download(name, text, type) {
  const b = new Blob([text], { type }); const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export function csv(rows, cols) {
  const q = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return [cols.map((c) => q(c[0])).join(','), ...rows.map((r) => cols.map((c) => q(c[1](r))).join(','))].join('\n');
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied. Paste it into a text or chat.'); return true; }
  catch { toast('Copy failed. Press and hold the text to copy it.'); return false; }
}

/** Strip plates, phone numbers and emails before anything leaves the phone. */
export function scrub(text) {
  if (!text) return '';
  return String(text)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[removed]')
    .replace(/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[removed]')
    .replace(/\b(?!(?:I|US|MD|VA|RT|SR)-?\d)(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9-]{5,8}\b/gi,
      (m) => (/^\d+(st|nd|rd|th|mph|am|pm|ft|mi|min|hrs?)$/i.test(m) ? m : '[removed]'))
    .trim();
}

/** Simple pub/sub so modules don't import each other in circles. */
const subs = {};
export const bus = {
  on(ev, fn) { (subs[ev] ||= []).push(fn); },
  emit(ev, ...a) { (subs[ev] || []).forEach((fn) => { try { fn(...a); } catch (e) { console.error(ev, e); } }); },
};

export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
