// Motion cast detector, shared by the host (authoritative) and the pad (live meter + lag-proof flash).
// Original to the Bass Cast spike.
//
// Axes: DeviceMotionEvent.rotationRate is reported as alpha = rate about the device X axis, beta = about Y,
// gamma = about Z (deg/s). That is what Safari/iOS and Chrome implement and what the current W3C spec now
// says (w3c/deviceorientation PR #43). It differs from DeviceOrientationEvent, where beta is the X-axis angle.
// For a phone held upright in portrait, screen facing you, an overhead rod cast is a rotation about X,
// i.e. rotationRate.alpha = rr[0]. Backswing (top of the phone tipping back toward you) is positive.
import type { Frame } from './protocol';

export type Axis = 0 | 1 | 2;
export const AXIS_NAMES = ['X · rotationRate.alpha', 'Y · rotationRate.beta', 'Z · rotationRate.gamma'] as const;
export interface AxisLock { axis: Axis; sign: 1 | -1; src: 'auto' | 'manual'; at?: string }
/** Prior used until the first swing teaches the real axis: upright portrait grip. */
export const PRIOR_AXIS: AxisLock = { axis: 0, sign: 1, src: 'auto' };

export const DET = {
  back: 60, // deg/s on the swing axis = backswing started
  fwd: 120, // deg/s the other way = forward flick
  fwdNoBack: 220, // forward-only flick (no backswing) when the axis is known
  releaseAfterPeakMs: 450, // button mode: let go up to this long after the flick peak
  earlyReleaseWaitMs: 300, // button let go during the backswing: wait this long for the flick
  backTimeoutMs: 900, // no-button mode: backswing that never turns into a flick
  cooldownMs: 1100, // ignore follow-through after a cast
  attemptMinPeak: 100, // smaller wiggles are not logged as attempts
  wrongAxisPeak: 260, // big rotation on another axis while locked = grip changed
};

export type Phase = 'idle' | 'armed' | 'back' | 'fwd' | 'cooldown';
export type RejectReason = 'no_swing' | 'no_forward' | 'released_early' | 'held_too_long' | 'wrong_axis' | 'back_timeout' | 'paused';
export const COACH: Record<RejectReason, string> = {
  no_swing: "Swing back further — I didn't feel a backswing.",
  no_forward: 'Flick forward faster.',
  back_timeout: 'Flick forward faster — the backswing never turned into a flick.',
  released_early: 'Keep holding until you flick forward, then let go.',
  held_too_long: 'Let go right after the flick (you held on too long).',
  wrong_axis: 'Hold the phone upright like a rod handle — re-learning your swing.',
  paused: 'The phone left the controller page.',
};

export interface PowerCal { wMin: number; wMax: number; gamma: number; scaled: boolean; scaledFrom?: number; at?: string }
/** Relaxed wrist flick (~300-500 deg/s) lands mid-range; 500 deg/s ~ 90%. */
export const DEFAULT_POWER: PowerCal = { wMin: 80, wMax: 560, gamma: 0.8, scaled: false };
export function powerOf(peak: number, c: PowerCal) {
  const x = Math.min(1, Math.max(0, (peak - c.wMin) / Math.max(60, c.wMax - c.wMin)));
  return Math.pow(x, c.gamma);
}
/**
 * Silent auto-scale from the first good swing: a natural 300-500 deg/s swing maps to ~65% power. Clamped so
 * max power never needs more than 560 deg/s (always reachable relaxed) and a timid first swing can't shrink the
 * range below 440 deg/s (which would make every later normal swing a full-power cast).
 */
export function scaledFrom(peak: number, c: PowerCal): PowerCal {
  const p = Math.min(500, Math.max(300, peak));
  const x = Math.pow(0.65, 1 / c.gamma);
  const wMax = Math.round(Math.min(560, Math.max(440, c.wMin + (p - c.wMin) / x)));
  return { ...c, wMax, scaled: true, scaledFrom: Math.round(peak), at: new Date().toISOString() };
}

