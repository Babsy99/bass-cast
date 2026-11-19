// Procedural WebAudio sounds (no sample files): bail click, whoosh, line zing, splash, chimes.
export class Sfx {
  ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  get suspended() { return !this.ctx || this.ctx.state !== 'running'; }
  unlock() {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        const len = this.ctx.sampleRate * 1.5;
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state !== 'running') void this.ctx.resume();
    } catch { /* no audio */ }
  }
  private noiseBurst(dur: number, f0: number, f1: number, q: number, gain: number, type: BiquadFilterType = 'bandpass') {
    const c = this.ctx; if (!c || !this.noise || c.state !== 'running') return;
    const src = c.createBufferSource(); src.buffer = this.noise;
    const bp = c.createBiquadFilter(); bp.type = type; bp.Q.value = q;
    const g = c.createGain();
    const t = c.currentTime;
    bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.2); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(c.destination);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
  }
  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', when = 0) {
    const c = this.ctx; if (!c || c.state !== 'running') return;
    const o = c.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = c.createGain(); const t = c.currentTime + when;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  click() { this.tone(2200, 0.03, 0.15, 'square'); }
  whoosh(power: number) { this.noiseBurst(0.35, 400, 2400 + power * 2000, 1.2, 0.25 + power * 0.3); }
  zing(dur: number) { this.noiseBurst(Math.min(2.5, dur), 5200, 2600, 6, 0.08); }
  splash(size: number) { this.noiseBurst(0.6, 1800, 300, 0.7, 0.3 + size * 0.3, 'lowpass'); this.tone(180, 0.15, 0.12, 'sine'); }
  good() { this.tone(660, 0.12, 0.12); this.tone(990, 0.18, 0.1, 'sine', 0.1); }
  bad() { this.tone(240, 0.22, 0.12, 'triangle'); }
}
