// List, Stats, Route and More tabs, plus helpers other pages reuse.
import { S, removeLocal, activeReports, allCameras } from './store.js';
import { $, $$, esc, money, dist, fmtDist, ago, segDist, streetKey, bus, toast } from './util.js';
import { map, layers } from './mapview.js';
import { E } from './engine.js';
import { go, confirmDel, ticketForm, cameraForm, locWidget } from './ui.js';

// ---------------------------------------------------------------- shared analytics
export function group(arr, keyFn) { const m = new Map(); arr.forEach((x) => { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }); return m; }
export function hotspots() {
  const cl = [];
  S.db.tickets.forEach((t) => {
    const c = cl.find((c) => dist(c, t) < 250);
    if (c) { c.items.push(t); const n = c.items.length; c.lat = (c.lat * (n - 1) + t.lat) / n; c.lng = (c.lng * (n - 1) + t.lng) / n; }
    else cl.push({ lat: t.lat, lng: t.lng, items: [t] });
  });
  return cl.map((c) => ({ lat: c.lat, lng: c.lng, count: c.items.length, total: c.items.reduce((s, x) => s + (x.fine || 0), 0), name: streetKey(c.items[0].street), items: c.items }))
    .sort((a, b) => b.count - a.count || b.total - a.total);
}
export function barList(entries, fmt, color) {
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return `<div class="bars">${entries.map(([k, v]) => `<div class="bar"><span class="lbl" title="${esc(k)}">${esc(k)}</span><span class="trk"><span class="fill" style="width:${((v / max) * 100).toFixed(1)}%;${color ? 'background:' + color : ''}"></span></span><span class="val">${fmt(v)}</span></div>`).join('')}</div>`;
}
export function summary() {
  const T = S.db.tickets, total = T.reduce((s, t) => s + (t.fine || 0), 0), ws = T.filter((t) => t.speed);
  const overs = T.filter((t) => t.speed && t.limit).map((t) => t.speed - t.limit);
  const lastDate = T.map((t) => t.date).filter(Boolean).sort().pop();
  return {
    n: T.length, total, avgFine: T.length ? total / T.length : 0, avgSpd: ws.length ? ws.reduce((s, t) => s + t.speed, 0) / ws.length : null,
    avgOver: overs.length ? overs.reduce((a, b) => a + b, 0) / overs.length : null,
    daysClean: lastDate ? Math.max(0, Math.floor((Date.now() - new Date(lastDate + 'T12:00')) / 86400000)) : null,
  };
}

