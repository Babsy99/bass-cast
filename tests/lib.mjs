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

/** Inject a synthetic swing on the pad page: devicemotion/deviceorientation at 60 Hz plus real touch on the bail button. */
export async function padSwing(page, { peakW = 1000, backW = 420, releaseAfterPeakMs = 30, aimDeg = 0 } = {}) {
  return page.evaluate(async (o) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const bail = document.querySelector('#bail');
    const fire = (rb, alpha, beta) => {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha, beta, gamma: 0 }));
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
        rotationRate: { alpha: 0, beta: rb, gamma: 0 },
        acceleration: { x: 0, y: rb / 120, z: Math.abs(rb) / 90 },
        accelerationIncludingGravity: { x: 0, y: 9.8, z: 0 }, interval: 16,
      }));
    };
    const pe = (type) => bail.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch' }));
    const alpha0 = 40;
    let beta = 70;
    window.__swinging = true; // pause the idle-motion generator: a real phone has one event stream
    // idle frames
    for (let i = 0; i < 6; i++) { fire(0, alpha0, beta); await sleep(16); }
    pe('pointerdown');
    for (let i = 0; i < 4; i++) { fire(0, alpha0, beta); await sleep(16); }
    // backswing ~250 ms (positive pitch rate = top of phone tilts back toward the user)
    const backN = 15;
    for (let i = 0; i < backN; i++) { const rb = o.backW * Math.sin((Math.PI * (i + 0.5)) / backN); beta += rb * 0.016; fire(rb, alpha0, beta); await sleep(16); }
    // forward whip ~220 ms, aim turns during the stroke
    const fwdN = 14; let tPeak = 0;
    const releaseAt = { done: false };
    const peakIdx = Math.floor(fwdN / 2);
    const relIdx = Math.max(1, peakIdx + Math.round(o.releaseAfterPeakMs / 16));
    for (let i = 0; i < fwdN + 18; i++) {
      const u = i / fwdN;
      const rb = i < fwdN ? -o.peakW * Math.sin(Math.PI * u) : -o.peakW * 0.05 * Math.exp(-(i - fwdN) / 3);
      beta += rb * 0.016;
      const yaw = alpha0 - o.aimDeg * Math.min(1, u * 1.3);
      fire(rb, yaw, beta);
      if (i === peakIdx) tPeak = performance.now();
      if (!releaseAt.done && i >= relIdx) { pe('pointerup'); releaseAt.done = true; }
      await sleep(16);
    }
    if (!releaseAt.done) pe('pointerup');
    for (let i = 0; i < 10; i++) { fire(0, alpha0 - o.aimDeg, beta); await sleep(16); }
    window.__swinging = false;
    return true;
  }, { peakW, backW, releaseAfterPeakMs, aimDeg });
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
