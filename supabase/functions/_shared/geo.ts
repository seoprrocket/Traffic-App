// Geography helpers shared by the agents.

export interface Pt { lat: number; lng: number }

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Meters between two points. */
export function dist(a: Pt, b: Pt): number {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Compass bearing from a to b, 0-359. */
export function bearing(a: Pt, b: Pt): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (Math.round((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

export function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const DIRS: Record<string, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
/** "N/B", "SE/B", "northbound", "EB" → heading in degrees, or null. */
export function parseHeading(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.toUpperCase();
  const m = t.match(/\b(NE|NW|SE|SW|N|S|E|W)\s*\/\s*B\b/) || t.match(/\b(NE|NW|SE|SW|N|S|E|W)B\b/);
  if (m) return DIRS[m[1]];
  const w = t.match(/\b(NORTH|SOUTH|EAST|WEST)\s*-?\s*BOUND\b/);
  if (w) return DIRS[w[1][0]];
  return null;
}

/** Minimum distance in meters from p to the segment a-b (flat-earth approximation, fine under ~50 km). */
export function segDist(p: Pt, a: Pt, b: Pt): number {
  const k = Math.cos(rad(p.lat)) * 111320, m = 110540;
  const ax = (a.lng - p.lng) * k, ay = (a.lat - p.lat) * m, bx = (b.lng - p.lng) * k, by = (b.lat - p.lat) * m;
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? -(ax * dx + ay * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Rough bounding box for a radius search. */
export function box(p: Pt, meters: number) {
  const dLat = meters / 110540, dLng = meters / (111320 * Math.cos(rad(p.lat)));
  return { minLat: p.lat - dLat, maxLat: p.lat + dLat, minLng: p.lng - dLng, maxLng: p.lng + dLng };
}

let lastGeocode = 0;
const UA = `TicketRadar/1.0 (${Deno.env.get("CONTACT_EMAIL") ?? "admin@example.com"})`;
async function politeWait() {
  // Nominatim's usage policy: at most one request per second
  const wait = lastGeocode + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocode = Date.now();
}

/** Address text → coordinates, limited to the DC / Maryland / Virginia area. */
export async function geocode(q: string): Promise<(Pt & { label: string }) | null> {
  await politeWait();
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us" +
    "&viewbox=-79.5,39.8,-75.0,36.5&bounded=1&q=" + encodeURIComponent(q);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
    if (!r.ok) return null;
    const js = await r.json();
    if (!js.length) return null;
    return { lat: +js[0].lat, lng: +js[0].lon, label: String(js[0].display_name).replace(/, United States$/, "") };
  } catch { return null; }
}

/** Coordinates → short place name. */
export async function reverseGeocode(p: Pt): Promise<string | null> {
  await politeWait();
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=16&lat=${p.lat}&lon=${p.lng}`,
      { headers: { "User-Agent": UA, "Accept": "application/json" } });
    if (!r.ok) return null;
    const js = await r.json();
    const a = js.address ?? {};
    return a.neighbourhood || a.suburb || a.road || a.city || a.town || js.display_name || null;
  } catch { return null; }
}

/** Remove license plates, phone numbers and emails from free text. */
export function scrub(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[removed]")
    .replace(/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[removed]")
    // plate-like tokens: 5-8 chars mixing letters and digits, but keep road names like I-495, US-50, MD-355
    .replace(/\b(?!(?:I|US|MD|VA|RT|SR)-?\d)(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9-]{5,8}\b/gi, (m) =>
      /^\d+(st|nd|rd|th|mph|am|pm|ft|mi|min|hrs?)$/i.test(m) ? m : "[removed]")
    .trim();
}
