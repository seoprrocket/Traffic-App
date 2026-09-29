// Drive mode: follows your GPS and fires the warnings.
import { S, sens, allCameras, activeReports, logAlert, logEvent, logTrip } from './store.js';
import { $, esc, dist, bearing, angleDiff, fmtDist, streetKey, ago, bus, toast } from './util.js';
import { watchLocation, notify, beep, speak, vibrate, keepAwake, askNotifyPermission, unlockAudio, isNative } from './native.js';

export const E = { driving: false, me: null, heading: null, speed: 0, osmLimit: null, road: null, limitHere: null, next: null };
const prevD = {}, fired = {}, inside = {};
let stopWatch = null, last = null, ref = null, trip = null;

// ---------------------------------------------------------------- alerts
let alertTimer = null;
const ICON = { camera: '📷', ticket: '⚠️', report: '📣', info: '🧠' };
export function raise(kind, title, sub, voice, mode) {
  mode = mode || S.db.settings.alertType;
  $('.alert')?.remove();
  const el = document.createElement('div');
  el.className = 'alert ' + kind; el.setAttribute('role', 'alert');
  el.innerHTML = `<div class="big">${ICON[kind]}</div><div><b>${esc(title)}</b><p>${esc(sub)}</p></div><button>OK</button>`;
  el.querySelector('button').onclick = () => el.remove();
  document.body.appendChild(el);
  clearTimeout(alertTimer); alertTimer = setTimeout(() => el.remove(), 15000);
  vibrate(kind === 'info' ? 120 : [250, 120, 250, 120, 400]);
  if (mode === 'sound' || mode === 'voice') beep();
  if (mode === 'voice') setTimeout(() => speak(voice || `${title}. ${sub}`), 650);
  if (isNative || document.hidden) notify(title, sub);
  logAlert(kind, title, sub);
  if (trip) trip.alerts++;
}

// ---------------------------------------------------------------- start / stop
export async function startDrive() {
  if (E.driving) return;
  unlockAudio();
  await askNotifyPermission();
  E.driving = true; last = null; ref = null; trip = null; E.speed = 0;
  keepAwake.wanted = true; keepAwake(true);
  if (S.db.settings.alertType === 'voice') speak(`Drive mode on. I'll warn you ${S.db.settings.lead} minutes before each camera.`);
  let warned = false;
  stopWatch = await watchLocation(onFix, (e) => {
    if (e.code === 1) { toast(e.message || 'Location is blocked. Allow it in your settings.'); stopDrive(); return; }
    if (e.code === 3) return;                                   // a slow fix; the watch keeps going
    if (!warned) { warned = true; toast('GPS signal is weak. Warnings resume when it comes back.'); }
  });
  bus.emit('drive', true);
}
export function stopDrive() {
  if (!E.driving) return;
  E.driving = false;
  try { stopWatch?.(); } catch { /* ignore */ }
  stopWatch = null; keepAwake.wanted = false; keepAwake(false);
  if (trip && last && trip.meters > 400) {
    logTrip({ start: trip.start, end: { lat: last.lat, lng: last.lng }, startedAt: trip.startedAt, endedAt: Date.now(),
      meters: Math.round(trip.meters), maxMph: Math.round(trip.maxMph), alerts: trip.alerts });
  }
  trip = null; last = null;
  bus.emit('drive', false);
}

// ---------------------------------------------------------------- each GPS fix
function onFix(p) {
  if (p.accuracy && p.accuracy > 120) return;               // too rough to trust
  let v = p.speed;
  if (v == null || isNaN(v) || v < 0) {
    // No speed from the GPS chip: work it out from the last fix, ignoring fixes that arrive too close together
    const dt = ref ? (p.t - ref.t) / 1000 : 0;
    if (!ref || dt > 30) { ref = p; v = E.speed; }
    else if (dt >= 0.8) { v = dist(ref, p) / dt; ref = p; }
    else v = E.speed;
  }
  v = Math.min(Math.max(0, v || 0), 70);                       // 70 m/s ≈ 155 mph: anything above is a GPS jump
  p.speed = last ? 0.6 * v + 0.4 * E.speed : v;                // light smoothing
  if (p.heading != null && p.heading >= 0 && p.speed > 2) E.heading = p.heading;
  else if (last && dist(last, p) > 12) E.heading = bearing(last, p);
  p.heading = E.heading;

  if (!trip) trip = { start: { lat: p.lat, lng: p.lng }, startedAt: Date.now(), meters: 0, maxMph: 0, alerts: 0 };
  else if (last) trip.meters += dist(last, p);
  trip.maxMph = Math.max(trip.maxMph, p.speed * 2.23694);

  E.me = p; E.speed = p.speed;
  lookupSpeedLimit(p);
  check(p);
  last = p;
  bus.emit('fix', p);
}

