// Live gyro meter (Mac HUD and phone): one bar per rotation axis, threshold lines, swing phase.
// Plain 2D canvas, original to the Bass Cast spike.
import { DET, type CastDetector } from './cast-detect';

const RANGE = 700; // deg/s at the bar ends
const HARD = 500; // relaxed-cast ceiling for the retest rule

export class GyroMeter {
  private g: CanvasRenderingContext2D;
  private hold: [number, number, number] = [0, 0, 0];
  constructor(private c: HTMLCanvasElement) { this.g = c.getContext('2d')!; }

  draw(d: CastDetector) {
    const c = this.c, g = this.g;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const W = c.clientWidth || 260, H = c.clientHeight || 96;
    if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(8,20,16,.72)'; g.fillRect(0, 0, W, H);
    const lock = d.active;
    const rr = d.live.rr;
    const top = 18, rowH = (H - top - 6) / 3, x0 = 26, x1 = W - 8, mid = (x0 + x1) / 2;
    const X = (v: number) => mid + (Math.max(-RANGE, Math.min(RANGE, v)) / RANGE) * (x1 - mid);
    g.font = '11px system-ui, sans-serif'; g.textBaseline = 'middle';
    const ph = d.phase === 'back' ? 'BACKSWING' : d.phase === 'fwd' ? 'FLICK!' : d.phase === 'armed' ? 'button held' : d.phase === 'cooldown' ? 'cast' : 'ready — just swing';
    g.fillStyle = d.phase === 'fwd' ? '#ffd166' : d.phase === 'back' ? '#7fd1ff' : '#cfe';
    g.fillText(`${ph}`, 6, 9);
    g.fillStyle = '#9bb'; g.textAlign = 'right';
    g.fillText(`axis ${'XYZ'[lock.axis]}${lock.sign > 0 ? '+' : '−'} ${d.learned ? (d.override ? '(manual)' : '(learned)') : '(auto)'}`, W - 6, 9);
    g.textAlign = 'left';
    for (let i = 0; i < 3; i++) {
      const y = top + i * rowH, cy = y + rowH / 2, bh = Math.max(6, rowH - 8);
      this.hold[i] = Math.max(Math.abs(rr[i]), this.hold[i] * 0.97);
      g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(x0, cy - bh / 2, x1 - x0, bh);
      const active = i === lock.axis;
      const v = rr[i];
      // Colour by meaning on the swing axis: backswing blue, flick amber, over 500 red.
      const w = active ? v * lock.sign : 0;
      g.fillStyle = Math.abs(v) > HARD ? '#ff5a5a' : !active ? '#6a8' : w > 0 ? '#5bc0ff' : '#ffb547';
      g.fillRect(Math.min(mid, X(v)), cy - bh / 2, Math.abs(X(v) - mid), bh);
      g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(X(this.hold[i] * Math.sign(v || 1)) - 1, cy - bh / 2, 2, bh);
      g.fillStyle = active ? '#fff' : '#9bb'; g.fillText('XYZ'[i], 8, cy);
      if (active) {
        // threshold lines: backswing on the +sign side, flick on the other
        const line = (val: number, col: string) => { g.fillStyle = col; g.fillRect(X(val) - 1, cy - bh / 2 - 2, 2, bh + 4); };
        line(DET.back * lock.sign, '#5bc0ff');
        line(-DET.fwd * lock.sign, '#ffb547');
      }
      const hard = (val: number) => { g.fillStyle = 'rgba(255,90,90,.6)'; g.fillRect(X(val), cy - bh / 2, 1, bh); };
      hard(HARD); hard(-HARD);
    }
  }
}
