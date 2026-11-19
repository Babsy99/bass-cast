// Fast unit tests for the shared motion detector + touch power curve, on realistic iPhone-like traces.
// Usage: node tests/detector-unit.mjs   (bundles shared/*.ts with esbuild, no browser)
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
const ROOT = new URL('..', import.meta.url).pathname;
execSync('npx esbuild app/src/cast.ts --bundle --format=esm --platform=node --outfile=/tmp/bcs-det.mjs --log-level=error', { cwd: ROOT });
execSync('npx esbuild shared/touchcast.ts --bundle --format=esm --platform=node --outfile=/tmp/bcs-touch.mjs --log-level=error', { cwd: ROOT });
const D = await import('/tmp/bcs-det.mjs?' + Date.now());
const T = await import('/tmp/bcs-touch.mjs?' + Date.now());

const CLOCK = { t: 1000 };
/** Same trace model as tests/lib.mjs padSwing, generated offline (60 Hz with jitter, tremor, cross-axis, rebound). */
function trace({ peakW = 400, backW = 220, axis = 0, sign = 1, button = false, releaseAfterPeakMs = 30, seed = 1, noFlick = false, idleMs = 1500 } = {}) {
  let sd = seed * 9301 + 49297; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) * 1.4;
  const others = [0, 1, 2].filter((i) => i !== axis);
  const ev = []; let t = CLOCK.t; let seq = 0;
  const fire = (w) => {
    const s = (t - 1000) / 1000; const rr = [0, 0, 0];
    rr[axis] = sign * w; rr[others[0]] = 0.25 * w * Math.sin(1.3 + s * 2) + 4 * gauss(); rr[others[1]] = -0.12 * w + 4 * gauss();
    for (let i = 0; i < 3; i++) rr[i] += 6 * Math.sin(2 * Math.PI * 9 * s + i) + 2 * gauss();
    ev.push({ k: 'f', f: { seq: seq++, tPad: t, th: t, rr, acc: [0, w / 120, Math.abs(w) / 90], ori: [40, 70, 0], bail: false } });
    t += 16 + (rnd() - 0.5) * 6;
  };
  for (let i = 0; i < 8; i++) fire(0);
  let rel = false;
  if (button) { ev.push({ k: 'b', d: true, t }); for (let i = 0; i < 4; i++) fire(0); }
  for (let i = 0; i < 20; i++) { fire(backW * Math.sin((Math.PI * (i + 0.5)) / 20)); if (button && releaseAfterPeakMs === 'back' && i === 14) { ev.push({ k: 'b', d: false, t }); rel = true; } }
  for (let i = 0; i < 4; i++) fire(0);
  const relIdx = typeof releaseAfterPeakMs === 'number' ? 6 + Math.round(releaseAfterPeakMs / 16) : -99;
  for (let i = 0; i < 42; i++) {
    const u = i / 12; let w = 0;
    if (!noFlick) w = i < 12 ? -peakW * Math.sin(Math.PI * u) : i < 20 ? peakW * 0.22 * Math.sin((Math.PI * (i - 12)) / 8) : 0;
    fire(w);
    if (button && !rel && relIdx > -99 && i >= relIdx) { ev.push({ k: 'b', d: false, t }); rel = true; }
  }
  if (button && !rel) ev.push({ k: 'b', d: false, t });
  for (let i = 0; i < idleMs / 16; i++) fire(0);
  CLOCK.t = t + 50;
  return ev;
}
function run(det, ev) {
  const out = { casts: [], attempts: [] };
  det.ev.onCast = (p) => out.casts.push(p);
  det.ev.onAttempt = (a) => out.attempts.push(a);
  for (const e of ev) e.k === 'f' ? det.feed(e.f) : det.bail(e.d, e.t, [40, 70, 0]);
  det.releaseTimeout();
  return out;
}
const results = []; let fails = 0;
const check = (name, ok, info) => { results.push({ name, ok, ...info }); if (!ok) fails++; console.log(ok ? '✓' : '✗', name, JSON.stringify(info)); };
const r2 = (x) => Math.round(x * 100) / 100;

