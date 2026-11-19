// Motion cast detection (runs on the host) + lure ballistics. Original to the Bass Cast spike.
import type { Frame } from '../../shared/protocol';

export type DetState = 'idle' | 'armed' | 'back' | 'fwd';

export interface HostFrame extends Frame { th: number } // th = frame time converted to host clock

export interface CastParams {
  source: 'motion' | 'touch';
  power: number; // 0..1
  aim: number; // deg, + = right
  dt: number; // release time minus flick-peak time, ms (+ = after peak)
  peakW: number; // deg/s (motion) or normalized px/ms (touch)
  peakAcc: number;
  backPeak: number;
  noBackswing: boolean;
  tFlickHost: number;
  tReleaseHost: number;
  timing: 'early' | 'good' | 'late';
  calibrated: boolean;
}

export interface DetectorEvents {
  onArm?: () => void;
  onBack?: () => void;
  onWhip?: (tFlickHost: number) => void; // forward-stroke peak confirmed -> rod whip starts on screen
  onCast?: (p: CastParams) => void;
  onCancel?: (why: string) => void;
}

export interface Calibration { wMin: number; wMax: number; backSign: 1 | -1; at?: string; peak?: number }
export const DEFAULT_CAL: Calibration = { wMin: 200, wMax: 1100, backSign: 1 };

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

export class CastDetector {
  state: DetState = 'idle';
  cal: Calibration = { ...DEFAULT_CAL };
  calibrated = false;
  live = { w: 0, acc: 0, yaw: 0, beta: 0 };
  peaks = { back: 0, fwd: 0, acc: 0 };
  private tPeak = 0;
  private whipSent = false;
  private yaw0: number | null = null;
  private gamma0 = 0;
  private lastYaw = 0;
  private lastTh = 0;
  private noBack = false;
  private releasing = false;
  private relTh = 0;

  constructor(public ev: DetectorEvents = {}) {}

  private yawOf(f: Frame) {
    // Heading change since the bail was pressed. alpha is relative on iOS (fine, we only diff it).
    if (this.yaw0 === null) return 0;
    const da = wrap180(f.ori[0] - this.yaw0);
    const dg = f.ori[2] - this.gamma0;
    // Prefer alpha; if alpha looks frozen (some devices), fall back to gamma.
    return Math.abs(da) > 0.01 ? -da : dg;
  }

  feed(f: HostFrame) {
    if (f.th < this.lastTh - 200) return; // stale reordered frame
    this.lastTh = Math.max(this.lastTh, f.th);
    const w = f.rr[1] * this.cal.backSign; // + = backswing direction (pitch axis)
    const accMag = Math.hypot(f.acc[0], f.acc[1], f.acc[2]);
    this.live = { w, acc: accMag, yaw: this.yawOf(f), beta: f.ori[1] };
    if (this.state === 'idle') return;
    if (!this.releasing || f.th <= this.relTh) this.lastYaw = this.live.yaw; // aim = yaw at release
    this.peaks.acc = Math.max(this.peaks.acc, accMag);
    if (this.state === 'armed') {
      if (w > 90) { this.state = 'back'; this.peaks.back = w; this.ev.onBack?.(); }
      else if (-w > 260) { this.noBack = true; this.enterFwd(-w, f.th); }
    } else if (this.state === 'back') {
      this.peaks.back = Math.max(this.peaks.back, w);
      if (-w > 150) this.enterFwd(-w, f.th);
    } else if (this.state === 'fwd') {
      if (-w > this.peaks.fwd) { this.peaks.fwd = -w; this.tPeak = f.th; }
      else if (!this.whipSent && -w < 0.8 * this.peaks.fwd) { this.whipSent = true; this.ev.onWhip?.(this.tPeak); }
    }
    // An early release (bail let go while the rod is still accelerating) is finalized once the stroke peaks.
    if (this.releasing && this.state === 'fwd' && this.whipSent) this.finalize();
    else if (this.releasing && f.th - this.relTh > 250) this.releaseTimeout(); // by phone time, not wall time
  }

  private enterFwd(w: number, th: number) {
    this.state = 'fwd';
    this.peaks.fwd = w;
    this.tPeak = th;
    this.whipSent = false;
  }

  bail(down: boolean, th: number, ori?: [number, number, number]) {
    if (down) {
      if (this.state !== 'idle') return;
      this.state = 'armed';
      this.peaks = { back: 0, fwd: 0, acc: 0 };
      this.noBack = false;
      this.yaw0 = ori ? ori[0] : null;
      this.gamma0 = ori ? ori[2] : 0;
      this.ev.onArm?.();
      return;
    }
    if (this.state === 'idle' || this.releasing) return;
    if (this.state === 'armed') { this.state = 'idle'; this.ev.onCancel?.('no swing'); return; }
    this.releasing = true;
    this.relTh = th;
    if (this.state === 'fwd' && this.whipSent) this.finalize();
    // otherwise keep watching the stroke; releaseTimeout() closes it out
  }

