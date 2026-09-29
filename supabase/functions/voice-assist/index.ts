// Agent 3 — Voice co-pilot
// The app handles simple commands on the phone ("report police", "what's ahead").
// Anything else comes here with the driver's position, and gets a short spoken answer.
import { serve, requireUser, quota, readJson, HttpError, admin } from "../_shared/http.ts";
import { askStructured, FAST_MODEL } from "../_shared/claude.ts";
import { dist, bearing, angleDiff, box } from "../_shared/geo.ts";

const REPORT_TYPES = ["Speed trap / police", "Officer location", "Immigration enforcement (ICE)", "Checkpoint",
  "New camera", "Ticket hotspot", "Icy road", "Road hazard", "Other"];

interface Answer { speech: string; action: "none" | "report" | "start_drive" | "stop_drive"; report_type: string | null; report_note: string | null }

const tool = {
  name: "respond",
  description: "Reply to the driver and optionally trigger an app action.",
  input_schema: {
    type: "object",
    properties: {
      speech: { type: "string", description: "What to say out loud. One or two short sentences, under 30 words, plain words, no lists." },
      action: { type: "string", enum: ["none", "report", "start_drive", "stop_drive"] },
      report_type: { type: ["string", "null"], enum: [...REPORT_TYPES, null] },
      report_note: { type: ["string", "null"], description: "Short description of what the driver saw, if reporting. No names or plates." },
    },
    required: ["speech", "action"],
  },
};

serve(async (req) => {
  const user = await requireUser(req);
  const b = await readJson<{ transcript?: string; lat?: number; lng?: number; heading?: number | null; speed_mph?: number; speed_limit?: number | null }>(req);
  const said = (b.transcript ?? "").trim().slice(0, 400);
  if (!said) throw new HttpError(400, "I didn't catch that.");
  await quota(user.id, "voice-assist", 150);

  const lines: string[] = [];
  if (typeof b.lat === "number" && typeof b.lng === "number") {
    const me = { lat: b.lat, lng: b.lng };
    const bx = box(me, 5000);
    const within = <T extends { lat: number; lng: number }>(q: T[] | null) =>
      (q ?? []).map((x) => {
        const d = dist(me, x), brg = bearing(me, x);
        const ahead = b.heading == null ? null : angleDiff(brg, b.heading) < 50;
        return { ...x, d, ahead };
      }).filter((x) => x.d < 5000).sort((p, q) => p.d - q.d);

    const [cams, mine, tix, reps] = await Promise.all([
      admin().from("cameras").select("name,kind,speed_limit,lat,lng").is("owner_id", null).eq("status", "active")
        .gte("lat", bx.minLat).lte("lat", bx.maxLat).gte("lng", bx.minLng).lte("lng", bx.maxLng).limit(200),
      admin().from("cameras").select("name,kind,speed_limit,lat,lng").eq("owner_id", user.id)
        .gte("lat", bx.minLat).lte("lat", bx.maxLat).gte("lng", bx.minLng).lte("lng", bx.maxLng),
      admin().from("tickets").select("street,type,lat,lng").eq("user_id", user.id)
        .gte("lat", bx.minLat).lte("lat", bx.maxLat).gte("lng", bx.minLng).lte("lng", bx.maxLng),
      admin().from("reports").select("type,lat,lng,created_at,clean_note,status").in("status", ["pending", "live"])
        .gt("expires_at", new Date().toISOString())
        .gte("lat", bx.minLat).lte("lat", bx.maxLat).gte("lng", bx.minLng).lte("lng", bx.maxLng),
    ]);
    const fmt = (m: number) => m < 300 ? `${Math.round(m * 3.281)} ft` : `${(m / 1609.34).toFixed(1)} mi`;
    const dir = (a: boolean | null) => a == null ? "" : a ? ", ahead" : ", behind or off to the side";
    for (const c of within([...(cams.data ?? []), ...(mine.data ?? [])]).slice(0, 8)) {
      lines.push(`Camera: ${c.kind}, ${c.name}${c.speed_limit ? `, limit ${c.speed_limit}` : ""}, ${fmt(c.d)}${dir(c.ahead)}`);
    }
    for (const t of within(tix.data).slice(0, 5)) lines.push(`Driver's past ticket: ${t.type} on ${t.street}, ${fmt(t.d)}${dir(t.ahead)}`);
    for (const r of within(reps.data).slice(0, 6)) {
      const mins = Math.round((Date.now() - Date.parse(r.created_at)) / 60000);
      lines.push(`Community report: ${r.type}, ${mins} min ago, ${fmt(r.d)}${dir(r.ahead)}${r.status === "live" && r.clean_note ? ` (${r.clean_note})` : ""}`);
    }
  }

  const ctx = [
    b.speed_mph != null ? `Current speed: ${Math.round(b.speed_mph)} mph.` : "",
    b.speed_limit ? `Posted limit here: ${b.speed_limit} mph.` : "",
    lines.length ? `Within 3 miles:\n${lines.join("\n")}` : "Nothing logged within 3 miles.",
  ].filter(Boolean).join("\n");

  const a = await askStructured<Answer>({
    model: FAST_MODEL,
    system: "You are the voice co-pilot in Ticket Radar, a DC-area app that warns drivers about speed cameras and ticket zones. " +
      "The driver is behind the wheel: answer in one or two short spoken sentences, lead with the most important fact, and never ask them to look at the screen. " +
      "Use only the context given for anything about cameras, tickets or reports; if it isn't there, say you don't have it. " +
      "If they describe something they see on the road, use action 'report' with the best report_type. " +
      "Don't give legal advice and don't encourage speeding or evading police.",
    content: `${ctx}\n\nDriver said: "${said}"`,
    tool,
    maxTokens: 300,
  });
  if (a.action === "report" && (!a.report_type || !REPORT_TYPES.includes(a.report_type))) a.report_type = "Other";
  return a;
});
