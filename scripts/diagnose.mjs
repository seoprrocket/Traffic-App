// Diagnoses the AI agents: recent Edge Function errors, and a live test of the scanner's Claude request.
// Run by .github/workflows/diagnose.yml. Prints results as GitHub annotations (no secrets, no user data).
const { SUPABASE_ACCESS_TOKEN: TOKEN, SUPABASE_PROJECT_REF: REF, ANTHROPIC_API_KEY: KEY, CLAUDE_MODEL } = process.env;
const note = (title, msg, level = 'notice') => console.log(`::${level} title=${title}::${String(msg).replace(/%/g, '%25').replace(/\r?\n/g, '%0A').slice(0, 3500)}`);

// 1. Recent function errors
try {
  const start = new Date(Date.now() - 24 * 3600e3).toISOString();
  const sql = "select timestamp, event_message from function_logs where regexp_contains(event_message, '(?i)error|claude|fail|exception|uncaught') order by timestamp desc limit 25";
  const u = `https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/logs.all?` + new URLSearchParams({ sql, iso_timestamp_start: start, iso_timestamp_end: new Date().toISOString() });
  const r = await fetch(u, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const j = await r.json().catch(() => ({}));
  const rows = (j.result || []).map((x) => `${new Date(x.timestamp / 1000).toISOString()}  ${String(x.event_message).replace(/sk-ant-[\w-]+/g, 'sk-ant-***').slice(0, 400)}`);
  note('Function errors (last 24h)', r.ok ? (rows.join('\n') || 'none') : `HTTP ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
} catch (e) { note('Function errors', e.message, 'warning'); }

// 2. Edge function request log for scan-ticket (status codes)
try {
  const start = new Date(Date.now() - 24 * 3600e3).toISOString();
  const sql = "select timestamp, m.function_id, r.status_code, r.execution_time_ms from function_edge_logs cross join unnest(metadata) as m cross join unnest(m.response) as r order by timestamp desc limit 15";
  const u = `https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/logs.all?` + new URLSearchParams({ sql, iso_timestamp_start: start, iso_timestamp_end: new Date().toISOString() });
  const r = await fetch(u, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const j = await r.json().catch(() => ({}));
  note('Function calls (last 24h)', r.ok ? ((j.result || []).map((x) => `${new Date(x.timestamp / 1000).toISOString()} ${x.function_id} → ${x.status_code} (${x.execution_time_ms} ms)`).join('\n') || 'none') : `HTTP ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
} catch (e) { note('Function calls', e.message, 'warning'); }

// 3. The scanner's exact Claude request shape, with a tiny text ticket
try {
  const PARKING = ['Expired meter', 'Other'];
  const one = { type: 'object', properties: {
    violation_type: { type: 'string', enum: ['Speed camera', 'Parking', 'Other'] },
    parking_reason: { type: ['string', 'null'], enum: [...PARKING, null] },
    violation_date: { type: ['string', 'null'] }, fine_amount: { type: ['number', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['violation_type', 'confidence'] };
  const tool = { name: 'record_tickets', description: 'Record tickets.', input_schema: { type: 'object', properties: {
    is_ticket: { type: 'boolean' }, tickets: { type: 'array', items: one, maxItems: 20 }, note_for_driver: { type: 'string' } }, required: ['is_ticket', 'tickets', 'note_for_driver'] } };
  const model = CLAUDE_MODEL || 'claude-sonnet-5-5';
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': KEY || '', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: 'user', content: 'Speed camera ticket, 09/02/2026, 16th St NW, $100. Record every ticket.' }], tools: [tool], tool_choice: { type: 'tool', name: 'record_tickets' } }) });
  const t = await r.text();
  note(`Claude test (${model})`, `HTTP ${r.status}\n${t.slice(0, 900)}`, r.ok ? 'notice' : 'error');
} catch (e) { note('Claude test', e.message, 'error'); }
