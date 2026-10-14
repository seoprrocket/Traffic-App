// Map search: find official cameras, your pins and ticket spots by name, or any street / address, and jump there.
import { S } from './store.js';
import { $, $$, esc, dist, fmtDist, toast, debounce, bus } from './util.js';
import { map, layers, icons, markerFor } from './mapview.js';
import { E } from './engine.js';
import { go, ticketForm } from './ui.js';
import { startNav } from './nav.js';

const GEO = 'https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=us&viewbox=-79.50,39.75,-75.00,37.85&bounded=1&q=';
const ICON = { Speed: '📷', 'Red light': '🚦', 'Stop sign': '🛑', Truck: '🚚', 'School zone': '🏫', 'Bus lane': '🚌' };
let box, inp, res, clearBtn, open = false, geoSeq = 0;

// ---------------------------------------------------------------- what can be found
function items() {
  const out = [];
  if (S.db.settings.officialCams) S.db.official.forEach((c) => out.push({ id: c.id, kind: 'official', icon: ICON[c.kind] || '📷', name: c.name, sub: `${c.kind}${c.kind === 'School zone' ? '' : ' camera'}${c.limit ? ' · limit ' + c.limit : ''} · ${c.jurisdiction || 'official'}`, lat: c.lat, lng: c.lng }));
  S.db.cameras.forEach((c) => out.push({ id: c.id, kind: 'camera', icon: '📷', name: c.name, sub: `Your camera pin · ${c.kind}${c.limit ? ' · limit ' + c.limit : ''}`, lat: c.lat, lng: c.lng }));
  S.db.tickets.filter((t) => !t.example).forEach((t) => out.push({ id: t.id, kind: 'ticket', icon: /^parking/i.test(t.type || '') ? '🅿️' : '⚠️', name: t.street, sub: `Your ticket · ${t.type}${t.date ? ' · ' + t.date : ''}`, lat: t.lat, lng: t.lng }));
  return out;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function localMatches(q) {
  const words = norm(q).split(' ').filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  for (const it of items()) {
    const n = norm(it.name);
    if (!words.every((w) => n.includes(w))) continue;
    const score = (n.startsWith(words[0]) ? 0 : 1) + (E.me ? Math.min(1, dist(E.me, it) / 40000) : 0.5);
    hits.push({ it, score });
  }
  return hits.sort((a, b) => a.score - b.score).slice(0, 8).map((h) => h.it);
}

// ---------------------------------------------------------------- drawing the results
function row(it, i) {
  return `<button type="button" class="ms-row" data-i="${i}"><span class="ms-ic">${it.icon}</span><span class="ms-main"><b>${esc(it.name)}</b><small>${esc(it.sub)}${E.me && it.lat != null ? ' · ' + fmtDist(dist(E.me, it)) : ''}</small></span></button>`;
}
let shown = [];
function paint(list, geoRow, note) {
  shown = list;
  res.innerHTML = list.map(row).join('') + (geoRow ? `<button type="button" class="ms-row ms-geo" data-geo="1"><span class="ms-ic">🔎</span><span class="ms-main"><b>Search the map for “${esc(geoRow)}”</b><small>Streets, addresses, intersections and places</small></span></button>` : '') + (note ? `<div class="ms-note">${note}</div>` : '');
  res.hidden = !res.innerHTML;
}
function onType() {
  const q = inp.value.trim();
  clearBtn.hidden = !q;
  if (q.length < 2) { paint([], '', ''); return; }
  const local = localMatches(q);
  paint(local, q.length >= 3 ? q : '', local.length ? '' : '<span>No camera or ticket spot matches that name.</span>');
}

// ---------------------------------------------------------------- picking a result
function pick(it) {
  close();
  go('map');
  map.setView([it.lat, it.lng], 17, { animate: true });
  setTimeout(() => { const m = markerFor(it.kind, it.id); if (m && m.openPopup) m.openPopup(); }, 350);
}
async function geocode(q) {
  const seq = ++geoSeq;
  paint([], '', '<span class="ms-spin"></span> Searching the map…');
  let js = [];
  try { js = await (await fetch(GEO + encodeURIComponent(q), { headers: { Accept: 'application/json' } })).json(); } catch { /* offline */ }
  if (seq !== geoSeq) return;
  if (!js.length) { paint([], '', 'Nothing found. Add the city or state, like “Georgia Ave & Colesville Rd, Silver Spring MD”.'); return; }
  const list = js.map((x) => { const name = x.display_name.replace(/, United States$/, ''); const parts = name.split(', '); return { id: 'g' + x.place_id, kind: 'place', icon: '📍', name: parts.slice(0, 2).join(', '), sub: parts.slice(2, 5).join(', '), lat: +x.lat, lng: +x.lon, full: name }; });
  paint(list, '', '');
}
function showPlace(p) {
  close();
  go('map');
  layers.temp.clearLayers();
  const near = items().filter((x) => x.kind !== 'ticket' && dist(x, p) <= 400).sort((a, b) => dist(a, p) - dist(b, p));
  const m = L.marker([p.lat, p.lng], { icon: icons.temp }).addTo(layers.temp);
  m.bindPopup(`<b>${esc(p.name)}</b><br><small>${esc(p.sub)}</small>
    ${near.length ? `<br><small>📷 ${near.length} camera${near.length === 1 ? '' : 's'} within a quarter mile: ${esc(near.slice(0, 2).map((x) => x.name).join('; '))}${near.length > 2 ? '…' : ''}</small>` : '<br><small>No official camera within a quarter mile.</small>'}
    <div class="popbtns"><button data-ms="nav">Navigate here</button><button data-ms="ticket">Add ticket here</button><button data-ms="park">Parking</button><button data-ms="clear">Remove pin</button></div>`, { maxWidth: 260 });
  map.setView([p.lat, p.lng], 16, { animate: true });
  setTimeout(() => m.openPopup(), 300);
  m.__place = p;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.leaflet-popup [data-ms]'); if (!b) return;
  let p = null; layers.temp.eachLayer((l) => { if (l.__place) p = l.__place; });
  if (!p) return;
  map.closePopup();
  const dest = { lat: p.lat, lng: p.lng, label: p.full || p.name };
  if (b.dataset.ms === 'nav') startNav({ dest, name: p.name });
  if (b.dataset.ms === 'ticket') ticketForm(null, { title: 'Add ticket', note: 'Location set from your search. Check the street name, then add the details from your notice.', ticket: { street: p.name.split(',')[0].slice(0, 160) }, location: dest });
  if (b.dataset.ms === 'park') { S.parkNear = dest; go('parking'); }
  if (b.dataset.ms === 'clear') layers.temp.clearLayers();
});