export interface Attempt {
  ok: boolean;
  reason: RejectReason | 'cast';
  coach: string;
  mode: 'free' | 'button';
  axis: Axis; sign: 1 | -1; axisLearned: boolean;
  backPeak: number; fwdPeak: number; // deg/s on the swing axis
  axisPeaks: [number, number, number]; // max |deg/s| per axis during the attempt (raw)
  dtMs: number | null; // release minus flick peak
  tStart: number; tEnd: number;
}

export interface CastParams {
  source: 'motion' | 'touch';
  power: number; aim: number; dt: number;
  peakW: number; peakAcc: number; backPeak: number; noBackswing: boolean;
  tFlickHost: number; tReleaseHost: number; timing: 'early' | 'good' | 'late'; calibrated: boolean;
  mode?: 'free' | 'button'; axis?: Axis; sign?: 1 | -1;
}

export interface DetectorEvents {
  onArm?: () => void;
  onBack?: () => void;
  onWhip?: (tFlick: number) => void;
  onCast?: (p: CastParams) => void;
  onAttempt?: (a: Attempt) => void;
  onLearn?: (l: AxisLock) => void;
  onScale?: (c: PowerCal) => void;
  onPhase?: (p: Phase) => void;
}

export interface HostFrame extends Frame { th: number }

export const TIMING_WINDOW = { early: -40, late: 120, lateMax: 450 };
export function timingOf(dt: number): 'early' | 'good' | 'late' {
  return dt < TIMING_WINDOW.early ? 'early' : dt > TIMING_WINDOW.late ? 'late' : 'good';
}

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

export class CastDetector {
  phase: Phase = 'idle';
  lock: AxisLock | null = null; // null = not learned yet (auto per swing, PRIOR as tie-break)
  override: AxisLock | null = null; // debug override
  power: PowerCal = { ...DEFAULT_POWER };
  autoScale = true;
  live = { rr: [0, 0, 0] as [number, number, number], w: 0, acc: 0, yaw: 0 };
  peaks = { back: 0, fwd: 0, acc: 0, negDuringBack: 0 };
  last: Attempt | null = null;
  private axis: Axis = 0;
  private sign: 1 | -1 = 1;
  private attemptAxisFixed = false;
  private mode: 'free' | 'button' = 'free';
  private bailDown = false;
  private tStart = 0;
  private tPeak = 0;
  private whipSent = false;
  private releasing = false;
  private relTh = 0;
  private noBack = false;
  private coolUntil = 0;
  private lastTh = 0;
  private axisPeaks: [number, number, number] = [0, 0, 0];
  private buf: { th: number; rr: [number, number, number] }[] = [];
  private attemptFrames: { th: number; rr: [number, number, number] }[] = [];
  private yaw0: number | null = null;
  private gamma0 = 0;
  private lastYaw = 0;

  constructor(public ev: DetectorEvents = {}) {}

  get active(): AxisLock { return this.override ?? this.lock ?? PRIOR_AXIS; }
  get learned() { return !!(this.override || this.lock); }

  private setPhase(p: Phase) { if (p !== this.phase) { this.phase = p; this.ev.onPhase?.(p); } }

  private yawOf(f: Frame) {
    if (this.yaw0 === null) return 0;
    const da = wrap180(f.ori[0] - this.yaw0);
    const dg = f.ori[2] - this.gamma0;
    return Math.abs(da) > 0.01 ? -da : dg;
  }

