// Community report types: icon, map group, color, and how long a report stays live (minutes).
// Keep in step with the type list in supabase/migrations/*_hazards.sql and the moderate-report agent.
export const RCAT = {
  'Speed trap / police':           { e: '🚓', g: 'police',    c: '#3b5bdb', ttl: 90 },
  'Officer location':              { e: '👮', g: 'police',    c: '#3b5bdb', ttl: 90 },
  'Immigration enforcement (ICE)': { e: '🚨', g: 'ice',       c: '#c2255c', ttl: 180 },
  'Checkpoint':                    { e: '🛑', g: 'police',    c: '#3b5bdb', ttl: 240 },
  'Accident':                      { e: '💥', g: 'emergency', c: '#e03131', ttl: 90 },
  'Emergency vehicle':             { e: '🚑', g: 'emergency', c: '#f03e3e', ttl: 30 },
  'Pothole':                       { e: '🕳️', g: 'hazard',    c: '#8d6e63', ttl: 4320 },
  'Debris':                        { e: '🪵', g: 'hazard',    c: '#e8590c', ttl: 120 },
  'Flooding':                      { e: '🌊', g: 'hazard',    c: '#1c7ed6', ttl: 360 },
  'Icy road':                      { e: '🧊', g: 'hazard',    c: '#1690b0', ttl: 360 },
  'Road hazard':                   { e: '🚧', g: 'hazard',    c: '#e8590c', ttl: 180 },
  'New camera':                    { e: '📷', g: 'camera',    c: '#d99100', ttl: 43200 },
  'Ticket hotspot':                { e: '⚠️', g: 'hotspot',   c: '#d42a2a', ttl: 43200 },
  'Other':                         { e: '📣', g: 'other',     c: '#7447d1', ttl: 180 },
};
export const RTYPES = Object.keys(RCAT);
export const HAZARDS = ['Accident', 'Emergency vehicle', 'Pothole', 'Debris', 'Flooding', 'Road hazard'];
export const rcat = (t) => RCAT[t] || RCAT.Other;
export const ttlMs = (t) => rcat(t).ttl * 60000;
