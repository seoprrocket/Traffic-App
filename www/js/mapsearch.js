// Map search: find official cameras, your pins and ticket spots by name, or any street / address, and jump there.
import { S, remember, forgetRecent } from './store.js';
import { $, $$, esc, dist, fmtDist, toast, debounce, bus, ago } from './util.js';
import { map, layers, icons, markerFor } from './mapview.js';
import { E } from './engine.js';
import { go, ticketForm } from './ui.js';
import { startNav } from './nav.js';
import { askSheet } from './ask.js';
import { allSaved, savePlaceSheet } from './lists.js';
import { listen } from './native.js';
import { runSpoken } from './voice.js';

const GEO = 'https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=us&viewbox=-79.50,39.75,-75.00,37.85&bounded=1&q=';
const ICON = { Speed: '📷', 'Red light': '🚦', 'Stop sign': '🛑', Truck: '🚚', 'School zone': '🏫', 'Bus lane': '🚌' };
let box, inp, res, clearBtn, open = false, geoSeq = 0;

// ---------------------------------------------------------------- what can be found
function items() {
  const out = [];
  if (S.db.settings.officialCams) S.db.official.forEach((c) => out.push({ id: c.id, kind: 'official', icon: ICON[c.kind] || '📷', name: c.name, sub: `${c.kind}${c.kind === 'School zone' ? '' : ' camera'}${c.limit ? ' · limit ' + c.limit : ''} · ${c.jurisdiction || 'official'}`, lat: c.lat, lng: c.lng }));
  S.db.cameras.forEach((c) => out.push({ id: c.id, kind: 'camera', icon: '📷', name: c.name, sub: `Your camera pin · ${c.kind}${c.limit ? ' · limit ' + c.limit : ''}`, lat: c.lat, lng: c.lng }));
  S.db.tickets.filter((t) => !t.example).forEach((t) => out.push({ id: t.id, kind: 'ticket', icon: /^parking/i.test(t.type || '') ? '🅿️' : '⚠️', name: t.street, sub: `Your ticket · ${t.type}${t.date ? ' · ' + t.date : ''}`, lat: t.lat, lng: t.lng }));
  allSaved().forEach((p) => out.push({ id: p.id, kind: 'saved', icon: p.list.icon, name: p.name, sub: `Saved · ${p.list.name}${p.note ? ' · ' + p.note : ''}`, lat: p.lat, lng: p.lng, full: p.note || p.name }));
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
  const q = inp.value.trim();
  const askRow = q.length >= 3 ? `<button type="button" class="ms-row ms-ask" data-ask="1"><span class="ms-ic">💬</span><span class="ms-main"><b>Ask Radar${/\s/.test(q) ? `: “${esc(q)}”` : ''}</b><small>Describe a place with conditions — “coffee with wifi open now near Bethesda”</small></span></button>` : '';
  res.innerHTML = list.map(row).join('') + (geoRow ? `<button type="button" class="ms-row ms-geo" data-geo="1"><span class="ms-ic">🔎</span><span class="ms-main"><b>Search the map for “${esc(geoRow)}”</b><small>Streets, addresses, intersections and places</small></span></button>` : '') + askRow + (note ? `<div class="ms-note">${note}</div>` : '');
  res.hidden = !res.innerHTML;
}
function recentRows() {
  const R = S.db.recent || [];
  if (!R.length) { res.innerHTML = ''; res.hidden = true; return; }
  shown = R.map((r) => (r.lat != null ? { id: 'r' + r.time, kind: r.kind === 'saved' ? 'saved' : 'place', icon: r.icon || '🕘', name: r.label || r.q, sub: r.sub || 'Recent', lat: r.lat, lng: r.lng, full: r.label || r.q, recent: r } : { id: 'r' + r.time, kind: 'query', icon: '🕘', name: r.q, sub: r.kind === 'ask' ? 'Ask Radar' : 'Recent search', recent: r }));
  res.innerHTML = `<div class="ms-recent"><span>Recent</span><button type="button" data-clear-recent="1">Delete all</button></div>` +
    shown.map((it, i) => `<div class="ms-row" data-i="${i}" role="button" tabindex="0"><span class="ms-ic">${it.icon}</span><span class="ms-main"><b>${esc(it.name)}</b><small>${esc(it.sub)} · ${ago(it.recent.time)}</small></span><button type="button" class="ms-del" data-del="${it.recent.time}" aria-label="Delete this search">✕</button></div>`).join('');
  res.hidden = false;
}
function onType() {
  const q = inp.value.trim();
  clearBtn.hidden = !q;
  if (!q) { recentRows(); return; }
  if (q.length < 2) { paint([], '', ''); return; }
  const local = localMatches(q);
  paint(local, q.length >= 3 ? q : '', local.length ? '' : '<span>No camera or ticket spot matches that name.</span>');
}

