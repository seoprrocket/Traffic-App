// Supabase: sign-in, sync, community data and the AI agents.
// If no Supabase project is configured, the app runs fully on the phone.
import { S, persist, save, queue, normalize } from './store.js';
import { bus, toast, scrub } from './util.js';
import { loadAllPublic, loadMoCo, loadPG, loadArlington, loadOSM } from './sources.js';

// The setup page can connect just this device before config.js is deployed ("Use on this device")
let override = null;
try { override = JSON.parse(localStorage.getItem('tr.config')); } catch { /* none */ }
export const usingOverride = !!override?.supabaseUrl;
const cfg = { ...(window.TR_CONFIG || {}), ...(usingOverride ? override : {}) };
export const cloudConfigured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
export const sb = cloudConfigured
  ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } })
  : null;

// ---------------------------------------------------------------- auth
// Stay signed in until "Sign out": the session (with its refresh token) lives in this phone's storage and is
// refreshed quietly whenever the app comes back to the foreground or back online. Nothing in the app signs you
// out on its own; only the Sign out button (or deleting the account) does.
let leaving = false;                                               // true while *we* are signing out on purpose
export async function initAuth() {
  if (!sb) return;
  try { if (navigator.storage?.persist) navigator.storage.persist().catch(() => {}); } catch { /* not offered */ }   // ask the phone not to evict the app's storage
  await fromEmailLink();
  const { data } = await sb.auth.getSession();
  setUser(data.session?.user || null);
  sb.auth.onAuthStateChange((ev, session) => {
    setUser(session?.user || null);
    if (ev === 'PASSWORD_RECOVERY' || (session && recoveryLink)) { recoveryLink = false; setTimeout(() => bus.emit('recovery'), 400); }
    if (ev === 'SIGNED_OUT' && !leaving) setTimeout(() => toast('Your sign-in expired on this phone. Your data is safe here — sign in again (More → Account) to keep syncing.', 9000), 500);
  });
  // Coming back to the app or back online: make sure the token is fresh (the client retries by itself when a refresh fails for lack of network)
  const refresh = () => { if (document.visibilityState === 'visible') sb.auth.getSession().catch(() => {}); };
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('online', refresh);
  window.addEventListener('focus', refresh);
  setInterval(refresh, 20 * 60000);
}
function setUser(u) {
  const changed = (S.user?.id || null) !== (u?.id || null);
  S.user = u; S.cloud = !!u;
  if (changed) {
    bus.emit('auth', u);
    if (u) syncNow();
  }
}
/** Signing in by tapping the link in the email: the link comes back to the app with the session in the address. */
let recoveryLink = false;
async function fromEmailLink() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (h.get('type') === 'recovery') recoveryLink = true;
  const q = new URLSearchParams(location.search);
  const clean = () => history.replaceState(null, '', location.pathname + '#account');
  try {
    if (h.get('access_token') && h.get('refresh_token')) {
      const { error } = await sb.auth.setSession({ access_token: h.get('access_token'), refresh_token: h.get('refresh_token') });
      clean();
      if (error) throw error;
      if (!S.db.acceptedTerms) { S.db.acceptedTerms = Date.now(); persist(); }
      setTimeout(() => { toast('Signed in. Syncing your data…'); bus.emit('go', 'account'); }, 300);
    } else if (q.get('code')) {
      const { error } = await sb.auth.exchangeCodeForSession(q.get('code'));
      clean();
      if (error) throw error;
      setTimeout(() => { toast('Signed in. Syncing your data…'); bus.emit('go', 'account'); }, 300);
    } else if (h.get('error') || q.get('error')) {
      const code = h.get('error_code') || q.get('error_code') || '';
      clean();
      setTimeout(() => toast(/expired/.test(code) ? 'That sign-in link expired or was already used. Send a new one.' : 'That sign-in link didn\'t work. Send a new one.', 6000), 300);
    }
  } catch { setTimeout(() => toast('That sign-in link didn\'t work. Send a new one.', 6000), 300); }
}
export async function sendCode(email) {
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } });
  if (error) throw new Error(error.message);
}
export async function verifyCode(email, token) {
  const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw new Error(error.message.includes('expired') ? 'That code expired. Send a new one.' : 'That code didn\'t work. Check it and try again.');
}
// ---- Email + password ------------------------------------------------------
const friendly = (e) => {
  const m = e?.message || '';
  if (/invalid login credentials/i.test(m)) return 'Wrong email or password. If you signed up with an email link before, use "Forgot password" to set one.';
  if (/email not confirmed/i.test(m)) return 'Confirm your email first: tap the link we sent you, then sign in.';
  if (/already registered|already been registered/i.test(m)) return 'That email already has an account. Sign in, or use "Forgot password".';
  if (/password should be|at least/i.test(m)) return 'Use a longer password (8 characters or more).';
  if (/rate limit|too many/i.test(m)) return 'Too many tries. Wait a few minutes and try again.';
  if (/signups not allowed|disabled/i.test(m)) return 'Sign-ups are turned off for this app right now.';
  return m || 'Something went wrong';
};
export async function signInPassword(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(friendly(error));
}
/** Create an account with a password. Returns true when the account is live right away, false when an email confirmation is needed first. */
export async function signUpPassword(email, password) {
  const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
  if (error) throw new Error(friendly(error));
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw new Error('That email already has an account. Sign in, or use "Forgot password".');
  return !!data.session;
}
export async function resetPassword(email) {
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) throw new Error(friendly(error));
}
export async function updatePassword(password) {
  const { error } = await sb.auth.updateUser({ password });
  if (error) throw new Error(friendly(error));
}
// ---- Phone (text message code) ----------------------------------------------
export function e164(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;                       // US / Canada
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  if (String(raw).trim().startsWith('+') && d.length >= 8) return '+' + d;
  return null;
}
const phoneErr = (e) => {
  const m = e?.message || '';
  if (/provider|not enabled|disabled|unsupported|sms/i.test(m) && !/invalid|expired/i.test(m)) return 'Text-message sign-in isn\'t switched on for this app yet. It needs an SMS provider (Twilio) in Supabase → Authentication → Providers → Phone.';
  if (/rate limit|too many/i.test(m)) return 'Too many codes requested. Wait a few minutes.';
  return m || 'Something went wrong';
};
export async function sendSms(phone) {
  const { error } = await sb.auth.signInWithOtp({ phone, options: { shouldCreateUser: true } });
  if (error) throw new Error(phoneErr(error));
}
export async function verifySms(phone, token) {
  const { error } = await sb.auth.verifyOtp({ phone, token, type: 'sms' });
  if (error) throw new Error(/expired/i.test(error.message) ? 'That code expired. Text me a new one.' : /invalid|incorrect/i.test(error.message) ? 'That code didn\'t match. Check it and try again.' : phoneErr(error));
}
export async function signOut() {
  leaving = true;
  try { await sb.auth.signOut(); } finally { leaving = false; }
  S.db.outbox = []; S.db.syncedUser = null; S.db.community = []; S.db.communityAt = 0;
  save();
}

