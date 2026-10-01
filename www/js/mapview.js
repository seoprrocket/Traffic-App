// The home map: markers for tickets, cameras, community reports, and you.
import { S, sens, activeReports } from './store.js';
import { esc, money, ago, DC, headingName, bus } from './util.js';
import { carSvg } from './cars.js';

export const TILE = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const ATTR = '© OpenStreetMap';

export { RCAT, RTYPES, rcat } from './reports.js';
import { rcat } from './reports.js';

export const pin = (color, emoji) => L.divIcon({ className: '', html: `<div class="m-pin" style="background:${color}"><span>${emoji}</span></div>`, iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -30] });
export const icons = { parkTicket: pin('#7a3fd1', '🅿️'), ticket: pin('#d42a2a', '⚠️'), camera: pin('#d99100', '📷'), temp: pin('#1d6cf0', '📍') };
export const reportIcon = (r) => { const c = rcat(r.type); return pin(c.c, c.e); };
const carStyle = () => S.db.settings.carStyle || 'dot';
export const youIcon = () => {
  const st = carStyle();
  if (st === 'dot') return L.divIcon({ className: '', html: '<div class="m-you"><i></i></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
  return L.divIcon({ className: '', html: `<div class="m-car">${carSvg(st, S.db.settings.carColor || '#f4f5f7', 46)}</div>`, iconSize: [46, 46], iconAnchor: [23, 23] });
};

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
    const pk = /^parking/i.test(t.type || '');
    if (!pk) L.circle([t.lat, t.lng], { radius: rr, color: '#d42a2a', weight: 1, fillOpacity: 0.08, renderer: canvas }).addTo(layers.tickets);
    L.marker([t.lat, t.lng], { icon: pk ? icons.parkTicket : icons.ticket }).bindPopup(`<b>${esc(t.street)}</b><br>${esc(t.type)}${t.violation ? ': ' + esc(t.violation) : ''} · ${esc(t.date)}<br>${t.fine ? money(t.fine) : ''}${t.speed ? ' · ' + t.speed + ' mph' : ''}${t.limit ? ' in a ' + t.limit : ''}`).addTo(layers.tickets);
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

let meMarker = null, lastMe = null, lastHeading = null;
export function placeMe(p) {
  lastMe = p;
  if (p.heading != null && !Number.isNaN(p.heading)) lastHeading = p.heading;
  if (!meMarker) meMarker = L.marker([p.lat, p.lng], { icon: youIcon(), zIndexOffset: 1000, interactive: false }).addTo(map);
  else meMarker.setLatLng([p.lat, p.lng]);
  const root = meMarker.getElement();
  const el = root?.querySelector('.m-you i');
  if (el) { el.style.display = lastHeading == null ? 'none' : 'block'; if (lastHeading != null) el.style.transform = `rotate(${lastHeading}deg)`; }
  const car = root?.querySelector('.m-car');
  if (car) car.style.transform = `rotate(${lastHeading ?? 0}deg)`;     // the car keeps pointing the way you last moved
}
/** After the car style changes in Settings. */
export function refreshMe() { if (meMarker) { meMarker.setIcon(youIcon()); if (lastMe) placeMe(lastMe); } }

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