// ---------------------------------------------------------------- picking a result
function pick(it) {
  remember({ q: it.name, label: it.name, kind: it.kind, icon: it.icon, sub: it.sub, lat: it.lat, lng: it.lng });
  close();
  go('map');
  map.setView([it.lat, it.lng], 17, { animate: true });
  setTimeout(() => {
    const m = markerFor(it.kind, it.id); if (m && m.openPopup) { m.openPopup(); return; }
    if (it.kind === 'saved' && layers.saved) layers.saved.eachLayer((l) => { const ll = l.getLatLng(); if (Math.abs(ll.lat - it.lat) < 1e-6 && Math.abs(ll.lng - it.lng) < 1e-6) l.openPopup(); });
  }, 350);
}
async function geocode(q) {
  const seq = ++geoSeq;
  remember({ q, kind: 'search' });
  paint([], '', '<span class="ms-spin"></span> Searching the map…');
  let js = [];
  try { js = await (await fetch(GEO + encodeURIComponent(q), { headers: { Accept: 'application/json' } })).json(); } catch { /* offline */ }
  if (seq !== geoSeq) return;
  if (!js.length) { paint([], '', 'Nothing found. Add the city or state, like “Georgia Ave & Colesville Rd, Silver Spring MD”.'); return; }
  const list = js.map((x) => { const name = x.display_name.replace(/, United States$/, ''); const parts = name.split(', '); return { id: 'g' + x.place_id, kind: 'place', icon: '📍', name: parts.slice(0, 2).join(', '), sub: parts.slice(2, 5).join(', '), lat: +x.lat, lng: +x.lon, full: name }; });
  paint(list, '', '');
}
function showPlace(p) {
  remember({ q: p.name, label: p.name, kind: 'place', icon: '📍', sub: p.sub, lat: p.lat, lng: p.lng });
  close();
  go('map');
  layers.temp.clearLayers();
  const near = items().filter((x) => x.kind !== 'ticket' && dist(x, p) <= 400).sort((a, b) => dist(a, p) - dist(b, p));
  const m = L.marker([p.lat, p.lng], { icon: icons.temp }).addTo(layers.temp);
  m.bindPopup(`<b>${esc(p.name)}</b><br><small>${esc(p.sub)}</small>
    ${near.length ? `<br><small>📷 ${near.length} camera${near.length === 1 ? '' : 's'} within a quarter mile: ${esc(near.slice(0, 2).map((x) => x.name).join('; '))}${near.length > 2 ? '…' : ''}</small>` : '<br><small>No official camera within a quarter mile.</small>'}
    <div class="popbtns"><button data-ms="nav">Navigate here</button><button data-ms="save">⭐ Save</button><button data-ms="ticket">Add ticket here</button><button data-ms="park">Parking</button><button data-ms="clear">Remove pin</button></div>`, { maxWidth: 260 });
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
  if (b.dataset.ms === 'save') savePlaceSheet({ name: p.name.split(',')[0], lat: p.lat, lng: p.lng, note: p.sub || '' });
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
    const del = e.target.closest('[data-del]'); if (del) { e.stopPropagation(); forgetRecent(+del.dataset.del); recentRows(); return; }
    const clr = e.target.closest('[data-clear-recent]'); if (clr) { forgetRecent(null); recentRows(); toast('Recent searches deleted'); return; }
    const g = e.target.closest('[data-geo]'); if (g) { geocode(inp.value.trim()); return; }
    const a = e.target.closest('[data-ask]'); if (a) { const q = inp.value.trim(); close(); askSheet(/\s/.test(q) ? q : ''); return; }
    const r = e.target.closest('[data-i]'); if (!r) return;
    const it = shown[+r.dataset.i]; if (!it) return;
    if (it.kind === 'query') { inp.value = it.name; if (it.recent.kind === 'ask') { close(); askSheet(it.name); } else { onType(); if (!localMatches(it.name).length) geocode(it.name); } return; }
    if (it.kind === 'place') showPlace(it); else pick(it);
  });
  // Talk to the map: say a place, a street, or a command ("navigate to…", "find gas", "take me home")
  const mic = $('#ms-mic');
  if (mic) mic.onclick = async () => {
    mic.classList.add('listening'); inp.placeholder = 'Listening…';
    try {
      const said = (await listen()).trim();
      if (!said) { toast('Didn\'t catch that'); return; }
      if (/^(navigate|take me|drive me|go|head|directions|find|look for|search for|where'?s|nearest|closest|add a stop|stop for|mute|unmute|alerts only|re-?cent|share my|remind me|save this|report|there'?s)/i.test(said) && await runSpoken(said)) { close(); return; }
      inp.value = said; open = true; box.classList.add('open'); onType();
      if (!localMatches(said).length) geocode(said);
    } catch (e) { toast(e.message || 'Voice isn\'t available here'); }
    finally { mic.classList.remove('listening'); inp.placeholder = 'Search or say a place, camera, street'; }
  };
  map.on('click dragstart', () => { if (open) close(); });
  bus.on('go', (v) => { if (v !== 'map' && open) close(); });
}
