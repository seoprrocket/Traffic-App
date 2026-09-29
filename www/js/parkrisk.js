// Parking-ticket risk: how often parking tickets are written near a spot, why, and when.
// DC: the city's monthly "Parking Violations" tables (every ticket has a block location).
// Montgomery County: the county DOT parking-ticket list (Bethesda, Silver Spring, Wheaton), matched by street and block number.
import { S } from './store.js';
import { dist } from './util.js';

const DC_URL = (y, m) => `https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Violations_Parking_${y}/MapServer/${m}/query`;
const MOCO_URL = 'https://data.montgomerycountymd.gov/resource/uyb2-cfmc.json';
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const RADIUS = 120;          // meters around the spot ("this block and the next one over")

// ---------------------------------------------------------------- helpers
const inDCBox = (p) => p.lat > 38.79 && p.lat < 38.996 && p.lng > -77.12 && p.lng < -76.909;
const inMoCoBox = (p) => p.lat > 38.93 && p.lat < 39.36 && p.lng > -77.53 && p.lng < -76.88;
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off */ } };
const day = () => new Date().toLocaleDateString('en-CA');

async function getJson(url, params) {
  const r = await fetch(url + '?' + new URLSearchParams(params));
  if (!r.ok) throw new Error('Parking ticket data is not responding. Try again in a minute.');
  const j = await r.json();
  if (j?.error) throw new Error(j.error.message || 'Parking ticket data returned an error.');
  return j;
}
export const titleCase = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
  .replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b(Nw|Ne|Sw|Se|Dc|Rpp|Dpw)\b/g, (x) => x.toUpperCase());
const cleanBlock = (s) => titleCase(String(s || '').replace(/\*+$/, '').replace(/\b(NORTH|SOUTH|EAST|WEST)\s*(S|SI|SID|SIDE)?\s*$/i, (m, d) => `(${d.toLowerCase()} side)`));

// ---------------------------------------------------------------- why tickets happen, in plain words
// "car" reasons follow the car (expired tags, inspection), so they don't count against the spot.
const REASONS = [
  [/REGIST|INSPECT|\bTAGS?\b|PLATE|DISPLAY OF|NO FRONT/, 'car', 'Paperwork tickets (tags, registration, inspection). These are about the car, not the spot.'],
  [/RUSH|TOW ?AWAY|NO STANDING/, 'rush', 'Rush-hour or tow-away limits. Read the sign times, often weekday mornings and evenings. Cars get towed.'],
  [/STREET ?(CLEAN|SWEEP)|SWEEP/, 'sweep', 'Street sweeping. Check the sign for the day and hours.'],
  [/EMERGENCY NO PARK|TEMPORARY|SPECIAL EVENT/, 'temp', 'Temporary "Emergency No Parking" signs for moves, filming and events. Look for paper signs on poles.'],
  [/RESIDENT|RPP|ZONE|PERMIT/, 'rpp', 'Residential permit block. Without that zone\'s sticker, the posted limit applies (often 2 hours on weekdays).'],
  [/METER|PAY ?STATION|MULTI.?SPACE|PAY ?BY|FAIL.*PAY|PARKING FEE/, 'meter', 'Meters are enforced. Pay by app (ParkMobile) and set the meter timer in Invictus Traffic Radar.'],
  [/OVER ?TIME|TIME LIMIT|HOUR|EXCESS|LONGER THAN/, 'time', 'Time limits are enforced. Set a timer when you park.'],
  [/HYDRANT/, 'hydrant', 'Too close to a fire hydrant. Leave plenty of room.'],
  [/LOADING|COMMERCIAL|DELIVER|TRUCK/, 'loading', 'Loading zones are for commercial vehicles during the posted hours.'],
  [/BUS|TAXI|BIKE/, 'bus', 'Bus, taxi or bike lanes and stops are ticketed quickly.'],
  [/CROSSWALK|INTERSECTION|CORNER|DRIVEWAY|ALLEY|SIDEWALK|STOP SIGN|DOUBLE/, 'clear', 'Blocking a crosswalk, corner, driveway, alley or traffic. Keep well clear.'],
  [/DISABL|HANDICAP|RESERVED|ELECTRIC|CHARG/, 'reserved', 'Reserved spaces (disabled, EV charging, official use).'],
  [/NO PARK|PROHIBIT|RESTRICT/, 'noparking', 'Signed no-parking area. Read every sign on the block before you leave the car.'],
];
export function explain(desc) {
  const u = String(desc || '').toUpperCase();
  for (const [re, key, tip] of REASONS) if (re.test(u)) return { key, tip };
  return { key: 'other', tip: '' };
}

