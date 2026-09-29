// Import tickets from ticket websites (cite-web.com and others), screenshots, photos, PDFs or pasted text.
// Pasted text is read on the phone. Pictures go to the AI scanner when you're signed in; otherwise they're read on the phone (OCR).
import { S, upsertLocal } from './store.js';
import { $, $$, esc, money, toast, dist, bus } from './util.js';
import { cloudConfigured, agent } from './cloud.js';
import { pageHead, bindBack, go, ticketForm, PARKING_REASONS } from './ui.js';

// ---------------------------------------------------------------- text → tickets (no AI, no network)
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const DATE_RE = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})|(\d{4})-(\d{2})-(\d{2})|\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i;
const DATE_SRC = DATE_RE.source;
const pad = (n) => String(n).padStart(2, '0');
export function toIsoDate(s) {
  const m = DATE_RE.exec(s || ''); if (!m) return '';
  let y, mo, d;
  if (m[1]) { mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
  else if (m[4]) { y = +m[4]; mo = +m[5]; d = +m[6]; }
  else { mo = MONTHS[m[7].toLowerCase().slice(0, 4)] || MONTHS[m[7].toLowerCase().slice(0, 3)]; d = +m[8]; y = +m[9]; }
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y > 2000 && y < 2100)) return '';
  return `${y}-${pad(mo)}-${pad(d)}`;
}
export function toTime(s) {
  const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])\.?\s*m\.?/i.exec(s || '') || /\b(\d{1,2}):(\d{2})(?::\d{2})?\b/.exec(s || '');
  if (!m) return '';
  let h = +m[1]; const mi = +m[2];
  if (m[3]) { const pm = /p/i.test(m[3]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  return h < 24 && mi < 60 ? `${pad(h)}:${pad(mi)}` : '';
}
const num = (s) => (s == null ? null : +String(s).replace(/,/g, '') || null);
const after = (text, labels, valueRe) => {
  const re = new RegExp(`(?:${labels})\\s*(?:#|no\\.?|number)?\\s*[:\\-]?[^\\S\\n]*(?:\\n\\s*)?(${valueRe})`, 'i');
  const m = re.exec(text); return m ? m[1] : null;
};
const JURIS = [
  [/district of columbia|washington,?\s*d\.?c|\bdc dmv\b|\bmpd\b|\bddot\b/i, 'Washington, DC'],
  [/montgomery county/i, 'Montgomery County, MD'], [/prince george'?s/i, "Prince George's County, MD"],
  [/gaithersburg/i, 'Gaithersburg, MD'], [/rockville/i, 'Rockville, MD'], [/takoma park/i, 'Takoma Park, MD'], [/college park/i, 'College Park, MD'],
  [/chevy chase/i, 'Chevy Chase, MD'], [/hyattsville/i, 'Hyattsville, MD'], [/laurel/i, 'Laurel, MD'], [/bowie/i, 'Bowie, MD'], [/greenbelt/i, 'Greenbelt, MD'],
  [/riverdale/i, 'Riverdale Park, MD'], [/cheverly/i, 'Cheverly, MD'], [/baltimore county/i, 'Baltimore County, MD'], [/baltimore/i, 'Baltimore, MD'],
  [/annapolis|anne arundel/i, 'Anne Arundel County, MD'], [/howard county/i, 'Howard County, MD'], [/frederick county|city of frederick/i, 'Frederick, MD'],
  [/alexandria/i, 'Alexandria, VA'], [/arlington/i, 'Arlington, VA'], [/fairfax/i, 'Fairfax, VA'], [/falls church/i, 'Falls Church, VA'],
  [/\bmaryland\b|\bmd\b/i, 'Maryland'], [/\bvirginia\b|\bva\b/i, 'Virginia'],
];
const PARK_MAP = [
  [/meter|pay ?station|multi.?space/i, 'Expired meter'], [/over ?time|time limit|hour/i, 'Over the time limit'],
  [/resident|rpp|permit/i, 'Residential permit zone'], [/rush|tow/i, 'Rush-hour / tow-away zone'], [/clean|sweep/i, 'Street sweeping'],
  [/emergency no park|temporary/i, 'Emergency or temporary no parking'], [/hydrant/i, 'Too close to a fire hydrant'],
  [/loading|bus zone|bus stop/i, 'Loading or bus zone'], [/crosswalk|corner|driveway|alley|intersection/i, 'Crosswalk, corner, driveway or alley'],
  [/regist|tags?\b|inspection/i, 'Expired tags or registration'], [/no (parking|standing)/i, 'No parking / no standing'],
];
function detectType(t, speed) {
  if (/red[\s-]?light|steady red|red signal|red indication/i.test(t)) return 'Red light camera';
  if (/stop[\s-]?sign/i.test(t)) return 'Stop sign camera';
  if (/bus[\s-]?(lane|only)/i.test(t)) return 'Bus lane';
  if (/\bpark(ing|ed)?\b|\bmeter\b|hydrant|tow[\s-]?away|street clean|permit zone/i.test(t) && !/speed/i.test(t)) return 'Parking';
  if (/speed|mph/i.test(t) || speed) return /officer|trooper|police officer|issued by officer/i.test(t) && !/camera|automated|photo/i.test(t) ? 'Speed (officer)' : 'Speed camera';
  return 'Other';
}
function cleanLoc(s) {
  if (!s) return '';
  return s.split(/\s{3,}|\t|\s+(?=(?:violation\s+)?(?:date|time|speed|fine|amount|status|plate|posted|recorded)\b\s*:)/i)[0]
    .replace(/^[\s:#\-]+|[\s,;:\-]+$/g, '').replace(/\s+/g, ' ').slice(0, 160);
}
/** Parse one ticket's worth of text. */
export function parseOne(text) {
  const t = String(text || '');
  const DATE = DATE_SRC;
  const issued = after(t, '(?:violation|offense|offence|issue|issued|incident|occurrence|event|citation|notice|infraction)\\s*date(?:\\s*(?:&|and)\\s*time)?|date of (?:violation|offense|occurrence)', DATE);
  const due = after(t, 'due date|payment due(?: date)?|pay by|due by|respond by|must (?:be paid|pay|respond) by|deadline|pay or contest by', DATE);
  const dates = [...t.matchAll(new RegExp(DATE, 'gi'))].map((m) => toIsoDate(m[0])).filter(Boolean);
  const date = toIsoDate(issued) || dates.find((d) => d !== toIsoDate(due)) || '';
  const timeLbl = after(t, '(?:violation|offense|issue|incident|occurrence|event)?\\s*time', '\\d{1,2}:\\d{2}(?::\\d{2})?\\s*(?:[ap]\\.?\\s*m\\.?)?');
  const dateLine = t.split('\n').find((l) => DATE_RE.test(l) && toTime(l) && !/due|pay by|respond|deadline/i.test(l));
  const time = toTime(timeLbl) || toTime((issued && t.slice(t.indexOf(issued), t.indexOf(issued) + 40)) || '') || toTime(dateLine) || '';
  let speed = num(after(t, '(?:recorded|vehicle|your|actual|detected|measured|observed|alleged|violator)\\s*speed', '\\d{2,3}'));
  let limit = num(after(t, '(?:posted\\s*)?speed\\s*limit|posted(?:\\s*speed)?|limit', '\\d{2}'));
  const inA = /(\d{2,3})\s*mph\s*in\s*an?\s*(\d{2})\s*(?:mph)?/i.exec(t);
  if (inA) { speed = speed || +inA[1]; limit = limit || +inA[2]; }
  if (speed && limit && speed <= limit) { /* labels crossed; keep both but lower confidence */ }
  const fine = num(after(t, 'amount due|total due|balance due|balance|civil penalty|penalty amount|fine amount|fine|amount|total', '\\$?\\s*[\\d,]+(?:\\.\\d{2})?')?.replace('$', '')) ||
    num(/\$\s*([\d,]+(?:\.\d{2})?)/.exec(t)?.[1]);
  const locRaw = after(t, 'violation location|location of (?:violation|offense|occurrence)|camera location|place of (?:violation|occurrence|offense)|incident location|location|address|intersection|site', '[^\\n]+');
  const addr = /\b\d{1,5}\s+(?:block\s+(?:of\s+)?|blk\s+)?(?:[NSEW]\.?\s+)?[A-Z0-9][A-Z0-9 .'-]{1,40}?\b(?:ST|STREET|AVE|AVENUE|RD|ROAD|BLVD|DR|DRIVE|PL|CT|LN|LANE|WAY|PKWY|PARKWAY|TER|CIR|HWY|PIKE)\b\.?(?:\s+(?:NW|NE|SW|SE))?(?:\s*(?:&|@|and|at)\s*[A-Z0-9][A-Z0-9 .'-]{1,40}?\b(?:ST|AVE|RD|BLVD|DR|PL|CT|LN|WAY|PKWY)\b\.?(?:\s+(?:NW|NE|SW|SE))?)?/i.exec(t.replace(new RegExp(DATE_SRC, 'gi'), ' ').replace(/\b\d{6,}\b/g, ' '));
  const street = cleanLoc(locRaw) || (addr ? addr[0].replace(/\s+/g, ' ').trim() : '');
  const dir = /\b(north|south|east|west)\s*bound\b|\b([NSEW])\s*\/?\s*B\b|\b(NB|SB|EB|WB)\b/i.exec(t);
  const direction = dir ? (dir[1] ? dir[1][0].toUpperCase() + 'B' : dir[2] ? dir[2].toUpperCase() + 'B' : dir[3].toUpperCase()) : '';
  const jurisdiction = (JURIS.find(([re]) => re.test(t)) || [])[1] || '';
  const type = detectType(t, speed);
  const violation = type === 'Parking' ? ((PARK_MAP.find(([re]) => re.test(t)) || [])[1] || 'Other') : '';
  const found = [date, street, fine, speed || type !== 'Other'].filter(Boolean).length;
  return { street, type, violation, date, time, speed: type.startsWith('Speed') ? speed : null, limit: type.startsWith('Speed') ? limit : null,
    fine: fine && fine < 5000 ? fine : null, due: toIsoDate(due), direction, jurisdiction, confidence: found >= 4 ? 'high' : found >= 2 ? 'medium' : 'low' };
}
/** Parse text that may hold one ticket, several labeled tickets, or a table of tickets. */
export function parseTicketText(text) {
  const t = String(text || '').replace(/\r/g, '').replace(/[  ]+\n/g, '\n');
  if (t.trim().length < 12) return [];
  // Several labeled tickets: split at each "Citation/Notice/Ticket number" label
  const lab = /(?:^|\n)[^\n]{0,20}\b(?:citation|notice|ticket|violation)\s*(?:#|no\.?|number)\s*[:\-]?/gi;
  const starts = [...t.matchAll(lab)].map((m) => m.index);
  let parts = [];
  if (starts.length >= 2) parts = starts.map((s, i) => t.slice(s, starts[i + 1] ?? t.length));
  else {
    // A results table: several lines that each have a date and a dollar amount
    const rows = t.split('\n').filter((l) => new RegExp(DATE_SRC, 'i').test(l) && /\$\s*\d/.test(l));
    if (rows.length >= 2) parts = rows;
    else parts = [t];
  }
  // Text around the tickets (e.g. "Montgomery County Speed Camera Program") tells us who issued them
  const context = parts.length > 1 ? t.split('\n').filter((l) => !parts.some((p) => p.includes(l.trim()) && l.trim())).join('\n') : '';
  return parts.map((p) => {
    const x = parseOne(p);
    if (!x.jurisdiction && context) x.jurisdiction = parseOne(context).jurisdiction;
    return x;
  }).filter((x) => x.date || x.street || x.fine);
}

// ---------------------------------------------------------------- pictures
function toB64(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); }); }
async function shrinkImage(file, max = 2000) {
  if (file.type === 'application/pdf') return { data: await toB64(file), mediaType: 'application/pdf' };
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(img.src);
  return { data: c.toDataURL('image/jpeg', 0.85).split(',')[1], mediaType: 'image/jpeg', canvas: c };
}
let ocrWorker = null;
async function ocr(canvas, onProgress) {
  if (!window.Tesseract) {
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'; s.onload = res; s.onerror = () => rej(new Error('Couldn\'t load the text reader. Check your connection.')); document.head.appendChild(s); });
  }
  if (!ocrWorker) ocrWorker = await window.Tesseract.createWorker('eng', 1, { logger: (m) => m.status === 'recognizing text' && onProgress?.(Math.round(m.progress * 100)) });
  const { data } = await ocrWorker.recognize(canvas);
  return data.text || '';
}
const aiReady = () => cloudConfigured && !!S.user;

