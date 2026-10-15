// Saved places: Home and Work, your own lists (Favorites, Clients, Date night…), and lists shared with
// friends by a join code — everyone on a shared list can add places. Works offline; syncs when signed in.
import { S, save, persist, upsertLocal, removeLocal, queue } from './store.js';
import { $, $$, esc, dist, fmtDist, ago, toast, uuid, bus, copyText } from './util.js';
import { map, layers } from './mapview.js';
import { E } from './engine.js';
import { openSheet, closeSheet, head, pageHead, bindBack, go, locWidget, confirmDel } from './ui.js';
import { startNav } from './nav.js';
import { saveProfile, joinList } from './cloud.js';

const ICONS = ['⭐', '❤️', '🍽️', '☕', '🏠', '💼', '🛍️', '🎉', '🏋️', '🅿️', '🎓', '🏥', '⛽', '🎯', '🌳', '🎵'];
const P = () => S.db.profile;

// ---------------------------------------------------------------- data
export function lists() { return S.db.lists; }
export function placesIn(listId) { return S.db.places.filter((p) => p.listId === listId).sort((a, b) => (b.time || 0) - (a.time || 0)); }
export function favorites() {
  let l = S.db.lists.find((x) => x.favorites || (x.name === 'Favorites' && x.mine !== false));
  if (!l) { l = { id: uuid(), name: 'Favorites', icon: '⭐', favorites: true, mine: true, created: Date.now() }; upsertLocal('lists', l); }
  return l;
}
export function createList(name, icon = '⭐') {
  const l = { id: uuid(), name: name.trim().slice(0, 60) || 'My list', icon, mine: true, created: Date.now() };
  upsertLocal('lists', l);
  return l;
}
export function addPlace(listId, place) {
  const p = { id: uuid(), listId, name: String(place.name || 'Saved place').slice(0, 120), lat: +place.lat, lng: +place.lng, note: (place.note || '').slice(0, 300), kind: (place.kind || '').slice(0, 40), mine: true, time: Date.now(), created: Date.now() };
  upsertLocal('places', p);
  bus.emit('places');
  return p;
}
export function removePlace(id) { removeLocal('places', id); bus.emit('places'); }
/** Every saved place, with the list it belongs to (for search and the map layer). */
export function allSaved() {
  const byList = Object.fromEntries(S.db.lists.map((l) => [l.id, l]));
  const out = S.db.places.map((p) => ({ ...p, list: byList[p.listId] })).filter((p) => p.list);
  if (P().home) out.unshift({ id: 'home', name: 'Home', lat: P().home.lat, lng: P().home.lng, note: P().home.label || '', list: { icon: '🏠', name: 'Home' }, special: 'home' });
  if (P().work) out.unshift({ id: 'work', name: 'Work', lat: P().work.lat, lng: P().work.lng, note: P().work.label || '', list: { icon: '💼', name: 'Work' }, special: 'work' });
  return out;
}
export function setHomeWork(which, loc) {
  P()[which] = loc ? { lat: +loc.lat, lng: +loc.lng, label: (loc.label || '').slice(0, 120) } : null;
  if (loc?.label && !P()[which + 'Label']) P()[which + 'Label'] = loc.label.split(',').slice(0, 2).join(',').slice(0, 120);
  save(); saveProfile().catch(() => {});
  bus.emit('places');
}
const newCode = () => Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
export function shareLink(l) { return new URL(`#join=${l.shareCode}`, location.href).href; }
export async function shareList(l) {
  if (!S.user) { toast('Sign in (More → Account) to share a list with friends'); go('account'); return; }
  if (!l.shareCode) { l.shareCode = newCode(); upsertLocal('lists', l); }
  const url = shareLink(l), text = `Join my "${l.name}" list in Invictus Traffic Radar — code ${l.shareCode}`;
  try { if (navigator.share) { await navigator.share({ title: l.name, text, url }); return; } } catch (e) { if (e?.name === 'AbortError') return; }
  await copyText(`${text}\n${url}`);
}

