// NTP-style clock sync: offset = padClock - hostClock.
// Method: a burst of 10 ping/pong samples; keep the 5 with the lowest RTT; offset = median of their offsets.
import { median } from './stats';

export interface ClockSample { rtt: number; offset: number; at: number }

export class ClockSync {
  offset = 0; // pad - host, ms
  synced = false;
  lastBurst: ClockSample[] = [];
  history: { at: number; offset: number; bestRtt: number; n: number }[] = [];
  private pending: ClockSample[] = [];

  /** h0 = host send time, p1 = pad receive/reply time, h3 = host receive time (all epoch ms). */
  static sample(h0: number, p1: number, h3: number): ClockSample {
    const rtt = h3 - h0;
    return { rtt, offset: p1 - (h0 + h3) / 2, at: h3 };
  }

  addBurstSample(s: ClockSample, burstSize = 10): boolean {
    this.pending.push(s);
    if (this.pending.length < burstSize) return false;
    this.finishBurst();
    return true;
  }

  finishBurst() {
    if (!this.pending.length) return;
    const best = [...this.pending].sort((a, b) => a.rtt - b.rtt).slice(0, 5);
    this.offset = median(best.map((b) => b.offset));
    this.synced = true;
    this.lastBurst = this.pending;
    this.history.push({ at: Date.now(), offset: this.offset, bestRtt: best[0].rtt, n: this.pending.length });
    if (this.history.length > 200) this.history.shift();
    this.pending = [];
  }

  resetPending() { this.pending = []; }

  /** Convert a pad timestamp to host time. */
  toHost(tPad: number) { return tPad - this.offset; }
}
