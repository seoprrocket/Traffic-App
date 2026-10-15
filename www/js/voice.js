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
import { startNav, endNav, navOn, setVoice, stopSheet, recenter, switchAlt, STOP_KINDS } from './nav.js';
import { askSpoken, askSheet } from './ask.js';
import { findSaved, goHome, savePlaceSheet } from './lists.js';
import { shareDrive, reminderSheet, shareLiveLocation } from './trip.js';

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
  if (/\b(take me|go|navigate|drive me|head)\s+(home|to my house|to my place)\b/.test(t)) return { action: 'home', which: 'home' };
  if (/\b(take me|go|navigate|drive me|head)\s+to (work|the office|my office|my job)\b/.test(t)) return { action: 'home', which: 'work' };
  if (/\b(save|bookmark|remember) (this|my) (place|spot|location|here)\b|\bsave (here|this)\b/.test(t)) return { action: 'save_here' };
  if (/\b(share|send) my (live |real.?time |current )?location\b/.test(t)) return { action: 'share_location' };
  const rem = /\bremind me to leave\b(?:\s+(?:at|by)\s+(.{2,30}))?/.exec(t);
  if (rem) return { action: 'remind', when: rem[1] || '' };
  if (/\b(open|show) (my )?(saved|favorites|favourites|lists)\b/.test(t)) return { action: 'open_saved' };
  if (/\balerts? only\b/.test(t)) return { action: 'voice', mode: 'alerts' };
  if (/\b(unmute|voice (back )?on|turn (the )?(voice|sound) (back )?on|talk to me)\b/.test(t)) return { action: 'voice', mode: 'all' };
  if (/\b(mute|silence|be quiet|quiet mode|stop talking)\b/.test(t)) return { action: 'voice', mode: 'mute' };
  if (/\b(re-?cent(er|re)( the map)?|center (the )?map|follow me)\b/.test(t)) return { action: 'recenter' };
  if (/\b(alternative|alternate|other|different|another) route\b|\bavoid (this|that) (road|route|highway)\b/.test(t)) return { action: 'alt' };
  const stop = /\b(?:add|make|plan) (?:a )?stop (?:for|at)\s+(.{2,60})|\bstop (?:for|at)\s+(gas|fuel|coffee|an atm|atm|food|a restroom|a bathroom|charging|parking)\b|\bi need (?:some |a |an )?(gas|fuel|coffee|atm|cash|food|restroom|bathroom|charging|charge|parking|pharmacy)\b/.exec(t);
  if (stop) return { action: 'stop', q: (stop[1] || stop[2] || stop[3]).replace(/[.?!]+$/, '') };
  const go2 = /\b(?:navigate|take me|drive me|directions|get me|go|head)\s+(?:to|toward|towards)\s+(.{3,80})$/.exec(t);
  if (go2) return { action: 'navigate', place: go2[1].replace(/[.?!]+$/, '') };
  if (/(start|begin) (driving|drive|drive mode)|drive mode on/.test(t)) return { action: 'start_drive' };
  if (/(stop|end) (driving|drive|drive mode)|drive mode off/.test(t)) return { action: 'stop_drive' };
  if (/speed limit|how fast can i|what'?s the limit/.test(t)) return { speech: limitSummary() };
  if (/\b(share (my )?(drive|trip|location|eta)|send my eta)\b/.test(t)) return { action: 'share_drive' };
  if (/\b(can i park|ok to park|okay to park|safe to park|good (place|spot) to park|parking tickets? (here|risk)|ticket risk)\b/.test(t)) return { action: 'park_check' };
  if (/\b(find|where can i) park(ing)?\b|\bparking near\b/.test(t)) return { action: 'find_parking' };
  const ask = /^(?:hey radar,? |radar,? |ask radar,? )?(?:find|look for|search for|i(?:'m| am) looking for|i want|is there|are there|where(?:'s| is| are) (?:the )?(?:nearest|closest)|nearest|closest|show me|any)\s+(.{3,140})$/.exec(t);
  if (ask) return { action: 'ask', q: ask[1].replace(/[.?!]+$/, '') };
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
    await runSpoken(said, true);
  } catch (e) { toast(e.message || 'Voice failed'); }
  finally { listening = false; document.body.classList.remove('listening'); }
}
/** Act on something the driver said (from the Voice button, or the map's mic). Returns true when it was a command. */
export async function runSpoken(said, speakFallback = false) {
  try {
    let r = understand(said);
    if (!r && S.cloud) {
      try {
        r = await agent('voice-assist', { transcript: said, lat: E.me?.lat, lng: E.me?.lng, heading: E.heading, speed_mph: E.speed * 2.23694, speed_limit: E.limitHere });
      } catch (e) { r = { speech: e.message }; }
    }
    if (!r) { if (speakFallback) speak('I can navigate, find places, add stops, report hazards, or tell you what\'s ahead.'); return false; }
    if (r.ask) { speak(r.ask); return true; }
    if (r.action === 'home') { await goHome(r.which); return true; }
    if (r.action === 'open_saved') { go('saved'); return true; }
    if (r.action === 'save_here') { if (!E.me) { speak('I need your location first.'); return true; } speak('Saving this spot.'); savePlaceSheet({ name: E.road ? `Near ${E.road}` : 'My location', lat: E.me.lat, lng: E.me.lng }); return true; }
    if (r.action === 'share_location') { await shareLiveLocation(); return true; }
    if (r.action === 'remind') { reminderSheet({ whenText: r.when }); return true; }
    if (r.action === 'undo') { if (lastReportId) { undoReport(lastReportId); lastReportId = null; speak('Removed your last report.'); } else speak('Nothing to undo.'); return true; }
    if (r.action === 'start_drive') { await startDrive(); return true; }
    if (r.action === 'stop_drive') { stopDrive(); speak('Drive mode off.'); return true; }
    if (r.action === 'report') { await doReport(r.report_type || 'Other', r.report_note); return true; }
    if (r.action === 'share_drive') { bus.emit('share-drive'); return true; }
    if (r.action === 'find_parking') { bus.emit('go', 'parking'); return true; }
    if (r.action === 'end_nav') { endNav(); speak('Navigation ended.'); return true; }
    if (r.action === 'voice') { setVoice(r.mode); if (r.mode === 'mute') toast('Muted. Say "unmute" or tap 🔇 to turn voice back on.'); return true; }
    if (r.action === 'recenter') { recenter(); go('map'); speak('Centered on you.'); return true; }
    if (r.action === 'alt') { if (!navOn()) speak('Start navigation first.'); else if (!switchAlt(0)) speak('There\'s no alternative route right now.'); return true; }
    if (r.action === 'stop') {
      if (!navOn()) { speak('Start navigation first, then I can add stops along the way.'); return true; }
      const k = STOP_KINDS.find(([key, , lb]) => new RegExp(`\\b(${key}|${lb.split(' ')[0]})`, 'i').test(r.q)) || (/gas|fuel/.test(r.q) ? STOP_KINDS[0] : /cash|bank/.test(r.q) ? STOP_KINDS[2] : /bathroom|restroom|toilet/.test(r.q) ? STOP_KINDS.find(([key]) => key === 'restroom') : /charg/.test(r.q) ? STOP_KINDS.find(([key]) => key === 'charge') : /eat|food|lunch|dinner|burger/.test(r.q) ? STOP_KINDS.find(([key]) => key === 'food') : null);
      speak(k ? `Looking for ${k[2].toLowerCase()} along your route.` : `Looking for ${r.q} along your route.`);
      stopSheet(k ? k[0] : undefined);
      if (!k) setTimeout(() => { const i = $('#st-q'); if (i) { i.value = r.q; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); } }, 300);
      return true;
    }
    if (r.action === 'ask') {
      speak('Checking the map.');
      askSheet(r.q);
      try { speak(await askSpoken(r.q)); } catch (e) { speak(e.message || 'I couldn\'t check that.'); }
      return true;
    }
    if (r.action === 'navigate') {
      const sv = findSaved(r.place);
      if (sv) { speak(`Navigating to ${sv.name}.`); await startNav({ dest: { lat: sv.lat, lng: sv.lng, label: sv.name }, name: sv.name }); return true; }
      speak(`Finding ${r.place}.`);
      const near = E.me || {};
      const q = new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'us', q: r.place, viewbox: '-79.50,39.75,-75.00,37.85', bounded: '1' });
      if (near.lat) q.set('viewbox', `${near.lng - 0.6},${near.lat + 0.45},${near.lng + 0.6},${near.lat - 0.45}`);
      let hit = null;
      try { hit = (await (await fetch('https://nominatim.openstreetmap.org/search?' + q)).json())[0]; } catch { /* offline */ }
      if (!hit) { speak(`I couldn't find ${r.place}. Try the Drive tab.`); return true; }
      const label = hit.display_name;
      await startNav({ dest: { lat: +hit.lat, lng: +hit.lon, label }, name: label.split(',')[0] });
      return true;
    }
    if (r.action === 'park_check') {
      if (!E.me) { speak('I need your location first. Start drive mode or tap locate.'); return true; }
      speak('Checking parking tickets here.');
      const res = await checkParkingAt(E.me, 'you');
      speak(res.error ? res.error : spokenRisk(res) || 'There\'s no parking ticket data for this area. Read the signs before you leave the car.');
      return true;
    }
    if (r.speech) speak(r.speech);
    return true;
  } catch (e) { toast(e.message || 'Voice failed'); return true; }
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
