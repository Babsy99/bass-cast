// Bass Cast spike — full headless test run (host + pad pages in one Chrome, real PeerJS broker, MQTT relay).
// Usage: node tests/run-all.mjs   (starts vite dev servers + a local MQTT-over-WS broker if needed)
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { launch, watchConsole, padSwing, padIdleMotion, sleep, median, p95, SHOTS, APP } from './lib.mjs';
import { startBroker } from './local-broker.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const RES = path.join(ROOT, 'tests/results');
fs.mkdirSync(RES, { recursive: true }); fs.mkdirSync(SHOTS, { recursive: true });
const PAD = 'http://127.0.0.1:5174/';
const BROKER = 'ws://127.0.0.1:9001';
const Q = `?mqtt=${encodeURIComponent(BROKER)}`;
// Pairing/latency runs pin WebGL2: headless SwiftShader WebGPU sometimes loses its device and the
// host then (correctly) reloads into WebGL2, which would only add noise to timing tests. T0 covers auto.
const QW = Q + '&renderer=webgl2';
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (k) => !only || only.includes(k);
const R = { startedAt: new Date().toISOString(), env: {}, errors: [] };
const errors = R.errors;
const log = (...a) => console.log('•', ...a);

async function up(u) { try { return (await fetch(u)).ok; } catch { return false; } }
async function ensureServers() {
  for (const [w, u] of [['app', APP], ['pad', PAD]]) {
    if (!(await up(u))) {
      spawn('npm', ['run', 'dev', '-w', w], { cwd: ROOT, stdio: 'ignore', detached: true }).unref();
      for (let i = 0; i < 40 && !(await up(u)); i++) await sleep(250);
    }
  }
}
await ensureServers();
let broker = null;
try { broker = await startBroker(9001); } catch (e) { log('broker already running?', e.code); }

// Public infra reachability from this box (for the report)
R.env.peerjsBroker = await fetch('https://0.peerjs.com/peerjs/id').then((r) => r.ok).catch(() => false);
R.env.chromePolicy = (() => { try { return execSync('cat /etc/opt/chrome/policies/managed/sand-webrtc-proxy-only.json').toString().trim(); } catch { return null; } })();

const browser = await launch(['--window-size=1280,720']);

async function newHost(q = Q, vp = { width: 1280, height: 720 }) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ ...vp, deviceScaleFactor: 1 });
  watchConsole(page, 'host', errors);
  const t0 = Date.now();
  await page.goto(APP + q, { waitUntil: 'domcontentloaded' });
  // Setup screen comes first (reading time is not pairing time); one click on "Show QR" starts the clock.
  // Retry loop: headless WebGPU can lose its device and reload the page into WebGL2 at any moment.
  let setupShown = false;
  for (let k = 0; k < 4; k++) {
    try {
      if (k === 0 && !q.includes('renderer=webgl2')) await sleep(4000); // let the headless WebGPU probe / device-lost reload settle
      await page.waitForFunction(() => window.__game && (window.__padUrl || !document.querySelector('#setup').hidden), { timeout: 20000 });
      if (await page.evaluate(() => !document.querySelector('#setup').hidden)) {
        setupShown = true;
        if (!R.setupShot) { await Promise.race([page.screenshot({ path: SHOTS + 'host-setup-before-qr.png' }), sleep(5000)]); R.setupShot = true; R.setupClockBeforeClick = await page.evaluate(() => window.__game.pairingClock.startAt); }
        await page.evaluate(() => document.querySelector('#btnShowQrNow').click());
      }
      await page.waitForFunction(() => window.__padUrl && window.__game && window.__game.pairingClock.startAt, { timeout: 8000 });
      break;
    } catch (e) { if (k === 3) throw e; await sleep(500); }
  }
  return { ctx, page, loadMs: Date.now() - t0, setupShown };
}
async function newPad(url, name = 'pad', ctx = null) {
  ctx = ctx || (await browser.createBrowserContext()); // fresh context == Safari website data cleared
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  watchConsole(page, name, errors);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#go');
  return { ctx, page };
}
const hostState = (h) => h.evaluate(() => ({ status: window.__link.status, path: window.__link.path, codeUsed: window.__link.codeUsed, renderer: document.querySelector('#fps').textContent }));
async function waitPaired(h, timeout = 20000) {
  const t0 = Date.now();
  await h.waitForFunction(() => window.__link.status === 'paired' && window.__link.lastFrameAt > 0, { timeout, polling: 20 });
  return Date.now() - t0;
}
async function lastCast(h) { return h.evaluate(() => window.__game.lastCast); }
async function castAndWait(h, pad, opts, tries = 3) {
  for (let k = 0; k < tries; k++) {
    const n0 = await h.evaluate(() => window.__game.casts.length);
    await padSwing(pad, opts);
    const ok = await h.waitForFunction((n) => window.__game.casts.length > n, { timeout: 8000, polling: 50 }, n0).then(() => true).catch(() => false);
    if (ok) return lastCast(h);
    R.castRetries = (R.castRetries || 0) + 1;
    await sleep(500);
  }
  throw new Error('cast never registered');
}
async function pair(h, rewrite = (u) => u) {
  const url = rewrite(await h.evaluate(() => window.__padUrl));
  const p = await newPad(url);
  await p.page.tap('#go');
  await padIdleMotion(p.page);
  const ms = await waitPaired(h);
  return { ...p, url, connectMs: ms };
}

