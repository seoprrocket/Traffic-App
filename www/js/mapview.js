// The home map: markers for tickets, cameras, community reports, and you.
import { S, sens, activeReports } from './store.js';
import { esc, money, ago, DC, headingName, bus } from './util.js';

export const TILE = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const ATTR = '© OpenStreetMap';

export const RCAT = {
  'Speed trap / police': { e: '🚓', g: 'police', c: '#3b5bdb' },
  'Officer location': { e: '👮', g: 'police', c: '#3b5bdb' },
  'Immigration enforcement (ICE)': { e: '🚨', g: 'ice', c: '#c2255c' },
  'Checkpoint': { e: '🛑', g: 'police', c: '#3b5bdb' },
  'New camera': { e: '📷', g: 'camera', c: '#d99100' },
  'Ticket hotspot': { e: '⚠️', g: 'hotspot', c: '#d42a2a' },
  'Icy road': { e: '🧊', g: 'hazard', c: '#1690b0' },
  'Road hazard': { e: '🚧', g: 'hazard', c: '#e8590c' },
  'Other': { e: '📣', g: 'other', c: '#7447d1' },
};
export const RTYPES = Object.keys(RCAT);
export const rcat = (t) => RCAT[t] || RCAT.Other;

export const pin = (color, emoji) => L.divIcon({ className: '', html: `<div class="m-pin" style="background:${color}"><span>${emoji}</span></div>`, iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -30] });
export const icons = { ticket: pin('#d42a2a', '⚠️'), camera: pin('#d99100', '📷'), temp: pin('#1d6cf0', '📍') };
export const reportIcon = (r) => { const c = rcat(r.type); return pin(c.c, c.e); };
export const youIcon = () => L.divIcon({ className: '', html: '<div class="m-you"><i></i></div>', iconSize: [22, 22], iconAnchor: [11, 11] });

export const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView(DC, 13);
L.tileLayer(TILE, { maxZoom: 19, attribution: ATTR }).addTo(map);
export const layers = {
  official: L.layerGroup().addTo(map), tickets: L.layerGroup().addTo(map), cameras: L.layerGroup().addTo(map),
  reports: L.layerGroup().addTo(map), route: L.layerGroup().addTo(map), temp: L.layerGroup().addTo(map),
};
const canvas = L.canvas({ padding: 0.5 });

export function reportPopup(r) {
  const voteable = S.cloud && !r.mine && r.status !== 'pending';
  return `<b>${esc(r.type)}</b>${r.status === 'pending' ? ' <small>(being checked)</small>' : ''}<br>${esc(r.note || '')}
    <br><small>${ago(r.time)}${r.confirms ? ` · ${r.confirms} confirmed` : ''}</small>
    ${voteable ? `<div class="popbtns"><button data-vote="1" data-id="${r.id}"${r.myVote === 1 ? ' disabled' : ''}>Still there</button><button data-vote="-1" data-id="${r.id}"${r.myVote === -1 ? ' disabled' : ''}>Gone</button></div>` : ''}`;
}
export function cameraPopup(c) {
  return `<b>${esc(c.name)}</b><br>${esc(c.kind)} camera${c.limit ? ' · limit ' + c.limit + ' mph' : ''}<br>
    <small>${c.official ? (c.verified ? 'Official list' : 'From county website, not yet verified') + (c.jurisdiction ? ' · ' + esc(c.jurisdiction) : '') : 'Your pin · drag to adjust'}
    ${c.heading != null ? ' · enforces ' + headingName(c.heading) : ''}</small>`;
}

export function drawMarkers() {
  Object.values(layers).forEach((l) => { if (l !== layers.route && l !== layers.temp) l.clearLayers(); });
  const rr = S.db.settings.ticketRadius * sens().f;
  S.db.tickets.forEach((t) => {
    L.circle([t.lat, t.lng], { radius: rr, color: '#d42a2a', weight: 1, fillOpacity: 0.08, renderer: canvas }).addTo(layers.tickets);
    L.marker([t.lat, t.lng], { icon: icons.ticket }).bindPopup(`<b>${esc(t.street)}</b><br>${esc(t.type)} · ${esc(t.date)}<br>${t.fine ? money(t.fine) : ''}${t.speed ? ' · ' + t.speed + ' mph' : ''}${t.limit ? ' in a ' + t.limit : ''}`).addTo(layers.tickets);
  });
  S.db.cameras.forEach((c) => {
    const m = L.marker([c.lat, c.lng], { icon: icons.camera, draggable: true }).bindPopup(cameraPopup(c)).addTo(layers.cameras);
    m.on('dragend', (e) => { const p = e.target.getLatLng(); bus.emit('camera-moved', c.id, +p.lat.toFixed(6), +p.lng.toFixed(6)); });
  });
  if (S.db.settings.officialCams) {
    S.db.official.forEach((c) => {
      L.circleMarker([c.lat, c.lng], { radius: 6, color: '#fff', weight: 1.5, fillColor: c.verified ? '#d99100' : '#b08a3a', fillOpacity: 0.95, renderer: canvas })
        .bindPopup(cameraPopup(c)).addTo(layers.official);
    });
  }
  activeReports().forEach((r) => L.marker([r.lat, r.lng], { icon: reportIcon(r) }).bindPopup(reportPopup(r)).addTo(layers.reports));
}

let meMarker = null;
export function placeMe(p) {
  if (!meMarker) meMarker = L.marker([p.lat, p.lng], { icon: youIcon(), zIndexOffset: 1000, interactive: false }).addTo(map);
  else meMarker.setLatLng([p.lat, p.lng]);
  const el = meMarker.getElement()?.querySelector('.m-you i');
  if (el) { el.style.display = p.heading == null ? 'none' : 'block'; if (p.heading != null) el.style.transform = `rotate(${p.heading}deg)`; }
}

export function fitAll(me) {
  const pts = [...S.db.tickets, ...S.db.cameras, ...activeReports()].map((p) => [p.lat, p.lng]);
  if (me) pts.push([me.lat, me.lng]);
  if (pts.length) map.fitBounds(pts, { padding: [50, 50], maxZoom: 15 }); else map.setView(DC, 13);
}

// Vote buttons inside popups
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-vote]');
  if (b) { b.disabled = true; bus.emit('vote', b.dataset.id, +b.dataset.vote); }
});
