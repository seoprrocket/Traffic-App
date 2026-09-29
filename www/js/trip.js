// Plan a Drive (traffic, leave-by time, saved trips), the live ETA bar, arrival, and Share drive.
import { S, persist, save } from './store.js';
import { $, $$, esc, dist, fmtDist, toast, uuid, bus, download, copyText } from './util.js';
import { map } from './mapview.js';
import { E, raise, startDrive } from './engine.js';
import { locateOnce } from './native.js';
import { locWidget, geoFail, busy, confirmDel, go } from './ui.js';
import { analyzeRoute, drawRoute, hotspots } from './pages-main.js';
import { apiStatus, api, creds, pushTrip, unpushTrip, pushState } from './netlify.js';

const MIN = 60000;
const clock = (t) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dayClock = (t) => {
  const d = new Date(t), today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
  const day = d.toDateString() === today.toDateString() ? 'today' : d.toDateString() === tomorrow.toDateString() ? 'tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return `${clock(t)} ${day}`;
};
const mins = (s) => Math.max(1, Math.round(s / 60));
const until = (t) => {
  const m = Math.round((t - Date.now()) / MIN);
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return `in ${h} h${r ? ' ' + r + ' min' : ''}`;
};
export const googleNav = (dest) => `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}&travelmode=driving&dir_action=navigate`;

// ---------------------------------------------------------------- planning
/** Traffic-aware plan from the Netlify function, or a typical-time estimate from OSRM. */
export async function planDrive({ start, end, arriveBy = null, buffer = 5 }) {
  const routeP = analyzeRoute(start, end);
  let p = null;
  try {
    const st = await apiStatus();
    if (st.ok) p = await api('traffic', { start, end, arriveBy, buffer });
  } catch { /* fall back below */ }
  const route = await routeP;
  if (!p) {
    const secs = Math.round((route.secs || route.meters / 13) * 1.2);
    const leave = arriveBy ? Math.floor((arriveBy - buffer * MIN - secs * 1000) / MIN) * MIN : null;
    p = { traffic: false, source: 'local', meters: route.meters, nowSecs: secs, staticSecs: route.secs, level: null, arriveBy,
      leaveAt: leave ? Math.max(leave, Math.floor(Date.now() / MIN) * MIN) : null, late: !!leave && leave < Date.now(),
      lateMin: leave && leave < Date.now() ? Math.round((Date.now() - leave) / MIN) : 0, samples: [] };
  }
  return { ...p, route };
}

// ---------------------------------------------------------------- Drive tab
const form = { start: {}, end: {}, arriveBy: '', buffer: 5, name: '' };
let lastPlan = null, built = false;

export function renderDrive() {
  const host = $('#p-drive');
  if (!built) {
    built = true;
    host.innerHTML = `
      <div class="card sec" id="dv-form">
        <h2>Plan a Drive</h2>
        <div class="loc" id="dv-end"></div>
        <div class="loc" id="dv-start"></div>
        <div class="grid2">
          <label class="f">Arrive by (optional)<input type="datetime-local" id="dv-arrive"></label>
          <label class="f">Extra time<select id="dv-buffer"><option value="0">None</option><option value="5" selected>5 min</option><option value="10">10 min</option><option value="15">15 min</option><option value="30">30 min</option></select></label>
        </div>
        <label class="f">Name (optional)<input type="text" id="dv-name" maxlength="80" placeholder="Dentist, Work, Airport…"></label>
        <button class="btn primary" id="dv-go">Check this drive</button>
      </div>
      <div id="dv-out" class="sec"></div>
      <div class="sec" id="dv-trips"></div>
      <div id="dv-risk"></div>`;
    locWidget($('#dv-end'), form.end, 'Where to?');
    locWidget($('#dv-start'), form.start, 'Starting from', null);
    if (E.me) setStartHere(E.me);
    else locateOnce().then(setStartHere).catch(() => {});
    $('#dv-go').onclick = checkDrive;
  }
  renderTrips(); renderRisk();
}
function setStartHere(p) {
  if (form.start.lat != null) return;
  form.start.lat = +p.lat.toFixed(6); form.start.lng = +p.lng.toFixed(6); form.start.label = 'My location';
  locWidget($('#dv-start'), form.start, 'Starting from');
}

