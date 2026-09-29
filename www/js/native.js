// One API for GPS, notifications, speech and screen-awake,
// using native plugins inside the iPhone/Android app and browser features on the web.
const Cap = window.Capacitor;
export const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const cache = {};
/** Native plugin proxy inside the phone app; null on the web. */
const P = (name) => {
  if (!isNative) return null;
  if (!cache[name]) cache[name] = Cap.registerPlugin ? Cap.registerPlugin(name) : Cap.Plugins?.[name];
  return cache[name] || null;
};

// ---------------------------------------------------------------- location
/** Calls cb({lat,lng,speed(m/s)|null,heading|null,accuracy,t}) on every fix. Returns a stop function. */
export async function watchLocation(cb, onError) {
  const BG = P('BackgroundGeolocation');
  if (BG) {
    // Keeps running when the phone is locked or another app (like Maps) is in front
    const id = await BG.addWatcher({
      backgroundTitle: 'Invictus Traffic Radar is watching for cameras',
      backgroundMessage: 'Drive mode is on. Tap to open.',
      requestPermissions: true, stale: false, distanceFilter: 8,
    }, (loc, err) => {
      if (err) {
        if (err.code === 'NOT_AUTHORIZED') onError?.({ code: 1, message: 'Location permission is off. Allow "Always" in Settings for background alerts.' });
        else onError?.(err);
        return;
      }
      cb({ lat: loc.latitude, lng: loc.longitude, speed: loc.speed ?? null, heading: loc.bearing ?? null, accuracy: loc.accuracy, t: loc.time || Date.now() });
    });
    return () => BG.removeWatcher({ id });
  }
  if (!navigator.geolocation) { onError?.({ code: 0, message: 'This browser has no GPS access.' }); return () => {}; }
  const wid = navigator.geolocation.watchPosition(
    (p) => cb({ lat: p.coords.latitude, lng: p.coords.longitude, speed: p.coords.speed, heading: p.coords.heading, accuracy: p.coords.accuracy, t: p.timestamp }),
    (e) => onError?.(e), { enableHighAccuracy: true, maximumAge: 1500, timeout: 20000 });
  return () => navigator.geolocation.clearWatch(wid);
}
export function locateOnce() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej({ code: 0 });
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, speed: p.coords.speed || 0, heading: p.coords.heading, t: p.timestamp }),
      rej, { enableHighAccuracy: true, timeout: 15000 });
  });
}

// ---------------------------------------------------------------- notifications
let notifId = 1;
export async function askNotifyPermission() {
  const LN = P('LocalNotifications');
  if (LN) { try { await LN.requestPermissions(); } catch { /* ignore */ } return; }
  if ('Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch { /* ignore */ } }
}
export async function notify(title, body) {
  const LN = P('LocalNotifications');
  if (LN) {
    try { await LN.schedule({ notifications: [{ id: notifId++ % 100000, title, body, schedule: { at: new Date(Date.now() + 50), allowWhileIdle: true } }] }); } catch { /* ignore */ }
    return;
  }
  try { if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(title, { body, tag: title }); } catch { /* ignore */ }
}
export async function remindAt(date, title, body) {
  const LN = P('LocalNotifications');
  if (!LN || date < new Date()) return false;
  try { await LN.schedule({ notifications: [{ id: notifId++ % 100000, title, body, schedule: { at: date } }] }); return true; } catch { return false; }
}

// ---------------------------------------------------------------- sound & speech
let actx = null;
export function unlockAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume?.(); } catch { /* ignore */ } }
export function beep() {
  if (!actx) return;
  try {
    const t = actx.currentTime;
    [0, 0.22, 0.44].forEach((d, i) => {
      const o = actx.createOscillator(), g = actx.createGain(); o.type = 'square'; o.frequency.value = i % 2 ? 660 : 880;
      g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.22, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.18);
      o.connect(g); g.connect(actx.destination); o.start(t + d); o.stop(t + d + 0.2);
    });
  } catch { /* ignore */ }
}
export async function speak(text) {
  const TTS = P('TextToSpeech');
  if (TTS) { try { await TTS.stop(); await TTS.speak({ text, lang: 'en-US', rate: 1.0, category: 'playback' }); } catch { /* ignore */ } return; }
  if (!('speechSynthesis' in window)) return;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.02; speechSynthesis.speak(u); } catch { /* ignore */ }
}
export function vibrate(p) { try { navigator.vibrate?.(p); } catch { /* ignore */ } }

// ---------------------------------------------------------------- listening
export const canListen = () => !!(P('SpeechRecognition') || window.SpeechRecognition || window.webkitSpeechRecognition);
/** Listen for one phrase. Resolves with the text, or '' if nothing was heard. */
export async function listen() {
  const SR = P('SpeechRecognition');
  if (SR) {
    const perm = await SR.requestPermissions();
    if (perm.speechRecognition !== 'granted') throw new Error('Microphone permission is off.');
    const r = await SR.start({ language: 'en-US', maxResults: 1, partialResults: false, popup: false });
    return (r.matches && r.matches[0]) || '';
  }
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) throw new Error('Voice isn\'t supported in this browser. Try Chrome, or the phone app.');
  return new Promise((res, rej) => {
    const r = new Rec(); r.lang = 'en-US'; r.interimResults = false; r.maxAlternatives = 1;
    let got = '';
    r.onresult = (e) => { got = e.results[0][0].transcript; };
    r.onerror = (e) => (e.error === 'no-speech' ? res('') : rej(new Error(e.error === 'not-allowed' ? 'Microphone permission is off.' : 'Didn\'t catch that.')));
    r.onend = () => res(got);
    r.start();
  });
}

// ---------------------------------------------------------------- keep screen on
let wake = null;
export async function keepAwake(on) {
  const KA = P('KeepAwake');
  if (KA) { try { on ? await KA.keepAwake() : await KA.allowSleep(); } catch { /* ignore */ } return; }
  try {
    if (on && 'wakeLock' in navigator) wake = await navigator.wakeLock.request('screen');
    if (!on && wake) { await wake.release(); wake = null; }
  } catch { /* ignore */ }
}
document.addEventListener('visibilitychange', () => { if (wake === null && document.visibilityState === 'visible' && keepAwake.wanted) keepAwake(true); });
