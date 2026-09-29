// Parking help: find garages and lots nearby, mark where you parked (photo, note, meter timer), find your car.
import { S, save } from './store.js';
import { $, $$, esc, dist, fmtDist, toast, uuid, bus, stamp } from './util.js';
import { map, pin } from './mapview.js';
import { E } from './engine.js';
import { locateOnce, notify, beep, speak } from './native.js';
import { pageHead, bindBack, busy, startPick, geoFail, go } from './ui.js';
import { pushReminder, unpushReminder } from './netlify.js';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const layer = L.layerGroup().addTo(map);
const carIcon = pin('#1d6cf0', '🚗');
const lotIcon = pin('#2b6b3f', '🅿️');
let results = [], searchAt = null, searchLabel = '';

const walkUrl = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=walking`;
const driveUrl = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving&dir_action=navigate`;
const clock = (t) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

// ---------------------------------------------------------------- data
const TYPE = { 'multi-storey': 'Garage', underground: 'Underground garage', surface: 'Lot', rooftop: 'Rooftop garage', street_side: 'Street-side', lane: 'Street lane', 'park_and_ride': 'Park & ride' };
/** Overpass parking elements → list, nearest first. */
export function parseParking(js, near) {
  const out = [];
  for (const el of js?.elements || []) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    if (lat == null || /^(private|no|customers|delivery|permit)$/.test(t.access || '')) continue;
    const kind = t.park_ride && t.park_ride !== 'no' ? 'Park & ride' : TYPE[t.parking] || 'Parking';
    out.push({ id: el.type + el.id, lat, lng, name: t.name || t.operator || kind, kind,
      fee: t.fee === 'yes' ? 'Paid' : t.fee === 'no' ? 'Free' : null, cap: t.capacity ? +t.capacity || null : null,
      hours: t.opening_hours || null, ev: !!(t['capacity:charging'] || t['socket:type2']), d: dist(near, { lat, lng }) });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, 25);
}
async function search(near, label) {
  const q = `[out:json][timeout:20];nwr(around:900,${near.lat},${near.lng})[amenity=parking];out center tags 60;`;
  const r = await fetch(OVERPASS, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (!r.ok) throw new Error('Parking search is busy. Try again in a minute.');
  results = parseParking(await r.json(), near); searchAt = near; searchLabel = label;
  drawLayer();
}
function drawLayer() {
  layer.clearLayers();
  const car = S.db.parking;
  if (car) L.marker([car.lat, car.lng], { icon: carIcon, zIndexOffset: 500 }).bindPopup(`<b>Your car</b><br>Parked ${stamp(car.at)}${car.note ? '<br>' + esc(car.note) : ''}`).addTo(layer);
  results.forEach((p) => L.marker([p.lat, p.lng], { icon: lotIcon }).bindPopup(`<b>${esc(p.name)}</b><br>${esc(p.kind)}${p.fee ? ' · ' + p.fee : ''}${p.cap ? ' · ' + p.cap + ' spaces' : ''}<br><a href="${driveUrl(p)}" target="_blank" rel="noopener">Directions</a>`).addTo(layer));
}

// ---------------------------------------------------------------- meter reminder
let meterTimer = null;
function armMeter() {
  clearTimeout(meterTimer);
  const car = S.db.parking;
  if (!car?.meterUntil) return;
  const at = car.meterUntil - 10 * 60000;
  const fire = () => {
    const left = Math.max(0, Math.round((car.meterUntil - Date.now()) / 60000));
    const msg = left ? `Your parking runs out in ${left} min, at ${clock(car.meterUntil)}.` : 'Your parking time is up.';
    toast(msg, 8000); beep(); speak(msg); notify('Parking meter', msg);
  };
  if (at > Date.now()) meterTimer = setTimeout(fire, Math.min(at - Date.now(), 2 ** 31 - 1));
}

// ---------------------------------------------------------------- mark / clear
async function markHere(extra = {}) {
  let at = E.me;
  if (!at) { try { at = await locateOnce(); } catch (e) { geoFail(e); return; } }
  setCar({ lat: at.lat, lng: at.lng, ...extra });
}
function setCar(v) {
  const old = S.db.parking;
  if (old?.remindId) unpushReminder(old.remindId);
  S.db.parking = { id: uuid(), at: Date.now(), note: '', level: '', photo: null, meterUntil: null, ...v };
  save(); drawLayer(); armMeter();
  toast('Parking spot saved');
}
export function clearCar() {
  const old = S.db.parking;
  if (old?.remindId) unpushReminder(old.remindId);
  S.db.parking = null; save(); drawLayer(); clearTimeout(meterTimer);
}
async function shrinkPhoto(file) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const k = Math.min(1, 900 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(img.src);
  return c.toDataURL('image/jpeg', 0.6);
}

// ---------------------------------------------------------------- page
export function renderParking() {
  const host = $('#p-parking');
  const car = S.db.parking;
  const near = S.parkNear || null;
  const meterLeft = car?.meterUntil ? Math.round((car.meterUntil - Date.now()) / 60000) : null;
  host.innerHTML = `${pageHead('Parking', 'Find a spot, and find your car again')}
    <div class="card sec">
      <h2>Your car</h2>
      ${car ? `
        <p style="margin:0">Parked <b>${stamp(car.at)}</b>${E.me ? ` · ${fmtDist(dist(E.me, car))} from you` : ''}</p>
        ${car.level || car.note ? `<p class="small" style="margin:0">${esc([car.level && 'Level/spot: ' + car.level, car.note].filter(Boolean).join(' · '))}</p>` : ''}
        ${car.meterUntil ? `<p class="small ${meterLeft < 15 ? 'bad' : ''}" style="margin:0">Meter runs out at <b>${clock(car.meterUntil)}</b>${meterLeft > 0 ? ` (${meterLeft} min left)` : ' (time is up)'}</p>` : ''}
        ${car.photo ? `<img class="carphoto" src="${car.photo}" alt="Photo of where you parked">` : ''}
        <div class="btns"><a class="btn primary" href="${walkUrl(car)}" target="_blank" rel="noopener">Walk to my car</a><button class="btn" id="pk-show">Show on map</button></div>
        <details class="lib"><summary>Edit note, photo or meter</summary><div class="sec" style="padding-bottom:14px">${editor(car)}</div></details>
        <div class="btns"><button class="btn danger" id="pk-clear">I've left, clear it</button></div>`
      : `<p class="note" style="margin:0">Save where you parked so you can walk back to it later. Add a photo of the level sign or a timer for the meter.</p>
        <div class="sec">${editor({})}</div>
        <div class="btns"><button class="btn primary" id="pk-mark">Save my spot here</button><button class="btn" id="pk-pick">Pick on map</button></div>`}
    </div>
    <div class="card sec">
      <h2>Find parking</h2>
      <p class="note" style="margin:0">Garages and lots from OpenStreetMap within about half a mile. Private and customer-only lots are left out. Many DC and Maryland street meters are paid in the ParkMobile app.</p>
      <div class="btns">${near ? `<button class="btn primary" data-near="dest">Near ${esc((near.label || 'my destination').split(',')[0])}</button>` : ''}<button class="btn${near ? '' : ' primary'}" data-near="me">Near me</button><button class="btn" data-near="map">Near the map center</button></div>
      <div id="pk-res" class="sec">${resultsHtml()}</div>
    </div>`;
  bindBack(host);
  const readEditor = () => ({ note: $('#pk-note').value.trim().slice(0, 200), level: $('#pk-level').value.trim().slice(0, 40), meterMin: +$('#pk-meter').value || 0 });
  const withMeter = async (v, photo) => {
    const out = { note: v.note, level: v.level, photo: photo ?? car?.photo ?? null, meterUntil: v.meterMin ? Date.now() + v.meterMin * 60000 : null };
    if (out.meterUntil) {
      out.remindId = 'rem_' + uuid().replace(/-/g, '').slice(0, 20);
      const ok = await pushReminder({ id: out.remindId, at: out.meterUntil - 10 * 60000, title: 'Parking meter', body: `Your parking runs out at ${clock(out.meterUntil)}.`, url: './#parking' });
      if (!ok) delete out.remindId;
    }
    return out;
  };
  let photo = null;
  $('#pk-photo').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { photo = await shrinkPhoto(f); $('#pk-photo-state').textContent = 'Photo added'; } catch { toast('Could not read that photo'); } };
  if (car) {
    $('#pk-show').onclick = () => { go('map'); map.setView([car.lat, car.lng], 18); };
    $('#pk-clear').onclick = () => { clearCar(); renderParking(); toast('Cleared'); };
    $('#pk-save').onclick = async () => { const v = await withMeter(readEditor(), photo); if (car.remindId && car.remindId !== v.remindId) unpushReminder(car.remindId); Object.assign(S.db.parking, v); save(); armMeter(); drawLayer(); renderParking(); toast('Updated'); };
  } else {
    $('#pk-mark').onclick = async (e) => { busy(e.currentTarget, true, 'Saving…'); await markHere(await withMeter(readEditor(), photo)); renderParking(); };
    $('#pk-pick').onclick = async () => { const v = await withMeter(readEditor(), photo); startPick(null, (lat, lng) => { setCar({ lat, lng, ...v }); go('parking'); }); };
  }
  $$('[data-near]', host).forEach((b) => (b.onclick = async () => {
    let at, label;
    if (b.dataset.near === 'dest') { at = near; label = (near.label || 'your destination').split(',')[0]; }
    else if (b.dataset.near === 'map') { const c = map.getCenter(); at = { lat: c.lat, lng: c.lng }; label = 'the map center'; }
    else { try { at = E.me || (await locateOnce()); label = 'you'; } catch (e) { geoFail(e); return; } }
    busy(b, true, 'Searching…');
    try { await search(at, label); } catch (e) { toast(e.message); }
    busy(b, false); $('#pk-res').innerHTML = resultsHtml(); bindResults();
  }));
  bindResults();
}
function editor(car) {
  const left = car.meterUntil ? Math.max(0, Math.round((car.meterUntil - Date.now()) / 60000)) : '';
  return `<div class="grid2"><label class="f">Level / spot<input type="text" id="pk-level" maxlength="40" value="${esc(car.level || '')}" placeholder="P3, row G"></label>
      <label class="f">Meter time (minutes)<input type="number" id="pk-meter" min="0" max="720" step="15" value="${left}" placeholder="e.g. 120"></label></div>
    <label class="f">Note<input type="text" id="pk-note" maxlength="200" value="${esc(car.note || '')}" placeholder="Near the elevator, blue garage"></label>
    <div class="btns"><label class="btn">📷 ${car.photo ? 'Replace photo' : 'Add a photo'}<input type="file" id="pk-photo" accept="image/*" capture="environment" hidden></label><span class="note" id="pk-photo-state"></span></div>
    ${car.lat != null ? '<button class="btn" id="pk-save">Save changes</button>' : ''}
    <p class="note" style="margin:0">With a meter time, you're reminded 10 minutes before it runs out${S.db.pushOn ? ', even if the app is closed' : ' while the app is open. Turn on phone notifications in Settings to be reminded when it is closed'}.</p>`;
}
function resultsHtml() {
  if (!searchAt) return '';
  if (!results.length) return `<div class="empty">No public garages or lots found near ${esc(searchLabel)}. Try the map center after moving the map.</div>`;
  return `<p class="note" style="margin:0">${results.length} near ${esc(searchLabel)}, closest first</p>` + results.map((p) => `<div class="row g"><span class="emo">🅿️</span><div class="main">
    <div class="ttl">${esc(p.name)}</div><div class="meta">${esc(p.kind)} · ${fmtDist(p.d)}${p.fee ? ' · ' + p.fee : ''}${p.cap ? ' · ' + p.cap + ' spaces' : ''}${p.ev ? ' · EV charging' : ''}</div>
    ${p.hours ? `<div class="meta">Hours: ${esc(p.hours)}</div>` : ''}</div>
    <div class="acts"><button class="sbtn" data-lot="${p.id}">Map</button><a class="sbtn linkbtn" href="${driveUrl(p)}" target="_blank" rel="noopener">Go</a></div></div>`).join('');
}
function bindResults() {
  $$('[data-lot]').forEach((b) => (b.onclick = () => { const p = results.find((x) => x.id === b.dataset.lot); go('map'); map.setView([p.lat, p.lng], 17); }));
}

// ---------------------------------------------------------------- after a drive, offer to save the spot
function offerMark() {
  if (!E.me) return;
  $('.undobar')?.remove();
  const el = document.createElement('div'); el.className = 'undobar';
  el.innerHTML = '<span>🅿️ Save where you parked?</span><button>Save spot</button>';
  el.querySelector('button').onclick = () => { el.remove(); markHere(); };
  document.body.appendChild(el); setTimeout(() => el.remove(), 12000);
}
bus.on('drive', (on) => { if (!on) setTimeout(offerMark, 400); });
bus.on('arrived', () => setTimeout(offerMark, 3000));

drawLayer();
armMeter();