// ---------------------------------------------------------------- navigate / voice helpers
export async function goHome(which = 'home') {
  const h = P()[which];
  if (!h) { toast(`Set your ${which} address first`); go('saved'); return false; }
  return startNav({ dest: { lat: h.lat, lng: h.lng, label: h.label || which }, name: which === 'home' ? 'Home' : 'Work' });
}
/** Find a saved place by (part of) its name — "navigate to Mom's" works when it's in a list. */
export function findSaved(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  if (/^(home|my house|my place)$/.test(t)) return allSaved().find((p) => p.special === 'home') || null;
  if (/^(work|the office|my office|my job)$/.test(t)) return allSaved().find((p) => p.special === 'work') || null;
  return allSaved().find((p) => p.name.toLowerCase() === t) || allSaved().find((p) => p.name.toLowerCase().includes(t)) || null;
}

// ---------------------------------------------------------------- map layer
export function drawSaved() {
  if (!layers.saved) layers.saved = L.layerGroup().addTo(map);
  layers.saved.clearLayers();
  allSaved().forEach((p) => {
    const m = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'saved-pin', html: `<span>${p.list.icon}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }) });
    m.bindPopup(`<b>${esc(p.name)}</b><br><small>${esc(p.list.name)}${p.note ? ' · ' + esc(p.note) : ''}</small><div class="popbtns"><button data-sv="nav" data-id="${esc(p.id)}">Navigate</button>${p.special ? '' : `<button data-sv="rm" data-id="${esc(p.id)}">Remove</button>`}</div>`);
    m.addTo(layers.saved);
  });
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.leaflet-popup [data-sv]'); if (!b) return;
  const p = allSaved().find((x) => x.id === b.dataset.id); if (!p) return;
  map.closePopup();
  if (b.dataset.sv === 'nav') startNav({ dest: { lat: p.lat, lng: p.lng, label: p.name }, name: p.name });
  if (b.dataset.sv === 'rm') removePlace(p.id);
});
bus.on('places', drawSaved);
bus.on('change', () => { if (layers.saved) drawSaved(); });

// ---------------------------------------------------------------- "save this place" sheet
export function savePlaceSheet(place, onSaved) {
  const L0 = S.db.lists.length ? S.db.lists : [favorites()];
  openSheet(`${head('Save place')}
    <div class="sec">
      <label class="f">Name<input id="sp-name" maxlength="120" value="${esc(place.name || '')}"></label>
      <label class="f">List<select id="sp-list">${L0.map((l) => `<option value="${l.id}">${l.icon} ${esc(l.name)}${l.shareCode ? ' (shared)' : ''}</option>`).join('')}<option value="__new">➕ New list…</option></select></label>
      <label class="f" id="sp-newf" hidden>New list name<input id="sp-new" maxlength="60" placeholder="Clients, Date night, Kids' activities…"></label>
      <label class="f">Note (optional)<input id="sp-note" maxlength="300" placeholder="Parking in the back, ask for Sam…"></label>
      <div class="btns"><button class="btn primary" id="sp-save">Save</button><button class="btn" id="sp-home">Set as Home</button><button class="btn" id="sp-work">Set as Work</button></div>
    </div>`, (s) => {
    s.querySelector('#sp-list').onchange = (e) => { s.querySelector('#sp-newf').hidden = e.target.value !== '__new'; };
    s.querySelector('#sp-save').onclick = () => {
      let listId = s.querySelector('#sp-list').value;
      if (listId === '__new') listId = createList(s.querySelector('#sp-new').value || 'My list').id;
      const p = addPlace(listId, { ...place, name: s.querySelector('#sp-name').value.trim() || place.name, note: s.querySelector('#sp-note').value.trim() });
      closeSheet(); toast(`Saved to ${S.db.lists.find((l) => l.id === listId)?.name || 'your list'}`); onSaved?.(p);
    };
    s.querySelector('#sp-home').onclick = () => { setHomeWork('home', { ...place, label: place.name }); closeSheet(); toast('Home set'); };
    s.querySelector('#sp-work').onclick = () => { setHomeWork('work', { ...place, label: place.name }); closeSheet(); toast('Work set'); };
  });
}

// ---------------------------------------------------------------- the Saved page
export function renderSaved() {
  const host = $('#p-saved');
  const me = E.me;
  const d = (p) => (me ? ' · ' + fmtDist(dist(me, p)) : '');
  const hw = (which, icon, label) => {
    const v = P()[which];
    return `<div class="row"><div class="main"><div class="ttl">${icon} ${label}</div><div class="meta">${v ? esc(v.label || `${v.lat.toFixed(4)}, ${v.lng.toFixed(4)}`) + d(v) : 'Not set'}</div>
      <div class="orow">${v ? `<button class="sbtn primary" data-hwnav="${which}">Navigate</button>` : ''}<button class="sbtn" data-hwset="${which}">${v ? 'Change' : 'Set address'}</button>${v ? `<button class="sbtn danger" data-hwclr="${which}">Clear</button>` : ''}</div></div></div>`;
  };
  const listCard = (l) => {
    const ps = placesIn(l.id);
    return `<div class="card sec" data-list="${l.id}"><div class="pagehead" style="margin:0"><div><h3 style="margin:0">${l.icon} ${esc(l.name)}${l.shareCode ? ' <span class="tag">Shared</span>' : ''}${l.mine === false ? ' <span class="tag">Friend\'s list</span>' : ''}</h3><p>${ps.length} place${ps.length === 1 ? '' : 's'}${l.shareCode ? ` · code <b class="mono">${esc(l.shareCode)}</b>` : ''}</p></div></div>
      ${ps.map((p) => `<div class="row"><div class="main"><div class="ttl">${esc(p.name)}</div><div class="meta">${p.note ? esc(p.note) + ' · ' : ''}${p.kind ? esc(p.kind) + ' · ' : ''}${p.mine === false ? 'added by a friend · ' : ''}${ago(p.time || p.created || Date.now())}${d(p)}</div>
        <div class="orow"><button class="sbtn primary" data-pnav="${p.id}">Navigate</button><button class="sbtn" data-pmap="${p.id}">Map</button><button class="sbtn danger" data-prm="${p.id}">Remove</button></div></div></div>`).join('')}
      ${ps.length ? '' : '<div class="empty">Nothing saved here yet. Search a place on the Map tab and tap "Save".</div>'}
      <div class="btns"><button class="btn" data-addhere="${l.id}">📍 Save my location</button><button class="btn" data-share="${l.id}">${l.shareCode ? '🔗 Share again' : '👥 Share with friends'}</button>${l.mine === false ? `<button class="btn" data-leave="${l.id}">Leave list</button>` : `<button class="btn" data-rename="${l.id}">Rename</button><button class="btn danger" data-dellist="${l.id}">Delete list</button>`}</div></div>`;
  };
  host.innerHTML = `${pageHead('Saved places', 'Home, Work, your lists, and lists you share with friends')}
    <div class="card sec">${hw('home', '🏠', 'Home')}${hw('work', '💼', 'Work')}</div>
    ${S.db.lists.map(listCard).join('')}
    <div class="card sec"><div class="btns"><button class="btn primary" id="sv-new">➕ New list</button><button class="btn" id="sv-join">🔑 Join a friend's list</button></div>
      <p class="note" style="margin:0">Shared lists: anyone with the code can add places; the person who made the list can remove anyone's. Sharing needs an account (More → Account). Lists live on this phone and sync to your account when you're signed in.</p></div>`;
  bindBack(host);
  $$('[data-hwnav]', host).forEach((b) => (b.onclick = () => goHome(b.dataset.hwnav)));
  $$('[data-hwclr]', host).forEach((b) => (b.onclick = () => confirmDel(b, () => { setHomeWork(b.dataset.hwclr, null); renderSaved(); })));
  $$('[data-hwset]', host).forEach((b) => (b.onclick = () => setHomeWorkSheet(b.dataset.hwset)));
  $$('[data-pnav]', host).forEach((b) => (b.onclick = () => { const p = S.db.places.find((x) => x.id === b.dataset.pnav); startNav({ dest: { lat: p.lat, lng: p.lng, label: p.name }, name: p.name }); }));
  $$('[data-pmap]', host).forEach((b) => (b.onclick = () => { const p = S.db.places.find((x) => x.id === b.dataset.pmap); go('map'); map.setView([p.lat, p.lng], 16); }));
  $$('[data-prm]', host).forEach((b) => (b.onclick = () => confirmDel(b, () => { removePlace(b.dataset.prm); renderSaved(); })));
  $$('[data-addhere]', host).forEach((b) => (b.onclick = () => { if (!E.me) { toast('Tap ◎ on the map first so I know where you are'); return; } savePlaceSheet({ name: E.road ? `Near ${E.road}` : 'My location', lat: E.me.lat, lng: E.me.lng }, renderSaved); }));
  $$('[data-share]', host).forEach((b) => (b.onclick = async () => { const l = S.db.lists.find((x) => x.id === b.dataset.share); await shareList(l); renderSaved(); }));
  $$('[data-rename]', host).forEach((b) => (b.onclick = () => { const l = S.db.lists.find((x) => x.id === b.dataset.rename); listSheet(l, renderSaved); }));
  $$('[data-dellist]', host).forEach((b) => (b.onclick = () => confirmDel(b, () => { removeLocal('lists', b.dataset.dellist); bus.emit('places'); renderSaved(); })));
  $$('[data-leave]', host).forEach((b) => (b.onclick = () => confirmDel(b, () => { S.db.lists = S.db.lists.filter((x) => x.id !== b.dataset.leave); S.db.places = S.db.places.filter((p) => p.listId !== b.dataset.leave); save(); bus.emit('places'); renderSaved(); toast('Left the list. Ask the owner for the code to rejoin.'); })));
  $('#sv-new').onclick = () => listSheet(null, renderSaved);
  $('#sv-join').onclick = () => joinSheet(renderSaved);
}
function listSheet(l, done) {
  openSheet(`${head(l ? 'Rename list' : 'New list')}
    <div class="sec">
      <label class="f">Name<input id="ls-name" maxlength="60" value="${esc(l?.name || '')}" placeholder="Clients, Date night, Kids' activities…"></label>
      <div class="f"><span>Icon</span><div class="chips" id="ls-icons" style="margin-top:6px">${ICONS.map((i) => `<button type="button" class="chip" data-ic="${i}"${(l?.icon || '⭐') === i ? ' aria-pressed="true"' : ''}>${i}</button>`).join('')}</div></div>
      <div class="btns"><button class="btn primary" id="ls-save">${l ? 'Save' : 'Create'}</button></div>
    </div>`, (s) => {
    let icon = l?.icon || '⭐';
    $$('#ls-icons .chip', s).forEach((c) => (c.onclick = () => { icon = c.dataset.ic; $$('#ls-icons .chip', s).forEach((x) => x.setAttribute('aria-pressed', x === c)); }));
    s.querySelector('#ls-save').onclick = () => {
      const name = s.querySelector('#ls-name').value.trim(); if (!name) { s.querySelector('#ls-name').focus(); return; }
      if (l) { l.name = name.slice(0, 60); l.icon = icon; upsertLocal('lists', l); } else createList(name, icon);
      closeSheet(); done?.();
    };
    s.querySelector('#ls-name').focus();
  });
}
export function joinSheet(done, code = '') {
  openSheet(`${head('Join a shared list')}
    <div class="sec">
      <p class="note" style="margin:0">Paste the code (or open the link) a friend sent you. You'll see their places and can add your own.</p>
      <label class="f">Code<input id="jn-code" maxlength="12" value="${esc(code)}" placeholder="ABCD2345" autocapitalize="characters" style="text-transform:uppercase;letter-spacing:.12em"></label>
      <div class="btns"><button class="btn primary" id="jn-go">Join</button></div>
      <div id="jn-msg" class="note"></div>
    </div>`, (s) => {
    const run = async () => {
      const c = s.querySelector('#jn-code').value.trim().toUpperCase(); if (c.length < 6) return;
      s.querySelector('#jn-msg').textContent = 'Joining…';
      try { await joinList(c); closeSheet(); toast('Joined! The list is under Saved places.'); done?.(); }
      catch (e) { s.querySelector('#jn-msg').textContent = e.message; }
    };
    s.querySelector('#jn-go').onclick = run;
    s.querySelector('#jn-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    if (code) run();
  });
}
function setHomeWorkSheet(which) {
  const st = { ...(P()[which] || {}) };
  openSheet(`${head(which === 'home' ? 'Set Home' : 'Set Work')}<div class="sec"><div id="hw-loc"></div><div class="btns"><button class="btn primary" id="hw-save">Save</button></div></div>`, (s) => {
    locWidget(s.querySelector('#hw-loc'), st, which === 'home' ? 'Home address' : 'Work address');
    s.querySelector('#hw-save').onclick = () => { if (st.lat == null) { toast('Search or pick the address first'); return; } setHomeWork(which, st); closeSheet(); renderSaved(); toast(`${which === 'home' ? 'Home' : 'Work'} saved. Say "take me ${which}" while driving.`); };
  });
}
/** A link like #join=CODE opened the app */
export function handleJoinHash() {
  const m = /join=([A-Za-z0-9]{6,12})/.exec(location.hash); if (!m) return false;
  history.replaceState(null, '', location.pathname);
  go('saved');
  setTimeout(() => joinSheet(renderSaved, m[1].toUpperCase()), 200);
  return true;
}
