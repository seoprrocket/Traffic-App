// Setup dashboard: walks through Netlify + Supabase and checks each step against the live project.
import { esc, toast, copyText, download } from './util.js';

// ---------------------------------------------------------------- saved answers (this browser only)
const LS = 'tr.setup';
const S = (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } })();
const keep = () => { try { localStorage.setItem(LS, JSON.stringify(S)); } catch { /* private mode */ } };
const live = window.TR_CONFIG || {};
S.url ??= live.supabaseUrl || '';
S.key ??= live.supabaseAnonKey || '';
S.company ??= live.company || '';
S.contact ??= live.contactEmail || '';
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
S.cronSecret ??= hex(24);
keep();

const $ = (s) => document.querySelector(s);
const ref = () => (String(S.url).match(/^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/) || [])[1] || null;
const base = () => String(S.url).replace(/\/+$/, '');
const dash = (path) => (ref() ? `https://supabase.com/dashboard/project/${ref()}/${path}` : 'https://supabase.com/dashboard/projects');
const isJwt = (k) => /^eyJ/.test(k || '');
const FNS = ['scan-ticket', 'voice-assist', 'dispute-helper', 'delete-account', 'camera-sync', 'moderate-report', 'commute-predict', 'weekly-coach'];
const JOBS = ['camera-sync-daily', 'commute-predict-nightly', 'weekly-coach-monday', 'publish-stuck-reports', 'housekeeping-weekly'];

function keyInfo(k) {
  k = (k || '').trim();
  if (!k) return { ok: false, msg: 'Paste the anon (public) or publishable key.' };
  if (/^sb_secret_/.test(k)) return { ok: false, danger: true, msg: 'That is a secret key. Never put it in the app: anyone could read and change your whole database. Use the publishable key instead.' };
  if (/^sb_publishable_/.test(k)) return { ok: true };
  if (isJwt(k)) {
    try {
      const part = k.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const p = JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4)));
      if (p.role === 'service_role') return { ok: false, danger: true, msg: 'That is the service_role key. Never put it in the app: anyone could read and change your whole database. Use the anon key instead.' };
      if (p.role === 'anon') return { ok: true };
    } catch { /* fall through */ }
  }
  return { ok: false, msg: "That doesn't look like a Supabase key. Copy the anon or publishable key from Project Settings → API." };
}
function urlInfo(u) {
  u = (u || '').trim();
  if (!u) return { ok: false, msg: 'Paste the Project URL.' };
  if (!/^https:\/\/[^/\s]+\/?$/.test(u)) return { ok: false, msg: 'Use just the address, like https://abcdefghijklmnopqrst.supabase.co' };
  return { ok: true };
}

// ---------------------------------------------------------------- checks
const R = { ran: false };
const hdrs = () => ({ apikey: S.key, ...(isJwt(S.key) ? { Authorization: `Bearer ${S.key}` } : {}) });
async function jfetch(url, opt = {}) {
  try {
    const r = await fetch(url, { cache: 'no-store', ...opt });
    let body = null; try { body = await r.json(); } catch { /* not json */ }
    return { status: r.status, body };
  } catch { return { status: 0, body: null }; }
}

async function checkSite() {
  const site = { https: location.protocol === 'https:' && !/^(localhost|127\.)/.test(location.hostname), host: location.host, netlify: /\.netlify\.app$/.test(location.hostname) };
  try { const h = await fetch(location.href, { method: 'HEAD', cache: 'no-store' }); site.headers = h.headers.get('x-content-type-options') === 'nosniff'; } catch { site.headers = false; }
  try { site.sw = !!(await navigator.serviceWorker?.getRegistration('./')); } catch { site.sw = false; }
  try {
    const t = await (await fetch('js/config.js', { cache: 'no-store' })).text();
    site.liveUrl = (t.match(/supabaseUrl:\s*['"]([^'"]*)['"]/) || t.match(/"supabaseUrl":\s*"([^"]*)"/) || [])[1] || '';
    site.liveKey = (t.match(/supabaseAnonKey:\s*['"]([^'"]*)['"]/) || t.match(/"supabaseAnonKey":\s*"([^"]*)"/) || [])[1] || '';
  } catch { site.liveUrl = ''; }
  try { site.override = !!JSON.parse(localStorage.getItem('tr.config'))?.supabaseUrl; } catch { site.override = false; }
  return site;
}

