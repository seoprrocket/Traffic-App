// Writes www/js/config.js from environment variables (Netlify builds from GitHub).
// If SUPABASE_URL isn't set, the existing config.js is left alone.
import { writeFileSync } from 'node:fs';
const e = process.env;
if (!e.SUPABASE_URL) { console.log('SUPABASE_URL not set; keeping www/js/config.js as is'); process.exit(0); }
if (/^sb_secret_/.test(e.SUPABASE_ANON_KEY || '') || /service_role/.test(Buffer.from((e.SUPABASE_ANON_KEY || '').split('.')[1] || '', 'base64').toString())) {
  console.error('SUPABASE_ANON_KEY is a secret/service_role key. Use the anon or publishable key.'); process.exit(1);
}
const cfg = { supabaseUrl: e.SUPABASE_URL, supabaseAnonKey: e.SUPABASE_ANON_KEY || '', company: e.TR_COMPANY || '', contactEmail: e.TR_CONTACT_EMAIL || '' };
writeFileSync(new URL('../www/js/config.js', import.meta.url), `// Written by scripts/write-config.mjs from Netlify environment variables\nwindow.TR_CONFIG = ${JSON.stringify(cfg, null, 2)};\n`);
console.log('Wrote www/js/config.js for', cfg.supabaseUrl);
