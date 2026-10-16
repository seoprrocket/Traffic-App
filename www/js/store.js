// Local state. Everything the app shows comes from here, so it works offline.
// When signed in, cloud.js mirrors changes to Supabase through the outbox.
import { uuid, isUuid, bus, toast, dist } from './util.js';

const KEY = 'ticketRadar.v1';

export const DEFAULT_SETTINGS = {
  lead: 5, ticketRadius: 300, alertType: 'voice', share: false, ai: true, sensitivity: 'medium',
  officialCams: true, speedLimits: true, handsFreeAuto: true,
  screenOn: 'always', watchCams: [], carStyle: 'dot', carColor: '#f4f5f7', navMuted: false, navVoice: 'all', avoid: [], engine: 'petrol', ecoRoutes: false, parkLayer: false, logPasses: true, speedOverBy: 5, speedMax: 0, roadBumps: true, roadCurves: true, roadLimits: true, roadTolls: true,
};
export const DEFAULT_PROFILE = { name: '', homeLabel: '', workLabel: '', home: null, work: null, avoidRisk: 'warn', emailCoach: true };
const LISTS = ['tickets', 'cameras', 'reports', 'routes', 'commutes', 'events', 'alerts', 'trips', 'outbox', 'official', 'community', 'hotspots', 'coach', 'predictions', 'disputes', 'plans', 'passes', 'lists', 'places', 'recent', 'reminders'];

function seed() {
  return {
    v: 3,
    tickets: [{ id: uuid(), street: 'Example — New York Ave NE', lat: 38.9146, lng: -76.9859, date: '2026-08-14', time: '', type: 'Speed camera', fine: 125, speed: 42, limit: 30, notes: 'Sample entry so you can see how it works. Edit or delete it.', example: true, shared: false, alertType: 'voice' }],
    cameras: [], reports: [], routes: [], commutes: [], events: [], alerts: [], trips: [], outbox: [], passes: [], lists: [], places: [], recent: [], reminders: [],
    official: [], officialAt: 0, community: [], communityAt: 0, hotspots: [], coach: [], predictions: [], disputes: [],
    settings: { ...DEFAULT_SETTINGS }, profile: { ...DEFAULT_PROFILE },
    acceptedTerms: null, syncedUser: null, lastPull: 0,
  };
}

export function normalize(d) {
  LISTS.forEach((k) => { if (!Array.isArray(d[k])) d[k] = []; });
  d.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  if (!Array.isArray(d.settings.avoid)) d.settings.avoid = [];
  if (!Array.isArray(d.settings.watchCams)) d.settings.watchCams = [];
  if (d.settings.navMuted && !(d.settings || {}).navVoiceSet) { d.settings.navVoice = 'mute'; }
  if (d.settings.voice === false && d.settings.alertType === 'voice') d.settings.alertType = 'sound';
  delete d.settings.voice;
  d.profile = { ...DEFAULT_PROFILE, ...(d.profile || {}) };
  // v1/v2 used short ids; the server needs UUIDs
  const remap = {};
  ['tickets', 'cameras', 'reports', 'routes', 'commutes', 'events', 'alerts'].forEach((k) => d[k].forEach((x) => {
    if (!isUuid(x.id)) { const n = uuid(); remap[x.id] = n; x.id = n; }
  }));
  d.commutes.forEach((c) => { if (remap[c.routeId]) c.routeId = remap[c.routeId]; });
  d.cameras = d.cameras.filter((c) => !c.example);
  d.reports.forEach((r) => { if (r.mine === undefined) r.mine = true; });
  d.v = 3;
  return d;
}

function load() {
  try { const d = JSON.parse(localStorage.getItem(KEY)); if (d && Array.isArray(d.tickets)) return normalize(d); } catch { /* fresh start */ }
  return seed();
}

export const S = { db: load(), user: null, cloud: false };

export function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(S.db)); }
  catch { toast('Your phone is out of storage for this app. Export a backup and clear old logs.'); }
}
export function save() { persist(); bus.emit('change'); }
export function replaceDb(d) { S.db = normalize(d); save(); }

// ---- Outbox: queued writes for the server --------------------------------
// op: 'upsert' | 'insert' | 'update' | 'delete'
export function queue(table, op, row) {
  // Always remembered, even while signed out or if the sign-in quietly expired:
  // the change waits in the outbox and uploads at the next sign-in (cloud.js flushes
  // only when signed in). Before, a change made while not signed in was never queued
  // and could be overwritten by the next sync.
  const id = row.id;
  // collapse repeated edits of the same row
  if (op === 'update' || op === 'upsert') {
    const prev = S.db.outbox.find((o) => o.table === table && o.row.id === id && (o.op === op || o.op === 'insert'));
    if (prev) { prev.row = { ...prev.row, ...row }; persist(); bus.emit('outbox'); return; }
  }
  if (op === 'delete') S.db.outbox = S.db.outbox.filter((o) => !(o.table === table && o.row.id === id));
  S.db.outbox.push({ table, op, row, at: Date.now() });
  persist(); bus.emit('outbox');
}

// ---- Typed mutators (local first, then queue) -----------------------------
const TABLE = { tickets: 'tickets', cameras: 'cameras', routes: 'routes', commutes: 'commutes', lists: 'lists', places: 'list_places' };
export function upsertLocal(list, rec) {
  const arr = S.db[list]; const i = arr.findIndex((x) => x.id === rec.id);
  if (i >= 0) arr[i] = rec; else arr.push(rec);
  if (TABLE[list]) queue(TABLE[list], 'upsert', { id: rec.id });   // cloud.js serializes the full row at flush time
  save();
}
export function removeLocal(list, id) {
  S.db[list] = S.db[list].filter((x) => x.id !== id);
  if (list === 'routes') S.db.commutes.filter((c) => c.routeId === id).forEach((c) => removeLocal('commutes', c.id));
  if (TABLE[list]) queue(TABLE[list], 'delete', { id });
  if (list === 'reports') queue('reports', 'delete', { id });
  if (list === 'passes') queue('camera_passes', 'delete', { id });
  if (list === 'lists') S.db.places.filter((p) => p.listId === id).forEach((p) => { S.db.places = S.db.places.filter((x) => x !== p); });
  save();
}