async function checkAll() {
  const btn = $('#checkAll'); btn.disabled = true; btn.textContent = 'Checking…';
  R.site = await checkSite();
  try { const r = await fetch('/api/trips', { cache: 'no-store' }); R.api = r.ok ? await r.json() : { ok: false }; } catch { R.api = { ok: false }; }
  R.conn = R.status = R.health = null;
  if (urlInfo(S.url).ok && keyInfo(S.key).ok) {
    const c = await jfetch(`${base()}/rest/v1/cameras?select=id&limit=1`, { headers: hdrs() });
    const code = c.body?.code;
    if (c.status === 0) R.conn = { reach: false };
    else if (c.status === 401 || c.status === 403) R.conn = { reach: true, keyOk: false, msg: c.body?.message };
    else R.conn = { reach: true, keyOk: true, tables: c.status === 200, missing: code === 'PGRST205' || code === '42P01' || c.status === 404 };
    if (R.conn.keyOk) {
      const s = await jfetch(`${base()}/rest/v1/rpc/setup_status`, { method: 'POST', headers: { ...hdrs(), 'Content-Type': 'application/json' }, body: '{}' });
      R.status = s.status === 200 ? s.body : null;
      const h = await jfetch(`${base()}/functions/v1/health`, { method: 'POST', headers: { ...hdrs(), 'Content-Type': 'application/json' }, body: '{}' });
      R.health = h.status === 200 && h.body?.ok ? h.body : null;
    }
  }
  R.ran = true;
  btn.disabled = false; btn.textContent = 'Check everything';
  render();
}

