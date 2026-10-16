// Official camera lists that publish exact locations. Used on the phone when the backend
// isn't connected (the camera-sync agent does the same work server-side when it is).
import { parseHeading, dist } from './util.js';
import { overpass } from './overpass.js';

export const DC_LAYER = 'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Public_Safety_WebMercator/MapServer/43/query';
export const MOCO_SPEED = 'https://data.montgomerycountymd.gov/resource/uv5p-zm58.json';
export const PG_ZONES = 'https://services.arcgis.com/kSZiBgsXsUF788NB/arcgis/rest/services/AED_Speed_Zones/FeatureServer/0/query';

const DC_KIND = { 'Speed': 'Speed', 'Red Light': 'Red light', 'Stop Sign': 'Stop sign', 'Truck Restriction': 'Truck', 'Bus Lane': 'Bus lane' };

// ---------------------------------------------------------------- parsers (pure, testable)
export function parseDC(features) {
  const out = [];
  for (const { attributes: a } of features || []) {
    if (a.CAMERA_LATITUDE == null || (a.ACTIVE_STATUS && !/active/i.test(a.ACTIVE_STATUS))) continue;
    out.push({ id: 'dc-' + (a.GLOBALID ?? a.OBJECTID), name: String(a.LOCATION_DESCRIPTION || 'DC camera').trim() + (/mobile/i.test(a.DEVICE_MOBILITY || '') ? ' (mobile)' : ''),
      lat: a.CAMERA_LATITUDE, lng: a.CAMERA_LONGITUDE, kind: DC_KIND[a.ENFORCEMENT_TYPE] || a.ENFORCEMENT_TYPE || 'Speed',
      limit: a.SPEED_LIMIT ? Math.round(a.SPEED_LIMIT) : null, heading: parseHeading(a.LOCATION_DESCRIPTION), verified: true,
      source: 'dc_open_data', jurisdiction: 'Washington, DC', official: true });
  }
  return out;
}

/** Montgomery County publishes one row per camera site per quarter. Keep the latest quarter. */
export function parseMoCo(rows) {
  rows = (rows || []).filter((r) => r.latitude && r.longitude && r.quarter_name);
  if (!rows.length) return [];
  const latest = rows.map((r) => r.quarter_name).sort().pop();
  const seen = new Set(), out = [];
  for (const r of rows) {
    if (r.quarter_name !== latest || seen.has(r.site_number)) continue;
    seen.add(r.site_number);
    const lat = +r.latitude, lng = +r.longitude;
    if (!isFinite(lat) || !isFinite(lng) || !lat) continue;
    out.push({ id: 'moco-' + r.site_number, name: `${String(r.address || 'Speed camera').trim()}${r.directions ? ' ' + r.directions : ''}`,
      lat, lng, kind: 'Speed', limit: null, heading: parseHeading(r.directions), verified: true,
      source: 'md_open_data', jurisdiction: 'Montgomery County, MD', official: true });
  }
  return out;
}

/** Point halfway along a line (the zone's middle). */
export function midpoint(coords) {
  const pts = coords.map(([lng, lat]) => ({ lat, lng }));
  if (pts.length === 1) return pts[0];
  let total = 0; const seg = [];
  for (let i = 1; i < pts.length; i++) { const d = dist(pts[i - 1], pts[i]); seg.push(d); total += d; }
  let half = total / 2;
  for (let i = 1; i < pts.length; i++) {
    if (half <= seg[i - 1] || i === pts.length - 1) {
      const t = seg[i - 1] ? Math.min(1, half / seg[i - 1]) : 0;
      return { lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t, lng: pts[i - 1].lng + (pts[i].lng - pts[i - 1].lng) * t };
    }
    half -= seg[i - 1];
  }
  return pts[0];
}