// ---------------------------------------------------------------- DC
/** The most recent months that have tickets published (checked once a day). */
async function dcMonths() {
  const c = lsGet('tr.pkMonths');
  if (c?.day === day() && c.list?.length) return c.list;
  const now = new Date(), cands = [];
  for (let i = 0; i < 7; i++) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); cands.push([d.getFullYear(), d.getMonth()]); }
  const counts = await Promise.all(cands.map(([y, m]) => getJson(DC_URL(y, m), { where: '1=1', returnCountOnly: 'true', f: 'json' }).then((j) => j.count || 0).catch(() => 0)));
  const list = cands.filter((_, i) => counts[i] > 1000).slice(0, 3);
  if (list.length) lsSet('tr.pkMonths', { day: day(), list });
  return list;
}
const box = (p, r) => {
  const dLat = r / 111320, dLng = r / (111320 * Math.cos(p.lat * Math.PI / 180));
  return `LATITUDE BETWEEN ${(p.lat - dLat).toFixed(6)} AND ${(p.lat + dLat).toFixed(6)} AND LONGITUDE BETWEEN ${(p.lng - dLng).toFixed(6)} AND ${(p.lng + dLng).toFixed(6)}`;
};
const stat = (type, field, name) => ({ statisticType: type, onStatisticField: field, outStatisticFieldName: name });
const stats = (url, where, groupBy, extra = []) => getJson(url, {
  where, groupByFieldsForStatistics: groupBy, outStatistics: JSON.stringify([stat('count', 'OBJECTID', 'n'), ...extra]), f: 'json',
}).then((j) => (j.features || []).map((f) => f.attributes));

async function dcRisk(p) {
  const months = await dcMonths();
  if (!months.length) throw new Error('DC has not published recent parking tickets yet.');
  const where = box(p, RADIUS);
  const per = await Promise.all(months.map(async ([y, m]) => {
    const u = DC_URL(y, m);
    const [blocks, times, dates] = await Promise.all([
      stats(u, where, 'LOCATION,VIOLATION_PROC_DESC', [stat('avg', 'FINE_AMOUNT', 'fine'), stat('avg', 'LATITUDE', 'lat'), stat('avg', 'LONGITUDE', 'lng')]),
      stats(u, where, 'ISSUE_TIME'),
      stats(u, where, 'ISSUE_DATE'),
    ]);
    return { blocks, times, dates };
  }));
  const rows = [], hours = Array(24).fill(0), days = Array(7).fill(0);
  for (const m of per) {
    for (const b of m.blocks) {
      if (b.lat == null) continue;
      // keep what's really within the radius, not just in the square
      if (dist(p, { lat: b.lat, lng: b.lng }) > RADIUS * 1.15) continue;
      rows.push({ block: cleanBlock(b.LOCATION), reason: b.VIOLATION_PROC_DESC, n: b.n, fine: b.fine || 0, lat: b.lat, lng: b.lng });
    }
    for (const t of m.times) { const h = parseInt(String(t.ISSUE_TIME ?? '').padStart(4, '0').slice(0, 2), 10); if (h >= 0 && h < 24) hours[h] += t.n; }
    for (const d of m.dates) if (d.ISSUE_DATE != null) days[new Date(d.ISSUE_DATE + 12 * 3600e3).getUTCDay()] += d.n;
  }
  const label = months.length > 1 ? `${MON[months.at(-1)[1]]}–${MON[months[0][1]]} ${months[0][0]}` : `${MON[months[0][1]]} ${months[0][0]}`;
  return summarize(p, { area: 'DC', source: 'DC Department of Public Works parking tickets', period: label, months: months.length, rows, hours, days });
}

/** Ticket counts per block inside a map view (latest month). For the map layer. */
export async function dcBlocks(bounds) {
  const months = await dcMonths();
  if (!months.length) return { month: null, blocks: [] };
  const [y, m] = months[0];
  const s = bounds.getSouth(), n = bounds.getNorth(), w = bounds.getWest(), e = bounds.getEast();
  const where = `LATITUDE BETWEEN ${s.toFixed(5)} AND ${n.toFixed(5)} AND LONGITUDE BETWEEN ${w.toFixed(5)} AND ${e.toFixed(5)}`;
  const list = await stats(DC_URL(y, m), where, 'LOCATION', [stat('avg', 'LATITUDE', 'lat'), stat('avg', 'LONGITUDE', 'lng'), stat('avg', 'FINE_AMOUNT', 'fine')]);
  return { month: `${MON[m]} ${y}`, blocks: list.filter((b) => b.lat != null).map((b) => ({ block: cleanBlock(b.LOCATION), n: b.n, lat: b.lat, lng: b.lng, fine: b.fine || 0 })) };
}
export const dcCovers = inDCBox;