// ---------------------------------------------------------------- open / close
function close() { open = false; res.hidden = true; inp.blur(); box.classList.remove('open'); }
export function setupMapSearch() {
  box = $('#mapsearch'); inp = $('#ms-q'); res = $('#ms-res'); clearBtn = $('#ms-x');
  if (!box) return;
  inp.addEventListener('input', debounce(onType, 120));
  inp.addEventListener('focus', () => { open = true; box.classList.add('open'); onType(); });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (shown.length && shown[0].kind !== 'place') pick(shown[0]); else if (shown.length) showPlace(shown[0]); else if (inp.value.trim().length >= 3) geocode(inp.value.trim()); }
  });
  clearBtn.onclick = () => { inp.value = ''; clearBtn.hidden = true; paint([], '', ''); layers.temp.clearLayers(); inp.focus(); };
  res.addEventListener('click', (e) => {
    const g = e.target.closest('[data-geo]'); if (g) { geocode(inp.value.trim()); return; }
    const r = e.target.closest('[data-i]'); if (!r) return;
    const it = shown[+r.dataset.i]; if (!it) return;
    if (it.kind === 'place') showPlace(it); else pick(it);
  });
  map.on('click dragstart', () => { if (open) close(); });
  bus.on('go', (v) => { if (v !== 'map' && open) close(); });
}