export function logAlert(kind, title, sub) {
  const a = { id: uuid(), time: Date.now(), kind, title, sub };
  S.db.alerts.unshift(a); if (S.db.alerts.length > 500) S.db.alerts.length = 500;
  queue('alert_log', 'insert', { id: a.id });
  persist(); bus.emit('log');
}
export function logEvent(kind, zone) {
  const e = { id: uuid(), time: Date.now(), kind, ...zone };
  S.db.events.unshift(e); if (S.db.events.length > 1000) S.db.events.length = 1000;
  queue('drive_events', 'insert', { id: e.id });
  persist(); bus.emit('log');
}
// ---- Recent searches (this phone only) --------------------------------------
export function remember(entry) {
  const key = (entry.q || entry.label || '').trim().toLowerCase(); if (!key) return;
  S.db.recent = [{ ...entry, time: Date.now() }, ...S.db.recent.filter((r) => (r.q || r.label || '').trim().toLowerCase() !== key)].slice(0, 20);
  persist();
}
export function forgetRecent(time) { S.db.recent = time == null ? [] : S.db.recent.filter((r) => r.time !== time); persist(); }

/** Auto-log: you just drove into a camera's zone. One row per pass; the speed is updated to your fastest while in the zone. */
export function logPass(c, mph) {
  const p = { id: uuid(), cameraId: c.id, name: c.name, kind: c.kind, limit: c.limit || null, jurisdiction: c.jurisdiction || (c.official ? '' : 'Your pin'), lat: c.lat, lng: c.lng, time: Date.now(), mph: Math.round(mph), over: c.limit ? Math.round(mph) - c.limit : null };
  S.db.passes.unshift(p); if (S.db.passes.length > 3000) S.db.passes.length = 3000;
  queue('camera_passes', 'insert', { id: p.id });
  persist(); bus.emit('log'); bus.emit('pass', p);
  return p;
}
export function updatePass(p, mph) {
  const m = Math.round(mph); if (m <= p.mph) return;
  p.mph = m; p.over = p.limit ? m - p.limit : null;
  queue('camera_passes', 'upsert', { id: p.id });
  persist(); bus.emit('log');
}
/** Speed at which this camera's jurisdiction starts ticketing: DC from 11 over the limit, Maryland from 12 over, Virginia from 10 over. */
export function ticketSpeed(c) {
  if (!c.limit) return null;
  const j = c.jurisdiction || '';
  return c.limit + (/DC|District/i.test(j) ? 11 : /, VA$|Virginia/i.test(j) ? 10 : 12);
}
/** Watched cameras: ones you flagged from My roads (or the map) for an earlier, louder warning and a slow-down nudge. */
export const isWatched = (c) => S.db.settings.watchCams.includes(c.id);
export function toggleWatch(c) {
  const w = S.db.settings.watchCams;
  const on = !w.includes(c.id);
  S.db.settings.watchCams = on ? [...w, c.id] : w.filter((x) => x !== c.id);
  save();
  return on;
}
/** Everything you logged while driving past this camera, newest first. */
export const cameraPasses = (c) => S.db.passes.filter((p) => p.cameraId === c.id);
export function logTrip(t) {
  const trip = { id: uuid(), ...t };
  S.db.trips.unshift(trip); if (S.db.trips.length > 300) S.db.trips.length = 300;
  queue('trips', 'insert', { id: trip.id });
  persist();
}

export const SENS = {
  low: { f: 0.75, window: 10, label: 'Low — fewer alerts' },
  medium: { f: 1, window: 20, label: 'Medium — balanced alerts' },
  high: { f: 1.4, window: 30, label: 'High — warn early and often' },
};
export const sens = () => SENS[S.db.settings.sensitivity] || SENS.medium;

/** All cameras the engine should watch: your pins plus official ones (if turned on). */
/** Your tickets from this camera: linked when you marked it, or logged within 150 m of it. */
export function cameraTickets(c) {
  // Logged from a camera → that camera only (so the N/B and S/B cameras on one block aren't both blamed); otherwise anything within 150 m
  return S.db.tickets.filter((t) => !t.example && !/^parking/i.test(t.type || '') && (t.cameraId ? t.cameraId === c.id : (t.lat != null && dist(t, c) <= 150)));
}
export function allCameras() {
  const mine = S.db.cameras;
  if (!S.db.settings.officialCams) return mine;
  // hide official cameras that duplicate one of your pins
  const off = S.db.official.filter((o) => !mine.some((m) => Math.abs(m.lat - o.lat) < 0.0006 && Math.abs(m.lng - o.lng) < 0.0006));
  return mine.concat(off);
}

/** Community reports: from the server when signed in, otherwise your own recent ones. */
import { ttlMs } from './reports.js';
export const LIVE_MS = 6 * 3600 * 1000;
export const reportLive = (r, now = Date.now()) => (r.expires || r.time + ttlMs(r.type)) > now && r.status !== 'hidden' && r.status !== 'merged';
export function activeReports() {
  const now = Date.now();
  if (S.cloud && S.db.communityAt) return S.db.community.filter((r) => r.expires > now);
  return S.db.reports.filter((r) => reportLive(r, now));
}
