// Supabase: sign-in, sync, community data and the AI agents.
// If no Supabase project is configured, the app runs fully on the phone.
import { S, persist, save, queue, normalize } from './store.js';
import { bus, toast, parseHeading, scrub } from './util.js';

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
export async function initAuth() {
  if (!sb) return;
  const { data } = await sb.auth.getSession();
  setUser(data.session?.user || null);
  sb.auth.onAuthStateChange((_e, session) => setUser(session?.user || null));
}
function setUser(u) {
  const changed = (S.user?.id || null) !== (u?.id || null);
  S.user = u; S.cloud = !!u;
  if (changed) {
    bus.emit('auth', u);
    if (u) syncNow();
  }
}
export async function sendCode(email) {
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) throw new Error(error.message);
}
export async function verifyCode(email, token) {
  const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw new Error(error.message.includes('expired') ? 'That code expired. Send a new one.' : 'That code didn\'t work. Check it and try again.');
}
export async function signOut() {
  await sb.auth.signOut();
  S.db.outbox = []; S.db.syncedUser = null; S.db.community = []; S.db.communityAt = 0;
  save();
}

// ---------------------------------------------------------------- row mapping
const toRow = {
  tickets: (t) => ({ id: t.id, street: t.street, lat: t.lat, lng: t.lng, ticket_date: t.date || null, ticket_time: t.time || null, due_date: t.due || null, type: t.type,
    fine: t.fine || null, speed: t.speed || null, speed_limit: t.limit || null, notes: t.notes || null, alert_type: t.alertType || 'voice', shared: !!t.shared }),
  cameras: (c) => ({ id: c.id, name: c.name, lat: c.lat, lng: c.lng, kind: c.kind, speed_limit: c.limit || null, heading: c.heading ?? null, source: 'user' }),
  routes: (r) => ({ id: r.id, name: r.name, start_pt: r.start, end_pt: r.end, hit_count: r.hitCount ?? null, meters: r.meters ?? null, secs: r.secs ?? null,
    checked_at: r.checked ? new Date(r.checked).toISOString() : null }),
  commutes: (c) => ({ id: c.id, route_id: c.routeId, days: c.days, depart: c.time, enabled: !!c.on }),
  reports: (r) => ({ id: r.id, type: r.type, lat: r.lat, lng: r.lng, place: r.place || null, note: scrub(r.note) || null }),
  alert_log: (a) => ({ id: a.id, kind: a.kind, title: a.title, detail: a.sub || null, at: new Date(a.time).toISOString() }),
  drive_events: (e) => ({ id: e.id, kind: e.kind, zone: e.zone, zone_type: e.zoneType, speed: e.speed ?? null, speed_limit: e.limit ?? null, at: new Date(e.time).toISOString() }),
  trips: (t) => ({ id: t.id, start_lat: t.start.lat, start_lng: t.start.lng, end_lat: t.end.lat, end_lng: t.end.lng,
    started_at: new Date(t.startedAt).toISOString(), ended_at: new Date(t.endedAt).toISOString(), meters: t.meters, max_mph: t.maxMph, alerts: t.alerts || 0 }),
};
const fromRow = {
  tickets: (r) => ({ id: r.id, street: r.street, lat: r.lat, lng: r.lng, date: r.ticket_date || '', time: (r.ticket_time || '').slice(0, 5), due: r.due_date || '', type: r.type,
    fine: +r.fine || 0, speed: r.speed, limit: r.speed_limit, notes: r.notes || '', alertType: r.alert_type, shared: r.shared, created: Date.parse(r.created_at) }),
  cameras: (r) => ({ id: r.id, name: r.name, lat: r.lat, lng: r.lng, kind: r.kind, limit: r.speed_limit, heading: r.heading }),
  routes: (r) => ({ id: r.id, name: r.name, start: r.start_pt, end: r.end_pt, hitCount: r.hit_count, meters: r.meters, secs: r.secs, checked: r.checked_at ? Date.parse(r.checked_at) : null }),
  commutes: (r) => ({ id: r.id, routeId: r.route_id, days: r.days, time: String(r.depart).slice(0, 5), on: r.enabled }),
  reports: (r) => ({ id: r.id, type: r.type, lat: r.lat, lng: r.lng, place: r.place || '', note: r.note || '', time: Date.parse(r.created_at), mine: true,
    status: r.status, reason: r.moderation_reason, expires: Date.parse(r.expires_at), confirms: r.confirms, denies: r.denies }),
  alert_log: (r) => ({ id: r.id, kind: r.kind, title: r.title, sub: r.detail || '', time: Date.parse(r.at) }),
  drive_events: (r) => ({ id: r.id, kind: r.kind, zone: r.zone, zoneType: r.zone_type, speed: r.speed, limit: r.speed_limit, time: Date.parse(r.at) }),
};
const LOCAL = { tickets: 'tickets', cameras: 'cameras', routes: 'routes', commutes: 'commutes', reports: 'reports', alert_log: 'alerts', drive_events: 'events', trips: 'trips' };

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

    const { data: p } = await sb.from('profiles').select('*').eq('id', uid).single();
    if (p) {
      S.db.profile = { ...S.db.profile, name: p.display_name || S.db.profile.name, homeLabel: p.home_label || S.db.profile.homeLabel,
        workLabel: p.work_label || S.db.profile.workLabel, avoidRisk: p.avoid_risk, emailCoach: p.email_coach };
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
  await sb.from('profiles').update({
    display_name: P.name || null, home_label: P.homeLabel || null, work_label: P.workLabel || null, avoid_risk: P.avoidRisk,
    email_coach: !!P.emailCoach, settings: S.db.settings,
    accepted_terms_at: S.db.acceptedTerms ? new Date(S.db.acceptedTerms).toISOString() : null,
  }).eq('id', S.user.id);
}

