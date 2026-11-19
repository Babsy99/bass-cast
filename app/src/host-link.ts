// Host side of the pad link: PeerJS (WebRTC DataChannels) first, keyless MQTT relay as fallback.
// Owns session-code lifecycle, single-pad pairing, clock sync and latency sampling.
import Peer, { type DataConnection } from 'peerjs';
import {
  ICE_SERVERS, PEER_BROKER, CODE_TTL_MS, nowMs, unpackFrame, brokerOverride,
  type Frame, type Msg, type Path,
} from '../../shared/protocol';
import { newSessionCode, isValidCode, deriveIds, hmacB64, macEq, b64url, randomBytes, Sealer, type Envelope, type SessionIds } from '../../shared/crypto';
import { ClockSync } from '../../shared/clock';
import { MqttRelay } from '../../shared/mqtt-relay';
import { patchUnreliableChannels, classifyPath, MOTION_LABEL_PREFIX, EVENT_LABEL_PREFIX } from '../../shared/rtc-patch';

export type LinkStatus = 'starting' | 'waiting' | 'paired' | 'paused' | 'lost';

interface PadRecord { pid: string; sec: string }
interface RtcPair { boot: string; evt?: DataConnection; mot?: DataConnection; authed: boolean; nonce: string; path: Path | null }

export interface LatencySample { at: number; rttHalf: number; path: Path | null }

const SS_KEY = 'bcs.host.session';

export class HostLink {
  code = '';
  ids!: SessionIds;
  codeUsed = false;
  codeShownAt = 0;
  pad: PadRecord | null = null;
  status: LinkStatus = 'starting';
  path: Path | null = null;
  rtcPath: Path | null = null;
  icePair: import('../../shared/rtc-patch').IcePair | null = null;
  clock = new ClockSync();
  rttHalf = NaN;
  deliveryAge = NaN;
  latencyLog: LatencySample[] = [];
  ageLog: { at: number; age: number; path: Path }[] = [];
  events: { at: string; line: string }[] = [];
  lastFrameAt = 0;
  lastPauseAt = 0;
  lostSince = 0;
  reconnects: { at: string; hostGapMs: number; padReconnectMs: number | null; via: string }[] = [];
  brokerOk = false;
  onFrame: (f: Frame, th: number, path: Path) => void = () => {};
  onMsg: (m: Msg, path: Path) => void = () => {};
  onChange: () => void = () => {};
  onPaired: (first: boolean) => void = () => {};
  onRejected: (why: string) => void = () => {};

  private peer: Peer | null = null;
  private pairs = new Map<string, RtcPair>();
  private active: RtcPair | null = null;
  private mqtt: MqttRelay | null = null;
  private codeSealer!: Sealer;
  private padSealer: Sealer | null = null;
  private mqttAuthNonce = '';
  private mqttLastAt = 0;
  private pingId = 0;
  private pingSent = new Map<number, { h0: number; burst: boolean }>();
  private burstLeft = 0;
  private timers: number[] = [];
  private pausedFlag = false;

  log(line: string) {
    const at = new Date().toISOString();
    this.events.push({ at, line });
    if (this.events.length > 500) this.events.shift();
    console.info('[link]', line);
    this.onChange();
  }

  /** New game launch = new code. A webview reload keeps the session (sessionStorage), a relaunch does not. */
  async start(forceNew = false) {
    patchUnreliableChannels();
    let saved: { code: string; used: boolean; pad: PadRecord | null; shownAt: number } | null = null;
    try { saved = JSON.parse(sessionStorage.getItem(SS_KEY) || 'null'); } catch { /* ignore */ }
    if (!forceNew && saved && isValidCode(saved.code) && (saved.used || Date.now() - saved.shownAt < CODE_TTL_MS)) {
      this.code = saved.code; this.codeUsed = saved.used; this.pad = saved.pad;
    } else {
      this.code = newSessionCode(); this.codeUsed = false; this.pad = null;
    }
    this.ids = await deriveIds(this.code);
    this.codeSealer = await Sealer.create('c', this.code);
    if (this.pad) this.padSealer = await Sealer.create('p', this.pad.sec);
    this.persist();
    this.status = this.pad ? 'lost' : 'waiting';
    this.startPeer();
    this.startMqtt();
    this.timers.push(window.setInterval(() => this.tick(), 1000));
    this.timers.push(window.setInterval(() => this.startBurst(), 10000));
    this.timers.push(window.setInterval(() => this.watchdog(), 250));
    this.log(`session ${this.ids.tag} ready (code ${this.codeUsed ? 'used' : 'fresh'})`);
  }

  private persist() {
    sessionStorage.setItem(SS_KEY, JSON.stringify({ code: this.code, used: this.codeUsed, pad: this.pad, shownAt: this.codeShownAt || Date.now() }));
  }