// ---------------------------------------------------------------- Montgomery County
const SUFFIX = { AVENUE: 'AVE', STREET: 'ST', ROAD: 'RD', DRIVE: 'DR', LANE: 'LN', BOULEVARD: 'BLVD', PLACE: 'PL', COURT: 'CT', PARKWAY: 'PKWY', TERRACE: 'TER', CIRCLE: 'CIR', HIGHWAY: 'HWY', PIKE: 'PIKE', WAY: 'WAY', SQUARE: 'SQ', PLAZA: 'PLZ' };
const DIR = { NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W' };
export function mocoStreet(road) {
  const w = String(road || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!w.length) return '';
  const last = w.length - 1;
  if (SUFFIX[w[last]]) w[last] = SUFFIX[w[last]];
  if (DIR[w[0]] && w.length > 2) w[0] = DIR[w[0]];
  return w.join(' ');
}
const houseNum = (s) => { const m = String(s || '').match(/(?:^|[-\s])(\d{2,5})\s+[A-Z]/i); return m ? +m[1] : null; };

async function reverse(p) {
  const c = lsGet('tr.revCache') || {};
  const k = p.lat.toFixed(4) + ',' + p.lng.toFixed(4);
  if (c[k]) return c[k];
  const j = await getJson(NOMINATIM, { format: 'jsonv2', lat: p.lat, lon: p.lng, zoom: 18, addressdetails: 1 });
  const a = j.address || {};
  const v = { road: a.road || '', num: a.house_number ? parseInt(a.house_number, 10) || null : null, county: a.county || '', state: a.state || '', city: a.city || a.town || a.village || a.suburb || '' };
  const keys = Object.keys(c); if (keys.length > 60) delete c[keys[0]];
  c[k] = v; lsSet('tr.revCache', c);
  return v;
}

async function mocoRisk(p, addr) {
  const street = mocoStreet(addr.road);
  if (!street) throw new Error('Couldn\'t tell which street this is. Move the pin onto the street.');
  const since = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10) + 'T00:00:00';
  const where = `upper(ticket_location) like '%${street.replace(/'/g, "''")}%' AND date_time > '${since}'`;
  const q = (select, group) => getJson(MOCO_URL, { $select: select, $where: where, $group: group, $limit: 20000 });
  // The county records times without AM/PM, so hours can't be trusted; days of the week can.
  const [reasons, dws, span] = await Promise.all([
    q('ticket_location, violation_description, count(*) as n', 'ticket_location, violation_description'),
    q('ticket_location, date_extract_dow(date_time) as d, count(*) as n', 'ticket_location, d'),
    getJson(MOCO_URL, { $select: 'min(date_time) as a, max(date_time) as b', $where: where }),
  ]);
  // Near = same street, within about two blocks of house numbers. Garage tickets (G35-…) count only when the spot is in that garage.
  const near = (loc) => {
    if (!new RegExp(`\\b${street.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(String(loc).toUpperCase())) return false;
    if (addr.num == null) return true;
    const n = houseNum(loc);
    return n == null ? false : Math.abs(n - addr.num) <= 200;
  };
  // No tickets anywhere on this street = outside the county's parking districts (e.g. Gaithersburg and Rockville run their own).
  if (!reasons.length) return null;
  const rows = [], hours = Array(24).fill(0), days = Array(7).fill(0);
  for (const r of reasons) if (near(r.ticket_location)) rows.push({ block: titleCase(r.ticket_location), reason: r.violation_description, n: +r.n, fine: 0 });
  for (const r of dws) if (near(r.ticket_location)) days[+r.d] += +r.n;
  const a = span?.[0]?.a ? new Date(span[0].a) : null, b = span?.[0]?.b ? new Date(span[0].b) : null;
  const months = a && b ? Math.max(1, Math.round((b - a) / (30.4 * 864e5))) : 12;
  const period = a && b ? `${MON[a.getMonth()]} ${a.getFullYear()}–${MON[b.getMonth()]} ${b.getFullYear()}` : 'the last year';
  const where2 = addr.num != null ? `on the ${Math.floor(addr.num / 100) * 100} block of ${titleCase(addr.road)}` : `on ${titleCase(addr.road)}`;
  return summarize(p, { area: 'Montgomery County', source: 'Montgomery County DOT parking tickets', period, months, rows, hours, days, where: where2 });
}

// ---------------------------------------------------------------- shared
function summarize(p, d) {
  const byReason = new Map();
  let total = 0, carOnly = 0, fineSum = 0, fineN = 0;
  for (const r of d.rows) {
    const x = byReason.get(r.reason) || { reason: r.reason, n: 0, fine: 0, fn: 0 };
    x.n += r.n; if (r.fine) { x.fine += r.fine * r.n; x.fn += r.n; }
    byReason.set(r.reason, x);
    total += r.n;
    if (explain(r.reason).key === 'car') carOnly += r.n;
    if (r.fine) { fineSum += r.fine * r.n; fineN += r.n; }
  }
  const spot = total - carOnly;                 // tickets about where and when people parked
  const perMonth = spot / Math.max(1, d.months);
  const level = perMonth >= 25 ? 'high' : perMonth >= 6 ? 'medium' : 'low';
  const reasons = [...byReason.values()].sort((a, b) => b.n - a.n).slice(0, 6)
    .map((x) => ({ desc: titleCase(x.reason), n: x.n, fine: x.fn ? Math.round(x.fine / x.fn) : null, ...explain(x.reason) }));
  // Busiest 3-hour window, and whether right now falls in a busy hour
  let best = 0, bestAt = 0;
  for (let h = 0; h < 24; h++) { const s = d.hours[h] + d.hours[(h + 1) % 24] + d.hours[(h + 2) % 24]; if (s > best) { best = s; bestAt = h; } }
  const hourTotal = d.hours.reduce((a, b) => a + b, 0);
  const now = new Date();
  const nowShare = hourTotal ? d.hours[now.getHours()] / hourTotal : 0;
  const busyDays = d.days.map((n, i) => [DAYS[i], n]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([x]) => x);
  const blocks = new Map();
  for (const r of d.rows) { const b = blocks.get(r.block) || { block: r.block, n: 0, lat: r.lat, lng: r.lng }; b.n += r.n; blocks.set(r.block, b); }
  const mine = S.db.tickets.filter((t) => /park/i.test(t.type || '') && !t.example && dist(p, t) <= 150);
  return {
    ...d, total, spot, perMonth, level, reasons, hourTotal, busyDays, mine,
    avgFine: fineN ? Math.round(fineSum / fineN) : null,
    peak: best ? { from: bestAt, to: (bestAt + 3) % 24 } : null,
    busyNow: hourTotal >= 10 && nowShare >= 0.08,
    blocks: [...blocks.values()].sort((a, b) => b.n - a.n).slice(0, 5),
    at: { lat: p.lat, lng: p.lng }, checked: Date.now(),
  };
}

/** Parking-ticket risk around a point. Returns null with a reason when there's no data for that area. */
export async function parkingRisk(p) {
  if (inDCBox(p)) {
    const r = await dcRisk(p);
    if (r.total || !inMoCoBox(p)) return r;   // near the DC line, fall through to the county if DC had nothing
  }
  if (inMoCoBox(p)) {
    const addr = await reverse(p);
    if (/montgomery/i.test(addr.county) && /maryland/i.test(addr.state)) {
      const r = await mocoRisk(p, addr);
      if (r) return r;
      return none(p, `No county parking tickets are on file for ${titleCase(addr.road) || 'this street'}. ${addr.city ? titleCase(addr.city) + ' may' : 'The town may'} run its own parking enforcement, which isn't published. Read the signs and use the checklist below.`);
    }
    if (/district of columbia/i.test(addr.state)) return dcRisk(p);
  }
  return none(p, 'Parking-ticket data covers DC and Montgomery County\'s parking districts (Bethesda, Silver Spring, Wheaton). Other areas aren\'t published yet, so read the signs and use the checklist below.');
}
const none = (p, why) => ({ none: true, why, at: { lat: p.lat, lng: p.lng }, mine: S.db.tickets.filter((t) => /park/i.test(t.type || '') && !t.example && dist(p, t) <= 150) });

export const hourName = (h) => (h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`);
export const LEVEL = {
  low: { t: 'Low ticket risk', c: 'var(--ok)', e: '🟢' },
  medium: { t: 'Some ticket risk', c: 'var(--warn)', e: '🟡' },
  high: { t: 'High ticket risk', c: 'var(--danger)', e: '🔴' },
};

/** One-sentence spoken summary for voice and the after-parking warning. */
export function spokenRisk(r) {
  if (!r || r.none) return r?.mine?.length ? 'You got a parking ticket near here before. Check the signs.' : '';
  const lvl = r.level === 'high' ? 'Heads up. This is a high ticket area.' : r.level === 'medium' ? 'Some parking tickets are written here.' : 'Few parking tickets are written here.';
  const top = r.reasons.find((x) => x.key !== 'car');
  const why = top && r.level !== 'low' ? ` Most are for ${top.desc.toLowerCase()}.` : '';
  const now = r.busyNow ? ' Right now is a busy ticket time.' : '';
  const mine = r.mine.length ? ' You were ticketed near here before.' : '';
  return lvl + why + now + mine;
}
