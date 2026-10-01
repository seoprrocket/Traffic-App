// Turn-by-turn navigation inside the app: route on the map, next-turn banner, spoken instructions,
// automatic re-routing when you leave the route. Routes come from OSRM (OpenStreetMap); camera and
// ticket warnings keep running on top because navigation rides on drive mode.
import { S, persist } from './store.js';
import { $, esc, dist, fmtDist, sayDist, toast, bus } from './util.js';
import { map } from './mapview.js';
import { E } from './engine.js';
import { speak, beep, locateOnce } from './native.js';
import { startTrip, endTrip, googleNav } from './trip.js';

const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const layer = L.layerGroup().addTo(map);
let N = null;            // active navigation
let follow = true;

export const navOn = () => !!N;

// ---------------------------------------------------------------- route
async function fetchRoute(from, to, heading) {
  const q = new URLSearchParams({ overview: 'false', steps: 'true', geometries: 'geojson' });
  if (heading != null && !Number.isNaN(heading)) q.set('bearings', `${Math.round((heading + 360) % 360)},60;`);
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(`${OSRM}${from.lng},${from.lat};${to.lng},${to.lat}?${q}`, { signal: ctl.signal });
    const js = await r.json();
    const rt = js.routes?.[0];
    if (!rt) throw new Error(js.message || 'No route found');
    return shape(rt);
  } finally { clearTimeout(timer); }
}
/** OSRM route → one line of points with cumulative distance, and steps indexed into it. */
export function shape(rt) {
  const pts = [], steps = [];
  for (const leg of rt.legs) for (const st of leg.steps) {
    const c = st.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
    const start = pts.length ? pts.length - 1 : 0;
    pts.push(...(pts.length ? c.slice(1) : c));
    const m = st.maneuver;
    steps.push({ idx: start, type: m.type, mod: m.modifier || '', exit: m.exit || null, name: st.name || '', ref: st.ref || '',
      dest: st.destinations || '', exits: st.exits || '', side: st.driving_side, loc: { lat: m.location[1], lng: m.location[0] }, dist: st.distance });
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return { pts, cum, steps, total: cum.at(-1) || 0, secs: rt.duration };
}

// ---------------------------------------------------------------- words and arrows
const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
const road = (s) => s.name || s.ref || '';
const onto = (s) => (road(s) ? ` onto ${road(s)}` : '');
export function instruction(s) {
  const m = s.mod;
  switch (s.type) {
    case 'depart': return `Head out${onto(s).replace(' onto', ' on')}`;
    case 'arrive': return `Arrive at your destination${m === 'left' || m === 'right' ? `, on the ${m}` : ''}`;
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
  if (s.type === 'arrive') return '<svg viewBox="0 0 60 60"><path d="M18 8 L18 54 M18 10 L46 10 L40 20 L46 30 L18 30" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>';
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
export async function startNav({ dest, name, arriveBy = null, factor = 1 }) {
  let from = E.me;
  if (!from) { try { from = await locateOnce(); } catch { toast('Turn on location to navigate'); return false; } }
  toast('Finding the best route…');
  let R;
  try { R = await fetchRoute(from, dest, E.heading); } catch (e) { toast('Couldn\'t find a route. Check your connection and try again.'); return false; }
  N = { dest: { lat: dest.lat, lng: dest.lng, label: dest.label || '' }, name: name || (dest.label || 'Destination').split(',')[0], R, seg: 0, step: 0, said: {}, offCount: 0, rerouteAt: 0, factor: factor || 1, muted: !!S.db.settings.navMuted };
  follow = true;
  document.body.classList.add('nav');
  bus.emit('nav-start');
  drawRoute();
  startTrip({ dest: N.dest, name: N.name, arriveBy, factor });     // ETA, share link, arrival and drive mode
  bus.emit('go', 'map');
  paint();
  const first = R.steps[1];
  say(`Starting route to ${N.name}. ${fmtDist(R.total)}. ${first ? `${instruction(first)} in ${sayDist(R.steps[1].idx ? R.cum[R.steps[1].idx] : 0)}.` : ''}`, true);
  setTimeout(() => { if (N && E.me) map.setView([E.me.lat, E.me.lng], 17); else map.fitBounds(L.latLngBounds(R.pts.map((x) => [x.lat, x.lng])), { padding: [60, 60] }); }, 120);
  return true;
}
export function endNav({ arrived = false, keepTrip = false } = {}) {
  if (!N) return;
  N = null;
  layer.clearLayers();
  document.body.classList.remove('nav');
  $('#navui')?.remove();
  if (!keepTrip && !arrived) endTrip();
  if (arrived) toast('You\'ve arrived', 4000);
}

function drawRoute() {
  layer.clearLayers();
  const ll = N.R.pts.map((x) => [x.lat, x.lng]);
  L.polyline(ll, { color: '#0b3d91', weight: 11, opacity: 0.55, interactive: false }).addTo(layer);
  L.polyline(ll, { color: '#3b82f6', weight: 7, opacity: 0.95, interactive: false }).addTo(layer);
  L.circleMarker([N.dest.lat, N.dest.lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#d42a2a', fillOpacity: 1 }).bindPopup(esc(N.name)).addTo(layer);
}

// ---------------------------------------------------------------- voice
function say(text, force) {
  if (!N || (N.muted && !force)) return;
  speak(text);
}
const near = (s) => (road(s) ? ` onto ${road(s)}` : '');

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
    if (next.type === 'arrive') {
      if (toNext < midAt && !said.mid) { said.mid = 1; say(`Your destination is ${sayDist(Math.max(30, toNext))} ahead${next.mod === 'left' || next.mod === 'right' ? `, on the ${next.mod}` : ''}.`); }
    } else if (toNext <= nowAt && !said.now) { said.now = said.mid = said.far = 1; say(instruction(next)); beep(); }
    else if (toNext <= midAt && toNext > nowAt && !said.mid) { said.mid = said.far = 1; say(`In ${sayDist(Math.round(toNext / 10) * 10)}, ${lowerFirst(instruction(next))}.`); }
    else if (toNext <= farAt && toNext > midAt + 150 && !said.far && R.steps[N.step].dist > 1200) { said.far = 1; say(`In ${sayDist(toNext)}, ${lowerFirst(instruction(next))}.`); }
  } else N.toNext = 0;
  if (follow) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 16), { animate: true });
  paint();
});
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