  markQrShown() { this.codeShownAt = Date.now(); this.persist(); }

  padUrl(base: string) {
    const u = new URL(base);
    const m = brokerOverride();
    u.hash = 's=' + this.code + (m ? '&m=' + encodeURIComponent(m) : '');
    return u.toString();
  }

  /** Throw away the current pairing and start a new single-use code. */
  async newSession() {
    this.stop();
    sessionStorage.removeItem(SS_KEY);
    this.pairs.clear(); this.active = null; this.padSealer = null; this.path = null; this.rtcPath = null;
    this.clock = new ClockSync();
    await this.start(true);
  }

  stop() {
    this.timers.forEach((t) => clearInterval(t)); this.timers = [];
    try { this.peer?.destroy(); } catch { /* ignore */ }
    this.peer = null;
    this.mqtt?.stop(); this.mqtt = null;
  }

  // ---------------- WebRTC via PeerJS ----------------
  private startPeer(attempt = 0) {
    const peer = new Peer(this.ids.hostPeerId, { ...PEER_BROKER, config: { iceServers: ICE_SERVERS }, debug: 1 });
    this.peer = peer;
    peer.on('open', () => { this.brokerOk = true; this.log('signaling broker connected'); this.onChange(); });
    peer.on('connection', (c) => this.onConn(c));
    peer.on('disconnected', () => { this.brokerOk = false; this.onChange(); setTimeout(() => { if (this.peer === peer && !peer.destroyed) peer.reconnect(); }, 1000); });
    peer.on('error', (e: any) => {
      const t = e?.type || 'error';
      if (t === 'unavailable-id') {
        // Old tab still registered at the broker after a reload: retry shortly.
        peer.destroy();
        if (this.peer === peer) setTimeout(() => this.startPeer(attempt + 1), Math.min(4000, 800 * (attempt + 1)));
      } else if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') {
        this.brokerOk = false; this.onChange();
        if (this.peer === peer) { peer.destroy(); setTimeout(() => this.startPeer(attempt + 1), 2000); }
      }
    });
    window.addEventListener('pagehide', () => peer.destroy(), { once: true });
  }

  private onConn(c: DataConnection) {
    const label = c.label || '';
    const isEvt = label.startsWith(EVENT_LABEL_PREFIX), isMot = label.startsWith(MOTION_LABEL_PREFIX);
    if (!isEvt && !isMot) { c.close(); return; }
    const boot = label.slice(5, 40);
    let pr = this.pairs.get(boot);
    if (!pr) { pr = { boot, authed: false, nonce: '', path: null }; this.pairs.set(boot, pr); }
    const p = pr;
    if (isEvt) p.evt = c; else p.mot = c;
    c.on('open', () => {
      if (isEvt) {
        // Close unauthenticated connections after 4 s.
        setTimeout(() => { if (!p.authed) { c.close(); p.mot?.close(); this.pairs.delete(boot); } }, 4000);
      }
    });
    c.on('data', (d: unknown) => {
      if (isMot) {
        if (!p.authed || this.active !== p) return;
        const f = unpackFrame(d as string);
        if (f) this.handleFrame(f, p.path || this.rtcPath || 'direct');
      } else this.handleRtcMsg(p, d as Msg);
    });
    const onGone = () => {
      if (this.active === p && (p.evt === c || p.mot === c)) {
        this.active = null; this.rtcPath = null;
        this.log('WebRTC channel closed');
        this.onChange();
      }
      if (!p.evt?.open && !p.mot?.open) this.pairs.delete(boot);
    };
    c.on('close', onGone);
    c.on('error', onGone);
  }

  private async handleRtcMsg(p: RtcPair, m: Msg) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') {
      p.nonce = b64url(randomBytes(16));
      p.evt?.send({ t: 'chal', n: p.nonce } satisfies Msg);
      return;
    }
    if (m.t === 'join' || m.t === 'auth') {
      const r = await this.verify(m, p.nonce);
      if (r.ok) {
        p.authed = true;
        // Only one controller: drop any other live connection.
        for (const [b, o] of this.pairs) if (o !== p) { o.evt?.close(); o.mot?.close(); this.pairs.delete(b); }
        this.active = p;
        p.evt?.send({ t: 'ok', first: r.first } satisfies Msg);
        this.log(`pad ${r.first ? 'paired' : 'rejoined'} over WebRTC`);
        this.afterAuth(r.first);
        classifyPath(p.evt?.peerConnection).then((c) => { p.path = c?.path || 'p2p-nat'; this.rtcPath = p.path; this.icePair = c?.pair ?? null; this.log(`WebRTC path: ${p.path}` + (c ? ` (local ${c.pair.local}/${c.pair.localAddrKind}, remote ${c.pair.remote}/${c.pair.remoteAddrKind}, ${c.pair.protocol})` : '')); this.onChange(); });
      } else {
        p.evt?.send({ t: 'reject', why: r.why } satisfies Msg);
        this.log(`REJECTED join over WebRTC: ${r.why}`);
        this.onRejected(r.why);
        setTimeout(() => { p.evt?.close(); p.mot?.close(); }, 300);
      }
      return;
    }
    if (!p.authed || this.active !== p) return;
    this.handleMsg(m, p.path || 'direct');
  }

  private async verify(m: Msg, nonce: string): Promise<{ ok: true; first: boolean } | { ok: false; why: 'used' | 'expired' | 'bad' | 'unknown' }> {
    if (!nonce) return { ok: false, why: 'bad' };
    if (m.t === 'join') {
      const proof = await hmacB64(this.code, nonce + '|join');
      if (!macEq(proof, m.proof)) return { ok: false, why: 'bad' };
      if (this.codeUsed) {
        // The same pad repeating its first join (e.g. lost 'ok') is fine.
        if (this.pad && this.pad.pid === m.pid && this.pad.sec === m.sec) return { ok: true, first: false };
        return { ok: false, why: 'used' };
      }
      if (this.codeShownAt && Date.now() - this.codeShownAt > CODE_TTL_MS) return { ok: false, why: 'expired' };
      if (typeof m.sec !== 'string' || m.sec.length < 22 || typeof m.pid !== 'string') return { ok: false, why: 'bad' };
      this.codeUsed = true;
      this.pad = { pid: m.pid, sec: m.sec };
      this.padSealer = await Sealer.create('p', m.sec);
      this.persist();
      return { ok: true, first: true };
    }
    if (m.t === 'auth') {
      if (!this.pad || m.pid !== this.pad.pid) return { ok: false, why: 'unknown' };
      const mac = await hmacB64(this.pad.sec, nonce + '|rejoin');
      if (!macEq(mac, m.mac)) return { ok: false, why: 'unknown' };
      return { ok: true, first: false };
    }
    return { ok: false, why: 'bad' };
  }

  private afterAuth(first: boolean) {
    const wasLost = this.status === 'lost' || this.status === 'paused';
    this.status = 'paired';
    this.pausedFlag = false;
    if (wasLost && this.lostSince) {
      this.reconnects.push({ at: new Date().toISOString(), hostGapMs: Math.round(nowMs() - this.lostSince), padReconnectMs: null, via: this.active ? 'webrtc' : 'mqtt' });
      this.lostSince = 0;
    }
    this.onPaired(first);
    this.startBurst();
    this.onChange();
  }

  // ---------------- MQTT relay ----------------
  private startMqtt() {
    this.mqtt = new MqttRelay(this.ids.topic + '/p', this.ids.topic + '/h', 'host-' + b64url(randomBytes(6)), (env) => this.onEnv(env));
    this.mqtt.onStatus = (ok) => { this.log(`MQTT relay ${ok ? 'connected (' + this.mqtt!.brokerUrl + ')' : 'disconnected'}`); };
    this.mqtt.start();
  }

  private async onEnv(env: Envelope) {
    if (env.k === 'c') {
      const m = (await this.codeSealer.open(env)) as Msg | null;
      if (!m) return;
      if (m.t === 'hello') {
        this.mqttAuthNonce = b64url(randomBytes(16));
        await this.mqtt!.send(this.codeSealer, { t: 'chal', n: this.mqttAuthNonce } satisfies Msg);
      } else if (m.t === 'join' || m.t === 'auth') {
        const r = await this.verify(m, this.mqttAuthNonce);
        this.mqttAuthNonce = '';
        if (r.ok) {
          await this.mqtt!.send(this.codeSealer, { t: 'ok', first: r.first } satisfies Msg);
          this.log(`pad ${r.first ? 'paired' : 'rejoined'} over MQTT relay`);
          this.mqttLastAt = nowMs();
          if (!this.active) this.afterAuth(r.first);
        } else {
          await this.mqtt!.send(this.codeSealer, { t: 'reject', why: r.why } satisfies Msg);
          this.log(`REJECTED join over MQTT: ${r.why}`);
          this.onRejected(r.why);
        }
      }
      return;
    }
    // 'p' envelopes are keyed by the paired pad's own secret: only that pad can produce them.
    if (!this.padSealer || !this.pad || !env.s.startsWith(this.pad.pid + ':')) return;
    const m = (await this.padSealer.open(env)) as Msg | null;
    if (!m) return;
    this.mqttLastAt = nowMs();
    if (this.status !== 'paired' && !this.active && m.t !== 'pause') this.afterAuth(false);
    if (m.t === 'mframe') {
      if (this.active) return; // WebRTC is live; ignore relay duplicates
      const f = unpackFrame(m.f);
      if (f) {
        if (nowMs() - this.clock.toHost(f.tPad) > 5000 && this.clock.synced) return; // stale/replayed
        this.handleFrame(f, 'mqtt-relay');
      }
      return;
    }
    if (this.active && m.t !== 'pong' && m.t !== 'resume' && m.t !== 'pause') return;
    this.handleMsg(m, 'mqtt-relay');
  }

  // ---------------- shared handling ----------------
  private handleFrame(f: Frame, path: Path) {
    const now = nowMs();
    this.lastFrameAt = now;
    if (this.path !== path) { this.path = path; this.log(`active path -> ${path}`); }
    if (this.status !== 'paired') { this.status = 'paired'; this.onChange(); }
    if (this.lostSince) {
      this.reconnects.push({ at: new Date().toISOString(), hostGapMs: Math.round(now - this.lostSince), padReconnectMs: null, via: path });
      this.lostSince = 0;
    }
    const th = this.clock.toHost(f.tPad);
    if (this.clock.synced) {
      this.deliveryAge = now - th;
      this.ageLog.push({ at: Math.round(now), age: Math.round(this.deliveryAge * 10) / 10, path });
      if (this.ageLog.length > 20000) this.ageLog.splice(0, 5000);
    }
    this.onFrame(f, th, path);
  }

  private handleMsg(m: Msg, path: Path) {
    if (m.t === 'pong') {
      const s = this.pingSent.get(m.id);
      if (!s) return;
      this.pingSent.delete(m.id);
      const h3 = nowMs();
      const smp = ClockSync.sample(s.h0, m.p1, h3);
      this.rttHalf = smp.rtt / 2;
      this.latencyLog.push({ at: Math.round(h3), rttHalf: Math.round(this.rttHalf * 10) / 10, path: this.path });
      if (this.latencyLog.length > 20000) this.latencyLog.splice(0, 5000);
      if (s.burst) this.clock.addBurstSample(smp);
      this.onChange();
      return;
    }
    if (m.t === 'pause') {
      this.status = 'paused'; this.pausedFlag = true; this.lastPauseAt = nowMs();
      if (!this.lostSince) this.lostSince = nowMs();
      this.log(`controller paused (${m.why})`);
    }
    if (m.t === 'resume') {
      this.status = 'paired'; this.pausedFlag = false;
      const last = this.reconnects[this.reconnects.length - 1];
      if (last && last.padReconnectMs === null && Date.now() - Date.parse(last.at) < 15000) { last.padReconnectMs = m.reconnectMs; last.via = m.via; }
      else this.reconnects.push({ at: new Date().toISOString(), hostGapMs: this.lostSince ? Math.round(nowMs() - this.lostSince) : 0, padReconnectMs: m.reconnectMs, via: m.via });
      this.lostSince = 0;
      this.log(`controller resumed in ${Math.round(m.reconnectMs)} ms via ${m.via}`);
    }
    this.onMsg(m, path);
    this.onChange();
  }

  send(m: Msg) {
    if (this.active?.evt?.open) { this.active.evt.send(m); return true; }
    if (this.mqtt?.connected && this.padSealer && nowMs() - this.mqttLastAt < 10000) { void this.mqtt.send(this.padSealer, m); return true; }
    return false;
  }

  private ping(burst: boolean) {
    const id = ++this.pingId;
    const h0 = nowMs();
    this.pingSent.set(id, { h0, burst });
    if (this.pingSent.size > 200) { const k = this.pingSent.keys().next().value!; this.pingSent.delete(k); }
    this.send({ t: 'ping', id, h0 });
  }

  /** NTP-style burst: 10 pings, 40 ms apart. ClockSync keeps the lowest-RTT 5 and takes the median offset. */
  startBurst() {
    if (this.status !== 'paired' || this.burstLeft > 0) return;
    this.clock.resetPending();
    this.burstLeft = 10;
    const step = () => {
      if (this.burstLeft <= 0) return;
      this.burstLeft--; this.ping(true);
      if (this.burstLeft > 0) setTimeout(step, 40);
      else setTimeout(() => this.clock.finishBurst(), 1500); // finalize even if some pongs were lost
    };
    step();
  }

  private tick() { if (this.status === 'paired') this.ping(false); }

  private watchdog() {
    const now = nowMs();
    if ((this.status === 'paired') && this.lastFrameAt && now - this.lastFrameAt > 1200 && !this.pausedFlag) {
      this.status = 'lost';
      this.lostSince = this.lastFrameAt;
      this.log('controller signal lost');
      this.onChange();
    }
  }
}
