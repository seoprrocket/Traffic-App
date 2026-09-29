// Official camera lists that publish exact locations. Used on the phone when the backend
// isn't connected (the camera-sync agent does the same work server-side when it is).
import { parseHeading, dist } from './util.js';

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

/** Every structured source, each allowed to fail on its own. */
export async function loadAllPublic() {
  const results = await Promise.allSettled([loadDC(), loadMoCo(), loadPG()]);
  results.forEach((r, i) => { if (r.status === 'rejected') console.warn('Camera source failed:', ['DC', 'Montgomery', "Prince George's"][i], r.reason?.message || r.reason); });
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}
