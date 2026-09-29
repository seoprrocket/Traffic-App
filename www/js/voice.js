// Voice co-pilot and the hands-free driving screen.
import { S } from './store.js';
import { $, esc, fmtDist, toast } from './util.js';
import { E, startDrive, stopDrive, aheadSummary, limitSummary } from './engine.js';
import { listen, canListen, speak, locateOnce, vibrate } from './native.js';
import { postReport, undoReport, go } from './ui.js';
import { agent } from './cloud.js';
import { rcat } from './mapview.js';

// ---------------------------------------------------------------- understanding simple commands on the phone
const REPORT_WORDS = [
  [/\b(icy|black ice|slick|slippery|ice on the road|frozen)\b/, 'Icy road'],
  [/\b(immigration|i\.?c\.?e\.? (agents?|officers?|raid|activity|van|vans|checkpoint))\b/, 'Immigration enforcement (ICE)'],
  [/\b(checkpoint|sobriety)\b/, 'Checkpoint'],
  [/\b(speed trap|radar|trooper|cop|cops|police|cruiser)\b/, 'Speed trap / police'],
  [/\b(officer|officers)\b/, 'Officer location'],
  [/\b(new camera|speed camera|camera van|camera)\b/, 'New camera'],
  [/\b(accident|crash|debris|pothole|hazard|stalled|construction|flood|flooding|tree down)\b/, 'Road hazard'],
];
function understand(raw) {
  const t = raw.toLowerCase().trim();
  if (/^(undo|cancel|never ?mind)/.test(t)) return { action: 'undo' };
  if (/(start|begin) (driving|drive|drive mode)|drive mode on/.test(t)) return { action: 'start_drive' };
  if (/(stop|end) (driving|drive|drive mode)|drive mode off/.test(t)) return { action: 'stop_drive' };
  if (/speed limit|how fast can i|what'?s the limit/.test(t)) return { speech: limitSummary() };
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
  speak(`Reported ${type.replace(' / police', '').replace(' (ICE)', '')}. Say undo if that was wrong.`);
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
    if (r.speech) speak(r.speech);
  } catch (e) { toast(e.message || 'Voice failed'); }
  finally { listening = false; document.body.classList.remove('listening'); }
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
  hf.classList.toggle('over', !!lim && mph > lim + 1);
  const n = E.next;
  $('#hf-next').innerHTML = !E.driving ? '<span class="muted">Drive mode is off</span>'
    : n ? `<b>${esc(n.label)}</b><span>${fmtDist(n.d)} ahead · ${n.eta < 1 ? 'under a minute' : '~' + Math.round(n.eta) + ' min'}${n.limit ? ' · limit ' + n.limit : ''}</span><small>${esc(n.name || '')}</small>`
    : '<span class="muted">Nothing logged ahead</span>';
}
export function setupHandsFree() {
  $('#hf-voice').onclick = voiceCommand;
  $('#hf-police').onclick = () => doReport('Speed trap / police');
  $('#hf-hazard').onclick = () => doReport('Road hazard');
  $('#hf-map').onclick = () => { showHandsFree(false); go('map'); };
  $('#hf-stop').onclick = () => { stopDrive(); showHandsFree(false); };
}
