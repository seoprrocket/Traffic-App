// Local state. Everything the app shows comes from here, so it works offline.
// When signed in, cloud.js mirrors changes to Supabase through the outbox.
import { uuid, isUuid, bus, toast } from './util.js';

const KEY = 'ticketRadar.v1';

export const DEFAULT_SETTINGS = {
  lead: 5, ticketRadius: 300, alertType: 'voice', share: false, ai: true, sensitivity: 'medium',
  officialCams: true, speedLimits: true, handsFreeAuto: true,
  speedOverBy: 5, speedMax: 0, roadBumps: true, roadCurves: true, roadLimits: true, roadTolls: true,
};
export const DEFAULT_PROFILE = { name: '', homeLabel: '', workLabel: '', avoidRisk: 'warn', emailCoach: true };
const LISTS = ['tickets', 'cameras', 'reports', 'routes', 'commutes', 'events', 'alerts', 'trips', 'outbox', 'official', 'community', 'hotspots', 'coach', 'predictions', 'disputes', 'plans'];

function seed() {
  return {
    v: 3,
    tickets: [{ id: uuid(), street: 'Example — New York Ave NE', lat: 38.9146, lng: -76.9859, date: '2026-08-14', time: '', type: 'Speed camera', fine: 125, speed: 42, limit: 30, notes: 'Sample entry so you can see how it works. Edit or delete it.', example: true, shared: false, alertType: 'voice' }],
    cameras: [], reports: [], routes: [], commutes: [], events: [], alerts: [], trips: [], outbox: [],
    official: [], officialAt: 0, community: [], communityAt: 0, hotspots: [], coach: [], predictions: [], disputes: [],
    settings: { ...DEFAULT_SETTINGS }, profile: { ...DEFAULT_PROFILE },
    acceptedTerms: null, syncedUser: null, lastPull: 0,
  };
}

export function normalize(d) {
  LISTS.forEach((k) => { if (!Array.isArray(d[k])) d[k] = []; });
  d.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
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
  if (!S.user) return;
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
const TABLE = { tickets: 'tickets', cameras: 'cameras', routes: 'routes', commutes: 'commutes' };
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
