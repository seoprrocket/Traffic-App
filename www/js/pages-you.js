// Driver Profile, Account, Alert Log, Data Export, Settings, and the legal pages.
import { S, save, persist, replaceDb, SENS, upsertLocal } from './store.js';
import { $, $$, esc, money, stamp, today, toast, download, csv } from './util.js';
import { pageHead, bindBack, openSheet, closeSheet, head, atOpts, confirmDel, busy, go } from './ui.js';
import { raise, playSamples } from './engine.js';
import { unlockAudio } from './native.js';
import { cloudConfigured, usingOverride, sendCode, verifyCode, signOut, syncNow, saveProfile, deleteAccount, loadOfficialCameras } from './cloud.js';
import { summary } from './pages-main.js';
import { pushState, enablePush, disablePush, testPush, pushTrip } from './netlify.js';

const cfg = window.TR_CONFIG || {};
const COMPANY = cfg.company || 'The Invictus Traffic Radar team';
const CONTACT = cfg.contactEmail || '[add your contact email in js/config.js]';

// ---------------------------------------------------------------- Profile
export function renderProfile() {
  const Sm = summary(), P = S.db.profile, wk = Date.now() - 7 * 86400000;
  const entries = S.db.events.filter((e) => e.kind === 'enter' && e.time > wk).length;
  const mine = S.db.reports.filter((r) => r.mine).length + S.db.tickets.filter((t) => t.shared).length;
  const host = $('#p-profile');
  host.innerHTML = `${pageHead('Driver Profile', 'Your driving summary and preferences')}
    <div class="card"><h2>${esc(P.name || 'Your summary')}</h2>
      <div class="kpis">
        <div class="kpi"><small>Tickets</small><b>${Sm.n}</b></div>
        <div class="kpi"><small>Total fines</small><b>${money(Sm.total)}</b></div>
        <div class="kpi"><small>Days ticket-free</small><b>${Sm.daysClean ?? '—'}</b></div>
        <div class="kpi"><small>Zone entries (7d)</small><b>${entries}</b></div>
      </div>
      <p class="note" style="margin:12px 0 0">${S.db.cameras.length} pinned camera${S.db.cameras.length === 1 ? '' : 's'} · ${S.db.official.length} official cameras loaded · ${S.db.routes.length} saved route${S.db.routes.length === 1 ? '' : 's'} · ${mine} community contribution${mine === 1 ? '' : 's'} · ${S.db.trips.length} trips logged</p>
      <div class="btns" style="margin-top:12px"><button class="btn" data-go="account">${S.user ? 'Account: ' + esc(S.user.email) : 'Sign in to sync'}</button></div>
    </div>
    <form id="pf" class="card sec">
      <h2>You</h2>
      <label class="f">Display name<input type="text" id="pf-name" maxlength="60" value="${esc(P.name)}" placeholder="Mady"></label>
      <h2 class="sech">Commute preferences</h2>
      <div class="grid2">
        <label class="f">Home area<input type="text" id="pf-home" maxlength="120" value="${esc(P.homeLabel)}" placeholder="Gaithersburg, MD"></label>
        <label class="f">Work / usual destination<input type="text" id="pf-work" maxlength="120" value="${esc(P.workLabel)}" placeholder="Downtown DC"></label>
      </div>
      <label class="f">When a route has risk points<select id="pf-avoid">
        <option value="warn"${P.avoidRisk === 'warn' ? ' selected' : ''}>Just warn me</option>
        <option value="alt"${P.avoidRisk === 'alt' ? ' selected' : ''}>Warn me and suggest checking another route</option></select></label>
      <p class="note" style="margin:0">Set exact trips and times in <a href="#commute-schedules">Commute Schedules</a>.</p>
      <h2 class="sech">Community sharing</h2>
      <label class="switch"><input type="checkbox" id="pf-share" ${S.db.settings.share ? 'checked' : ''}><span><b>Share anonymized data</b><small>New tickets default to shared. Help others avoid tickets.</small></span></label>
      <div class="privacy"><b>Privacy protected.</b> Only anonymized data is shared: rounded location, month, location type and fine range. Nothing that identifies you.</div>
      <label class="switch"><input type="checkbox" id="pf-email" ${P.emailCoach ? 'checked' : ''}><span><b>Weekly coach email</b><small>A short review of your driving week, Monday mornings. Needs an account.</small></span></label>
      <button class="btn primary" type="submit">Save profile</button>
    </form>`;
  host.querySelector('#pf').onsubmit = (e) => {
    e.preventDefault();
    Object.assign(S.db.profile, { name: $('#pf-name').value.trim(), homeLabel: $('#pf-home').value.trim(), workLabel: $('#pf-work').value.trim(),
      avoidRisk: $('#pf-avoid').value, emailCoach: $('#pf-email').checked });
    S.db.settings.share = $('#pf-share').checked;
    save(); saveProfile(); toast('Profile saved');
  };
  host.querySelector('[data-go]').onclick = () => go('account');
  bindBack(host);
}

