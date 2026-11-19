// Bass Cast spike — host game: ties link, cast detection, lake scene, logs, test modes and pass criteria.
import { LakeScene, type RendererInfo } from './scene';
import { CastDetector, simulate, type CastParams, type Trajectory, timingOf, DEFAULT_CAL } from './cast';
import { Sfx } from './audio';
import type { HostLink } from './host-link';
import { nowMs, type Msg, type Path } from '../../shared/protocol';
import { median, percentile, round1 } from '../../shared/stats';
import { TouchCaster } from '../../shared/touchcast';
import type * as THREE from 'three/webgpu';

export const PASS = { pairingS: 10, reconnectS: 5, lagMedianMs: 100, lagP95Ms: 150, goodCasts: 8, landTolPct: 15, aimConeDeg: 6 };

export interface CastRow {
  i: number; at: string; source: 'motion' | 'touch'; mode: string; path: Path | 'local';
  power: number; aimDeg: number; releaseDtMs: number; timing: string; peakW: number; peakAcc: number; backPeak: number;
  launchDeg: number; speedMs: number; distFt: number; landAimDeg: number;
  intendedFt?: number; intendedAimDeg?: number; landErrPct?: number; aimErrDeg?: number; good?: boolean;
  calibrated: boolean; cal: { wMin: number; wMax: number; backSign: number; peak?: number };
}

export interface LagRow {
  i: number; path: Path | 'local'; source: string;
  t_flick_phone: number; t_flick_host: number; t_detect_host: number; detect_lag_ms: number; t_cast_start_host: number; lag_ms: number;
  t_release_host: number; t_launch_host: number; release_lag_ms: number;
  clock_offset_ms: number; sync_best_rtt_ms: number | null;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const fmt = (x: number, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '–');

function download(name: string, obj: unknown) {
  const txt = JSON.stringify(obj, null, 2);
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  } catch { /* ignore */ }
  // Also show it (WKWebView in a packaged app may ignore <a download>).
  const dlg = $('#exportDlg');
  ($('#exportTxt') as HTMLTextAreaElement).value = txt;
  $('#exportName').textContent = name;
  dlg.hidden = false;
}

export class Game {
  scene: LakeScene;
  det: CastDetector;
  sfx = new Sfx();
  casts: CastRow[] = [];
  lag: LagRow[] = [];
  mode: 'free' | 'test10' | 'lat50' = 'free';
  test: { n: number; good: number; target: { ft: number; aim: number } | null; rows: CastRow[] } = { n: 0, good: 0, target: null, rows: [] };
  latRun: { rows: LagRow[]; path: string; startedAt: string } | null = null;
  touchMode = false;
  calibrateNext = false;
  firstCastDone = false;
  pairingClock = { startAt: 0, stopAt: 0, ms: NaN, log: [] as { at: string; ms: number; session: string }[] };
  private pendingFlick: { tFlickHost: number; tFlickPad: number; path: Path | 'local'; tDetect: number } | null = null;
  private pendingLag: Partial<LagRow> | null = null;
  private lastPath: Path | 'local' = 'local';
  private frames = 0;
  private fps = 0;
  private fpsAcc = { n: 0, t: 0 };
  private resScale = 1;
  private lowFor = 0;
  private highFor = 0;
  private lastT = 0;
  private toastTimer = 0;
  private framesRx = 0;
  private framesRxRate = 0;
  lastCast: CastRow | null = null;

