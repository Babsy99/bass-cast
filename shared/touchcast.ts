// Touch / mouse cast fallback: drag back (down), then flick forward (up) and let go.
// Produces the same normalized cast parameters as the motion detector.
export interface TouchCastResult { power: number; aim: number; dt: number; tFlick: number; tRel: number; peakV: number }

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
    const norm = peakV / Math.max(1, scalePx / 480); // roughly screen-size independent
    const power = Math.max(0, Math.min(1, (norm - 0.4) / 3.2));
    if (power <= 0) return null;
    const aim = Math.max(-35, Math.min(35, (Math.atan2(dirX, -dirY) * 180) / Math.PI));
    return { power, aim, dt: tRel - tFlick, tFlick, tRel, peakV: norm };
  }
}
