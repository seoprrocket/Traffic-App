// Drive mode: follows your GPS and fires the warnings.
import { S, sens, allCameras, activeReports, logAlert, logEvent, logTrip , cameraTickets, logPass, updatePass, isWatched } from './store.js';
import { $, esc, dist, bearing, angleDiff, fmtDist, sayDist, streetKey, ago, bus, toast, headingSpoken, sameStreet } from './util.js';
import { sayType } from './reports.js';
import { watchLocation, notify, beep, speak, vibrate, keepAwake, askNotifyPermission, unlockAudio, isNative } from './native.js';
import * as roads from './roads.js';

export const E = { driving: false, me: null, heading: null, speed: 0, osmLimit: null, road: null, limitHere: null, next: null, onRoute: null, silent: false };
const prevD = {}, fired = {}, inside = {};
let stopWatch = null, last = null, ref = null, headRef = null, trip = null;

// ---------------------------------------------------------------- alerts
let alertTimer = null;
const ICON = { camera: '📷', ticket: '⚠️', report: '📣', info: '🧠', road: '🛣️', speed: '⏱️', emergency: '🚑' };
export function raise(kind, title, sub, voice, mode, opts = {}) {
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
  if (mode === 'voice' && !E.silent) setTimeout(() => speak(voice || `${title}. ${sub}`), 650);   // E.silent: navigation set to full mute
  if (isNative || document.hidden) notify(title, sub);
  if (opts.log === false) return;
  logAlert(kind, title, sub);
  if (trip) trip.alerts++;
}

// ---------------------------------------------------------------- sample alerts (Settings → Hear sample alerts)
export const SAMPLES = [
  ['camera', 'Camera in ~5 min', 'Wisconsin Ave NW S/B · 1.8 mi ahead · limit 25 mph', 'Heads up. Speed camera in about 5 minutes. Speed limit 25.'],
  ['camera', 'Camera right ahead', 'Wisconsin Ave NW S/B · keep it under 25 mph', 'Speed camera right ahead. Keep it under 25.'],
  ['ticket', 'Ticket zone', 'You got a speed camera ticket on New York Ave NE · limit 30 mph', "Caution. You've been ticketed on New York Ave NE before. Limit 30. Watch for the camera."],
  ['speed', 'Slow down: 42 in a 30', "You're more than 5 mph over the limit", 'Slow down. The limit is 30.'],
  ['road', 'Speed bump ahead', 'In about 400 ft', 'Speed bump ahead.'],
  ['road', 'Sharp curve ahead', 'In about 650 ft on Rock Creek Pkwy', 'Sharp curve ahead. Slow down.'],
  ['road', 'Speed limit drops to 25', 'In about 800 ft (now 40)', 'Speed limit drops to 25 ahead.'],
  ['road', 'Toll ahead', 'In about 0.6 mi', 'Toll ahead.'],
  ['report', 'Speed trap / police reported', '0.4 mi ahead · 6 min ago', 'Police reported 0.4 miles ahead.'],
  ['emergency', 'Emergency vehicle nearby', '600 ft ahead · 2 min ago. Move over or slow down if you pass it.', 'Emergency vehicle ahead. Move over or slow down.'],
  ['info', 'Time to leave for Dentist', 'About 25 min with traffic. Arrive by 3:30 PM.', 'Time to leave for Dentist. About 25 minutes.'],
];
let sampleTimer = null;
/** Plays each alert type in turn, a few seconds apart. Not saved to the alert log. */
export function playSamples(list = SAMPLES, gap = 5200) {
  clearTimeout(sampleTimer);
  unlockAudio();
  let i = 0;
  const next = () => {
    if (i >= list.length) return;
    const [k, t, s, v] = list[i++];
    raise(k, `${t}`, `${s}  (sample ${i} of ${list.length})`, v, 'voice', { log: false });
    sampleTimer = setTimeout(next, gap);
  };
  next();
}
export function stopSamples() { clearTimeout(sampleTimer); $('.alert')?.remove(); try { speechSynthesis.cancel(); } catch { /* none */ } }

// ---------------------------------------------------------------- start / stop
export async function startDrive() {
  if (E.driving) return;
  unlockAudio();
  askNotifyPermission();                                        // ask, but never wait on the answer before watching GPS
  E.driving = true; last = null; ref = null; headRef = null; trip = null; E.speed = 0;
  keepAwake(true, 'drive');
  if (S.db.settings.alertType === 'voice') speak(`Drive mode on. I'll warn you ${S.db.settings.lead} minutes before each camera in your direction.`);
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
  stopWatch = null; keepAwake(false, 'drive');
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
  // Direction of travel (true north): the GPS course when the chip gives one, otherwise the bearing from the last point 12 m back —
  // kept as a separate reference so slow driving still turns the compass
  if (p.heading != null && p.heading >= 0 && p.speed > 2) { E.heading = p.heading; headRef = p; }
  else if (!headRef) headRef = p;
  else if (dist(headRef, p) > 12) { E.heading = bearing(headRef, p); headRef = p; }
  p.heading = E.heading;

  if (!trip) trip = { start: { lat: p.lat, lng: p.lng }, startedAt: Date.now(), meters: 0, maxMph: 0, alerts: 0 };
  else if (last) trip.meters += dist(last, p);
  trip.maxMph = Math.max(trip.maxMph, p.speed * 2.23694);

  E.me = p; E.speed = p.speed;
  if (S.db.settings.speedLimits || roadAlertsOn()) roads.refresh(p);
  check(p);
  last = p;
  bus.emit('fix', p);
}

