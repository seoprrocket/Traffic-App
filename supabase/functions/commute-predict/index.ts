// Agent 5 — Commute predictor
// Nightly. Finds the trips each driver repeats, when they usually leave,
// and what's on the way, then suggests commute schedules in the app.
import { serve, requireCron, admin } from "../_shared/http.ts";
import { askStructured, FAST_MODEL, claudeConfigured } from "../_shared/claude.ts";
import { dist, segDist, reverseGeocode, type Pt } from "../_shared/geo.ts";

const TZ = "America/New_York";
const started = Date.now();

interface Trip { start_lat: number; start_lng: number; end_lat: number; end_lng: number; started_at: string }
interface Cluster extends Pt { n: number }

function clusterOf(list: Cluster[], p: Pt): number {
  let i = list.findIndex((c) => dist(c, p) < 600);
  if (i < 0) { list.push({ ...p, n: 0 }); i = list.length - 1; }
  const c = list[i]; c.lat = (c.lat * c.n + p.lat) / (c.n + 1); c.lng = (c.lng * c.n + p.lng) / (c.n + 1); c.n++;
  return i;
}
function local(iso: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday"));
  return { dow, minutes: (+g("hour") % 24) * 60 + +g("minute") };
}
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

interface Named { patterns: { index: number; name: string; risk_note: string; confidence: "high" | "medium" | "low" }[] }
const tool = {
  name: "name_patterns",
  description: "Give each recurring trip a short name and a one-line risk note.",
  input_schema: {
    type: "object",
    properties: {
      patterns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            name: { type: "string", description: "Like 'Home → Downtown' or 'Gaithersburg → Tysons'. Under 40 characters." },
            risk_note: { type: "string", description: "One sentence about cameras/ticket spots on the way, or that it looks clear." },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["index", "name", "risk_note", "confidence"],
        },
      },
    },
    required: ["patterns"],
  },
};

serve(async (req) => {
  requireCron(req);
  const db = admin();
  const since = new Date(Date.now() - 60 * 86400e3).toISOString();
  const { data: tripRows } = await db.from("trips").select("user_id,start_lat,start_lng,end_lat,end_lng,started_at").gte("started_at", since);
  const byUser = new Map<string, Trip[]>();
  for (const t of tripRows ?? []) (byUser.get(t.user_id) ?? byUser.set(t.user_id, []).get(t.user_id)!).push(t);

  const { data: cams } = await db.from("cameras").select("lat,lng").is("owner_id", null).eq("status", "active");
  let done = 0;
  for (const [userId, trips] of byUser) {
    if (Date.now() - started > 120_000) break;
    if (trips.length < 6) continue;

    const places: Cluster[] = [];
    const groups = new Map<string, { o: number; d: number; days: number[]; mins: number[] }>();
    for (const t of trips) {
      const o = clusterOf(places, { lat: t.start_lat, lng: t.start_lng });
      const d = clusterOf(places, { lat: t.end_lat, lng: t.end_lng });
      if (o === d) continue;
      const k = `${o}>${d}`, l = local(t.started_at);
      const g = groups.get(k) ?? { o, d, days: [], mins: [] };
      g.days.push(l.dow); g.mins.push(l.minutes); groups.set(k, g);
    }
    const { data: tix } = await db.from("tickets").select("lat,lng").eq("user_id", userId);
    const found = [...groups.values()].filter((g) => g.days.length >= 3).sort((a, b) => b.days.length - a.days.length).slice(0, 4)
      .map((g) => {
        const counts = [0, 0, 0, 0, 0, 0, 0]; g.days.forEach((d) => counts[d]++);
        const days = counts.map((c, i) => [c, i]).filter(([c]) => c >= Math.max(1, g.days.length / 10)).map(([, i]) => i);
        const sorted = [...g.mins].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const A = places[g.o], B = places[g.d];
        const camsOnWay = (cams ?? []).filter((c) => segDist(c, A, B) < 800).length;   // straight-line corridor
        const tixOnWay = (tix ?? []).filter((c) => segDist(c, A, B) < 800).length;
        return { A, B, trips: g.days.length, days, depart: hhmm(Math.max(0, median - 5)), camsOnWay, tixOnWay };
      });
    if (!found.length) continue;

    for (const f of found) {
      (f.A as Cluster & { label?: string }).label ??= await reverseGeocode(f.A) ?? "Start";
      (f.B as Cluster & { label?: string }).label ??= await reverseGeocode(f.B) ?? "Destination";
    }
    const { data: prof } = await db.from("profiles").select("home_label,work_label").eq("id", userId).single();

    let named: Named = { patterns: found.map((f, i) => ({
      index: i, name: `${(f.A as { label?: string }).label} → ${(f.B as { label?: string }).label}`.slice(0, 40),
      risk_note: f.camsOnWay || f.tixOnWay ? `${f.camsOnWay} cameras and ${f.tixOnWay} of your ticket spots near this corridor.` : "No known cameras near this corridor.",
      confidence: f.trips >= 8 ? "high" : "medium" as const })) };
    if (claudeConfigured()) {
      try {
        named = await askStructured<Named>({
          model: FAST_MODEL,
          system: "You name a driver's recurring trips for a traffic-camera alert app. Use the driver's own home/work labels when a place matches them. Be brief and factual.",
          content: JSON.stringify({
            driver_labels: { home: prof?.home_label, work: prof?.work_label },
            trips: found.map((f, i) => ({ index: i, from: (f.A as { label?: string }).label, to: (f.B as { label?: string }).label,
              times_driven_last_60_days: f.trips, usual_departure: f.depart, days: f.days,
              official_cameras_near_corridor: f.camsOnWay, drivers_past_tickets_near_corridor: f.tixOnWay })),
          }),
          tool, maxTokens: 700,
        });
      } catch (e) { console.error("naming failed, using plain names", e); }
    }

    const patterns = found.map((f, i) => {
      const n = named.patterns.find((p) => p.index === i);
      return {
        name: n?.name ?? `Trip ${i + 1}`, risk_note: n?.risk_note ?? "", confidence: n?.confidence ?? "medium",
        days: f.days, depart: f.depart, trips: f.trips,
        start: { lat: +f.A.lat.toFixed(5), lng: +f.A.lng.toFixed(5), label: (f.A as { label?: string }).label },
        end: { lat: +f.B.lat.toFixed(5), lng: +f.B.lng.toFixed(5), label: (f.B as { label?: string }).label },
      };
    });
    await db.from("commute_predictions").upsert({ user_id: userId, patterns, updated_at: new Date().toISOString() });
    done++;
  }
  return { ok: true, drivers_updated: done };
});
