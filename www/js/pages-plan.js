// Saved Routes, Commute Schedules, and the pre-trip heads-up.
import { S, save, persist, upsertLocal, removeLocal, sens } from './store.js';
import { $, $$, esc, fmtDist, ago, uuid, toast, bus } from './util.js';
import { map } from './mapview.js';
import { raise } from './engine.js';
import { pageHead, bindBack, openSheet, closeSheet, head, locWidget, confirmDel, go } from './ui.js';
import { analyzeRoute, drawRoute, routeReport, gmaps } from './pages-main.js';

// ---------------------------------------------------------------- Saved routes
export function saveRouteSheet(route, res) {
  openSheet(`${head('Save route')}<form id="sr" class="sec"><label class="f">Route name<input type="text" id="sr-name" required maxlength="80" placeholder="Home → Office"></label>
    <button class="btn primary" type="submit">Save</button></form>`, (s) => {
    s.querySelector('#sr').onsubmit = (e) => {
      e.preventDefault();
      upsertLocal('routes', { id: uuid(), name: s.querySelector('#sr-name').value.trim(), start: route.start, end: route.end,
        checked: Date.now(), hitCount: res ? res.hits.length : null, meters: res ? res.meters : null, secs: res ? res.secs : null });
      closeSheet(); toast('Route saved');
    };
  });
}
bus.on('save-route', saveRouteSheet);

const short = (l) => String(l || '').split(',')[0];
export function renderRoutes() {
  const host = $('#p-routes');
  host.innerHTML = `${pageHead('Saved Routes', 'Your frequent trips, checked against risk points')}
    <div class="btns"><button class="btn primary" data-new>Add a route</button></div>
    <div class="sec">${S.db.routes.length ? S.db.routes.map((r) => `<div class="row ${r.hitCount ? 't' : 'g'}"><div class="main"><div class="ttl">${esc(r.name)}</div>
      <div class="meta">${esc(short(r.start.label) || 'Start')} → ${esc(short(r.end.label) || 'End')}${r.meters ? ' · ' + fmtDist(r.meters) : ''}${r.secs ? ' · ' + Math.round(r.secs / 60) + ' min' : ''}</div>
      <div class="meta">${r.hitCount == null ? 'Not checked yet' : r.hitCount ? r.hitCount + ' risk point' + (r.hitCount > 1 ? 's' : '') : 'Clear'} · checked ${r.checked ? ago(r.checked) : 'never'}</div></div>
      <div class="acts"><button class="sbtn" data-chk="${r.id}">Check now</button><a class="sbtn linkbtn" href="${gmaps(r.start, r.end)}" target="_blank" rel="noopener">Navigate</a><button class="sbtn danger" data-del="${r.id}">Delete</button></div></div>`).join('')
      : '<div class="empty">No saved routes yet. Add your commute, or save one from the Route tab after checking it.</div>'}</div>
    <div id="routeRes"></div>`;
  host.querySelector('[data-new]').onclick = () => {
    const A = {}, B = {};
    openSheet(`${head('Add a route')}<form id="ar" class="sec"><label class="f">Route name<input type="text" id="ar-name" required maxlength="80" placeholder="Home → Office"></label><div class="loc" id="ar-a"></div><div class="loc" id="ar-b"></div><button class="btn primary" type="submit">Check and save</button></form>`, (s) => {
      locWidget(s.querySelector('#ar-a'), A, 'Start'); locWidget(s.querySelector('#ar-b'), B, 'Destination');
      s.querySelector('#ar').onsubmit = async (e) => {
        e.preventDefault(); if (A.lat == null || B.lat == null) { toast('Set both ends of the route'); return; }
        const name = s.querySelector('#ar-name').value.trim(); closeSheet(); toast('Checking route…');
        const res = await analyzeRoute(A, B);
        upsertLocal('routes', { id: uuid(), name, start: { ...A }, end: { ...B }, checked: Date.now(), hitCount: res.hits.length, meters: res.meters, secs: res.secs });
        toast('Route saved');
      };
    });
  };
  $$('[data-chk]', host).forEach((b) => (b.onclick = async () => {
    const r = S.db.routes.find((x) => x.id === b.dataset.chk); b.textContent = 'Checking…';
    const res = await analyzeRoute(r.start, r.end);
    upsertLocal('routes', { ...r, checked: Date.now(), hitCount: res.hits.length, meters: res.meters, secs: res.secs });
    const poly = drawRoute(res, r.start, r.end);
    const out = $('#routeRes'); out.innerHTML = routeReport(res, r.start, r.end);
    out.querySelector('[data-rtmap]').onclick = () => { go('map'); setTimeout(() => map.fitBounds(poly.getBounds(), { padding: [40, 40] }), 80); };
    out.scrollIntoView({ behavior: 'smooth' });
  }));
  $$('[data-del]', host).forEach((b) => (b.onclick = () => confirmDel(b, () => removeLocal('routes', b.dataset.del))));
  bindBack(host);
}