function geofence(id, name, zoneType, isIn, mph, limit) {
  if (isIn && !inside[id]) { inside[id] = 1; logEvent('enter', { zone: name, zoneType, speed: Math.round(mph), limit: limit || null }); }
  else if (!isIn && inside[id]) { delete inside[id]; logEvent('exit', { zone: name, zoneType, speed: Math.round(mph), limit: limit || null }); }
}

/** Is this point in front of me (or am I heading toward it)? */
function isAhead(me, pt, d) {
  if (E.heading == null) return true;
  return d < 60 || angleDiff(bearing(me, pt), E.heading) <= 70;
}

function check(cur) {
  const mph = cur.speed * 2.23694, SX = sens(), st = S.db.settings;
  const lead = st.lead * 60;
  const v = Math.max(cur.speed, 8.9);                        // treat under 20 mph as 20 so a red light doesn't hide a camera
  const reach = v * lead;
  let limitNear = null, limitD = Infinity;
  const candidates = [];

  for (const c of allCameras()) {
    const d = dist(cur, c);
    if (d > reach * 1.5 + 800) { delete fired['far' + c.id]; }
    if (d > 600) delete fired['near' + c.id];
    if (d > 12000) { delete prevD[c.id]; continue; }
    const p = prevD[c.id]; prevD[c.id] = d;
    const approaching = p == null || d < p - 3 || d < 150;
    const rightWay = c.heading == null || E.heading == null || angleDiff(E.heading, c.heading) <= 50;
    const ahead = isAhead(cur, c, d);
    const live = approaching && rightWay && ahead;
    geofence('c' + c.id, c.name, 'Camera', d <= 250 && rightWay, mph, c.limit);
    if (!live) continue;
    candidates.push({ kind: 'camera', label: `${c.kind} camera`, name: c.name, d, limit: c.limit });
    if (d < 800 && c.limit && d < limitD) { limitD = d; limitNear = c.limit; }
    const eta = d / v;
    if (eta <= lead && d > 250 && !fired['far' + c.id]) {
      fired['far' + c.id] = 1;
      const mins = Math.max(1, Math.round(eta / 60));
      raise('camera', `Camera in ~${mins} min`, `${c.name} · ${fmtDist(d)} ahead${c.limit ? ' · limit ' + c.limit + ' mph' : ''}`,
        `Heads up. ${c.kind} camera in about ${mins} minute${mins > 1 ? 's' : ''}${c.limit ? '. Speed limit ' + c.limit : ''}.`);
    }
    if (d <= 250 && !fired['near' + c.id]) {
      fired['near' + c.id] = 1;
      raise('camera', 'Camera right ahead', `${c.name}${c.limit ? ' · keep it under ' + c.limit + ' mph' : ''}`, `${c.kind} camera right ahead.${c.limit ? ' Keep it under ' + c.limit + '.' : ''}`);
    }
  }

  const tr = st.ticketRadius * SX.f;
  for (const t of S.db.tickets) {
    const d = dist(cur, t);
    geofence('t' + t.id, streetKey(t.street), 'Ticket zone', d <= tr, mph, t.limit);
    if (d <= tr && t.limit && d < limitD) { limitD = d; limitNear = t.limit; }
    const ahead = isAhead(cur, t, d);
    if (ahead && d < 5000) candidates.push({ kind: 'ticket', label: 'Ticket zone', name: streetKey(t.street), d, limit: t.limit });
    if (st.ai && ahead && d <= 1200 * SX.f && d > tr && !fired['pre' + t.id]) {
      fired['pre' + t.id] = 1;
      raise('info', 'Ticket area coming up', `You were ticketed on ${streetKey(t.street)} (${fmtDist(d)} away). Ease off now.`,
        `Proactive alert. You're getting close to ${streetKey(t.street)}, where you got a ticket before.`, t.alertType);
    }
    if (d <= tr && !fired['t' + t.id]) {
      fired['t' + t.id] = 1;
      raise('ticket', 'Ticket zone', `You got a ${String(t.type).toLowerCase()} ticket on ${streetKey(t.street)}${t.limit ? ' · limit ' + t.limit + ' mph' : ''}`,
        `Caution. You've been ticketed on ${streetKey(t.street)} before.${t.limit ? ' Limit ' + t.limit + '.' : ''} Watch for the camera.`, t.alertType);
    }
    if (d > tr * 3) delete fired['t' + t.id];
    if (d > 2400 * SX.f) delete fired['pre' + t.id];
  }

  for (const r of activeReports()) {
    if (r.mine) continue;
    const d = dist(cur, r);
    const ahead = isAhead(cur, r, d);
    if (ahead && d < 5000) candidates.push({ kind: 'report', label: r.type, name: r.place || '', d });
    if (ahead && d <= 800 * SX.f && !fired['r' + r.id]) {
      fired['r' + r.id] = 1;
      raise('report', r.type + ' reported', `${fmtDist(d)} ahead · ${ago(r.time)}${r.note ? ' · ' + r.note : ''}`, `${r.type} reported ${fmtDist(d)} ahead.`);
    }
    if (d > 2400) delete fired['r' + r.id];
  }

  E.limitHere = limitNear ?? E.osmLimit ?? null;
  candidates.sort((a, b) => a.d - b.d);
  E.next = candidates[0] ? { ...candidates[0], eta: candidates[0].d / v / 60 } : null;
}

