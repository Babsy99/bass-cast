import './ui.css';
import qrcode from 'qrcode-generator';
import { createRenderer } from './scene';
import { Game } from './game';
import { HostLink } from './host-link';
import { MotionSource, requestMotionPermission } from '../../shared/sensors';
import { nowMs } from '../../shared/protocol';

const $ = (s: string) => document.querySelector(s) as HTMLElement;

const PAD_URL_PUBLIC = 'https://babsy99.github.io/bass-cast/';

function padBase(): string {
  const q = new URLSearchParams(location.search).get('pad');
  if (q) return q;
  const env = import.meta.env.VITE_PAD_URL as string | undefined;
  if (env) return env;
  // Production (Tauri app / vite build): the hosted controller page.
  if (import.meta.env.PROD) return PAD_URL_PUBLIC;
  // Dev default: the pad dev server on the same host.
  return `${location.protocol === 'https:' ? 'https' : 'http'}://${location.hostname || '127.0.0.1'}:5174/`;
}

function drawQr(text: string) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const c = $('#qr') as unknown as HTMLCanvasElement;
  const quiet = 3, px = Math.floor(320 / (n + quiet * 2));
  c.width = c.height = px * (n + quiet * 2);
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#0b1a14';
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) g.fillRect((k + quiet) * px, (r + quiet) * px, px, px);
}

async function boot() {
  if (!globalThis.crypto?.subtle) { // session codes, HMAC and AES-GCM all need WebCrypto (secure context)
    $('#fatal').hidden = false; $('#fatal').textContent = 'WebCrypto is unavailable here (not a secure context), so pairing cannot be secured.'; return;
  }
  const canvas = $('#c') as unknown as HTMLCanvasElement;
  let rend;
  try { rend = await createRenderer(canvas); }
  catch (e) { $('#fatal').hidden = false; $('#fatal').textContent = 'No WebGPU or WebGL2 available: ' + (e as Error).message; return; }
  const { renderer, info } = rend;
  console.info('[renderer]', info.kind, '-', info.reason);
  const solo = new URLSearchParams(location.search).has('solo');
  let link: HostLink | null = null;
  if (!solo) link = new HostLink();
  const game = new Game(renderer, info, link, canvas);
  (window as any).__game = game;
  (window as any).__link = link;

  if (link) {
    await link.start();
    const showQr = () => {
      const url = link!.padUrl(padBase());
      drawQr(url);
      $('#sessTag').textContent = link!.ids.tag;
      $('#padHost').textContent = new URL(url).host;
      link!.markQrShown();
      game.qrShown();
      game.renderQr();
      (window as any).__padUrl = url;
    };
    const origNew = link.newSession.bind(link);
    link.newSession = async () => { await origNew(); showQr(); };
    // Setup + first-run instructions come BEFORE the QR (reading time is not pairing time). The pairing
    // clock and the code's TTL start when "Show QR" is pressed. A reload of an already-paired session skips it.
    // Also skipped after an in-tab reload (e.g. the WebGPU->WebGL2 fallback reload) once it was read.
    const already = !!link.pad || link.codeUsed || sessionStorage.getItem('bcs.setupDone') === '1' || new URLSearchParams(location.search).has('noSetup');
    const go = () => { sessionStorage.setItem('bcs.setupDone', '1'); $('#setup').hidden = true; $('#qrCard').hidden = false; showQr(); };
    if (already) go();
    else {
      $('#setup').hidden = false;
      $('#btnShowQrNow').onclick = () => { game.sfx.unlock(); go(); };
    }
    game.renderStatus();
    game.renderPass();
  } else {
    // Solo fallback: phone runs game + controller in one page.
    document.body.classList.add('solo');
    $('#qrCard').hidden = true;
    const src = new MotionSource((f) => {
      game.det.feed({ ...f, th: f.tPad });
      game.scene.liveBeta = f.ori[1];
    });
    $('#soloStart').hidden = false;
    $('#soloStart').onclick = async () => {
      const r = await requestMotionPermission();
      game.sfx.unlock();
      if (!r.ok) { $('#soloStart').textContent = `Motion blocked (${r.detail}). Using touch-cast — drag back, flick up.`; game.setTouchMode(true, false); return; }
      src.start();
      $('#soloStart').hidden = true; $('#soloBail').hidden = false;
      game.qrShown();
    };
    const bail = $('#soloBail');
    bail.addEventListener('pointerdown', (e) => { e.preventDefault(); src.bail = true; game.det.bail(true, nowMs(), src.orientation); navigator.vibrate?.(10); });
    const up = () => { if (!src.bail) return; src.bail = false; game.det.bail(false, nowMs()); setTimeout(() => game.det.releaseTimeout(), 600); };
    bail.addEventListener('pointerup', up); bail.addEventListener('pointercancel', up);
  }
}

boot();
