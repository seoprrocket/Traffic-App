// Road features from OpenStreetMap: posted speed limits, speed bumps, toll booths, sharp curves
// and speed-limit drops ahead. One query covers the ~900 m around you and is refreshed as you move.
import { dist, bearing, angleDiff } from './util.js';

import { overpass } from './overpass.js';
const RADIUS = 900;
export const road = { limit: null, name: null, way: null };
let cache = { at: null, t: 0, nodes: [], ways: [] };
let busy = false, failedAt = 0;

// ---------------------------------------------------------------- data
export function parseLimit(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  const n = parseFloat(s);
  if (isNaN(n)) return null;                                   // "signals", "none", "walk"
  return /mph/i.test(s) ? Math.round(n) : Math.round((n * 0.621371) / 5) * 5;
}

/** Turn an Overpass JSON response into bumps/tolls and road lines. */
export function parseOverpass(js) {
  const nodes = [], ways = [];
  for (const el of js?.elements || []) {
    const t = el.tags || {};
    if (el.type === 'node') {
      const kind = t.traffic_calming ? 'bump' : (t.barrier === 'toll_booth' || t.highway === 'toll_gantry') ? 'toll' : null;
      if (kind) nodes.push({ id: 'n' + el.id, kind, lat: el.lat, lng: el.lon, sub: t.traffic_calming || null });
    } else if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length > 1) {
      ways.push({ id: 'w' + el.id, pts: el.geometry.map((g) => ({ lat: g.lat, lng: g.lon })), limit: parseLimit(t.maxspeed),
        name: t.name || t.ref || null, oneway: t.oneway === 'yes', hw: t.highway });
    }
  }
  return { nodes, ways };
}

export async function refresh(p) {
  if (busy || Date.now() - failedAt < 30000) return;
  if (cache.at && dist(cache.at, p) < RADIUS / 2 && Date.now() - cache.t < 15 * 60000) return;
  busy = true;
  const q = `[out:json][timeout:20];(
    node(around:${RADIUS},${p.lat},${p.lng})[traffic_calming~"^(bump|hump|table|cushion|yes)$"];
    node(around:${RADIUS},${p.lat},${p.lng})[barrier=toll_booth];
    node(around:${RADIUS},${p.lat},${p.lng})[highway=toll_gantry];
    way(around:${RADIUS},${p.lat},${p.lng})[highway~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street)$"];
  );out geom;`;
  try {
    cache = { at: { lat: p.lat, lng: p.lng }, t: Date.now(), ...parseOverpass(await overpass(q, { timeoutMs: 20000 })) };
  } catch { failedAt = Date.now(); }
  finally { busy = false; }
}
export function setCache(data, at) { cache = { at, t: Date.now(), ...data }; }   // for tests

// ---------------------------------------------------------------- geometry
const rad = (x) => (x * Math.PI) / 180;
/** Where p falls on segment a-b: t in [0,1], distance in meters. */
function project(p, a, b) {
  const k = Math.cos(rad(p.lat)) * 111320, m = 110540;
  const ax = (a.lng - p.lng) * k, ay = (a.lat - p.lat) * m, bx = (b.lng - p.lng) * k, by = (b.lat - p.lat) * m;
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? -(ax * dx + ay * dy) / l : 0; t = Math.max(0, Math.min(1, t));
  return { t, d: Math.hypot(ax + t * dx, ay + t * dy), pt: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t } };
}

/** The road you're on and which way along it you're going. */
function match(p, heading) {
  let best = null;
  for (const w of cache.ways) {
    for (let i = 0; i < w.pts.length - 1; i++) {
      const pr = project(p, w.pts[i], w.pts[i + 1]);
      if (pr.d > 25 || (best && pr.d >= best.d)) continue;
      const b = bearing(w.pts[i], w.pts[i + 1]);
      let dir = 0;
      if (heading != null) {
        const f = angleDiff(b, heading), r = angleDiff((b + 180) % 360, heading);
        if (Math.min(f, r) > 40) continue;                     // a cross street
        dir = f <= r ? 1 : -1;
      }
      best = { way: w, i, pt: pr.pt, d: pr.d, dir };
    }
  }
  return best;
}

/** Points along the road ahead of you, each with its distance from you. */
function walkAhead(m, maxM) {
  const { way, i, pt, dir } = m;
  const out = [{ ...pt, at: 0 }];
  let at = 0;
  const idx = dir > 0 ? Array.from({ length: way.pts.length - i - 1 }, (_, k) => i + 1 + k) : Array.from({ length: i + 1 }, (_, k) => i - k);
  for (const j of idx) {
    const q = way.pts[j];
    at += dist(out[out.length - 1], q);
    out.push({ ...q, at });
    if (at >= maxM) return { path: out, end: null };
  }
  return { path: out, end: out[out.length - 1] };
}

