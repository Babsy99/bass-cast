// Device motion/orientation capture (iOS permission flow + watchdog). Used by the pad and by solo mode.
import type { Frame } from './protocol';
import { nowMs } from './protocol';

type PermFn = () => Promise<'granted' | 'denied' | 'default'>;

export async function requestMotionPermission(): Promise<{ ok: boolean; detail: string }> {
  // Must be called synchronously from a user tap on iOS 13+.
  const DM = (window as any).DeviceMotionEvent, DO = (window as any).DeviceOrientationEvent;
  const reqs: Promise<string>[] = [];
  if (DM && typeof DM.requestPermission === 'function') reqs.push((DM.requestPermission as PermFn)());
  if (DO && typeof DO.requestPermission === 'function') reqs.push((DO.requestPermission as PermFn)());
  if (!reqs.length) return { ok: !!DM, detail: DM ? 'no permission prompt needed' : 'DeviceMotionEvent not supported' };
  try {
    const res = await Promise.all(reqs);
    const ok = res.every((r) => r === 'granted');
    return { ok, detail: res.join(',') };
  } catch (e) {
    return { ok: false, detail: (e as Error).message || 'permission error' };
  }
}

export class MotionSource {
  private ori: [number, number, number] = [0, 0, 0];
  private seq = 0;
  lastEventAt = 0;
  bail = false;
  running = false;
  minIntervalMs = 8; // cap ~120 Hz; iOS delivers ~60 Hz, so normally every event is sent
  private lastSent = 0;
  constructor(private onFrame: (f: Frame) => void) {}
  private onMotion = (e: DeviceMotionEvent) => {
    const t = nowMs();
    this.lastEventAt = t;
    if (t - this.lastSent < this.minIntervalMs) return;
    this.lastSent = t;
    const rr = e.rotationRate, a = e.acceleration && e.acceleration.x !== null ? e.acceleration : e.accelerationIncludingGravity;
    this.onFrame({
      seq: ++this.seq, tPad: t,
      rr: [rr?.alpha ?? 0, rr?.beta ?? 0, rr?.gamma ?? 0],
      acc: [a?.x ?? 0, a?.y ?? 0, a?.z ?? 0],
      ori: this.ori, bail: this.bail,
    });
  };
  private onOri = (e: DeviceOrientationEvent) => { this.ori = [e.alpha ?? 0, e.beta ?? 0, e.gamma ?? 0]; };
  get orientation() { return this.ori; }
  start() {
    if (this.running) return;
    this.running = true;
    window.addEventListener('devicemotion', this.onMotion);
    window.addEventListener('deviceorientation', this.onOri);
  }
  stop() {
    this.running = false;
    window.removeEventListener('devicemotion', this.onMotion);
    window.removeEventListener('deviceorientation', this.onOri);
  }
  /** True if motion events have arrived within `ms`. */
  alive(ms = 1000) { return nowMs() - this.lastEventAt < ms; }
}
