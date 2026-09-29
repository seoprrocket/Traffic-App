// Shared UI pieces: sheets, the location picker, and the add/edit forms.
import { S, save, upsertLocal, queue } from './store.js';
import { $, $$, esc, toast, today, uuid, DIRS, scrub, bus } from './util.js';
import { map, layers, icons, RTYPES, rcat } from './mapview.js';
import { locateOnce } from './native.js';
import { E } from './engine.js';
import { agent, flush, loadCommunity, cloudConfigured } from './cloud.js';

export const go = (v) => bus.emit('go', v);

// ---------------------------------------------------------------- sheets
export function openSheet(html, setup) {
  closeSheet();
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  ov.addEventListener('click', (e) => { if (e.target === ov) closeSheet(); });
  $('#layer').appendChild(ov);
  ov.querySelector('[data-close]')?.addEventListener('click', closeSheet);
  setup?.(ov.querySelector('.sheet'));
}
export function closeSheet() { $('#layer').innerHTML = ''; }
export const head = (t) => `<div class="sheethead"><h3>${t}</h3><button class="iconbtn" data-close aria-label="Close">✕</button></div>`;
export const pageHead = (title, sub) => `<div class="pagehead"><button class="back" data-back>← More</button><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div></div>`;
export function bindBack(root) { $$('[data-back]', root).forEach((b) => (b.onclick = () => go('more'))); }

export function confirmDel(btn, fn) {
  if (btn.dataset.armed) { fn(); return; }
  const orig = btn.textContent; btn.dataset.armed = 1; btn.textContent = 'Tap again';
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = orig; } }, 3000);
}
export function geoFail(e) { toast(e && e.code === 1 ? 'Location is blocked. Allow it in your settings.' : 'Couldn\'t get your location. Open the app over https or in the phone app.'); }
export function busy(btn, on, text) { if (!btn) return; if (on) { btn.dataset.label = btn.textContent; btn.textContent = text || 'Working…'; btn.disabled = true; } else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; } }

// ---------------------------------------------------------------- location picker
let picking = null;
export function locWidget(host, state, label, onChange) {
  function paint() {
    host.innerHTML = `<label class="f">${label}<input type="search" placeholder="Street, intersection or address" value="${esc(state.q || '')}"></label>
      <div class="btns"><button type="button" class="btn" data-a="find">Search</button><button type="button" class="btn" data-a="gps">Use my location</button><button type="button" class="btn" data-a="map">Pick on map</button></div>
      <div class="results"></div>
      <div class="picked">${state.lat != null ? `Set to <b>${esc(state.label || 'Pinned spot')}</b><br><span class="mono">${(+state.lat).toFixed(5)}, ${(+state.lng).toFixed(5)}</span>` : 'No location set yet'}</div>`;
    const inp = host.querySelector('input'), res = host.querySelector('.results');
    inp.oninput = () => { state.q = inp.value; };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } };
    host.querySelector('[data-a=find]').onclick = find;
    host.querySelector('[data-a=gps]').onclick = () => (E.me ? Promise.resolve(E.me) : locateOnce()).then((p) => set(p.lat, p.lng, 'My location')).catch(geoFail);
    host.querySelector('[data-a=map]').onclick = () => startPick(state, (lat, lng) => set(lat, lng, 'Pinned on map'));
    async function find() {
      const q = (inp.value || '').trim(); if (!q) return;
      res.innerHTML = '<span class="note">Searching…</span>';
      try {
        const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=us&viewbox=-79.50,39.75,-75.00,37.85&bounded=1&q=' + encodeURIComponent(q);
        const js = await (await fetch(url, { headers: { Accept: 'application/json' } })).json();
        if (!js.length) { res.innerHTML = '<span class="note">Nothing found nearby. Add the city, like "Rockville Pike & Nicholson Ln, Rockville MD", or pick it on the map.</span>'; return; }
        res.innerHTML = '';
        js.forEach((x) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = x.display_name.replace(/, United States$/, ''); b.onclick = () => set(+x.lat, +x.lon, b.textContent); res.appendChild(b); });
      } catch { res.innerHTML = '<span class="note">Search is offline. Use "Pick on map" instead.</span>'; }
    }
  }
  function set(lat, lng, lbl) { state.lat = +(+lat).toFixed(6); state.lng = +(+lng).toFixed(6); state.label = lbl; paint(); onChange?.(state); }
  paint();
  return { paint, set };
}
export function startPick(state, cb) {
  const ov = $('.overlay'); if (ov) ov.style.display = 'none';
  picking = { cb, ov, from: S.view };
  go('map'); $('#pickbar').hidden = false;
  if (state && state.lat != null) map.setView([state.lat, state.lng], 17); else if (map.getZoom() < 15) map.setZoom(15);
}
function endPick() {
  const p = picking; $('#pickbar').hidden = true; if (p?.ov) p.ov.style.display = '';
  picking = null; layers.temp.clearLayers();
  if (p && p.from && p.from !== 'map' && !p.ov) go(p.from);
}
$('#pickCancel').onclick = endPick;
map.on('click', (e) => {
  if (!picking) return;
  const p = picking; layers.temp.clearLayers(); L.marker(e.latlng, { icon: icons.temp }).addTo(layers.temp);
  setTimeout(() => { endPick(); p.cb(e.latlng.lat, e.latlng.lng); }, 250);
});