// Auto-log of every camera you drive past (My roads tab): one row per pass, speed = your fastest inside the 250 m zone
const passing = {}, nudgeAt = {};
function trackPass(c, isIn, mph) {
  const p = passing[c.id];
  if (isIn && !p) { if (S.db.settings.logPasses !== false) passing[c.id] = logPass(c, mph); }
  else if (isIn && p) updatePass(p, mph);
  else if (!isIn && p) delete passing[c.id];
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
    if (d > 2500) delete fired['one' + c.id];
    if (d > 12000) { delete prevD[c.id]; continue; }
    const p = prevD[c.id]; prevD[c.id] = d;
    const approaching = p == null || d < p - 3 || d < 150;
    // Only cameras in my direction:
    //  • it enforces the way I'm going (its direction within 50° of mine); one-direction cameras wait until the GPS knows my direction
    //  • it's ahead of me — within 45° of my heading for the early warnings (70° once I'm close)
    //  • when navigating, it's on my route ahead of me; otherwise, if it's clearly on a different street, only the "right ahead" call-out
    const rightWay = c.heading == null ? true : E.heading == null ? false : angleDiff(E.heading, c.heading) <= 50;
    const ahead = isAhead(cur, c, d);
    const route = E.onRoute ? E.onRoute(c) : undefined;
    // no route: in front of me (≤45° off my heading) and no more than ~150 m to the side of my line of travel, and not on a street I'm clearly not driving
    const off = E.heading == null ? 999 : angleDiff(bearing(cur, c), E.heading);
    const myWay = route ? route.on && route.ahead > 0 : E.heading != null && off <= 45 && d * Math.sin((off * Math.PI) / 180) <= 150 && sameStreet(c.name, E.road) !== false;
    const live = approaching && rightWay && ahead && route?.on !== false;
    // My roads: log the pass only when the camera is on my line of travel (not one on a cross street 200 m away)
    trackPass(c, d <= 250 && rightWay && (E.heading == null || off <= 60 || d <= 100), mph);
    geofence('c' + c.id, c.name, 'Camera', d <= 250 && rightWay, mph, c.limit);
    if (!live) continue;
    if (myWay || d <= 250) candidates.push({ kind: 'camera', label: `${c.kind} camera`, name: c.name, d, limit: c.limit });
    if (d < 800 && c.limit && d < limitD) { limitD = d; limitNear = c.limit; }
    const eta = d / v;
    const dir = c.heading != null ? headingSpoken(c.heading) : '';
    const watched = isWatched(c);
    const myLead = watched ? lead + 60 : lead;                     // a watched camera warns a minute earlier
    if (eta <= myLead && d > 250 && myWay && !fired['far' + c.id]) {
      fired['far' + c.id] = 1;
      const mins = Math.max(1, Math.round(eta / 60));
      const got = cameraTickets(c).length;
      raise('camera', got ? `⚠️ Camera that got you · ~${mins} min` : watched ? `👁 Watched camera · ~${mins} min` : `Camera in ~${mins} min`, `${c.name} · ${fmtDist(d)} ahead${c.limit ? ' · limit ' + c.limit + ' mph' : ''}${got ? ` · ticketed you ${got === 1 ? 'once' : got + ' times'}` : watched ? ' · on your watch list' : ''}`,
        `${watched ? 'Watch out. Your flagged' : 'Heads up.'} ${c.kind} camera${dir ? ', ' + dir + ',' : ''} in about ${mins} minute${mins > 1 ? 's' : ''}${c.limit ? '. Speed limit ' + c.limit : ''}.${got ? ' This one has ticketed you before.' : watched ? ' Ease off now.' : ''}`);
      if (eta <= 60) fired['one' + c.id] = 1;                 // already inside the last minute: one call-out is enough
    }
    // Second call-out: one minute out ("One minute to camera"), when the first warning was further out than that
    if (lead > 75 && eta <= 60 && d > 250 && myWay && fired['far' + c.id] && !fired['one' + c.id]) {
      fired['one' + c.id] = 1;
      raise('camera', 'Camera in 1 min', `${c.name} · ${fmtDist(d)} ahead${c.limit ? ' · limit ' + c.limit + ' mph' : ''}`,
        `One minute to ${String(c.kind).toLowerCase()} camera.${c.limit ? ' Limit ' + c.limit + '.' : ''}`);
    }
    if (d <= 250 && !fired['near' + c.id]) {
      fired['near' + c.id] = 1;
      fired['one' + c.id] = 1;
      const got = cameraTickets(c).length;
      raise('camera', got ? 'Camera that got you · right ahead' : watched ? '👁 Watched camera · right ahead' : 'Camera right ahead', `${c.name}${c.limit ? ' · keep it under ' + c.limit + ' mph' : ''}`, `${watched ? 'Watched' : c.kind} camera right ahead.${c.limit ? ' Keep it under ' + c.limit + '.' : ''}${got ? ' It got you before.' : ''}`);
    }
    // Watched camera and you're over its limit within 600 m: a slow-down nudge, every 20 s until you're under
    if (watched && c.limit && d <= 600 && mph > c.limit && Date.now() - (nudgeAt[c.id] || 0) > 20000) {
      nudgeAt[c.id] = Date.now();
      raise('speed', `Slow down: ${Math.round(mph)} in a ${c.limit}`, `Watched camera ${fmtDist(d)} ahead · ${c.name}`, `Slow down. ${c.limit} for the camera ahead.`, null, { log: false });
    }
  }

  const tr = st.ticketRadius * SX.f;
  for (const t of S.db.tickets) {
    if (/^parking/i.test(t.type || '')) continue;   // parking tickets warn when you park, not while driving
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
    const emergency = r.type === 'Emergency vehicle';
    if (ahead && d < 5000) candidates.push({ kind: 'report', label: r.type, name: r.place || '', d });
    if (emergency && d <= 600 * SX.f && !fired['r' + r.id]) {
      fired['r' + r.id] = 1;
      raise('emergency', 'Emergency vehicle nearby', `${fmtDist(d)} ${ahead ? 'ahead' : 'away'} · ${ago(r.time)}. Move over or slow down if you pass it.`, `Emergency vehicle ${ahead ? 'ahead' : 'nearby'}. Move over or slow down.`);
    } else if (ahead && d <= 800 * SX.f && !fired['r' + r.id]) {
      fired['r' + r.id] = 1;
      raise('report', r.type + ' reported', `${fmtDist(d)} ahead · ${ago(r.time)}${r.note ? ' · ' + r.note : ''}`, `${sayType(r.type)} reported ${sayDist(d)} ahead.`);
    }
    if (d > 2400) delete fired['r' + r.id];
  }

  // Road features: posted limit, bumps, curves, limit drops, tolls
  const rw = roads.check(cur, E.heading, mph, { bumps: st.roadBumps, curves: st.roadCurves, limits: st.roadLimits, tolls: st.roadTolls });
  E.osmLimit = st.speedLimits ? roads.road.limit : null;
  E.road = roads.road.name;
  for (const w of rw) {
    if (fired['rd' + w.key]) continue;
    if (w.group && Date.now() - (groupAt[w.group] || 0) < (w.group === 'bump' ? 20000 : 180000)) { fired['rd' + w.key] = 1; continue; }
    fired['rd' + w.key] = 1; if (w.group) groupAt[w.group] = Date.now();
    raise('road', w.title, w.sub, w.voice);
  }

  E.limitHere = limitNear ?? E.osmLimit ?? null;
  speedCheck(Math.round(mph), E.limitHere, st);
  candidates.sort((a, b) => a.d - b.d);
  E.next = candidates[0] ? { ...candidates[0], eta: candidates[0].d / v / 60 } : null;
}
const groupAt = {};
function roadAlertsOn() { const s = S.db.settings; return s.roadBumps || s.roadCurves || s.roadLimits || s.roadTolls; }