  /** Pick the swing axis for an attempt that is just starting (axis not learned yet). */
  private pickAxis(f: HostFrame) {
    if (this.learned) { this.axis = this.active.axis; this.sign = this.active.sign; this.attemptAxisFixed = true; return; }
    const win = this.buf.filter((b) => f.th - b.th <= 200);
    const e = [0, 0, 0];
    for (const b of win) for (let i = 0; i < 3; i++) e[i] += b.rr[i] * b.rr[i];
    let ax: Axis = PRIOR_AXIS.axis;
    for (let i = 0; i < 3; i++) if (e[i] > e[ax] * 1.15) ax = i as Axis;
    this.axis = ax;
    this.sign = (f.rr[ax] >= 0 ? 1 : -1) as 1 | -1; // first big excursion = backswing
    this.attemptAxisFixed = true;
  }

  feed(f: HostFrame) {
    if (f.th < this.lastTh - 200) return; // stale, reordered
    this.lastTh = Math.max(this.lastTh, f.th);
    this.buf.push({ th: f.th, rr: f.rr });
    while (this.buf.length && f.th - this.buf[0].th > 1500) this.buf.shift();
    const accMag = Math.hypot(f.acc[0], f.acc[1], f.acc[2]);
    const a = this.active;
    const wAct = f.rr[this.attemptAxisFixed && this.phase !== 'idle' && this.phase !== 'cooldown' ? this.axis : a.axis] *
      (this.attemptAxisFixed && this.phase !== 'idle' && this.phase !== 'cooldown' ? this.sign : a.sign);
    this.live = { rr: f.rr, w: wAct, acc: accMag, yaw: this.yawOf(f) };

    if (this.phase === 'cooldown') {
      if (f.th >= this.coolUntil) this.setPhase(this.bailDown ? 'armed' : 'idle');
      else return;
    }
    const maxAbs = Math.max(Math.abs(f.rr[0]), Math.abs(f.rr[1]), Math.abs(f.rr[2]));

    if (this.phase === 'idle' || this.phase === 'armed') {
      // Locked axis, yet a big rotation shows up only on another axis: the grip changed. Re-learn.
      if (this.lock && !this.override && this.phase === 'idle') {
        const other = [0, 1, 2].filter((i) => i !== this.lock!.axis).map((i) => Math.abs(f.rr[i]));
        if (Math.max(...other) > DET.wrongAxisPeak && Math.abs(f.rr[this.lock.axis]) < DET.back) {
          this.startAttempt(f);
          this.axis = this.lock.axis; this.sign = this.lock.sign;
          for (const b of this.buf) if (f.th - b.th <= 500) for (let i = 0; i < 3; i++) this.axisPeaks[i] = Math.max(this.axisPeaks[i], Math.abs(b.rr[i]));
          this.endAttempt(f.th, 'wrong_axis');
          return;
        }
      }
      if (maxAbs > DET.back || this.phase === 'armed') {
        if (this.phase === 'idle' && maxAbs > DET.back) this.startAttempt(f);
        if (!this.attemptAxisFixed && maxAbs > DET.back) this.pickAxis(f);
        if (this.attemptAxisFixed) {
          const w = f.rr[this.axis] * this.sign;
          this.track(f, accMag);
          if (w > DET.back) { this.setPhase('back'); this.peaks.back = w; this.ev.onBack?.(); }
          else if (this.learned && -w > DET.fwdNoBack) { this.noBack = true; this.enterFwd(-w, f.th); }
          else if (this.phase === 'idle') this.attemptAxisFixed = false; // wiggle on another axis, keep listening
        }
      }
    } else {
      this.track(f, accMag);
      const w = f.rr[this.axis] * this.sign;
      if (this.phase === 'back') {
        this.peaks.back = Math.max(this.peaks.back, w);
        this.peaks.negDuringBack = Math.max(this.peaks.negDuringBack, -w);
        if (-w > DET.fwd) this.enterFwd(-w, f.th);
        else if (this.mode === 'free' && f.th - this.tStart > DET.backTimeoutMs) {
          const big = Math.max(...this.axisPeaks) >= DET.attemptMinPeak;
          this.endAttempt(f.th, this.peaks.negDuringBack > 40 ? 'no_forward' : 'back_timeout', !big);
          return;
        }
      } else if (this.phase === 'fwd') {
        if (-w > this.peaks.fwd) { this.peaks.fwd = -w; this.tPeak = f.th; }
        else if (!this.whipSent && -w < 0.8 * this.peaks.fwd) { this.whipSent = true; this.ev.onWhip?.(this.tPeak); }
        if (this.mode === 'free' && this.whipSent && -w < 0.5 * this.peaks.fwd) { this.relTh = f.th; this.finalize(); return; }
        if (this.mode === 'button' && !this.releasing && this.bailDown && f.th - this.tPeak > DET.releaseAfterPeakMs) { this.endAttempt(f.th, 'held_too_long'); return; }
      }
      if (this.releasing) {
        if (this.phase === 'fwd' && this.whipSent) this.finalize();
        else if (f.th - this.relTh > DET.earlyReleaseWaitMs) this.releaseTimeout();
      }
    }
  }