// ---------------------------------------------------------------- posted speed limits (OpenStreetMap)
let limAt = null, limT = 0, limBusy = false;
async function lookupSpeedLimit(p) {
  if (!S.db.settings.speedLimits || limBusy) return;
  if (limAt && dist(limAt, p) < 180 && Date.now() - limT < 60000) return;
  if (Date.now() - limT < 12000) return;
  limBusy = true; limT = Date.now(); limAt = { lat: p.lat, lng: p.lng };
  try {
    const q = `[out:json][timeout:8];way(around:25,${p.lat},${p.lng})[highway][maxspeed];out tags 4;`;
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 9000);
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
    const js = await r.json();
    const way = (js.elements || [])[0];
    if (way) {
      const raw = String(way.tags.maxspeed); const n = parseFloat(raw);
      E.osmLimit = isNaN(n) ? null : /mph/i.test(raw) ? Math.round(n) : Math.round((n * 0.621371) / 5) * 5;
      E.road = way.tags.name || way.tags.ref || null;
    } else { E.osmLimit = null; E.road = null; }
  } catch { /* keep last known limit */ } finally { limBusy = false; }
}

// ---------------------------------------------------------------- for voice & hands-free
export function aheadSummary() {
  const n = E.next;
  if (!E.driving) return 'Drive mode is off. Say "start driving" first.';
  if (!n) return 'Nothing logged ahead of you within three miles.';
  const eta = n.eta < 1 ? 'less than a minute' : `about ${Math.round(n.eta)} minute${Math.round(n.eta) > 1 ? 's' : ''}`;
  return `${n.label}${n.name ? ' at ' + n.name : ''}, ${fmtDist(n.d)} ahead, ${eta} away.${n.limit ? ' Limit ' + n.limit + '.' : ''}`;
}
export function limitSummary() {
  if (E.limitHere) return `The limit here is ${E.limitHere} miles per hour${E.road ? ' on ' + E.road : ''}.`;
  return 'I don\'t have the posted limit for this road. Watch for the next sign.';
}
