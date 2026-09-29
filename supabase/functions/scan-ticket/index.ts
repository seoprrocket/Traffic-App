// Agent 1 — Ticket scanner
// Photo or PDF of a ticket notice → structured ticket, located on the map.
// The image is read once and never stored.
import { serve, requireUser, quota, readJson, HttpError, admin } from "../_shared/http.ts";
import { askStructured, SMART_MODEL, type Block } from "../_shared/claude.ts";
import { geocode, dist, parseHeading, box } from "../_shared/geo.ts";

const TYPES = ["Speed camera", "Red light camera", "Stop sign camera", "Speed (officer)", "Bus lane", "Parking", "Other"];
const MEDIA = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];

interface Extracted {
  is_ticket: boolean;
  violation_type: string;
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
  note_for_driver: string;
}

const tool = {
  name: "record_ticket",
  description: "Record the details printed on a traffic citation or camera-enforcement notice.",
  input_schema: {
    type: "object",
    properties: {
      is_ticket: { type: "boolean", description: "False if the image is not a traffic ticket or notice." },
      violation_type: { type: "string", enum: TYPES },
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
      note_for_driver: { type: "string", description: "One short sentence: anything unreadable or worth double-checking." },
    },
    required: ["is_ticket", "violation_type", "confidence", "note_for_driver"],
  },
};

serve(async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ data?: string; mediaType?: string }>(req);
  if (!body.data || !body.mediaType || !MEDIA.includes(body.mediaType)) {
    throw new HttpError(400, "Send a JPG, PNG, WEBP or PDF of the ticket.");
  }
  if (body.data.length > 9_000_000) throw new HttpError(413, "That file is too large. Use a photo under 6 MB.");
  await quota(user.id, "scan-ticket", 20);

  const file: Block = body.mediaType === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: body.data } }
    : { type: "image", source: { type: "base64", media_type: body.mediaType, data: body.data } };

  const x = await askStructured<Extracted>({
    model: SMART_MODEL,
    system: "You read traffic tickets and automated-enforcement notices from the Washington DC, Maryland and Virginia area. " +
      "Copy only what is printed; use null for anything missing or unreadable, never guess. " +
      "Do not return license plate numbers, VINs, notice or citation numbers, names, or the owner's mailing address.",
    content: [file, { type: "text", text: "Record this ticket's details." }],
    tool,
    maxTokens: 800,
  });

  if (!x.is_ticket) {
    return { ok: false, message: "That doesn't look like a traffic ticket. Try a clearer photo of the front of the notice." };
  }

  // Put it on the map
  let location = null, camera = null;
  if (x.location_text) {
    const where = [x.location_text, x.jurisdiction ?? "Washington, DC"].join(", ")
      .replace(/\b(\d+)\s*BLK\b/i, "$1").replace(/\b[NSEW]{1,2}\/B\b/gi, "");
    location = await geocode(where) ?? await geocode(x.location_text);
  }
  if (location) {
    // Is there an official camera right there? Then the ticket lines up with it.
    const b = box(location, 400);
    const { data } = await admin().from("cameras")
      .select("id,name,kind,speed_limit,heading,lat,lng")
      .is("owner_id", null).eq("status", "active")
      .gte("lat", b.minLat).lte("lat", b.maxLat).gte("lng", b.minLng).lte("lng", b.maxLng);
    const heading = parseHeading(x.direction ?? x.location_text);
    const best = (data ?? [])
      .map((c) => ({ ...c, d: dist(location!, c) }))
      .filter((c) => heading == null || c.heading == null || Math.abs(((c.heading - heading + 540) % 360) - 180) < 60)
      .sort((a, b) => a.d - b.d)[0];
    if (best && best.d < 300) camera = { id: best.id, name: best.name, kind: best.kind, speed_limit: best.speed_limit, meters: Math.round(best.d) };
  }

  return {
    ok: true,
    ticket: {
      street: x.location_text,
      type: x.violation_type,
      date: x.violation_date,
      time: x.violation_time,
      speed: x.recorded_speed,
      limit: x.speed_limit,
      fine: x.fine_amount,
      due: x.payment_due_date,
      direction: x.direction,
      jurisdiction: x.jurisdiction,
    },
    location,
    camera,
    confidence: x.confidence,
    note: x.note_for_driver,
  };
});
