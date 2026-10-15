// Turn-by-turn navigation inside the app: route on the map, next-turn banner, spoken instructions,
// automatic re-routing when you leave the route, quick stops along the way, alternative routes,
// toll/highway/ferry avoidance and a fuel-efficient pick. Routes come from OSRM (OpenStreetMap);
// camera and ticket warnings keep running on top because navigation rides on drive mode.
import { S, persist } from './store.js';
import { $, $$, esc, dist, fmtDist, sayDist, toast, bus } from './util.js';
import { map } from './mapview.js';
import { E } from './engine.js';
import { speak, beep, locateOnce, listen } from './native.js';
import { startTrip, endTrip, googleNav } from './trip.js';
import { overpass } from './overpass.js';
import { openSheet, closeSheet, head } from './ui.js';

const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const layer = L.layerGroup().addTo(map);
let N = null;            // active navigation
let follow = true;

export const navOn = () => !!N;
export const navState = () => N;

// ---------------------------------------------------------------- route preferences
export const AVOID = [['toll', 'Tolls'], ['motorway', 'Highways'], ['ferry', 'Ferries']];
export const ENGINES = [['petrol', 'Gas (petrol)'], ['diesel', 'Diesel'], ['hybrid', 'Hybrid'], ['electric', 'Electric']];
// typical consumption used for the fuel estimate: miles per gallon, or miles per kWh for electric
const MPG = { petrol: 28, diesel: 34, hybrid: 48, electric: 3.6 };
export function fuelEstimate(meters, engine = S.db.settings.engine) {
  const mi = meters / 1609.34, rate = MPG[engine] || MPG.petrol;
  return engine === 'electric' ? `≈${(mi / rate).toFixed(1)} kWh` : `≈${(mi / rate).toFixed(mi / rate < 1 ? 2 : 1)} gal`;
}

// ---------------------------------------------------------------- route
/** Routes from here to there, through any stops. The first is the best one; the rest are alternatives (only when there are no stops). */
async function fetchRoutes(from, to, heading, via = []) {
  const coords = [from, ...via, to].map((p) => `${p.lng},${p.lat}`).join(';');
  const avoid = (S.db.settings.avoid || []).filter((a) => AVOID.some(([k]) => k === a));
  const attempts = avoid.length > 1 ? [avoid, avoid.slice(0, 1), []] : avoid.length ? [avoid, []] : [[]];
  let lastErr = null;
  for (const ex of attempts) {
    const q = new URLSearchParams({ overview: 'false', steps: 'true', geometries: 'geojson' });
    if (!via.length) q.set('alternatives', 'true');
    if (ex.length) q.set('exclude', ex.join(','));
    if (heading != null && !Number.isNaN(heading)) q.set('bearings', [`${Math.round((heading + 360) % 360)},60`, ...via.map(() => ''), ''].join(';'));
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(`${OSRM}${coords}?${q}`, { signal: ctl.signal });
      const js = await r.json();
      if (!js.routes?.length) throw new Error(js.message || 'No route found');
      const routes = js.routes.map((rt) => shape(rt, via));
      routes.forEach((R) => { R.avoided = ex; });
      if (ex.length < avoid.length) routes.forEach((R) => { R.avoidNote = `Couldn't avoid ${avoid.filter((a) => !ex.includes(a)).map((a) => AVOID.find(([k]) => k === a)[1].toLowerCase()).join(' and ')} on this trip`; });
      return routes;
    } catch (e) { lastErr = e; } finally { clearTimeout(timer); }
  }
  throw lastErr || new Error('No route found');
}
/** The route to drive: the fastest, or (with fuel-efficient routes on) the shortest one that's no more than 15% slower. */
function pickRoute(routes) {
  if (!S.db.settings.ecoRoutes || routes.length < 2) return routes[0];
  const fastest = routes[0];
  const eco = [...routes].sort((a, b) => a.meters - b.meters)[0];
  if (eco !== fastest && eco.secs <= fastest.secs * 1.15 && eco.meters < fastest.meters * 0.97) { eco.eco = true; return eco; }
  return fastest;
}
/** OSRM route → one line of points with cumulative distance, and steps indexed into it. Arrival steps of intermediate legs are the stops. */
export function shape(rt, via = []) {
  const pts = [], steps = [];
  rt.legs.forEach((leg, li) => {
    for (const st of leg.steps) {
      const c = st.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
      const start = pts.length ? pts.length - 1 : 0;
      pts.push(...(pts.length ? c.slice(1) : c));
      const m = st.maneuver;
      const step = { idx: start, type: m.type, mod: m.modifier || '', exit: m.exit || null, name: st.name || '', ref: st.ref || '',
        dest: st.destinations || '', exits: st.exits || '', side: st.driving_side, loc: { lat: m.location[1], lng: m.location[0] }, dist: st.distance };
      if (m.type === 'arrive' && li < rt.legs.length - 1) { step.stop = via[li]?.name || `Stop ${li + 1}`; step.stopId = via[li]?.id; }
      steps.push(step);
    }
  });
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return { pts, cum, steps, total: cum.at(-1) || 0, meters: rt.distance || cum.at(-1) || 0, secs: rt.duration, summary: rt.legs.map((l) => l.summary).filter(Boolean).join(', ') };
}