  constructor(private renderer: THREE.WebGPURenderer, private info: RendererInfo, private link: HostLink | null, private canvas: HTMLCanvasElement) {
    this.scene = new LakeScene(renderer, innerWidth / innerHeight);
    this.det = new CastDetector({
      onArm: () => { this.sfx.click(); this.scene.armRod(); this.haptic('tick'); },
      onBack: () => this.scene.backRod(),
      onWhip: (tFlickHost) => this.onWhip(tFlickHost),
      onCast: (p) => this.onCast(p),
      onCancel: (why) => { this.toast(`Cast cancelled: ${why}`); this.pendingFlick = null; },
    });
    try { const c = JSON.parse(localStorage.getItem('bcs.cal') || 'null'); if (c?.wMax) { this.det.cal = { ...DEFAULT_CAL, ...c }; this.det.calibrated = true; } } catch { /* ignore */ }
    this.scene.onLand = (t) => this.onLand(t);
    addEventListener('resize', () => this.resize());
    this.resize();
    this.bindUi();
    new TouchCaster(canvas, nowMs, (r) => {
      if (!this.touchMode) return;
      this.onWhip(r.tFlick, r.tFlick, 'local', 'touch');
      this.launchFrom({ source: 'touch', power: r.power, aim: r.aim, dt: r.dt, peakW: r.peakV, peakAcc: 0, backPeak: 0, noBackswing: false, tFlickHost: r.tFlick, tReleaseHost: r.tRel, timing: timingOf(r.dt), calibrated: false }, 'local');
    }, () => this.sfx.unlock());
    addEventListener('pointerdown', () => this.sfx.unlock());
    addEventListener('keydown', (e) => {
      this.sfx.unlock();
      if (e.key === 'd') this.toggle('#debug');
      if (e.key === 'p') this.toggle('#panel');
    });
    if (link) this.wireLink(link);
    requestAnimationFrame((t) => this.loop(t));
    setInterval(() => { this.framesRxRate = this.framesRx; this.framesRx = 0; }, 1000);
  }

  // ---------------- link ----------------
  private wireLink(link: HostLink) {
    link.onFrame = (f, th, path) => {
      this.framesRx++;
      this.lastPath = path;
      this.lastOriV = f.ori;
      this.det.feed({ ...f, th });
      this.scene.liveBeta = f.ori[1];
      // Fallback for a lost bail event: frame flag edges also drive the bail.
      if (f.bail && this.det.state === 'idle' && !this.bailFromEvt && th > this.lastBailTh + 80) { this.lastBailTh = th; this.det.bail(true, th, f.ori); }
    };
    link.onMsg = (m: Msg, path) => this.onPadMsg(m, path);
    link.onChange = () => this.renderStatus();
    link.onPaired = (first) => {
      if (first) {
        this.toast('Controller connected. Grip the phone firmly!', 3500);
        $('#grip').hidden = this.firstCastDone;
        this.link?.send({ t: 'mode', touch: this.touchMode });
      }
      this.renderQr();
    };
    link.onRejected = (why) => this.toast(`A second phone tried to join with this code (${why}) — rejected.`, 4000);
  }

  private bailFromEvt = false;
  private lastBailTh = 0;
  private onPadMsg(m: Msg, path: Path) {
    if (m.t === 'bail') {
      const th = this.link!.clock.toHost(m.tp);
      this.bailFromEvt = !!m.d;
      this.lastBailTh = th;
      if (m.d) this.det.bail(true, th, this.lastOri());
      else {
        // Events and frames travel on different channels: the detector keeps reading frames after the
        // release event until the stroke peak is confirmed (early release), max 160 ms.
        this.det.bail(false, th);
        setTimeout(() => this.det.releaseTimeout(), 600); // safety net if frames stop
      }
    } else if (m.t === 'tcast') {
      const c = this.link!.clock;
      this.onWhip(c.toHost(m.tFlick), m.tFlick, path, 'touch');
      this.launchFrom({ source: 'touch', power: m.power, aim: m.aim, dt: m.dt, peakW: 0, peakAcc: 0, backPeak: 0, noBackswing: false, tFlickHost: c.toHost(m.tFlick), tReleaseHost: c.toHost(m.tRel), timing: timingOf(m.dt), calibrated: false }, path);
    } else if (m.t === 'pause') {
      this.det.cancel('controller paused');
      this.bailFromEvt = false;
      $('#paused').hidden = false;
    } else if (m.t === 'resume') {
      $('#paused').hidden = true;
    } else if (m.t === 'mode') {
      this.setTouchMode(m.touch, false);
    }
  }

  private lastOriV: [number, number, number] | undefined;
  private lastOri(): [number, number, number] | undefined { return this.lastOriV; }