  private track(f: HostFrame, accMag: number) {
    for (let i = 0; i < 3; i++) this.axisPeaks[i] = Math.max(this.axisPeaks[i], Math.abs(f.rr[i]));
    this.peaks.acc = Math.max(this.peaks.acc, accMag);
    this.attemptFrames.push({ th: f.th, rr: f.rr });
    if (!this.releasing || f.th <= this.relTh) this.lastYaw = this.live.yaw;
  }

  private startAttempt(f: HostFrame) {
    this.tStart = f.th;
    this.peaks = { back: 0, fwd: 0, acc: 0, negDuringBack: 0 };
    this.axisPeaks = [0, 0, 0];
    this.attemptFrames = [];
    this.noBack = false;
    this.whipSent = false;
    this.releasing = false;
    if (!this.bailDown) { this.mode = 'free'; this.yaw0 = f.ori[0]; this.gamma0 = f.ori[2]; }
  }

  private enterFwd(w: number, th: number) {
    this.setPhase('fwd');
    this.peaks.fwd = w;
    this.tPeak = th;
    this.whipSent = false;
  }

  bail(down: boolean, th: number, ori?: [number, number, number]) {
    if (down) {
      this.bailDown = true;
      if (this.phase === 'idle' || this.phase === 'cooldown') {
        this.mode = 'button';
        this.yaw0 = ori ? ori[0] : null; this.gamma0 = ori ? ori[2] : 0;
        this.tStart = th;
        this.peaks = { back: 0, fwd: 0, acc: 0, negDuringBack: 0 };
        this.axisPeaks = [0, 0, 0]; this.attemptFrames = []; this.noBack = false; this.whipSent = false; this.releasing = false;
        this.attemptAxisFixed = false;
        this.coolUntil = 0;
        this.setPhase('armed');
        this.ev.onArm?.();
      } else this.mode = 'button'; // pressed just after a free swing started: same attempt
      return;
    }
    this.bailDown = false;
    if (this.mode !== 'button' || this.releasing) return;
    if (this.phase === 'armed') {
      const big = Math.max(...this.axisPeaks);
      this.endAttempt(th, 'no_swing', false);
      void big;
      return;
    }
    if (this.phase === 'idle' || this.phase === 'cooldown') return;
    this.releasing = true;
    this.relTh = th;
    if (this.phase === 'fwd' && this.whipSent) this.finalize();
  }

  /** Release that has not resolved yet (frames stopped, or still in the backswing). */
  releaseTimeout() {
    if (!this.releasing) return;
    if (this.phase === 'fwd') this.finalize();
    else this.endAttempt(this.relTh, 'released_early');
  }

  cancel(why: RejectReason = 'paused') {
    this.bailDown = false;
    if (this.phase !== 'idle' && this.phase !== 'cooldown') this.endAttempt(this.lastTh, why);
  }

