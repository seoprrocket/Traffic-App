// Agent 6 — Ticket dispute helper
// Helps a driver prepare their own dispute: deadline, possible grounds, evidence, draft letter.
// General information only — not legal advice.
import { serve, requireUser, quota, readJson, HttpError, admin } from "../_shared/http.ts";
import { askStructured, SMART_MODEL } from "../_shared/claude.ts";
import { scrub } from "../_shared/geo.ts";

interface Plan {
  summary: string;
  deadline_note: string;
  grounds: { title: string; fit: "strong" | "possible" | "weak"; why: string; evidence: string[] }[];
  questions: string[];
  next_steps: string[];
  letter: string;
}

const tool = {
  name: "dispute_plan",
  description: "A plan to help the driver decide whether and how to contest a traffic ticket.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Two sentences: the honest overall picture." },
      deadline_note: { type: "string", description: "What the driver should check about deadlines, based only on what they provided." },
      grounds: {
        type: "array", maxItems: 6,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            fit: { type: "string", enum: ["strong", "possible", "weak"] },
            why: { type: "string" },
            evidence: { type: "array", items: { type: "string" } },
          },
          required: ["title", "fit", "why", "evidence"],
        },
      },
      questions: { type: "array", items: { type: "string" }, description: "Facts that would change the assessment." },
      next_steps: { type: "array", items: { type: "string" } },
      letter: { type: "string", description: "Draft dispute statement in plain first person, under 250 words, with [brackets] for anything the driver must fill in." },
    },
    required: ["summary", "deadline_note", "grounds", "questions", "next_steps", "letter"],
  },
};

serve(async (req) => {
  const user = await requireUser(req);
  const b = await readJson<{ ticket_id?: string; account?: string; due?: string | null }>(req);
  if (!b.ticket_id) throw new HttpError(400, "Choose a ticket first.");
  await quota(user.id, "dispute-helper", 10);

  const db = admin();
  const { data: t } = await db.from("tickets").select("*").eq("id", b.ticket_id).eq("user_id", user.id).single();
  if (!t) throw new HttpError(404, "That ticket isn't in your account.");

  // What's known about the spot: nearby official camera and how often this driver passes it
  const { count: passes } = await db.from("drive_events").select("id", { count: "exact", head: true })
    .eq("user_id", user.id).eq("kind", "enter").ilike("zone", `%${(t.street ?? "").slice(0, 30)}%`);

  const plan = await askStructured<Plan>({
    model: SMART_MODEL,
    system:
      "You help a driver in the Washington DC / Maryland / Virginia area prepare to contest a traffic or camera ticket themselves. " +
      "You are not a lawyer and this is general information, not legal advice; say so once in next_steps. " +
      "Be honest: if nothing suggests a defense, say that paying may be the practical choice. " +
      "Common grounds you may consider when the facts support them: the vehicle or plate in the photo isn't theirs; the car was sold, stolen or rented to someone else at the time; " +
      "someone else was driving (where the jurisdiction allows naming them); required speed-limit or camera signs were missing or blocked; the photo or recorded data is unclear or inconsistent; " +
      "an emergency or yielding to an emergency vehicle; a clerical error on the notice. " +
      "Do not cite statute numbers, fine schedules or deadlines you were not given; tell the driver to confirm the process and deadline printed on the notice " +
      "(DC camera tickets are handled by the DC DMV; Maryland and Virginia tickets by the issuing county or city and its court).",
    content: JSON.stringify({
      ticket: { type: t.type, street: t.street, date: t.ticket_date, time: t.ticket_time, recorded_speed: t.speed, speed_limit: t.speed_limit, fine: t.fine, notes: scrub(t.notes) },
      deadline_printed_on_notice: b.due ?? null,
      drivers_account: scrub(b.account ?? "").slice(0, 2000) || "(none given)",
      times_driver_has_passed_this_zone_with_app: passes ?? 0,
    }),
    tool,
    maxTokens: 2000,
  });

  const { data: saved } = await db.from("disputes").insert({ user_id: user.id, ticket_id: t.id, analysis: plan, letter: plan.letter }).select("id,created_at").single();
  return { ...plan, id: saved?.id, created_at: saved?.created_at };
});
