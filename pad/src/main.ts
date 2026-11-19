import './pad.css';
import { PadLink, type Pairing } from './pad-link';
import { haptic } from './haptics';
import { MotionSource, requestMotionPermission } from '../../shared/sensors';
import { isValidCode } from '../../shared/crypto';
import { nowMs, packFrame } from '../../shared/protocol';
import { TouchCaster } from '../../shared/touchcast';
import { CastDetector, DEFAULT_POWER } from '../../shared/cast-detect';
import { GyroMeter } from '../../shared/gyro-meter';

const $ = (s: string) => document.querySelector(s) as HTMLElement;
const show = (id: string) => { for (const s of ['#start', '#ctl', '#rejected', '#nocode']) $(s).hidden = s !== id; };

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  let code = h.get('s');
  let pairing: Pairing | null = null;
  const p = h.get('p');
  if (p && p.includes('.')) { const [pid, sec] = p.split('.'); if (pid && sec) pairing = { pid, sec }; }
  if (!isValidCode(code)) code = localStorage.getItem('bcs.lastCode');
  return { code: isValidCode(code) ? code : null, pairing };
}

const { code, pairing: hashPairing } = readHash();
const params = new URLSearchParams(location.search);
let link: PadLink | null = null;
let touchMode = false;
let visibleAt = 0;
let awaitingResume = false;
let motionWanted = false;

// Local mirror of the host detector: drives the live gyro meter and the lag-proof flash. The host stays authoritative.
let lagProof = false;
let actx: AudioContext | null = null;
function unlockAudio() { try { actx ??= new AudioContext(); if (actx.state !== 'running') void actx.resume(); } catch { /* none */ } }
function beep(freq = 880) {
  const c = actx; if (!c || c.state !== 'running') return;
  const o = c.createOscillator(); o.type = 'square'; o.frequency.value = freq;
  const g = c.createGain(); const t = c.currentTime;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.09);
}
const det = new CastDetector({
  onWhip: () => {
    if (!lagProof || touchMode) return;
    // Lag proof: white flash + 880 Hz beep the moment this phone sees the flick peak.
    const fl = $('#flash'); fl.hidden = false; beep(880);
    setTimeout(() => (fl.hidden = true), 120);
  },
});
det.autoScale = false;
const meter = new GyroMeter($('#gyro') as unknown as HTMLCanvasElement);
const src = new MotionSource((f) => { link?.sendFrame(packFrame(f)); det.feed({ ...f, th: f.tPad }); });
let lastPower: number | null = null;
let band: { pLo: number; pHi: number; lo: number; hi: number; ft: number } | null = null;
function renderPower() {
  const b = $('#powBand'), m = $('#powMark');
  b.hidden = !band; m.hidden = lastPower === null;
  if (band) { b.style.left = `${band.pLo * 100}%`; b.style.width = `${Math.max(1, (band.pHi - band.pLo) * 100)}%`; }
  if (lastPower !== null) m.style.left = `${lastPower * 100}%`;
  $('#powLbl').textContent = (band ? `target ${band.ft} ft · good ${band.lo}–${band.hi} ft` : 'power') + (lastPower !== null ? ` · last ${Math.round(lastPower * 100)}%` : '');
}
function coach(text: string, bad: boolean) { const c = $('#coach'); c.textContent = text; c.classList.toggle('bad', bad); }

function setStatus() {
  if (!link) return;
  const pill = $('#pill');
  const st = link.state;
  pill.className = 'pill ' + (link.live ? 'live' : st);
  pill.textContent = st === 'rejected' ? 'Rejected' : link.live ? `Connected · ${link.via}` : 'Connecting…';
  if (st === 'rejected') {
    show('#rejected');
    $('#rejWhy').textContent = link.rejectWhy === 'used' ? 'This QR code was already used by another phone.' : link.rejectWhy === 'expired' ? 'This QR code expired.' : 'This phone is not paired with the game.';
  }
}

function bailDown(e: Event) {
  e.preventDefault();
  if (touchMode || !link?.live) return;
  src.bail = true;
  det.bail(true, nowMs(), src.orientation);
  $('#bail').classList.add('down');
  link.sendEvt({ t: 'bail', d: 1, tp: nowMs() });
  haptic('tick');
}
function bailUp(e?: Event) {
  e?.preventDefault();
  if (!src.bail) return;
  src.bail = false;
  det.bail(false, nowMs());
  setTimeout(() => det.releaseTimeout(), 600);
  $('#bail').classList.remove('down');
  link?.sendEvt({ t: 'bail', d: 0, tp: nowMs() });
}

function setTouch(on: boolean, tell: boolean) {
  touchMode = on;
  ($('#touchToggle') as HTMLInputElement).checked = on;
  $('#bail').hidden = on; $('#touchPad').hidden = !on;
  $('#hint').textContent = on ? 'Drag down, then flick up and let go. A normal flick is mid power; a long, fast drag is max.' : 'Just swing — no button needed. Holding the button is optional.';
  $('#gyro').hidden = on;
  if (tell) link?.sendEvt({ t: 'mode', touch: on });
}

