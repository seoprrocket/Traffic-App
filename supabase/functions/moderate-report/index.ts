// Agent 4 — Report moderator
// Called by the database for every new or edited community report.
// Publishes, hides, cleans the note, or merges it into a duplicate.
import { serve, requireCron, readJson, admin } from "../_shared/http.ts";
import { askStructured, FAST_MODEL, claudeConfigured } from "../_shared/claude.ts";
import { dist, scrub, box } from "../_shared/geo.ts";

const GROUP: Record<string, string> = {
  "Speed trap / police": "police", "Officer location": "police", "Checkpoint": "police",
  "Immigration enforcement (ICE)": "ice", "New camera": "camera", "Ticket hotspot": "hotspot",
  "Icy road": "hazard", "Road hazard": "hazard", "Other": "other",
};

interface Verdict { decision: "publish" | "hide"; reason: string; clean_note: string; duplicate_of: string | null }

const tool = {
  name: "moderate",
  description: "Decide what happens to a community road report.",
  input_schema: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["publish", "hide"] },
      reason: { type: "string", description: "Short reason, shown to the author if hidden." },
      clean_note: { type: "string", description: "The note, safe to show publicly. Empty string if nothing useful remains." },
      duplicate_of: { type: ["string", "null"], description: "Id of an existing nearby report that describes the same thing, else null." },
    },
    required: ["decision", "reason", "clean_note"],
  },
};

serve(async (req) => {
  requireCron(req);
  const { report_id } = await readJson<{ report_id: string }>(req);
  const db = admin();
  const { data: r } = await db.from("reports").select("*").eq("id", report_id).single();
  if (!r || r.status !== "pending") return { skipped: true };

  const pre = scrub(r.note);

  if (!claudeConfigured()) {
    await db.from("reports").update({ status: "live", clean_note: pre || null, moderation_reason: "Basic filter" }).eq("id", r.id);
    return { decision: "publish", basic: true };
  }

  // Nearby reports of the same kind in the last 2 hours → duplicate candidates
  const b = box(r, 400);
  const { data: near } = await db.from("reports")
    .select("id,type,lat,lng,clean_note,created_at,expires_at,confirms")
    .in("status", ["pending", "live"]).neq("id", r.id)
    .gt("created_at", new Date(Date.now() - 2 * 3600e3).toISOString())
    .gte("lat", b.minLat).lte("lat", b.maxLat).gte("lng", b.minLng).lte("lng", b.maxLng);
  const cands = (near ?? []).filter((n) => GROUP[n.type] === GROUP[r.type] && dist(r, n) < 350);

  const v = await askStructured<Verdict>({
    model: FAST_MODEL,
    system:
      "You moderate a community road-report feed for the DC area. Drivers share where they see speed traps, police, " +
      "immigration enforcement activity, checkpoints, new cameras, icy roads and hazards. Reporting what is happening in a public place is allowed.\n" +
      "Rewrite the note so it describes the activity and the place only. Remove names, descriptions that identify a specific person " +
      "(faces, clothing of a named person, badge numbers), license plates, phone numbers and addresses of private homes.\n" +
      "Hide the report if it: threatens or encourages harm, harassment, or physically interfering with anyone (including officers); " +
      "targets a specific private person; is spam, advertising or obviously fake; or is hateful.\n" +
      "Mark it a duplicate only if a candidate clearly describes the same thing at the same place.",
    content: JSON.stringify({
      report: { type: r.type, note: pre, place: r.place },
      candidates: cands.map((c) => ({ id: c.id, type: c.type, note: c.clean_note, meters_away: Math.round(dist(r, c)),
        minutes_ago: Math.round((Date.now() - Date.parse(c.created_at)) / 60000) })),
    }),
    tool,
    maxTokens: 400,
  });

  const clean = scrub(v.clean_note) || null;
  const dupe = v.duplicate_of && cands.find((c) => c.id === v.duplicate_of);

  if (v.decision === "hide") {
    await db.from("reports").update({ status: "hidden", moderation_reason: v.reason.slice(0, 200) }).eq("id", r.id);
  } else if (dupe) {
    // Fold into the existing report: counts as a confirmation and keeps it alive longer
    const now = Date.now();
    const exp = Math.min(Math.max(Date.parse(dupe.expires_at), now + 30 * 60e3), now + 6 * 3600e3);
    await db.from("reports").update({ confirms: (dupe.confirms ?? 0) + 1, expires_at: new Date(exp).toISOString() }).eq("id", dupe.id);
    await db.from("reports").update({ status: "merged", merged_into: dupe.id, clean_note: clean, moderation_reason: "Same as an existing report" }).eq("id", r.id);
  } else {
    await db.from("reports").update({ status: "live", clean_note: clean, moderation_reason: null }).eq("id", r.id);
  }
  return { decision: dupe ? "merged" : v.decision };
});
