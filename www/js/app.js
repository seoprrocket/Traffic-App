// Boot, routing and wiring between modules.
import { S, save, upsertLocal } from './store.js';
import { $, $$, bus, debounce, toast, today, uuid } from './util.js';
import { map, drawMarkers, placeMe, fitAll } from './mapview.js';
import { E, startDrive, stopDrive, overBy } from './engine.js';
import { locateOnce, unlockAudio, isNative } from './native.js';
import { initAuth, flush, loadCommunity, loadOfficialCameras, vote, loadAgentOutputs, cloudConfigured } from './cloud.js';
import { addChooser, scanTicket, reportForm, ticketFields, readTicket, bindTicketType, locWidget, pageHead, bindBack, geoFail } from './ui.js';
import { renderList, renderStats, renderMore } from './pages-main.js';
import { renderDrive, tripTick, paintEta } from './trip.js';
import { renderParking } from './parking.js';
import { renderCommunityMap, renderFeed, renderContrib, renderHeat } from './pages-community.js';
import { renderRoutes, renderCommutes, commuteCheck } from './pages-plan.js';
import { renderCoach, renderTips, renderDispute } from './pages-learn.js';
import { renderProfile, renderAccount, renderLog, renderExport, openSettings, termsGate, renderPrivacy, renderTerms } from './pages-you.js';
import { voiceCommand, showHandsFree, paintHandsFree, setupHandsFree } from './voice.js';

// ---------------------------------------------------------------- Add Location page
const addState = {};
function renderAdd() {
  const host = $('#p-add');
  if (host.dataset.built) return;            // keep what was typed while picking on the map
  host.dataset.built = '1';
  host.innerHTML = `${pageHead('Add Location', 'Log a spot where you got a ticket: speeding, camera or parking')}
    <div class="btns"><button class="btn" id="af-scan">📸 Scan the ticket instead</button></div>
    <form id="af" class="card sec">${ticketFields({ date: today(), type: 'Speed camera' }, 'af')}
      <label class="switch"><input type="checkbox" id="af-cam" checked><span><b>Also mark a camera here</b><small>Adds a camera pin with this speed limit, so you get the ${S.db.settings.lead}-minute warning.</small></span></label>
      <button class="btn primary" type="submit">Save location</button></form>`;
  for (const k in addState) delete addState[k];
  locWidget(host.querySelector('#af-loc'), addState, 'Address or intersection', (x) => {
    const el = host.querySelector('#af-street'); if (!el.value && x.label && !/^(My location|Pinned on map)$/.test(x.label)) el.value = x.label.split(',')[0];
  });
  bindTicketType(host, 'af');
  host.querySelector('#af-scan').onclick = scanTicket;
  host.querySelector('#af').onsubmit = (e) => {
    e.preventDefault();
    if (addState.lat == null) { toast('Set the address: search, use GPS, or pick on the map'); return; }
    const rec = readTicket(host, 'af', addState, { id: uuid(), created: Date.now() });
    upsertLocal('tickets', rec);
    if (host.querySelector('#af-cam').checked && /camera/i.test(rec.type)) {
      upsertLocal('cameras', { id: uuid(), name: rec.street, lat: rec.lat, lng: rec.lng, kind: rec.type.replace(/ camera$/i, ''), limit: rec.limit, heading: null });
    }
    delete host.dataset.built;
    toast('Location saved'); show('map'); map.setView([rec.lat, rec.lng], 16);
  };
  bindBack(host);
}

// ---------------------------------------------------------------- router
const TABS = ['map', 'list', 'stats', 'route', 'more'];
const PAGES = {
  'add-location': { t: 'Add Location', e: '➕', d: 'Log a ticket spot by address', g: 'Log', r: renderAdd },
  'scan': { t: 'Scan a Ticket', e: '📸', d: 'Photo of the notice fills it all in', g: 'Log', act: scanTicket },
  'parking': { t: 'Parking', e: '🅿️', d: 'Find a spot, mark where you parked', g: 'Plan', r: renderParking },
  'saved-routes': { t: 'Saved Routes', e: '🧭', d: 'Your frequent trips, pre-checked', g: 'Plan', r: renderRoutes },
  'commute-schedules': { t: 'Commute Schedules', e: '🗓', d: 'Warnings before you leave', g: 'Plan', r: renderCommutes },
  'driving-coach': { t: 'Driving Coach', e: '🎯', d: 'Weekly review and tips', g: 'Learn', r: renderCoach },
  'dispute': { t: 'Dispute Help', e: '⚖️', d: 'Options and a draft statement', g: 'Learn', r: renderDispute },
  'safety-tips': { t: 'Safety Tips', e: '📘', d: 'How to avoid citations', g: 'Learn', r: renderTips },
  'community-map': { t: 'Community Map', e: '🗺', d: 'Live sightings and hotspots', g: 'Community', r: renderCommunityMap },
  'reporting-feed': { t: 'Reporting Feed', e: '📣', d: 'Latest reports, newest first', g: 'Community', r: renderFeed },
  'my-contributions': { t: 'My Contributions', e: '✍️', d: 'Edit or delete what you posted', g: 'Community', r: renderContrib },
  'risk-heatmap': { t: 'Risk Heatmap', e: '🔥', d: 'DC, Maryland and Virginia', g: 'Community', r: renderHeat },
  'driver-profile': { t: 'Driver Profile', e: '👤', d: 'Summary, sharing, commute', g: 'You', r: renderProfile },
  'account': { t: 'Account', e: '🔑', d: 'Sign in, sync, delete', g: 'You', r: renderAccount },
  'alert-log': { t: 'Alert Log', e: '🔔', d: 'Every warning and zone entry', g: 'You', r: renderLog },
  'data-export': { t: 'Data Export', e: '⬇️', d: 'Download your records', g: 'You', r: renderExport },
  'privacy': { t: 'Privacy Policy', r: renderPrivacy },
  'terms': { t: 'Terms of Use', r: renderTerms },
};
export function show(v, push = true) {
  if (PAGES[v]?.act) { PAGES[v].act(); return; }
  if (!TABS.includes(v) && !PAGES[v]) v = 'map';
  S.view = v;
  $$('.view').forEach((el) => (el.hidden = el.id !== 'view-' + v));
  const tab = TABS.includes(v) ? v : 'more';
  $$('nav button').forEach((b) => b.setAttribute('aria-selected', b.dataset.v === tab));
  if (push) { const h = v === 'map' ? '' : '#' + v; if (location.hash !== h) history.replaceState(null, '', h || location.pathname); }
  $('main').scrollTop = 0;
  render(v);
}
function render(v) {
  if (v === 'map') setTimeout(() => map.invalidateSize(), 50);
  else if (v === 'list') renderList();
  else if (v === 'stats') renderStats();
  else if (v === 'route') renderDrive();
  else if (v === 'more') renderMore(PAGES);
  else PAGES[v]?.r?.();
}
$$('nav button').forEach((b) => (b.onclick = () => show(b.dataset.v)));
window.addEventListener('hashchange', () => show(location.hash.slice(1) || 'map', false));
bus.on('go', (v) => show(v));

