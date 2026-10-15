// Ask Radar: plain-English place requests with several criteria at once, answered from OpenStreetMap —
// "quiet restaurant with parking, open late, vegetarian options, between Silver Spring and Bethesda".
// Everything is checked against map data on the phone; where the map has no answer, the result says so.
import { S } from './store.js';
import { $, $$, esc, dist, fmtDist, toast, bus } from './util.js';
import { map, layers, icons } from './mapview.js';
import { E } from './engine.js';
import { overpass } from './overpass.js';
import { openSheet, closeSheet, head, go } from './ui.js';
import { startNav, navOn, addStop, navState, locate } from './nav.js';
import { listen } from './native.js';

// ---------------------------------------------------------------- what kind of place
const KINDS = [
  [/\b(gas|fuel|petrol|diesel|gas station)\b/, 'fuel', '⛽', 'Gas station', '["amenity"="fuel"]'],
  [/\b(ev|electric|charg\w*|supercharger)\b/, 'charge', '🔌', 'EV charging', '["amenity"="charging_station"]'],
  [/\b(coffee|cafe|caf[eé]|espresso|latte|starbucks)\b/, 'cafe', '☕', 'Coffee', '["amenity"="cafe"]'],
  [/\b(atm|cash|bank)\b/, 'atm', '🏧', 'ATM / bank', '["amenity"~"^(atm|bank)$"]'],
  [/\b(pharmac\w*|drugstore|cvs|walgreens|prescription)\b/, 'pharmacy', '💊', 'Pharmacy', '["amenity"="pharmacy"]'],
  [/\b(grocer\w*|supermarket|groceries|whole foods|trader joe|giant|safeway)\b/, 'grocery', '🛒', 'Grocery', '["shop"="supermarket"]'],
  [/\b(convenience|7.?eleven|wawa|sheetz|corner store)\b/, 'store', '🏪', 'Convenience store', '["shop"="convenience"]'],
  [/\b(hotel|motel|place to (stay|sleep)|lodging)\b/, 'hotel', '🏨', 'Hotel', '["tourism"~"^(hotel|motel)$"]'],
  [/\b(hospital|urgent care|emergency room|\ber\b|clinic)\b/, 'medical', '🏥', 'Hospital / clinic', '["amenity"~"^(hospital|clinic|doctors)$"]'],
  [/\b(rest ?stop|rest ?area|bathroom|restroom|toilet)\b/, 'restroom', '🚻', 'Restroom', '["amenity"="toilets"]'],
  [/\b(car wash)\b/, 'carwash', '🧽', 'Car wash', '["amenity"="car_wash"]'],
  [/\b(mechanic|tire|tyre|auto repair|oil change|body shop)\b/, 'repair', '🔧', 'Auto repair', '["shop"~"^(car_repair|tyres)$"]'],
  [/\b(bar|pub|drinks|beer|cocktail|brewery|happy hour|wine bar)\b/, 'bar', '🍺', 'Bar', '["amenity"~"^(bar|pub|biergarten)$"]'],
  [/\b(fast food|burger|drive.?thr(u|ough)|mcdonald|chick.?fil|wendy|taco bell|chipotle|five guys)\b/, 'fastfood', '🍟', 'Fast food', '["amenity"="fast_food"]'],
  [/\b(pizza|sushi|thai|chinese|mexican|indian|italian|ethiopian|korean|japanese|vietnamese|pho|ramen|bbq|barbecue|seafood|steak|mediterranean|greek|halal|kosher|caribbean|jamaican|peruvian|salvadoran|pupus|tacos?|wings|brunch|bakery|dessert|ice cream)\b/, 'cuisine', '🍽️', 'Restaurant', '["amenity"~"^(restaurant|fast_food|cafe)$"]'],
  [/\b(restaurant|dinner|lunch|breakfast|eat|food|dine|dining|meal|place to eat|hungry)\b/, 'restaurant', '🍽️', 'Restaurant', '["amenity"="restaurant"]'],
  [/\b(park(ing)?|garage|park my car)\b/, 'parking', '🅿️', 'Parking', '["amenity"="parking"]'],
  [/\b(gym|fitness|workout)\b/, 'gym', '🏋️', 'Gym', '["leisure"="fitness_centre"]'],
  [/\b(library|librar)\b/, 'library', '📚', 'Library', '["amenity"="library"]'],
  [/\b(playground|park for kids)\b/, 'playground', '🛝', 'Playground', '["leisure"="playground"]'],
];
const CUISINE = { pizza: 'pizza', sushi: 'sushi|japanese', thai: 'thai', chinese: 'chinese', mexican: 'mexican', indian: 'indian', italian: 'italian', ethiopian: 'ethiopian', korean: 'korean', japanese: 'japanese', vietnamese: 'vietnamese', pho: 'vietnamese', ramen: 'ramen|japanese', bbq: 'barbecue|bbq', barbecue: 'barbecue|bbq', seafood: 'seafood', steak: 'steak', mediterranean: 'mediterranean|greek|lebanese|turkish', greek: 'greek', halal: 'halal', kosher: 'kosher', caribbean: 'caribbean|jamaican', jamaican: 'jamaican|caribbean', peruvian: 'peruvian', salvadoran: 'salvadoran|pupus', pupus: 'salvadoran|pupus', taco: 'mexican|tacos?', tacos: 'mexican|tacos?', wings: 'chicken|wings', brunch: 'breakfast|brunch|american', bakery: 'bakery', dessert: 'dessert|ice_cream', 'ice cream': 'ice_cream' };