// ---------------------------------------------------------------- row mapping
// Parking tickets keep "what for" in the type column ("Parking – Expired meter"), so no database change is needed.
const splitType = (ty) => { const m = /^(Parking) – (.+)$/.exec(ty || ''); return m ? { type: m[1], violation: m[2] } : { type: ty, violation: '' }; };
const toRow = {
  tickets: (t) => ({ id: t.id, street: t.street, lat: t.lat, lng: t.lng, ticket_date: t.date || null, ticket_time: t.time || null, due_date: t.due || null, type: t.violation ? `${t.type} – ${t.violation}` : t.type, camera_id: t.cameraId || null,
    fine: t.fine || null, speed: t.speed || null, speed_limit: t.limit || null, notes: t.notes || null, alert_type: t.alertType || 'voice', shared: !!t.shared }),
  cameras: (c) => ({ id: c.id, name: c.name, lat: c.lat, lng: c.lng, kind: c.kind, speed_limit: c.limit || null, heading: c.heading ?? null, source: 'user' }),
  routes: (r) => ({ id: r.id, name: r.name, start_pt: r.start, end_pt: r.end, hit_count: r.hitCount ?? null, meters: r.meters ?? null, secs: r.secs ?? null,
    checked_at: r.checked ? new Date(r.checked).toISOString() : null }),
  commutes: (c) => ({ id: c.id, route_id: c.routeId, days: c.days, depart: c.time, enabled: !!c.on }),
  reports: (r) => ({ id: r.id, type: r.type, lat: r.lat, lng: r.lng, place: r.place || null, note: scrub(r.note) || null }),
  alert_log: (a) => ({ id: a.id, kind: a.kind, title: a.title, detail: a.sub || null, at: new Date(a.time).toISOString() }),
  drive_events: (e) => ({ id: e.id, kind: e.kind, zone: e.zone, zone_type: e.zoneType, speed: e.speed ?? null, speed_limit: e.limit ?? null, at: new Date(e.time).toISOString() }),
  lists: (l) => ({ id: l.id, name: l.name, icon: l.icon || '⭐', share_code: l.shareCode || null }),
  list_places: (p) => ({ id: p.id, list_id: p.listId, name: p.name, lat: p.lat, lng: p.lng, note: p.note || null, kind: p.kind || null }),
  camera_passes: (p) => ({ id: p.id, camera_id: p.cameraId, name: p.name, kind: p.kind, speed_limit: p.limit ?? null, jurisdiction: p.jurisdiction || null, lat: p.lat, lng: p.lng, mph: p.mph ?? null, at: new Date(p.time).toISOString() }),
  trips: (t) => ({ id: t.id, start_lat: t.start.lat, start_lng: t.start.lng, end_lat: t.end.lat, end_lng: t.end.lng,
    started_at: new Date(t.startedAt).toISOString(), ended_at: new Date(t.endedAt).toISOString(), meters: t.meters, max_mph: t.maxMph, alerts: t.alerts || 0 }),
};
const fromRow = {
  tickets: (r) => ({ id: r.id, street: r.street, lat: r.lat, lng: r.lng, date: r.ticket_date || '', time: (r.ticket_time || '').slice(0, 5), due: r.due_date || '', ...splitType(r.type), cameraId: r.camera_id || null,
    fine: +r.fine || 0, speed: r.speed, limit: r.speed_limit, notes: r.notes || '', alertType: r.alert_type, shared: r.shared, created: Date.parse(r.created_at) }),
  cameras: (r) => ({ id: r.id, name: r.name, lat: r.lat, lng: r.lng, kind: r.kind, limit: r.speed_limit, heading: r.heading }),
  routes: (r) => ({ id: r.id, name: r.name, start: r.start_pt, end: r.end_pt, hitCount: r.hit_count, meters: r.meters, secs: r.secs, checked: r.checked_at ? Date.parse(r.checked_at) : null }),
  commutes: (r) => ({ id: r.id, routeId: r.route_id, days: r.days, time: String(r.depart).slice(0, 5), on: r.enabled }),
  reports: (r) => ({ id: r.id, type: r.type, lat: r.lat, lng: r.lng, place: r.place || '', note: r.note || '', time: Date.parse(r.created_at), mine: true,
    status: r.status, reason: r.moderation_reason, expires: Date.parse(r.expires_at), confirms: r.confirms, denies: r.denies }),
  alert_log: (r) => ({ id: r.id, kind: r.kind, title: r.title, sub: r.detail || '', time: Date.parse(r.at) }),
  drive_events: (r) => ({ id: r.id, kind: r.kind, zone: r.zone, zoneType: r.zone_type, speed: r.speed, limit: r.speed_limit, time: Date.parse(r.at) }),
  lists: (r) => ({ id: r.id, name: r.name, icon: r.icon || '⭐', shareCode: r.share_code || '', ownerId: r.owner_id, mine: r.owner_id === S.user?.id, created: Date.parse(r.created_at) }),
  list_places: (r) => ({ id: r.id, listId: r.list_id, name: r.name, lat: r.lat, lng: r.lng, note: r.note || '', kind: r.kind || '', addedBy: r.added_by, mine: r.added_by === S.user?.id, time: Date.parse(r.created_at), created: Date.parse(r.created_at) }),
  camera_passes: (r) => ({ id: r.id, cameraId: r.camera_id, name: r.name, kind: r.kind, limit: r.speed_limit, jurisdiction: r.jurisdiction || '', lat: r.lat, lng: r.lng, mph: r.mph, over: r.speed_limit && r.mph != null ? r.mph - r.speed_limit : null, time: Date.parse(r.at), created: Date.parse(r.at) }),
};
const LOCAL = { tickets: 'tickets', cameras: 'cameras', routes: 'routes', commutes: 'commutes', reports: 'reports', alert_log: 'alerts', drive_events: 'events', trips: 'trips', camera_passes: 'passes', lists: 'lists', list_places: 'places' };