// 1. Fresh detector, upright portrait cast on X (alpha), backswing positive, relaxed 400 deg/s, no button.
{
  const det = new D.CastDetector();
  const o = run(det, trace({ peakW: 400, axis: 0, sign: 1, seed: 1 }));
  const c = o.casts[0];
  check('X+ 400°/s no-button casts, learns X+, mid power', !!c && det.lock?.axis === 0 && det.lock?.sign === 1 && c.power > 0.55 && c.power < 0.75,
    { casts: o.casts.length, power: c && r2(c.power), dt: c && Math.round(c.dt), timing: c?.timing, lock: det.lock, wMax: det.power.wMax, peak: c && Math.round(c.peakW) });
  // follow-ups on the same (now learned + auto-scaled) detector
  const p = {};
  for (const w of [300, 400, 500, 600]) { const x = run(det, trace({ peakW: w, seed: w })); p[w] = x.casts[0] ? r2(x.casts[0].power) : null; }
  check('power curve after auto-scale: 300 < 400 < 500, 500 ≈ 0.8-0.95', p[300] < p[400] && p[400] < p[500] && p[500] >= 0.78 && p[500] <= 0.97, { powers: p });
  // weak wiggle -> logged reject with coaching and raw peaks
  const weak = run(det, trace({ peakW: 100, backW: 120, seed: 3 }));
  check('weak flick rejected + logged with peaks', weak.casts.length === 0 && weak.attempts.length === 1 && ['no_forward', 'back_timeout'].includes(weak.attempts[0].reason),
    { attempt: weak.attempts[0] && { reason: weak.attempts[0].reason, coach: weak.attempts[0].coach, back: weak.attempts[0].backPeak, fwd: weak.attempts[0].fwdPeak, axes: weak.attempts[0].axisPeaks } });
  // button: release 60 ms after the peak = good; 300 ms = late; 40 ms before the peak = accepted early; held 600 ms = held_too_long; let go in backswing with no flick = released_early
  const b = (opt) => run(det, trace({ peakW: 400, button: true, seed: 11, ...opt }));
  const g = b({ releaseAfterPeakMs: 60 }), l = b({ releaseAfterPeakMs: 300 }), e = b({ releaseAfterPeakMs: -40 }), h = b({ releaseAfterPeakMs: 600 }), re = b({ releaseAfterPeakMs: 'back', noFlick: true });
  check('button: +60 ms good, +300 ms late (accepted ≤450), −40 ms accepted early', g.casts[0]?.timing === 'good' && l.casts[0]?.timing === 'late' && e.casts.length === 1 && e.casts[0].dt < 0,
    { good: g.casts[0] && Math.round(g.casts[0].dt), late: l.casts[0] && Math.round(l.casts[0].dt), early: e.casts[0] && Math.round(e.casts[0].dt) });
  check('button: held 600 ms -> held_too_long; let go in backswing, no flick -> released_early', h.attempts[0]?.reason === 'held_too_long' && re.attempts[0]?.reason === 'released_early',
    { held: h.attempts[0]?.reason, early: re.attempts[0]?.reason, coachHeld: h.attempts[0]?.coach });
  // grip change: same learned detector, swing now on Y -> wrong_axis once, then re-learns Y
  const w1 = run(det, trace({ peakW: 420, axis: 1, sign: 1, seed: 21 }));
  const w2 = run(det, trace({ peakW: 420, axis: 1, sign: 1, seed: 22 }));
  check('grip change X->Y: wrong_axis then re-learn Y and cast', w1.attempts.some((a) => a.reason === 'wrong_axis') && w2.casts.length === 1 && det.lock?.axis === 1,
    { first: w1.attempts.map((a) => a.reason), second: w2.attempts.map((a) => a.reason), lock: det.lock });
}
// 1b. Timid first swing must not make later normal swings saturate.
{
  const det = new D.CastDetector();
  const a = run(det, trace({ peakW: 210, seed: 71 })), b = run(det, trace({ peakW: 420, seed: 72 }));
  check('timid first swing (210°/s) then 420°/s: second is not maxed out', !!a.casts[0] && !!b.casts[0] && b.casts[0].power < 0.97 && det.power.wMax >= 440,
    { first: a.casts[0] && r2(a.casts[0].power), second: b.casts[0] && r2(b.casts[0].power), wMax: det.power.wMax });
}
// 2. Other sign and other axes on fresh detectors.
for (const [axis, sign] of [[0, -1], [1, 1], [1, -1], [2, -1]]) {
  const det = new D.CastDetector();
  const o = run(det, trace({ peakW: 380, axis, sign, seed: 5 + axis }));
  const o2 = run(det, trace({ peakW: 380, axis, sign, seed: 9 + axis }));
  check(`fresh ${'XYZ'[axis]}${sign > 0 ? '+' : '−'} casts first swing + learns it`, o.casts.length === 1 && det.lock?.axis === axis && det.lock?.sign === sign && o2.casts.length === 1,
    { first: o.casts[0] && r2(o.casts[0].power), second: o2.casts[0] && r2(o2.casts[0].power), lock: det.lock });
}
// 2b. Brief traces 300 / 450 / 900 deg/s -> power and landing distance (good release), two ways:
//     a fresh detector (first swing = 450 sets the auto power scale) and the default curve (no auto-scale).
{
  const dist = (c) => (c ? Math.round(D.simulate({ power: c.power, dt: c.dt, aim: 0 }).distFt * 10) / 10 : null);
  const det = new D.CastDetector();
  const first = run(det, trace({ peakW: 450, seed: 81 })).casts[0];
  const auto = {};
  for (const w of [300, 450, 900]) { const c = run(det, trace({ peakW: w, seed: 90 + w })).casts[0]; auto[w] = c && { peak: Math.round(c.peakW), power: r2(c.power), ft: dist(c), timing: c.timing, tooHard: c.peakW > 500 }; }
  const d0 = new D.CastDetector(); d0.autoScale = false;
  const def = {};
  for (const w of [300, 450, 900]) { const c = run(d0, trace({ peakW: w, seed: 190 + w })).casts[0]; def[w] = c && { power: r2(c.power), ft: dist(c) }; }
  check('300/450/900 traces: all cast; 300 and 450 mid-range, 900 maxed and flagged too hard', !!auto[300] && !!auto[450] && !!auto[900] && auto[300].power < auto[450].power && auto[450].power < 0.9 && auto[900].power === 1 && auto[900].tooHard,
    { firstSwing450: first && { power: r2(first.power), ft: dist(first) }, afterAutoScale: auto, defaultCurve: def, wMax: det.power.wMax });
}
// 3. Prior: old host code read rr[1]; show that an X swing used to be invisible to it.
{
  const ev = trace({ peakW: 400, axis: 0, sign: 1, seed: 1 }).filter((e) => e.k === 'f');
  const peakBeta = Math.max(...ev.map((e) => Math.abs(e.f.rr[1])));
  check('old bug reproduced: X swing shows small rr[1] (beta) — old forward threshold 150/260', peakBeta < 150, { peakBetaDps: Math.round(peakBeta), peakAlphaDps: Math.round(Math.max(...ev.map((e) => Math.abs(e.f.rr[0])))) });
}
// 4. Touch power curve: normal flick ~60-70%, long fast drag ~100%, old curve for comparison.
{
  const mk = (len, speed, H = 600) => { // drag down 80 px then flick up len*H px at `speed` (px/ms per 480 px of pad height)
    const pts = []; let t = 0, y = 300; const x = 200;
    for (let i = 0; i < 5; i++) { pts.push({ x, y, t }); y += 16; t += 16; }
    const pxPerMs = speed * (H / 480); const dist = len * H; const n = Math.max(4, Math.round(dist / (pxPerMs * 8))); // iOS delivers touch moves at ~120 Hz on ProMotion, 60 Hz otherwise
    for (let i = 0; i < n; i++) { y -= dist / n; t += 8; pts.push({ x, y, t }); }
    return T.TouchCaster.analyze(pts, 80, t + 5, H);
  };
  const normal = mk(0.35, 4.5), lazy = mk(0.25, 2.5), longFast = mk(0.95, 9), fastShort = mk(0.3, 9);
  const oldNormal = Math.min(1, Math.max(0, (normal.speedN - 0.4) / 3.2)); // the previous curve
  check('touch: normal flick 60-70%, long+fast = max, fast-but-short well below max', normal.power >= 0.58 && normal.power <= 0.72 && longFast.power >= 0.97 && fastShort.power < 0.85,
    { normalSpeedLen: [r2(normal.speedN), r2(normal.lenN)], longFastSpeedLen: [r2(longFast.speedN), r2(longFast.lenN)], lazy: r2(lazy.power), normal: r2(normal.power), fastShort: r2(fastShort.power), longFast: r2(longFast.power), oldCurveNormal: r2(oldNormal) });
}
fs.mkdirSync(path.join(ROOT, 'tests/results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'tests/results/detector-unit.json'), JSON.stringify({ at: new Date().toISOString(), pass: results.length - fails, fail: fails, results }, null, 2));
console.log(`${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
