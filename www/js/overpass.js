// OpenStreetMap Overpass queries with backup servers and a time limit.
// The main public server is often overloaded (429/504) or slow; try the next one instead of waiting forever.
const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
let preferred = 0;   // remember which server answered last

export async function overpass(query, { timeoutMs = 12000, signal } = {}) {
  let lastErr = null;
  for (let i = 0; i < SERVERS.length; i++) {
    const idx = (preferred + i) % SERVERS.length;
    const ctl = new AbortController();
    const stop = () => ctl.abort();
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, timeoutMs);
    try {
      const r = await fetch(SERVERS[idx], { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j?.remark && /runtime error|timed out|rate_limited/i.test(j.remark) && !(j.elements || []).length) throw new Error(j.remark);
      preferred = idx;
      return j;
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw e;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
  }
  throw lastErr || new Error('Map data servers are not responding');
}