  private haptic(p: 'tick' | 'thunk' | 'buzz' | 'double') { this.link?.send({ t: 'hap', p }); }

  // ---------------- casting ----------------
  /** Rod whip starts on screen at the next rendered frame; that frame time is t_cast_start_host. */
  private onWhip(tFlickHost: number, tFlickPad?: number, path?: Path | 'local', _src = 'motion') {
    this.scene.whip();
    this.sfx.whoosh(0.6);
    const off = this.link?.clock.offset ?? 0;
    this.pendingFlick = { tFlickHost, tFlickPad: tFlickPad ?? tFlickHost + off, path: path ?? this.lastPath, tDetect: nowMs() };
    this.wantWhipStamp = true;
  }
  private wantWhipStamp = false;
  private wantLaunchStamp = false;

  private onCast(p: CastParams) { this.launchFrom(p, this.lastPath); }

  private launchFrom(p: CastParams, path: Path | 'local') {
    let power = p.power;
    if (!this.firstCastDone && p.source === 'motion' && !this.det.calibrated) power = p.power; // default curve
    const traj = simulate({ power, dt: p.dt, aim: p.aim });
    this.scene.launch(traj, performance.now() / 1000);
    this.sfx.zing(traj.flightS);
    this.haptic('thunk');
    const lagBase = this.pendingFlick;
    this.pendingLag = {
      path, source: p.source,
      t_flick_phone: lagBase ? round1(lagBase.tFlickPad) : NaN,
      t_flick_host: round1(p.tFlickHost),
      t_detect_host: lagBase ? round1(lagBase.tDetect) : NaN,
      t_release_host: round1(p.tReleaseHost),
      clock_offset_ms: round1(this.link?.clock.offset ?? 0),
      sync_best_rtt_ms: this.link?.clock.history.at(-1)?.bestRtt ?? null,
    };
    if (this.whipStampAt) { this.pendingLag.t_cast_start_host = round1(this.whipStampAt); this.whipStampAt = 0; }
    this.wantLaunchStamp = true;
    this.pendingParams = { p, traj, path };
    if (this.pairingClock.startAt && !this.pairingClock.stopAt) {
      this.pairingClock.stopAt = Date.now();
      this.pairingClock.ms = this.pairingClock.stopAt - this.pairingClock.startAt;
      this.pairingClock.log.push({ at: new Date().toISOString(), ms: this.pairingClock.ms, session: this.link?.ids.tag ?? 'solo' });
      console.info('[pairing] QR shown -> first cast', this.pairingClock.ms, 'ms');
    }
    if (this.calibrateNext && p.source === 'motion') {
      if (this.det.calibrateFrom(p)) { localStorage.setItem('bcs.cal', JSON.stringify(this.det.cal)); this.toast(`Calibrated: this swing (${Math.round(p.peakW)}°/s) = 80% power`); }
      this.calibrateNext = false; $('#calOffer').hidden = true;
    }
  }
  private whipStampAt = 0;
  private pendingParams: { p: CastParams; traj: Trajectory; path: Path | 'local' } | null = null;

