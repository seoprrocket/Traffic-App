// Agent 1 — Ticket scanner
// Photo or PDF of a ticket notice → structured ticket, located on the map.
// The image is read once and never stored.
import { serve, requireUser, quota, readJson, HttpError, admin } from "../_shared/http.ts";
import { askStructured, SMART_MODEL, type Block } from "../_shared/claude.ts";
import { geocode, dist, parseHeading, box } from "../_shared/geo.ts";

const TYPES = ["Speed camera", "Red light camera", "Stop sign camera", "Speed (officer)", "Bus lane", "Parking", "Other"];
const MEDIA = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];

const PARKING = ["Expired meter", "Over the time limit", "Residential permit zone", "Rush-hour / tow-away zone", "Street sweeping",
  "Emergency or temporary no parking", "No parking / no standing", "Too close to a fire hydrant", "Loading or bus zone",
  "Crosswalk, corner, driveway or alley", "Expired tags or registration", "Other"];

interface One {
  violation_type: string;
  parking_reason: string | null;
  violation_date: string | null;
  violation_time: string | null;
  location_text: string | null;
  jurisdiction: string | null;
  direction: string | null;
  recorded_speed: number | null;
  speed_limit: number | null;
  fine_amount: number | null;
  payment_due_date: string | null;
  confidence: "high" | "medium" | "low";
}
interface Extracted { is_ticket: boolean; tickets: One[]; note_for_driver: string }

const one = {
  type: "object",
  properties: {
    violation_type: { type: "string", enum: TYPES },
    parking_reason: { type: ["string", "null"], enum: [...PARKING, null], description: "Only for parking tickets: the closest reason." },
    violation_date: { type: ["string", "null"], description: "Date of the violation, YYYY-MM-DD." },
    violation_time: { type: ["string", "null"], description: "Time of the violation, 24h HH:MM." },
    location_text: { type: ["string", "null"], description: "Where the violation happened, exactly as printed (street, block, intersection)." },
    jurisdiction: { type: ["string", "null"], description: "City/county/state that issued it, e.g. 'Washington, DC' or 'Montgomery County, MD'." },
    direction: { type: ["string", "null"], description: "Direction of travel if printed, e.g. 'N/B'." },
    recorded_speed: { type: ["integer", "null"] },
    speed_limit: { type: ["integer", "null"] },
    fine_amount: { type: ["number", "null"], description: "Fine in dollars, without late fees." },
    payment_due_date: { type: ["string", "null"], description: "Pay-or-contest deadline if printed, YYYY-MM-DD." },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["violation_type", "confidence"],
};
const tool = {
  name: "record_tickets",
  description: "Record every traffic or parking ticket shown: a paper notice, a PDF, or a screenshot of a ticket website such as cite-web.com, a DMV ticket search or a county payment portal.",
  input_schema: {
    type: "object",
    properties: {
      is_ticket: { type: "boolean", description: "False if this shows no traffic or parking ticket." },
      tickets: { type: "array", items: one, maxItems: 20, description: "One entry per distinct ticket shown. A results list with several rows is several tickets." },
      note_for_driver: { type: "string", description: "One short sentence: anything unreadable or worth double-checking." },
    },
    required: ["is_ticket", "tickets", "note_for_driver"],
  },
};

serve(async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ data?: string; mediaType?: string; text?: string }>(req);
  const text = typeof body.text === "string" ? body.text.slice(0, 20000).trim() : "";
  if (!text && (!body.data || !body.mediaType || !MEDIA.includes(body.mediaType))) {
    throw new HttpError(400, "Send a JPG, PNG, WEBP or PDF of the ticket, or the text of the ticket page.");
  }
  if (body.data && body.data.length > 9_000_000) throw new HttpError(413, "That file is too large. Use a photo under 6 MB.");
  await quota(user.id, "scan-ticket", 20);

  const content: Block[] = text
    ? [{ type: "text", text: `Text copied from a ticket website or notice:\n<page>\n${text}\n</page>\nRecord every ticket in it.` }]
    : [body.mediaType === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: body.data! } }
        : { type: "image", source: { type: "base64", media_type: body.mediaType!, data: body.data! } },
      { type: "text", text: "Record every ticket shown." }];

  const x = await askStructured<Extracted>({
    model: SMART_MODEL,
    system: "You read traffic tickets, parking tickets and automated-enforcement notices from the Washington DC, Maryland and Virginia area, " +
      "including screenshots of ticket websites (cite-web.com, DC DMV, county payment portals) and photos of paper notices. " +
      "Copy only what is shown; use null for anything missing or unreadable, never guess. Ignore page menus, ads and payment buttons. " +
      "Do not return license plate numbers, VINs, notice, citation or PIN numbers, names, or mailing addresses.",
    content,
    tool,
    maxTokens: 2000,
  });

  const list = (x.tickets ?? []).slice(0, 20);
  if (!x.is_ticket || !list.length) {
    return { ok: false, message: "That doesn't look like a traffic ticket. Try a clearer photo or a screenshot of the ticket page." };
  }

  const out = [], locations = [];
  let camera = null;
  for (const [i, t] of list.entries()) {
    let location = null;
    if (t.location_text) {
      const where = [t.location_text, t.jurisdiction ?? "Washington, DC"].join(", ")
        .replace(/\b(\d+)\s*BLK\b/i, "$1").replace(/\b[NSEW]{1,2}\/B\b/gi, "");
      location = await geocode(where) ?? await geocode(t.location_text);
    }
    if (location && i === 0) {
      // Is there an official camera right there? Then the ticket lines up with it.
      const b = box(location, 400);
      const { data } = await admin().from("cameras")
        .select("id,name,kind,speed_limit,heading,lat,lng")
        .is("owner_id", null).eq("status", "active")
        .gte("lat", b.minLat).lte("lat", b.maxLat).gte("lng", b.minLng).lte("lng", b.maxLng);
      const heading = parseHeading(t.direction ?? t.location_text);
      const best = (data ?? [])
        .map((c) => ({ ...c, d: dist(location!, c) }))
        .filter((c) => heading == null || c.heading == null || Math.abs(((c.heading - heading + 540) % 360) - 180) < 60)
        .sort((a, b) => a.d - b.d)[0];
      if (best && best.d < 300) camera = { id: best.id, name: best.name, kind: best.kind, speed_limit: best.speed_limit, meters: Math.round(best.d) };
    }
    locations.push(location);
    out.push({
      street: t.location_text, type: t.violation_type, violation: t.violation_type === "Parking" ? (t.parking_reason ?? "Other") : "",
      date: t.violation_date, time: t.violation_time, speed: t.recorded_speed, limit: t.speed_limit, fine: t.fine_amount,
      due: t.payment_due_date, direction: t.direction, jurisdiction: t.jurisdiction, confidence: t.confidence,
    });
  }

  return {
    ok: true,
    ticket: out[0], location: locations[0], camera,     // older app versions read these
    tickets: out, locations,
    confidence: out[0].confidence,
    note: x.note_for_driver,
  };
});