// ---------------------------------------------------------------- geocoding
const GEO = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&viewbox=-79.50,39.75,-75.00,37.85&bounded=1&q=';
let lastGeo = 0;
async function geocodeTicket(x) {
  if (!x.street) return null;
  const base = x.street.replace(/\b(\d+)\s*(?:blk|block)(?:\s*of)?\b/i, '$1').replace(/\b(?:[NSEW]\/?B|NB|SB|EB|WB|(?:north|south|east|west)\s*bound)\b/gi, '')
    .replace(/\s*[@&]\s*|\s+at\s+/gi, ' and ').replace(/\s+/g, ' ').trim();
  const where = x.jurisdiction || 'Washington, DC';
  const tries = [`${base}, ${where}`, `${base.split(' and ')[0]}, ${where}`];
  for (const q of [...new Set(tries)]) {
    const wait = 1100 - (Date.now() - lastGeo); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeo = Date.now();
    try {
      const r = await fetch(GEO + encodeURIComponent(q)); const j = await r.json();
      if (j[0]) return { lat: +j[0].lat, lng: +j[0].lon, label: j[0].display_name, rough: q !== tries[0] };
    } catch { /* offline */ }
  }
  return null;
}

// ---------------------------------------------------------------- state and page
let items = [];          // { id, t: ticket fields, loc, source, status: 'ready'|'noloc'|'dupe'|'saved', include }
let working = '';
const newId = () => 'im' + Math.random().toString(36).slice(2, 9);
function isDupe(t, loc) {
  return S.db.tickets.some((x) => !x.example && x.date && x.date === t.date && ((t.time && x.time === t.time) || (loc && x.lat != null && dist(x, loc) < 250) || (x.street || '').toLowerCase() === (t.street || '').toLowerCase()));
}
async function addFound(list, source) {
  for (const raw of list) {
    const key = (x) => `${x.date}|${x.time}|${(x.street || '').toLowerCase()}`;
    if (items.some((i) => i.status !== 'saved' && key(i.t) === key(raw))) continue;   // already in the list
    const t = { ...raw };
    const it = { id: newId(), t, loc: raw.location || null, source, status: 'locating', include: true };
    items.unshift(it); paint();
    if (!it.loc) it.loc = await geocodeTicket(t);
    const dupe = isDupe(t, it.loc);
    it.status = dupe ? 'dupe' : it.loc ? 'ready' : 'noloc';
    it.include = !dupe && !!it.loc;
    paint();
  }
}
async function fromText(text, source = 'Pasted text') {
  const found = parseTicketText(text);
  if (!found.length) { toast('No ticket details found in that text. Try a screenshot instead.'); return 0; }
  await addFound(found, source);
  return found.length;
}
async function fromFile(file) {
  working = `Reading ${esc(file.name || 'picture')}…`; paint();
  try {
    const pic = await shrinkImage(file);
    if (aiReady()) {
      const out = await agent('scan-ticket', { data: pic.data, mediaType: pic.mediaType });
      if (!out.ok) { toast(out.message); return; }
      const list = (out.tickets || [out.ticket]).map((tk, i) => ({
        street: tk.street || '', type: tk.type || 'Other', violation: tk.violation || '', date: tk.date || '', time: tk.time || '', speed: tk.speed ?? null, limit: tk.limit ?? null,
        fine: tk.fine ?? null, due: tk.due || '', direction: tk.direction || '', jurisdiction: tk.jurisdiction || '',
        location: (out.locations ? out.locations[i] : i === 0 ? out.location : null) || null, confidence: tk.confidence || out.confidence, note: tk.note || out.note,
      }));
      await addFound(list, 'AI scan');
    } else if (pic.canvas) {
      const text = await ocr(pic.canvas, (p) => { working = `Reading text on this phone… ${p}%`; paintWorking(); });
      working = '';
      const n = await fromText(text, 'Screenshot (read on this phone)');
      if (!n) toast('Couldn\'t read ticket details from that picture. Screenshots of the ticket website work best, or paste the text.');
    } else toast('PDFs need the AI scanner (sign in with Supabase set up). Or open the PDF, copy the text and paste it here.');
  } catch (e) { toast(e.message || 'Couldn\'t read that file'); }
  finally { working = ''; paint(); }
}

