// Agent 2 — Camera data
// Runs daily. Pulls the official camera lists that publish exact locations (DC, Montgomery County,
// Prince George's County), every enforcement camera mapped in OpenStreetMap across Maryland, DC and
// Virginia, then reads other county/town web pages listed in camera_sources.
import { serve, requireCron, admin } from "../_shared/http.ts";
import { askStructured, SMART_MODEL, claudeConfigured } from "../_shared/claude.ts";
import { geocode, parseHeading, dist, jurisdictionAt } from "../_shared/geo.ts";

const DC_LAYER = "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Public_Safety_WebMercator/MapServer/43/query";
const KIND: Record<string, string> = {
  "Speed": "Speed", "Red Light": "Red light", "Stop Sign": "Stop sign",
  "Truck Restriction": "Truck", "Bus Lane": "Bus lane", "Bus Zone": "Bus lane", "School Bus Stop-Arm": "School bus",
};
const started = Date.now();
const timeLeft = () => 140_000 - (Date.now() - started);

type Row = Record<string, unknown>;

/** Save one source's cameras and retire the ones it no longer lists. */
async function store(label: string, source: string, jurisdiction: string, rows: Row[], runAt: string) {
  if (!rows.length) return `${label}: no rows returned; kept existing cameras`;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin().from("cameras").upsert(rows.slice(i, i + 500), { onConflict: "source,source_ref" });
    if (error) throw error;
  }
  const { count } = await admin().from("cameras").update({ status: "retired" }, { count: "exact" })
    .eq("source", source).eq("jurisdiction", jurisdiction).eq("status", "active").lt("last_seen_at", runAt);
  return `${label}: ${rows.length} active, ${count ?? 0} retired`;
}
const base = (runAt: string) => ({ owner_id: null, verified: true, status: "active", last_seen_at: runAt });

async function syncDC() {
  const runAt = new Date().toISOString();
  const rows: Row[] = [];
  for (let offset = 0; offset < 20000; offset += 1000) {
    const url = `${DC_LAYER}?where=1%3D1&outFields=*&returnGeometry=false&orderByFields=OBJECTID&resultOffset=${offset}&resultRecordCount=1000&f=json`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`DC data ${r.status}`);
    const js = await r.json();
    const feats = js.features ?? [];
    for (const { attributes: a } of feats) {
      if (a.CAMERA_LATITUDE == null || a.CAMERA_LONGITUDE == null) continue;
      if (a.ACTIVE_STATUS && !/active/i.test(a.ACTIVE_STATUS)) continue;
      const mobile = /mobile/i.test(a.DEVICE_MOBILITY ?? "");
      rows.push({
        ...base(runAt), source: "dc_open_data", source_ref: String(a.GLOBALID ?? a.OBJECTID), jurisdiction: "Washington, DC",
        name: `${String(a.LOCATION_DESCRIPTION ?? "DC camera").trim()}${mobile ? " (mobile)" : ""}`,
        lat: a.CAMERA_LATITUDE, lng: a.CAMERA_LONGITUDE,
        kind: KIND[a.ENFORCEMENT_TYPE] ?? a.ENFORCEMENT_TYPE ?? "Speed",
        speed_limit: a.SPEED_LIMIT ? Math.round(a.SPEED_LIMIT) : null,
        heading: parseHeading(a.LOCATION_DESCRIPTION),
      });
    }
    if (!js.exceededTransferLimit && feats.length < 1000) break;
  }
  return store("DC", "dc_open_data", "Washington, DC", rows, runAt);
}

// Montgomery County, MD: one row per camera site per quarter, with coordinates and direction
const MOCO = "https://data.montgomerycountymd.gov/resource/uv5p-zm58.json";
async function syncMoCo() {
  const runAt = new Date().toISOString();
  const q = encodeURIComponent;
  const r = await fetch(`${MOCO}?$select=${q("site_number,address,directions,latitude,longitude,quarter_name")}&$order=${q("quarter_name DESC")}&$limit=2000`);
  if (!r.ok) throw new Error(`Montgomery data ${r.status}`);
  // Only sites with a real position: the county leaves coordinates blank (or "0") on many rows
  const all = (await r.json() as Row[]).filter((x) => x.quarter_name);
  const latest = all.map((x) => String(x.quarter_name)).sort().pop();
  const seen = new Set<string>(); const rows: Row[] = [];
  for (const x of all) {
    const site = String(x.site_number);
    if (x.quarter_name !== latest || seen.has(site)) continue;
    const lat = +String(x.latitude ?? ""), lng = +String(x.longitude ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !lat || !lng) continue;
    seen.add(site);
    rows.push({
      ...base(runAt), source: "md_open_data", source_ref: `moco-${site}`, jurisdiction: "Montgomery County, MD",
      name: `${String(x.address ?? "Speed camera").trim()}${x.directions ? " " + x.directions : ""}`,
      lat, lng, kind: "Speed", speed_limit: null,
      heading: parseHeading(String(x.directions ?? "")),
    });
  }
  return store(`Montgomery County (${latest ?? "no data"})`, "md_open_data", "Montgomery County, MD", rows, runAt);
}