// ---------------------------------------------------------------- List
let listKind = 'tickets';
$$('#listSeg button').forEach((b) => (b.onclick = () => { listKind = b.dataset.k; $$('#listSeg button').forEach((x) => x.setAttribute('aria-pressed', x === b)); renderList(); }));
export function renderList() {
  const host = $('#listBody');
  if (listKind === 'tickets') {
    const rows = [...S.db.tickets].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    host.innerHTML = rows.length ? rows.map((t) => `<div class="row t"><div class="main"><div class="ttl">${esc(t.street)}${t.example ? '<span class="tag">Example</span>' : ''}${t.shared ? '<span class="tag">Shared</span>' : ''}</div>
      <div class="meta">${esc(t.type)} · ${esc(t.date || 'no date')}${t.time ? ' ' + esc(t.time) : ''} · ${t.fine ? money(t.fine) : 'no fine'}${t.speed ? ' · ' + t.speed + ' mph' : ''}${t.limit ? ' in ' + t.limit : ''}</div>
      ${t.due ? `<div class="meta">Pay or contest by <b>${esc(t.due)}</b></div>` : ''}${t.notes ? `<div class="meta">${esc(t.notes)}</div>` : ''}</div>
      <div class="acts"><button class="sbtn" data-go="${t.id}">Map</button><button class="sbtn" data-disp="${t.id}">Dispute help</button><button class="sbtn" data-ed="${t.id}">Edit</button><button class="sbtn danger" data-del="${t.id}">Delete</button></div></div>`).join('')
      : '<div class="empty">No tickets yet. Tap the red + on the map to scan or add your first one.</div>';
  } else {
    const mine = S.db.cameras;
    const byArea = {}; S.db.official.forEach((c) => { const k = c.jurisdiction || 'Other'; byArea[k] = (byArea[k] || 0) + 1; });
    const areas = Object.entries(byArea).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(k)} ${n}`).join(' · ');
    host.innerHTML = `<p class="note" style="margin:0">${S.db.official.length} official cameras are loaded${areas ? ` (${areas})` : ''} and ${S.db.settings.officialCams ? 'included in your warnings' : 'turned off in Settings'}. Your own pins:</p>` +
      (mine.length ? mine.map((c) => `<div class="row c"><div class="main"><div class="ttl">${esc(c.name)}</div>
      <div class="meta">${esc(c.kind)} camera${c.limit ? ' · limit ' + c.limit + ' mph' : ''}${c.heading != null ? ' · catches ' + ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(c.heading / 45) % 8] + '-bound' : ''} · ${E.me ? fmtDist(dist(E.me, c)) + ' from you' : '<span class="mono">' + c.lat.toFixed(5) + ', ' + c.lng.toFixed(5) + '</span>'}</div></div>
      <div class="acts"><button class="sbtn" data-go="${c.id}">Map</button><button class="sbtn" data-ed="${c.id}">Edit</button><button class="sbtn danger" data-del="${c.id}">Delete</button></div></div>`).join('')
        : '<div class="empty">No pins of your own yet. Tap the red + and choose "Camera location" for any camera the official list misses.</div>');
  }
  const list = listKind === 'tickets' ? 'tickets' : 'cameras', arr = S.db[list];
  $$('[data-go]', host).forEach((b) => (b.onclick = () => { const x = arr.find((y) => y.id === b.dataset.go); go('map'); map.setView([x.lat, x.lng], 17); }));
  $$('[data-ed]', host).forEach((b) => (b.onclick = () => { const x = arr.find((y) => y.id === b.dataset.ed); list === 'tickets' ? ticketForm(x) : cameraForm(x); }));
  $$('[data-disp]', host).forEach((b) => (b.onclick = () => { S.disputeTicket = b.dataset.disp; go('dispute'); }));
  $$('[data-del]', host).forEach((b) => (b.onclick = () => confirmDel(b, () => removeLocal(list, b.dataset.del))));
}

// ---------------------------------------------------------------- Stats
export function renderStats() {
  const T = S.db.tickets, host = $('#statsBody');
  if (!T.length) { host.innerHTML = '<div class="card"><h2>Stats &amp; Insights</h2><div class="empty">Add a ticket to see your patterns here.</div></div>'; return; }
  const Sm = summary();
  const now = new Date(), months = [];
  for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push({ k: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), l: d.toLocaleString('en-US', { month: 'short' }), n: 0 }); }
  T.forEach((t) => { const m = months.find((m) => m.k === (t.date || '').slice(0, 7)); if (m) m.n++; });
  const mMax = Math.max(1, ...months.map((m) => m.n));
  const byLoc = [...group(T, (t) => streetKey(t.street))].map(([k, v]) => ({ k, n: v.length, total: v.reduce((s, x) => s + (x.fine || 0), 0), fine: v.reduce((s, x) => s + (x.fine || 0), 0) / v.length,
    spd: (() => { const s = v.filter((x) => x.speed); return s.length ? s.reduce((a, x) => a + x.speed, 0) / s.length : null; })() })).sort((a, b) => b.n - a.n || b.total - a.total);
  const byType = [...group(T, (t) => t.type)].map(([k, v]) => [k, v.length]).sort((a, b) => b[1] - a[1]);
  const hs = hotspots(), priciest = [...byLoc].sort((a, b) => b.fine - a.fine)[0];
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const byDay = [...group(T.filter((t) => t.date), (t) => days[new Date(t.date + 'T12:00').getDay()])].sort((a, b) => b[1].length - a[1].length)[0];
  const ins = [
    `Most expensive area: <b>${esc(priciest.k)}</b> (avg ${money(priciest.fine)})`,
    `You've been ticketed <b>${Sm.n}</b> time${Sm.n > 1 ? 's' : ''} for <b>${money(Sm.total)}</b> total`,
    Sm.avgSpd != null ? `Your average speed when ticketed: <b>${Math.round(Sm.avgSpd)} mph</b>` : null,
    Sm.avgOver != null ? `On average you were <b>${Math.round(Sm.avgOver)} mph over</b> the limit` : null,
    byDay && T.length > 1 ? `Most tickets land on a <b>${byDay[0]}</b> (${byDay[1].length})` : null,
    `Top type: <b>${esc(byType[0][0])}</b>`,
  ].filter(Boolean);
  host.innerHTML = `
   <div class="kpis">
     <div class="kpi"><small>Total tickets</small><b>${Sm.n}</b></div>
     <div class="kpi"><small>Total fines</small><b>${money(Sm.total)}</b></div>
     <div class="kpi"><small>Avg fine</small><b>${money(Sm.avgFine)}</b></div>
     <div class="kpi"><small>Avg speed</small><b>${Sm.avgSpd != null ? Math.round(Sm.avgSpd) + '<span class="unit"> mph</span>' : '—'}</b></div>
   </div>
   <div class="card"><h2>Key insights</h2><ul class="insights">${ins.map((i) => `<li>${i}</li>`).join('')}</ul></div>
   <div class="card"><h2>Tickets over time</h2>
     <div class="cols">${months.map((m) => `<div><em>${m.n || ''}</em><i class="${m.n ? '' : 'zero'}" style="height:${(m.n / mMax) * 100 || 0}%"></i></div>`).join('')}</div>
     <div class="colx">${months.map((m) => `<span>${m.l}</span>`).join('')}</div>
   </div>
   <div class="card"><h2>Tickets by location</h2>${barList(byLoc.slice(0, 8).map((x) => [x.k, x.n]), (v) => v + '')}</div>
   <div class="card"><h2>Tickets by type</h2>${barList(byType, (v) => v + '', 'var(--warn)')}</div>
   <div class="card"><h2>Fine &amp; speed by location</h2><div class="scroll"><table class="tbl">
     <thead><tr><th>Location</th><th class="n">Tickets</th><th class="n">Avg fine ($)</th><th class="n">Avg speed (mph)</th></tr></thead>
     <tbody>${byLoc.map((x) => `<tr><td>${esc(x.k)}</td><td class="n">${x.n}</td><td class="n">${Math.round(x.fine)}</td><td class="n">${x.spd != null ? Math.round(x.spd) : '—'}</td></tr>`).join('')}</tbody></table></div></div>
   <div class="card"><h2>Ticket hotspots</h2><div class="sec">${hs.slice(0, 6).map((h) => `<div class="row t"><div class="main"><div class="ttl">${esc(h.name)}</div><div class="meta">${h.count} ticket${h.count > 1 ? 's' : ''} within 250 m · ${money(h.total)}</div></div><div class="acts"><button class="sbtn" data-hs="${h.lat},${h.lng}">Map</button></div></div>`).join('')}</div></div>`;
  $$('[data-hs]', host).forEach((b) => (b.onclick = () => { const [a, c] = b.dataset.hs.split(',').map(Number); go('map'); map.setView([a, c], 16); }));
}