// ---------------------------------------------------------------- words and arrows
const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
const road = (s) => s.name || s.ref || '';
const onto = (s) => (road(s) ? ` onto ${road(s)}` : '');
export function instruction(s) {
  const m = s.mod;
  switch (s.type) {
    case 'depart': return `Head out${onto(s).replace(' onto', ' on')}`;
    case 'arrive': return s.stop ? `Stop: ${s.stop}${m === 'left' || m === 'right' ? `, on the ${m}` : ''}` : `Arrive at your destination${m === 'left' || m === 'right' ? `, on the ${m}` : ''}`;
    case 'roundabout': case 'rotary': case 'exit roundabout': case 'exit rotary':
      return `At the ${s.type.includes('rotary') ? 'traffic circle' : 'roundabout'}, take the ${ORD[s.exit] || 'next'} exit${onto(s)}`;
    case 'roundabout turn': return `At the roundabout, turn ${m}${onto(s)}`;
    case 'merge': return `Merge${m.includes('left') ? ' left' : m.includes('right') ? ' right' : ''}${onto(s)}`;
    case 'on ramp': return `Take the ramp${m.includes('left') ? ' on the left' : ''}${s.dest ? ` toward ${s.dest.split(',')[0]}` : onto(s)}`;
    case 'off ramp': return `Take ${s.exits ? `exit ${s.exits.split(';')[0]}` : 'the exit'}${m.includes('left') ? ' on the left' : ''}${s.dest ? ` toward ${s.dest.split(',')[0]}` : onto(s)}`;
    case 'fork': return `Keep ${m.includes('left') ? 'left' : 'right'} at the fork${s.dest ? ` toward ${s.dest.split(',')[0]}` : onto(s)}`;
    case 'new name': return `Continue${onto(s)}`;
    case 'continue': return m === 'uturn' ? `Make a U-turn${onto(s)}` : m && m !== 'straight' ? `Keep ${m.replace('slight ', '')}${onto(s)}` : `Continue straight${onto(s)}`;
    case 'end of road': case 'turn': default:
      if (m === 'uturn') return `Make a U-turn${onto(s)}`;
      if (m === 'straight') return `Continue straight${onto(s)}`;
      return `Turn ${m || 'ahead'}${onto(s)}`;
  }
}
const ARROW = { left: 'M30 12 L12 30 L30 48 M12 30 L48 30 L48 52', right: 'M30 12 L48 30 L30 48 M48 30 L12 30 L12 52',
  'slight left': 'M16 14 L16 30 L32 30 M16 14 L40 38 L40 54', 'slight right': 'M44 14 L44 30 L28 30 M44 14 L20 38 L20 54',
  'sharp left': 'M14 40 L14 22 L32 22 M14 40 L44 10 M44 10 L44 54', 'sharp right': 'M46 40 L46 22 L28 22 M46 40 L16 10 M16 10 L16 54',
  straight: 'M30 8 L16 24 M30 8 L44 24 M30 8 L30 54', uturn: 'M18 54 L18 24 Q18 10 30 10 Q42 10 42 24 L42 40 M34 32 L42 42 L50 32' };