// ---------------------------------------------------------------- T0 renderer + start screenshots
let H, P;
if (want('basic')) {
  log('T0 renderer probe (auto) + start screenshots');
  H = await newHost();
  await sleep(4000); // allow WebGPU probe / device-lost fallback
  await H.page.waitForFunction(() => window.__padUrl && window.__link?.brokerOk, { timeout: 30000 });
  await sleep(1500);
  R.renderer = await H.page.evaluate(() => ({ overlay: document.querySelector('#fps').textContent, why: document.querySelector('#fps').title, gpuLost: sessionStorage.getItem('bcs.gpuLost') }));
  await H.page.screenshot({ path: SHOTS + 'host-start-qr.png' });
  const url = await H.page.evaluate(() => window.__padUrl);
  R.padUrlShape = url.replace(/#s=[^&]+/, '#s=<22-char base64url, 128-bit>');
  P = await newPad(url);
  await P.page.screenshot({ path: SHOTS + 'pad-start.png' });
  await P.page.tap('#go');
  await padIdleMotion(P.page);
  R.firstConnectMs = await waitPaired(H.page);
  await sleep(1200);
  await P.page.screenshot({ path: SHOTS + 'pad-connected.png' });
  R.webrtc = await P.page.evaluate(async () => {
    const l = window.__pad.link; const pc = l.evt?.peerConnection || l.peer?._connections && Object.values(l.peer._connections).flat()[0]?.peerConnection;
    let cands = [];
    if (pc) { const st = await pc.getStats(); st.forEach((r) => { if (r.type === 'local-candidate') cands.push(`${r.candidateType}/${r.protocol}/${r.address}`); }); }
    return { peerOpenAtBroker: !!l.peer?.open, rtcReady: l.rtcReady, iceState: pc?.iceConnectionState ?? 'no pc (retrying)', signalingState: pc?.signalingState ?? null, localCandidates: cands, via: l.via };
  });
  R.webrtc.hostSawOffer = await H.page.evaluate(() => window.__link.events.some(() => true) && window.__link.pairs.size >= 0);
  log('renderer', R.renderer.overlay, '| webrtc', JSON.stringify(R.webrtc));

  // ------------------------------------------------------------ T1 synthetic casts + screenshots + video
  log('T1 synthetic weak / good / late casts');
  const weak = await castAndWait(H.page, P.page, { peakW: 220 });
  await sleep(600);
  // video of the good cast via CDP screencast
  const cdp = await H.page.createCDPSession();
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => { frames.push({ data: f.data, t: f.metadata.timestamp }); await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
  await sleep(500);
  const n0 = await H.page.evaluate(() => window.__game.casts.length);
  const swingP = padSwing(P.page, { peakW: 430, seed: 2 });
  await swingP;
  await sleep(350);
  await H.page.screenshot({ path: SHOTS + 'host-mid-flight.png' });
  await H.page.waitForFunction((n) => window.__game.casts.length > n, { timeout: 12000, polling: 30 }, n0);
  await sleep(250);
  await H.page.screenshot({ path: SHOTS + 'host-splash.png' });
  const good = await lastCast(H.page);
  await sleep(1800);
  await cdp.send('Page.stopScreencast');
  // write mp4
  const fdir = '/tmp/bcs-frames'; fs.rmSync(fdir, { recursive: true, force: true }); fs.mkdirSync(fdir);
  let concat = '';
  frames.forEach((f, i) => {
    const fn = path.join(fdir, `f${String(i).padStart(4, '0')}.jpg`);
    fs.writeFileSync(fn, Buffer.from(f.data, 'base64'));
    const d = i < frames.length - 1 ? Math.max(0.02, frames[i + 1].t - f.t) : 0.1;
    concat += `file '${fn}'\nduration ${d.toFixed(3)}\n`;
  });
  if (frames.length) {
    concat += `file '${path.join(fdir, `f${String(frames.length - 1).padStart(4, '0')}.jpg`)}'\n`;
    fs.writeFileSync(path.join(fdir, 'list.txt'), concat);
    execSync(`ffmpeg -y -loglevel error -f concat -safe 0 -i ${fdir}/list.txt -vf "fps=30,scale=1280:-2,format=yuv420p" -c:v libx264 -movflags +faststart ${SHOTS}cast.mp4`);
  }
  R.video = { frames: frames.length, file: SHOTS + 'cast.mp4' };
  await sleep(500);
  const late = await castAndWait(H.page, P.page, { peakW: 430, button: true, releaseAfterPeakMs: 320, seed: 3 });
  await sleep(600);
  const early = await castAndWait(H.page, P.page, { peakW: 430, button: true, releaseAfterPeakMs: -60, seed: 4 });
  await sleep(600);
  const aimed = await castAndWait(H.page, P.page, { peakW: 380, aimDeg: 12, seed: 5 });
  const pick = (c) => ({ distFt: c.distFt, power: c.power, peak_dps: c.peak_dps, mode: c.castMode, axis: c.axis, releaseDtMs: c.releaseDtMs, timing: c.timing, launchDeg: c.launchDeg, aimDeg: c.aimDeg, landAimDeg: c.landAimDeg, path: c.path, link: c.link });
  R.syntheticCasts = { note: 'realistic iPhone-like traces on rotationRate.alpha (X), backswing +; relaxed peaks 220-430 deg/s', weak: pick(weak), goodNoButton: pick(good), lateButton320ms: pick(late), earlyButtonMinus60ms: pick(early), aimedRight12: pick(aimed) };
  R.syntheticCasts.orderOk = good.distFt > weak.distFt && good.distFt > late.distFt;
  log('casts', JSON.stringify(R.syntheticCasts));

  // ------------------------------------------------------------ T8 touch-cast fallback (pad + host mouse)
  log('T8 touch-cast fallback');
  await P.page.click('#touchToggle');
  await sleep(300);
  const nT = await H.page.evaluate(() => window.__game.casts.length);
  const box = await (await P.page.$('#touchPad')).boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await P.page.touchscreen.touchStart(cx, cy - 60);
  for (let i = 1; i <= 6; i++) { await P.page.touchscreen.touchMove(cx, cy - 60 + i * 20); await sleep(16); }
  for (let i = 1; i <= 6; i++) { await P.page.touchscreen.touchMove(cx + i * 4, cy + 60 - i * 70); await sleep(16); }
  await P.page.touchscreen.touchEnd();
  await H.page.waitForFunction((n) => window.__game.casts.length > n, { timeout: 8000 }, nT).catch(() => {});
  const tc = await lastCast(H.page);
  R.touchCastPad = tc && tc.source === 'touch' ? pick(tc) : 'no touch cast registered';
  await P.page.screenshot({ path: SHOTS + 'pad-touch-mode.png' });
  await P.page.click('#touchToggle');
  // host mouse touch-cast
  await H.page.evaluate(() => window.__game.setTouchMode(true));
  await sleep(200);
  const nM = await H.page.evaluate(() => window.__game.casts.length);
  await H.page.mouse.move(640, 300); await H.page.mouse.down();
  for (let i = 1; i <= 4; i++) { await H.page.mouse.move(640, 300 + i * 30); await sleep(16); }
  for (let i = 1; i <= 3; i++) { await H.page.mouse.move(640 - i * 10, 420 - i * 130); }
  await H.page.mouse.up();
  await H.page.waitForFunction((n) => window.__game.casts.length > n, { timeout: 8000 }, nM).catch(() => {});
  const mc = await lastCast(H.page);
  R.touchCastHostMouse = mc && mc.source === 'touch' && mc.i > nM ? pick(mc) : 'no mouse cast registered';
  await H.page.evaluate(() => window.__game.setTouchMode(false));
  log('touch', JSON.stringify(R.touchCastPad), JSON.stringify(R.touchCastHostMouse));
}

// ---------------------------------------------------------------- T7 Test-10 mode (scoring + export mechanics)
if (want('basic')) {
  log('T7 Test 10 casts (synthetic thrower aiming at each target)');
  // Inverse of the app's own launch curve (good release): power needed for a target distance.
  execSync('npx esbuild app/src/cast.ts --bundle --format=esm --platform=node --outfile=/tmp/bcs-sim.mjs --log-level=error', { cwd: ROOT });
  const { simulate } = await import('/tmp/bcs-sim.mjs');
  const powerFor = (ft) => { let lo = 0, hi = 1; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; simulate({ power: m, dt: 30, aim: 0 }).distFt < ft ? (lo = m) : (hi = m); } return (lo + hi) / 2; };
  await H.page.evaluate(() => window.__game.startTest10());
  const pw = await H.page.evaluate(() => window.__game.det.power);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const feelLog = [];
  for (let i = 0; i < 10; i++) {
    const tg = await H.page.evaluate(() => window.__game.test.target);
    if (i === 3) { await H.page.screenshot({ path: SHOTS + 'host-test10-target.png' }); await P.page.screenshot({ path: SHOTS + 'pad-power-band.png' }); }
    const p = powerFor(tg.ft);
    // invert the host's motion power curve; human-ish noise ±6% swing speed, ±4° aim
    let peakW = (pw.wMin + Math.pow(p, 1 / pw.gamma) * (pw.wMax - pw.wMin)) * (1 + (rnd() - 0.5) * 0.12);
    if (i === 2) peakW = 640; // deliberately too hard: must be flagged and never count
    const c = await castAndWait(H.page, P.page, { peakW, aimDeg: tg.aim + (rnd() - 0.5) * 8, seed: 100 + i });
    // one-tap "Felt relaxed?" on the pad; cast 5 answers 👎
    await P.page.waitForFunction(() => !document.querySelector('#feel').hidden, { timeout: 5000 }).catch(() => {});
    if (i === 0) await P.page.screenshot({ path: SHOTS + 'pad-felt-relaxed.png' });
    const up = i !== 4;
    await P.page.tap(up ? '#feelUp' : '#feelDown').catch(() => {});
    feelLog.push({ i: c.i, up });
    await sleep(500);
  }
  await sleep(500);
  await H.page.screenshot({ path: SHOTS + 'host-test10-summary.png' });
  R.test10 = await H.page.evaluate(() => { const e = window.__game.exportCasts(); return { score: `${e.test10.counted}/${e.test10.attempts}`, summaryText: document.querySelector('#testInfo').innerText,
    rows: e.test10.rows.map((r) => ({ intendedFt: r.intendedFt, distFt: r.distFt, missText: r.missText, missFt: r.missFt, missDeg: r.missDeg, peak_dps: r.peak_dps, tooHard: r.tooHard, relaxed: r.relaxed, good: r.good, counts: r.counts })) }; });
  R.test10.ruleOk = R.test10.rows[2].tooHard === true && R.test10.rows[2].counts === false && R.test10.rows[4].relaxed === false && R.test10.rows[4].counts === false &&
    R.test10.rows.every((r) => r.counts === (r.good && !r.tooHard && r.relaxed === true)) && R.test10.rows.every((r) => r.good || /(Long|Short) by \d+ ft|(Left|Right) by \d+°/.test(r.missText));
  fs.writeFileSync(path.join(RES, 'test10-casts.json'), JSON.stringify(await H.page.evaluate(() => window.__game.exportCasts()), null, 2));
  log('test10', R.test10.score);
}

// ---------------------------------------------------------------- T9 motion axis/sign + rejects + lag proof (fresh hosts)
async function attemptAndWait(h, pad, opts) {
  const n0 = await h.evaluate(() => window.__game.attempts.length);
  await padSwing(pad, opts);
  await h.waitForFunction((n) => window.__game.attempts.length > n, { timeout: 6000, polling: 50 }, n0).catch(() => {});
  await sleep(300);
  return h.evaluate((n) => window.__game.attempts.slice(n), n0);
}
if (want('basic') || want('motion')) {
  log('T9 motion: fresh hosts (empty storage), no button, realistic iPhone traces on X+, X−, Y+');
  R.motion = {};
  for (const [axis, sign] of [[0, 1], [0, -1], [1, 1]]) {
    const key = `${'XYZ'[axis]}${sign > 0 ? '+' : '-'}`;
    const h = await newHost(QW, { width: 960, height: 540 });
    const p = await pair(h.page);
    await sleep(1500);
    const c1 = await castAndWait(h.page, p.page, { peakW: 400, axis, sign, seed: 31 + axis });
    await sleep(500);
    const c2 = await castAndWait(h.page, p.page, { peakW: 300, axis, sign, seed: 41 + axis });
    await sleep(500);
    const c3 = await castAndWait(h.page, p.page, { peakW: 500, axis, sign, seed: 51 + axis });
    const st = await h.page.evaluate(() => ({ lock: window.__game.det.lock, power: window.__game.det.power, stored: localStorage.getItem('bcs.axis'), attempts: window.__game.attempts.map((a) => a.reason) }));
    const r = { first400: { power: c1.power, distFt: c1.distFt, peak_dps: c1.peak_dps, mode: c1.castMode }, at300: { power: c2.power, distFt: c2.distFt }, at500: { power: c3.power, distFt: c3.distFt }, learned: st.lock, persisted: !!st.stored, autoScale: { wMax: st.power.wMax, from: st.power.scaledFrom }, attempts: st.attempts };
    if (key === 'X+') {
      await h.page.screenshot({ path: SHOTS + 'host-gyro-meter.png' });
      await p.page.screenshot({ path: SHOTS + 'pad-gyro-meter.png' });
      // rejects: weak flick (no-button), button held too long, button let go during the backswing with no flick
      const weak = await attemptAndWait(h.page, p.page, { peakW: 100, backW: 120, seed: 61 });
      await sleep(400);
      const coachWeak = await p.page.evaluate(() => document.querySelector('#coach').textContent);
      const held = await attemptAndWait(h.page, p.page, { peakW: 400, button: true, releaseAfterPeakMs: 650, seed: 62 });
      await sleep(400);
      const relEarly = await attemptAndWait(h.page, p.page, { peakW: 400, button: true, releaseAfterPeakMs: 'back', noFlick: true, seed: 63 });
      await sleep(400);
      const strip = (a) => a.map((x) => ({ reason: x.reason, coach: x.coach, backPeak: x.backPeak, fwdPeak: x.fwdPeak, axisPeaks: x.axisPeaks, mode: x.mode }));
      r.rejects = { weak: strip(weak), heldTooLong: strip(held), releasedEarly: strip(relEarly), padCoachAfterWeak: coachWeak };
      const exp = await h.page.evaluate(() => window.__game.exportCasts());
      r.exportHasAttempts = { n: exp.attempts.length, stats: exp.attemptStats };
      // lag proof: phone flash + 880 Hz at its own flick detection, Mac corner square + 1760 Hz on the whip frame
      await h.page.evaluate(() => { const c = document.querySelector('#lagProof'); c.checked = true; c.dispatchEvent(new Event('change')); });
      await sleep(400);
      const watch = (sel) => `(() => { window.__flashes = []; const el = document.querySelector('${sel}'); new MutationObserver(() => { if (!el.hidden) window.__flashes.push(performance.timeOrigin + performance.now()); }).observe(el, { attributes: true, attributeFilter: ['hidden'] }); })()`;
      await p.page.evaluate(watch('#flash')); await h.page.evaluate(watch('#lpSquare'));
      const lp = await castAndWait(h.page, p.page, { peakW: 420, seed: 64 });
      await sleep(300);
      const padFl = await p.page.evaluate(() => window.__flashes), hostFl = await h.page.evaluate(() => window.__flashes);
      const lag = await h.page.evaluate(() => window.__game.lag.at(-1));
      r.lagProof = { padFlashes: padFl.length, hostFlashes: hostFl.length, flashGapMs: padFl.length && hostFl.length ? Math.round(hostFl[0] - padFl[0]) : null, measuredLagMs: lag?.lag_ms, link: lag?.link, ice: lag?.ice, cast: lp.distFt,
        note: 'same box: both clocks share one epoch, so the flash gap ~= flick->whip lag' };
    }
    R.motion[key] = r;
    log('motion', key, JSON.stringify(r));
    await h.ctx.close(); await p.ctx.close();
  }
}

// ---------------------------------------------------------------- B0a: second phone with a used code
if (want('basic')) {
  log('B0a second phone scans the used QR');
  const url = await H.page.evaluate(() => window.__padUrl);
  const P2 = await newPad(url, 'pad2');
  await P2.page.tap('#go');
  await P2.page.waitForFunction(() => window.__pad?.link?.state === 'rejected', { timeout: 15000 }).catch(() => {});
  R.b0a = { padState: await P2.page.evaluate(() => window.__pad.link.state + ':' + window.__pad.link.rejectWhy), hostLog: await H.page.evaluate(() => window.__link.events.filter((e) => e.line.includes('REJECTED')).map((e) => `${e.at} ${e.line}`)) };
  await P2.page.screenshot({ path: SHOTS + 'pad-rejected-used-code.png' });
  await P2.ctx.close();
  log('b0a', JSON.stringify(R.b0a));
}

// ---------------------------------------------------------------- T4 reconnects
if (want('basic')) {
  log('T4a kill channel');
  R.reconnect = {};
  const gapBefore = await H.page.evaluate(() => window.__link.reconnects.length);
  await P.page.evaluate(() => window.__pad.killChannel());
  const t0 = Date.now();
  await sleep(300);
  await H.page.waitForFunction(() => window.__link.status === 'paired' && performance.timeOrigin + performance.now() - window.__link.lastFrameAt < 200, { timeout: 15000, polling: 20 });
  R.reconnect.killChannel = { framesBackAfterMs: Date.now() - t0, hostLog: await H.page.evaluate((n) => window.__link.reconnects.slice(n), gapBefore) };
  const okCast = await castAndWait(H.page, P.page, { peakW: 420 });
  R.reconnect.killChannel.castAfter = okCast.distFt;
  log('kill', JSON.stringify(R.reconnect.killChannel));

  log('T4b phone sleeps 30 s, network drops during sleep, wakes');
  await P.page.evaluate(() => {
    window.__vis = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__vis });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__vis === 'hidden' });
  });
  await P.page.evaluate(() => { window.__swinging = true; window.__vis = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(500);
  R.reconnect.sleep = { hostDuringSleep: (await hostState(H.page)).status };
  await H.page.screenshot({ path: SHOTS + 'host-controller-paused.png' });
  await P.page.evaluate(() => window.__pad.link.mqtt?.client?.stream?.destroy());
  await sleep(30000);
  const tw = Date.now();
  await P.page.evaluate(() => { window.__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
  // Motion stays stopped (as iOS may do) -> expect "Tap to resume"
  await P.page.waitForFunction(() => !document.querySelector('#resume').hidden, { timeout: 5000 }).catch(() => {});
  R.reconnect.sleep.tapToResumeShown = await P.page.evaluate(() => !document.querySelector('#resume').hidden);
  await P.page.screenshot({ path: SHOTS + 'pad-tap-to-resume.png' });
  await P.page.tap('#resume');
  await P.page.evaluate(() => { window.__swinging = false; });
  await H.page.waitForFunction(() => window.__link.status === 'paired' && performance.timeOrigin + performance.now() - window.__link.lastFrameAt < 200, { timeout: 15000, polling: 20 });
  R.reconnect.sleep.wakeToControllingMs = Date.now() - tw;
  await sleep(500);
  R.reconnect.sleep.hostLog = await H.page.evaluate(() => window.__link.reconnects.slice(-2));
  R.reconnect.sleep.castAfter = (await castAndWait(H.page, P.page, { peakW: 420 })).distFt;
  log('sleep', JSON.stringify(R.reconnect.sleep));

  log('T4c pad page reload (iOS forgets motion permission) -> one tap, no rescan');
  await P.page.reload({ waitUntil: 'domcontentloaded' });
  await P.page.waitForSelector('#go');
  R.reconnect.reload = { button: await P.page.$eval('#go', (e) => e.textContent) };
  const tr = Date.now();
  await P.page.tap('#go');
  await padIdleMotion(P.page);
  await H.page.waitForFunction(() => window.__link.status === 'paired' && performance.timeOrigin + performance.now() - window.__link.lastFrameAt < 200, { timeout: 15000, polling: 20 });
  R.reconnect.reload.tapToControllingMs = Date.now() - tr;
  R.reconnect.reload.castAfter = (await castAndWait(H.page, P.page, { peakW: 420 })).distFt;
  log('reload', JSON.stringify(R.reconnect.reload));

  log('T4d camera-scan context with empty storage (pairing only in URL fragment)');
  const pairedUrl = await P.page.evaluate(() => location.href);
  await P.ctx.close();
  P = await newPad(pairedUrl, 'pad-cam');
  const tcam = Date.now();
  await P.page.tap('#go');
  await padIdleMotion(P.page);
  await H.page.waitForFunction(() => window.__link.status === 'paired' && performance.timeOrigin + performance.now() - window.__link.lastFrameAt < 200, { timeout: 15000, polling: 20 });
  R.reconnect.cameraContext = { fragmentHasPairing: /[#&]p=/.test(pairedUrl), tapToControllingMs: Date.now() - tcam, castAfter: (await castAndWait(H.page, P.page, { peakW: 420 })).distFt };
  log('cam', JSON.stringify(R.reconnect.cameraContext));

  log('T4e host (game) reload keeps pairing');
  const th = Date.now();
  await H.page.reload({ waitUntil: 'domcontentloaded' });
  await H.page.waitForFunction(() => window.__link && window.__link.status === 'paired' && window.__link.lastFrameAt > 0, { timeout: 20000, polling: 50 }).catch(() => {});
  R.reconnect.hostReload = { ok: (await hostState(H.page)).status === 'paired', ms: Date.now() - th, qrHidden: await H.page.evaluate(() => document.querySelector('#qrCard').hidden) };
  log('hostReload', JSON.stringify(R.reconnect.hostReload));
  await H.ctx.close(); await P.ctx.close();
}

// ---------------------------------------------------------------- B0a: expired (never used) code
if (want('basic') || want('expired')) {
  log('B0a expired: QR shown 16 min ago (TTL 15 min), first phone scans it');
  const h = await newHost(QW, { width: 640, height: 360 });
  await h.page.evaluate(() => { window.__link.codeShownAt = Date.now() - 16 * 60 * 1000; window.__link.persist(); });
  const url = await h.page.evaluate(() => window.__padUrl);
  const Px = await newPad(url, 'pad-expired');
  await Px.page.tap('#go');
  await Px.page.waitForFunction(() => window.__pad?.link?.state === 'rejected', { timeout: 15000 }).catch(() => {});
  R.b0aExpired = { padState: await Px.page.evaluate(() => window.__pad.link.state + ':' + window.__pad.link.rejectWhy),
    padText: await Px.page.evaluate(() => document.querySelector('#rejWhy')?.textContent),
    hostStatus: await h.page.evaluate(() => window.__link.status),
    hostLog: await h.page.evaluate(() => window.__link.events.filter((e) => e.line.includes('REJECTED')).map((e) => `${e.at} ${e.line}`)) };
  await Px.page.screenshot({ path: SHOTS + 'pad-rejected-expired-code.png' });
  await Px.ctx.close(); await h.ctx.close();
  log('b0aExpired', JSON.stringify(R.b0aExpired));
}

// ---------------------------------------------------------------- T2 five fresh pairings
if (want('pair')) {
  log('T2 five fresh pairings (new game tab + pad with cleared data each time)');
  R.pairings = [];
  for (let i = 0; i < 5; i++) {
    const h = await newHost(QW, { width: 640, height: 360 });
    const qrAt = await h.page.evaluate(() => window.__game.pairingClock.startAt);
    try {
      const p = await pair(h.page);
      const c = await castAndWait(h.page, p.page, { peakW: 420 });
      const pc = await h.page.evaluate(() => window.__game.pairingClock.ms);
      const path = (await hostState(h.page)).path;
      const scan = await h.page.evaluate(() => window.__game.pairingClock.log.at(-1)?.scanToCastMs ?? null);
      R.pairings.push({ ok: true, setupShown: h.setupShown, hostLoadMs: h.loadMs, tapToConnectedMs: p.connectMs, qrToFirstCastMs: pc, scanToFirstCastMs: scan, path, distFt: c.distFt });
      await p.ctx.close();
    } catch (e) { R.pairings.push({ ok: false, error: String(e.message || e) }); }
    await h.ctx.close();
    log('pairing', i + 1, JSON.stringify(R.pairings.at(-1)));
  }
  const ok = R.pairings.filter((p) => p.ok);
  R.pairingSummary = { success: `${ok.length}/5`, tapToConnectedMedianMs: median(ok.map((p) => p.tapToConnectedMs)), qrToFirstCastMedianMs: median(ok.map((p) => p.qrToFirstCastMs)), scanToFirstCastMedianMs: median(ok.map((p) => p.scanToFirstCastMs)), max: Math.max(...ok.map((p) => p.qrToFirstCastMs)) };
}

// ---------------------------------------------------------------- T5/T6 latency, 50 casts
async function latencyRun(label, setup, teardown, rewrite) {
  const h = await newHost(QW, { width: 640, height: 360 });
  const p = await pair(h.page, rewrite);
  await sleep(2500); // let the first clock-sync burst finish
  if (setup) await setup(h, p);
  await sleep(1500);
  await h.page.evaluate(() => window.__game.startLat50());
  for (let i = 0; i < 50; i++) {
    try { await castAndWait(h.page, p.page, { peakW: 320 + (i % 5) * 40, seed: i + 1 }); } catch { /* lost cast */ }
    await sleep(150);
  }
  await sleep(1000);
  const exp = await h.page.evaluate(() => window.__game.exportLatency());
  if (teardown) await teardown(h, p);
  fs.writeFileSync(path.join(RES, `latency-${label}.json`), JSON.stringify(exp, null, 2));
  if (label === 'mqtt-local') await h.page.evaluate(() => { document.querySelector('#panel').hidden = false; }), await sleep(600), await h.page.screenshot({ path: SHOTS + 'host-panel-pass-criteria.png' });
  await h.ctx.close(); await p.ctx.close();
  const s = exp.latencyTest.stats;
  return { casts: exp.latencyTest.rows.length, path: exp.latencyTest.rows[0]?.path, linkTags: exp.latencyTest.rows.reduce((m, r) => { m[r.link] = (m[r.link] ?? 0) + 1; return m; }, {}), ice: exp.link?.ice ?? null, lagMedianMs: s.median, lagP95Ms: s.p95, detectMedianMs: s.detectMedian, detectP95Ms: s.detectP95, hostFps: s.hostFps,
    rttHalfMedianMs: exp.pingRttHalf.median, rttHalfP95Ms: exp.pingRttHalf.p95, deliveryAgeMedianMs: exp.deliveryAge.median, deliveryAgeP95Ms: exp.deliveryAge.p95,
    clockOffsetMs: exp.clockSync.at(-1)?.offset, file: `tests/results/latency-${label}.json` };
}
if (want('lat')) {
  log('T5 latency 50 casts, MQTT relay, unthrottled');
  R.latency = {};
  R.latency.mqttLocal = await latencyRun('mqtt-local');
  log(JSON.stringify(R.latency.mqttLocal));
  log('T6 latency 50 casts, MQTT relay, pad behind a bad link: +150 ms each way (RTT +300 ms), 5% segment loss (+200 ms RTO)');
  // tc/netem is unavailable in this kernel (sch_netem missing), so the pad's broker connection goes
  // through tests/lag-proxy.mjs instead. The host stays on the clean link (Mac on good Wi-Fi, phone on a bad one).
  const { startLagProxy } = await import('./lag-proxy.mjs');
  const lp = await startLagProxy(9002, 9001);
  const viaProxy = (u) => u.replace(encodeURIComponent('127.0.0.1:9001'), encodeURIComponent('127.0.0.1:9002')).replace('127.0.0.1:9001', '127.0.0.1:9002');
  R.latency.mqttThrottled = await latencyRun('mqtt-throttled-rtt300-loss5', async () => { lp.cfg.delayMs = 150; lp.cfg.loss = 0.05; lp.cfg.lostChunks = 0; lp.cfg.chunks = 0; },
    async () => { R.latency.proxyStats = { chunks: lp.cfg.chunks, lostChunks: lp.cfg.lostChunks }; lp.cfg.delayMs = 0; lp.cfg.loss = 0; }, viaProxy);
  await lp.close();
  log(JSON.stringify(R.latency.mqttThrottled), JSON.stringify(R.latency.proxyStats));
  log('T6b CDP emulateNetworkConditions on the pad (latency 300 ms) — WebSocket only');
  R.latency.cdpPad300 = await latencyRun('mqtt-cdp-pad-300ms', async (h, p) => {
    const c = await p.page.createCDPSession(); await c.send('Network.enable');
    await c.send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: -1, uploadThroughput: -1, packetLoss: 5 });
  });
  log(JSON.stringify(R.latency.cdpPad300));
}

await browser.close();
if (broker) await broker.close();
R.consoleErrors = { count: errors.length, sample: errors.slice(0, 20) };
R.finishedAt = new Date().toISOString();
const out = path.join(RES, `summary${only ? '-' + only.join('-') : ''}.json`);
fs.writeFileSync(out, JSON.stringify(R, null, 2));
log('console errors:', errors.length);
log('wrote', out);
process.exit(0);