// ---------------------------------------------------------------- what else they asked for
// Each filter: [regex, key, label, check(tags) → true | false | null (map data can't tell)]
const FILTERS = [
  [/\bvegan\b/, 'vegan', 'vegan options', (t) => (t['diet:vegan'] ? ['yes', 'only'].includes(t['diet:vegan']) : null)],
  [/\bvegetarian|veggie\b/, 'vegetarian', 'vegetarian options', (t) => (t['diet:vegetarian'] || t['diet:vegan'] ? ['yes', 'only'].includes(t['diet:vegetarian']) || ['yes', 'only'].includes(t['diet:vegan']) : null)],
  [/\b(gluten.?free)\b/, 'gf', 'gluten-free options', (t) => (t['diet:gluten_free'] ? ['yes', 'only'].includes(t['diet:gluten_free']) : null)],
  [/\bhalal\b/, 'halal', 'halal', (t) => (t['diet:halal'] ? ['yes', 'only'].includes(t['diet:halal']) : /halal/i.test(t.cuisine || '') ? true : null)],
  [/\bkosher\b/, 'kosher', 'kosher', (t) => (t['diet:kosher'] ? ['yes', 'only'].includes(t['diet:kosher']) : /kosher/i.test(t.cuisine || '') ? true : null)],
  [/\b(open late|late night|late|after (9|10|11)|until midnight|till midnight)\b/, 'late', 'open late (10 PM or later)', (t) => hours(t.opening_hours).late],
  [/\b(open now|right now|open at this hour|still open)\b/, 'now', 'open now', (t) => hours(t.opening_hours).openNow],
  [/\b(24.?hours?|24\/7|all night|around the clock)\b/, 'h24', 'open 24 hours', (t) => (t.opening_hours ? /24\s*\/\s*7/.test(t.opening_hours) : null)],
  [/\b(with parking|good parking|easy parking|well.?park\w*|parking lot|free parking|has parking)\b/, 'parking', 'parking', (t, x) => (t.parking ? t.parking !== 'no' : x.nearParking != null ? x.nearParking : null)],
  [/\b(quiet|calm|not (too )?loud|peaceful|low.?key)\b/, 'quiet', 'quiet', (t, x) => (x.majorRoad == null ? null : !x.majorRoad)],
  [/\b(outdoor|patio|outside seating|outdoor seating|terrace)\b/, 'outdoor', 'outdoor seating', (t) => (t.outdoor_seating ? t.outdoor_seating !== 'no' : null)],
  [/\b(wi-?fi|internet)\b/, 'wifi', 'wi-fi', (t) => (t.internet_access ? !['no', 'none'].includes(t.internet_access) : null)],
  [/\b(wheelchair|accessible|step.?free)\b/, 'wheelchair', 'wheelchair accessible', (t) => (t.wheelchair ? t.wheelchair === 'yes' || t.wheelchair === 'limited' : null)],
  [/\b(drive.?thr(u|ough))\b/, 'drivethru', 'drive-through', (t) => (t.drive_through ? t.drive_through === 'yes' : null)],
  [/\b(takeout|take.?away|to go)\b/, 'takeout', 'takeout', (t) => (t.takeaway ? t.takeaway !== 'no' : null)],
  [/\b(deliver\w*)\b/, 'delivery', 'delivery', (t) => (t.delivery ? t.delivery !== 'no' : null)],
  [/\b(kid|child|family|families)\w*\b/, 'kids', 'family-friendly', (t) => (t.kids_area ? t.kids_area === 'yes' : t.highchair ? t.highchair === 'yes' : null)],
  [/\b(dog|pet)s?\b/, 'dogs', 'dogs allowed', (t) => (t.dog ? t.dog !== 'no' : null)],
  [/\b(cheap|inexpensive|affordable|budget|not (too )?expensive)\b/, 'cheap', 'inexpensive', () => null],
  [/\b(reservation|book a table)\b/, 'reservation', 'takes reservations', (t) => (t.reservation ? t.reservation !== 'no' : null)],
  [/\b(credit card|card payment|cashless)\b/, 'cards', 'takes cards', (t) => (t['payment:credit_cards'] ? t['payment:credit_cards'] === 'yes' : t['payment:cards'] ? t['payment:cards'] === 'yes' : null)],
];