// ---------------------------------------------------------------- header, map buttons
$('#driveBtn').onclick = () => (E.driving ? stopDrive() : startDrive());
$('#setBtn').onclick = openSettings;
$('#fab').onclick = addChooser;
$('#micBtn').onclick = () => { unlockAudio(); voiceCommand(); };
$('#hfBtn').onclick = () => showHandsFree(true);
$('#parkBtn').onclick = () => { S.parkNear = S.db.activeTrip?.dest || null; show('parking'); };
$('#fitBtn').onclick = () => fitAll(E.me);
$('#locBtn').onclick = () => {
  if (E.me) { map.setView([E.me.lat, E.me.lng], 16); follow = true; return; }
  locateOnce().then((p) => { E.me = p; placeMe(p); map.setView([p.lat, p.lng], 16); }).catch(geoFail);
};
let follow = true;
map.on('dragstart', () => { follow = false; });

// ---------------------------------------------------------------- events between modules
const rerender = debounce(() => { drawMarkers(); if (S.view && !['map', 'add-location', 'route', 'parking'].includes(S.view)) render(S.view); }, 60);
bus.on('change', rerender);
bus.on('community', () => { drawMarkers(); if (['community-map', 'reporting-feed', 'my-contributions', 'risk-heatmap'].includes(S.view)) render(S.view); });
bus.on('agents', () => { if (['driving-coach', 'commute-schedules', 'dispute'].includes(S.view)) render(S.view); });
bus.on('drive', () => paintEta());
bus.on('log', debounce(() => { if (S.view === 'alert-log') renderLog(); }, 300));
bus.on('auth', () => { loadOfficialCameras(true); rerender(); });
bus.on('outbox', debounce(() => flush(), 1500));
bus.on('vote', (id, v) => vote(id, v));
bus.on('camera-moved', (id, lat, lng) => { const c = S.db.cameras.find((x) => x.id === id); if (c) { upsertLocal('cameras', { ...c, lat, lng }); toast('Camera position updated'); } });
bus.on('drive', (on) => {
  $('#driveBtn').classList.toggle('on', on); $('#driveBtn').setAttribute('aria-pressed', on); $('#driveLbl').textContent = on ? 'Driving' : 'Start drive';
  $('#speedo').hidden = !on; $('#micBtn').hidden = !on;
  if (on) { follow = true; show('map'); if (S.db.settings.handsFreeAuto) showHandsFree(true); }
  else showHandsFree(false);
});
bus.on('fix', (p) => {
  placeMe(p);
  if (follow && S.view === 'map') map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15), { animate: true });
  const mph = Math.round(p.speed * 2.23694);
  $('#spdVal').textContent = mph;
  $('#limSign').hidden = !E.limitHere; $('#limVal').textContent = E.limitHere || '';
  $('#spdSign').classList.toggle('over', !!E.limitHere && mph > E.limitHere + (overBy() ?? 1));
  paintHandsFree();
});

// ---------------------------------------------------------------- boot
(async function boot() {
  setupHandsFree();
  drawMarkers();
  show(location.hash.slice(1) || 'map', false);
  setTimeout(() => fitAll(null), 150);
  await initAuth();
  loadOfficialCameras();
  termsGate();
  if (!isNative && location.protocol !== 'https:' && !/^(localhost|127\.)/.test(location.hostname)) setTimeout(() => toast('Open this app over https so GPS alerts work'), 900);
  if (!cloudConfigured) console.info('Invictus Traffic Radar: running on this device only (no Supabase config).');
  // live community data while it matters
  setInterval(() => { if (S.cloud && (E.driving || ['map', 'community-map', 'reporting-feed'].includes(S.view))) loadCommunity(); }, 20000);
  setInterval(() => { if (!S.cloud) drawMarkers(); }, 60000);
  setInterval(commuteCheck, 60000); setTimeout(commuteCheck, 4000);
  setInterval(tripTick, 60000); setTimeout(tripTick, 5000);
  paintEta();
  setInterval(flush, 30000);
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  if ('serviceWorker' in navigator && window.isSecureContext && !isNative) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (S.cloud) loadAgentOutputs();
})();