function itemHtml(it) {
  const t = it.t;
  const st = { locating: '<span class="note">Finding it on the map…</span>', ready: `<span class="ok">📍 ${esc((it.loc?.label || '').split(',').slice(0, 2).join(','))}${it.loc?.rough ? ' (approximate)' : ''}</span>`,
    noloc: '<span class="bad">No map location yet. Tap Edit to set it.</span>', dupe: '<span class="note">Looks like a ticket you already have.</span>', saved: '<span class="ok">✓ Imported</span>' }[it.status];
  return `<div class="row imp" data-imp="${it.id}">
    ${it.status === 'saved' ? '<span class="emo">✅</span>' : `<input type="checkbox" class="impchk" ${it.include ? 'checked' : ''} ${it.loc ? '' : 'disabled'} aria-label="Include this ticket">`}
    <div class="main"><div class="ttl">${esc(t.street || 'Location not found')}</div>
      <div class="meta">${esc(t.type)}${t.violation ? ': ' + esc(t.violation) : ''} · ${esc(t.date || 'no date')}${t.time ? ' ' + esc(t.time) : ''}${t.fine ? ' · ' + money(t.fine) : ''}${t.speed ? ` · ${t.speed}${t.limit ? ' in ' + t.limit : ''} mph` : ''}${t.due ? ' · due ' + esc(t.due) : ''}</div>
      <div class="meta">${st}${t.confidence === 'low' ? ' · <span class="bad">check the details</span>' : ''} · <small>${esc(it.source)}</small></div></div>
    ${it.status === 'saved' ? '' : `<div class="acts"><button class="sbtn" data-ie="${it.id}">Edit</button><button class="sbtn" data-ix="${it.id}" aria-label="Remove">✕</button></div>`}</div>`;
}
function paintWorking() { const w = $('#im-working'); if (w) w.innerHTML = working ? `<div class="spinner"></div> ${working}` : ''; }
function paint() {
  const host = $('#im-list'); if (!host) return;
  paintWorking();
  const ready = items.filter((i) => i.include && i.loc && i.status !== 'saved').length;
  host.innerHTML = items.length ? `${items.map(itemHtml).join('')}
    <div class="btns"><button class="btn primary" id="im-save" ${ready ? '' : 'disabled'}>Import ${ready || ''} ticket${ready === 1 ? '' : 's'}</button>${items.some((i) => i.status === 'saved') ? '<button class="btn" id="im-clear">Clear imported</button>' : ''}</div>` : '';
  $$('.impchk', host).forEach((c) => (c.onchange = () => { items.find((i) => i.id === c.closest('[data-imp]').dataset.imp).include = c.checked; paint(); }));
  $$('[data-ix]', host).forEach((b) => (b.onclick = () => { items = items.filter((i) => i.id !== b.dataset.ix); paint(); }));
  $$('[data-ie]', host).forEach((b) => (b.onclick = () => editItem(items.find((i) => i.id === b.dataset.ie))));
  const sv = $('#im-save', host); if (sv) sv.onclick = saveAll;
  const cl = $('#im-clear', host); if (cl) cl.onclick = () => { items = items.filter((i) => i.status !== 'saved'); paint(); };
}
const toRecord = (it) => ({
  id: crypto.randomUUID ? crypto.randomUUID() : newId(), created: Date.now(), street: (it.t.street || it.loc?.label?.split(',')[0] || 'Imported ticket').slice(0, 160),
  lat: it.loc.lat, lng: it.loc.lng, date: it.t.date || '', time: it.t.time || '', due: it.t.due || '', type: it.t.type || 'Other', violation: it.t.violation || '',
  fine: +it.t.fine || 0, speed: it.t.speed || null, limit: it.t.limit || null,
  notes: [it.t.jurisdiction, it.t.direction && `Direction: ${it.t.direction}`, 'Imported'].filter(Boolean).join(' · '),
  alertType: S.db.settings.alertType, shared: !!S.db.settings.share,
});
function saveAll() {
  let n = 0;
  for (const it of items) if (it.include && it.loc && it.status !== 'saved') { const rec = toRecord(it); upsertLocal('tickets', rec); bus.emit('ticket-saved', rec); it.status = 'saved'; n++; }
  paint(); toast(`${n} ticket${n === 1 ? '' : 's'} imported. You'll get alerts at each spot.`);
}
function editItem(it) {
  ticketForm(null, {
    ticket: { ...it.t, notes: [it.t.jurisdiction, it.t.direction && `Direction: ${it.t.direction}`, 'Imported'].filter(Boolean).join(' · ') },
    location: it.loc ? { lat: it.loc.lat, lng: it.loc.lng, label: it.loc.label } : null,
    confidence: it.t.confidence, note: it.loc ? 'Check each field, then save.' : 'Set where it happened below, then save.',
    onSaved: () => { it.status = 'saved'; go('import'); paint(); },
  });
}