// ---------------------------------------------------------------- push
let flushing = false;
export async function flush() {
  if (!sb || !S.user || flushing || !navigator.onLine) return;
  flushing = true;
  try {
    while (S.db.outbox.length) {
      const job = S.db.outbox[0];
      const q = sb.from(job.table);
      let res;
      if (job.op === 'delete') res = await q.delete().eq('id', job.row.id);
      else {
        const rec = S.db[LOCAL[job.table]].find((x) => x.id === job.row.id);
        if (!rec) { S.db.outbox.shift(); continue; }          // deleted or trimmed before it synced
        const row = toRow[job.table](rec);
        if (job.op === 'insert') res = await q.insert(row);
        else if (job.op === 'update') { const { id, ...rest } = row; res = await q.update(rest).eq('id', id); }
        else res = await q.upsert(row);
      }
      if (res.error) {
        const e = res.error;
        if (e.code === '23505' && job.op === 'insert') { S.db.outbox.shift(); continue; }   // already there
        if (!e.code || /fetch|network/i.test(e.message)) break;                             // offline: try later
        console.warn('Dropped sync job', job, e);
        if (e.code === 'P0001') toast(e.message);
        S.db.outbox.shift();
        continue;
      }
      S.db.outbox.shift();
    }
  } finally { flushing = false; persist(); bus.emit('outbox'); }
}
window.addEventListener('online', () => flush());

