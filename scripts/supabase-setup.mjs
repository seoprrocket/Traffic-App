// Sets up Supabase for Invictus Traffic Radar using the Supabase Management API.
// Runs inside the GitHub Action (.github/workflows/supabase.yml); no database password or terminal needed.
//   node scripts/supabase-setup.mjs check | database | secrets | schedules | phone
import { readFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const API = process.env.SUPABASE_API || 'https://api.supabase.com';
const TOKEN = (process.env.SUPABASE_ACCESS_TOKEN || '').trim();
const REF = (process.env.SUPABASE_PROJECT_REF || '').trim().replace(/^https:\/\//, '').replace(/\.supabase\.co\/?$/, '');
const PROJECT_URL = process.env.SUPABASE_PROJECT_URL || `https://${REF}.supabase.co`;
const MIG = new URL('../supabase/migrations/', import.meta.url);

const out = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
const note = (msg) => { console.log(msg); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, msg + '\n'); };
const fail = (msg) => { console.log(`::error::${msg}`); note(`❌ ${msg}`); process.exit(1); };

async function call(path, opt = {}) {
  const r = await fetch(API + path, { ...opt, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(`${r.status} ${typeof body === 'string' ? body : body.message || body.error || JSON.stringify(body)}`.slice(0, 500));
  return body;
}
const sql = (query) => call(`/v1/projects/${REF}/database/query`, { method: 'POST', body: JSON.stringify({ query }) });
const file = (name) => readFileSync(new URL(name, MIG), 'utf8');
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

const steps = {
  async check() {
    if (!TOKEN || !REF) {
      note('⚠️ Add the SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF secrets in GitHub (Settings → Secrets and variables → Actions), then run this workflow again.');
      out('ready', 'false');
      return;
    }
    if (!/^[a-z0-9]{20}$/.test(REF)) fail(`SUPABASE_PROJECT_REF should be the 20-letter code from your project URL (https://<code>.supabase.co). Got "${REF}".`);
    let p;
    try { p = await call(`/v1/projects/${REF}`); }
    catch (e) { fail(/401|403/.test(e.message) ? 'Supabase rejected the access token. Make a new one at supabase.com/dashboard/account/tokens and update SUPABASE_ACCESS_TOKEN.' : `Couldn't find project ${REF}: ${e.message}`); }
    if (p.status && !/ACTIVE/.test(p.status)) fail(`Project "${p.name}" is ${p.status}. Restore it in the Supabase dashboard, then run again.`);
    note(`✅ Connected to Supabase project **${p.name}** (${REF})`);
    if (!process.env.ANTHROPIC_API_KEY) note('⚠️ ANTHROPIC_API_KEY is not set, so the AI features will stay off. Everything else still gets set up.');
    out('ready', 'true');
  },

  async database() {
    const [{ ok }] = await sql("select to_regclass('public.tickets') is not null as ok");
    if (!ok) { await sql(file('20260929000000_init.sql')); note('✅ Database built'); }
    else note('✅ Database already built');
    for (const f of ['20260929000050_setup_status.sql', '20260929000200_maryland.sql', '20260929000300_hazards.sql', '20261014000000_retire_zero_coords.sql', '20261014000100_ticket_camera.sql', '20261014000200_camera_passes.sql', '20261015000000_saved_lists.sql', '20261015000100_dmv_sources.sql']) await sql(file(f));
    note('✅ Database updates applied (status check, Maryland, hazard types)');
  },

  async secrets() {
    // A fresh scheduler secret each run, written to the agents and to Vault together so they always match
    const cron = randomBytes(24).toString('hex');
    const list = [{ name: 'CRON_SECRET', value: cron }];
    for (const k of ['ANTHROPIC_API_KEY', 'CONTACT_EMAIL', 'RESEND_API_KEY', 'RESEND_FROM', 'CLAUDE_MODEL', 'CLAUDE_FAST_MODEL']) {
      const v = (process.env[k] || '').trim();
      if (v) list.push({ name: k, value: v });
    }
    await call(`/v1/projects/${REF}/secrets`, { method: 'POST', body: JSON.stringify(list) });
    await sql(`do $$ begin
      if exists (select 1 from vault.secrets where name = 'project_url') then
        perform vault.update_secret((select id from vault.secrets where name = 'project_url'), ${lit(PROJECT_URL)});
      else perform vault.create_secret(${lit(PROJECT_URL)}, 'project_url'); end if;
      if exists (select 1 from vault.secrets where name = 'cron_secret') then
        perform vault.update_secret((select id from vault.secrets where name = 'cron_secret'), ${lit(cron)});
      else perform vault.create_secret(${lit(cron)}, 'cron_secret'); end if;
    end $$;`);
    note(`✅ Keys saved to Supabase: ${list.map((x) => x.name).join(', ')}`);
  },

  /** Phone sign-in with no texting bill: each number in PHONE_LOGINS gets a fixed 6-digit code (Supabase "test OTPs").
   *  PHONE_LOGINS = "+12405550123=123456, +13015550199=654321" (commas or new lines). Real Twilio texting, if ever set up in the
   *  dashboard, is left untouched; numbers not on the list fall through to it. */
  async phone() {
    const raw = (process.env.PHONE_LOGINS || '').trim();
    if (!raw) { note('ℹ️ PHONE_LOGINS not set: phone sign-in without texting stays as it is. Add the secret (number=code, one per line) to turn it on.'); return; }
    const entries = [];
    for (const part of raw.split(/[\n,;]+/)) {
      const m = /^\s*(\+?[\d\s().-]{10,18})\s*=\s*(\d{6})\s*$/.exec(part); if (!m) { if (part.trim()) note(`⚠️ Skipped "${part.trim().replace(/\d(?=\d{4})/g, '•')}" — use +1XXXXXXXXXX=123456`); continue; }
      let d = m[1].replace(/\D/g, ''); if (d.length === 10) d = '1' + d;
      entries.push([d, m[2]]);
    }
    if (!entries.length) fail('PHONE_LOGINS has no usable entries. Format: +12405550123=123456');
    const cfg = await call(`/v1/projects/${REF}/config/auth`);
    const list = entries.flatMap(([d, c]) => [`${d}:${c}`, `+${d}:${c}`]).join(',');   // Supabase format: phone:code,phone:code — both spellings so it matches however the number is stored
    const patch = {
      external_phone_enabled: true,
      sms_provider: cfg.sms_provider || 'twilio',
      sms_test_otp: list,
      sms_otp_length: 6,
    };
    if ((patch.sms_provider === 'twilio') && !cfg.sms_twilio_account_sid) Object.assign(patch, { sms_twilio_account_sid: 'ACnotconfigured', sms_twilio_auth_token: 'notconfigured', sms_twilio_message_service_sid: 'notconfigured' });
    await call(`/v1/projects/${REF}/config/auth`, { method: 'PATCH', body: JSON.stringify(patch) });
    note(`✅ Phone sign-in without texting: ${entries.length} number${entries.length === 1 ? '' : 's'} set (${entries.map(([d]) => '+' + d.replace(/\d(?=\d{4})/g, '•')).join(', ')}). Each signs in with its fixed code; no SMS is sent.`);
  },

  async schedules() {
    await sql(file('20260929000100_schedules.sql'));
    note('✅ Schedules installed (camera sync, commute predictor, weekly coach, cleanup)');
    const [{ n }] = await sql("select count(*)::int as n from public.cameras where owner_id is null and status = 'active'");
    if (!n) { await sql("select public.call_agent('camera-sync')"); note('✅ First camera load started. Cameras appear within a few minutes.'); }
    else note(`✅ ${n} official cameras already loaded`);
    note('\nAll set. Open /setup.html on your site and press **Check everything**.');
  },
};

const step = process.argv[2];
if (!steps[step]) fail(`Unknown step "${step}"`);
try { await steps[step](); } catch (e) { fail(`${step} failed: ${e.message}`); }