async function connect(withMotion: boolean) {
  if (!globalThis.crypto?.subtle) { alert('This page needs HTTPS (WebCrypto) to pair securely.'); return; }
  // Called synchronously from the tap: permission request must be the first await.
  let permNote = '';
  unlockAudio();
  if (withMotion) {
    const r = await requestMotionPermission();
    if (!r.ok) {
      permNote = r.detail;
      $('#permErr').hidden = false;
      $('#permErr').textContent = `Motion access was not allowed (${r.detail}). To allow it: close this tab, scan again and tap "Allow". Or keep going with touch-cast.`;
    } else { src.start(); motionWanted = true; }
  }
  show('#ctl');
  if (!withMotion || permNote) setTouch(true, false);
  if (!link) {
    link = new PadLink(code!);
    link.allowRtc = params.get('rtc') !== '0'; // test flag: force the MQTT relay
    (window as any).__pad = {
      link, src, killRtc: () => link!.killRtc(),
      // Test hook: drop whichever transport is carrying traffic right now.
      det, feel,
      killChannel: () => { if (link!.rtcReady) link!.killRtc(); else (link as any).mqtt?.client?.stream?.destroy(); },
    };
    await link.init(hashPairing);
    link.onState = setStatus;
    link.onMsg = (m) => {
      if (m.t === 'hap') haptic(m.p);
      if (m.t === 'mode') setTouch(m.touch, false);
      if (m.t === 'cfg') {
        lagProof = m.lagProof;
        if (m.learned) det.lock = { axis: m.axis, sign: m.sign, src: 'auto' }; else { det.lock = null; det.override = null; }
        det.power = { ...DEFAULT_POWER, wMin: m.wMin, wMax: m.wMax, scaled: true };
      }
      if (m.t === 'coach') {
        coach(m.text, !m.ok);
        if (m.ok && typeof m.power === 'number') { lastPower = m.power; renderPower(); }
      }
      if (m.t === 'target') {
        band = m.ft && m.lo !== undefined && m.hi !== undefined && m.pLo !== undefined && m.pHi !== undefined ? { ft: m.ft, lo: m.lo, hi: m.hi, pLo: m.pLo, pHi: m.pHi } : null;
        renderPower();
      }
      if (m.t === 'ask') { const f = $('#feel'); f.dataset.id = String(m.id); f.hidden = false; }
    };
    link.onLive = (via) => {
      if (visibleAt) {
        link!.sendEvt({ t: 'resume', tp: nowMs(), reconnectMs: Math.round(nowMs() - visibleAt), via });
        visibleAt = 0;
      }
      if (touchMode) link!.sendEvt({ t: 'mode', touch: true });
    };
    link.start();
  }
}

function resumeTap() {
  // Re-request permission from a tap (iOS forgets it on reload; may stop events after sleep).
  void requestMotionPermission().then((r) => {
    if (r.ok) { src.stop(); src.start(); motionWanted = true; }
    $('#resume').hidden = true; awaitingResume = false;
    if (!link) void connect(false).then(() => { if (r.ok) setTouch(false, true); });
  });
}

if (!code) show('#nocode');
else {
  show('#start');
  // If this phone already paired with this game, iOS will have forgotten motion permission after a reload: offer one tap.
  const known = !!hashPairing || Object.keys(localStorage).some((k) => k.startsWith('bcs.pair.'));
  $('#go').textContent = known ? 'Tap to resume' : 'Allow motion and connect';
}
$('#go').addEventListener('click', () => { void connect(true); });
$('#touchOnly').addEventListener('click', () => { void connect(false); });
$('#resume').addEventListener('click', resumeTap);
const bail = $('#bail');
bail.addEventListener('pointerdown', bailDown);
bail.addEventListener('pointerup', bailUp);
bail.addEventListener('pointercancel', bailUp);
bail.addEventListener('contextmenu', (e) => e.preventDefault());
($('#touchToggle') as HTMLInputElement).addEventListener('change', (e) => setTouch((e.target as HTMLInputElement).checked, true));
new TouchCaster($('#touchPad'), nowMs, (r) => {
  if (!touchMode) return;
  link?.sendEvt({ t: 'tcast', power: r.power, aim: r.aim, dt: r.dt, tFlick: r.tFlick, tRel: r.tRel });
  haptic('thunk');
});

function feel(ok: boolean) {
  const f = $('#feel'); const id = Number(f.dataset.id);
  f.hidden = true;
  if (id) link?.sendEvt({ t: 'feel', id, ok });
  haptic('tick');
}
$('#feelUp').addEventListener('click', () => feel(true));
$('#feelDown').addEventListener('click', () => feel(false));
(function drawMeter() { if (!$('#ctl').hidden && !touchMode) meter.draw(det); requestAnimationFrame(drawMeter); })();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    bailUp();
    link?.sendEvt({ t: 'pause', tp: nowMs(), why: 'page hidden' });
  } else {
    visibleAt = nowMs();
    link?.wake();
    // If the link survived the sleep, tell the host right away once it is confirmed live.
    const t0 = visibleAt;
    const poll = setInterval(() => {
      if (!visibleAt || visibleAt !== t0) { clearInterval(poll); return; }
      if (link?.live) {
        clearInterval(poll);
        link.sendEvt({ t: 'resume', tp: nowMs(), reconnectMs: Math.round(nowMs() - t0), via: link.via });
        visibleAt = 0;
      }
    }, 100);
    // If motion events don't come back within 1 s, ask for one tap (never a rescan).
    if (motionWanted && !touchMode) {
      setTimeout(() => {
        if (document.visibilityState === 'visible' && !src.alive(1000)) { $('#resume').hidden = false; awaitingResume = true; }
      }, 1000);
    }
  }
});
addEventListener('pageshow', () => link?.wake());
addEventListener('online', () => link?.wake());
addEventListener('blur', () => bailUp()); // a notification banner/call steals focus: cancel cleanly
setInterval(() => {
  $('#rate').textContent = src.running ? (src.alive(500) ? 'motion ✓' : 'motion: no data') : 'motion off';
  if (link && !Number.isNaN(link.rttHalf)) $('#rate').textContent += ` · ${Math.round(link.rttHalf)} ms`;
  if (awaitingResume && src.alive(300)) { $('#resume').hidden = true; awaitingResume = false; }
}, 500);