// ---------------------------------------------------------------- pull
export async function syncNow() {
  if (!sb || !S.user) return;
  const uid = S.user.id;
  try {
    // First sign-in on this phone: upload what's already here
    if (S.db.syncedUser !== uid) {
      const up = (list, table, op = 'upsert') => S.db[list].filter((x) => !x.example).forEach((x) => queue(table, op, { id: x.id }));
      up('tickets', 'tickets'); up('cameras', 'cameras'); up('routes', 'routes'); up('commutes', 'commutes');
      up('reports', 'reports', 'insert');
      S.db.syncedUser = uid; persist();
    }
    await flush();
    const pending = new Set(S.db.outbox.map((o) => o.row.id));
    const pull = async (table, q = (x) => x) => {
      const { data, error } = await q(sb.from(table).select('*'));
      if (error) throw error;
      const local = LOCAL[table];
      const server = data.map(fromRow[table]);
      const onServer = new Set(server.map((x) => x.id));
      // Never drop something saved on this phone that hasn't reached the account yet:
      // keep it and queue it, instead of letting the server copy overwrite it.
      const unsent = S.db[local].filter((x) => !onServer.has(x.id) && !pending.has(x.id) && !x.example && (x.created || 0) > (S.db.lastPull || 0));
      unsent.forEach((x) => { pending.add(x.id); queue(table, 'upsert', { id: x.id }); });
      const keep = S.db[local].filter((x) => pending.has(x.id) || x.example);
      S.db[local] = server.filter((x) => !pending.has(x.id)).concat(keep);
    };
    await pull('tickets');
    await pull('cameras', (q) => q.eq('owner_id', uid));
    await pull('routes');
    await pull('commutes');
    await pull('reports', (q) => q.eq('user_id', uid).gte('created_at', new Date(Date.now() - 30 * 86400e3).toISOString()).order('created_at', { ascending: false }));
    await pull('alert_log', (q) => q.order('at', { ascending: false }).limit(300));
    await pull('drive_events', (q) => q.order('at', { ascending: false }).limit(500));
    try { await pull('camera_passes', (q) => q.order('at', { ascending: false }).limit(3000)); } catch (e) { console.warn('camera_passes not set up yet', e); }
    try { await pull('lists'); await pull('list_places', (q) => q.order('created_at', { ascending: false }).limit(2000)); } catch (e) { console.warn('saved lists not set up yet', e); }

    const { data: p } = await sb.from('profiles').select('*').eq('id', uid).single();
    if (p) {
      S.db.profile = { ...S.db.profile, name: p.display_name || S.db.profile.name, homeLabel: p.home_label || S.db.profile.homeLabel,
        workLabel: p.work_label || S.db.profile.workLabel, home: p.home_pt || S.db.profile.home || null, work: p.work_pt || S.db.profile.work || null, avoidRisk: p.avoid_risk, emailCoach: p.email_coach };
      if (p.settings && Object.keys(p.settings).length) S.db.settings = { ...S.db.settings, ...p.settings };
      if (p.accepted_terms_at) S.db.acceptedTerms = S.db.acceptedTerms || Date.parse(p.accepted_terms_at);
      else if (S.db.acceptedTerms) saveProfile();
    }
    S.db.lastPull = Date.now();
    save();
    loadCommunity(); loadAgentOutputs();
  } catch (e) {
    console.warn('sync failed', e);
  }
}