// ---------------------------------------------------------------- official cameras
const DC_LAYER = 'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Public_Safety_WebMercator/MapServer/43/query';
const KIND = { 'Speed': 'Speed', 'Red Light': 'Red light', 'Stop Sign': 'Stop sign', 'Truck Restriction': 'Truck', 'Bus Lane': 'Bus lane' };
export async function loadOfficialCameras(force) {
  if (!force && Date.now() - S.db.officialAt < 20 * 3600e3 && S.db.official.length) return;
  let list = null;
  try {
    if (sb) {
      list = [];
      for (let from = 0; from < 10000; from += 1000) {
        const { data, error } = await sb.from('cameras').select('id,name,lat,lng,kind,speed_limit,heading,verified,source,jurisdiction')
          .is('owner_id', null).eq('status', 'active').order('id').range(from, from + 999);
        if (error) throw error;
        list.push(...data.map((c) => ({ id: c.id, name: c.name, lat: c.lat, lng: c.lng, kind: c.kind, limit: c.speed_limit, heading: c.heading,
          verified: c.verified, source: c.source, jurisdiction: c.jurisdiction, official: true })));
        if (data.length < 1000) break;
      }
      if (!list.length) list = null;   // backend not seeded yet → fall back to DC directly
    }
    if (!list) {
      list = [];
      for (let off = 0; off < 5000; off += 1000) {
        const r = await fetch(`${DC_LAYER}?where=1%3D1&outFields=GLOBALID,ENFORCEMENT_TYPE,LOCATION_DESCRIPTION,SPEED_LIMIT,DEVICE_MOBILITY,ACTIVE_STATUS,CAMERA_LATITUDE,CAMERA_LONGITUDE&returnGeometry=false&orderByFields=OBJECTID&resultOffset=${off}&resultRecordCount=1000&f=json`);
        const js = await r.json();
        for (const { attributes: a } of js.features || []) {
          if (a.CAMERA_LATITUDE == null || (a.ACTIVE_STATUS && !/active/i.test(a.ACTIVE_STATUS))) continue;
          list.push({ id: 'dc-' + a.GLOBALID, name: String(a.LOCATION_DESCRIPTION || 'DC camera').trim() + (/mobile/i.test(a.DEVICE_MOBILITY || '') ? ' (mobile)' : ''),
            lat: a.CAMERA_LATITUDE, lng: a.CAMERA_LONGITUDE, kind: KIND[a.ENFORCEMENT_TYPE] || a.ENFORCEMENT_TYPE || 'Speed',
            limit: a.SPEED_LIMIT ? Math.round(a.SPEED_LIMIT) : null, heading: parseHeading(a.LOCATION_DESCRIPTION), verified: true, source: 'dc_open_data', jurisdiction: 'Washington, DC', official: true });
        }
        if ((js.features || []).length < 1000) break;
      }
    }
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
  await sb.auth.signOut();
  localStorage.clear();
  S.db = normalize({}); save();
}