export function renderImport() {
  const host = $('#p-import');
  host.innerHTML = `${pageHead('Import Tickets', 'From ticket websites, screenshots, photos or PDFs')}
    <div class="card sec">
      <h2>From cite-web.com</h2>
      <p class="note" style="margin:0">Many red-light and speed-camera programs in the area use this site. It shows one ticket at a time and needs the <b>citation number and PIN</b> printed on your notice.</p>
      <ol class="small" style="margin:0;padding-left:20px">
        <li>Open the site and log in with the citation number and PIN.</li>
        <li>On the ticket page, take a <b>screenshot</b>. Or on a computer, select all (Ctrl/⌘ A), copy (Ctrl/⌘ C) and paste it below.</li>
        <li>Add the screenshot or paste the text here. Repeat for each ticket.</li>
      </ol>
      <div class="btns"><a class="btn" href="https://public.cite-web.com" target="_blank" rel="noopener">Open cite-web.com ↗</a></div>
      <p class="note small" style="margin:0">Works the same with any ticket website: DC DMV ticket search, county parking portals, or the PDF of your notice.</p>
    </div>
    <div class="card sec">
      <h2>Add tickets</h2>
      <div class="btns"><label class="btn primary">📷 Take a photo<input type="file" id="im-cam" accept="image/*" capture="environment" hidden></label>
        <label class="btn">🖼 Screenshots or PDFs<input type="file" id="im-files" accept="image/*,application/pdf" multiple hidden></label></div>
      <label class="f">Or paste here (text or a screenshot)<textarea id="im-paste" rows="5" placeholder="Paste the ticket page here. Several tickets at once is fine."></textarea></label>
      <div class="btns"><button class="btn" id="im-read">Read pasted text</button></div>
      <p class="note small" style="margin:0">${aiReady() ? 'Pictures and PDFs are read by the AI scanner and not stored.' : 'Screenshots are read on this phone (the first one downloads a text reader, about 10 MB). Signing in with the AI agents set up reads photos of paper notices and PDFs more accurately.'} Plate numbers, citation numbers and PINs are never saved.</p>
      <div id="im-working" class="note"></div>
    </div>
    <div id="im-list" class="sec"></div>`;
  bindBack(host);
  const files = async (list) => { for (const f of list) await fromFile(f); };
  $('#im-cam').onchange = (e) => files([...e.target.files]);
  $('#im-files').onchange = (e) => files([...e.target.files]);
  $('#im-read').onclick = async () => { const v = $('#im-paste').value; if (await fromText(v)) $('#im-paste').value = ''; };
  $('#im-paste').addEventListener('paste', (e) => {
    const pics = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    if (pics.length) { e.preventDefault(); files(pics); return; }
    setTimeout(() => { const v = $('#im-paste').value; if (v.length > 40) fromText(v).then((n) => { if (n) $('#im-paste').value = ''; }); }, 0);
  });
  paint();
}
export { PARKING_REASONS };
