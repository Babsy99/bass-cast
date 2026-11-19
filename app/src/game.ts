// Bass Cast spike — host game: ties link, cast detection, lake scene, logs, test modes and pass criteria.
import { LakeScene, type RendererInfo } from './scene';
import { CastDetector, simulate, powerForFeet, type CastParams, type Trajectory, timingOf, DEFAULT_POWER, scaledFrom, DET, AXIS_NAMES, type Attempt, type AxisLock, type PowerCal } from './cast';
import { GyroMeter } from '../../shared/gyro-meter';
import { Sfx } from './audio';
import type { HostLink } from './host-link';
import { nowMs, PATH_LABEL, pathKind, type Msg, type Path } from '../../shared/protocol';
import { median, percentile, round1 } from '../../shared/stats';
import { TouchCaster } from '../../shared/touchcast';
import type * as THREE from 'three/webgpu';

export const PASS = { pairingS: 10, reconnectS: 5, lagMedianMs: 100, lagP95Ms: 150, goodCasts: 8, landTolPct: 15, aimConeDeg: 6, maxPeakDps: 500 };
/** Test 10 targets: reachable with a relaxed (<=500 deg/s) swing. */
export const TARGET_FT = { min: 45, max: 110, aimDeg: 12 };

export interface CastRow {
  i: number; at: string; source: 'motion' | 'touch'; mode: string; path: Path | 'local';
  power: number; aimDeg: number; releaseDtMs: number; timing: string; peakW: number; peakAcc: number; backPeak: number;
  launchDeg: number; speedMs: number; distFt: number; landAimDeg: number;
  intendedFt?: number; intendedAimDeg?: number; landErrPct?: number; aimErrDeg?: number; good?: boolean;
  /** Test 10: signed misses (+ = long / right) and plain-English text. */
  missFt?: number; missDeg?: number; missText?: string;
  /** Retest rule: peak gyro on the swing axis (motion only), >500 = too hard; relaxed = the player's 👍/👎. */
  peak_dps: number | null; tooHard: boolean; relaxed?: boolean | null; counts?: boolean;
  link: 'direct' | 'relay' | 'local'; castMode?: string; axis?: string;
  calibrated: boolean; cal: PowerCal;
}

export interface AttemptRow extends Attempt { i: number; at: string; path: Path | 'local'; link: string; power?: number; distFt?: number }