  private onLand(t: Trajectory) {
    this.sfx.splash(Math.min(1, t.speed / 30));
    this.haptic('buzz');
    const pp = this.pendingParams; if (!pp) return;
    const { p, path } = pp;
    const row: CastRow = {
      i: this.casts.length + 1, at: new Date().toISOString(), source: p.source, mode: this.mode, path,
      power: round1(p.power * 100) / 100, aimDeg: round1(p.aim), releaseDtMs: Math.round(p.dt), timing: p.timing,
      peakW: Math.round(p.peakW), peakAcc: round1(p.peakAcc), backPeak: Math.round(p.backPeak),
      launchDeg: round1(t.launchDeg), speedMs: round1(t.speed), distFt: round1(t.distFt), landAimDeg: round1(t.landAimDeg),
      calibrated: this.det.calibrated, cal: { ...this.det.cal },
    };
    if (this.mode === 'test10' && this.test.target) {
      const tg = this.test.target;
      row.intendedFt = tg.ft; row.intendedAimDeg = tg.aim;
      row.landErrPct = round1((Math.abs(t.distFt - tg.ft) / tg.ft) * 100);
      row.aimErrDeg = round1(Math.abs(t.landAimDeg - tg.aim));
      row.good = row.landErrPct <= PASS.landTolPct && row.aimErrDeg <= PASS.aimConeDeg;
      this.test.n++; if (row.good) this.test.good++;
      this.test.rows.push(row);
      row.good ? this.sfx.good() : this.sfx.bad();
      if (row.good) this.haptic('double');
      if (this.test.n >= 10) { this.toast(`Test done: ${this.test.good}/10 good casts ${this.test.good >= PASS.goodCasts ? '✅ PASS' : '❌'}`, 6000); this.test.target = null; this.scene.showTarget(null); }
      else this.nextTarget();
    }
    this.casts.push(row);
    this.lastCast = row;
    $('#dist').textContent = `${Math.round(t.distFt)} ft`;
    $('#distSub').textContent = `${p.timing === 'good' ? 'clean release' : p.timing === 'early' ? 'early release – lobbed' : 'late release – slapped'} · power ${Math.round(p.power * 100)}% · aim ${p.aim >= 0 ? '+' : ''}${p.aim.toFixed(0)}°` + (row.good === undefined ? '' : row.good ? ' · ✅ good' : ` · ❌ ${row.landErrPct}% off`);
    if (!this.firstCastDone) {
      this.firstCastDone = true;
      $('#grip').hidden = true;
      if (!this.det.calibrated && p.source === 'motion') $('#calOffer').hidden = false;
    }
    this.renderLog();
    this.renderPass();
  }

  private nextTarget() {
    const ft = Math.round(50 + Math.random() * 70);
    const aim = Math.round((Math.random() - 0.5) * 24);
    this.test.target = { ft, aim };
    this.scene.showTarget(ft, aim, PASS.landTolPct / 100);
    $('#testInfo').textContent = `Test 10 casts: cast ${this.test.n + 1}/10 → target ${ft} ft, ${aim >= 0 ? '+' : ''}${aim}° · score ${this.test.good}/${this.test.n}`;
  }

  startTest10() {
    this.mode = 'test10'; this.test = { n: 0, good: 0, target: null, rows: [] };
    this.nextTarget();
    $('#testInfo').hidden = false;
  }

  startLat50() {
    this.mode = 'lat50';
    this.latRun = { rows: [], path: String(this.link?.path ?? 'local'), startedAt: new Date().toISOString() };
    $('#testInfo').hidden = false;
    $('#testInfo').textContent = 'Latency test: make 50 casts (0/50)';
  }

  setTouchMode(on: boolean, tellPad = true) {
    this.touchMode = on;
    ($('#touchToggle') as HTMLInputElement).checked = on;
    if (tellPad) this.link?.send({ t: 'mode', touch: on });
    this.toast(on ? 'Touch-cast on: drag back, flick forward, let go' : 'Motion casting on');
  }

  // ---------------- loop ----------------
  private loop(tMs: number) {
    const nowS = tMs / 1000;
    const dt = this.lastT ? Math.min(0.1, nowS - this.lastT) : 1 / 60;
    this.lastT = nowS;
    const frameHost = performance.timeOrigin + tMs;
    if (this.wantWhipStamp) { this.wantWhipStamp = false; this.whipStampAt = frameHost; this.commitLagIfReady(); }
    if (this.wantLaunchStamp) {
      this.wantLaunchStamp = false;
      if (this.pendingLag) {
        this.pendingLag.t_launch_host = round1(frameHost);
        if (this.pendingLag.t_cast_start_host === undefined && this.whipStampAt) { this.pendingLag.t_cast_start_host = round1(this.whipStampAt); this.whipStampAt = 0; }
        if (this.pendingLag.t_cast_start_host === undefined) this.pendingLag.t_cast_start_host = round1(frameHost);
        this.commitLagIfReady();
      }
    }
    this.scene.update(nowS, dt);
    this.scene.render();
    // fps + dynamic resolution
    this.fpsAcc.n++; this.fpsAcc.t += dt;
    if (this.fpsAcc.t >= 0.5) {
      this.fps = this.fpsAcc.n / this.fpsAcc.t; this.fpsAcc = { n: 0, t: 0 };
      if (this.fps < 50) { this.lowFor++; this.highFor = 0; } else if (this.fps > 58) { this.highFor++; this.lowFor = 0; }
      if (this.lowFor >= 4 && this.resScale > 0.6) { this.resScale = Math.max(0.6, this.resScale - 0.1); this.lowFor = 0; this.resize(); }
      if (this.highFor >= 10 && this.resScale < 1) { this.resScale = Math.min(1, this.resScale + 0.1); this.highFor = 0; this.resize(); }
      $('#fps').textContent = `${this.fps.toFixed(0)} fps · ${this.info.kind} · ${Math.round(this.resScale * 100)}% res`;
      $('#fps').title = this.info.reason;
      this.renderStatus();
    }
    if (this.pairingClock.startAt && !this.pairingClock.stopAt) $('#pairClock').textContent = ((Date.now() - this.pairingClock.startAt) / 1000).toFixed(1) + ' s';
    if (!$('#debug').hidden) this.renderDebug();
    this.frames++;
    requestAnimationFrame((t) => this.loop(t));
  }

