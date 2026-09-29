// Agent 2 — Camera data
// Runs daily. Pulls DC's official camera list, then reads county web pages
// (Montgomery, Gaithersburg, anything added to camera_sources) and turns them into map pins.
import { serve, requireCron, admin } from "../_shared/http.ts";
import { askStructured, SMART_MODEL, claudeConfigured } from "../_shared/claude.ts";
import { geocode, parseHeading } from "../_shared/geo.ts";

const DC_LAYER = "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Public_Safety_WebMercator/MapServer/43/query";
const KIND: Record<string, string> = {
  "Speed": "Speed", "Red Light": "Red light", "Stop Sign": "Stop sign",
  "Truck Restriction": "Truck", "Bus Lane": "Bus lane", "Bus Zone": "Bus lane", "School Bus Stop-Arm": "School bus",
};
const started = Date.now();
const timeLeft = () => 140_000 - (Date.now() - started);

async function syncDC() {
  const runAt = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];
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
        owner_id: null,
        source: "dc_open_data",
        source_ref: String(a.GLOBALID ?? a.OBJECTID),
        jurisdiction: "Washington, DC",
        name: `${String(a.LOCATION_DESCRIPTION ?? "DC camera").trim()}${mobile ? " (mobile)" : ""}`,
        lat: a.CAMERA_LATITUDE,
        lng: a.CAMERA_LONGITUDE,
        kind: KIND[a.ENFORCEMENT_TYPE] ?? a.ENFORCEMENT_TYPE ?? "Speed",
        speed_limit: a.SPEED_LIMIT ? Math.round(a.SPEED_LIMIT) : null,
        heading: parseHeading(a.LOCATION_DESCRIPTION),
        verified: true,
        status: "active",
        last_seen_at: runAt,
      });
    }
    if (!js.exceededTransferLimit && feats.length < 1000) break;
  }
  if (!rows.length) return "DC: no rows returned; kept existing cameras";
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin().from("cameras").upsert(rows.slice(i, i + 500), { onConflict: "source,source_ref" });
    if (error) throw error;
  }
  // Anything DC no longer lists is retired
  const { count } = await admin().from("cameras").update({ status: "retired" }, { count: "exact" })
    .eq("source", "dc_open_data").eq("status", "active").lt("last_seen_at", runAt);
  return `DC: ${rows.length} active, ${count ?? 0} retired`;
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
  try { report.push(await syncDC()); } catch (e) { report.push(`DC failed: ${(e as Error).message}`); }
  report.push(...await syncWebSources());
  console.log(report.join("\n"));
  return { ok: true, report };
});
