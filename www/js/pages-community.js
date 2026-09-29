// Community Map, Reporting Feed, My Contributions, Risk Heatmap.
import { S, save, activeReports, reportLive, upsertLocal, queue } from './store.js';
import { $, $$, esc, dist, fmtDist, ago, stamp, fineRange, streetKey, DC, toast, copyText } from './util.js';
import { TILE, ATTR, rcat, reportIcon, reportPopup, youIcon } from './mapview.js';
import { E } from './engine.js';
import { pageHead, bindBack, reportForm, confirmDel, go } from './ui.js';
import { loadCommunity, vote, flush } from './cloud.js';

export const CGROUPS = [['police', '🚓 Police & officers'], ['emergency', '🚑 Accidents & emergency'], ['ice', '🚨 ICE activity'], ['hazard', '🚧 Road hazards'], ['camera', '📷 New cameras'], ['hotspot', '⚠️ Ticket hotspots'], ['other', '📣 Other']];

/** Shared ticket hotspots: from everyone (server) or just yours (offline). */
function sharedHotspots() {
  if (S.cloud && S.db.communityAt) return S.db.hotspots.map((h) => ({ ...h, fine: h.fine_range }));
  return S.db.tickets.filter((t) => t.shared).map((t) => ({ id: t.id, lat: Math.round(t.lat * 1000) / 1000, lng: Math.round(t.lng * 1000) / 1000,
    street: streetKey(t.street), type: t.type, month: (t.date || '').slice(0, 7), fine: fineRange(t.fine), mine: true }));
}

// ---------------------------------------------------------------- Community map
let cmap = null, cLayer = null;
const cOn = new Set(CGROUPS.map((g) => g[0]));
export function renderCommunityMap() {
  if (!cmap) {
    cmap = L.map('cmap', { zoomControl: false }).setView(DC, 12);
    L.tileLayer(TILE, { maxZoom: 19, attribution: ATTR }).addTo(cmap);
    cLayer = L.layerGroup().addTo(cmap);
    $('#cmapFab').onclick = () => reportForm();
  }
  $('#cmapChips').innerHTML = '<button data-back class="chipback">← More</button>' + CGROUPS.map(([k, l]) => `<button data-g="${k}" aria-pressed="${cOn.has(k)}">${l}</button>`).join('');
  $$('#cmapChips [data-g]').forEach((b) => (b.onclick = () => { cOn.has(b.dataset.g) ? cOn.delete(b.dataset.g) : cOn.add(b.dataset.g); renderCommunityMap(); }));
  $('#cmapChips [data-back]').onclick = () => go('more');
  cLayer.clearLayers();
  const live = activeReports().filter((r) => cOn.has(rcat(r.type).g));
  live.forEach((r) => {
    const fresh = Date.now() - r.time < 30 * 60000;
    L.circle([r.lat, r.lng], { radius: fresh ? 220 : 140, color: rcat(r.type).c, weight: 1, fillOpacity: fresh ? 0.18 : 0.08 }).addTo(cLayer);
    L.marker([r.lat, r.lng], { icon: reportIcon(r) }).bindPopup(reportPopup(r)).addTo(cLayer);
  });
  let shared = 0;
  if (cOn.has('hotspot')) sharedHotspots().forEach((h) => {
    shared++;
    L.circle([h.lat, h.lng], { radius: 180, color: '#d42a2a', weight: 1, fillOpacity: 0.2 })
      .bindPopup(`<b>Ticket hotspot</b><br>${esc(h.street)}<br>${esc(h.type)} · ${esc(h.month || '')} · fine ${esc(h.fine)}`).addTo(cLayer);
  });
  if (E.me) L.marker([E.me.lat, E.me.lng], { icon: youIcon(), interactive: false }).addTo(cLayer);
  $('#cmapNote').innerHTML = `<b>${live.length} live report${live.length === 1 ? '' : 's'}</b> (last 6 hours) · ${shared} shared hotspot${shared === 1 ? '' : 's'} · ` +
    (S.cloud ? 'updates every 20 seconds from every driver. Tap a report to confirm it.' : 'shows your own reports only. Sign in to see everyone\'s.');
  setTimeout(() => cmap.invalidateSize(), 50);
}
export const communityMap = () => cmap;

