// Touch / mouse cast fallback: drag back (down), then flick forward (up) and let go.
// Produces the same normalized cast parameters as the motion detector.
export interface TouchCastResult { power: number; aim: number; dt: number; tFlick: number; tRel: number; peakV: number; lenN: number; speedN: number }

/** Touch power: speed and drag length together, eased. Old curve saturated at speed 3.6 (field test: 8 of 10 normal flicks hit 100%).
 *  Now a normal flick (speed ~4.5, ~35% of the pad height) ~ 65%; 100% needs a long (90% of pad) AND fast (8) drag. */
export const TOUCH = { vFull: 8.0, lFull: 0.9, wV: 0.55, wL: 0.45, ease: 0.6, cap: 1 };
export function touchPower(speedN: number, lenN: number) {
  const s = TOUCH.wV * Math.min(1, speedN / TOUCH.vFull) + TOUCH.wL * Math.min(1, lenN / TOUCH.lFull);
  return Math.min(TOUCH.cap, Math.pow(Math.max(0, s), TOUCH.ease));
}

interface P { x: number; y: number; t: number }

export class TouchCaster {
  private pts: P[] = [];
  private active = false;
  private maxDown = 0;
  constructor(private el: HTMLElement, private clock: () => number, private onCast: (r: TouchCastResult) => void,
    private onDown: () => void = () => {}) {
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', () => { this.active = false; });
  }
  enabled = true;
  private down(e: PointerEvent) {
    if (!this.enabled) return;
    this.active = true;
    this.pts = [{ x: e.clientX, y: e.clientY, t: this.clock() }];
    this.maxDown = 0;
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.onDown();
  }
  private move(e: PointerEvent) {
    if (!this.active) return;
    const p = { x: e.clientX, y: e.clientY, t: this.clock() };
    this.pts.push(p);
    this.maxDown = Math.max(this.maxDown, p.y - this.pts[0].y);
    if (this.pts.length > 400) this.pts.shift();
  }
  private up(e: PointerEvent) {
    if (!this.active) return;
    this.active = false;
    const tRel = this.clock();
    this.pts.push({ x: e.clientX, y: e.clientY, t: tRel });
    const r = TouchCaster.analyze(this.pts, this.maxDown, tRel, Math.max(320, this.el.clientHeight));
    if (r) this.onCast(r);
  }
  /** Pure function so it can be unit-tested. */
  static analyze(pts: P[], maxDown: number, tRel: number, scalePx: number): TouchCastResult | null {
    if (pts.length < 3 || maxDown < 20) return null; // needs a back-drag first
    let peakV = 0, tFlick = tRel, dirX = 0, dirY = -1;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 3)], b = pts[i];
      const dt = Math.max(1, b.t - a.t);
      const vy = -(b.y - a.y) / dt; // upward px/ms
      if (vy > peakV) { peakV = vy; tFlick = b.t; dirX = b.x - a.x; dirY = b.y - a.y; }
    }
    const norm = peakV / Math.max(1, scalePx / 480); // roughly screen-size independent (px/ms per 480 px)
    let lowY = -Infinity; for (const p of pts) lowY = Math.max(lowY, p.y);
    const lenN = Math.max(0, lowY - pts[pts.length - 1].y) / Math.max(1, scalePx); // upward travel from the lowest point
    if (norm < 0.3 || lenN < 0.05) return null;
    const power = touchPower(norm, lenN);
    const aim = Math.max(-35, Math.min(35, (Math.atan2(dirX, -dirY) * 180) / Math.PI));
    return { power, aim, dt: tRel - tFlick, tFlick, tRel, peakV: norm, lenN, speedN: norm };
  }
}