  private commitLagIfReady() {
    const L = this.pendingLag;
    if (!L || L.t_cast_start_host === undefined || L.t_launch_host === undefined) return;
    const row: LagRow = {
      i: this.lag.length + 1, path: L.path!, source: L.source!,
      t_flick_phone: L.t_flick_phone!, t_flick_host: L.t_flick_host!, t_detect_host: L.t_detect_host!,
      detect_lag_ms: round1(L.t_detect_host! - L.t_flick_host!), t_cast_start_host: L.t_cast_start_host,
      lag_ms: round1(L.t_cast_start_host - L.t_flick_host!),
      t_release_host: L.t_release_host!, t_launch_host: L.t_launch_host, release_lag_ms: round1(L.t_launch_host - L.t_release_host!),
      clock_offset_ms: L.clock_offset_ms!, sync_best_rtt_ms: L.sync_best_rtt_ms ?? null,
    };
    this.pendingLag = null; this.pendingFlick = null;
    this.lag.push(row);
    if (this.mode === 'lat50' && this.latRun) {
      this.latRun.rows.push(row);
      $('#testInfo').textContent = `Latency test: ${this.latRun.rows.length}/50 casts · median ${fmt(median(this.latRun.rows.map((r) => r.lag_ms)))} ms`;
      if (this.latRun.rows.length >= 50) { this.toast('Latency test done — export it from the panel', 5000); this.mode = 'free'; }
    }
    this.renderPass();
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2) * this.resScale;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.scene.resize(innerWidth, innerHeight);
  }

  // ---------------- UI ----------------
  toast(s: string, ms = 2500) {
    const t = $('#toast'); t.textContent = s; t.hidden = false;
    clearTimeout(this.toastTimer); this.toastTimer = window.setTimeout(() => (t.hidden = true), ms);
  }
  private toggle(sel: string) { const e = $(sel); e.hidden = !e.hidden; }

  private bindUi() {
    $('#btnPanel').onclick = () => this.toggle('#panel');
    $('#btnDebug').onclick = () => this.toggle('#debug');
    $('#btnTest10').onclick = () => this.startTest10();
    $('#btnLat50').onclick = () => this.startLat50();
    $('#btnExportCasts').onclick = () => download(`basscast-casts-${Date.now()}.json`, this.exportCasts());
    $('#btnExportLat').onclick = () => download(`basscast-latency-${Date.now()}.json`, this.exportLatency());
    $('#btnCal').onclick = () => { this.calibrateNext = true; this.toast('Calibration: make one comfortable full cast'); };
    $('#calYes').onclick = () => { this.calibrateNext = true; $('#calOffer').hidden = true; this.toast('Make one comfortable full cast'); };
    $('#calNo').onclick = () => { $('#calOffer').hidden = true; };
    $('#btnNewSession').onclick = async () => { await this.link?.newSession(); this.pairingClock.startAt = 0; this.pairingClock.stopAt = 0; this.renderQr(); };
    $('#btnShowQr').onclick = () => { $('#qrCard').hidden = !$('#qrCard').hidden; };
    ($('#touchToggle') as HTMLInputElement).onchange = (e) => this.setTouchMode((e.target as HTMLInputElement).checked);
    $('#exportClose').onclick = () => ($('#exportDlg').hidden = true);
    $('#exportCopy').onclick = () => { void navigator.clipboard?.writeText(($('#exportTxt') as HTMLTextAreaElement).value); };
  }

  /** Called by main after the QR is drawn. */
  qrShown() {
    if (!this.pairingClock.startAt) { this.pairingClock.startAt = Date.now(); this.pairingClock.stopAt = 0; }
  }

  renderQr() {
    const l = this.link; if (!l) return;
    const paired = !!l.pad;
    $('#qrCard').hidden = paired;
    $('#btnShowQr').hidden = !paired;
  }

  renderStatus() {
    const l = this.link; if (!l) return;
    const pill = $('#pill');
    const st = l.status;
    const label: Record<string, string> = { starting: 'Starting…', waiting: 'Waiting for phone', paired: 'Controller connected', paused: 'Controller paused', lost: 'Reconnecting…' };
    pill.className = 'hud pill ' + st;
    const pathLbl = l.path ? ({ direct: 'direct', 'relay-p2p': 'relay-p2p', 'mqtt-relay': 'MQTT relay' } as const)[l.path] : '—';
    pill.innerHTML = `<b>${label[st]}</b><span>path: ${st === 'paired' ? pathLbl : '—'}</span><span>RTT/2 ${fmt(l.rttHalf, 0)} ms</span><span>age ${fmt(l.deliveryAge, 0)} ms</span>`;
    $('#brokerState').textContent = l.brokerOk ? 'signaling ok' : 'signaling…';
    $('#paused').hidden = st !== 'paused';
  }

  private renderDebug() {
    const d = this.det;
    $('#debug').textContent =
      `state ${d.state}\nω pitch ${d.live.w.toFixed(0)}°/s\npeak back ${d.peaks.back.toFixed(0)} fwd ${d.peaks.fwd.toFixed(0)}°/s\n` +
      `|acc| ${d.live.acc.toFixed(1)} peak ${d.peaks.acc.toFixed(1)} m/s²\nyaw Δ ${d.live.yaw.toFixed(1)}°  beta ${d.live.beta.toFixed(0)}°\n` +
      `frames rx ${this.framesRxRate}/s\noffset ${fmt(this.link?.clock.offset ?? 0, 1)} ms\ncal wMax ${d.cal.wMax}${d.calibrated ? ' (calibrated)' : ' (default)'}`;
  }

  private renderLog() {
    const rows = this.casts.slice(-10).reverse();
    $('#castLog').innerHTML = '<tr><th>#</th><th>src</th><th>pow</th><th>aim</th><th>rel ms</th><th>ft</th><th></th></tr>' +
      rows.map((r) => `<tr><td>${r.i}</td><td>${r.source[0]}</td><td>${Math.round(r.power * 100)}</td><td>${r.aimDeg}</td><td>${r.releaseDtMs}</td><td>${Math.round(r.distFt)}</td><td>${r.good === undefined ? '' : r.good ? '✅' : '❌'}</td></tr>`).join('');
  }

  lagStats(rows = this.lag) {
    const xs = rows.map((r) => r.lag_ms).filter(Number.isFinite);
    const rel = rows.map((r) => r.release_lag_ms).filter(Number.isFinite);
    const det = rows.map((r) => r.detect_lag_ms).filter(Number.isFinite);
    return { n: xs.length, median: round1(median(xs)), p95: round1(percentile(xs, 95)), detectMedian: round1(median(det)), detectP95: round1(percentile(det, 95)), releaseMedian: round1(median(rel)), releaseP95: round1(percentile(rel, 95)), hostFps: round1(this.fps) };
  }

  renderPass() {
    const l = this.link;
    const pc = this.pairingClock.ms / 1000;
    const rc = l?.reconnects.at(-1);
    const rcS = rc ? (rc.padReconnectMs ?? rc.hostGapMs) / 1000 : NaN;
    const s = this.lagStats(this.latRun?.rows.length ? this.latRun.rows : this.lag);
    const row = (ok: boolean | null, label: string, val: string) => `<li class="${ok === null ? 'na' : ok ? 'ok' : 'bad'}">${ok === null ? '–' : ok ? '✓' : '✗'} ${label} <b>${val}</b></li>`;
    $('#pass').innerHTML =
      row(Number.isFinite(pc) ? pc <= PASS.pairingS : null, `Pairing ≤${PASS.pairingS} s`, Number.isFinite(pc) ? pc.toFixed(1) + ' s' : '–') +
      row(Number.isFinite(rcS) ? rcS <= PASS.reconnectS : null, `Reconnect ≤${PASS.reconnectS} s`, Number.isFinite(rcS) ? rcS.toFixed(1) + ' s' : '–') +
      row(s.n ? s.median <= PASS.lagMedianMs : null, `Median lag ≤${PASS.lagMedianMs} ms`, s.n ? `${s.median} ms (n=${s.n})` : '–') +
      row(s.n ? s.p95 <= PASS.lagP95Ms : null, `p95 lag ≤${PASS.lagP95Ms} ms`, s.n ? `${s.p95} ms` : '–') +
      row(this.test.n >= 10 ? this.test.good >= PASS.goodCasts : null, `Cast test ≥${PASS.goodCasts}/10`, this.test.n ? `${this.test.good}/${this.test.n}` : '–');
  }

  exportCasts() {
    return {
      app: 'Bass Cast spike', kind: 'cast-log', exportedAt: new Date().toISOString(), renderer: this.info,
      goodRule: { landErrPctMax: PASS.landTolPct, aimConeDeg: PASS.aimConeDeg },
      calibration: { calibrated: this.det.calibrated, ...this.det.cal },
      test10: { attempts: this.test.n, good: this.test.good, rows: this.test.rows },
      casts: this.casts,
    };
  }

  exportLatency() {
    const l = this.link;
    const runRows = this.latRun?.rows ?? [];
    const ages = l?.ageLog.map((a) => a.age) ?? [];
    return {
      app: 'Bass Cast spike', kind: 'latency-log', exportedAt: new Date().toISOString(),
      method: {
        clock: 'NTP-style: host sends ping(h0); pad replies with its clock p1; host receives at h3. offset=p1-(h0+h3)/2. ' +
          'Burst of 10 samples at connect and every 10 s; keep the 5 lowest-RTT samples; offset = median of those.',
        lag: 'lag_ms = t_cast_start_host - t_flick_host. t_flick_phone is the phone timestamp of peak forward pitch angular velocity; ' +
          't_flick_host = t_flick_phone - offset. t_detect_host = when the host detector confirmed the peak (transport + detection, before rendering). t_cast_start_host is the host requestAnimationFrame timestamp of the first rendered frame showing the rod whip. ' +
          'release_lag_ms = first frame with the lure in flight minus bail release (phone time -> host time).',
        clocks: 'performance.timeOrigin + performance.now() on both devices (epoch ms).',
      },
      pass: PASS,
      latencyTest: this.latRun ? { ...this.latRun, stats: this.lagStats(runRows) } : null,
      allCasts: { rows: this.lag, stats: this.lagStats() },
      pairing: { clock: this.pairingClock.log, session: l?.ids.tag },
      reconnects: l?.reconnects ?? [],
      clockSync: l?.clock.history ?? [],
      pingRttHalf: { n: l?.latencyLog.length ?? 0, median: round1(median(l?.latencyLog.map((x) => x.rttHalf) ?? [])), p95: round1(percentile(l?.latencyLog.map((x) => x.rttHalf) ?? [], 95)), samples: l?.latencyLog.slice(-600) ?? [] },
      deliveryAge: { n: ages.length, median: round1(median(ages)), p95: round1(percentile(ages, 95)), samples: l?.ageLog.slice(-600) ?? [] },
      events: l?.events.slice(-200) ?? [],
    };
  }
}