export interface LagRow {
  i: number; path: Path | 'local'; source: string;
  /** direct = phone->Mac WebRTC (LAN or STUN-found addresses, no server in the path); relay = through the MQTT broker. */
  link: 'direct' | 'relay' | 'local'; ice: string | null;
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
  test: { n: number; good: number; target: { ft: number; aim: number } | null; rows: CastRow[]; done: boolean } = { n: 0, good: 0, target: null, rows: [], done: false };
  attempts: AttemptRow[] = [];
  lagProof = false;
  padJoinedAt = 0;
  private meter: GyroMeter | null = null;
  latRun: { rows: LagRow[]; path: string; startedAt: string } | null = null;
  touchMode = false;
  calibrateNext = false;
  firstCastDone = false;
  pairingClock = { startAt: 0, stopAt: 0, ms: NaN, log: [] as { at: string; ms: number; scanToCastMs: number | null; session: string }[] };
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
      onBack: () => { if (!this.touchMode) this.scene.backRod(); },
      onWhip: (tFlickHost) => { if (!this.touchMode) this.onWhip(tFlickHost); },
      onCast: (p) => { if (!this.touchMode) this.onCast(p); },
      onAttempt: (a) => { if (!this.touchMode) this.onAttempt(a); },
      onLearn: (l) => { localStorage.setItem('bcs.axis', JSON.stringify(l)); this.toast(`Learned your swing: ${AXIS_NAMES[l.axis]}, backswing ${l.sign > 0 ? '+' : '−'}`, 3000); this.sendCfg(); this.renderAxisSel(); },
      onScale: (c) => { localStorage.setItem('bcs.power', JSON.stringify(c)); this.sendCfg(); },
    });
    try { const l = JSON.parse(localStorage.getItem('bcs.axis') || 'null') as AxisLock | null; if (l && [0, 1, 2].includes(l.axis)) { if (l.src === 'manual') this.det.override = l; else this.det.lock = l; } } catch { /* ignore */ }
    try { const c = JSON.parse(localStorage.getItem('bcs.power') || 'null') as PowerCal | null; if (c?.wMax) this.det.power = { ...DEFAULT_POWER, ...c }; } catch { /* ignore */ }
    const gm = document.querySelector('#gyro') as HTMLCanvasElement | null;
    if (gm) this.meter = new GyroMeter(gm);
    this.scene.onLand = (t) => this.onLand(t);
    addEventListener('resize', () => this.resize());
    this.resize();
    this.bindUi();
    new TouchCaster(canvas, nowMs, (r) => {
      if (!this.touchMode) return;
      this.onWhip(r.tFlick, r.tFlick, 'local', 'touch');
      this.launchFrom({ source: 'touch', power: r.power, aim: r.aim, dt: r.dt, peakW: 0, peakAcc: 0, backPeak: 0, noBackswing: false, tFlickHost: r.tFlick, tReleaseHost: r.tRel, timing: timingOf(r.dt), calibrated: false }, 'local');
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
      if (f.bail && this.det.phase === 'idle' && !this.bailFromEvt && th > this.lastBailTh + 80) { this.lastBailTh = th; this.det.bail(true, th, f.ori); }
    };
    link.onMsg = (m: Msg, path) => this.onPadMsg(m, path);
    link.onChange = () => this.renderStatus();
    link.onPaired = (first) => {
      if (first) {
        this.padJoinedAt = Date.now();
        this.toast('Controller connected. Hold it upright like a rod handle and just swing.', 3500);
        $('#grip').hidden = this.firstCastDone;
        this.link?.send({ t: 'mode', touch: this.touchMode });
      }
      this.sendCfg();
      if (this.mode === 'test10') this.sendTarget();
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
      this.det.cancel('paused');
      this.bailFromEvt = false;
      $('#paused').hidden = false;
    } else if (m.t === 'resume') {
      $('#paused').hidden = true;
    } else if (m.t === 'mode') {
      this.setTouchMode(m.touch, false);
    } else if (m.t === 'feel') {
      this.answerFeel(m.id, m.ok);
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
    this.whipStampAt = 0; // never reuse a stamp from an earlier (rejected) swing
    this.wantWhipStamp = true;
    if (this.lagProof) this.wantFlash = true;
  }
  private wantWhipStamp = false;
  private wantFlash = false;
  private flashTimer = 0;
  private wantLaunchStamp = false;

  private onCast(p: CastParams) {
    if (this.calibrateNext) {
      // "Re-tune power": this swing = ~65% power (same rule as the silent first-swing auto-scale).
      this.det.power = scaledFrom(p.peakW, { ...DEFAULT_POWER });
      localStorage.setItem('bcs.power', JSON.stringify(this.det.power));
      this.toast(`Power re-tuned: this swing (${Math.round(p.peakW)}°/s) ≈ 65% · max at ${this.det.power.wMax}°/s`, 3500);
      this.calibrateNext = false; this.sendCfg();
      p = { ...p, power: 0.65 * (p.noBackswing ? 0.8 : 1) };
    }
    this.launchFrom(p, this.lastPath);
  }

  /** Every motion attempt (cast or reject) is logged with its reason and raw peaks; rejects coach the player. */
  private onAttempt(a: Attempt) {
    const path = this.lastPath;
    const row: AttemptRow = { ...a, i: this.attempts.length + 1, at: new Date().toISOString(), path, link: pathKind(path) };
    this.attempts.push(row);
    if (this.attempts.length > 2000) this.attempts.splice(0, 500);
    if (!a.ok) {
      const peaks = `back ${a.backPeak} / flick ${a.fwdPeak}°/s`;
      this.toast(`${a.coach}  (${peaks})`, 3500);
      this.sfx.bad();
      this.link?.send({ t: 'coach', ok: false, text: a.coach, peak: a.fwdPeak });
      this.pendingFlick = null; this.whipStampAt = 0; this.wantWhipStamp = false;
    }
    this.renderAttempts();
  }

  private sendCfg() {
    const l = this.det.active;
    this.link?.send({ t: 'cfg', axis: l.axis, sign: l.sign, learned: this.det.learned, back: DET.back, fwd: DET.fwd, wMin: this.det.power.wMin, wMax: this.det.power.wMax, lagProof: this.lagProof });
  }

  private launchFrom(p: CastParams, path: Path | 'local') {
    const power = p.power;
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
      const scanToCastMs = this.padJoinedAt ? Math.max(0, this.pairingClock.stopAt - this.padJoinedAt) : null;
      this.pairingClock.log.push({ at: new Date().toISOString(), ms: this.pairingClock.ms, scanToCastMs, session: this.link?.ids.tag ?? 'solo' });
      console.info('[pairing] QR shown -> first cast', this.pairingClock.ms, 'ms; pad joined -> first cast', scanToCastMs, 'ms');
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
      calibrated: this.det.power.scaled, cal: { ...this.det.power },
      peak_dps: p.source === 'motion' ? Math.round(p.peakW) : null,
      tooHard: p.source === 'motion' && p.peakW > PASS.maxPeakDps,
      link: pathKind(path) as CastRow['link'], castMode: p.mode, axis: p.axis === undefined ? undefined : `${'XYZ'[p.axis]}${(p.sign ?? 1) > 0 ? '+' : '−'}`,
    };
    let missLine = '';
    if (this.mode === 'test10' && this.test.target) {
      const tg = this.test.target;
      row.intendedFt = tg.ft; row.intendedAimDeg = tg.aim;
      row.landErrPct = round1((Math.abs(t.distFt - tg.ft) / tg.ft) * 100);
      row.aimErrDeg = round1(Math.abs(t.landAimDeg - tg.aim));
      row.missFt = Math.round(t.distFt - tg.ft);
      row.missDeg = round1(t.landAimDeg - tg.aim);
      const distOk = row.landErrPct <= PASS.landTolPct, aimOk = row.aimErrDeg <= PASS.aimConeDeg;
      row.good = distOk && aimOk;
      const parts: string[] = [];
      if (!distOk) parts.push(`${row.missFt > 0 ? 'Long' : 'Short'} by ${Math.abs(row.missFt)} ft`);
      if (!aimOk) parts.push(`${row.missDeg > 0 ? 'Right' : 'Left'} by ${Math.abs(Math.round(row.missDeg))}°`);
      row.missText = parts.join(', ');
      row.relaxed = null;
      row.counts = false;
      this.test.n++;
      this.test.rows.push(row);
      row.good && !row.tooHard ? this.sfx.good() : this.sfx.bad();
      if (row.good) this.haptic('double');
      missLine = row.good ? 'on target' : row.missText;
      if (row.tooHard) missLine += " · doesn't count";
      this.askFeel(row);
      if (this.test.n >= 10) { this.test.done = true; this.test.target = null; this.scene.showTarget(null); this.link?.send({ t: 'target', ft: 0 }); }
      else this.nextTarget();
      this.rescore();
    }
    this.casts.push(row);
    this.lastCast = row;
    $('#dist').textContent = `${Math.round(t.distFt)} ft`;
    const peakTxt = row.peak_dps === null ? '' : ` · peak ${row.peak_dps}°/s${row.tooHard ? ' (too hard)' : ''}`;
    $('#distSub').textContent = `${p.timing === 'good' ? 'clean release' : p.timing === 'early' ? 'early release – lobbed' : 'late release – slapped'} · power ${Math.round(p.power * 100)}% · aim ${p.aim >= 0 ? '+' : ''}${p.aim.toFixed(0)}°${peakTxt}` + (row.good === undefined ? '' : row.good ? ' · ✅ on target' : ` · ❌ ${row.missText}`);
    this.link?.send({ t: 'coach', ok: true, text: `${Math.round(t.distFt)} ft · ${Math.round(p.power * 100)}% power${peakTxt}` + (missLine ? ` · ${missLine}` : ''), power: p.power, distFt: t.distFt, peak: row.peak_dps ?? undefined });
    const la = this.attempts.at(-1);
    if (la && la.ok && p.source === 'motion' && la.power === undefined) { la.power = round1(p.power * 100) / 100; la.distFt = round1(t.distFt); }
    if (!this.firstCastDone) {
      this.firstCastDone = true;
      $('#grip').hidden = true;
    }
    this.renderLog();
    this.renderPass();
  }

  private band(ft: number) { const k = PASS.landTolPct / 100; return { lo: Math.round(ft * (1 - k)), hi: Math.round(ft * (1 + k)) }; }

  private nextTarget() {
    const ft = Math.round(TARGET_FT.min + Math.random() * (TARGET_FT.max - TARGET_FT.min));
    const aim = Math.round((Math.random() - 0.5) * 2 * TARGET_FT.aimDeg);
    this.test.target = { ft, aim };
    this.scene.showTarget(ft, aim, PASS.landTolPct / 100);
    this.sendTarget();
    this.renderTestInfo();
  }

  private sendTarget() {
    const tg = this.test.target; if (!tg) return;
    const { lo, hi } = this.band(tg.ft);
    this.link?.send({ t: 'target', ft: tg.ft, lo, hi, pLo: Math.round(powerForFeet(lo) * 1000) / 1000, pHi: Math.round(powerForFeet(hi) * 1000) / 1000 });
  }

  private renderTestInfo() {
    const tg = this.test.target;
    const waiting = this.test.rows.filter((r) => r.good && !r.tooHard && r.relaxed === null).length;
    const score = `score ${this.test.good}/${this.test.n}` + (waiting ? ` (+${waiting} awaiting 👍)` : '');
    const last = this.test.rows.at(-1);
    const lastTxt = last ? ` · last: ${Math.round(last.distFt)} ft${last.peak_dps !== null ? `, ${last.peak_dps}°/s` : ''}${last.good ? ' ✅' : ` ❌ ${last.missText}`}${last.tooHard ? " — too hard, doesn't count" : ''}` : '';
    if (tg) {
      const { lo, hi } = this.band(tg.ft);
      $('#testInfo').innerHTML = `Test 10 · cast ${this.test.n + 1}/10 → <b>target ${tg.ft} ft</b> · good <b>${lo}–${hi} ft</b>, aim ${tg.aim >= 0 ? '+' : ''}${tg.aim}° ±${PASS.aimConeDeg}° · ${score}${lastTxt}`;
    } else if (this.test.done) {
      $('#testInfo').innerHTML = this.testSummaryHtml();
    }
  }

  /** Score = good landing AND (motion: peak <= 500 deg/s) AND the player's 👍. */
  private rescore() {
    for (const r of this.test.rows) r.counts = !!r.good && !r.tooHard && r.relaxed === true;
    this.test.good = this.test.rows.filter((r) => r.counts).length;
    this.renderTestInfo();
    this.renderPass();
    if (this.test.done && !this.test.rows.some((r) => r.relaxed === null)) {
      this.toast(`Test done: ${this.test.good}/10 count ${this.test.good >= PASS.goodCasts ? '✅ PASS' : '❌'}`, 6000);
    }
  }

  testSummaryHtml() {
    const lines = this.test.rows.map((r, k) => {
      const why: string[] = [];
      if (!r.good) why.push(r.missText || 'missed');
      if (r.tooHard) why.push(`${r.peak_dps}°/s too hard, doesn't count`);
      if (r.relaxed === false) why.push('👎 not relaxed');
      if (r.relaxed === null) why.push('awaiting 👍/👎');
      return `<li>${k + 1}. ${r.intendedFt} ft → ${Math.round(r.distFt)} ft${r.peak_dps !== null ? ` · ${r.peak_dps}°/s` : ''} · ${r.counts ? '✅ counts' : '❌ ' + why.join(', ')}</li>`;
    });
    return `<b>Test 10 done: ${this.test.good}/10 count</b> (need ${PASS.goodCasts}; rule: on target, peak ≤${PASS.maxPeakDps}°/s, felt relaxed 👍)<ol style="margin:4px 0 0 0;padding:0;list-style:none">${lines.join('')}</ol>`;
  }

  private askFeel(row: CastRow) {
    this.link?.send({ t: 'ask', id: row.i });
    const box = $('#feel');
    box.hidden = false; box.dataset.id = String(row.i);
  }

  answerFeel(id: number, ok: boolean) {
    const row = this.test.rows.find((r) => r.i === id);
    if (!row) return;
    row.relaxed = ok;
    const box = $('#feel'); if (box.dataset.id === String(id)) box.hidden = true;
    this.rescore();
    this.renderLog();
  }

  startTest10() {
    this.mode = 'test10'; this.test = { n: 0, good: 0, target: null, rows: [], done: false };
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
    if (this.wantFlash) {
      // Lag proof: corner square + 1760 Hz beep on the same frame the rod whip is first drawn.
      this.wantFlash = false;
      const sq = $('#lpSquare'); sq.hidden = false; this.sfx.beep(1760);
      clearTimeout(this.flashTimer); this.flashTimer = window.setTimeout(() => (sq.hidden = true), 150);
    }
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
    if (this.meter) {
      const show = !this.touchMode && (!this.link || this.link.status === 'paired');
      $('#gyro').hidden = !show;
      if (show) this.meter.draw(this.det);
    }
    this.frames++;
    requestAnimationFrame((t) => this.loop(t));
  }

  private commitLagIfReady() {
    const L = this.pendingLag;
    if (!L || L.t_cast_start_host === undefined || L.t_launch_host === undefined) return;
    const row: LagRow = {
      i: this.lag.length + 1, path: L.path!, source: L.source!,
      link: pathKind(L.path!) as LagRow['link'],
      ice: L.path === 'mqtt-relay' || L.path === 'local' || !this.link?.icePair ? null : `${this.link.icePair.local}/${this.link.icePair.localAddrKind} -> ${this.link.icePair.remote}/${this.link.icePair.remoteAddrKind} ${this.link.icePair.protocol}`,
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
    $('#btnCal').onclick = () => { this.calibrateNext = true; this.toast('Re-tune power: make one relaxed cast — it becomes ~65% power'); };
    $('#calYes').onclick = () => { $('#calOffer').hidden = true; };
    $('#calNo').onclick = () => { $('#calOffer').hidden = true; };
    ($('#axisSel') as HTMLSelectElement).onchange = (e) => this.setAxis((e.target as HTMLSelectElement).value);
    ($('#lagProof') as HTMLInputElement).onchange = (e) => { this.lagProof = (e.target as HTMLInputElement).checked; this.sendCfg(); this.toast(this.lagProof ? 'Lag proof on: film both screens. Phone flashes + beeps 880 Hz at the flick; Mac flashes the corner + beeps 1760 Hz on the whip frame' : 'Lag proof off', 4000); };
    $('#feelUp').onclick = () => this.answerFeel(Number($('#feel').dataset.id), true);
    $('#feelDown').onclick = () => this.answerFeel(Number($('#feel').dataset.id), false);
    this.renderAxisSel();
    $('#btnNewSession').onclick = async () => { this.pairingClock.startAt = 0; this.pairingClock.stopAt = 0; this.padJoinedAt = 0; await this.link?.newSession(); this.renderQr(); };
    $('#btnShowQr').onclick = () => { $('#qrCard').hidden = !$('#qrCard').hidden; };
    ($('#touchToggle') as HTMLInputElement).onchange = (e) => this.setTouchMode((e.target as HTMLInputElement).checked);
    $('#exportClose').onclick = () => ($('#exportDlg').hidden = true);
    $('#exportCopy').onclick = () => { void navigator.clipboard?.writeText(($('#exportTxt') as HTMLTextAreaElement).value); };
  }

  /** Debug override for the swing axis: 'auto' re-learns from the next swing. */
  setAxis(v: string) {
    if (v === 'auto') { this.det.override = null; this.det.lock = null; localStorage.removeItem('bcs.axis'); this.toast('Swing axis: auto — learns from your next swing'); }
    else {
      const axis = 'xyz'.indexOf(v[0]) as 0 | 1 | 2; const sign = v[1] === '-' ? -1 : 1;
      this.det.override = { axis, sign, src: 'manual', at: new Date().toISOString() };
      localStorage.setItem('bcs.axis', JSON.stringify(this.det.override));
      this.toast(`Swing axis forced: ${AXIS_NAMES[axis]}, backswing ${sign > 0 ? '+' : '−'}`);
    }
    this.sendCfg(); this.renderAxisSel();
  }
  private renderAxisSel() {
    const sel = document.querySelector('#axisSel') as HTMLSelectElement | null; if (!sel) return;
    const o = this.det.override;
    sel.value = o ? `${'xyz'[o.axis]}${o.sign > 0 ? '+' : '-'}` : 'auto';
    const l = this.det.lock;
    $('#axisNote').textContent = o ? 'manual' : l ? `learned ${'XYZ'[l.axis]}${l.sign > 0 ? '+' : '−'}` : 'not learned yet (assumes X+)';
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
    const pathLbl = l.path ? PATH_LABEL[l.path] : '—';
    pill.innerHTML = `<b>${label[st]}</b><span>path: ${st === 'paired' ? pathLbl : '—'}</span><span>RTT/2 ${fmt(l.rttHalf, 0)} ms</span><span>age ${fmt(l.deliveryAge, 0)} ms</span>`;
    $('#brokerState').textContent = l.brokerOk ? 'signaling ok' : 'signaling…';
    $('#paused').hidden = st !== 'paused';
  }

  private renderDebug() {
    const d = this.det;
    $('#debug').textContent =
      `phase ${d.phase}\nrr x/y/z ${d.live.rr.map((v) => v.toFixed(0)).join(' / ')}°/s\nswing axis ${'XYZ'[d.active.axis]}${d.active.sign > 0 ? '+' : '−'} ${d.learned ? '' : '(not learned)'} ω ${d.live.w.toFixed(0)}°/s\n` +
      `thresholds back ${DET.back} · flick ${DET.fwd} · release ≤${DET.releaseAfterPeakMs} ms after peak\n` +
      `peak back ${d.peaks.back.toFixed(0)} fwd ${d.peaks.fwd.toFixed(0)}°/s\n|acc| ${d.live.acc.toFixed(1)} peak ${d.peaks.acc.toFixed(1)} m/s²\nyaw Δ ${d.live.yaw.toFixed(1)}°\n` +
      `last attempt: ${d.last ? (d.last.ok ? 'cast' : d.last.reason) + ` (back ${d.last.backPeak}, fwd ${d.last.fwdPeak}, axes ${d.last.axisPeaks.join('/')})` : '–'}\n` +
      `frames rx ${this.framesRxRate}/s\noffset ${fmt(this.link?.clock.offset ?? 0, 1)} ms\npower wMin ${d.power.wMin} wMax ${d.power.wMax}${d.power.scaled ? ` (auto from ${d.power.scaledFrom ?? '?'}°/s)` : ' (default)'}`;
  }

  private renderLog() {
    const rows = this.casts.slice(-10).reverse();
    $('#castLog').innerHTML = '<tr><th>#</th><th>src</th><th>pow</th><th>°/s</th><th>rel ms</th><th>ft</th><th>miss</th><th>👍</th><th></th></tr>' +
      rows.map((r) => `<tr><td>${r.i}</td><td>${r.source[0]}</td><td>${Math.round(r.power * 100)}</td><td${r.tooHard ? ' class="hard" title="too hard, doesn\'t count"' : ''}>${r.peak_dps ?? '–'}</td><td>${r.releaseDtMs}</td><td>${Math.round(r.distFt)}</td><td>${r.missText ?? ''}</td><td>${r.relaxed === undefined ? '' : r.relaxed === null ? '…' : r.relaxed ? '👍' : '👎'}</td><td>${r.good === undefined ? '' : r.counts ? '✅' : '❌'}</td></tr>`).join('');
  }

  private renderAttempts() {
    const el = document.querySelector('#attLog'); if (!el) return;
    const rows = this.attempts.slice(-8).reverse();
    el.innerHTML = '<tr><th>#</th><th>result</th><th>back</th><th>flick</th><th>x/y/z peak</th><th>axis</th></tr>' +
      rows.map((a) => `<tr><td>${a.i}</td><td>${a.ok ? 'cast' : a.reason}</td><td>${a.backPeak}</td><td>${a.fwdPeak}</td><td>${a.axisPeaks.join('/')}</td><td>${'XYZ'[a.axis]}${a.sign > 0 ? '+' : '−'}</td></tr>`).join('');
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
      row(this.test.n >= 10 ? this.test.good >= PASS.goodCasts : null, `Cast test ≥${PASS.goodCasts}/10 (≤${PASS.maxPeakDps}°/s + 👍)`, this.test.n ? `${this.test.good}/${this.test.n}` : '–');
  }

  exportCasts() {
    return {
      app: 'Bass Cast spike', kind: 'cast-log', exportedAt: new Date().toISOString(), renderer: this.info,
      goodRule: { landErrPctMax: PASS.landTolPct, aimConeDeg: PASS.aimConeDeg, maxPeakDps: PASS.maxPeakDps, needsRelaxedThumbsUp: true },
      detector: { thresholds: DET, axis: this.det.active, axisLearned: this.det.learned, axisOverride: this.det.override, power: this.det.power,
        axes: 'rr[0]=rotationRate.alpha (about device X), rr[1]=beta (Y), rr[2]=gamma (Z), deg/s' },
      test10: {
        attempts: this.test.n, counted: this.test.good, done: this.test.done, rows: this.test.rows,
        misses: this.test.rows.filter((r) => !r.counts).map((r) => ({ i: r.i, targetFt: r.intendedFt, distFt: r.distFt, missFt: r.missFt, missDeg: r.missDeg, text: r.missText, peak_dps: r.peak_dps, tooHard: r.tooHard, relaxed: r.relaxed })),
      },
      casts: this.casts,
      attempts: this.attempts,
      attemptStats: this.attempts.reduce((m, a) => { m[a.reason] = (m[a.reason] ?? 0) + 1; return m; }, {} as Record<string, number>),
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
      pairing: { clock: this.pairingClock.log, session: l?.ids.tag, note: 'ms = Show QR click -> first cast; scanToCastMs = phone joined -> first cast' },
      link: { path: l?.path ?? null, label: l?.path ? PATH_LABEL[l.path] : null, ice: l?.icePair ?? null,
        paths: 'direct = WebRTC host<->host on the LAN; p2p-nat = WebRTC phone<->Mac via STUN-found addresses (no server relays data); mqtt-relay = data through the public MQTT broker' },
      reconnects: l?.reconnects ?? [],
      clockSync: l?.clock.history ?? [],
      pingRttHalf: { n: l?.latencyLog.length ?? 0, median: round1(median(l?.latencyLog.map((x) => x.rttHalf) ?? [])), p95: round1(percentile(l?.latencyLog.map((x) => x.rttHalf) ?? [], 95)), samples: l?.latencyLog.slice(-600) ?? [] },
      deliveryAge: { n: ages.length, median: round1(median(ages)), p95: round1(percentile(ages, 95)), samples: l?.ageLog.slice(-600) ?? [] },
      events: l?.events.slice(-200) ?? [],
    };
  }
}