  /** Called ~160 ms after a release that hasn't been finalized yet. */
  releaseTimeout() {
    if (!this.releasing) return;
    if (this.state === 'fwd') this.finalize();
    else { this.releasing = false; this.state = 'idle'; this.ev.onCancel?.('released during backswing'); }
  }

  private finalize() {
    this.releasing = false;
    this.state = 'idle';
    if (!this.whipSent) { this.whipSent = true; this.ev.onWhip?.(this.tPeak); }
    const th = this.relTh;
    const dt = th - this.tPeak;
    const span = Math.max(100, this.cal.wMax - this.cal.wMin);
    let power = Math.pow(Math.min(1, Math.max(0, (this.peaks.fwd - this.cal.wMin) / span)), 0.9);
    if (this.noBack) power *= 0.7;
    this.ev.onCast?.({
      source: 'motion', power, aim: Math.max(-35, Math.min(35, this.lastYaw)), dt, peakW: this.peaks.fwd,
      peakAcc: this.peaks.acc, backPeak: this.peaks.back, noBackswing: this.noBack, tFlickHost: this.tPeak,
      tReleaseHost: th, timing: timingOf(dt), calibrated: this.calibrated,
    });
  }

  cancel(why: string) {
    this.releasing = false;
    if (this.state !== 'idle') { this.state = 'idle'; this.ev.onCancel?.(why); }
  }

  /** Optional calibration from one comfortable full cast: that swing maps to ~80% power. */
  calibrateFrom(p: CastParams) {
    if (p.source !== 'motion' || p.peakW < 250) return false;
    this.cal = { ...this.cal, wMax: Math.round(p.peakW / 0.8), at: new Date().toISOString(), peak: Math.round(p.peakW) };
    this.calibrated = true;
    return true;
  }
}

export const TIMING_WINDOW = { early: -20, late: 60 };
export function timingOf(dt: number): 'early' | 'good' | 'late' {
  return dt < TIMING_WINDOW.early ? 'early' : dt > TIMING_WINDOW.late ? 'late' : 'good';
}

export interface Trajectory {
  pts: { t: number; x: number; y: number; z: number }[]; // seconds, metres (camera-local: -z forward)
  distM: number;
  distFt: number;
  landAimDeg: number;
  flightS: number;
  launchDeg: number;
  speed: number;
  slap: boolean;
}

export const ROD_TIP_HEIGHT = 2.4;
export const DRAG_K = 0.014; // 1/m — lure + line drag folded together

/** Release timing shapes the launch: early lobs high and loses speed, late flattens/slaps short. */
export function launchFrom(p: { power: number; dt: number; aim: number }) {
  let speed = 6 + 20 * p.power;
  let angle = 30;
  if (p.dt < TIMING_WINDOW.early) {
    const e = Math.min(1, (TIMING_WINDOW.early - p.dt) / 200);
    angle += 40 * e; speed *= 1 - 0.35 * e;
  } else if (p.dt > TIMING_WINDOW.late) {
    const l = Math.min(1, (p.dt - TIMING_WINDOW.late) / 250);
    angle -= 45 * l; speed *= 1 - 0.3 * l;
  }
  return { speed, angle, aim: p.aim };
}

export function simulate(p: { power: number; dt: number; aim: number }): Trajectory {
  const { speed, angle, aim } = launchFrom(p);
  const a = (angle * Math.PI) / 180, yaw = (aim * Math.PI) / 180;
  let vx = speed * Math.cos(a) * Math.sin(yaw), vz = -speed * Math.cos(a) * Math.cos(yaw), vy = speed * Math.sin(a);
  let x = 0, y = ROD_TIP_HEIGHT, z = 0, t = 0;
  const h = 1 / 240;
  const pts = [{ t, x, y, z }];
  while (y > 0 && t < 8) {
    const v = Math.hypot(vx, vy, vz);
    vx += -DRAG_K * v * vx * h;
    vz += -DRAG_K * v * vz * h;
    vy += (-9.81 - DRAG_K * v * vy) * h;
    x += vx * h; y += vy * h; z += vz * h; t += h;
    if (Math.round(t * 240) % 4 === 0) pts.push({ t, x, y: Math.max(0, y), z });
  }
  pts.push({ t, x, y: 0, z });
  const distM = Math.hypot(x, z);
  return { pts, distM, distFt: distM * 3.28084, landAimDeg: (Math.atan2(x, -z) * 180) / Math.PI, flightS: t, launchDeg: angle, speed, slap: angle < 5 };
}
