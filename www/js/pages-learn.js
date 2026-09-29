// Driving Coach, Safety Tips, Ticket Dispute helper.
import { S, sens, upsertLocal } from './store.js';
import { $, $$, esc, money, dist, streetKey, toast, copyText, stamp } from './util.js';
import { pageHead, bindBack, busy, go } from './ui.js';
import { agent, loadAgentOutputs, cloudConfigured } from './cloud.js';
import { summary, hotspots, group } from './pages-main.js';
import { remindAt } from './native.js';

// ---------------------------------------------------------------- Coach
function coachTips() {
  const T = S.db.tickets, Sm = summary(), tips = [];
  const wk = Date.now() - 14 * 86400000;
  const ent = S.db.events.filter((e) => e.kind === 'enter' && e.time > wk);
  const overIn = ent.filter((e) => e.limit && e.speed > e.limit + 2);
  if (!T.length && !ent.length) return [{ lvl: 'lo', t: 'Start with your history', p: 'Log the tickets you have gotten. The coach finds patterns once there is data to read.' }];
  if (Sm.avgOver != null && Sm.avgOver >= 10) tips.push({ lvl: 'hi', t: `You average ${Math.round(Sm.avgOver)} mph over when ticketed`, p: 'Most of your tickets come from sustained speed, not a brief slip. On streets you have been ticketed on, hold the limit for the whole block.' });
  else if (Sm.avgOver != null) tips.push({ lvl: 'md', t: `You average ${Math.round(Sm.avgOver)} mph over when ticketed`, p: 'Small margins still trigger cameras. In ticket zones, aim for the posted number, not a few over.' });
  hotspots().filter((h) => h.count >= 2).slice(0, 2).forEach((h) => {
    const covered = [...S.db.cameras, ...S.db.official].some((c) => dist(c, h) < 300);
    tips.push({ lvl: 'hi', t: `Repeat spot: ${h.name}`, p: `${h.count} tickets here for ${money(h.total)}. ${covered ? 'A camera is on file here, so you get a warning. Treat it as a hard slow-down.' : `No camera is on file near it. Pin one so you get a ${S.db.settings.lead}-minute warning.`}` });
  });
  const unpinned = T.filter((t) => /camera/i.test(t.type) && ![...S.db.cameras, ...S.db.official].some((c) => dist(c, t) < 300));
  if (unpinned.length) tips.push({ lvl: 'md', t: `${unpinned.length} camera ticket${unpinned.length > 1 ? 's have' : ' has'} no camera on file`, p: `Your ticket-zone alert fires within ${Math.round(S.db.settings.ticketRadius * sens().f)} m. A pinned camera warns you minutes earlier.` });
  const types = [...group(T, (t) => t.type)].sort((a, b) => b[1].length - a[1].length);
  if (types[0]) {
    const ty = types[0][0];
    if (/red light/i.test(ty)) tips.push({ lvl: 'md', t: 'Red lights are your main issue', p: 'Cameras photograph entering after the light turns red and rolling right turns. Near a known camera, cover the brake on a stale green.' });
    if (/stop sign/i.test(ty)) tips.push({ lvl: 'md', t: 'Stop-sign cameras catch rolling stops', p: 'Come to a full stop behind the line until the car stops rocking, then go.' });
    if (/^parking/i.test(ty)) tips.push({ lvl: 'md', t: 'Parking is your main ticket type', p: 'Use Parking → Can I park here? before you walk away. It shows why tickets get written on that block and when. Set the meter timer when you park.' });
    if (/bus lane/i.test(ty)) tips.push({ lvl: 'md', t: 'Watch the red-painted lanes', p: 'Bus-lane cameras ticket driving or stopping in the lane during posted hours.' });
  }
  const hours = T.filter((t) => t.time).map((t) => +t.time.slice(0, 2));
  if (hours.length >= 2) {
    const g = [...group(hours, (h) => (h < 10 ? 'morning (before 10)' : h < 16 ? 'midday' : h < 20 ? 'evening rush' : 'night'))].sort((a, b) => b[1].length - a[1].length)[0];
    tips.push({ lvl: 'md', t: `Most tickets happen in the ${g[0]}`, p: `${g[1].length} of ${hours.length} timed tickets. Leave 10 minutes earlier on those trips so you're not making up time.` });
  }
  if (ent.length) tips.push({ lvl: overIn.length ? 'hi' : 'lo', t: `${ent.length} zone entr${ent.length > 1 ? 'ies' : 'y'} in the last 2 weeks`, p: overIn.length ? `You were over the limit on ${overIn.length} of them. Start slowing at the ${S.db.settings.lead}-minute warning instead of the "right ahead" alert.` : 'You stayed at or under the limit every time GPS saw you enter a zone. Keep it up.' });
  if (Sm.daysClean != null && Sm.daysClean >= 30) tips.push({ lvl: 'lo', t: `${Sm.daysClean} days ticket-free`, p: 'Your current habits are working. Keep drive mode on for trips through your hotspots.' });
  if (!S.db.commutes.length) tips.push({ lvl: 'lo', t: 'Add your commute schedule', p: 'With a schedule, you get a pre-trip heads-up listing every camera and ticket spot on the way.' });
  return tips;
}
export function renderCoach() {
  const host = $('#p-coach'), wk = Date.now() - 7 * 86400000;
  const recent = S.db.events.filter((e) => e.time > wk), alerts = S.db.alerts.filter((a) => a.time > wk);
  const latest = S.db.coach[0];
  host.innerHTML = `${pageHead('Driving Coach', 'Advice drawn from your tickets and drive history')}
    <div class="kpis">
      <div class="kpi"><small>Alerts this week</small><b>${alerts.length}</b></div>
      <div class="kpi"><small>Zone entries</small><b>${recent.filter((e) => e.kind === 'enter').length}</b></div>
      <div class="kpi"><small>Over limit in zone</small><b>${recent.filter((e) => e.kind === 'enter' && e.limit && e.speed > e.limit + 2).length}</b></div>
      <div class="kpi"><small>Days ticket-free</small><b>${summary().daysClean ?? '—'}</b></div>
    </div>
    <div class="card"><h2>Weekly AI review</h2>
      ${latest ? `<p class="note" style="margin:0 0 6px">Week of ${esc(latest.week_start)}</p><h3>${esc(latest.headline)}</h3><p>${esc(latest.body.summary)}</p>
        ${latest.body.wins?.length ? `<b>What went well</b><ul class="insights">${latest.body.wins.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        ${latest.body.focus?.length ? `<b>Focus this week</b><ul class="insights">${latest.body.focus.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        <div class="privacy"><b>Tip:</b> ${esc(latest.body.tip)}</div>`
        : `<p class="note" style="margin:0">${S.user ? 'Your first review arrives Monday morning, or write one now from this week\'s drives.' : 'Sign in to get a written review every Monday.'}</p>`}
      <div class="btns" style="margin-top:12px">${S.user ? '<button class="btn" id="coachNow">Write this week\'s review now</button>' : cloudConfigured ? '<button class="btn" data-go="account">Sign in</button>' : ''}</div>
    </div>
    <h2 class="sech">Right now</h2>
    <div class="sec">${coachTips().map((t) => `<div class="tip"><span class="lvl ${t.lvl}">${{ hi: 'Priority', md: 'Watch', lo: 'Good' }[t.lvl]}</span><div><b>${esc(t.t)}</b><p>${esc(t.p)}</p></div></div>`).join('')}</div>`;
  host.querySelector('#coachNow')?.addEventListener('click', async (e) => {
    const b = e.currentTarget; busy(b, true, 'Writing…');
    try { const out = await agent('weekly-coach', {}); if (out.skipped) toast('No drives logged this week yet.'); await loadAgentOutputs(); renderCoach(); }
    catch (err) { toast(err.message); busy(b, false); }
  });
  host.querySelector('[data-go]')?.addEventListener('click', () => go('account'));
  bindBack(host);
}

// ---------------------------------------------------------------- Safety tips
const LIB = [
  ['How DC camera enforcement works', [
    'DC uses automated cameras for speeding, red lights, stop signs, blocked intersections and crosswalks, and bus lanes. Some are fixed on poles; others are in parked vans that move.',
    'Camera tickets are mailed to the registered owner of the car, usually a few weeks after the violation.',
    'DC publishes where its enforcement cameras are. This app loads that list automatically, so those cameras warn you without pinning.']],
  ['How Maryland camera enforcement works', [
    'Maryland speed cameras are mostly in school zones and highway work zones, plus a growing number on residential streets in some counties.',
    'A Maryland speed camera only issues a ticket when you are going at least 12 mph over the limit. That is not a cushion to drive at: officers can stop you at any speed over.',
    'School-zone speed cameras generally run on weekdays from 6 am to 8 pm, all year, including summer. Check the posted sign for each zone.',
    'Since October 2025, Maryland speed camera fines rise with your speed: $40 at 12–15 mph over, then $70, $120 and $230, up to $425 at 40 mph or more over.',
    'SafeZones work-zone cameras move between highway work zones such as I-95, I-495 and I-270, so they aren\'t on any fixed list. Slow down whenever you see work-zone signs.',
    'This app loads Montgomery County\'s camera sites and Prince George\'s County\'s school speed zones automatically. Other counties and towns are added from their web pages when the backend is connected; pin any camera the lists miss.',
    'In Maryland, camera tickets are handled by the county or town that issued them. The notice explains how to pay or ask for a court date.']],
  ['Speeding', [
    'Many DC neighborhood streets are posted at 20 or 25 mph. If you have not seen a sign, assume the lower number.',
    'Limits drop in school zones during posted hours and in work zones. Both are common camera locations in DC and Maryland.',
    'Speed creeps up on downhill stretches and wide, empty roads. Check your speedometer at the top of every hill near a known camera.',
    'Use cruise control or a speed limiter on highways and parkways that have cameras.']],
  ['Red lights and right turns', [
    'A growing number of DC intersections prohibit right turns on red. Look for the sign every time before you turn.',
    'When you do turn right on red, come to a full stop first. Rolling turns are a common camera violation.',
    'On a stale green near a camera, ease off early so you can stop on yellow without braking hard.']],
  ['Emergency vehicles and crashes', [
    'Maryland law requires you to move over a lane when you pass a stopped emergency, tow or service vehicle with flashing lights, or to slow down if you can\'t move over safely. Do the same in DC.',
    'Pull to the right and stop for an emergency vehicle coming toward you or behind you with lights and siren, unless you\'re in an intersection.',
    'Reporting a crash or emergency vehicle in the app warns other drivers for about 30 to 90 minutes. Only report what you see, and never while typing at the wheel: use voice or the big Hazard button.']],
  ['Stop signs, crosswalks and bus lanes', [
    'Stop fully behind the line until the car stops moving, then proceed.',
    'Do not enter an intersection or crosswalk unless you can clear it before the light changes.',
    'Red-painted lanes are for buses during posted hours. Driving or stopping in them can be ticketed.']],
  ['Parking without a ticket', [
    'Before you leave the car, open Parking → Can I park here? It shows how many tickets get written on that block, what for, and at what times.',
    'Read every sign on the pole, top to bottom. The most limiting sign wins, and rush-hour and street-sweeping limits often sit below the main sign.',
    'Look for paper "Emergency No Parking" signs on poles and trees. They go up days ahead for moves and events, and cars get ticketed and towed.',
    'In residential permit zones, cars without that zone\'s sticker get a time limit, often 2 hours on weekdays. Set the meter timer so you move in time.',
    'Leave room at hydrants, crosswalks, corners, driveways and alleys. These get ticketed at any hour.',
    'A garage or lot costs more than a meter but can\'t get a street ticket. On red blocks, it\'s usually cheaper than the fine.']],
  ['If you get a ticket', [
    'Read the notice right away. It lists the violation, the fine and the deadline to pay or dispute.',
    'In DC you pay or contest camera tickets through the DC DMV. In Maryland, follow the instructions from the county or town on the notice. Missing the deadline can add penalties.',
    'Scan it into this app the same day. The spot gets a caution alert, and Dispute help can walk you through your options.']],
  ['Using this app safely', [
    'Set everything up before you drive. Use hands-free mode and voice while moving.',
    'The app is a reminder, not a guarantee. Cameras move, lists lag, and GPS can be off. The posted signs always win.']],
];
export function renderTips() {
  const host = $('#p-tips');
  host.innerHTML = `${pageHead('Safety Tips', 'Practical ways to avoid citations and drive safely')}
    ${LIB.map((s, i) => `<details class="lib"${i === 0 ? ' open' : ''}><summary>${esc(s[0])}</summary><ul>${s[1].map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>`).join('')}
    <p class="note">General guidance, not legal advice. Check the posted signs and your ticket notice for the rules that apply to you.</p>`;
  bindBack(host);
}

// ---------------------------------------------------------------- Dispute helper
export function renderDispute() {
  const host = $('#p-dispute');
  const tix = [...S.db.tickets].filter((t) => !t.example).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const sel = S.disputeTicket && tix.find((t) => t.id === S.disputeTicket) ? S.disputeTicket : tix[0]?.id;
  const t = tix.find((x) => x.id === sel);
  const past = (S.db.disputes || []).filter((d) => d.ticket_id === sel);
  host.innerHTML = `${pageHead('Dispute Help', 'Prepare to contest a ticket yourself')}
    <div class="privacy">General information to help you decide, not legal advice. The deadline and process printed on your notice are what count.</div>
    ${!tix.length ? '<div class="empty">Add or scan a ticket first.</div>' : `
    <form id="dp" class="card sec">
      <label class="f">Ticket<select id="dp-t">${tix.map((x) => `<option value="${x.id}"${x.id === sel ? ' selected' : ''}>${esc(streetKey(x.street))} · ${esc(x.date || 'no date')} · ${x.fine ? money(x.fine) : ''}</option>`).join('')}</select></label>
      <label class="f">Pay or contest by (from the notice)<input type="date" id="dp-due" value="${esc(t?.due || '')}"></label>
      <label class="f">What happened (optional)<textarea id="dp-acc" maxlength="2000" placeholder="E.g. I sold the car in July. Or: the speed limit sign on that block is hidden by a tree."></textarea></label>
      <button class="btn primary" type="submit" id="dp-go"${S.user ? '' : ' disabled'}>Review my options</button>
      ${S.user ? '' : '<p class="note" style="margin:0">Sign in to use Dispute help.</p>'}
    </form>`}
    <div id="dp-out"></div>
    ${past.length ? `<div class="card"><h2>Earlier reviews of this ticket</h2><div class="sec">${past.map((d, i) => `<button class="row i rowbtn" data-past="${i}"><div class="main"><div class="ttl">${esc(d.analysis.summary.slice(0, 90))}…</div><div class="meta">${stamp(Date.parse(d.created_at))}</div></div></button>`).join('')}</div></div>` : ''}`;
  bindBack(host);
  const form = host.querySelector('#dp'); if (!form) return;
  host.querySelector('#dp-t').onchange = (e) => { S.disputeTicket = e.target.value; renderDispute(); };
  $$('[data-past]', host).forEach((b) => (b.onclick = () => showPlan(past[+b.dataset.past].analysis, t)));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const b = host.querySelector('#dp-go'); busy(b, true, 'Reviewing…');
    const due = host.querySelector('#dp-due').value;
    try {
      const plan = await agent('dispute-helper', { ticket_id: sel, account: host.querySelector('#dp-acc').value, due: due || null });
      if (due && t && t.due !== due) upsertLocal('tickets', { ...t, due });
      showPlan(plan, t);
      if (due) { const at = new Date(due + 'T09:00'); at.setDate(at.getDate() - 3); if (await remindAt(at, 'Ticket deadline in 3 days', `${streetKey(t.street)}: pay or contest by ${due}.`)) toast('Reminder set for 3 days before the deadline'); }
      loadAgentOutputs();
    } catch (err) { toast(err.message); } finally { busy(b, false); }
  };
}
function showPlan(p, t) {
  const out = $('#dp-out');
  const fit = { strong: 'lo', possible: 'md', weak: 'hi' };
  out.innerHTML = `<div class="card sec">
    <h2>Your options</h2><p style="margin:0">${esc(p.summary)}</p>
    <div class="privacy"><b>Deadline:</b> ${esc(p.deadline_note)}</div>
    ${p.grounds.length ? `<h3>Possible grounds</h3>${p.grounds.map((g) => `<div class="tip"><span class="lvl ${fit[g.fit]}">${esc(g.fit)}</span><div><b>${esc(g.title)}</b><p>${esc(g.why)}</p>${g.evidence?.length ? `<p><b>Evidence:</b> ${g.evidence.map(esc).join('; ')}</p>` : ''}</div></div>`).join('')}` : ''}
    ${p.questions?.length ? `<h3>Questions that could change this</h3><ul class="insights">${p.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
    ${p.next_steps?.length ? `<h3>Next steps</h3><ol class="insights">${p.next_steps.map((q) => `<li>${esc(q)}</li>`).join('')}</ol>` : ''}
    <h3>Draft statement</h3><pre class="letter" id="dp-letter">${esc(p.letter)}</pre>
    <div class="btns"><button class="btn" id="dp-copy">Copy statement</button></div></div>`;
  out.querySelector('#dp-copy').onclick = () => copyText(p.letter);
  out.scrollIntoView({ behavior: 'smooth' });
}