async function reroute(p) {
  N.rerouteAt = Date.now(); N.offCount = 0;
  say('Rerouting.');
  const dest = N.dest;
  try {
    const R = await fetchRoute(p, dest, p.heading ?? E.heading);
    if (!N) return;
    Object.assign(N, { R, seg: 0, step: 0, said: {} });
    drawRoute(); paint();
  } catch { toast('Couldn\'t reroute right now. Keep heading toward your destination.'); }
}

// ---------------------------------------------------------------- screen
const clock = (t) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
function paint() {
  if (!N) return;
  let ui = $('#navui');
  if (!ui) {
    ui = document.createElement('div'); ui.id = 'navui';
    ui.innerHTML = `<div class="navtop" role="status" aria-live="polite"><div class="navarrow"></div><div class="navtxt"><b class="navdist"></b><span class="navins"></span></div></div>
      <div class="navthen" hidden></div>
      <div class="navbot"><div class="navstats"><b class="navmin"></b><span class="navsub"></span></div>
        <button class="navbtn" data-nv="center" aria-label="Recenter" hidden>⌖</button>
        <button class="navbtn" data-nv="over" aria-label="Route overview">🗺</button>
        <button class="navbtn" data-nv="mute" aria-label="Mute voice"></button>
        <button class="navbtn end" data-nv="end">End</button></div>`;
    $('#view-map').appendChild(ui);
    ui.addEventListener('click', (e) => {
      const b = e.target.closest('[data-nv]'); if (!b || !N) return;
      const k = b.dataset.nv;
      if (k === 'end') { endNav(); toast('Navigation ended'); }
      if (k === 'mute') { N.muted = !N.muted; S.db.settings.navMuted = N.muted; persist(); paint(); toast(N.muted ? 'Voice directions off. Camera warnings still speak.' : 'Voice directions on'); }
      if (k === 'over') { follow = false; map.fitBounds(L.latLngBounds(N.R.pts.slice(N.seg).map((x) => [x.lat, x.lng])), { padding: [80, 40] }); paint(); }
      if (k === 'center') { follow = true; if (E.me) map.setView([E.me.lat, E.me.lng], 17); paint(); }
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
  ui.querySelector('.navmin').textContent = `${Math.max(1, Math.round(secs / 60))} min`;
  ui.querySelector('.navsub').textContent = `${fmtDist(left)} · arrive ${clock(eta)}`;
  ui.querySelector('[data-nv="mute"]').textContent = N.muted ? '🔇' : '🔊';
  ui.querySelector('[data-nv="center"]').hidden = follow;
}
map.on('dragstart', () => { if (N) { follow = false; paint(); } });

// arrival and "End trip" from the ETA bar
bus.on('arrived', () => { if (N) endNav({ arrived: true }); });
bus.on('trip-ended', () => { if (N) endNav({ keepTrip: true }); });
bus.on('drive', (on) => { if (!on && N) endNav({ keepTrip: true }); });

/** Quick start from a place search result or saved trip. */
export function navLinks(dest) { return { google: googleNav(dest) }; }