async function checkDrive() {
  if (form.end.lat == null) { toast('Choose where you are going'); return; }
  if (form.start.lat == null) { toast('Set where you are starting from'); return; }
  const v = $('#dv-arrive').value;
  const arriveBy = v ? new Date(v).getTime() : null;
  if (arriveBy && arriveBy < Date.now()) { toast('That arrival time has already passed'); return; }
  const buffer = +$('#dv-buffer').value;
  const name = $('#dv-name').value.trim() || (form.end.label || 'your destination').split(',')[0];
  const b = $('#dv-go'); busy(b, true, 'Checking traffic…');
  const out = $('#dv-out'); out.innerHTML = '<div class="card note"><div class="spinner"></div> Checking the drive…</div>';
  try {
    const p = await planDrive({ start: { ...form.start }, end: { ...form.end }, arriveBy, buffer });
    lastPlan = { ...p, name, buffer, start: { ...form.start }, end: { ...form.end } };
    showPlan(lastPlan);
  } catch (e) {
    out.innerHTML = `<div class="card"><p class="bad" style="margin:0">Couldn't check that drive. ${esc(e.message || '')}</p></div>`;
  } finally { busy(b, false); }
}

const LEVEL = { light: ['Light traffic', 'lo'], moderate: ['Moderate traffic', 'md'], heavy: ['Heavy traffic', 'hi'] };
function chart(p) {
  if (!p.samples || p.samples.length < 2) return '';
  const max = Math.max(...p.samples.map((s) => s.secs));
  const pick = p.leaveAt ? p.samples.reduce((a, b) => (Math.abs(b.departAt - p.leaveAt) < Math.abs(a.departAt - p.leaveAt) ? b : a)) : p.samples[0];
  return `<div class="card"><h3 style="margin-top:0">Drive time by when you leave</h3>
    <div class="cols tall">${p.samples.map((s) => `<div><em>${mins(s.secs)}m</em><i class="${s === pick ? 'pick' : ''}" style="height:${Math.round((s.secs / max) * 100)}%"></i></div>`).join('')}</div>
    <div class="colx">${p.samples.map((s) => `<span>${clock(s.departAt).replace(' ', '')}</span>`).join('')}</div>
    <p class="note" style="margin:8px 0 0">Minutes of driving if you leave at each time. Predictions use Google's live and typical traffic.</p></div>`;
}
function riskList(res) {
  if (!res?.hits?.length) return '<p class="note" style="margin:0">No known cameras, ticket spots or live reports on this route.</p>';
  return `<div class="sec">${res.hits.slice(0, 8).map((h) => `<div class="row ${h.k}"><div class="main"><div class="ttl">${esc(h.title)}</div><div class="meta">${esc(h.sub)} · ${fmtDist(h.at)} into the trip</div></div></div>`).join('')}${res.hits.length > 8 ? `<p class="note">+ ${res.hits.length - 8} more</p>` : ''}</div>`;
}
function showPlan(p) {
  const out = $('#dv-out');
  const lv = p.level && LEVEL[p.level];
  const head = p.arriveBy
    ? (p.late
      ? `<div class="bigtime bad">Leave now</div><p style="margin:0">Even leaving now you'd arrive about <b>${p.lateMin} min late</b> for ${clock(p.arriveBy)}.</p>`
      : `<div class="bigtime">Leave by ${clock(p.leaveAt)}</div><p style="margin:0">to arrive by ${dayClock(p.arriveBy)}${p.buffer ? ` with ${p.buffer} min to spare` : ''} · leave ${until(p.leaveAt)}</p>`)
    : `<div class="bigtime">${mins(p.nowSecs)} min</div><p style="margin:0">if you leave now · arrive about ${clock(Date.now() + p.nowSecs * 1000)}</p>`;
  const traffic = p.traffic
    ? `${lv ? `<span class="tag ${lv[1]}">${lv[0]}</span> ` : ''}About ${mins(p.nowSecs)} min with traffic${p.staticSecs && Math.abs(p.staticSecs - p.nowSecs) > 90 ? `, ${mins(p.staticSecs)} min with no traffic` : ''} · ${fmtDist(p.meters)}`
    : `About ${mins(p.nowSecs)} min · ${fmtDist(p.meters)}<br><span class="note">Live traffic isn't connected, so this is the usual drive time plus 20%. ${p.note ? esc(p.note) : 'Step 2 of the setup page adds live traffic.'}</span>`;
  out.innerHTML = `<div class="card sec plan">
      <p class="eyebrow">${esc(p.name)}</p>${head}<p class="small" style="margin:0">${traffic}</p>
      <div class="btns">
        <a class="btn primary" id="dv-nav" href="${googleNav(p.end)}" target="_blank" rel="noopener">Start with Google Maps</a>
        <button class="btn" id="dv-start-only">Start without directions</button>
      </div>
      <div class="btns">
        ${p.arriveBy ? '<button class="btn" id="dv-save">Save trip &amp; remind me</button><button class="btn" id="dv-cal">Add to calendar</button>' : ''}
        <button class="btn" id="dv-map">Show on map</button>
        <button class="btn" id="dv-saveroute">Save as route</button>
      </div></div>
    ${chart(p)}
    <div class="card"><h3 style="margin-top:0">On this route</h3>${riskList(p.route)}</div>`;
  const begin = () => startTrip({ dest: p.end, name: p.name, arriveBy: p.arriveBy, factor: p.traffic && p.staticSecs ? p.nowSecs / p.staticSecs : 1 });
  $('#dv-nav').addEventListener('click', () => setTimeout(begin, 50));   // the link opens Google Maps; Ticket Radar keeps watching
  $('#dv-start-only').onclick = () => { begin(); go('map'); };
  $('#dv-map').onclick = () => { const poly = drawRoute(p.route, p.start, p.end); go('map'); setTimeout(() => map.fitBounds(poly.getBounds(), { padding: [40, 40] }), 80); };
  $('#dv-saveroute').onclick = () => bus.emit('save-route', { start: p.start, end: p.end }, p.route);
  $('#dv-save')?.addEventListener('click', () => saveTrip(p));
  $('#dv-cal')?.addEventListener('click', () => calendar(p));
  out.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- saved trips
async function saveTrip(p) {
  const rec = { id: uuid(), name: p.name, start: p.start, end: p.end, arriveBy: p.arriveBy, buffer: p.buffer,
    leaveAt: p.leaveAt, secs: p.nowSecs, traffic: p.traffic, checkedAt: Date.now(), alerted: false };
  S.db.plans = [...(S.db.plans || []).filter((x) => x.arriveBy > Date.now() - 3600e3), rec];
  save();
  const pushed = await pushTrip(rec);
  const ps = pushed ? 'on' : await pushState();
  toast(pushed ? `Saved. You'll get a notification when it's time to leave.`
    : ps === 'off' ? 'Saved. Turn on phone notifications in Settings to be told when to leave.'
    : 'Saved. The app reminds you when it\'s open; add it to your calendar too.', 4500);
  renderTrips();
}
function renderTrips() {
  const host = $('#dv-trips'); if (!host) return;
  const list = (S.db.plans || []).filter((x) => x.arriveBy > Date.now() - 3600e3).sort((a, b) => a.arriveBy - b.arriveBy);
  if (!list.length) { host.innerHTML = ''; return; }
  host.innerHTML = `<h2 class="sech">Saved trips</h2>${list.map((t) => {
    const past = t.arriveBy < Date.now();
    const due = !past && t.leaveAt && t.leaveAt - Date.now() < 10 * MIN;
    return `<div class="row ${due ? 't' : 'i'}" style="${past ? 'opacity:.55' : ''}"><div class="main">
      <div class="ttl">${esc(t.name)}${due ? '<span class="tag bad">Leave now</span>' : ''}</div>
      <div class="meta">Arrive by ${dayClock(t.arriveBy)}</div>
      <div class="meta">${past ? 'Done' : `Leave by <b>${clock(t.leaveAt)}</b> (${until(t.leaveAt)}) · about ${mins(t.secs)} min${t.traffic ? ' with traffic' : ''} · checked ${Math.max(0, Math.round((Date.now() - t.checkedAt) / MIN))} min ago`}</div></div>
      <div class="acts">${past ? '' : `<a class="sbtn linkbtn" data-nav="${t.id}" href="${googleNav(t.end)}" target="_blank" rel="noopener">Go</a><button class="sbtn" data-chk="${t.id}">Check again</button><button class="sbtn" data-cal="${t.id}">Calendar</button>`}<button class="sbtn danger" data-del="${t.id}">Delete</button></div></div>`;
  }).join('')}`;
  const find = (id) => S.db.plans.find((x) => x.id === id);
  $$('[data-nav]', host).forEach((a) => a.addEventListener('click', () => { const t = find(a.dataset.nav); setTimeout(() => startTrip({ dest: t.end, name: t.name, arriveBy: t.arriveBy }), 50); }));
  $$('[data-chk]', host).forEach((b) => (b.onclick = async () => { busy(b, true, 'Checking…'); await refreshTrip(find(b.dataset.chk), true); busy(b, false); renderTrips(); }));
  $$('[data-cal]', host).forEach((b) => (b.onclick = () => { const t = find(b.dataset.cal); calendar({ ...t, nowSecs: t.secs }); }));
  $$('[data-del]', host).forEach((b) => (b.onclick = () => confirmDel(b, () => { unpushTrip(b.dataset.del); S.db.plans = S.db.plans.filter((x) => x.id !== b.dataset.del); save(); renderTrips(); })));
}
function renderRisk() {
  const hs = hotspots(), host = $('#dv-risk'); if (!host) return;
  host.innerHTML = hs.length ? `<div class="card"><h2>Your high-risk zones</h2><div class="sec">${hs.slice(0, 5).map((h) => `<div class="row t"><div class="main"><div class="ttl">${esc(h.name)}</div><div class="meta">${h.count} ticket${h.count > 1 ? 's' : ''}</div></div></div>`).join('')}</div></div>` : '';
}

async function refreshTrip(t, force) {
  if (!t) return;
  let start = t.start;
  if (!start) { try { const p = E.me || (await locateOnce()); start = { lat: p.lat, lng: p.lng, label: 'My location' }; } catch { return; } }
  try {
    const p = await planDrive({ start, end: t.end, arriveBy: t.arriveBy, buffer: t.buffer });
    const prev = t.leaveAt;
    Object.assign(t, { leaveAt: p.leaveAt, secs: p.nowSecs, traffic: p.traffic, checkedAt: Date.now() });
    persist();
    if (!force && prev && p.leaveAt < prev - 10 * MIN && p.leaveAt - Date.now() > 15 * MIN && !t.warned) {
      t.warned = true;
      raise('info', `Traffic is building: leave by ${clock(p.leaveAt)}`, `${t.name}: about ${mins(p.nowSecs)} min now.`);
    }
    pushTrip(t);
  } catch { /* try again next minute */ }
}

/** Runs every minute while the app is open. */
export async function tripTick() {
  const now = Date.now();
  for (const t of S.db.plans || []) {
    if (t.arriveBy < now || t.arriveBy - now > 3 * 3600e3) continue;
    const soon = t.leaveAt && t.leaveAt - now < 30 * MIN;
    if (now - (t.checkedAt || 0) >= (soon ? 5 : 10) * MIN) await refreshTrip(t);
    if (!t.alerted && t.leaveAt && now >= t.leaveAt - 5 * MIN) {
      t.alerted = true; persist();
      raise('info', `Time to leave for ${t.name}`, `About ${mins(t.secs)} min${t.traffic ? ' with traffic' : ''}. Arrive by ${clock(t.arriveBy)}.`,
        `Time to leave for ${t.name}. About ${mins(t.secs)} minutes.`);
    }
  }
  if ($('#dv-trips') && S.view === 'route') renderTrips();
}

// ---------------------------------------------------------------- calendar (works with no server at all)
function calendar(p) {
  const f = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const leave = p.leaveAt || p.arriveBy - (p.nowSecs || 1200) * 1000;
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ticket Radar//EN', 'BEGIN:VEVENT',
    `UID:${p.id || uuid()}@ticket-radar`, `DTSTAMP:${f(Date.now())}`, `DTSTART:${f(leave)}`, `DTEND:${f(p.arriveBy)}`,
    `SUMMARY:Leave for ${String(p.name).replace(/[,;\\]/g, ' ')}`,
    `DESCRIPTION:About ${mins(p.nowSecs || 0)} min drive. Check traffic in Ticket Radar before you go.\\n${googleNav(p.end)}`,
    `LOCATION:${String(p.end.label || '').replace(/[,;\\]/g, ' ')}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Leave in 10 minutes', 'TRIGGER:-PT10M', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Time to leave', 'TRIGGER:PT0M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  download(`leave-for-${String(p.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'trip'}.ics`, ics, 'text/calendar');
  toast('Open the file to add it to your calendar');
}

// ---------------------------------------------------------------- active trip, ETA and arrival
const T = () => S.db.activeTrip;
export function startTrip({ dest, name, arriveBy = null, factor = 1 }) {
  S.db.activeTrip = { dest: { lat: dest.lat, lng: dest.lng, label: dest.label || '' }, name: name || (dest.label || 'Destination').split(',')[0],
    arriveBy, factor: Math.min(3, Math.max(0.8, factor || 1)), eta: null, remM: null, remS: null, calcAt: 0, calcFrom: null, startedAt: Date.now(), share: null };
  persist();
  if (!E.driving) startDrive();
  paintEta();
  updateEta(true);
}
export function endTrip({ arrived = false } = {}) {
  const t = T(); if (!t) return;
  if (t.share) api('share', { action: 'end', token: t.share.token, secret: t.share.secret, arrived }).catch(() => {});
  S.db.activeTrip = null; persist();
  paintEta();
}

let etaBusy = false;
async function updateEta(force) {
  const t = T(); if (!t || etaBusy) return;
  const me = E.me; if (!me) return;
  const moved = t.calcFrom ? dist(t.calcFrom, me) : Infinity;
  if (!force && Date.now() - t.calcAt < 60000 && moved < 1000) {
    if (t.remS != null) {                                 // between checks, count down with the distance covered
      const k = t.remM ? Math.max(0, 1 - moved / t.remM) : 1;
      t.eta = Date.now() + t.remS * k * t.factor * 1000;
    }
    return;
  }
  etaBusy = true;
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${me.lng},${me.lat};${t.dest.lng},${t.dest.lat}?overview=false`);
    const js = await r.json(); const rt = js.routes?.[0];
    if (rt) {
      Object.assign(t, { remS: rt.duration, remM: rt.distance, calcAt: Date.now(), calcFrom: { lat: me.lat, lng: me.lng } });
      t.eta = Date.now() + rt.duration * t.factor * 1000;
    }
  } catch {
    const d = dist(me, t.dest);                           // offline: straight line at 25 mph
    Object.assign(t, { remM: d * 1.3, remS: (d * 1.3) / 11, calcAt: Date.now(), calcFrom: { lat: me.lat, lng: me.lng } });
    t.eta = Date.now() + t.remS * 1000;
  } finally { etaBusy = false; persist(); paintEta(); }
}