function nearPath(path, q) {
  let best = { d: Infinity, at: 0 };
  for (let k = 0; k < path.length - 1; k++) {
    const pr = project(q, path[k], path[k + 1]);
    if (pr.d < best.d) best = { d: pr.d, at: path[k].at + dist(path[k], pr.pt) };
  }
  return best;
}
const pointAt = (path, at) => {
  for (let k = 1; k < path.length; k++) if (path[k].at >= at) {
    const a = path[k - 1], b = path[k], t = (at - a.at) / Math.max(0.01, b.at - a.at);
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  }
  return path[path.length - 1];
};

/** First bend of at least 60° between 60 m and 350 m ahead. */
function findCurve(path) {
  const total = path[path.length - 1].at;
  for (let k = 1; k < path.length - 1; k++) {
    const at = path[k].at;
    if (at < 60) continue;
    if (at > 350 || at + 40 > total) break;
    const a = pointAt(path, at - 40), b = pointAt(path, at + 40);
    const turn = angleDiff(bearing(a, path[k]), bearing(path[k], b));
    if (turn >= 60) return { at, turn, k };
  }
  return null;
}

/** The road that continues straight on from where this one ends. */
function nextWay(m, end, path) {
  const inB = bearing(path[Math.max(0, path.length - 2)], end);
  let best = null;
  for (const w of cache.ways) {
    if (w === m.way) continue;
    const first = w.pts[0], last = w.pts[w.pts.length - 1];
    let outB = null;
    if (dist(first, end) < 8) outB = bearing(first, w.pts[1]);
    else if (dist(last, end) < 8 && !w.oneway) outB = bearing(last, w.pts[w.pts.length - 2]);
    if (outB == null) continue;
    const diff = angleDiff(inB, outB);
    if (diff < 35 && (!best || diff < best.diff)) best = { way: w, diff };
  }
  return best?.way || null;
}

// ---------------------------------------------------------------- checks (called on every GPS fix)
/**
 * Updates `road` (limit + name) and returns warnings to show:
 * [{ key, title, sub, voice }]. `opts` = { bumps, curves, limits, tolls } toggles.
 */
export function check(p, heading, mph, opts) {
  const out = [];
  const m = cache.ways.length ? match(p, heading) : null;
  road.way = m?.way?.id || null;
  road.limit = m?.way?.limit ?? null;
  road.name = m?.way?.name ?? null;
  if (heading == null) return out;

  if (m && m.dir) {
    const { path, end } = walkAhead(m, 1200);
    if (opts.curves && mph >= 20) {
      const c = findCurve(path);
      if (c && c.at >= 90) out.push({ key: `curve-${m.way.id}-${c.k}`, title: 'Sharp curve ahead', sub: `In about ${Math.round(c.at * 3.281 / 50) * 50} ft${m.way.name ? ' on ' + m.way.name : ''}`, voice: 'Sharp curve ahead. Slow down.' });
    }
    if (opts.limits && end && end.at <= 300 && m.way.limit) {
      const nx = nextWay(m, end, path);
      if (nx?.limit && nx.limit <= m.way.limit - 10) {
        out.push({ key: `drop-${m.way.id}-${nx.id}`, title: `Speed limit drops to ${nx.limit}`, sub: `In about ${Math.round(end.at * 3.281 / 50) * 50} ft${nx.name ? ' on ' + nx.name : ''} (now ${m.way.limit})`, voice: `Speed limit drops to ${nx.limit} ahead.` });
      }
    }
    for (const n of cache.nodes) {
      if ((n.kind === 'bump' && !opts.bumps) || (n.kind === 'toll' && !opts.tolls)) continue;
      const np = nearPath(path, n);
      if (np.d > 12) continue;
      if (n.kind === 'bump' && np.at >= 40 && np.at <= 220 && mph >= 10) {
        out.push({ key: 'bump-' + n.id, group: 'bump', title: n.sub === 'table' ? 'Raised crosswalk ahead' : 'Speed bump ahead', sub: `In about ${Math.round(np.at * 3.281 / 25) * 25} ft`, voice: n.sub === 'table' ? 'Raised crosswalk ahead.' : 'Speed bump ahead.' });
      }
      if (n.kind === 'toll' && np.at >= 100 && np.at <= 1200) {
        out.push({ key: 'toll-' + n.id, group: 'toll', title: 'Toll ahead', sub: `In about ${(np.at / 1609.34).toFixed(1)} mi`, voice: 'Toll ahead.' });
      }
    }
  } else {
    // Not matched to a road (no map data yet, or GPS drift): use a narrow cone in front of you
    for (const n of cache.nodes) {
      const d = dist(p, n);
      if (angleDiff(bearing(p, n), heading) > 20) continue;
      if (n.kind === 'bump' && opts.bumps && d >= 40 && d <= 180 && mph >= 10) out.push({ key: 'bump-' + n.id, group: 'bump', title: 'Speed bump ahead', sub: `In about ${Math.round(d * 3.281 / 25) * 25} ft`, voice: 'Speed bump ahead.' });
      if (n.kind === 'toll' && opts.tolls && d >= 100 && d <= 1000) out.push({ key: 'toll-' + n.id, group: 'toll', title: 'Toll ahead', sub: `In about ${(d / 1609.34).toFixed(1)} mi`, voice: 'Toll ahead.' });
    }
  }
  return out;
}