// ---------------------------------------------------------------- routing
function nearRoute(pt, line) { let best = Infinity, idx = 0; for (let i = 0; i < line.length - 1; i++) { const d = segDist(pt, line[i], line[i + 1]); if (d < best) { best = d; idx = i; } } return { d: best, idx }; }
export async function analyzeRoute(A, B) {
  let line = null, meters = null, secs = null, fallback = false;
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${A.lng},${A.lat};${B.lng},${B.lat}?overview=full&geometries=geojson`);
    const js = await r.json(); const rt = js.routes && js.routes[0];
    if (rt) { line = rt.geometry.coordinates.map((c) => ({ lat: c[1], lng: c[0] })); meters = rt.distance; secs = rt.duration; }
  } catch { /* fall back to a straight line */ }
  if (!line) { fallback = true; line = [{ lat: A.lat, lng: A.lng }, { lat: B.lat, lng: B.lng }]; meters = dist(A, B); }
  const cum = [0]; for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + dist(line[i - 1], line[i]));
  const hits = [], W = fallback ? 400 : 60;
  allCameras().forEach((c) => { const n = nearRoute(c, line); if (n.d <= W) hits.push({ k: 'c', at: cum[n.idx], title: c.name, sub: `${c.kind} camera${c.limit ? ' · limit ' + c.limit : ''}` }); });
  S.db.tickets.forEach((t) => { const n = nearRoute(t, line); if (n.d <= Math.max(W, 120)) hits.push({ k: 't', at: cum[n.idx], title: streetKey(t.street), sub: `You got a ${String(t.type).toLowerCase()} ticket here${t.fine ? ' · ' + money(t.fine) : ''}` }); });
  activeReports().forEach((r) => { const n = nearRoute(r, line); if (n.d <= Math.max(W, 150)) hits.push({ k: 'r', at: cum[n.idx], title: r.type, sub: ago(r.time) + (r.note ? ' · ' + r.note : '') }); });
  hits.sort((a, b) => a.at - b.at);
  return { line, meters, secs, fallback, hits };
}
export const gmaps = (A, B) => `https://www.google.com/maps/dir/?api=1&origin=${A.lat},${A.lng}&destination=${B.lat},${B.lng}&travelmode=driving`;
export function drawRoute(res, A, B) {
  layers.route.clearLayers();
  const poly = L.polyline(res.line.map((p) => [p.lat, p.lng]), { color: res.hits.length ? '#d42a2a' : '#18804f', weight: 6, opacity: 0.8, dashArray: res.fallback ? '8 8' : null }).addTo(layers.route);
  L.circleMarker([A.lat, A.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#1d6cf0', fillOpacity: 1 }).addTo(layers.route);
  L.circleMarker([B.lat, B.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#13202b', fillOpacity: 1 }).addTo(layers.route);
  return poly;
}
export function routeReport(res, A, B, extra) {
  const alt = res.hits.length && S.db.profile.avoidRisk === 'alt';
  return `<div class="card"><h2>${res.hits.length ? res.hits.length + ' risk point' + (res.hits.length > 1 ? 's' : '') + ' on this route' : 'Clear route'}</h2>
    <p class="note" style="margin:0 0 12px">${fmtDist(res.meters)}${res.secs ? ' · about ' + Math.round(res.secs / 60) + ' min' : ''}${res.fallback ? ' · straight-line check (routing service unreachable), so this is approximate' : ''}</p>
    ${alt ? '<div class="privacy">You asked to see alternatives. Open Google Maps below and compare the other suggested routes against these spots.</div>' : ''}
    ${res.hits.length ? `<div class="sec">${res.hits.map((h) => `<div class="row ${h.k}"><div class="main"><div class="ttl">${esc(h.title)}</div><div class="meta">${esc(h.sub)} · ${fmtDist(h.at)} into the trip</div></div></div>`).join('')}</div>` : '<div class="empty">None of your ticket spots, known cameras or recent reports sit on this route.</div>'}
    <div class="btns" style="margin-top:12px"><button class="btn" data-rtmap>Show on map</button>${extra || ''}<a class="btn primary" href="${gmaps(A, B)}" target="_blank" rel="noopener">Open in Google Maps</a></div>
    <p class="note" style="margin:10px 0 0">Turn on <b>Start drive</b> too, so the warnings fire while you navigate.</p></div>`;
}

export const rS = {}, rE = {};
let routeShown = false;
export function setupRouteTab() {
  locWidget($('#routeStart'), rS, 'Starting point');
  locWidget($('#routeEnd'), rE, 'Destination');
  $('#routeGo').onclick = async () => {
    if (rS.lat == null || rE.lat == null) { toast('Set both a start and a destination'); return; }
    routeShown = true;
    const out = $('#routeOut'); out.innerHTML = '<div class="card note"><div class="spinner"></div> Checking the route…</div>';
    const res = await analyzeRoute(rS, rE);
    const poly = drawRoute(res, rS, rE);
    out.innerHTML = routeReport(res, rS, rE, '<button class="btn" data-rtsave>Save route</button>');
    out.querySelector('[data-rtmap]').onclick = () => { go('map'); setTimeout(() => map.fitBounds(poly.getBounds(), { padding: [40, 40] }), 80); };
    out.querySelector('[data-rtsave]').onclick = () => bus.emit('save-route', { start: { ...rS }, end: { ...rE } }, res);
  };
}
export function renderRouteTab() {
  if (routeShown) return;
  const hs = hotspots();
  $('#routeOut').innerHTML = `<div class="card"><h2>High-risk zones</h2>${hs.length ? `<div class="sec">${hs.slice(0, 5).map((h) => `<div class="row t"><div class="main"><div class="ttl">${esc(h.name)}</div><div class="meta">${h.count} ticket${h.count > 1 ? 's' : ''} · ${money(h.total)} in fines</div></div></div>`).join('')}</div>` : '<div class="empty">No high-risk zones identified yet. They appear once you log tickets.</div>'}</div>`;
}

// ---------------------------------------------------------------- More
export function renderMore(PAGES) {
  const groups = {};
  Object.entries(PAGES).filter(([, p]) => p.g).forEach(([k, p]) => { (groups[p.g] = groups[p.g] || []).push([k, p]); });
  $('#moreBody').innerHTML = `<div class="pagehead"><div><h2>More</h2><p>${S.user ? 'Signed in as ' + esc(S.user.email) : 'Not signed in · data stays on this phone'}</p></div></div>` +
    Object.entries(groups).map(([g, items]) => `<div class="grouplbl">${g}</div><div class="morelist">${items.map(([k, p]) => `<button data-go="${k}"><span class="ic">${p.e}</span><span><b>${p.t}</b><small>${p.d}</small></span></button>`).join('')}</div>`).join('');
  $$('#moreBody [data-go]').forEach((b) => (b.onclick = () => go(b.dataset.go)));
}