export async function saveProfile() {
  if (!sb || !S.user) return;
  const P = S.db.profile;
  const row = {
    display_name: P.name || null, home_label: P.homeLabel || null, work_label: P.workLabel || null, home_pt: P.home || null, work_pt: P.work || null, avoid_risk: P.avoidRisk,
    email_coach: !!P.emailCoach, settings: S.db.settings,
    accepted_terms_at: S.db.acceptedTerms ? new Date(S.db.acceptedTerms).toISOString() : null,
  };
  const { error } = await sb.from('profiles').update(row).eq('id', S.user.id);
  if (error && /home_pt|work_pt/.test(error.message || '')) {           // saved-lists migration not run yet: save the rest
    const { home_pt, work_pt, ...rest } = row;
    await sb.from('profiles').update(rest).eq('id', S.user.id);
  }
}
/** Join a friend's shared list by its code (needs the saved-lists migration and a signed-in account). */
export async function joinList(code) {
  if (!sb || !S.user) throw new Error('Sign in first (More → Account), then open the link again.');
  const { data, error } = await sb.rpc('join_list', { code: String(code || '').trim().toUpperCase() });
  if (error) throw new Error(/does not match/.test(error.message) ? 'That code doesn\'t match a shared list.' : /join_list/.test(error.message) ? 'Shared lists aren\'t set up on the server yet (run the setup SQL).' : error.message);
  await syncNow();
  return data;
}

