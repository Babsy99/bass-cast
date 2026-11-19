// Lure ballistics + re-export of the shared motion detector. Original to the Bass Cast spike.
export * from '../../shared/cast-detect';
import { TIMING_WINDOW } from '../../shared/cast-detect';

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
    const l = Math.min(1, (p.dt - TIMING_WINDOW.late) / (TIMING_WINDOW.lateMax - TIMING_WINDOW.late));
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

/** Power (good timing, zero aim) that lands at `ft`; bisection on the ballistic sim. */
export function powerForFeet(ft: number) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 22; i++) { const m = (lo + hi) / 2; if (simulate({ power: m, dt: 30, aim: 0 }).distFt < ft) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