// ---------------------------------------------------------------- Feed
let feedFilter = 'all';
export function renderFeed() {
  const host = $('#p-feed');
  const reps = S.cloud && S.db.communityAt ? S.db.community : S.db.reports;
  const items = [...reps.map((r) => ({ t: r.time, kind: 'r', r })), ...sharedHotspots().map((h) => ({ t: h.month ? Date.parse(h.month + '-15') : 0, kind: 'h', h }))]
    .filter((i) => feedFilter === 'all' || (i.kind === 'h' ? feedFilter === 'hotspot' : rcat(i.r.type).g === feedFilter))
    .sort((a, b) => b.t - a.t).slice(0, 200);
  host.innerHTML = `${pageHead('Reporting Feed', S.cloud ? 'Latest reports from drivers, newest first' : 'Your reports, newest first. Sign in to see everyone\'s.')}
    <div class="seg"><button data-f="all" aria-pressed="${feedFilter === 'all'}">All</button>${CGROUPS.map(([k, l]) => `<button data-f="${k}" aria-pressed="${feedFilter === k}">${l}</button>`).join('')}</div>
    <div class="btns"><button class="btn red" data-new>Report a sighting</button>${S.cloud ? '<button class="btn" data-refresh>Refresh</button>' : ''}</div>
    <div class="sec">${items.length ? items.map((i) => {
      if (i.kind === 'h') return `<div class="row t"><span class="emo">⚠️</span><div class="main"><div class="ttl">Ticket hotspot · ${esc(i.h.type)}</div><div class="meta">${esc(i.h.month || '')} · fine ${esc(i.h.fine)} · near ${esc(i.h.street)}</div></div></div>`;
      const r = i.r, live = reportLive(r);
      const voteable = S.cloud && !r.mine && live && r.status === 'live';
      return `<div class="row r" style="border-left-color:${rcat(r.type).c};${live ? '' : 'opacity:.6'}"><span class="emo">${rcat(r.type).e}</span><div class="main">
        <div class="ttl">${esc(r.type)}${r.status === 'pending' ? '<span class="tag">Being checked</span>' : live ? '<span class="tag live">Live</span>' : '<span class="tag">Expired</span>'}${r.confirms ? `<span class="tag">${r.confirms} confirmed</span>` : ''}</div>
        <div class="meta">${stamp(r.time)} · ${ago(r.time)}${E.me ? ' · ' + fmtDist(dist(E.me, r)) + ' away' : ''}</div>${r.note ? `<div class="meta">${esc(r.note)}</div>` : ''}</div>
        <div class="acts">${voteable ? `<button class="sbtn" data-v="1" data-id="${r.id}"${r.myVote === 1 ? ' disabled' : ''}>Still there</button><button class="sbtn" data-v="-1" data-id="${r.id}"${r.myVote === -1 ? ' disabled' : ''}>Gone</button>` : ''}<button class="sbtn" data-map="${r.id}">Map</button><button class="sbtn" data-sh="${r.id}">Share</button></div></div>`;
    }).join('') : '<div class="empty">No sightings reported yet. Tap "Report a sighting" when you spot something.</div>'}</div>`;
  $$('[data-f]', host).forEach((b) => (b.onclick = () => { feedFilter = b.dataset.f; renderFeed(); }));
  host.querySelector('[data-new]').onclick = () => reportForm();
  host.querySelector('[data-refresh]')?.addEventListener('click', () => loadCommunity().then(() => toast('Updated')));
  $$('[data-v]', host).forEach((b) => (b.onclick = () => { b.disabled = true; vote(b.dataset.id, +b.dataset.v); }));
  $$('[data-sh]', host).forEach((b) => (b.onclick = () => share(reps.find((r) => r.id === b.dataset.sh))));
  $$('[data-map]', host).forEach((b) => (b.onclick = () => { const r = reps.find((x) => x.id === b.dataset.map); go('community-map'); setTimeout(() => cmap.setView([r.lat, r.lng], 16), 80); }));
  bindBack(host);
}
function shareText(r) {
  const where = r.place && r.place !== 'My location' && r.place !== 'Pinned on map' ? r.place : 'this spot';
  return `${rcat(r.type).e} ${r.type} near ${where} (${ago(r.time)})${r.note ? ': ' + r.note : ''}\nhttps://www.google.com/maps?q=${r.lat},${r.lng}\n— via Ticket Radar DC`;
}
async function share(r) {
  const text = shareText(r);
  try { if (navigator.share) { await navigator.share({ text }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
  copyText(text);
}

// ---------------------------------------------------------------- My contributions
export function renderContrib() {
  const host = $('#p-contrib');
  const reps = S.db.reports.filter((r) => r.mine), sh = S.db.tickets.filter((t) => t.shared);
  const statusTag = (r) => {
    if (r.status === 'hidden') return `<span class="tag bad">Hidden</span>`;
    if (r.status === 'merged') return `<span class="tag">Merged into an existing report</span>`;
    if (r.status === 'pending') return `<span class="tag">Being checked</span>`;
    return reportLive(r) ? '<span class="tag live">Live</span>' : '<span class="tag">Expired</span>';
  };
  host.innerHTML = `${pageHead('My Contributions', 'Everything you have posted to the community')}
    <div class="card"><h2>Sightings (${reps.length})</h2><div class="sec">${reps.length ? reps.map((r) => `<div class="row r" style="border-left-color:${rcat(r.type).c}"><span class="emo">${rcat(r.type).e}</span><div class="main"><div class="ttl">${esc(r.type)}${statusTag(r)}</div>
      <div class="meta">${stamp(r.time)}${r.edited ? ' · edited' : ''}${r.note ? ' · ' + esc(r.note) : ''}</div>${r.status === 'hidden' && r.reason ? `<div class="meta">Why: ${esc(r.reason)}</div>` : ''}${r.confirms ? `<div class="meta">${r.confirms} driver${r.confirms > 1 ? 's' : ''} confirmed it</div>` : ''}</div>
      <div class="acts"><button class="sbtn" data-ed="${r.id}">Edit</button><button class="sbtn danger" data-del="${r.id}">Delete</button></div></div>`).join('') : '<div class="empty">You haven\'t posted any sightings yet.</div>'}</div></div>
    <div class="card"><h2>Shared ticket hotspots (${sh.length})</h2><div class="sec">${sh.length ? sh.map((t) => `<div class="row t"><div class="main"><div class="ttl">${esc(streetKey(t.street))}</div>
      <div class="meta">Others see: ${esc(t.type)} · ${esc((t.date || '').slice(0, 7))} · fine ${fineRange(t.fine)} · location rounded to about 100 m</div></div>
      <div class="acts"><button class="sbtn danger" data-un="${t.id}">Stop sharing</button></div></div>`).join('') : '<div class="empty">None shared. Turn on "Share anonymized" on a ticket to add it here.</div>'}</div></div>`;
  $$('[data-ed]', host).forEach((b) => (b.onclick = () => reportForm(S.db.reports.find((r) => r.id === b.dataset.ed))));
  $$('[data-del]', host).forEach((b) => (b.onclick = () => confirmDel(b, () => {
    S.db.reports = S.db.reports.filter((r) => r.id !== b.dataset.del);
    S.db.community = S.db.community.filter((r) => r.id !== b.dataset.del);
    queue('reports', 'delete', { id: b.dataset.del }); flush(); save();
  })));
  $$('[data-un]', host).forEach((b) => (b.onclick = () => { const t = S.db.tickets.find((x) => x.id === b.dataset.un); upsertLocal('tickets', { ...t, shared: false }); toast('No longer shared'); }));
  bindBack(host);
}

// ---------------------------------------------------------------- Risk heatmap
let hmap = null, hLayer = null;
const hOn = { tickets: true, shared: true, reports: true, cameras: true };
export function renderHeat() {
  if (!hmap) {
    hmap = L.map('hmap', { zoomControl: false }).setView([38.95, -77.12], 10);
    L.tileLayer(TILE, { maxZoom: 19, attribution: ATTR }).addTo(hmap);
    hLayer = L.layerGroup().addTo(hmap);
  }
  $('#hmapChips').innerHTML = '<button data-back class="chipback">← More</button>' +
    [['tickets', '⚠️ My tickets'], ['shared', '👥 Shared tickets'], ['reports', '📣 Reports'], ['cameras', '📷 Cameras']].map(([k, l]) => `<button data-h="${k}" aria-pressed="${hOn[k]}">${l}</button>`).join('') +
    '<button data-zoom="dc">DC</button><button data-zoom="md">Maryland</button><button data-zoom="dmv">DMV region</button>';
  $$('#hmapChips [data-h]').forEach((b) => (b.onclick = () => { hOn[b.dataset.h] = !hOn[b.dataset.h]; renderHeat(); }));
  $('#hmapChips [data-back]').onclick = () => go('more');
  $('#hmapChips [data-zoom="dc"]').onclick = () => hmap.setView(DC, 12);
  $('#hmapChips [data-zoom="md"]').onclick = () => hmap.fitBounds([[37.9, -79.49], [39.72, -75.05]]);
  $('#hmapChips [data-zoom="dmv"]').onclick = () => hmap.setView([38.95, -77.12], 9);
  hLayer.clearLayers();
  const pts = [];
  if (hOn.tickets) S.db.tickets.forEach((t) => pts.push([t.lat, t.lng, Math.min(1, 0.55 + (t.fine || 0) / 400)]));
  if (hOn.shared) sharedHotspots().filter((h) => !h.mine).forEach((h) => pts.push([h.lat, h.lng, 0.6]));
  if (hOn.reports) (S.cloud ? S.db.community : S.db.reports).forEach((r) => { const age = (Date.now() - r.time) / 86400000; pts.push([r.lat, r.lng, Math.max(0.2, 0.7 - age * 0.05)]); });
  if (hOn.cameras) [...S.db.cameras, ...S.db.official].forEach((c) => pts.push([c.lat, c.lng, 0.5]));
  if (L.heatLayer) L.heatLayer(pts, { radius: 26, blur: 20, maxZoom: 15, minOpacity: 0.35, gradient: { 0.3: '#2f9e44', 0.55: '#fab005', 0.8: '#f76707', 1: '#e03131' } }).addTo(hLayer);
  else pts.forEach((p) => L.circle([p[0], p[1]], { radius: 400, stroke: false, fillColor: '#e03131', fillOpacity: 0.15 + p[2] * 0.2 }).addTo(hLayer));
  $('#hmapNote').innerHTML = `<b>${pts.length} data point${pts.length === 1 ? '' : 's'}</b> · green = low, red = high concentration. Tickets weigh more the higher the fine; reports fade as they age.`;
  setTimeout(() => hmap.invalidateSize(), 50);
}