/** Prince George's County publishes school speed zones as road segments (GeoJSON). */
export function parsePG(geojson) {
  const out = [];
  for (const f of geojson?.features || []) {
    const p = f.properties || {}, g = f.geometry;
    if (!g) continue;
    const line = g.type === 'MultiLineString' ? g.coordinates.flat() : g.type === 'LineString' ? g.coordinates : g.type === 'Point' ? [g.coordinates] : null;
    if (!line || !line.length) continue;
    const m = midpoint(line);
    const inactive = /^no$/i.test(String(p.isActive || ''));
    out.push({ id: 'pg-' + (p.ObjectId ?? p.id), name: `${String(p.locname || 'School').trim()} ${/school/i.test(p.type || '') ? 'school zone' : 'speed zone'}${p.location ? ' · ' + String(p.location).trim() : ''}${inactive ? ' (listed inactive, may still enforce)' : ''}`,
      lat: +m.lat.toFixed(6), lng: +m.lng.toFixed(6), kind: /school/i.test(p.type || '') ? 'School zone' : 'Speed', limit: null, heading: null, verified: true,
      source: 'md_open_data', jurisdiction: "Prince George's County, MD", official: true });
  }
  return out;
}

// ---------------------------------------------------------------- loaders
async function getJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }

export async function loadDC() {
  const all = [];
  for (let off = 0; off < 5000; off += 1000) {
    const js = await getJson(`${DC_LAYER}?where=1%3D1&outFields=GLOBALID,OBJECTID,ENFORCEMENT_TYPE,LOCATION_DESCRIPTION,SPEED_LIMIT,DEVICE_MOBILITY,ACTIVE_STATUS,CAMERA_LATITUDE,CAMERA_LONGITUDE&returnGeometry=false&orderByFields=OBJECTID&resultOffset=${off}&resultRecordCount=1000&f=json`);
    all.push(...parseDC(js.features));
    if ((js.features || []).length < 1000) break;
  }
  return all;
}
export async function loadMoCo() {
  const q = encodeURIComponent;
  // newest quarter first; one quarter is a few hundred rows
  return parseMoCo(await getJson(`${MOCO_SPEED}?$select=${q('site_number,address,directions,latitude,longitude,quarter_name')}&$order=${q('quarter_name DESC')}&$limit=2000`));
}
export async function loadPG() {
  return parsePG(await getJson(`${PG_ZONES}?where=1%3D1&outFields=${encodeURIComponent('ObjectId,id,locname,location,type,isActive')}&outSR=4326&f=geojson&resultRecordCount=2000`));
}

// ---------------------------------------------------------------- Arlington County, VA (open data: school-zone speed + red-light cameras)
const ARL = 'https://arlgis.arlingtonva.us/arcgis/rest/services/Open_Data/';
const titleCase = (s) => String(s || '').trim().toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b(Nb|Sb|Eb|Wb|Ne|Nw|Se|Sw)\b/g, (m) => m.toUpperCase());
export function parseArlington(speed, red) {
  const out = [];
  for (const f of speed?.features || []) {
    const a = f.attributes || {}; if (!f.geometry || a.Retired || (a.Active && !/^y/i.test(String(a.Active)))) continue;
    const limit = parseInt(String(a.BeaconSpeedLimit ?? a.NonSchoolSpeedLimit ?? ''), 10);
    out.push({ id: 'arl-speed-' + (a.ID || a.OBJECTID), name: `${titleCase(a.Street)}${a.School ? ' @ ' + titleCase(a.School) : ''}${a.Direction ? ' ' + String(a.Direction).toUpperCase().replace(/B$/, '/B') : ''} (school zone)`, lat: f.geometry.y, lng: f.geometry.x, kind: 'Speed', limit: Number.isFinite(limit) ? limit : null, heading: parseHeading(String(a.Direction || '')), verified: true, source: 'arlington_open_data', jurisdiction: 'Arlington County, VA', official: true });
  }
  for (const f of red?.features || []) {
    const a = f.attributes || {}; if (!f.geometry || a.Retired) continue;
    out.push({ id: 'arl-red-' + (a.ID || a.OBJECTID), name: `${titleCase(a.Street)}${a.IntersectingStreet ? ' & ' + titleCase(a.IntersectingStreet) : ''}${a.Direction ? ' ' + String(a.Direction).toUpperCase().replace(/B$/, '/B') : ''}`, lat: f.geometry.y, lng: f.geometry.x, kind: 'Red light', limit: null, heading: parseHeading(String(a.Direction || '')), verified: true, source: 'arlington_open_data', jurisdiction: 'Arlington County, VA', official: true });
  }
  return out;
}
export async function loadArlington() {
  const q = (svc) => getJson(`${ARL}${svc}/MapServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=json&resultRecordCount=2000`);
  const [speed, red] = await Promise.all([q('od_DES_Signal_PhotoSpeed_Cameras_pnt'), q('od_DES_Signal_PhotoRED_Cameras_pnt')]);
  return parseArlington(speed, red);
}