// ---------------------------------------------------------------- UI helpers
const code = (id, caption, text) => `<div class="code"><div class="cap"><span>${esc(caption)}</span><button class="sbtn" data-copy="${id}">Copy</button></div><pre id="${id}">${esc(text)}</pre></div>`;
const check = (state, label, note) => `<li class="${state === true ? 'c-ok' : state === false ? 'c-bad' : state === 'maybe' ? 'c-maybe' : ''}"><span>${label}${note ? `<small>${note}</small>` : ''}</span></li>`;
const links = (arr) => `<div class="links">${arr.map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`).join('')}</div>`;
const PILL = { done: 'Done', warn: 'Almost', todo: 'To do', unknown: 'Not checked' };

function configText() {
  return `// Ticket Radar settings. Generated by the setup page.\nwindow.TR_CONFIG = {\n  supabaseUrl: ${JSON.stringify(base())},\n  supabaseAnonKey: ${JSON.stringify(S.key.trim())},\n  company: ${JSON.stringify(S.company)},\n  contactEmail: ${JSON.stringify(S.contact)},\n};\n`;
}
function vaultSql() {
  const u = (base() || 'https://YOUR-PROJECT-REF.supabase.co').replace(/'/g, "''");
  return `-- Lets the database call your agents. Safe to run again.
do $$ begin
  if exists (select 1 from vault.secrets where name = 'project_url') then
    perform vault.update_secret((select id from vault.secrets where name = 'project_url'), '${u}');
  else perform vault.create_secret('${u}', 'project_url'); end if;
  if exists (select 1 from vault.secrets where name = 'cron_secret') then
    perform vault.update_secret((select id from vault.secrets where name = 'cron_secret'), '${S.cronSecret}');
  else perform vault.create_secret('${S.cronSecret}', 'cron_secret'); end if;
end $$;`;
}
function terminal() {
  return `cd ticket-radar            # the folder you unzipped
npx supabase login
npx supabase link --project-ref ${ref() || 'YOUR-PROJECT-REF'}

npx supabase functions deploy scan-ticket voice-assist dispute-helper delete-account
npx supabase functions deploy camera-sync moderate-report commute-predict weekly-coach health --no-verify-jwt

npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-YOUR-KEY CRON_SECRET=${S.cronSecret} CONTACT_EMAIL=${S.contact || 'you@yourdomain.com'}`;
}
const EMAIL = `<h2>Your Ticket Radar code</h2>
<p>Enter this code in the app to sign in:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px">{{ .Token }}</p>
<p>If you didn't ask for this, you can ignore this email.</p>`;

// ---------------------------------------------------------------- steps
function steps() {
  const site = R.site || {}, conn = R.conn, st = R.status, hl = R.health;
  const out = [];

  // 1. Netlify
  {
    const state = !R.ran ? 'unknown' : site.https ? (site.headers ? 'done' : 'warn') : 'todo';
    out.push({ title: 'Put the site on Netlify', sub: site.https ? `Live at ${site.host}` : 'Host the www folder over https', state, html: `
      <ul class="checks">
        ${check(R.ran ? site.https : null, 'Served over https', site.https ? '' : "Phones only share GPS with https sites. You're viewing this page locally.")}
        ${check(R.ran ? (site.netlify ? true : site.https ? 'maybe' : null) : null, site.netlify ? 'Hosted on Netlify' : 'Hosted on Netlify', site.netlify || !site.https ? '' : `Running at ${esc(site.host)}. Fine if that's your custom domain on Netlify.`)}
        ${check(R.ran ? site.headers : null, 'Netlify settings file is active', site.headers ? '' : 'The _headers file in www sets safety and caching rules. Upload the whole www folder, not single files.')}
        ${check(R.ran ? (site.sw || 'maybe') : null, 'Offline support is on', site.sw ? '' : 'Turns on the first time someone opens the app itself.')}
      </ul>
      <p class="small" style="margin:0"><b>First upload:</b> drag the <span class="mono">www</span> folder onto Netlify Drop. <b>Updates:</b> open your site in Netlify → Deploys, and drag the folder onto that page so the address stays the same.</p>
      ${links([['Netlify Drop', 'https://app.netlify.com/drop'], ['Your Netlify sites', 'https://app.netlify.com/']])}` });
  }

  // 2. Netlify Functions: live traffic, notifications, Share drive
  {
    const a = R.api || {};
    const state = !R.ran ? 'unknown' : !a.ok ? 'todo' : a.traffic && a.push ? 'done' : 'warn';
    const v = S.vapid;
    out.push({ title: 'Live traffic & notifications', sub: 'Netlify Functions: Plan a Drive traffic, "time to leave", Share drive', state, html: `
      <ul class="checks">
        ${check(R.ran ? !!a.ok : null, 'Functions are deployed', a.ok ? '' : 'They deploy automatically when Netlify builds from your GitHub repo. Drag-and-drop deploys skip them.')}
        ${check(R.ran && a.ok ? (a.traffic ? true : 'maybe') : null, 'Live traffic (Google)', a.traffic ? '' : 'Optional. Without it, Plan a Drive uses typical drive times plus 20%.')}
        ${check(R.ran && a.ok ? (a.push ? true : 'maybe') : null, 'Phone notifications', a.push ? '' : 'Add the three VAPID values below.')}
        ${check(R.ran && a.ok ? true : null, 'Share drive links', 'Work as soon as the functions are deployed.')}
      </ul>
      <p class="small" style="margin:0"><b>1. Notification keys.</b> Press the button to make a key pair in this browser, then add all three lines in Netlify → Site configuration → Environment variables. Keep the private key secret.</p>
      <div class="btns"><button class="btn" data-act="vapid">${v ? 'Make new keys' : 'Make notification keys'}</button></div>
      ${v ? code('vapid-env', 'Netlify environment variables', `VAPID_PUBLIC_KEY=${v.pub}\nVAPID_PRIVATE_KEY=${v.priv}\nVAPID_SUBJECT=mailto:${S.contact || 'you@yourdomain.com'}`) : ''}
      <p class="small" style="margin:0"><b>2. Live traffic (optional).</b> In Google Cloud: create a project and turn on billing (Google includes free monthly usage), enable the <b>Routes API</b>, create an API key, and restrict it to the Routes API. Then add it in Netlify:</p>
      ${code('google-env', 'Netlify environment variables', 'GOOGLE_MAPS_API_KEY=your-key-here\nGOOGLE_DAILY_LIMIT=400')}
      <p class="note small" style="margin:0">GOOGLE_DAILY_LIMIT caps Google calls per day to protect your bill; after that the app falls back to typical times. Checking one planned drive uses up to 5 calls, and each saved trip uses a few more on the day.</p>
      ${links([['Routes API', 'https://console.cloud.google.com/apis/library/routes.googleapis.com'], ['API keys', 'https://console.cloud.google.com/apis/credentials'], ['Billing & budgets', 'https://console.cloud.google.com/billing'], ['Netlify sites', 'https://app.netlify.com/']])}
      <p class="small" style="margin:0"><b>3.</b> In Netlify, open <b>Deploys → Trigger deploy</b> so the new variables take effect, then press <b>Check everything</b>.</p>` });
  }

  // 3. Supabase project
  {
    const ui = urlInfo(S.url), ki = keyInfo(S.key);
    const state = !(ui.ok && ki.ok) ? 'todo' : !R.ran ? 'unknown' : conn?.reach && conn?.keyOk ? 'done' : 'todo';
    const msg = !R.ran || !(ui.ok && ki.ok) ? '' : !conn?.reach ? "Couldn't reach that URL. Check it's the Project URL, and that the project isn't paused." : !conn?.keyOk ? `Supabase rejected the key${conn.msg ? ': ' + esc(conn.msg) : ''}.` : '';
    out.push({ title: 'Connect Supabase', sub: ref() ? `Project ${ref()}` : 'Accounts, sync, community reports and AI', state, html: `
      <ol class="small"><li>Create a free project at supabase.com. Pick the US East region.</li><li>Open Project Settings → API and copy the <b>Project URL</b> and the <b>anon</b> (or <b>publishable</b>) key.</li></ol>
      ${links([['Supabase projects', 'https://supabase.com/dashboard/projects'], ['API settings', dash('settings/api')]])}
      <label class="f">Project URL<input type="text" id="in-url" value="${esc(S.url)}" placeholder="https://abcdefghijklmnopqrst.supabase.co" autocomplete="off" spellcheck="false"></label>
      <label class="f">Anon / publishable key<input type="text" id="in-key" value="${esc(S.key)}" placeholder="eyJhbGciOi… or sb_publishable_…" autocomplete="off" spellcheck="false"></label>
      ${!ki.ok && ki.danger ? `<div class="danger"><b>Stop.</b> ${esc(ki.msg)}</div>` : ''}
      ${msg ? `<div class="danger">${msg}</div>` : ''}
      <div class="btns"><button class="btn primary" data-act="save-conn">Save and test</button></div>` });
  }

  // 3. Database
  {
    const md = !!st?.maryland && !!st?.hazards;
    const state = !R.ran || !conn?.keyOk ? (conn?.keyOk === false ? 'todo' : 'unknown') : conn.tables && st && md ? 'done' : conn.tables ? 'warn' : 'todo';
    out.push({ title: 'Build the database', sub: 'Tables, security rules and the status check', state, html: `
      <ul class="checks">
        ${check(R.ran && conn?.keyOk ? !!conn.tables : null, 'Ticket Radar tables exist')}
        ${check(R.ran && conn?.keyOk ? !!st : null, 'Setup status check installed', st ? '' : 'Included in the copy below.')}
        ${check(R.ran && conn?.keyOk && st ? !!st.maryland : null, 'Maryland cameras enabled')}
        ${check(R.ran && conn?.keyOk && st ? !!st.hazards : null, 'New hazard types (accidents, potholes, flooding, emergency vehicles)')}
        ${R.ran && conn?.tables && st && !md ? '<li class="c-maybe"><span>Your database was built before these were added. Press "Copy database updates", run it, and check again.</span></li>' : ''}
      </ul>
      <ol class="small"><li>Press <b>Copy database SQL</b>.</li><li>Open the SQL editor, paste, and press Run. It takes a few seconds.</li><li>Come back and press <b>Check everything</b>.</li></ol>
      <div class="btns"><button class="btn primary" data-act="copy-db">Copy database SQL</button>${conn?.tables && !md ? '<button class="btn" data-act="copy-md">Copy database updates</button>' : ''}</div>
      ${links([['SQL editor', dash('sql/new')]])}
      <p class="note small" style="margin:0">Run it only once on a new project. If it says a table already exists, that part is done.</p>` });
  }

  // 4. Sign-in emails
  {
    const state = S.emailDone ? 'done' : 'todo';
    out.push({ title: 'Set up sign-in emails', sub: 'People sign in with a 6-digit emailed code', state, html: `
      <ol class="small">
        <li>Open Authentication → Emails, choose the <b>Magic Link</b> template, and replace its body with the text below. The subject can be "Your Ticket Radar code".</li>
        <li>Open Authentication → URL Configuration and set <b>Site URL</b> to <span class="mono sel">${esc(location.origin)}</span></li>
        <li><b>Before other people sign in:</b> Supabase's built-in sender only emails your own team and only a few per hour. Add custom SMTP under Authentication → Emails → SMTP Settings. Resend works well and has a free tier.</li>
      </ol>
      ${code('email-tpl', 'Magic Link email body', EMAIL)}
      ${links([['Email templates', dash('auth/templates')], ['URL configuration', dash('auth/url-configuration')], ['Resend', 'https://resend.com']])}
      <label class="switch"><input type="checkbox" id="in-email" ${S.emailDone ? 'checked' : ''}><span><b>I've updated the email template</b><small>This page can't read your email settings, so tick this yourself.</small></span></label>` });
  }

  // 5. Connect the live app
  {
    const matches = R.ran && site.liveUrl && site.liveUrl.replace(/\/+$/, '') === base() && site.liveKey === S.key.trim();
    const state = !urlInfo(S.url).ok ? 'todo' : !R.ran ? 'unknown' : matches ? 'done' : site.override ? 'warn' : 'todo';
    out.push({ title: 'Connect the live app', sub: 'Put your project settings in config.js', state, html: `
      <ul class="checks">
        ${check(R.ran ? !!matches : null, 'The live site uses this project', matches ? '' : site.liveUrl ? `The live config.js points to ${esc(site.liveUrl)}.` : 'The live config.js is still empty.')}
        ${check(R.ran ? (site.override ? 'maybe' : null) : null, site.override ? 'This device is connected for testing' : 'Test on this device first (optional)')}
      </ul>
      <div class="grid2"><label class="f">Business name (Privacy Policy &amp; Terms)<input type="text" id="in-company" value="${esc(S.company)}" placeholder="Your business name"></label>
        <label class="f">Contact email (Privacy Policy &amp; Terms)<input type="text" id="in-contact" value="${esc(S.contact)}" placeholder="support@yourdomain.com"></label></div>
      <p class="small" style="margin:0"><b>Drag-and-drop sites:</b> download config.js, replace <span class="mono">www/js/config.js</span> with it, then drag the <span class="mono">www</span> folder onto your site's Deploys page.</p>
      ${code('cfg', 'www/js/config.js', configText())}
      <div class="btns"><button class="btn primary" data-act="dl-config">Download config.js</button>
        ${site.override ? '<button class="btn" data-act="stop-device">Stop testing on this device</button>' : '<button class="btn" data-act="use-device">Use on this device now</button>'}</div>
      <p class="small" style="margin:0"><b>Sites deployed from GitHub:</b> skip the download. In Netlify → Site configuration → Environment variables, add these, then redeploy. The build writes config.js for you.</p>
      ${code('envs', 'Netlify environment variables', `SUPABASE_URL=${base()}\nSUPABASE_ANON_KEY=${S.key.trim()}\nTR_COMPANY=${S.company}\nTR_CONTACT_EMAIL=${S.contact}`)}` });
  }

  // 6. AI agents
  {
    const fns = hl?.functions || {};
    const nf = FNS.filter((f) => fns[f]).length;
    const sec = hl?.secrets || {};
    const jobs = (st?.cron_jobs || []).map((j) => j.name);
    const jobsOk = JOBS.every((j) => jobs.includes(j));
    const camsDC = st?.cameras?.dc_open_data || 0;
    const camsMD = st?.cameras?.md_open_data || 0;
    const hashOk = hl?.cron_hash && st?.cron_hash ? hl.cron_hash === st.cron_hash : null;
    const items = [!!hl, nf === FNS.length, hl?.anthropic === 'ok', !!sec.CRON_SECRET, !!(st?.vault_project_url && st?.vault_cron_secret), hashOk === true, jobsOk, camsDC > 0 && camsMD > 0];
    const n = items.filter(Boolean).length;
    const state = !R.ran || !conn?.keyOk ? 'unknown' : n === items.length ? 'done' : n > 0 ? 'warn' : 'todo';
    const on = R.ran && conn?.keyOk;
    out.push({ title: 'Turn on the AI agents', sub: on ? `${n} of ${items.length} checks passing` : 'Scanner, voice, moderator, coach and more', state, html: `
      <ul class="checks">
        ${check(on ? (nf === FNS.length ? true : hl ? 'maybe' : false) : null, 'Agents deployed', hl ? `${nf} of ${FNS.length} found${nf < FNS.length ? ': missing ' + FNS.filter((f) => !fns[f]).join(', ') : ''}` : 'Run the terminal commands below. You need Node.js installed.')}
        ${check(on && hl ? hl.anthropic === 'ok' : null, 'Anthropic API key works', !hl ? '' : !sec.ANTHROPIC_API_KEY ? 'Not set yet.' : hl.anthropic === 'invalid' ? 'Anthropic rejected the key. Create a new one and set it again.' : hl.anthropic !== 'ok' ? `Couldn't confirm (${esc(hl.anthropic)}).` : '')}
        ${check(on && hl ? !!sec.CRON_SECRET : null, 'Scheduler secret set on the agents')}
        ${check(on && hl ? (sec.CONTACT_EMAIL ? true : 'maybe') : null, 'Contact email set', 'Used politely when looking up addresses on OpenStreetMap.')}
        ${check(on ? !!(st?.vault_project_url && st?.vault_cron_secret) : null, 'Database can call the agents', 'Run the Vault SQL below.')}
        ${check(on && hashOk !== null ? hashOk : null, 'Both copies of the scheduler secret match', hashOk === false ? 'They differ. Run the terminal "secrets set" line and the Vault SQL again, both from this page.' : '')}
        ${check(on ? jobsOk : null, 'Schedules installed', jobsOk ? '' : 'Run the schedules SQL below (after the Vault SQL).')}
        ${check(on ? (camsDC > 0 && camsMD > 0 ? true : camsDC || camsMD ? 'maybe' : false) : null, 'Official cameras loaded', camsDC || camsMD ? `${camsDC} DC · ${camsMD} Maryland${camsMD ? '' : ' (run the Maryland update in step 3, redeploy camera-sync, then load cameras again)'}` : 'Run "Load cameras now" below once everything above is set.')}
        ${check(on && hl ? (sec.RESEND_API_KEY && sec.RESEND_FROM ? true : 'maybe') : null, 'Weekly coach email (optional)', sec.RESEND_API_KEY ? '' : 'Set RESEND_API_KEY and RESEND_FROM to email the Monday review.')}
      </ul>
      <p class="small" style="margin:0"><b>1. In a terminal</b>, from the unzipped ticket-radar folder. Replace <span class="mono">sk-ant-YOUR-KEY</span> with your key from console.anthropic.com. The scheduler secret was made for you in this browser; keep it private.</p>
      ${code('term', 'Terminal', terminal())}
      <p class="small" style="margin:0"><b>2. In the SQL editor</b>, run this so the database can call the agents:</p>
      ${code('vault', 'SQL: Vault', vaultSql())}
      <p class="small" style="margin:0"><b>3.</b> Still in the SQL editor, install the schedules, then load the cameras:</p>
      <div class="btns"><button class="btn" data-act="copy-sched">Copy schedules SQL</button></div>
      ${code('loadcams', 'SQL: load cameras now', "select public.call_agent('camera-sync');")}
      ${links([['SQL editor', dash('sql/new')], ['Edge Functions', dash('functions')], ['Anthropic keys', 'https://console.anthropic.com/settings/keys'], ['Node.js', 'https://nodejs.org']])}
      <p class="note small" style="margin:0">Optional coach email: <span class="mono">npx supabase secrets set RESEND_API_KEY=re_… RESEND_FROM="Ticket Radar &lt;coach@yourdomain.com&gt;"</span>. <button class="linkish" data-act="new-secret">Make a new scheduler secret</button></p>` });
  }
  return out;
}

function healthHtml() {
  const st = R.status; if (!st) return '';
  const cams = Object.entries(st.cameras || {});
  const fmt = (t) => (t ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never');
  return `<div class="health">
      <div class="kpi"><small>Official cameras</small><b>${cams.reduce((s, [, n]) => s + n, 0)}</b></div>
      <div class="kpi"><small>Reports stuck in review</small><b>${st.reports_waiting ?? 0}</b></div>
    </div>
    ${st.reports_waiting ? '<p class="small bad">Reports are waiting on the moderator. Check the moderate-report logs and step 6.</p>' : ''}
    ${cams.length ? `<p class="small">By source: ${cams.map(([k, n]) => `${esc(k.replace('dc_open_data', 'DC open data').replace('md_open_data', 'Maryland open data').replace('agent', 'county pages'))} ${n}`).join(' · ')}</p>` : ''}
    <h3>Camera sources</h3><div class="scroll"><table class="tbl"><thead><tr><th>Source</th><th>Last run</th><th>Result</th></tr></thead><tbody>
      ${(st.camera_sources || []).map((c) => `<tr><td>${esc(c.jurisdiction)}${c.enabled ? '' : ' (off)'}</td><td>${fmt(c.last_run_at)}</td><td>${esc(c.last_result || '—')}</td></tr>`).join('')}</tbody></table></div>
    ${st.cron_jobs ? `<h3>Schedules</h3><div class="scroll"><table class="tbl"><thead><tr><th>Job</th><th>Last run</th><th>Status</th></tr></thead><tbody>
      ${st.cron_jobs.map((j) => `<tr><td>${esc(j.name)}</td><td>${fmt(j.last_run)}</td><td class="${j.last_status === 'failed' ? 'bad' : ''}">${esc(j.last_status || '—')}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <p class="note small">Add more county or town camera pages with: <span class="mono">insert into camera_sources (jurisdiction, url) values ('Rockville, MD', 'https://…');</span></p>`;
}

// ---------------------------------------------------------------- render
function render() {
  const list = steps();
  const open = new Set([...document.querySelectorAll('#steps details[open]')].map((d) => d.dataset.i));
  const first = !document.querySelector('#steps details');
  $('#steps').innerHTML = list.map((s, i) => `<details class="step" data-i="${i}" data-s="${s.state}"${(first ? s.state !== 'done' && list.findIndex((x) => x.state !== 'done') === i : open.has(String(i))) ? ' open' : ''}>
    <summary><span class="num">${s.state === 'done' ? '✓' : i + 1}</span><span class="t"><h2>${esc(s.title)}</h2><p>${esc(s.sub)}</p></span><span class="pill ${s.state}">${PILL[s.state]}</span></summary>
    <div class="body">${s.html}</div></details>`).join('');
  const done = list.filter((s) => s.state === 'done').length;
  $('#meter').style.width = `${(done / list.length) * 100}%`;
  $('#count').textContent = `${done} of ${list.length} done`;
  const h = healthHtml(); $('#healthCard').hidden = !h; $('#health').innerHTML = h;
}

// ---------------------------------------------------------------- actions
async function sqlFile(name) { const r = await fetch(`setup/${name}`, { cache: 'no-store' }); if (!r.ok) throw new Error(); return r.text(); }
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'in-email') { S.emailDone = t.checked; keep(); render(); }
  if (t.id === 'in-company' || t.id === 'in-contact') { S[t.id === 'in-company' ? 'company' : 'contact'] = t.value.trim(); keep(); render(); }
});
document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-copy]');
  if (c) { copyText($('#' + c.dataset.copy).textContent); return; }
  const a = e.target.closest('[data-act]'); if (!a) return;
  const act = a.dataset.act;
  if (act === 'save-conn') {
    S.url = $('#in-url').value.trim().replace(/\/+$/, ''); S.key = $('#in-key').value.trim(); keep();
    const ui = urlInfo(S.url), ki = keyInfo(S.key);
    if (!ui.ok) { toast(ui.msg); render(); return; }
    if (!ki.ok) { toast(ki.danger ? "That key must not go in the app." : ki.msg); render(); return; }
    await checkAll();
  } else if (act === 'copy-db') {
    try { const sql = [await sqlFile('20260929000000_init.sql'), await sqlFile('20260929000050_setup_status.sql'), await sqlFile('20260929000200_maryland.sql'), await sqlFile('20260929000300_hazards.sql')].join('\n\n'); copyText(sql); }
    catch { toast("Couldn't load the SQL files. Upload the whole www folder, including www/setup."); }
  } else if (act === 'copy-md') {
    try { copyText([await sqlFile('20260929000050_setup_status.sql'), await sqlFile('20260929000200_maryland.sql'), await sqlFile('20260929000300_hazards.sql')].join('\n\n')); } catch { toast("Couldn't load the SQL file. Upload the whole www folder."); }
  } else if (act === 'copy-sched') {
    try { copyText(await sqlFile('20260929000100_schedules.sql')); } catch { toast("Couldn't load the SQL file. Upload the whole www folder."); }
  } else if (act === 'dl-config') {
    download('config.js', configText(), 'text/javascript');
  } else if (act === 'use-device') {
    if (!keyInfo(S.key).ok) { toast('Save a valid project URL and key first'); return; }
    localStorage.setItem('tr.config', JSON.stringify({ supabaseUrl: base(), supabaseAnonKey: S.key.trim() }));
    toast('This device is connected. Open the app to sign in.'); await checkAll();
  } else if (act === 'stop-device') {
    localStorage.removeItem('tr.config'); toast('This device is back to the live settings'); await checkAll();
  } else if (act === 'vapid') {
    try {
      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
      const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
      const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      S.vapid = { pub: b64u(raw), priv: jwk.d }; keep(); render();
      toast('Keys made. Copy them into Netlify.');
    } catch { toast("This browser couldn't make keys. Try Chrome."); }
  } else if (act === 'new-secret') {
    S.cronSecret = hex(24); keep(); render(); toast('New secret made. Run the terminal "secrets set" line and the Vault SQL again.');
  }
});
$('#checkAll').onclick = checkAll;

render();
checkAll();