// ---------------------------------------------------------------- your own speed alerts
const sp = { over: 0, overOn: false, overAt: 0, max: 0, maxOn: false, maxAt: 0 };
/** Over-limit threshold in mph above the limit, or null when off. */
export const overBy = () => { const v = S.db.settings.speedOverBy; return v === '' || v == null || +v < 0 ? null : +v; };
function speedCheck(mph, limit, st) {
  const ob = overBy();
  if (ob != null && limit) {
    if (mph > limit + ob) {
      if (++sp.over >= 3 && !sp.overOn && Date.now() - sp.overAt > 30000) {
        sp.overOn = true; sp.overAt = Date.now();
        raise('speed', `Slow down: ${mph} in a ${limit}`, ob ? `You're more than ${ob} mph over the limit` : "You're over the limit", `Slow down. The limit is ${limit}.`);
      }
    } else if (mph <= limit + ob - 2) { sp.over = 0; sp.overOn = false; }
  }
  const mx = +st.speedMax || 0;
  if (mx > 0) {
    if (mph > mx) {
      if (++sp.max >= 3 && !sp.maxOn && Date.now() - sp.maxAt > 30000) {
        sp.maxOn = true; sp.maxAt = Date.now();
        raise('speed', `Over ${mx} mph`, `You're going ${mph} mph`, `You're over ${mx}.`);
      }
    } else if (mph <= mx - 2) { sp.max = 0; sp.maxOn = false; }
  }
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