// ---------------------------------------------------------------- opening hours (the common OSM shapes)
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
export function hours(str) {
  if (!str) return { late: null, openNow: null, text: '' };
  const s = String(str).trim();
  if (/24\s*\/\s*7/.test(s)) return { late: true, openNow: true, text: 'Open 24 hours' };
  const today = DAYS[new Date().getDay()], nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  let maxClose = null, openNow = null, sawToday = false;
  for (const rule of s.split(/\s*;\s*/)) {
    const m = rule.match(/^([A-Za-z,\-\s]*?)\s*(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}(?:\s*,\s*\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})*)\s*$/);
    if (!m) { if (/\boff\b|closed/i.test(rule) && dayMatch(rule, today)) { sawToday = true; openNow = false; } continue; }
    const days = m[1].trim(), applies = !days || dayMatch(days, today);
    for (const span of m[2].split(/\s*,\s*/)) {
      const [a, b] = span.split(/\s*-\s*/).map(toMin);
      const close = b <= a ? b + 1440 : b;              // "22:00-02:00" closes after midnight
      maxClose = Math.max(maxClose ?? 0, close);
      if (applies) { sawToday = true; if (nowMin >= a && nowMin < close || nowMin + 1440 < close && nowMin < b) openNow = true; else if (openNow == null) openNow = false; }
    }
  }
  return { late: maxClose == null ? null : maxClose >= 22 * 60, openNow: sawToday ? openNow : null, text: s.length > 60 ? s.slice(0, 57) + '…' : s, closes: maxClose };
}
function toMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); }
function dayMatch(spec, day) {
  const parts = spec.replace(/\s+/g, '').split(',');
  for (const p of parts) {
    if (!p) continue;
    if (/^PH|^SH/.test(p)) continue;
    const r = p.match(/^([A-Za-z]{2})-([A-Za-z]{2})$/);
    if (r) { const a = DAYS.indexOf(cap(r[1])), b = DAYS.indexOf(cap(r[2])), d = DAYS.indexOf(day); if (a >= 0 && b >= 0 && (a <= b ? d >= a && d <= b : d >= a || d <= b)) return true; }
    else if (cap(p) === day) return true;
  }
  return false;
}
const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase();