// ---------------------------------------------------------------- Account
let codeFor = null;
export function renderAccount() {
  const host = $('#p-account');
  const out = S.db.outbox.length;
  host.innerHTML = `${pageHead('Account', 'Sync across devices and share with other drivers')}
    ${!cloudConfigured ? `<div class="card"><h2>Backend not connected</h2><p class="note" style="margin:0">This copy of the app isn't connected to Supabase yet, so everything stays on this phone and the AI features are off. Open the <a href="setup.html">setup dashboard</a> to connect it step by step.</p></div>`
    : (usingOverride ? `<div class="privacy">This phone is connected through the <a href="setup.html">setup dashboard</a> only. Deploy config.js so everyone's app connects.</div>` : '') +
      (S.user ? `<div class="card sec"><h2>Signed in</h2><p style="margin:0"><b>${esc(S.user.email)}</b></p>
        <p class="note" style="margin:0">${out ? `${out} change${out > 1 ? 's' : ''} waiting to sync.` : 'Everything is synced.'} Last sync ${S.db.lastPull ? stamp(S.db.lastPull) : 'never'}.</p>
        <div class="btns"><button class="btn" id="ac-sync">Sync now</button><button class="btn" id="ac-out">Sign out</button></div></div>
      <div class="card sec"><h2>Delete account</h2><p class="note" style="margin:0">Permanently deletes your account and everything stored on the server: tickets, routes, drive history and reports. This can't be undone. Export a backup first if you want to keep a copy.</p>
        <div class="btns"><button class="btn danger" id="ac-del">Delete my account</button></div></div>`
    : `<form id="ac-form" class="card sec"><h2>Sign in or create an account</h2>
        <p class="note" style="margin:0">We'll email you a 6-digit code. No password needed. Anything already on this phone uploads to your account.</p>
        <label class="f">Email<input type="email" id="ac-email" required autocomplete="email" value="${esc(codeFor || '')}"></label>
        ${codeFor ? '<label class="f">Code from the email<input type="text" id="ac-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required></label>' : ''}
        <button class="btn primary" type="submit" id="ac-go">${codeFor ? 'Sign in' : 'Email me a code'}</button>
        ${codeFor ? '<button class="btn" type="button" id="ac-restart">Use a different email</button>' : ''}
        <p class="note" style="margin:0">By continuing you agree to the <a href="#terms">Terms</a> and <a href="#privacy">Privacy Policy</a>.</p></form>`)}
    <div class="btns"><a class="btn" href="#privacy">Privacy Policy</a><a class="btn" href="#terms">Terms of Use</a></div>`;
  host.querySelector('#ac-sync')?.addEventListener('click', async (e) => { busy(e.currentTarget, true, 'Syncing…'); await syncNow(); await loadOfficialCameras(true); renderAccount(); toast('Synced'); });
  host.querySelector('#ac-out')?.addEventListener('click', async () => { await signOut(); renderAccount(); toast('Signed out. Your data stays on this phone.'); });
  const del = host.querySelector('#ac-del');
  del?.addEventListener('click', () => confirmDel(del, async () => {
    busy(del, true, 'Deleting…');
    try { await deleteAccount(); toast('Your account was deleted'); go('map'); } catch (err) { toast(err.message); busy(del, false); }
  }));
  host.querySelector('#ac-restart')?.addEventListener('click', () => { codeFor = null; renderAccount(); });
  host.querySelector('#ac-form')?.addEventListener('submit', async (e) => {
    e.preventDefault(); const b = host.querySelector('#ac-go'); busy(b, true);
    const email = host.querySelector('#ac-email').value.trim();
    try {
      if (!codeFor) { await sendCode(email); codeFor = email; renderAccount(); toast('Code sent. Check your email.'); }
      else { await verifyCode(email, host.querySelector('#ac-code').value.trim()); codeFor = null; if (!S.db.acceptedTerms) S.db.acceptedTerms = Date.now(); persist(); toast('Signed in. Syncing your data…'); go('more'); }
    } catch (err) { toast(err.message); busy(b, false); }
  });
  bindBack(host);
}

// ---------------------------------------------------------------- Alert log
let logFilter = 'all';
export function renderLog() {
  const host = $('#p-log'), A = S.db.alerts, Ev = S.db.events;
  const enter = Ev.filter((e) => e.kind === 'enter'), exit = Ev.filter((e) => e.kind === 'exit');
  const items = [...A.map((a) => ({ t: a.time, type: 'alert', a })), ...Ev.map((e) => ({ t: e.time, type: e.kind, e }))]
    .filter((i) => logFilter === 'all' || i.type === logFilter).sort((a, b) => b.t - a.t).slice(0, 300);
  const cls = { camera: 'c', ticket: 't', report: 'r', info: 'i' };
  host.innerHTML = `${pageHead('Alert Log', 'Every warning and ticket-zone event while driving')}
    <div class="kpis">
      <div class="kpi"><small>Total events</small><b>${A.length + Ev.length}</b></div>
      <div class="kpi"><small>Alerts sent</small><b>${A.length}</b></div>
      <div class="kpi"><small>Zone entries</small><b>${enter.length}</b></div>
      <div class="kpi"><small>Zone exits</small><b>${exit.length}</b></div>
    </div>
    <div class="seg">${[['all', `All (${A.length + Ev.length})`], ['alert', `Alerts (${A.length})`], ['enter', `Enter (${enter.length})`], ['exit', `Exit (${exit.length})`]].map(([k, l]) => `<button data-f="${k}" aria-pressed="${logFilter === k}">${l}</button>`).join('')}</div>
    <div class="sec">${items.length ? items.map((i) => {
      if (i.type === 'alert') { const a = i.a; return `<div class="row ${cls[a.kind] || 'i'}"><div class="main"><div class="ttl">${esc(a.title)}</div><div class="meta">${esc(a.sub)}</div><div class="meta">${stamp(a.time)}</div></div></div>`; }
      const e = i.e; const over = e.limit && e.speed > e.limit + 2;
      return `<div class="row g"><span class="emo">${e.kind === 'enter' ? '↘' : '↗'}</span><div class="main"><div class="ttl">${e.kind === 'enter' ? 'Entered' : 'Left'} ${esc(String(e.zoneType).toLowerCase())}: ${esc(e.zone)}</div><div class="meta">${stamp(e.time)} · ${e.speed} mph${e.limit ? ' (limit ' + e.limit + ')' : ''}${over ? ' · <b class="bad">over limit</b>' : ''}</div></div></div>`;
    }).join('') : '<div class="empty">No events yet. Your alerts and zone activity appear here as you drive with drive mode on.</div>'}</div>
    ${items.length ? '<div class="btns"><button class="btn danger" data-clear>Clear log on this phone</button></div>' : ''}`;
  $$('[data-f]', host).forEach((b) => (b.onclick = () => { logFilter = b.dataset.f; renderLog(); }));
  const c = host.querySelector('[data-clear]'); if (c) c.onclick = () => confirmDel(c, () => { S.db.alerts = []; S.db.events = []; save(); });
  bindBack(host);
}

// ---------------------------------------------------------------- Export
export function renderExport() {
  const host = $('#p-export'), d = today();
  host.innerHTML = `${pageHead('Data Export', 'Download your records for safekeeping')}
    <div class="card sec">
      <div class="row t"><div class="main"><div class="ttl">Tickets (${S.db.tickets.length})</div><div class="meta">Date, time, street, type, fine, speed, limit, deadline, coordinates, notes</div></div><div class="acts"><button class="sbtn" data-x="tickets">Download CSV</button></div></div>
      <div class="row c"><div class="main"><div class="ttl">Your cameras (${S.db.cameras.length})</div><div class="meta">Name, type, limit, direction, coordinates</div></div><div class="acts"><button class="sbtn" data-x="cameras">Download CSV</button></div></div>
      <div class="row g"><div class="main"><div class="ttl">Driving events (${S.db.events.length})</div><div class="meta">Every zone entry and exit, with speed</div></div><div class="acts"><button class="sbtn" data-x="events">Download CSV</button></div></div>
      <div class="row g"><div class="main"><div class="ttl">Trips (${S.db.trips.length})</div><div class="meta">Start, end, distance, top speed, alerts</div></div><div class="acts"><button class="sbtn" data-x="trips">Download CSV</button></div></div>
      <div class="row i"><div class="main"><div class="ttl">Alert log (${S.db.alerts.length})</div><div class="meta">Every warning the app gave you</div></div><div class="acts"><button class="sbtn" data-x="alerts">Download CSV</button></div></div>
      <div class="row r"><div class="main"><div class="ttl">Your reports (${S.db.reports.length})</div><div class="meta">Sightings you posted</div></div><div class="acts"><button class="sbtn" data-x="reports">Download CSV</button></div></div>
    </div>
    <div class="card sec"><h2>Full backup</h2><p class="note" style="margin:0">Everything on this phone in one file, including routes, schedules and settings.</p>
      <div class="btns"><button class="btn primary" data-x="json">Download backup</button><label class="btn">Restore from backup<input type="file" id="x-imp" accept="application/json" hidden></label></div></div>`;
  const X = {
    tickets: () => download(`tickets-${d}.csv`, csv(S.db.tickets, [['date', (t) => t.date], ['time', (t) => t.time], ['street', (t) => t.street], ['type', (t) => t.type], ['fine', (t) => t.fine], ['speed', (t) => t.speed], ['limit', (t) => t.limit], ['due', (t) => t.due], ['lat', (t) => t.lat], ['lng', (t) => t.lng], ['notes', (t) => t.notes], ['shared', (t) => (t.shared ? 'yes' : 'no')]]), 'text/csv'),
    cameras: () => download(`cameras-${d}.csv`, csv(S.db.cameras, [['name', (c) => c.name], ['type', (c) => c.kind], ['limit', (c) => c.limit], ['heading', (c) => c.heading], ['lat', (c) => c.lat], ['lng', (c) => c.lng]]), 'text/csv'),
    events: () => download(`driving-events-${d}.csv`, csv(S.db.events, [['time', (e) => new Date(e.time).toISOString()], ['event', (e) => e.kind], ['zone', (e) => e.zone], ['zone_type', (e) => e.zoneType], ['speed_mph', (e) => e.speed], ['limit', (e) => e.limit]]), 'text/csv'),
    trips: () => download(`trips-${d}.csv`, csv(S.db.trips, [['started', (t) => new Date(t.startedAt).toISOString()], ['ended', (t) => new Date(t.endedAt).toISOString()], ['miles', (t) => (t.meters / 1609.34).toFixed(1)], ['top_mph', (t) => t.maxMph], ['alerts', (t) => t.alerts], ['start', (t) => `${t.start.lat},${t.start.lng}`], ['end', (t) => `${t.end.lat},${t.end.lng}`]]), 'text/csv'),
    alerts: () => download(`alert-log-${d}.csv`, csv(S.db.alerts, [['time', (a) => new Date(a.time).toISOString()], ['kind', (a) => a.kind], ['title', (a) => a.title], ['detail', (a) => a.sub]]), 'text/csv'),
    reports: () => download(`reports-${d}.csv`, csv(S.db.reports, [['time', (r) => new Date(r.time).toISOString()], ['type', (r) => r.type], ['lat', (r) => r.lat], ['lng', (r) => r.lng], ['note', (r) => r.note], ['status', (r) => r.status]]), 'text/csv'),
    json: () => { const { outbox, official, community, hotspots, ...rest } = S.db; download(`invictus-traffic-radar-backup-${d}.json`, JSON.stringify(rest, null, 2), 'application/json'); },
  };
  $$('[data-x]', host).forEach((b) => (b.onclick = () => { X[b.dataset.x](); toast('Download started'); }));
  host.querySelector('#x-imp').onchange = (e) => importFile(e.target.files[0]);
  bindBack(host);
}
function importFile(f) {
  if (!f) return; const rd = new FileReader();
  rd.onload = () => {
    try {
      const d = JSON.parse(rd.result); if (!Array.isArray(d.tickets)) throw new Error();
      const keepUser = S.db.syncedUser; replaceDb(d); S.db.syncedUser = null; persist();   // re-upload on next sync
      if (keepUser) syncNow();
      closeSheet(); toast('Backup restored');
    } catch { toast('That file is not a Invictus Traffic Radar backup'); }
  };
  rd.readAsText(f);
}

// ---------------------------------------------------------------- Settings
export function openSettings() {
  const st = S.db.settings;
  openSheet(`${head('Settings')}
  <div class="sec">
    <label class="f">Default alert type<select id="s-at">${atOpts(st.alertType)}</select><small class="hint">Applied to new ticket locations and all camera warnings.</small></label>
    <div class="grid2">
      <label class="f">Camera warning (minutes ahead)<input type="number" id="s-lead" min="1" max="15" value="${st.lead}"></label>
      <label class="f">Ticket-zone radius (meters)<input type="number" id="s-rad" min="50" max="1000" step="50" value="${st.ticketRadius}"></label>
    </div>
    <h3 class="sech">Speed alerts</h3>
    <div class="grid2">
      <label class="f">Warn me when I'm over the limit by<select id="s-over">${[['', 'Off'], ['0', 'Any amount'], ['5', '5 mph'], ['10', '10 mph'], ['15', '15 mph']].map(([v, l]) => `<option value="${v}"${String(st.speedOverBy ?? '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f">Also warn me above (mph, 0 = off)<input type="number" id="s-max" min="0" max="120" step="5" value="${+st.speedMax || 0}"></label>
    </div>
    <h3 class="sech">Road warnings</h3>
    <div class="grid2">
      <label class="switch"><input type="checkbox" id="s-rb" ${st.roadBumps ? 'checked' : ''}><span><b>Speed bumps</b></span></label>
      <label class="switch"><input type="checkbox" id="s-rc" ${st.roadCurves ? 'checked' : ''}><span><b>Sharp curves</b></span></label>
      <label class="switch"><input type="checkbox" id="s-rl" ${st.roadLimits ? 'checked' : ''}><span><b>Speed limit drops</b></span></label>
      <label class="switch"><input type="checkbox" id="s-rt" ${st.roadTolls ? 'checked' : ''}><span><b>Toll booths</b></span></label>
    </div>
    <p class="note" style="margin:0">Road warnings and speed limits come from OpenStreetMap, which is good but not complete. Posted signs always win.</p>
    <h3 class="sech">Phone notifications</h3>
    <div id="s-push" class="note">Checking…</div>
    <h3 class="sech">More</h3>
    <label class="switch"><input type="checkbox" id="s-off" ${st.officialCams ? 'checked' : ''}><span><b>Official camera lists</b><small>Warn me about the cameras DC, Montgomery County and Prince George's County publish, plus county lists, not just my pins.</small></span></label>
    <label class="switch"><input type="checkbox" id="s-lim" ${st.speedLimits ? 'checked' : ''}><span><b>Show the speed limit for every road</b><small>Looks up posted limits from OpenStreetMap as you drive. Uses a little data.</small></span></label>
    <label class="switch"><input type="checkbox" id="s-hf" ${st.handsFreeAuto ? 'checked' : ''}><span><b>Hands-free screen while driving</b><small>Big speed readout and one-tap report buttons when drive mode starts.</small></span></label>
    <label class="switch"><input type="checkbox" id="s-share" ${st.share ? 'checked' : ''}><span><b>Share anonymized data</b><small>Your new tickets are anonymized and shared with the community.</small></span></label>
    <div class="privacy"><b>Privacy protected.</b> Only anonymized data is shared: rounded location, month, location type and fine range. No personal information is ever shared.</div>
    <label class="switch"><input type="checkbox" id="s-ai" ${st.ai ? 'checked' : ''}><span><b>Proactive alerts</b><small>Warns you before scheduled commutes and before areas where you've been ticketed.</small></span></label>
    <label class="f">Alert sensitivity<select id="s-sens">${Object.entries(SENS).map(([k, v]) => `<option value="${k}"${st.sensitivity === k ? ' selected' : ''}>${v.label}</option>`).join('')}</select></label>
    <div class="btns"><button class="btn" id="s-test">Hear sample alerts</button><button class="btn primary" id="s-save">Save settings</button></div>
    <div class="btns"><button class="btn danger" id="s-clr">Remove example entries</button></div>
  </div>`, (s) => {
    const read = () => Object.assign(S.db.settings, {
      alertType: s.querySelector('#s-at').value, lead: Math.min(15, Math.max(1, +s.querySelector('#s-lead').value || 5)),
      ticketRadius: Math.min(1000, Math.max(50, +s.querySelector('#s-rad').value || 300)), share: s.querySelector('#s-share').checked,
      ai: s.querySelector('#s-ai').checked, sensitivity: s.querySelector('#s-sens').value, officialCams: s.querySelector('#s-off').checked,
      speedLimits: s.querySelector('#s-lim').checked, handsFreeAuto: s.querySelector('#s-hf').checked,
      speedOverBy: s.querySelector('#s-over').value === '' ? '' : +s.querySelector('#s-over').value,
      speedMax: Math.max(0, Math.min(120, +s.querySelector('#s-max').value || 0)),
      roadBumps: s.querySelector('#s-rb').checked, roadCurves: s.querySelector('#s-rc').checked,
      roadLimits: s.querySelector('#s-rl').checked, roadTolls: s.querySelector('#s-rt').checked,
    });
    s.querySelector('#s-save').onclick = () => { read(); save(); saveProfile(); closeSheet(); toast('Settings saved'); };
    s.querySelector('#s-test').onclick = () => { read(); persist(); unlockAudio(); closeSheet(); playSamples(); toast('Playing 11 sample alerts. This takes about a minute.', 4000); };
    s.querySelector('#s-clr').onclick = () => { S.db.tickets = S.db.tickets.filter((t) => !t.example); save(); closeSheet(); toast('Examples removed'); };
    paintPush(s.querySelector('#s-push'));
  });
}

// ---------------------------------------------------------------- phone notifications block
const PUSH_TEXT = {
  on: 'On. This phone gets "time to leave" and parking meter notifications, even with the app closed.',
  off: 'Off. Turn on to be told when to leave for saved trips and before your parking meter runs out, even with the app closed.',
  install: 'On iPhone, add Invictus Traffic Radar to your Home Screen first (Share → Add to Home Screen), then open it from there to turn notifications on.',
  unsupported: "This browser can't receive notifications. Saved trips still remind you while the app is open, and you can add them to your calendar.",
  server: 'Not set up on the site yet (setup page, step 2). Until then, trips remind you while the app is open, and you can add them to your calendar.',
  denied: 'Blocked for this site. Allow notifications for it in your phone or browser settings, then come back.',
};
async function paintPush(el) {
  if (!el) return;
  const st = await pushState();
  el.innerHTML = `<p style="margin:0">${PUSH_TEXT[st]}</p>${st === 'on' ? '<div class="btns" style="margin-top:8px"><button class="btn" data-p="test">Send a test</button><button class="btn" data-p="off">Turn off</button></div>'
    : st === 'off' ? '<div class="btns" style="margin-top:8px"><button class="btn primary" data-p="on">Turn on notifications</button></div>' : ''}`;
  el.querySelectorAll('[data-p]').forEach((b) => (b.onclick = async () => {
    busy(b, true);
    try {
      if (b.dataset.p === 'on') { await enablePush(); for (const t of S.db.plans || []) if (t.arriveBy > Date.now()) await pushTrip(t); toast('Notifications are on'); }
      if (b.dataset.p === 'off') { await disablePush(); toast('Notifications are off'); }
      if (b.dataset.p === 'test') { await testPush(); toast('Test sent. It should arrive in a few seconds.'); }
    } catch (e) { toast(e.message, 6000); }
    paintPush(el);
  }));
}

// ---------------------------------------------------------------- Terms gate (first run)
export function termsGate() {
  if (S.db.acceptedTerms) return;
  openSheet(`<div class="sheethead"><h3>Before you drive</h3></div>
    <ul class="insights">
      <li><b>Set it up before you drive.</b> Don't tap the screen while the car is moving. Use voice or hands-free mode, or have a passenger help.</li>
      <li><b>The posted signs always win.</b> Camera lists lag, cameras move, and GPS can be off. The app can miss things.</li>
      <li><b>This isn't legal advice.</b> Dispute help gives general information only.</li>
      <li><b>Reports are public.</b> Describe what and where, never who. No names, faces or plates.</li>
    </ul>
    <p class="note" style="margin:0">Read the full <a href="#terms" data-close-sheet>Terms of Use</a> and <a href="#privacy" data-close-sheet>Privacy Policy</a>.</p>
    <button class="btn primary" id="tg-ok">I agree</button>`, (s) => {
    s.querySelector('#tg-ok').onclick = () => { S.db.acceptedTerms = Date.now(); save(); saveProfile(); closeSheet(); };
    $$('[data-close-sheet]', s).forEach((a) => a.addEventListener('click', () => { closeSheet(); setTimeout(termsGate, 400); }));
  });
}

// ---------------------------------------------------------------- Legal pages
const EFFECTIVE = 'September 29, 2026';
export function renderPrivacy() {
  const host = $('#p-privacy');
  host.innerHTML = `${pageHead('Privacy Policy', 'Effective ' + EFFECTIVE)}<article class="card legal">
    <p>${esc(COMPANY)} ("we") runs Invictus Traffic Radar. This policy explains what the app collects, why, and your choices.</p>
    <h3>What stays on your phone</h3>
    <p>If you don't sign in, everything you enter stays in your phone's browser storage or the app's storage. We never see it.</p>
    <h3>What we store when you sign in</h3>
    <ul><li>Your email address, to sign you in.</li>
      <li>Tickets, camera pins, routes and commute schedules you enter.</li>
      <li>Drive history while drive mode is on: trip start and end points, distance, top speed, when you entered or left a camera or ticket zone and your speed at that moment, and the alerts you received. We don't keep a continuous track of your location.</li>
      <li>Community reports you post, and your "still there / gone" votes.</li>
      <li>Your profile and settings.</li></ul>
    <h3>What other drivers can see</h3>
    <ul><li>Reports you post: type, location, time and the reviewed note. Never your name or email.</li>
      <li>Tickets you choose to share: location rounded to about 100 meters, month, type and a fine range.</li></ul>
    <h3>Drive features</h3>
    <ul><li><b>Plan a Drive:</b> your start and destination are sent to the site's server, which asks Google's Routes service for drive times with traffic. Saved trips you want notifications for are kept on the server (with an anonymous id for your phone) until an hour after the arrival time.</li>
      <li><b>Share drive:</b> while you share, your location, speed, destination name and arrival time are stored on the server and shown to anyone with the link. The link stops working 30 minutes after you end the trip, and at most 4 hours after your last update.</li>
      <li><b>Parking:</b> your saved spot, note and photo stay on your phone. A meter reminder sends only its time and message to the server.</li>
      <li><b>Importing tickets:</b> pasted text and screenshots read on your phone stay on your phone. With the AI scanner, the picture is sent to be read once and isn't stored. The street is looked up on OpenStreetMap to place it on the map. Plate numbers, citation numbers and PINs are not saved.</li>
      <li><b>Parking ticket check:</b> the spot you check is sent to the DC government's map service, or for Montgomery County to OpenStreetMap (to find the street name) and the county's open-data site. Nothing else about you is sent.</li>
      <li><b>Road warnings and parking search</b> send the area around you to OpenStreetMap's Overpass service.</li></ul>
    <h3>AI processing</h3>
    <p>Some features send data to Anthropic's Claude API: ticket photos you scan (read once, not stored by us), voice questions with your nearby hazards, report text for moderation, and summaries of your drive history for coaching, commute suggestions and dispute help. Anthropic processes this data to return an answer.</p>
    <h3>Other services</h3>
    <p>Supabase hosts our database. Address searches go to OpenStreetMap's Nominatim; route checks to the OSRM routing service; speed-limit lookups to the Overpass API; map tiles come from OpenStreetMap. Camera locations come from the open data published by DC, Montgomery County and Prince George's County, and from county camera web pages. Weekly coach emails are sent through Resend. These services receive only what they need for that request, such as the address you search or the map area you view.</p>
    <h3>Location permission</h3>
    <p>The app uses your location only while drive mode is on, or when you tap "Use my location." In the phone app, background location keeps warnings working when the screen is off. Turning drive mode off stops it.</p>
    <h3>How long we keep data</h3>
    <p>Drive events and alerts are deleted after one year. Reports stop showing after six hours and are kept for moderation and your history. Everything else stays until you delete it or delete your account.</p>
    <h3>Your choices</h3>
    <ul><li>Export everything from Data Export.</li><li>Delete any item in the app.</li><li>Delete your account and all server data from Account.</li><li>Turn off sharing, proactive alerts, speed-limit lookups and coach emails in Settings and Driver Profile.</li></ul>
    <p>We don't sell your data or use it for advertising. The app isn't meant for anyone under 16.</p>
    <h3>Contact</h3><p>Questions or requests: <span class="mono sel">${esc(CONTACT)}</span></p></article>`;
  bindBack(host);
}
export function renderTerms() {
  const host = $('#p-terms');
  host.innerHTML = `${pageHead('Terms of Use', 'Effective ' + EFFECTIVE)}<article class="card legal">
    <p>By using Invictus Traffic Radar you agree to these terms. If you don't agree, don't use the app.</p>
    <h3>Drive safely and obey the law</h3>
    <p>Don't operate the app while driving in a way that takes your attention off the road. Set it up before you drive and use voice or hands-free features, or let a passenger operate it. You are responsible for following all traffic laws and posted signs. Some places restrict phone use while driving; follow those rules.</p>
    <h3>No guarantee</h3>
    <p>The app is a reminder tool. Camera lists, community reports, speed limits and routes can be wrong, late or missing, and GPS can be inaccurate. We don't promise you'll avoid any ticket, and we're not responsible for citations, fines, or anything that happens while you drive. The app is provided "as is."</p>
    <h3>Not legal advice</h3>
    <p>Dispute help, safety tips and coaching are general information. For advice about your case, contact a lawyer or the agency on your notice.</p>
    <h3>Community rules</h3>
    <ul><li>Report only what you actually saw, in a public place.</li>
      <li>Describe the activity and location, not people: no names, faces, badge numbers, license plates or private addresses.</li>
      <li>No threats, harassment, calls to interfere with anyone (including officers), spam, or hateful content.</li>
      <li>Reports are reviewed automatically and may be hidden. Accounts that break these rules may be removed.</li></ul>
    <h3>Your content</h3>
    <p>You keep ownership of what you post. You let us display and process it to run the app, including showing reports to other drivers.</p>
    <h3>Changes</h3>
    <p>We may update these terms. We'll show the new date here, and continuing to use the app means you accept the update.</p>
    <h3>Contact</h3><p><span class="mono sel">${esc(CONTACT)}</span></p></article>`;
  bindBack(host);
}
