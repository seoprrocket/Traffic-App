// Agent 2 — Camera data
// Runs daily. Pulls the official camera lists that publish exact locations (DC, Montgomery County,
// Prince George's County), then reads other county/town web pages listed in camera_sources.
import { serve, requireCron, admin } from "../_shared/http.ts";
import { askStructured, SMART_MODEL, claudeConfigured } from "../_shared/claude.ts";
import { geocode, parseHeading, dist } from "../_shared/geo.ts";

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
  const all = (await r.json() as Row[]).filter((x) => x.latitude && x.longitude && x.quarter_name);
  const latest = all.map((x) => String(x.quarter_name)).sort().pop();
  const seen = new Set<string>(); const rows: Row[] = [];
  for (const x of all) {
    const site = String(x.site_number);
    if (x.quarter_name !== latest || seen.has(site)) continue;
    seen.add(site);
    rows.push({
      ...base(runAt), source: "md_open_data", source_ref: `moco-${site}`, jurisdiction: "Montgomery County, MD",
      name: `${String(x.address ?? "Speed camera").trim()}${x.directions ? " " + x.directions : ""}`,
      lat: +String(x.latitude), lng: +String(x.longitude), kind: "Speed", speed_limit: null,
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
  for (const [label, fn] of [["DC", syncDC], ["Montgomery County", syncMoCo], ["Prince George's County", syncPG]] as const) {
    try { report.push(await fn()); } catch (e) { report.push(`${label} failed: ${(e as Error).message}`); }
  }
  report.push(...await syncWebSources());
  console.log(report.join("\n"));
  return { ok: true, report };
});