// Prince George's County, MD: school speed zones as road segments; the camera point is the zone's middle
const PG = "https://services.arcgis.com/kSZiBgsXsUF788NB/arcgis/rest/services/AED_Speed_Zones/FeatureServer/0/query";
function midpoint(coords: number[][]) {
  const pts = coords.map(([lng, lat]) => ({ lat, lng }));
  if (pts.length === 1) return pts[0];
  const seg: number[] = []; let total = 0;
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
async function syncPG() {
  const runAt = new Date().toISOString();
  const r = await fetch(`${PG}?where=1%3D1&outFields=${encodeURIComponent("ObjectId,id,locname,location,type,isActive")}&outSR=4326&f=geojson&resultRecordCount=2000`);
  if (!r.ok) throw new Error(`Prince George's data ${r.status}`);
  const js = await r.json();
  if (js?.error) throw new Error(`Prince George's data: ${js.error.message ?? JSON.stringify(js.error).slice(0, 120)}`); // ArcGIS reports errors with HTTP 200
  const rows: Row[] = [];
  for (const f of js.features ?? []) {
    const p = f.properties ?? {}, g = f.geometry;
    const line: number[][] | null = !g ? null : g.type === "MultiLineString" ? g.coordinates.flat() : g.type === "LineString" ? g.coordinates : g.type === "Point" ? [g.coordinates] : null;
    if (!line?.length) continue;
    const m = midpoint(line);
    const school = /school/i.test(p.type ?? "");
    const inactive = /^no$/i.test(String(p.isActive ?? ""));
    rows.push({
      ...base(runAt), source: "md_open_data", source_ref: `pg-${p.ObjectId ?? p.id}`, jurisdiction: "Prince George's County, MD",
      name: `${String(p.locname ?? "School").trim()} ${school ? "school zone" : "speed zone"}${p.location ? " · " + String(p.location).trim() : ""}${inactive ? " (listed inactive, may still enforce)" : ""}`,
      lat: +m.lat.toFixed(6), lng: +m.lng.toFixed(6), kind: school ? "School zone" : "Speed", speed_limit: null, heading: null,
    });
  }
  return store("Prince George's County", "md_open_data", "Prince George's County, MD", rows, runAt);
}

// ---------------------------------------------------------------- Arlington County, VA: open-data layers with exact points
const ARL = "https://arlgis.arlingtonva.us/arcgis/rest/services/Open_Data/";
async function arlLayer(service: string) {
  const url = `${ARL}${service}/MapServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=json&resultRecordCount=2000`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Arlington ${service} ${r.status}`);
  const js = await r.json();
  if (js.error) throw new Error(`Arlington ${service}: ${js.error.message}`);
  return (js.features ?? []) as { attributes: Record<string, unknown>; geometry?: { x: number; y: number } }[];
}
const title = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b(Nb|Sb|Eb|Wb|Ne|Nw|Se|Sw)\b/g, (m) => m.toUpperCase());
async function syncArlington() {
  const runAt = new Date().toISOString();
  const rows: Row[] = [];
  for (const f of await arlLayer("od_DES_Signal_PhotoSpeed_Cameras_pnt")) {
    const a = f.attributes; if (!f.geometry || a.Retired || (a.Active && !/^y/i.test(String(a.Active)))) continue;
    const limit = parseInt(String(a.BeaconSpeedLimit ?? a.NonSchoolSpeedLimit ?? ""), 10);
    rows.push({ ...base(runAt), source: "arlington_open_data", source_ref: `speed-${a.ID ?? a.OBJECTID}`, jurisdiction: "Arlington County, VA",
      name: `${title(a.Street)}${a.School ? " @ " + title(a.School) : ""}${a.Direction ? " " + String(a.Direction).toUpperCase().replace(/B$/, "/B") : ""} (school zone)`,
      lat: f.geometry.y, lng: f.geometry.x, kind: "Speed", speed_limit: Number.isFinite(limit) ? limit : null, heading: parseHeading(String(a.Direction ?? "")) });
  }
  for (const f of await arlLayer("od_DES_Signal_PhotoRED_Cameras_pnt")) {
    const a = f.attributes; if (!f.geometry || a.Retired) continue;
    rows.push({ ...base(runAt), source: "arlington_open_data", source_ref: `red-${a.ID ?? a.OBJECTID}`, jurisdiction: "Arlington County, VA",
      name: `${title(a.Street)}${a.IntersectingStreet ? " & " + title(a.IntersectingStreet) : ""}${a.Direction ? " " + String(a.Direction).toUpperCase().replace(/B$/, "/B") : ""}`,
      lat: f.geometry.y, lng: f.geometry.x, kind: "Red light", speed_limit: null, heading: parseHeading(String(a.Direction ?? "")) });
  }
  return store("Arlington County", "arlington_open_data", "Arlington County, VA", rows, runAt);
}

// ---------------------------------------------------------------- OpenStreetMap: the whole DMV
// Every speed / red-light enforcement camera mapped in OSM inside Maryland, DC and Virginia. Fills in
// Virginia and the Maryland counties that publish no machine-readable list. Named after the nearest
// named road; labelled with the county or city it sits in; skipped where an official source already
// has a camera within 60 m (so DC's own list wins).
const DMV_BBOX = "36.50,-83.70,39.75,-75.00";
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const CARD: Record<string, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315, NORTH: 0, NORTHEAST: 45, EAST: 90, SOUTHEAST: 135, SOUTH: 180, SOUTHWEST: 225, WEST: 270, NORTHWEST: 315 };
function osmHeading(t: Record<string, string>) {
  const d = (t.direction ?? t["camera:direction"] ?? "").trim().toUpperCase();
  if (!d) return parseHeading(t.description ?? t.name);
  if (/^\d+(\.\d+)?$/.test(d)) return Math.round(+d) % 360;
  const first = d.split(/[;,-]/)[0].trim();
  return CARD[first] ?? parseHeading(d);
}
function osmLimit(t: Record<string, string>) {
  const m = /(\d{2,3})\s*(mph)?/i.exec(t.maxspeed ?? t["maxspeed:enforced"] ?? ""); if (!m) return null;
  const n = +m[1]; return m[2] || n <= 85 ? n : null;
}
async function overpass(query: string): Promise<{ elements: Record<string, unknown>[] }> {
  let last: Error | null = null;
  for (const url of OVERPASS) {
    if (timeLeft() < 30_000) break;
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60_000);
      const r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(query), headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "InvictusTrafficRadar/1.0 camera-sync" }, signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(`Overpass ${r.status}`);
      return await r.json();
    } catch (e) { last = e as Error; }
  }
  throw last ?? new Error("Overpass unreachable");
}
async function syncOSM() {
  const runAt = new Date().toISOString();
  const q = `[out:json][timeout:90];
node["highway"="speed_camera"](${DMV_BBOX})->.cams;
relation["type"="enforcement"](${DMV_BBOX})->.enf;
node(r.enf:"device")->.dev;
(.cams; .dev;)->.all;
way(around.all:35)["highway"]["name"]->.roads;
.cams out body; .enf out body; .dev out body; .roads out geom;`;
  const js = await overpass(q);
  const els = js.elements as { type: string; id: number; lat?: number; lon?: number; tags?: Record<string, string>; members?: { type: string; ref: number; role: string }[]; geometry?: { lat: number; lon: number }[] }[];
  const nodes = new Map<number, typeof els[number]>();
  const roads: { name: string; pts: { lat: number; lng: number }[] }[] = [];
  const relFor = new Map<number, typeof els[number]>();      // device node id → enforcement relation
  for (const e of els) {
    if (e.type === "node" && e.lat != null) nodes.set(e.id, e);
    else if (e.type === "way" && e.geometry && e.tags?.name) roads.push({ name: e.tags.name, pts: e.geometry.map((g) => ({ lat: g.lat, lng: g.lon })) });
    else if (e.type === "relation") for (const m of e.members ?? []) if (m.type === "node" && m.role === "device") relFor.set(m.ref, e);
  }
  // official cameras already on file (any source but OSM): don't duplicate them
  const official: { lat: number; lng: number }[] = [];
  for (let from = 0; from < 20000; from += 1000) {                     // the API returns at most 1000 rows per request
    const { data } = await admin().from("cameras").select("lat,lng").eq("status", "active").neq("source", "osm").is("owner_id", null).order("id").range(from, from + 999);
    official.push(...(data ?? [])); if (!data || data.length < 1000) break;
  }
  const near = (p: { lat: number; lng: number }) => official.some((o) => Math.abs(o.lat - p.lat) < 0.001 && Math.abs(o.lng - p.lng) < 0.0013 && dist(o, p) < 60);
  const nearestRoad = (p: { lat: number; lng: number }) => {
    let best = "", bd = 45;
    for (const r of roads) for (const v of r.pts) { if (Math.abs(v.lat - p.lat) > 0.001 || Math.abs(v.lng - p.lng) > 0.0013) continue; const d = dist(v, p); if (d < bd) { bd = d; best = r.name; } }
    return best;
  };
  const rows: Row[] = []; let skippedDup = 0, outside = 0;
  for (const n of nodes.values()) {
    const p = { lat: n.lat!, lng: n.lon! };
    const rel = relFor.get(n.id);
    const t = { ...(rel?.tags ?? {}), ...(n.tags ?? {}) };
    const isCam = n.tags?.highway === "speed_camera" || !!rel || /camera/i.test(n.tags?.enforcement ?? "");
    if (!isCam) continue;
    const j = jurisdictionAt(p.lat, p.lng);
    if (!j) { outside++; continue; }
    if (near(p)) { skippedDup++; continue; }
    const enf = (rel?.tags?.enforcement ?? n.tags?.enforcement ?? "maxspeed").toLowerCase();
    const kind = /traffic_signals|red.?light/.test(enf) ? "Red light" : /stop/.test(enf) ? "Stop sign" : /bus/.test(enf) ? "Bus lane" : /toll|access|weight|height/.test(enf) ? "Other" : "Speed";
    if (kind === "Other") continue;
    const road = t.name && !/speed camera|camera/i.test(t.name) ? t.name : nearestRoad(p) || t["addr:street"] || "";
    const heading = osmHeading(t);
    const dirTxt = heading == null ? "" : " " + (["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(heading / 45) % 8]) + "/B";
    rows.push({
      ...base(runAt), verified: false, source: "osm", source_ref: `n${n.id}`, jurisdiction: j,
      name: `${road || kind + " camera"}${dirTxt}${t.description && t.description.length < 60 && !road ? " · " + t.description : ""}`.slice(0, 160),
      lat: p.lat, lng: p.lng, kind, speed_limit: osmLimit(t), heading,
    });
  }
  if (!rows.length) return `OpenStreetMap: no cameras returned; kept existing`;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin().from("cameras").upsert(rows.slice(i, i + 500), { onConflict: "source,source_ref" });
    if (error) throw error;
  }
  const { count } = await admin().from("cameras").update({ status: "retired" }, { count: "exact" }).eq("source", "osm").eq("status", "active").lt("last_seen_at", runAt);
  const byState: Record<string, number> = {};
  for (const r of rows) { const st = String(r.jurisdiction).slice(-2); byState[st] = (byState[st] ?? 0) + 1; }
  return `OpenStreetMap: ${rows.length} active (${Object.entries(byState).map(([k, v]) => `${k} ${v}`).join(", ")}), ${count ?? 0} retired, ${skippedDup} already covered by official lists, ${outside} outside MD/DC/VA`;
}

interface Listed { cameras: { location: string; direction: string | null; type: string; speed_limit: number | null }[] }
const listTool = {
  name: "list_cameras",
  description: "List the fixed or scheduled traffic-enforcement camera locations stated on the page.",
  input_schema: {
    type: "object",
    properties: {
      cameras: {
        type: "array",
        items: {
          type: "object",
          properties: {
            location: { type: "string", description: "Street address, block or intersection, as written." },
            direction: { type: ["string", "null"], description: "Direction of travel enforced, e.g. 'N/B'." },
            type: { type: "string", enum: ["Speed", "Red light", "Stop sign", "Bus lane", "School bus", "Other"] },
            speed_limit: { type: ["integer", "null"] },
          },
          required: ["location", "type"],
        },
      },
    },
    required: ["cameras"],
  },
};

function pageText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<(br|\/p|\/li|\/tr|\/h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

async function syncWebSources() {
  if (!claudeConfigured()) return ["Web sources skipped: ANTHROPIC_API_KEY not set"];
  const { data: sources } = await admin().from("camera_sources").select("*").eq("enabled", true);
  const log: string[] = [];
  for (const s of sources ?? []) {
    if (timeLeft() < 25_000) { log.push(`${s.jurisdiction}: skipped, out of time`); continue; }
    let result = "";
    try {
      const r = await fetch(s.url, { headers: { "User-Agent": "TicketRadar/1.0 camera-sync" } });
      if (!r.ok) throw new Error(`page returned ${r.status}`);
      const text = pageText(await r.text()).slice(0, 60000);
      const out = await askStructured<Listed>({
        model: SMART_MODEL,
        system: `You extract traffic camera locations for ${s.jurisdiction}. List only locations the page states have an enforcement camera. ` +
          "Skip locations described as removed, proposed, or under consideration. Never invent locations.",
        content: `Page: ${s.url}\n\n${text}`,
        tool: listTool,
        maxTokens: 4000,
      });
      const { data: existing } = await admin().from("cameras").select("source_ref").eq("source", "agent").eq("jurisdiction", s.jurisdiction);
      const known = new Set((existing ?? []).map((e) => e.source_ref));
      const seenRefs: string[] = [];
      let added = 0, skipped = 0;
      for (const c of out.cameras.slice(0, 400)) {
        const ref = `${s.jurisdiction}|${c.location}|${c.direction ?? ""}`.toLowerCase().replace(/\s+/g, " ");
        seenRefs.push(ref);
        if (known.has(ref)) continue;
        if (timeLeft() < 15_000 || added >= 60) { skipped++; continue; }   // geocoding is slow; finish tomorrow
        const at = await geocode(`${c.location}, ${s.jurisdiction}`);
        if (!at) { skipped++; continue; }
        const { error } = await admin().from("cameras").upsert({
          owner_id: null, source: "agent", source_ref: ref, jurisdiction: s.jurisdiction,
          name: `${c.location}${c.direction ? " " + c.direction : ""}`, lat: at.lat, lng: at.lng,
          kind: c.type === "Other" ? "Speed" : c.type, speed_limit: c.speed_limit, heading: parseHeading(c.direction),
          verified: false, status: "active", last_seen_at: new Date().toISOString(),
        }, { onConflict: "source,source_ref" });
        if (!error) added++;
      }
      // Only retire when the page clearly still lists cameras (protects against a broken page)
      let retired = 0;
      if (out.cameras.length >= 3) {
        const gone = [...known].filter((k) => !seenRefs.includes(k));
        if (gone.length) {
          const { count } = await admin().from("cameras").update({ status: "retired" }, { count: "exact" })
            .eq("source", "agent").eq("jurisdiction", s.jurisdiction).in("source_ref", gone);
          retired = count ?? 0;
        }
        await admin().from("cameras").update({ last_seen_at: new Date().toISOString(), status: "active" })
          .eq("source", "agent").eq("jurisdiction", s.jurisdiction).in("source_ref", seenRefs.filter((r) => known.has(r)));
      }
      result = `${out.cameras.length} listed, ${added} added, ${skipped} left for next run, ${retired} retired`;
    } catch (e) {
      result = `failed: ${(e as Error).message}`;
    }
    await admin().from("camera_sources").update({ last_run_at: new Date().toISOString(), last_result: result }).eq("id", s.id);
    log.push(`${s.jurisdiction}: ${result}`);
  }
  return log;
}

serve(async (req) => {
  requireCron(req);
  const report: string[] = [];
  for (const [label, fn] of [["DC", syncDC], ["Montgomery County", syncMoCo], ["Prince George's County", syncPG], ["Arlington County", syncArlington], ["OpenStreetMap", syncOSM]] as const) {
    try { report.push(await fn()); } catch (e) { report.push(`${label} failed: ${(e as Error).message}`); }
  }
  report.push(...await syncWebSources());
  console.log(report.join("\n"));
  return { ok: true, report };
});
