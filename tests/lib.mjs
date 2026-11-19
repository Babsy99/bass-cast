// Shared helpers for the headless Bass Cast tests (puppeteer-core from /tmp/pw).
import { createRequire } from 'module';
const require = createRequire('/tmp/pw/');
export const puppeteer = require('puppeteer-core');

export const APP = process.env.APP_URL || 'http://127.0.0.1:5173/';
export const SHOTS = new URL('../shots/', import.meta.url).pathname;

export async function launch(extra = []) {
  return puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-unsafe-webgpu',
      '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', ...extra],
  });
}

export function watchConsole(page, name, errors) {
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') errors.push(`[${name}] ${t}`);
    if (process.env.VERBOSE) console.log(`[${name}:${m.type()}] ${t}`);
  });
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror ${e.message}`));
}

export async function openHost(browser, errors, q = '') {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  watchConsole(page, 'host', errors);
  await page.goto(APP + q, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__padUrl && window.__link && window.__link.brokerOk, { timeout: 30000 });
  return { ctx, page };
}

export async function openPad(browser, url, errors, name = 'pad', ctx = null) {
  ctx = ctx || (await browser.createBrowserContext()); // fresh context = Safari data cleared
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  watchConsole(page, name, errors);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { ctx, page };
}

/**
 * Inject a realistic iPhone-like overhead cast on the pad page (devicemotion + deviceorientation).
 * - axis: rotationRate index the swing happens on (0 = alpha = device X, the upright-portrait pitch axis; 1 = beta/Y; 2 = gamma/Z)
 * - sign: +1 if the backswing reads positive on that axis, -1 if negative (a different grip / phone orientation)
 * - backW / peakW: backswing and forward-flick peak, deg/s (a relaxed wrist flick is ~300-500)
 * - cross-axis coupling (~25% / 12%), 9 Hz hand tremor (±6 deg/s), sensor noise, 60 Hz with ±3 ms jitter,
 *   a pause at the top, and a post-flick rebound (the wrist stopping the phone) like a real trace.
 * - button: false = no-button (default) mode; true = hold the button through the swing and let go at
 *   releaseAfterPeakMs relative to the forward peak (negative = before the peak, 'back' = during the backswing).
 */
export async function padSwing(page, { peakW = 400, backW = 220, axis = 0, sign = 1, button = false, releaseAfterPeakMs = 30, aimDeg = 0, seed = 1, noFlick = false } = {}) {
  return page.evaluate(async (o) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let sd = o.seed * 9301 + 49297; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
    const gauss = () => (rnd() + rnd() + rnd() - 1.5) * 1.4;
    const bail = document.querySelector('#bail');
    const others = [0, 1, 2].filter((i) => i !== o.axis);
    const t0 = performance.now();
    let pitch = 70, yaw = 40;
    const fire = (w /* deg/s on the swing axis, + = backswing */) => {
      const t = (performance.now() - t0) / 1000;
      const rr = [0, 0, 0];
      rr[o.axis] = o.sign * w;
      rr[others[0]] = 0.25 * w * Math.sin(1.3 + t * 2) + 4 * gauss();
      rr[others[1]] = -0.12 * w + 4 * gauss();
      for (let i = 0; i < 3; i++) rr[i] += 6 * Math.sin(2 * Math.PI * 9 * t + i) + 2 * gauss();
      pitch += w * 0.016;
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: yaw, beta: pitch, gamma: 0 }));
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
        rotationRate: { alpha: rr[0], beta: rr[1], gamma: rr[2] },
        acceleration: { x: 0.2 * gauss(), y: w / 120, z: Math.abs(w) / 90 },
        accelerationIncludingGravity: { x: 0, y: 9.8, z: 0 }, interval: 16,
      }));
    };
    const tick = () => sleep(16 + (rnd() - 0.5) * 6);
    const pe = (type) => bail.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch' }));
    window.__swinging = true; // pause the idle generator: a real phone has one event stream
    for (let i = 0; i < 8; i++) { fire(0); await tick(); }
    let released = false;
    if (o.button) { pe('pointerdown'); for (let i = 0; i < 4; i++) { fire(0); await tick(); } }
    // backswing ~330 ms
    const backN = 20;
    for (let i = 0; i < backN; i++) {
      fire(o.backW * Math.sin((Math.PI * (i + 0.5)) / backN));
      if (o.button && o.releaseAfterPeakMs === 'back' && i === backN - 6) { pe('pointerup'); released = true; }
      await tick();
    }
    for (let i = 0; i < 4; i++) { fire(0); await tick(); } // pause at the top ~65 ms
    // forward flick ~200 ms, aim turns during the stroke
    const fwdN = 12, peakIdx = 6;
    const relIdx = typeof o.releaseAfterPeakMs === 'number' ? peakIdx + Math.round(o.releaseAfterPeakMs / 16) : -99;
    for (let i = 0; i < fwdN + 30; i++) {
      const u = i / fwdN;
      let w = 0;
      if (!o.noFlick) w = i < fwdN ? -o.peakW * Math.sin(Math.PI * u) : i < fwdN + 8 ? o.peakW * 0.22 * Math.sin((Math.PI * (i - fwdN)) / 8) : 0; // rebound
      yaw = 40 - o.aimDeg * Math.min(1, u * 1.3);
      fire(w);
      if (o.button && !released && i >= relIdx && relIdx > -99) { pe('pointerup'); released = true; }
      await tick();
    }
    if (o.button && !released) pe('pointerup');
    for (let i = 0; i < 10; i++) { fire(0); await tick(); }
    window.__swinging = false;
    return true;
  }, { peakW, backW, axis, sign, button, releaseAfterPeakMs, aimDeg, seed, noFlick });
}

/** Keep idle motion events flowing so the pad looks alive (like a real phone at rest). */
export async function padIdleMotion(page) {
  await page.evaluate(() => {
    if (window.__idle) return;
    window.__idle = setInterval(() => {
      if (window.__swinging) return;
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: 0, beta: 0, gamma: 0 }, acceleration: { x: 0, y: 0, z: 0 }, interval: 16 }));
    }, 16);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };
export const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : NaN; };