let shareAt = 0;
bus.on('fix', (p) => {
  const t = T(); if (!t) return;
  updateEta(false);
  if (dist(p, t.dest) < 120 && p.speed < 5) {
    raise('info', `You've arrived at ${t.name}`, 'Tap P on the map to mark where you parked.', `You've arrived.`);
    endTrip({ arrived: true });
    bus.emit('arrived', p);
    return;
  }
  if (t.share && Date.now() - shareAt > 20000) {
    shareAt = Date.now();
    api('share', { action: 'update', token: t.share.token, secret: t.share.secret,
      data: { lat: p.lat, lng: p.lng, heading: p.heading, eta: t.eta, mph: Math.round(p.speed * 2.23694) } }).catch(() => {});
  }
  paintEta();
});
bus.on('drive', (on) => { if (!on && T()) paintEta(); });
bus.on('share-drive', () => shareDrive());

function etaText(t) {
  if (!t.eta) return 'Working out your arrival time…';
  const left = Math.max(0, Math.round((t.eta - Date.now()) / MIN));
  const late = t.arriveBy && t.eta > t.arriveBy + MIN ? ` · ${Math.round((t.eta - t.arriveBy) / MIN)} min late` : '';
  return `Arrive ${clock(t.eta)} · ${left} min${t.remM != null ? ' · ' + fmtDist(t.remM) : ''}${late}`;
}
export function etaSummary() {
  const t = T();
  if (!t) return 'You don\'t have a destination set. Plan a drive first.';
  if (!t.eta) return 'I\'m still working out your arrival time.';
  return `You'll arrive at ${t.name} around ${clock(t.eta)}, in about ${Math.max(1, Math.round((t.eta - Date.now()) / MIN))} minutes.`;
}
export function paintEta() {
  const t = T();
  for (const id of ['#etabar', '#hf-eta']) {
    const el = $(id); if (!el) continue;
    el.hidden = !t;
    if (!t) { el.innerHTML = ''; continue; }
    el.classList.toggle('late', !!(t.arriveBy && t.eta && t.eta > t.arriveBy + MIN));
    el.innerHTML = `<button class="etamain" data-eta="menu"><span class="flag">🏁</span><span><b>${esc(t.name)}</b><small>${etaText(t)}</small></span></button>
      <button class="etashare${t.share ? ' on' : ''}" data-eta="share">${t.share ? 'Sharing' : 'Share'}</button>`;
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-eta]'); if (!b) return;
  if (b.dataset.eta === 'share') shareDrive();
  else etaMenu();
});
function etaMenu() {
  const t = T(); if (!t) return;
  import('./ui.js').then(({ openSheet, head, closeSheet }) => openSheet(`${head(esc(t.name))}
    <p style="margin:0">${etaText(t)}</p>
    <div class="choice">
      <button data-m="share"><span class="ic" style="background:var(--you)">📍</span><span><b>${t.share ? 'Sharing your drive' : 'Share drive'}</b><small>${t.share ? 'Send the link again, or stop sharing' : 'Send a live link with your location and arrival time'}</small></span></button>
      <a class="choicelink" href="${googleNav(t.dest)}" target="_blank" rel="noopener"><span class="ic" style="background:var(--ok)">🧭</span><span><b>Directions in Google Maps</b><small>Ticket Radar keeps watching while it's open</small></span></a>
      <button data-m="park"><span class="ic" style="background:var(--surface2)">🅿️</span><span><b>Parking near ${esc(t.name)}</b><small>Garages and lots close to where you're going</small></span></button>
      <button data-m="end"><span class="ic" style="background:var(--danger)">✕</span><span><b>End trip</b><small>Stops the ETA and any sharing</small></span></button>
    </div>`, (s) => {
    $$('[data-m]', s).forEach((x) => (x.onclick = () => {
      closeSheet();
      if (x.dataset.m === 'share') shareDrive();
      if (x.dataset.m === 'park') { S.parkNear = t.dest; go('parking'); }
      if (x.dataset.m === 'end') { endTrip(); toast('Trip ended'); }
    }));
  }));
}

