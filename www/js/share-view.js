// The page people open from a "Share drive" link. Polls the share every 10 seconds.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (t) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const token = location.hash.slice(1);

const map = L.map('map', { zoomControl: false }).setView([38.9, -77.03], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
let car = null, dest = null, fitted = false, timer = null;

function ago(t) { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${Math.max(1, s)} s ago` : `${Math.round(s / 60)} min ago`; }

async function poll() {
  if (!/^[A-Za-z0-9_-]{8,20}$/.test(token)) return ended('This link is incomplete. Ask for it to be sent again.');
  let d;
  try {
    const r = await fetch('/api/share?t=' + encodeURIComponent(token), { cache: 'no-store' });
    if (r.status === 404) return ended('This drive has ended.');
    if (!r.ok) throw new Error();
    d = await r.json();
  } catch { $('#meta').textContent = 'Connection lost. Trying again…'; return; }

  document.title = `${d.name} · live drive`;
  if (d.ended) {
    $('#who').textContent = `${d.name} ${d.arrived ? 'has arrived at' : 'stopped sharing their drive to'} ${d.destLabel || 'their destination'}`;
    $('#eta').textContent = d.arrived ? 'Arrived' : 'Sharing stopped';
    $('#eta').className = 'eta done';
    $('#meta').textContent = `at ${clock(d.updatedAt)}`;
    clearInterval(timer);
  } else {
    const left = d.eta ? Math.max(0, Math.round((d.eta - Date.now()) / 60000)) : null;
    $('#who').innerHTML = `${esc(d.name)} is driving to <b>${esc(d.destLabel || 'their destination')}</b>`;
    $('#eta').textContent = d.eta ? `Arriving ~${clock(d.eta)}` : 'On the way';
    const late = d.arriveBy && d.eta && d.eta > d.arriveBy + 60000;
    $('#meta').innerHTML = `${left != null ? `${left} min away · ` : ''}${late ? `<span class="bad">${Math.round((d.eta - d.arriveBy) / 60000)} min behind schedule</span> · ` : ''}updated ${ago(d.updatedAt)}`;
  }
  if (d.dest && !dest) dest = L.marker([d.dest.lat, d.dest.lng], { icon: L.divIcon({ className: '', html: '<div class="dest">🏁</div>', iconSize: [26, 26], iconAnchor: [4, 24] }) }).addTo(map);
  if (d.lat != null) {
    if (!car) car = L.marker([d.lat, d.lng], { icon: L.divIcon({ className: '', html: '<div class="car"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(map);
    else car.setLatLng([d.lat, d.lng]);
    if (!fitted) { fitted = true; const pts = [[d.lat, d.lng]]; if (d.dest) pts.push([d.dest.lat, d.dest.lng]); map.fitBounds(pts, { padding: [60, 60], maxZoom: 15 }); }
  }
}
function ended(msg) { $('#who').textContent = msg; $('#eta').textContent = ''; $('#meta').textContent = ''; clearInterval(timer); }

poll();
timer = setInterval(poll, 10000);