// ---------------------------------------------------------------- the request
export function parseAsk(q) {
  const t = String(q || '').toLowerCase().replace(/[’']/g, "'").trim();
  const kind = KINDS.find(([re]) => re.test(t));
  const cuisineWord = Object.keys(CUISINE).find((w) => new RegExp('\\b' + w + '\\b').test(t));
  const filters = FILTERS.filter(([re]) => re.test(t)).map(([, key, label, check]) => ({ key, label, check }));
  // where
  let where = { mode: 'me' };
  let m;
  if ((m = /\b(?:between|from)\s+(.+?)\s+(?:and|to)\s+(.+?)(?:\s+(?:that|with|which|open|and|,)\b.*)?$/.exec(t)) && !/^(a|an|the)\b/.test(m[1])) where = { mode: 'between', a: clean(m[1]), b: clean(m[2]) };
  else if (/\b(on (my|the) (way|route)|along (my|the) (route|way)|en route|on route)\b/.test(t)) where = { mode: 'route' };
  else if ((m = /\b(?:near|in|around|close to|by)\s+(?!me\b|here\b|my location)([a-z0-9][a-z0-9 .'&-]{2,60}?)(?=\s+(?:that|with|which|open|and|for|,)\b|$)/.exec(t))) where = { mode: 'place', q: clean(m[1]) };
  const radiusWord = /\bwithin\s+(\d+(?:\.\d+)?)\s*(mi|mile|miles|km|minutes?|min)\b/.exec(t);
  const radius = radiusWord ? (/mi/.test(radiusWord[2]) ? +radiusWord[1] * 1609 : /km/.test(radiusWord[2]) ? +radiusWord[1] * 1000 : +radiusWord[1] * 800) : null;
  return { q, kind: kind ? { key: kind[1], icon: kind[2], label: kind[3], tag: kind[4] } : null, cuisine: cuisineWord ? CUISINE[cuisineWord] : null, cuisineWord, filters, where, radius };
}
const clean = (s) => s.replace(/\b(a|an|the|some|any|good|nice|great|best)\b/g, ' ').replace(/[?.!,]+$/, '').replace(/\s+/g, ' ').trim();

async function geocode(q) {
  const near = E.me || map.getCenter();
  const u = new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'us', q, viewbox: `${near.lng - 1.2},${near.lat + 0.9},${near.lng + 1.2},${near.lat - 0.9}`, bounded: '1' });
  const js = await (await fetch('https://nominatim.openstreetmap.org/search?' + u, { headers: { Accept: 'application/json' } })).json();
  if (!js[0]) { const js2 = await (await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'us', q }))).json(); if (!js2[0]) throw new Error(`Couldn't find "${q}"`); return { lat: +js2[0].lat, lng: +js2[0].lon, name: js2[0].display_name.split(',')[0] }; }
  return { lat: +js[0].lat, lng: +js[0].lon, name: js[0].display_name.split(',')[0] };
}

/** Run the request. Returns { parsed, area, results, note }. */
export async function askRadar(q) {
  const p = parseAsk(q);
  if (!p.kind) throw new Error('Tell me what kind of place: a restaurant, coffee, gas, an ATM, parking, a pharmacy…');
  // the search area
  let area, areaText;
  if (p.where.mode === 'between') {
    const [a, b] = await Promise.all([geocode(p.where.a), geocode(p.where.b)]);
    const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    area = { ...mid, r: Math.min(20000, dist(a, b) / 2 + 1200), a, b }; areaText = `between ${a.name} and ${b.name}`;
  } else if (p.where.mode === 'route') {
    const N = navState();
    if (!N) throw new Error('Start navigation first, then ask for places on the way.');
    const from = N.along || 0, line = []; let lastAt = -1e9;
    for (let i = Math.max(0, N.seg); i < N.R.pts.length; i++) { const at = N.R.cum[i] - from; if (at > 25000) break; if (at - lastAt >= 400) { line.push(`${N.R.pts[i].lat.toFixed(5)},${N.R.pts[i].lng.toFixed(5)}`); lastAt = at; } }
    area = { route: line, N }; areaText = 'along your route';
  } else if (p.where.mode === 'place') {
    const c = await geocode(p.where.q); area = { ...c, r: p.radius || 3000 }; areaText = `near ${c.name}`;
  } else {
    const c = E.me || map.getCenter(); area = { lat: c.lat, lng: c.lng, r: p.radius || 3500 }; areaText = E.me ? 'near you' : 'around the map';
  }
  const tag = p.kind.tag + (p.cuisine ? `["cuisine"~"${p.cuisine}",i]` : '');
  const where = area.route ? `(around:500,${area.route.join(',')})` : `(around:${Math.round(area.r)},${area.lat.toFixed(5)},${area.lng.toFixed(5)})`;
  const wantParking = p.filters.some((f) => f.key === 'parking') && p.kind.key !== 'parking';
  const wantQuiet = p.filters.some((f) => f.key === 'quiet');
  const q2 = `[out:json][timeout:20];nwr${tag}${where}->.p;(.p;${wantParking ? 'nwr["amenity"="parking"](around.p:120);' : ''}${wantQuiet ? 'way["highway"~"^(motorway|trunk|primary)$"](around.p:60);' : ''});out center 80;`;
  const js = await overpass(q2, { timeoutMs: 22000 });
  const els = js.elements || [];
  const parkings = els.filter((e) => e.tags?.amenity === 'parking' && p.kind.key !== 'parking').map((e) => ({ lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon }));
  const roads = els.filter((e) => e.type === 'way' && e.tags?.highway && /^(motorway|trunk|primary)$/.test(e.tags.highway)).map((e) => ({ lat: e.center?.lat, lng: e.center?.lon }));
  const ref = area.a ? null : area.route ? null : { lat: area.lat, lng: area.lng };
  const me = E.me;
  const out = [];
  for (const el of els) {
    const t = el.tags || {};
    if (p.kind.key !== 'parking' && t.amenity === 'parking') continue;
    if (el.type === 'way' && t.highway) continue;
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon; if (lat == null) continue;
    const x = { id: 'osm' + el.type[0] + el.id, name: t.name || t.brand || t.operator || p.kind.label, lat, lng, tags: t, icon: p.kind.icon, kind: p.kind.label };
    if (wantParking) x.nearParking = t.parking ? t.parking !== 'no' : parkings.some((pk) => dist(pk, x) <= 120) ? true : parkings.length ? false : null;
    if (wantQuiet) x.majorRoad = roads.length ? roads.some((r) => r.lat != null && dist(r, x) <= 90) : null;
    x.checks = p.filters.map((f) => ({ key: f.key, label: f.label, ok: f.check(t, x) }));
    x.score = x.checks.reduce((s, c) => s + (c.ok === true ? 2 : c.ok === null ? 0 : -3), 0);
    x.hours = hours(t.opening_hours);
    x.d = me ? dist(me, x) : ref ? dist(ref, x) : null;
    if (area.route) { const pos = locate(area.N.R, x, area.N.seg); x.ahead = pos.along - (area.N.along || 0); x.off = pos.off; }
    if (area.a) { x.detour = dist(area.a, x) + dist(x, area.b) - dist(area.a, area.b); }
    x.sub = [t['addr:street'] ? `${t['addr:housenumber'] || ''} ${t['addr:street']}`.trim() : '', t.cuisine ? t.cuisine.replace(/_/g, ' ').replace(/;/g, ', ') : '', x.hours.text].filter(Boolean).join(' · ');
    out.push(x);
  }
  out.sort((a, b) => b.score - a.score || (a.ahead ?? a.detour ?? a.d ?? 0) - (b.ahead ?? b.detour ?? b.d ?? 0));
  const unknowable = p.filters.filter((f) => out.length && out.every((x) => x.checks.find((c) => c.key === f.key)?.ok == null)).map((f) => f.label);
  const note = !out.length ? `No ${p.kind.label.toLowerCase()} ${p.cuisineWord ? '(' + p.cuisineWord + ') ' : ''}found ${areaText}. Try a wider area or fewer conditions.`
    : unknowable.length ? `The map doesn't record ${unknowable.join(' or ')} for these places, so those are shown as unknown rather than guessed.` : '';
  return { parsed: p, areaText, results: out.slice(0, 20), note };
}

// ---------------------------------------------------------------- the sheet
let lastQ = '';
export function askSheet(q = '') {
  openSheet(`${head('Ask Radar')}
    <div class="sec">
      <p class="note" style="margin:0">Describe what you need in one sentence. Examples: <i>quiet restaurant with parking, open late, vegetarian options, between Silver Spring and Bethesda</i> · <i>gas on the way</i> · <i>24 hour pharmacy near Rockville</i> · <i>coffee with wifi near me</i>.</p>
      <div class="ms-bar" style="position:static"><span class="ms-glass" aria-hidden="true">💬</span><input id="ask-q" type="search" placeholder="What do you need?" autocomplete="off" value="${esc(q || lastQ)}"><button id="ask-mic" type="button" aria-label="Say it">🎤</button></div>
      <div class="btns"><button class="btn primary" id="ask-go">Ask</button></div>
      <div id="ask-out" class="sec"></div>
    </div>`, (s) => {
    const out = s.querySelector('#ask-out'), inp = s.querySelector('#ask-q');
    const run = async () => {
      const text = inp.value.trim(); if (text.length < 3) { inp.focus(); return; }
      lastQ = text;
      out.innerHTML = '<div class="empty"><span class="ms-spin"></span> Checking the map…</div>';
      try {
        const r = await askRadar(text);
        const crit = r.parsed.filters.map((f) => f.label);
        out.innerHTML = `<p class="note" style="margin:0 0 6px"><b>${esc(r.parsed.kind.label)}${r.parsed.cuisineWord ? ' · ' + esc(r.parsed.cuisineWord) : ''}</b> ${esc(r.areaText)}${crit.length ? ' · ' + esc(crit.join(', ')) : ''}</p>${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}` +
          r.results.map((x, i) => `<div class="row"><div class="main"><div class="ttl">${x.icon} ${esc(x.name)}</div>
            <div class="meta">${x.ahead != null ? `${fmtDist(Math.max(0, x.ahead))} ahead · ${x.off < 60 ? 'on the route' : fmtDist(x.off) + ' off'}` : x.detour != null ? `${fmtDist(x.detour)} out of the way${x.d != null ? ' · ' + fmtDist(x.d) + ' from you' : ''}` : x.d != null ? fmtDist(x.d) + (E.me ? ' from you' : ' from there') : ''}${x.sub ? ' · ' + esc(x.sub) : ''}</div>
            ${x.checks.length ? `<div class="meta checks">${x.checks.map((c) => `<span class="ck ${c.ok === true ? 'ok' : c.ok === false ? 'no' : 'unk'}">${c.ok === true ? '✓' : c.ok === false ? '✗' : '?'} ${esc(c.label)}</span>`).join('')}</div>` : ''}
            <div class="orow"><button class="sbtn primary" data-nav="${i}">Navigate</button>${navOn() ? `<button class="sbtn" data-stop="${i}">Add stop</button>` : ''}<button class="sbtn" data-map="${i}">Map</button></div></div></div>`).join('');
        $$('[data-nav]', out).forEach((b) => (b.onclick = async () => { const x = r.results[+b.dataset.nav]; closeSheet(); await startNav({ dest: { lat: x.lat, lng: x.lng, label: x.name }, name: x.name }); }));
        $$('[data-stop]', out).forEach((b) => (b.onclick = async () => { const x = r.results[+b.dataset.stop]; closeSheet(); await addStop({ id: x.id, name: x.name, kind: x.kind, lat: x.lat, lng: x.lng }); }));
        $$('[data-map]', out).forEach((b) => (b.onclick = () => { const x = r.results[+b.dataset.map]; closeSheet(); go('map'); layers.temp.clearLayers(); L.marker([x.lat, x.lng], { icon: icons.temp }).bindPopup(`<b>${esc(x.name)}</b><br><small>${esc(x.sub || x.kind)}</small>`).addTo(layers.temp).openPopup(); map.setView([x.lat, x.lng], 16); }));
        bus.emit('ask-results', r);
      } catch (e) { out.innerHTML = `<div class="empty">${esc(e.message || 'Something went wrong')}</div>`; }
    };
    s.querySelector('#ask-go').onclick = run;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    s.querySelector('#ask-mic').onclick = async () => { try { const t = await listen(); if (t) { inp.value = t; run(); } } catch (e) { toast(e.message); } };
    if (q) run(); else inp.focus();
  });
}
/** Spoken answer for a voice request: the top two matches. */
export async function askSpoken(q) {
  const r = await askRadar(q);
  if (!r.results.length) return r.note;
  const top = r.results.slice(0, 2).map((x) => `${x.name}${x.ahead != null ? `, ${fmtDist(Math.max(0, x.ahead))} ahead` : x.d != null ? `, ${fmtDist(x.d)} away` : ''}${x.checks.some((c) => c.ok === false) ? ', missing ' + x.checks.filter((c) => c.ok === false).map((c) => c.label).join(' and ') : ''}`);
  return `${r.results.length === 1 ? 'One match' : `${r.results.length} matches`} ${r.areaText}. ${top.join('. ')}. ${navOn() ? 'Say "add stop" for the first one, or ' : ''}say "navigate to" and the name.`;
}
