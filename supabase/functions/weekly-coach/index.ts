// Agent 7 — Weekly coach
// Mondays: a short written review of each driver's week, saved in the app and emailed (if Resend is set up).
// The app's "Generate now" button calls it for just the signed-in driver.
import { serve, isCron, requireUser, quota, admin } from "../_shared/http.ts";
import { askStructured, FAST_MODEL, claudeConfigured } from "../_shared/claude.ts";

interface Coach { headline: string; summary: string; wins: string[]; focus: string[]; tip: string }
const tool = {
  name: "weekly_coach",
  description: "A short weekly driving review.",
  input_schema: {
    type: "object",
    properties: {
      headline: { type: "string", description: "Under 10 words." },
      summary: { type: "string", description: "Two or three sentences in second person, warm and direct." },
      wins: { type: "array", items: { type: "string" }, maxItems: 3 },
      focus: { type: "array", items: { type: "string" }, maxItems: 3, description: "Specific, actionable, tied to named places or times from the data." },
      tip: { type: "string", description: "One practical tip for next week." },
    },
    required: ["headline", "summary", "wins", "focus", "tip"],
  },
};

function mondayOf(d: Date) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}

async function statsFor(userId: string, since: string) {
  const db = admin();
  const [trips, events, alerts, tickets] = await Promise.all([
    db.from("trips").select("meters,max_mph,alerts,started_at").eq("user_id", userId).gte("started_at", since),
    db.from("drive_events").select("kind,zone,zone_type,speed,speed_limit,at").eq("user_id", userId).gte("at", since),
    db.from("alert_log").select("kind,title").eq("user_id", userId).gte("at", since),
    db.from("tickets").select("street,type,fine,ticket_date").eq("user_id", userId).gte("created_at", since),
  ]);
  const enters = (events.data ?? []).filter((e) => e.kind === "enter");
  const over = enters.filter((e) => e.speed_limit && e.speed > e.speed_limit + 2);
  const zoneCounts: Record<string, number> = {};
  enters.forEach((e) => zoneCounts[e.zone] = (zoneCounts[e.zone] ?? 0) + 1);
  const overZones: Record<string, number> = {};
  over.forEach((e) => overZones[e.zone] = (overZones[e.zone] ?? 0) + 1);
  return {
    trips: trips.data?.length ?? 0,
    miles: Math.round((trips.data ?? []).reduce((s, t) => s + (t.meters ?? 0), 0) / 1609.34),
    top_speed_mph: Math.max(0, ...(trips.data ?? []).map((t) => t.max_mph ?? 0)),
    alerts_by_kind: (alerts.data ?? []).reduce((m: Record<string, number>, a) => (m[a.kind] = (m[a.kind] ?? 0) + 1, m), {}),
    zone_entries: enters.length,
    over_limit_entries: over.length,
    busiest_zones: Object.entries(zoneCounts).sort((a, b) => b[1] - a[1]).slice(0, 3),
    zones_where_over_limit: Object.entries(overZones).sort((a, b) => b[1] - a[1]).slice(0, 3),
    new_tickets: tickets.data ?? [],
  };
}

async function email(to: string, c: Coach) {
  const key = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("RESEND_FROM");
  if (!key || !from) return false;
  const li = (a: string[]) => a.map((x) => `<li style="margin:4px 0">${x.replace(/</g, "&lt;")}</li>`).join("");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;color:#13202b">
    <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#56687a;margin:0">Ticket Radar · weekly coach</p>
    <h1 style="font-size:24px;margin:6px 0 12px">${c.headline.replace(/</g, "&lt;")}</h1>
    <p>${c.summary.replace(/</g, "&lt;")}</p>
    ${c.wins.length ? `<h3 style="margin-bottom:4px">What went well</h3><ul>${li(c.wins)}</ul>` : ""}
    ${c.focus.length ? `<h3 style="margin-bottom:4px">Focus this week</h3><ul>${li(c.focus)}</ul>` : ""}
    <p style="background:#eef2f5;padding:12px;border-radius:8px"><b>Tip:</b> ${c.tip.replace(/</g, "&lt;")}</p>
    <p style="font-size:12px;color:#56687a">Turn these emails off in the app under Driver Profile.</p></div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject: `Your driving week: ${c.headline}`, html }),
  });
  return r.ok;
}

async function coachOne(userId: string, sendEmail: boolean) {
  const since = new Date(Date.now() - 7 * 86400e3).toISOString();
  const s = await statsFor(userId, since);
  if (!s.trips && !s.zone_entries && !s.new_tickets.length) return { skipped: "no activity this week" };
  const c = await askStructured<Coach>({
    model: FAST_MODEL,
    system: "You write a short weekly driving review for a DC-area driver using Ticket Radar, an app that warns about speed cameras and places they've been ticketed. " +
      "Use only the numbers given. Praise real progress; be specific and practical about what to change. Never encourage speeding or evading enforcement.",
    content: JSON.stringify(s),
    tool, maxTokens: 700,
  });
  const week = mondayOf(new Date());
  await admin().from("coach_reports").upsert({ user_id: userId, week_start: week, headline: c.headline, body: { ...c, stats: s } }, { onConflict: "user_id,week_start" });
  let emailed = false;
  if (sendEmail) {
    const { data: p } = await admin().from("profiles").select("email_coach").eq("id", userId).single();
    if (p?.email_coach) {
      const { data: u } = await admin().auth.admin.getUserById(userId);
      if (u.user?.email) emailed = await email(u.user.email, c);
    }
  }
  return { ...c, week_start: week, emailed };
}

serve(async (req) => {
  if (!claudeConfigured()) return { ok: false, error: "ANTHROPIC_API_KEY not set" };
  if (isCron(req)) {
    const since = new Date(Date.now() - 7 * 86400e3).toISOString();
    const { data } = await admin().from("trips").select("user_id").gte("started_at", since);
    const users = [...new Set((data ?? []).map((t) => t.user_id))];
    const started = Date.now(); let done = 0;
    for (const u of users) {
      if (Date.now() - started > 120_000) break;
      try { await coachOne(u, true); done++; } catch (e) { console.error(u, e); }
    }
    return { ok: true, coached: done, of: users.length };
  }
  const user = await requireUser(req);
  await quota(user.id, "weekly-coach", 3);
  return await coachOne(user.id, false);
});