  private attemptBase(tEnd: number): Omit<Attempt, 'ok' | 'reason' | 'coach'> {
    const r1 = (x: number) => Math.round(x);
    return {
      mode: this.mode, axis: this.axis, sign: this.sign, axisLearned: this.learned,
      backPeak: r1(this.peaks.back), fwdPeak: r1(this.peaks.fwd), axisPeaks: [r1(this.axisPeaks[0]), r1(this.axisPeaks[1]), r1(this.axisPeaks[2])],
      dtMs: null, tStart: this.tStart, tEnd,
    };
  }

  /** Locked axis, but most of the motion happened on another axis: the grip changed. */
  private offAxis() {
    if (!this.lock || this.override) return false;
    const mine = this.axisPeaks[this.axis];
    const other = Math.max(...this.axisPeaks.filter((_, i) => i !== this.axis));
    return other > DET.wrongAxisPeak && other > 2 * mine;
  }

  private endAttempt(tEnd: number, reason: RejectReason, silent = false) {
    if (reason !== 'wrong_axis' && reason !== 'paused' && this.offAxis()) { reason = 'wrong_axis'; silent = false; }
    if (reason === 'wrong_axis' && !this.override) this.lock = null; // re-learn from the next good swing
    const a: Attempt = { ...this.attemptBase(tEnd), ok: false, reason, coach: COACH[reason] };
    this.releasing = false;
    this.attemptAxisFixed = false;
    this.coolUntil = tEnd + (reason === 'wrong_axis' ? DET.cooldownMs : 400);
    this.setPhase('cooldown');
    if (silent) return;
    this.last = a;
    this.ev.onAttempt?.(a);
  }

  /** After a good cast, learn axis+sign from the whole swing: most angular energy; first excursion = backswing. */
  private learnFrom() {
    if (this.override || this.lock) return;
    const e = [0, 0, 0];
    for (const b of this.attemptFrames) for (let i = 0; i < 3; i++) e[i] += b.rr[i] * b.rr[i];
    let ax: Axis = 0;
    for (let i = 1; i < 3; i++) if (e[i] > e[ax]) ax = i as Axis;
    const first = this.attemptFrames.find((b) => Math.abs(b.rr[ax]) > DET.back);
    const sign = ((first ? first.rr[ax] : 1) >= 0 ? 1 : -1) as 1 | -1;
    this.lock = { axis: ax, sign: this.noBack ? (-sign as 1 | -1) : sign, src: 'auto', at: new Date().toISOString() };
    this.ev.onLearn?.(this.lock);
  }

  private finalize() {
    this.releasing = false;
    if (!this.whipSent) { this.whipSent = true; this.ev.onWhip?.(this.tPeak); }
    const th = this.relTh;
    const dt = th - this.tPeak;
    if (this.offAxis()) { this.endAttempt(th, 'wrong_axis'); return; }
    if (this.mode === 'button' && dt > DET.releaseAfterPeakMs) { this.endAttempt(th, 'held_too_long'); return; }
    if (this.autoScale && !this.power.scaled) { this.power = scaledFrom(this.peaks.fwd, this.power); this.ev.onScale?.(this.power); }
    let power = powerOf(this.peaks.fwd, this.power);
    if (this.noBack) power *= 0.8;
    const a: Attempt = { ...this.attemptBase(th), ok: true, reason: 'cast', coach: '', dtMs: Math.round(dt) };
    this.learnFrom();
    this.attemptAxisFixed = false;
    this.coolUntil = th + DET.cooldownMs;
    this.setPhase('cooldown');
    this.last = a;
    this.ev.onAttempt?.(a);
    this.ev.onCast?.({
      source: 'motion', power, aim: Math.max(-35, Math.min(35, this.lastYaw)), dt, peakW: this.peaks.fwd,
      peakAcc: this.peaks.acc, backPeak: this.peaks.back, noBackswing: this.noBack, tFlickHost: this.tPeak,
      tReleaseHost: th, timing: timingOf(dt), calibrated: this.power.scaled, mode: this.mode, axis: this.axis, sign: this.sign,
    });
  }
}