export function arrowSvg(s) {
  if (s.type === 'arrive') return s.stop ? '<svg viewBox="0 0 60 60"><circle cx="30" cy="26" r="13" fill="none" stroke="currentColor" stroke-width="5"/><path d="M30 39 L30 54" stroke="currentColor" stroke-width="5" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 60 60"><path d="M18 8 L18 54 M18 10 L46 10 L40 20 L46 30 L18 30" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>';
  if (/roundabout|rotary/.test(s.type)) return '<svg viewBox="0 0 60 60"><circle cx="30" cy="30" r="12" fill="none" stroke="currentColor" stroke-width="5"/><path d="M30 54 L30 42 M42 30 L54 30 M48 22 L54 30 L48 38" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  let k = s.mod || 'straight';
  if (s.type === 'fork' || s.type === 'off ramp' || s.type === 'on ramp' || s.type === 'merge') k = k.includes('left') ? 'slight left' : k.includes('right') ? 'slight right' : 'straight';
  return `<svg viewBox="0 0 60 60"><path d="${ARROW[k] || ARROW.straight}" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// ---------------------------------------------------------------- where am I on the route
function project(p, a, b) {
  const k = Math.cos(p.lat * Math.PI / 180) * 111320, ky = 110540;
  const ax = a.lng * k, ay = a.lat * ky, bx = b.lng * k, by = b.lat * ky, px = p.lng * k, py = p.lat * ky;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return { t, d: Math.sqrt(x * x + y * y) };
}
export function locate(R, p, fromSeg = 0) {
  let best = { d: Infinity, seg: fromSeg, t: 0 };
  const lo = Math.max(0, fromSeg - 3), hi = Math.min(R.pts.length - 1, fromSeg + 400);
  for (let i = lo; i < hi; i++) { const r = project(p, R.pts[i], R.pts[i + 1]); if (r.d < best.d) best = { d: r.d, seg: i, t: r.t }; }
  const segLen = R.cum[best.seg + 1] - R.cum[best.seg];
  const along = R.cum[best.seg] + best.t * segLen;
  let step = 0;
  for (let i = 0; i < R.steps.length; i++) if (R.steps[i].idx <= best.seg) step = i; else break;
  return { off: best.d, seg: best.seg, along, step };
}

// ---------------------------------------------------------------- start / stop
export async function startNav({ dest, name, arriveBy = null, factor = 1, stops = [] }) {
  let from = E.me;
  if (!from) { try { from = await locateOnce(); } catch { toast('Turn on location to navigate'); return false; } }
  toast('Finding the best route…');
  let routes;
  try { routes = await fetchRoutes(from, dest, E.heading, stops); } catch (e) { toast('Couldn\'t find a route. Check your connection and try again.'); return false; }
  const R = pickRoute(routes);
  N = { dest: { lat: dest.lat, lng: dest.lng, label: dest.label || '' }, name: name || (dest.label || 'Destination').split(',')[0], R, alts: routes.filter((x) => x !== R), stops: [...stops],
    seg: 0, step: 0, said: {}, offCount: 0, rerouteAt: 0, factor: factor || 1, voice: voiceMode(), altsUntil: Date.now() + 10 * 60000 };
  follow = true;
  E.onRoute = routeAhead; E.silent = N.voice === 'mute';
  document.body.classList.add('nav');
  bus.emit('nav-start');
  drawRoute();
  startTrip({ dest: N.dest, name: N.name, arriveBy, factor });     // ETA, share link, arrival and drive mode
  bus.emit('go', 'map');
  paint();
  if (R.avoidNote) toast(R.avoidNote, 5000);
  const first = R.steps[1];
  say(`Starting route to ${N.name}${R.eco ? ', the fuel-efficient way' : ''}. ${fmtDist(R.total)}.${N.alts.length ? ` ${N.alts.length === 1 ? 'One alternative route is' : N.alts.length + ' alternative routes are'} shown in gray; tap one to take it.` : ''} ${first ? `${instruction(first)} in ${sayDist(R.steps[1].idx ? R.cum[R.steps[1].idx] : 0)}.` : ''}`, true);
  setTimeout(() => { if (N && E.me) map.setView([E.me.lat, E.me.lng], 17); else map.fitBounds(L.latLngBounds(R.pts.map((x) => [x.lat, x.lng])), { padding: [60, 60] }); }, 120);
  return true;
}
/** For the camera engine: is this point on my route, ahead of me? → { on, ahead (m) }, or undefined when I'm not on the route myself. */
export function routeAhead(pt) {
  if (!N || N.along == null || N.offCount >= 3) return undefined;
  const pos = locate(N.R, pt, N.seg);
  const ahead = pos.along - N.along;
  return { on: pos.off <= 80 && ahead > -40, ahead };
}
export function endNav({ arrived = false, keepTrip = false } = {}) {
  if (!N) return;
  N = null; E.onRoute = null; E.silent = false;
  layer.clearLayers();
  document.body.classList.remove('nav');
  $('#navui')?.remove();
  if (!keepTrip && !arrived) endTrip();
  if (arrived) toast('You\'ve arrived', 4000);
}

const STOP_ICON = (i) => L.divIcon({ className: 'stop-pin', html: `<span>${i + 1}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] });
function drawRoute() {
  layer.clearLayers();
  // alternatives first (gray, underneath) — tap one to switch
  if (Date.now() < N.altsUntil) N.alts.forEach((A, i) => {
    const ll = A.pts.map((x) => [x.lat, x.lng]);
    L.polyline(ll, { color: '#fff', weight: 10, opacity: 0.7, interactive: false }).addTo(layer);
    const line = L.polyline(ll, { color: '#8a94a3', weight: 7, opacity: 0.95 }).addTo(layer);
    line.on('click', () => switchAlt(i));
    line.bindTooltip(`${Math.round(A.secs / 60)} min · ${fmtDist(A.total)}${A.summary ? ' · via ' + esc(A.summary) : ''} — tap to take this route`, { sticky: true });
  });
  const ll = N.R.pts.map((x) => [x.lat, x.lng]);
  L.polyline(ll, { color: '#0b3d91', weight: 11, opacity: 0.55, interactive: false }).addTo(layer);
  L.polyline(ll, { color: N.R.eco ? '#15803d' : '#3b82f6', weight: 7, opacity: 0.95, interactive: false }).addTo(layer);
  N.stops.forEach((s, i) => L.marker([s.lat, s.lng], { icon: STOP_ICON(i) }).bindPopup(`<b>${esc(s.name)}</b><br><small>Stop ${i + 1}${s.kind ? ' · ' + esc(s.kind) : ''}</small><div class="popbtns"><button data-nvstop="${esc(s.id)}">Remove stop</button></div>`).addTo(layer));
  L.circleMarker([N.dest.lat, N.dest.lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#d42a2a', fillOpacity: 1 }).bindPopup(esc(N.name)).addTo(layer);
}
document.addEventListener('click', (e) => { const b = e.target.closest('.leaflet-popup [data-nvstop]'); if (b) { map.closePopup(); removeStop(b.dataset.nvstop); } });

/** Take alternative route i (gray on the map). */
export function switchAlt(i) {
  if (!N || !N.alts[i]) return false;
  const A = N.alts[i];
  N.alts = N.alts.filter((x) => x !== A).concat(N.R);
  Object.assign(N, { R: A, seg: 0, step: 0, said: {}, altsUntil: Date.now() + 5 * 60000 });
  drawRoute(); paint();
  say(`Taking the other route${A.summary ? ' via ' + A.summary : ''}. ${Math.round(A.secs / 60)} minutes.`, true);
  return true;
}

// ---------------------------------------------------------------- voice: all directions, alerts only, or full mute
const MODES = [['all', '🔊', 'Voice: directions and alerts'], ['alerts', '🔔', 'Alerts only: cameras, hazards and traffic speak; turn directions are silent'], ['mute', '🔇', 'Muted: nothing speaks until you unmute']];
function voiceMode() { const v = S.db.settings.navVoice; return MODES.some(([k]) => k === v) ? v : S.db.settings.navMuted ? 'mute' : 'all'; }
export function setVoice(mode) {
  if (!MODES.some(([k]) => k === mode)) mode = MODES[(MODES.findIndex(([k]) => k === voiceMode()) + 1) % MODES.length][0];
  S.db.settings.navVoice = mode; S.db.settings.navMuted = mode === 'mute'; persist();
  E.silent = mode === 'mute';
  if (N) { N.voice = mode; paint(); }
  toast(MODES.find(([k]) => k === mode)[2]);
  if (mode !== 'mute') speak(mode === 'all' ? 'Voice directions on.' : 'Alerts only.');
  return mode;
}
function say(text, force) {
  if (!N) return;
  if (N.voice === 'mute') return;
  if (N.voice === 'alerts' && !force) return;
  speak(text);
}

// ---------------------------------------------------------------- every GPS fix
bus.on('fix', async (p) => {
  if (!N) return;
  const R = N.R;
  const pos = locate(R, p, N.seg);
  N.seg = pos.seg; N.step = pos.step; N.along = pos.along;
  // off the route? (allow for GPS error and slow speeds)
  const tol = 45 + Math.min(40, (p.acc || 0));
  if (pos.off > tol && (p.speed || 0) > 1.5) N.offCount++; else N.offCount = 0;
  if (N.offCount >= 3 && Date.now() - N.rerouteAt > 10000) { reroute(p); }
  const next = R.steps[N.step + 1];
  if (next) {
    const toNext = R.cum[next.idx] - pos.along;
    N.toNext = toNext;
    const v = Math.max(5, p.speed || 0);
    const key = N.step + 1;
    const said = N.said[key] || (N.said[key] = {});
    const farAt = 800, midAt = Math.max(150, v * 14), nowAt = Math.max(35, v * 4.5);
    if (next.type === 'arrive' && next.stop) {
      if (toNext < midAt && !said.mid) { said.mid = 1; say(`Your stop, ${next.stop}, is ${sayDist(Math.max(30, toNext))} ahead${next.mod === 'left' || next.mod === 'right' ? `, on the ${next.mod}` : ''}.`); }
      if (toNext < 45 && !said.now) { said.now = 1; arrivedAtStop(next); }
    } else if (next.type === 'arrive') {
      if (toNext < midAt && !said.mid) { said.mid = 1; say(`Your destination is ${sayDist(Math.max(30, toNext))} ahead${next.mod === 'left' || next.mod === 'right' ? `, on the ${next.mod}` : ''}.`); }
    } else if (toNext <= nowAt && !said.now) { said.now = said.mid = said.far = 1; say(instruction(next)); beep(); }
    else if (toNext <= midAt && toNext > nowAt && !said.mid) { said.mid = said.far = 1; say(`In ${sayDist(Math.round(toNext / 10) * 10)}, ${lowerFirst(instruction(next))}.`); }
    else if (toNext <= farAt && toNext > midAt + 150 && !said.far && R.steps[N.step].dist > 1200) { said.far = 1; say(`In ${sayDist(toNext)}, ${lowerFirst(instruction(next))}.`); }
  } else N.toNext = 0;
  if (N.alts.length && Date.now() >= N.altsUntil && !N.altsCleared) { N.altsCleared = true; drawRoute(); }
  if (follow) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 16), { animate: true });
  paint();
});
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
function arrivedAtStop(step) {
  const s = N.stops.find((x) => x.id === step.stopId) || N.stops[0];
  if (s) N.stops = N.stops.filter((x) => x !== s);
  const left = N.stops.length;
  say(`You're at ${step.stop}. When you're ready, continue${left ? ` to your next stop` : ` to ${N.name}`}.`, true);
  toast(`Stop: ${step.stop}. Route continues to ${left ? 'your next stop' : N.name}.`, 6000);
  drawRoute();
}