// ---------------------------------------------------------------- add menu
export function addChooser() {
  openSheet(`${head('Add')}
  <div class="choice">
   <button data-k="scan"><span class="ic" style="background:var(--you)">📸</span><span><b>Scan or import tickets</b><small>Photo of the notice, a screenshot from cite-web.com or another ticket site, a PDF, or pasted text.</small></span></button>
   <button data-k="ticket"><span class="ic" style="background:var(--danger)">⚠️</span><span><b>Type in a ticket</b><small>Street, fine, speed. You'll get a caution alert on this street.</small></span></button>
   <button data-k="camera"><span class="ic" style="background:var(--warn)">📷</span><span><b>Camera location</b><small>Pin it exactly. You'll get a ${S.db.settings.lead}-minute warning.</small></span></button>
   <button data-k="report"><span class="ic" style="background:var(--report)">📣</span><span><b>Report a sighting</b><small>Police, ICE activity, icy road, new camera, hazard.</small></span></button>
  </div>`, (s) => $$('[data-k]', s).forEach((b) => (b.onclick = () => ({ scan: scanTicket, ticket: () => ticketForm(), camera: () => cameraForm(), report: () => reportForm() })[b.dataset.k]())));
}

// ---------------------------------------------------------------- ticket form
export const TYPES = ['Speed camera', 'Red light camera', 'Stop sign camera', 'Speed (officer)', 'Bus lane', 'Parking', 'Other'];
export const PARKING_REASONS = ['Expired meter', 'Over the time limit', 'Residential permit zone', 'Rush-hour / tow-away zone', 'Street sweeping', 'Emergency or temporary no parking', 'No parking / no standing', 'Too close to a fire hydrant', 'Loading or bus zone', 'Crosswalk, corner, driveway or alley', 'Expired tags or registration', 'Other'];
const isParking = (t) => /^parking/i.test(t || '');
export const ATYPES = [['visual', 'Visual popup only'], ['sound', 'Popup + warning sound'], ['voice', 'Popup + sound + spoken warning']];
export const atOpts = (sel) => ATYPES.map(([k, l]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${l}</option>`).join('');

export function ticketFields(d, px) {
  return `<label class="f">Street name (how you'll recognize it)<input type="text" id="${px}-street" required maxlength="160" value="${esc(d.street || '')}" placeholder="e.g. New York Ave NE"></label>
    <div class="loc" id="${px}-loc"></div>
    <div class="grid3 mvonly"${isParking(d.type) ? ' hidden' : ''}>
      <label class="f">Speed limit<input type="number" id="${px}-limit" inputmode="numeric" min="0" max="100" value="${d.limit ?? ''}"></label>
      <label class="f">Your speed<input type="number" id="${px}-speed" inputmode="numeric" min="0" max="200" value="${d.speed ?? ''}"></label>
      <label class="f">Fine ($)<input type="number" id="${px}-fine" inputmode="decimal" min="0" value="${d.fine ?? ''}"></label>
    </div>
    <div class="grid3">
      <label class="f">Date<input type="date" id="${px}-date" value="${esc(d.date || '')}"></label>
      <label class="f">Time<input type="time" id="${px}-time" value="${esc(d.time || '')}"></label>
      <label class="f">Type<select id="${px}-type">${TYPES.map((x) => `<option${x === d.type ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
    </div>
    <div class="grid2 pkonly"${isParking(d.type) ? '' : ' hidden'}>
      <label class="f">What for<select id="${px}-viol"><option value="">Choose…</option>${PARKING_REASONS.map((x) => `<option${x === d.violation ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="f">Fine ($)<input type="number" id="${px}-pfine" inputmode="decimal" min="0" value="${d.fine ?? ''}"></label>
    </div>
    <div class="grid2">
      <label class="f">Pay or contest by<input type="date" id="${px}-due" value="${esc(d.due || '')}"></label>
      <label class="f">Alert for this spot<select id="${px}-at">${atOpts(d.alertType || S.db.settings.alertType)}</select></label>
    </div>
    <label class="f">Notes<textarea id="${px}-notes" maxlength="1000" placeholder="Camera is on the light pole past the bridge">${esc(d.notes || '')}</textarea></label>
    <label class="switch"><input type="checkbox" id="${px}-share" ${(d.shared ?? S.db.settings.share) ? 'checked' : ''}><span><b>Share anonymized with the community</b><small>Rounded location, month, type and fine range only.</small></span></label>`;
}
export function readTicket(root, px, st, rec) {
  const g = (id) => root.querySelector(`#${px}-${id}`);
  Object.assign(rec, {
    street: g('street').value.trim(), lat: st.lat, lng: st.lng, date: g('date').value, time: g('time').value, due: g('due').value, type: g('type').value,
    fine: +(isParking(g('type').value) ? g('pfine') : g('fine')).value || 0, notes: g('notes').value.trim(),
    speed: isParking(g('type').value) ? null : +g('speed').value || null, limit: isParking(g('type').value) ? null : +g('limit').value || null,
    violation: isParking(g('type').value) ? g('viol').value : '',
    alertType: g('at').value, shared: g('share').checked,
  });
  delete rec.example; return rec;
}
/** Parking tickets ask "what for" instead of speed; keeps the two fine boxes in sync. */
export function bindTicketType(root, px) {
  const ty = root.querySelector(`#${px}-type`), f1 = root.querySelector(`#${px}-fine`), f2 = root.querySelector(`#${px}-pfine`);
  const sync = () => { const p = isParking(ty.value); root.querySelector('.mvonly').hidden = p; root.querySelector('.pkonly').hidden = !p;
    const cam = root.querySelector(`#${px}-cam`)?.closest('label'); if (cam) cam.hidden = !/camera/i.test(ty.value);
    const notes = root.querySelector(`#${px}-notes`); if (notes) notes.placeholder = p ? 'Sign said 2 hr parking 7am–6:30pm, zone 2' : 'Camera is on the light pole past the bridge'; };
  ty.addEventListener('change', sync);
  f1.addEventListener('input', () => { f2.value = f1.value; }); f2.addEventListener('input', () => { f1.value = f2.value; });
  sync();
}
const autoName = (el, x) => { if (!el.value && x.label && x.label !== 'My location' && x.label !== 'Pinned on map') el.value = x.label.split(',')[0]; };

export function ticketForm(t, preset) {
  const base = t || { date: today(), type: 'Speed camera', ...(preset?.ticket || {}) };
  const st = t ? { lat: t.lat, lng: t.lng, label: t.street } : { ...(preset?.location || {}) };
  const cam = preset?.camera;
  openSheet(`${head(t ? 'Edit ticket' : preset ? 'Check the scanned ticket' : 'Add ticket')}
    ${preset ? `<div class="privacy">${preset.confidence === 'low' ? '<b>Low confidence.</b> ' : ''}${esc(preset.note || 'Check each field before saving.')}</div>` : ''}
    <form id="tf" class="sec">${ticketFields(base, 'tf')}
      ${!t && /camera/i.test(base.type || '') ? (cam
        ? `<div class="privacy">Matches <b>${esc(cam.name)}</b> on the official camera list (${cam.meters} m away). You're already covered by its warning.</div>`
        : `<label class="switch"><input type="checkbox" id="tf-cam" checked><span><b>Also mark a camera here</b><small>So you get the ${S.db.settings.lead}-minute warning next time.</small></span></label>`) : ''}
      <button class="btn primary" type="submit">${t ? 'Save changes' : 'Save ticket'}</button></form>`, (s) => {
    locWidget(s.querySelector('#tf-loc'), st, 'Where exactly', (x) => autoName(s.querySelector('#tf-street'), x));
    bindTicketType(s, 'tf');
    s.querySelector('#tf').onsubmit = (e) => {
      e.preventDefault();
      if (st.lat == null) { toast('Set the location: search, use GPS, or pick on the map'); return; }
      const rec = readTicket(s, 'tf', st, t ? { ...t } : { id: uuid(), created: Date.now() });
      upsertLocal('tickets', rec);
      if (s.querySelector('#tf-cam')?.checked) {
        upsertLocal('cameras', { id: uuid(), name: rec.street, lat: rec.lat, lng: rec.lng, kind: rec.type.replace(/ camera$/i, ''), limit: rec.limit, heading: preset?.heading ?? null });
      }
      bus.emit('ticket-saved', rec);
      closeSheet(); toast(t ? 'Ticket updated' : isParking(rec.type) ? 'Parking ticket saved. You\'ll be warned when you park near here.' : 'Ticket saved. You\'ll get a caution alert here.');
      if (preset?.onSaved) { preset.onSaved(rec); return; }
      go('map'); map.setView([rec.lat, rec.lng], 16);
    };
  });
}

// ---------------------------------------------------------------- camera form
const KINDS = ['Speed', 'Red light', 'Stop sign', 'Truck', 'Bus lane', 'School bus', 'Mobile / van'];
export function cameraForm(c) {
  const st = c ? { lat: c.lat, lng: c.lng, label: c.name } : {};
  const d = c || { kind: 'Speed', heading: null };
  openSheet(`${head(c ? 'Edit camera' : 'Add camera')}
    <form id="cf" class="sec">
      <label class="f">Name<input type="text" id="cf-name" required maxlength="200" value="${esc(d.name || '')}" placeholder="e.g. Suitland Pkwy SE eastbound"></label>
      <div class="loc" id="cf-loc"></div>
      <p class="note" style="margin:0">For the exact spot, choose "Pick on map", zoom all the way in and tap the pole. You can drag the pin later.</p>
      <div class="grid2">
        <label class="f">Camera type<select id="cf-kind">${KINDS.map((x) => `<option${x === d.kind ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
        <label class="f">Speed limit (mph)<input type="number" id="cf-limit" inputmode="numeric" min="0" max="100" value="${d.limit ?? ''}"></label>
      </div>
      <label class="f">Direction it catches<select id="cf-dir"><option value="">Both directions / not sure</option>${DIRS.map(([n, h]) => `<option value="${h}"${d.heading === h ? ' selected' : ''}>${n}-bound traffic</option>`).join('')}</select></label>
      ${E.heading != null ? '<button type="button" class="btn" id="cf-myhead">Use the direction I\'m driving</button>' : ''}
      <button class="btn primary" type="submit">${c ? 'Save changes' : 'Save camera'}</button>
    </form>`, (s) => {
    locWidget(s.querySelector('#cf-loc'), st, 'Camera location', (x) => autoName(s.querySelector('#cf-name'), x));
    s.querySelector('#cf-myhead')?.addEventListener('click', () => {
      const sel = s.querySelector('#cf-dir'); const h = Math.round(E.heading / 45) * 45 % 360; sel.value = String(h); toast('Direction set');
    });
    s.querySelector('#cf').onsubmit = (e) => {
      e.preventDefault();
      if (st.lat == null) { toast('Set the camera location first'); return; }
      const dir = s.querySelector('#cf-dir').value;
      const rec = { ...(c || { id: uuid() }), name: s.querySelector('#cf-name').value.trim(), lat: st.lat, lng: st.lng, kind: s.querySelector('#cf-kind').value,
        limit: +s.querySelector('#cf-limit').value || null, heading: dir === '' ? null : +dir };
      upsertLocal('cameras', rec);
      closeSheet(); toast(`Camera saved. ${S.db.settings.lead}-minute warning is on.`);
      go('map'); map.setView([rec.lat, rec.lng], 17);
    };
  });
}

// ---------------------------------------------------------------- report form
export function postReport({ type, lat, lng, place = '', note = '' }) {
  const r = { id: uuid(), type, lat: +(+lat).toFixed(6), lng: +(+lng).toFixed(6), place, note: scrub(note), time: Date.now(), mine: true, status: S.cloud ? 'pending' : 'live' };
  S.db.reports.unshift(r);
  if (S.cloud) {
    S.db.community.unshift({ ...r, expires: Date.now() + 6 * 3600e3, confirms: 0, denies: 0, note: '' });
    queue('reports', 'insert', { id: r.id });
    flush().then(() => setTimeout(loadCommunity, 4000));
  }
  save();
  return r;
}
export function undoReport(id) {
  S.db.reports = S.db.reports.filter((r) => r.id !== id);
  S.db.community = S.db.community.filter((r) => r.id !== id);
  queue('reports', 'delete', { id }); flush(); save();
}
export function reportForm(r) {
  const st = r ? { lat: r.lat, lng: r.lng, label: r.place } : {};
  openSheet(`${head(r ? 'Edit report' : 'Report a sighting')}
    <form id="rf" class="sec">
      <label class="f">What did you see<select id="rf-type">${RTYPES.map((x) => `<option value="${esc(x)}"${r && r.type === x ? ' selected' : ''}>${rcat(x).e} ${x}</option>`).join('')}</select></label>
      <div class="loc" id="rf-loc"></div>
      <label class="f">Details (optional)<textarea id="rf-note" maxlength="280" placeholder="Two unmarked SUVs parked by the Metro entrance, northbound side">${esc(r ? r.note : '')}</textarea></label>
      <p class="note" style="margin:0">Describe the activity and the place. Leave out names, faces and license plates. ${S.cloud ? 'Every report is checked before its details are shown to others.' : ''}</p>
      <button class="btn red" type="submit">${r ? 'Save changes' : 'Post report'}</button>
    </form>`, (s) => {
    if (!r && E.me) { st.lat = +E.me.lat.toFixed(6); st.lng = +E.me.lng.toFixed(6); st.label = 'My location'; }
    const w = locWidget(s.querySelector('#rf-loc'), st, 'Where');
    if (!r && !E.me) locateOnce().then((p) => { if (st.lat == null && s.isConnected) w.set(p.lat, p.lng, 'My location'); }).catch(() => {});
    s.querySelector('#rf').onsubmit = (e) => {
      e.preventDefault();
      if (st.lat == null) { toast('Set where you saw it'); return; }
      const type = s.querySelector('#rf-type').value, note = s.querySelector('#rf-note').value.trim();
      if (r) {
        Object.assign(r, { type, lat: st.lat, lng: st.lng, place: st.label || '', note: scrub(note), edited: Date.now(), status: S.cloud ? 'pending' : r.status });
        if (S.cloud) { queue('reports', 'update', { id: r.id }); flush().then(() => setTimeout(loadCommunity, 4000)); }
        save(); closeSheet(); toast('Report updated');
      } else {
        postReport({ type, lat: st.lat, lng: st.lng, place: st.label || '', note });
        closeSheet(); toast('Report posted'); go('reporting-feed');
      }
    };
  });
}

// ---------------------------------------------------------------- ticket scanner
/** Scanning and importing live on the Import Tickets page (photos, screenshots, PDFs, pasted text). */
export function scanTicket() { closeSheet(); go('import'); }
