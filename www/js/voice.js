// Voice co-pilot and the hands-free driving screen.
import { S } from './store.js';
import { $, esc, fmtDist, toast, bus } from './util.js';
import { etaSummary } from './trip.js';
import { E, startDrive, stopDrive, aheadSummary, limitSummary, overBy } from './engine.js';
import { listen, canListen, speak, locateOnce, vibrate } from './native.js';
import { postReport, undoReport, go } from './ui.js';
import { agent } from './cloud.js';
import { rcat } from './mapview.js';
import { HAZARDS, sayType } from './reports.js';
import { checkParkingAt } from './parking.js';
import { spokenRisk } from './parkrisk.js';
import { startNav, endNav } from './nav.js';

// ---------------------------------------------------------------- understanding simple commands on the phone
const REPORT_WORDS = [
  [/\b(icy|black ice|slick|slippery|ice on the road|frozen)\b/, 'Icy road'],
  [/\b(immigration|i\.?c\.?e\.? (agents?|officers?|raid|activity|van|vans|checkpoint))\b/, 'Immigration enforcement (ICE)'],
  [/\b(checkpoint|sobriety)\b/, 'Checkpoint'],
  [/\b(speed trap|radar|trooper|cop|cops|police|cruiser)\b/, 'Speed trap / police'],
  [/\b(officer|officers)\b/, 'Officer location'],
  [/\b(new camera|speed camera|camera van|camera)\b/, 'New camera'],
  [/\b(ambulance|fire truck|firetruck|emergency vehicle|paramedics?)\b/, 'Emergency vehicle'],
  [/\b(accident|crash|wreck|collision|fender bender)\b/, 'Accident'],
  [/\b(pothole|potholes)\b/, 'Pothole'],
  [/\b(debris|something in the road|object in the road|tire in the road|ladder)\b/, 'Debris'],
  [/\b(flood|flooded|flooding|high water|standing water)\b/, 'Flooding'],
  [/\b(hazard|stalled|broken down|construction|tree down|lane closed)\b/, 'Road hazard'],
];
function understand(raw) {
  const t = raw.toLowerCase().trim();
  if (/^(undo|cancel|never ?mind)/.test(t)) return { action: 'undo' };
  if (/\b(stop|end|cancel) (navigation|navigating|directions|the route)\b/.test(t)) return { action: 'end_nav' };
  const go2 = /\b(?:navigate|take me|drive me|directions|get me|go|head)\s+(?:to|toward|towards)\s+(.{3,80})$/.exec(t);
  if (go2) return { action: 'navigate', place: go2[1].replace(/[.?!]+$/, '') };
  if (/(start|begin) (driving|drive|drive mode)|drive mode on/.test(t)) return { action: 'start_drive' };
  if (/(stop|end) (driving|drive|drive mode)|drive mode off/.test(t)) return { action: 'stop_drive' };
  if (/speed limit|how fast can i|what'?s the limit/.test(t)) return { speech: limitSummary() };
  if (/\b(share (my )?(drive|trip|location|eta)|send my eta)\b/.test(t)) return { action: 'share_drive' };
  if (/\b(can i park|ok to park|okay to park|safe to park|good (place|spot) to park|parking tickets? (here|risk)|ticket risk)\b/.test(t)) return { action: 'park_check' };
  if (/\b(find|where can i) park(ing)?\b|\bparking near\b/.test(t)) return { action: 'find_parking' };
  if (/\b(when will i (get there|arrive)|what'?s my eta|how long (until|till) i)\b/.test(t)) return { speech: etaSummary() };
  if (/(what'?s|anything|any cameras?|anything) (ahead|coming up|up ahead)|next camera/.test(t)) return { speech: aheadSummary() };
  if (/\b(report|there'?s|i see|spotted|seeing)\b/.test(t)) {
    const hit = REPORT_WORDS.find(([re]) => re.test(t));
    if (hit) return { action: 'report', report_type: hit[1], report_note: '' };
    if (/\bice\b/.test(t)) return { ask: 'Did you mean icy roads, or immigration enforcement? Say "icy road" or "immigration".' };
  }
  return null;
}

let lastReportId = null;
async function doReport(type, note) {
  let at = E.me;
  if (!at) { try { at = await locateOnce(); } catch { speak('I need your location to report that.'); return; } }
  const r = postReport({ type, lat: at.lat, lng: at.lng, place: E.road || '', note: note || '' });
  lastReportId = r.id;
  speak(`Reported ${sayType(type).replace(/^(A road hazard|Something)$/, 'it')}. Say undo if that was wrong.`);
  undoBar(r);
}
function undoBar(r) {
  $('.undobar')?.remove();
  const el = document.createElement('div'); el.className = 'undobar';
  el.innerHTML = `<span>${rcat(r.type).e} Reported ${esc(r.type)}</span><button>Undo</button>`;
  el.querySelector('button').onclick = () => { undoReport(r.id); el.remove(); toast('Report removed'); };
  document.body.appendChild(el); setTimeout(() => el.remove(), 9000);
}

let listening = false;
export async function voiceCommand() {
  if (listening) return;
  if (!canListen()) { toast('Voice isn\'t available here. Use Chrome on Android or the phone app.'); return; }
  listening = true; document.body.classList.add('listening'); vibrate(40);
  try {
    const said = await listen();
    if (!said) { speak('I didn\'t catch that.'); return; }
    let r = understand(said);
    if (!r && S.cloud) {
      try {
        r = await agent('voice-assist', { transcript: said, lat: E.me?.lat, lng: E.me?.lng, heading: E.heading, speed_mph: E.speed * 2.23694, speed_limit: E.limitHere });
      } catch (e) { r = { speech: e.message }; }
    }
    if (!r) r = { speech: 'I can report police, hazards or cameras, tell you what\'s ahead, or the speed limit.' };
    if (r.ask) { speak(r.ask); return; }
    if (r.action === 'undo') { if (lastReportId) { undoReport(lastReportId); lastReportId = null; speak('Removed your last report.'); } else speak('Nothing to undo.'); return; }
    if (r.action === 'start_drive') { await startDrive(); return; }
    if (r.action === 'stop_drive') { stopDrive(); speak('Drive mode off.'); return; }
    if (r.action === 'report') { await doReport(r.report_type || 'Other', r.report_note); return; }
    if (r.action === 'share_drive') { bus.emit('share-drive'); return; }
    if (r.action === 'find_parking') { bus.emit('go', 'parking'); return; }
    if (r.action === 'end_nav') { endNav(); speak('Navigation ended.'); return; }
    if (r.action === 'navigate') {
      speak(`Finding ${r.place}.`);
      const near = E.me || {};
      const q = new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'us', q: r.place, viewbox: '-79.50,39.75,-75.00,37.85', bounded: '1' });
      if (near.lat) q.set('viewbox', `${near.lng - 0.6},${near.lat + 0.45},${near.lng + 0.6},${near.lat - 0.45}`);
      let hit = null;
      try { hit = (await (await fetch('https://nominatim.openstreetmap.org/search?' + q)).json())[0]; } catch { /* offline */ }
      if (!hit) { speak(`I couldn't find ${r.place}. Try the Drive tab.`); return; }
      const label = hit.display_name;
      await startNav({ dest: { lat: +hit.lat, lng: +hit.lon, label }, name: label.split(',')[0] });
      return;
    }
    if (r.action === 'park_check') {
      if (!E.me) { speak('I need your location first. Start drive mode or tap locate.'); return; }
      speak('Checking parking tickets here.');
      const res = await checkParkingAt(E.me, 'you');
      speak(res.error ? res.error : spokenRisk(res) || 'There\'s no parking ticket data for this area. Read the signs before you leave the car.');
      return;
    }
    if (r.speech) speak(r.speech);
  } catch (e) { toast(e.message || 'Voice failed'); }
  finally { listening = false; document.body.classList.remove('listening'); }
}

// ---------------------------------------------------------------- one-tap hazard picker (big buttons)
function hazardPicker() {
  document.querySelector('.hzpick')?.remove();
  const el = document.createElement('div'); el.className = 'hzpick'; el.setAttribute('role', 'dialog');
  el.innerHTML = `<div class="hzgrid">${HAZARDS.map((t) => `<button data-t="${esc(t)}"><span>${rcat(t).e}</span>${esc(t)}</button>`).join('')}</div><button class="hzcancel">Cancel</button>`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-t]');
    if (b) { el.remove(); doReport(b.dataset.t); } else if (e.target.closest('.hzcancel') || e.target === el) el.remove();
  });
  document.body.appendChild(el);
  setTimeout(() => el.isConnected && el.remove(), 12000);
}

// ---------------------------------------------------------------- hands-free screen
export function showHandsFree(on) {
  $('#handsfree').hidden = !on;
  document.body.classList.toggle('hf', on);
  if (on) paintHandsFree();
}
export function paintHandsFree() {
  const hf = $('#handsfree'); if (hf.hidden) return;
  const mph = Math.round(E.speed * 2.23694);
  $('#hf-speed').textContent = E.driving ? mph : '–';
  const lim = E.limitHere;
  $('#hf-limit').hidden = !lim; $('#hf-limit b').textContent = lim || '';
  hf.classList.toggle('over', !!lim && mph > lim + (overBy() ?? 1));
  const n = E.next;
  $('#hf-next').innerHTML = !E.driving ? '<span class="muted">Drive mode is off</span>'
    : n ? `<b>${esc(n.label)}</b><span>${fmtDist(n.d)} ahead · ${n.eta < 1 ? 'under a minute' : '~' + Math.round(n.eta) + ' min'}${n.limit ? ' · limit ' + n.limit : ''}</span><small>${esc(n.name || '')}</small>`
    : '<span class="muted">Nothing logged ahead</span>';
}
export function setupHandsFree() {
  $('#hf-voice').onclick = voiceCommand;
  $('#hf-police').onclick = () => doReport('Speed trap / police');
  $('#hf-hazard').onclick = hazardPicker;
  $('#hf-map').onclick = () => { showHandsFree(false); go('map'); };
  $('#hf-stop').onclick = () => { stopDrive(); showHandsFree(false); };
}