async function reroute(p) {
  N.rerouteAt = Date.now(); N.offCount = 0;
  say('Rerouting.');
  try {
    const routes = await fetchRoutes(p, N.dest, p.heading ?? E.heading, N.stops);
    if (!N) return;
    const R = pickRoute(routes);
    Object.assign(N, { R, alts: routes.filter((x) => x !== R), seg: 0, step: 0, said: {}, altsUntil: Date.now() + 3 * 60000, altsCleared: false });
    drawRoute(); paint();
  } catch { toast('Couldn\'t reroute right now. Keep heading toward your destination.'); }
}

// ---------------------------------------------------------------- stops along the way
export const STOP_KINDS = [
  ['fuel', '⛽', 'Gas', '["amenity"="fuel"]'],
  ['coffee', '☕', 'Coffee', '["amenity"="cafe"]'],
  ['atm', '🏧', 'ATM', '["amenity"~"^(atm|bank)$"]'],
  ['food', '🍔', 'Food', '["amenity"~"^(restaurant|fast_food)$"]'],
  ['charge', '🔌', 'EV charging', '["amenity"="charging_station"]'],
  ['parking', '🅿️', 'Parking', '["amenity"="parking"]'],
  ['store', '🛒', 'Store', '["shop"~"^(convenience|supermarket)$"]'],
  ['pharmacy', '💊', 'Pharmacy', '["amenity"="pharmacy"]'],
  ['restroom', '🚻', 'Restroom', '["amenity"="toilets"]'],
];
/** Places of one kind along the next ~15 km of the route, nearest first. */
export async function placesAlongRoute(kind, { maxAhead = 15000, radius = 400 } = {}) {
  if (!N) throw new Error('Start navigation first');
  const k = STOP_KINDS.find((x) => x[0] === kind); if (!k) throw new Error('Unknown stop kind');
  const R = N.R, from = N.along || 0;
  const line = [];
  let lastAt = -1e9;
  for (let i = Math.max(0, N.seg); i < R.pts.length; i++) {
    const a = R.cum[i] - from; if (a > maxAhead) break;
    if (a - lastAt >= 350 || i === R.pts.length - 1) { line.push(`${R.pts[i].lat.toFixed(5)},${R.pts[i].lng.toFixed(5)}`); lastAt = a; }
  }
  if (line.length < 2 && E.me) line.unshift(`${E.me.lat.toFixed(5)},${E.me.lng.toFixed(5)}`);
  const q = `[out:json][timeout:12];nwr${k[3]}(around:${radius},${line.join(',')});out center 40;`;
  const js = await overpass(q, { timeoutMs: 14000 });
  const out = (js.elements || []).map((el) => {
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon; if (lat == null) return null;
    const t = el.tags || {};
    const pos = locate(R, { lat, lng }, N.seg);
    return { id: 'osm' + el.type[0] + el.id, kind: k[2], icon: k[1], name: t.name || t.brand || t.operator || k[2], lat, lng, ahead: pos.along - from, off: pos.off, hours: t.opening_hours || '', brand: t.brand || '' };
  }).filter((x) => x && x.ahead > -200).sort((a, b) => a.ahead - b.ahead);
  return out;
}
/** Add a stop and reroute through it. */
export async function addStop(s) {
  if (!N) { toast('Start navigation first, then add stops'); return false; }
  const stop = { id: s.id || 'stop' + Date.now(), name: (s.name || 'Stop').slice(0, 80), kind: s.kind || '', lat: s.lat, lng: s.lng };
  const from = E.me || N.R.pts[N.seg];
  // keep stops in the order you'll reach them along the current route
  const stops = [...N.stops, stop].map((x) => ({ x, at: locate(N.R, x, 0).along })).sort((a, b) => a.at - b.at).map((o) => o.x);
  toast(`Adding ${stop.name}…`);
  try {
    const routes = await fetchRoutes(from, N.dest, E.heading, stops);
    if (!N) return false;
    N.stops = stops;
    Object.assign(N, { R: routes[0], alts: [], seg: 0, step: 0, said: {}, altsCleared: true });
    drawRoute(); paint();
    const i = N.stops.indexOf(stop);
    const st = N.R.steps.find((x) => x.stopId === stop.id);
    say(`Added ${stop.name} as stop ${i + 1}${st ? `, ${sayDist(N.R.cum[st.idx])} ahead` : ''}. Then on to ${N.name}.`, true);
    return true;
  } catch { toast('Couldn\'t route through that stop.'); return false; }
}
export async function removeStop(id) {
  if (!N) return;
  const s = N.stops.find((x) => x.id === id); if (!s) return;
  const stops = N.stops.filter((x) => x !== s);
  try {
    const routes = await fetchRoutes(E.me || N.R.pts[N.seg], N.dest, E.heading, stops);
    if (!N) return;
    N.stops = stops;
    Object.assign(N, { R: routes[0], alts: [], seg: 0, step: 0, said: {}, altsCleared: true });
    drawRoute(); paint();
    toast(`Removed ${s.name}`);
  } catch { toast('Couldn\'t update the route.'); }
}
const clockAhead = (m) => (E.speed > 2 ? ` · ~${Math.max(1, Math.round(m / Math.max(E.speed, 8) / 60))} min` : '');
/** The "add a stop" sheet: quick kinds, a search box, and the stops already on the route. */
export function stopSheet(kind) {
  if (!N) { toast('Start navigation first, then add stops'); return; }
  openSheet(`${head('Add a stop')}
    <div class="sec">
      <p class="note" style="margin:0">Pick what you need and the closest options along the next ${fmtDist(15000)} of your route show up. Your trip to <b>${esc(N.name)}</b> continues after the stop.</p>
      <div class="chips" id="st-kinds">${STOP_KINDS.map(([k, ic, lb]) => `<button class="chip" data-kind="${k}"${kind === k ? ' aria-pressed="true"' : ''}>${ic} ${lb}</button>`).join('')}</div>
      <div class="ms-bar" style="position:static"><span class="ms-glass" aria-hidden="true">🔍</span><input id="st-q" type="search" placeholder="Or search a place or address" autocomplete="off"><button id="st-mic" type="button" aria-label="Say it">🎤</button></div>
      <div id="st-res" class="sec"></div>
      ${N.stops.length ? `<h3>Stops on this route</h3>${N.stops.map((s, i) => `<div class="row"><div class="main"><div class="ttl">${i + 1}. ${esc(s.name)}</div><div class="meta">${esc(s.kind || 'Stop')}</div></div><div class="acts"><button class="sbtn danger" data-rm="${esc(s.id)}">Remove</button></div></div>`).join('')}` : ''}
    </div>`, (s) => {
    const res = s.querySelector('#st-res');
    const show = (list, note) => {
      res.innerHTML = note ? `<div class="empty">${note}</div>` : list.slice(0, 12).map((p, i) => `<div class="row"><div class="main"><div class="ttl">${p.icon || '📍'} ${esc(p.name)}</div>
        <div class="meta">${p.ahead != null ? `${fmtDist(Math.max(0, p.ahead))} ahead${clockAhead(p.ahead)} · ${p.off < 60 ? 'on the route' : fmtDist(p.off) + ' off the route'}` : esc(p.sub || '')}${p.hours ? ' · ' + esc(p.hours.slice(0, 40)) : ''}</div>
        <div class="orow"><button class="sbtn primary" data-add="${i}">Add stop</button></div></div></div>`).join('');
      $$('[data-add]', res).forEach((b) => (b.onclick = async () => { closeSheet(); await addStop(list[+b.dataset.add]); }));
    };
    const run = async (k) => {
      $$('#st-kinds .chip', s).forEach((c) => c.setAttribute('aria-pressed', c.dataset.kind === k));
      res.innerHTML = '<div class="empty"><span class="ms-spin"></span> Looking along your route…</div>';
      try { const list = await placesAlongRoute(k); show(list, list.length ? '' : `Nothing of that kind within ${fmtDist(15000)} along the route. Try a search instead.`); }
      catch (e) { show([], 'Map data servers are busy. Try again in a moment.'); }
    };
    $$('#st-kinds .chip', s).forEach((c) => (c.onclick = () => run(c.dataset.kind)));
    const search = async () => {
      const q = s.querySelector('#st-q').value.trim(); if (q.length < 2) return;
      res.innerHTML = '<div class="empty"><span class="ms-spin"></span> Searching…</div>';
      const me = E.me || N.R.pts[N.seg];
      const u = new URLSearchParams({ format: 'json', limit: '8', countrycodes: 'us', q, viewbox: `${me.lng - 0.5},${me.lat + 0.4},${me.lng + 0.5},${me.lat - 0.4}`, bounded: '1' });
      try {
        const js = await (await fetch('https://nominatim.openstreetmap.org/search?' + u)).json();
        const list = js.map((x) => { const pos = locate(N.R, { lat: +x.lat, lng: +x.lon }, 0); const parts = x.display_name.split(', '); return { id: 'g' + x.place_id, name: parts[0], sub: parts.slice(1, 4).join(', '), lat: +x.lat, lng: +x.lon, ahead: pos.along - (N.along || 0), off: pos.off, kind: 'Search' }; });
        show(list, list.length ? '' : 'Nothing found. Add the city, like "Starbucks Bethesda".');
      } catch { show([], 'Search isn\'t reachable right now.'); }
    };
    s.querySelector('#st-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
    s.querySelector('#st-mic').onclick = async () => { try { const t = await listen(); if (t) { s.querySelector('#st-q').value = t; const k = STOP_KINDS.find(([, , lb]) => new RegExp(lb.split(' ')[0], 'i').test(t)) || (/gas|fuel/i.test(t) && STOP_KINDS[0]); if (k) run(k[0]); else search(); } } catch (e) { toast(e.message); } };
    $$('[data-rm]', s).forEach((b) => (b.onclick = () => { closeSheet(); removeStop(b.dataset.rm); }));
    if (kind) run(kind);
  });
}

// ---------------------------------------------------------------- screen
const clock = (t) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
export function recenter() { follow = true; if (E.me) map.setView([E.me.lat, E.me.lng], 17); if (N) paint(); }
function paint() {
  if (!N) return;
  let ui = $('#navui');
  if (!ui) {
    ui = document.createElement('div'); ui.id = 'navui';
    ui.innerHTML = `<div class="navtop" role="status" aria-live="polite"><div class="navarrow"></div><div class="navtxt"><b class="navdist"></b><span class="navins"></span></div></div>
      <div class="navthen" hidden></div>
      <div class="navalts" hidden></div>
      <div class="navbot"><div class="navstats"><b class="navmin"></b><span class="navsub"></span></div>
        <button class="navbtn" data-nv="center" aria-label="Re-center" hidden>⌖</button>
        <button class="navbtn" data-nv="stop" aria-label="Add a stop">➕</button>
        <button class="navbtn" data-nv="over" aria-label="Route overview">🗺</button>
        <button class="navbtn" data-nv="mute" aria-label="Voice mode"></button>
        <button class="navbtn end" data-nv="end">End</button></div>`;
    $('#view-map').appendChild(ui);
    ui.addEventListener('click', (e) => {
      const alt = e.target.closest('[data-alt]'); if (alt && N) { switchAlt(+alt.dataset.alt); return; }
      const b = e.target.closest('[data-nv]'); if (!b || !N) return;
      const k = b.dataset.nv;
      if (k === 'end') { endNav(); toast('Navigation ended'); }
      if (k === 'mute') setVoice();
      if (k === 'stop') stopSheet();
      if (k === 'over') { follow = false; map.fitBounds(L.latLngBounds(N.R.pts.slice(N.seg).map((x) => [x.lat, x.lng])), { padding: [80, 40] }); paint(); }
      if (k === 'center') recenter();
    });
  }
  const R = N.R;
  const next = R.steps[N.step + 1] || R.steps.at(-1);
  const toNext = N.toNext ?? (next ? R.cum[next.idx] : 0);
  ui.querySelector('.navarrow').innerHTML = arrowSvg(next);
  ui.querySelector('.navdist').textContent = next.type === 'arrive' && toNext < 30 ? 'Now' : fmtDist(Math.max(0, toNext));
  ui.querySelector('.navins').textContent = instruction(next);
  const then = R.steps[N.step + 2];
  const thenEl = ui.querySelector('.navthen');
  if (then && then.type !== 'arrive' && R.cum[then.idx] - R.cum[next.idx] < 200) { thenEl.hidden = false; thenEl.innerHTML = `Then ${arrowSvg(then)}`; } else thenEl.hidden = true;
  const left = Math.max(0, R.total - (N.along || 0));
  const secs = R.secs * (R.total ? left / R.total : 0) * (N.factor || 1);
  const eta = S.db.activeTrip?.eta && Math.abs(S.db.activeTrip.eta - (Date.now() + secs * 1000)) < 20 * 60000 ? S.db.activeTrip.eta : Date.now() + secs * 1000;
  ui.querySelector('.navmin').textContent = `${Math.max(1, Math.round(secs / 60))} min${R.eco ? ' · 🌿 eco' : ''}`;
  ui.querySelector('.navsub').textContent = `${fmtDist(left)} · arrive ${clock(eta)} · ${fuelEstimate(left)}${N.stops.length ? ` · ${N.stops.length} stop${N.stops.length === 1 ? '' : 's'}` : ''}`;
  ui.querySelector('[data-nv="mute"]').textContent = MODES.find(([k]) => k === N.voice)?.[1] || '🔊';
  ui.querySelector('[data-nv="center"]').hidden = follow;
  const altsEl = ui.querySelector('.navalts');
  const showAlts = N.alts.length && Date.now() < N.altsUntil;
  altsEl.hidden = !showAlts;
  if (showAlts) altsEl.innerHTML = N.alts.map((A, i) => `<button data-alt="${i}">${Math.round(A.secs / 60)} min · ${fmtDist(A.total)}${A.summary ? ' · via ' + esc(A.summary) : ''}</button>`).join('');
}
map.on('dragstart', () => { if (N) { follow = false; paint(); } });

// arrival and "End trip" from the ETA bar
bus.on('arrived', () => { if (N) endNav({ arrived: true }); });
bus.on('trip-ended', () => { if (N) endNav({ keepTrip: true }); });
bus.on('drive', (on) => { if (!on && N) endNav({ keepTrip: true }); });

/** Quick start from a place search result or saved trip. */
export function navLinks(dest) { return { google: googleNav(dest) }; }