// ---------------------------------------------------------------- Commute schedules
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function renderCommutes() {
  const host = $('#p-commute');
  const preds = (S.db.predictions || []).filter((p) => !S.db.routes.some((r) => r.name === p.name));
  host.innerHTML = `${pageHead('Commute Schedules', 'Tell the app when you drive so it can warn you before you leave')}
    <div class="card note body">${S.db.settings.ai
      ? `Proactive alerts are <b class="ok">on</b>. With the app open, you get a heads-up up to ${sens().window} minutes before each scheduled trip, listing the cameras and ticket spots on that route.`
      : 'Proactive alerts are <b class="bad">off</b>. Turn them on in Settings (⚙︎) to get pre-trip warnings.'}</div>
    ${preds.length ? `<div class="card"><h2>Suggested from your drives</h2><p class="note" style="margin:0 0 10px">Trips you've repeated in the last 60 days, found by the commute agent.</p><div class="sec">
      ${preds.map((p, i) => `<div class="row i"><div class="main"><div class="ttl">${esc(p.name)} · ${esc(p.depart)}</div><div class="meta">${p.days.map((d) => DOW[d]).join(', ')} · driven ${p.trips} times · ${esc(p.confidence)} confidence</div>${p.risk_note ? `<div class="meta">${esc(p.risk_note)}</div>` : ''}</div>
        <div class="acts"><button class="sbtn" data-adopt="${i}">Add schedule</button></div></div>`).join('')}</div></div>` : ''}
    <div class="btns"><button class="btn primary" data-new>Add a schedule</button></div>
    <div class="sec">${S.db.commutes.length ? S.db.commutes.map((c) => {
      const r = S.db.routes.find((x) => x.id === c.routeId);
      return `<div class="row ${c.on ? 'i' : ''}" style="${c.on ? '' : 'opacity:.6'}"><div class="main"><div class="ttl">${esc(r ? r.name : 'Deleted route')} · ${esc(c.time)}</div>
      <div class="meta">${c.days.map((d) => DOW[d]).join(', ') || 'No days'}${r && r.hitCount != null ? ' · ' + (r.hitCount ? r.hitCount + ' risk point' + (r.hitCount > 1 ? 's' : '') : 'clear route') : ''}</div></div>
      <div class="acts"><button class="sbtn" data-tog="${c.id}">${c.on ? 'Pause' : 'Resume'}</button><button class="sbtn" data-ed="${c.id}">Edit</button><button class="sbtn danger" data-del="${c.id}">Delete</button></div></div>`;
    }).join('') : '<div class="empty">No schedules yet. Save a route first, then set the days and time you usually leave.</div>'}</div>`;
  host.querySelector('[data-new]').onclick = () => commuteForm();
  $$('[data-adopt]', host).forEach((b) => (b.onclick = () => {
    const p = preds[+b.dataset.adopt]; const rid = uuid();
    upsertLocal('routes', { id: rid, name: p.name, start: p.start, end: p.end, checked: null, hitCount: null });
    upsertLocal('commutes', { id: uuid(), routeId: rid, days: p.days, time: p.depart, on: true });
    toast('Schedule added');
  }));
  $$('[data-ed]', host).forEach((b) => (b.onclick = () => commuteForm(S.db.commutes.find((c) => c.id === b.dataset.ed))));
  $$('[data-tog]', host).forEach((b) => (b.onclick = () => { const c = S.db.commutes.find((x) => x.id === b.dataset.tog); upsertLocal('commutes', { ...c, on: !c.on }); }));
  $$('[data-del]', host).forEach((b) => (b.onclick = () => confirmDel(b, () => removeLocal('commutes', b.dataset.del))));
  bindBack(host);
}
function commuteForm(c) {
  if (!S.db.routes.length) { toast('Save a route first'); go('saved-routes'); return; }
  const d = c || { days: [1, 2, 3, 4, 5], time: '08:00', routeId: S.db.routes[0].id, on: true };
  openSheet(`${head(c ? 'Edit schedule' : 'Add schedule')}<form id="cm" class="sec">
    <label class="f">Route<select id="cm-route">${S.db.routes.map((r) => `<option value="${r.id}"${r.id === d.routeId ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
    <label class="f">Usual departure time<input type="time" id="cm-time" value="${esc(d.time)}" required></label>
    <fieldset class="f plain"><legend>Days</legend><div class="days">${DOW.map((n, i) => `<label><input type="checkbox" value="${i}" ${d.days.includes(i) ? 'checked' : ''}>${n}</label>`).join('')}</div></fieldset>
    <button class="btn primary" type="submit">Save schedule</button></form>`, (s) => {
    s.querySelector('#cm').onsubmit = (e) => {
      e.preventDefault();
      upsertLocal('commutes', { ...(c || { id: uuid(), on: true }), routeId: s.querySelector('#cm-route').value, time: s.querySelector('#cm-time').value,
        days: $$('.days input:checked', s).map((x) => +x.value) });
      closeSheet(); toast('Schedule saved');
    };
  });
}

// ---------------------------------------------------------------- pre-trip heads-up (runs every minute)
const firedToday = {};
export async function commuteCheck() {
  if (!S.db.settings.ai) return;
  const now = new Date(), win = sens().window;
  for (const c of S.db.commutes) {
    if (!c.on || !c.days.includes(now.getDay())) continue;
    const [h, m] = c.time.split(':').map(Number); const dep = new Date(now); dep.setHours(h, m, 0, 0);
    const mins = (dep - now) / 60000, key = c.id + now.toDateString();
    if (mins < 0 || mins > win || firedToday[key]) continue;
    firedToday[key] = 1;
    const r = S.db.routes.find((x) => x.id === c.routeId); if (!r) continue;
    const res = await analyzeRoute(r.start, r.end);
    Object.assign(r, { hitCount: res.hits.length, checked: Date.now() }); persist();
    const n = (k) => res.hits.filter((x) => x.k === k).length;
    const parts = [[n('c'), 'camera'], [n('t'), 'ticket spot'], [n('r'), 'live report']].filter(([x]) => x).map(([x, w]) => `${x} ${w}${x > 1 ? 's' : ''}`);
    const alt = S.db.profile.avoidRisk === 'alt' && parts.length;
    raise('info', `${r.name} in ${Math.round(mins)} min`,
      parts.length ? `${parts.join(', ')} on this route.${alt ? ' Consider checking another route.' : ' Tap Start drive when you leave.'}` : 'Route looks clear. Tap Start drive when you leave.',
      `Proactive alert. Your ${r.name} trip starts in ${Math.round(mins)} minutes. ${parts.length ? parts.join(', ') + ' on the way.' : 'The route looks clear.'}`);
  }
}