// ---------------------------------------------------------------- OpenStreetMap: every mapped enforcement camera in MD, DC and VA
// Used on the phone when the backend hasn't synced them yet. State outlines (simplified) label each camera.
const STATES = {"Washington, DC":[[[-77.035,38.994],[-76.909,38.895],[-77.041,38.791],[-77.117,38.934],[-77.035,38.994]]],"Maryland":[[[-75.995,37.953],[-76.017,37.953],[-76.044,37.953],[-75.995,37.953]],[[-79.478,39.722],[-75.787,39.722],[-75.693,38.463],[-75.047,38.452],[-75.244,38.03],[-75.398,38.013],[-75.672,37.953],[-75.885,37.909],[-75.88,38.074],[-75.962,38.139],[-75.847,38.211],[-76.0,38.375],[-76.049,38.304],[-76.258,38.32],[-76.329,38.501],[-76.263,38.501],[-76.258,38.736],[-76.192,38.83],[-76.279,39.147],[-76.17,39.333],[-76.0,39.366],[-75.973,39.558],[-76.099,39.536],[-76.104,39.438],[-76.367,39.312],[-76.444,39.197],[-76.46,38.906],[-76.559,38.769],[-76.515,38.539],[-76.384,38.38],[-76.4,38.26],[-76.318,38.139],[-76.362,38.057],[-76.592,38.216],[-76.92,38.293],[-77.019,38.446],[-77.205,38.359],[-77.276,38.479],[-77.128,38.632],[-77.041,38.791],[-76.909,38.895],[-77.035,38.994],[-77.117,38.934],[-77.249,39.027],[-77.457,39.076],[-77.457,39.224],[-77.567,39.306],[-77.72,39.322],[-77.835,39.602],[-78.005,39.602],[-78.174,39.695],[-78.268,39.618],[-78.432,39.624],[-78.47,39.514],[-78.766,39.585],[-78.963,39.438],[-79.095,39.47],[-79.292,39.301],[-79.489,39.207],[-79.478,39.722]]],"Virginia":[[[-75.398,38.013],[-75.244,38.03],[-75.376,37.86],[-75.513,37.8],[-75.595,37.57],[-75.803,37.197],[-75.973,37.121],[-76.028,37.258],[-75.94,37.564],[-75.672,37.953],[-75.398,38.013]],[[-76.017,37.953],[-75.995,37.953],[-76.044,37.953],[-76.017,37.953]],[[-78.35,39.465],[-77.829,39.131],[-77.72,39.322],[-77.567,39.306],[-77.457,39.224],[-77.457,39.076],[-77.249,39.027],[-77.117,38.934],[-77.041,38.791],[-77.128,38.632],[-77.249,38.589],[-77.326,38.446],[-77.282,38.342],[-77.013,38.375],[-76.964,38.216],[-76.614,38.15],[-76.515,38.024],[-76.236,37.888],[-76.362,37.608],[-76.247,37.389],[-76.384,37.285],[-76.4,37.159],[-76.274,37.082],[-76.411,36.962],[-76.619,37.121],[-76.668,37.066],[-76.488,36.951],[-75.995,36.924],[-75.869,36.551],[-79.511,36.54],[-80.294,36.546],[-80.979,36.562],[-81.68,36.589],[-83.673,36.6],[-83.137,36.743],[-83.071,36.852],[-82.879,36.891],[-82.868,36.978],[-82.72,37.044],[-82.72,37.121],[-82.353,37.269],[-81.97,37.537],[-81.986,37.455],[-81.849,37.285],[-81.68,37.203],[-81.554,37.208],[-81.362,37.34],[-81.225,37.236],[-80.968,37.291],[-80.513,37.482],[-80.475,37.422],[-80.3,37.51],[-80.294,37.69],[-80.185,37.849],[-79.998,37.997],[-79.922,38.178],[-79.724,38.364],[-79.648,38.594],[-79.478,38.457],[-79.314,38.413],[-79.21,38.495],[-78.996,38.851],[-78.87,38.764],[-78.404,39.169],[-78.35,39.465]]]};
function inRing(x, y, ring) { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi) inside = !inside; } return inside; }
export const stateAt = (lat, lng) => Object.keys(STATES).find((k) => STATES[k].some((r) => inRing(lng, lat, r))) || null;
const CARD = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315, NORTH: 0, NORTHEAST: 45, EAST: 90, SOUTHEAST: 135, SOUTH: 180, SOUTHWEST: 225, WEST: 270, NORTHWEST: 315 };
export function parseOSM(js, skipNear = []) {
  const els = js.elements || [];
  const relFor = new Map();
  els.filter((e) => e.type === 'relation').forEach((r) => (r.members || []).forEach((m) => { if (m.type === 'node' && m.role === 'device') relFor.set(m.ref, r); }));
  const roads = els.filter((e) => e.type === 'way' && e.geometry && e.tags?.name);
  const out = [];
  for (const n of els) {
    if (n.type !== 'node' || n.lat == null) continue;
    const rel = relFor.get(n.id);
    if (!(n.tags?.highway === 'speed_camera' || rel)) continue;
    const t = { ...(rel?.tags || {}), ...(n.tags || {}) };
    const st = stateAt(n.lat, n.lon); if (!st) continue;
    const p = { lat: n.lat, lng: n.lon };
    if (skipNear.some((o) => Math.abs(o.lat - p.lat) < 0.001 && Math.abs(o.lng - p.lng) < 0.0013 && dist(o, p) < 60)) continue;
    const enf = String(rel?.tags?.enforcement || n.tags?.enforcement || 'maxspeed').toLowerCase();
    const kind = /traffic_signals|red/.test(enf) ? 'Red light' : /stop/.test(enf) ? 'Stop sign' : /bus/.test(enf) ? 'Bus lane' : 'Speed';
    let road = t.name && !/camera/i.test(t.name) ? t.name : '';
    if (!road) { let bd = 45; for (const w of roads) for (const v of w.geometry) { if (Math.abs(v.lat - p.lat) > 0.001 || Math.abs(v.lon - p.lng) > 0.0013) continue; const d = dist({ lat: v.lat, lng: v.lon }, p); if (d < bd) { bd = d; road = w.tags.name; } } }
    const dir = String(t.direction || '').trim().toUpperCase();
    const heading = /^\d+(\.\d+)?$/.test(dir) ? Math.round(+dir) % 360 : CARD[dir.split(/[;,-]/)[0]] ?? parseHeading(t.description || t.name);
    const lm = /(\d{2,3})\s*(mph)?/i.exec(t.maxspeed || '');
    out.push({ id: 'osm-n' + n.id, name: `${road || kind + ' camera'}${heading != null ? ' ' + ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(heading / 45) % 8] + '/B' : ''}`, lat: p.lat, lng: p.lng, kind, limit: lm && (lm[2] || +lm[1] <= 85) ? +lm[1] : null, heading, verified: false, source: 'osm', jurisdiction: st, official: true });
  }
  return out;
}
export async function loadOSM(skipNear = []) {
  const bbox = '36.50,-83.70,39.75,-75.00';
  const q = `[out:json][timeout:60];node["highway"="speed_camera"](${bbox})->.cams;relation["type"="enforcement"](${bbox})->.enf;node(r.enf:"device")->.dev;(.cams; .dev;)->.all;way(around.all:35)["highway"]["name"]->.roads;.cams out body; .enf out body; .dev out body; .roads out geom;`;
  return parseOSM(await overpass(q, { timeoutMs: 70000 }), skipNear);
}

/** Every structured source, each allowed to fail on its own. */
export async function loadAllPublic() {
  const results = await Promise.allSettled([loadDC(), loadMoCo(), loadPG(), loadArlington()]);
  results.forEach((r, i) => { if (r.status === 'rejected') console.warn('Camera source failed:', ['DC', 'Montgomery', "Prince George's", 'Arlington'][i], r.reason?.message || r.reason); });
  const list = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  try { list.push(...await loadOSM(list)); } catch (e) { console.warn('OpenStreetMap cameras failed:', e?.message || e); }
  return list;   // (no backend: refreshed every 20 h with the rest)
}