// ---------------------------------------------------------------- official cameras (DC + Maryland)
export async function loadOfficialCameras(force) {
  if (!force && Date.now() - S.db.officialAt < 20 * 3600e3 && S.db.official.length) return;
  let list = null;
  try {
    if (sb) {
      list = [];
      for (let from = 0; from < 20000; from += 1000) {
        const { data, error } = await sb.from('cameras').select('id,name,lat,lng,kind,speed_limit,heading,verified,source,jurisdiction')
          .is('owner_id', null).eq('status', 'active').order('id').range(from, from + 999);
        if (error) throw error;
        list.push(...data.map((c) => ({ id: c.id, name: c.name, lat: c.lat, lng: c.lng, kind: c.kind, limit: c.speed_limit, heading: c.heading,
          verified: c.verified, source: c.source, jurisdiction: c.jurisdiction, official: true })));
        if (data.length < 1000) break;
      }
      // A camera with no real position (the county left it blank, stored as 0,0) can't warn anyone: leave it out
      list = list.filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng) && c.lat !== 0 && c.lng !== 0);
      if (!list.length) list = null;   // backend not seeded yet: load the public lists directly
      else {
        // Each county the backend doesn't have yet comes straight from that county's open data
        const has = (re) => list.some((c) => re.test(c.jurisdiction || ''));
        const add = [];
        if (!has(/montgomery/i)) add.push(loadMoCo());
        if (!has(/prince george/i)) add.push(loadPG());
        if (!has(/arlington/i)) add.push(loadArlington());
        if (add.length) { const md = await Promise.allSettled(add); list.push(...md.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))); }
        // Virginia and the rest of Maryland come from OpenStreetMap until the server has synced them (a big query: reuse yesterday's copy)
        if (!list.some((c) => c.source === 'osm')) {
          const cached = S.db.official.filter((c) => c.source === 'osm');
          if (cached.length && Date.now() - (S.db.osmAt || 0) < 24 * 3600e3) list.push(...cached);
          else { try { list.push(...await loadOSM(list)); S.db.osmAt = Date.now(); } catch (e) { console.warn('OpenStreetMap cameras failed:', e?.message || e); list.push(...cached); } }
        }
      }
    }
    if (!list) list = await loadAllPublic();
    if (!list.length) return;          // every source failed: keep what we had
    S.db.official = list; S.db.officialAt = Date.now(); save();
  } catch (e) { console.warn('official cameras unavailable:', e?.message || e); }
}

// ---------------------------------------------------------------- community
export async function loadCommunity() {
  if (!sb) return;
  try {
    const { data, error } = await sb.from('live_reports').select('*').order('created_at', { ascending: false }).limit(500);
    if (error) throw error;
    S.db.community = data.map((r) => ({ id: r.id, type: r.type, lat: r.lat, lng: r.lng, place: r.place || '', note: r.note || '', status: r.status,
      confirms: r.confirms, denies: r.denies, time: Date.parse(r.created_at), expires: Date.parse(r.expires_at), mine: r.mine, myVote: r.my_vote }));
    S.db.communityAt = Date.now();
    const hs = await sb.from('shared_hotspots').select('*').limit(1000);
    if (!hs.error) S.db.hotspots = hs.data;
    persist(); bus.emit('community');
  } catch (e) { console.warn('community unavailable', e); }
}
export async function vote(reportId, v) {
  if (!sb || !S.user) { toast('Sign in to confirm reports'); return; }
  const { error } = await sb.from('report_votes').upsert({ report_id: reportId, user_id: S.user.id, vote: v });
  if (error) { toast(error.message); return; }
  const r = S.db.community.find((x) => x.id === reportId); if (r) r.myVote = v;
  toast(v > 0 ? 'Thanks. Kept it on the map.' : 'Thanks. Marked as gone.');
  loadCommunity();
}

// ---------------------------------------------------------------- agents
export async function agent(name, body) {
  if (!sb) throw new Error('Connect Supabase to use the AI features. See the setup guide.');
  if (!S.user) throw new Error('Sign in to use the AI features.');
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch { /* keep generic */ }
    throw new Error(msg);
  }
  return data;
}
export async function loadAgentOutputs() {
  if (!sb || !S.user) return;
  const [c, p, d] = await Promise.all([
    sb.from('coach_reports').select('*').order('week_start', { ascending: false }).limit(12),
    sb.from('commute_predictions').select('*').maybeSingle(),
    sb.from('disputes').select('*').order('created_at', { ascending: false }).limit(20),
  ]);
  if (!c.error) S.db.coach = c.data;
  if (!p.error) S.db.predictions = p.data?.patterns || [];
  if (!d.error) S.db.disputes = d.data;
  persist(); bus.emit('agents');
}
export async function deleteAccount() {
  await agent('delete-account', { confirm: 'DELETE' });
  leaving = true; await sb.auth.signOut(); leaving = false;
  localStorage.clear();
  S.db = normalize({}); save();
}
