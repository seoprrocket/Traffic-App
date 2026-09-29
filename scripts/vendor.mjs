// Copies the three browser libraries into www/vendor so the app works offline and inside the phone app.
import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
const out = new URL('../www/vendor/', import.meta.url);
mkdirSync(out, { recursive: true });
const files = [
  ['leaflet/dist/leaflet.js', 'leaflet.js'],
  ['leaflet/dist/leaflet.css', 'leaflet.css'],
  ['leaflet.heat/dist/leaflet-heat.js', 'leaflet-heat.js'],
  ['@supabase/supabase-js/dist/umd/supabase.js', 'supabase.js'],
];
for (const [src, dst] of files) {
  const from = new URL('../node_modules/' + src, import.meta.url);
  if (!existsSync(from)) { console.error('Missing ' + src + ' — run npm install first'); process.exit(1); }
  copyFileSync(from, new URL(dst, out));
}
mkdirSync(new URL('images/', out), { recursive: true });
for (const img of ['layers.png', 'layers-2x.png', 'marker-icon.png', 'marker-icon-2x.png', 'marker-shadow.png']) {
  copyFileSync(new URL('../node_modules/leaflet/dist/images/' + img, import.meta.url), new URL('images/' + img, out));
}
// The setup page offers these SQL files for copy-paste
const sqlOut = new URL('../www/setup/', import.meta.url);
mkdirSync(sqlOut, { recursive: true });
for (const f of readdirSync(new URL('../supabase/migrations/', import.meta.url))) {
  if (f.endsWith('.sql')) copyFileSync(new URL('../supabase/migrations/' + f, import.meta.url), new URL(f, sqlOut));
}
console.log('Vendor files copied to www/vendor, SQL to www/setup');