// ---------------------------------------------------------------- Share drive
export async function shareDrive() {
  const t = T();
  if (!t) { toast('Plan a drive first, then share it from the arrival bar'); go('route'); return; }
  const me = E.me || (await locateOnce().catch(() => null));
  const who = S.db.profile.name || 'Your friend';
  const etaStr = t.eta ? ` I should arrive around ${clock(t.eta)}.` : '';
  if (t.share) return sendShare(t.share.url, `${who} is driving to ${t.name}.${etaStr}`, true);
  try {
    const secret = uuid() + uuid();
    const r = await api('share', { action: 'start', secret, data: { name: who, destLabel: t.name, dest: t.dest, lat: me?.lat, lng: me?.lng, heading: E.heading, eta: t.eta, arriveBy: t.arriveBy } });
    const url = new URL('share.html#' + r.token, location.href).href;
    t.share = { token: r.token, secret, url }; persist(); paintEta();
    sendShare(url, `Follow my drive to ${t.name}.${etaStr}`);
  } catch {
    // No live link available: share a snapshot instead
    const where = me ? `https://www.google.com/maps?q=${me.lat.toFixed(5)},${me.lng.toFixed(5)}` : '';
    sendShare(where, `I'm on my way to ${t.name}.${etaStr}${where ? ' Here\'s where I am now:' : ''}`);
  }
}
async function sendShare(url, text, again) {
  try { if (navigator.share) { await navigator.share({ title: 'My drive', text, url }); if (!again) toast('Shared. The link updates until you arrive.'); return; } }
  catch (e) { if (e?.name === 'AbortError') return; }
  await copyText(`${text} ${url}`);
}

// Re-show a trip that was active before a reload
setTimeout(paintEta, 0);
