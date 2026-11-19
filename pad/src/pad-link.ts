// Pad side of the link: WebRTC via PeerJS first; after 3 s (or on any drop) relay over keyless MQTT.
import Peer, { type DataConnection } from 'peerjs';
import { ICE_SERVERS, PEER_BROKER, PROTOCOL_VERSION, RTC_GRACE_MS, nowMs, type Msg } from '../../shared/protocol';
import { deriveIds, hmacB64, b64url, randomBytes, Sealer, type Envelope, type SessionIds } from '../../shared/crypto';
import { MqttRelay } from '../../shared/mqtt-relay';
import { patchUnreliableChannels, classifyPath, MOTION_LABEL_PREFIX, EVENT_LABEL_PREFIX } from '../../shared/rtc-patch';

export interface Pairing { pid: string; sec: string }
export type PadState = 'idle' | 'connecting' | 'live' | 'rejected';

export class PadLink {
  ids!: SessionIds;
  pairing: Pairing | null = null;
  state: PadState = 'idle';
  rtcReady = false;
  mqttReady = false;
  rtcPath: string | null = null;
  rejectWhy = '';
  rttHalf = NaN;
  allowRtc = true;
  onState: () => void = () => {};
  onMsg: (m: Msg) => void = () => {};
  onLive: (via: string) => void = () => {};
  private boot = b64url(randomBytes(6));
  private pendingPid = b64url(randomBytes(9));
  private pendingSec = b64url(randomBytes(16)); // 128-bit per-pad secret, created on this phone
  private peer: Peer | null = null;
  private evt: DataConnection | null = null;
  private mot: DataConnection | null = null;
  private mqtt: MqttRelay | null = null;
  private codeSealer!: Sealer;
  private padSealer: Sealer | null = null;
  private mqttJoinPending = false;
  private graceTimer = 0;
  private rtcRetry = 0;
  private lastHostPing = 0;
  private rtcAttempt = 0;

  constructor(public code: string) {}

  get storageKey() { return 'bcs.pair.' + this.ids.hostPeerId; }
  get via() { return this.rtcReady ? (this.rtcPath || 'webrtc') : this.mqttReady ? 'mqtt-relay' : 'none'; }
  get live() { return this.rtcReady || this.mqttReady; }

  async init(hashPairing: Pairing | null) {
    patchUnreliableChannels();
    this.ids = await deriveIds(this.code);
    this.codeSealer = await Sealer.create('c', this.code);
    let p: Pairing | null = null;
    try { p = JSON.parse(localStorage.getItem(this.storageKey) || 'null'); } catch { /* ignore */ }
    // Camera-scan pages may open in a separate Safari context with empty storage: the URL fragment also carries the pairing.
    this.pairing = p || hashPairing;
    if (this.pairing) { this.padSealer = await Sealer.create('p', this.pairing.sec); this.pendingPid = this.pairing.pid; }
  }

  start() {
    this.state = 'connecting';
    this.onState();
    if (this.allowRtc) this.startRtc();
    this.startMqtt();
    this.armGrace();
    setInterval(() => this.watch(), 500);
  }

  private armGrace() {
    clearTimeout(this.graceTimer);
    this.graceTimer = window.setTimeout(() => { if (!this.rtcReady) this.useMqtt(); }, this.allowRtc ? RTC_GRACE_MS : 0);
  }

  // ---------------- WebRTC ----------------
  private startRtc() {
    if (!this.allowRtc) return;
    this.teardownRtc();
    const attempt = ++this.rtcAttempt;
    const peer = new Peer({ ...PEER_BROKER, config: { iceServers: ICE_SERVERS }, debug: 1 });
    this.peer = peer;
    peer.on('open', () => {
      if (attempt !== this.rtcAttempt) return;
      const evt = peer.connect(this.ids.hostPeerId, { label: EVENT_LABEL_PREFIX + this.boot, reliable: true, serialization: 'json' });
      const mot = peer.connect(this.ids.hostPeerId, { label: MOTION_LABEL_PREFIX + this.boot, reliable: false, serialization: 'raw' });
      this.evt = evt; this.mot = mot;
      evt.on('open', () => evt.send({ t: 'hello', v: PROTOCOL_VERSION, boot: this.boot } satisfies Msg));
      evt.on('data', (d) => this.onRtcMsg(d as Msg, attempt));
      const gone = () => { if (attempt === this.rtcAttempt) this.rtcDown('channel closed'); };
      evt.on('close', gone); mot.on('close', gone); evt.on('error', gone);
    });
    peer.on('error', (e: any) => { if (attempt === this.rtcAttempt) this.rtcDown('peer error: ' + (e?.type || '')); });
    peer.on('disconnected', () => { /* signaling socket dropped; data channels may still be alive */ });
  }

  private teardownRtc() {
    try { this.evt?.close(); this.mot?.close(); } catch { /* ignore */ }
    try { this.peer?.destroy(); } catch { /* ignore */ }
    this.evt = this.mot = null; this.peer = null;
  }

  private rtcDown(why: string) {
    const was = this.rtcReady;
    this.rtcReady = false; this.rtcPath = null;
    this.teardownRtc();
    if (was) console.info('[pad] WebRTC down:', why);
    if (this.state !== 'rejected') {
      this.useMqtt(); // relay immediately on a drop
      clearTimeout(this.rtcRetry);
      this.rtcRetry = window.setTimeout(() => this.startRtc(), was ? 800 : 2500);
    }
    this.onState();
  }

  private async onRtcMsg(m: Msg, attempt: number) {
    if (attempt !== this.rtcAttempt || !m) return;
    if (m.t === 'chal') { this.evt?.send(await this.authMsg(m.n)); return; }
    if (m.t === 'ok') {
      await this.savePairing();
      this.rtcReady = true;
      this.lastHostPing = nowMs();
      this.state = 'live';
      classifyPath(this.evt?.peerConnection).then((p) => { this.rtcPath = p; this.onState(); });
      this.onLive('webrtc');
      this.onState();
      return;
    }
    if (m.t === 'reject') { this.rejected(m.why); return; }
    this.handle(m, 'rtc');
  }

  private async authMsg(nonce: string): Promise<Msg> {
    if (this.pairing) return { t: 'auth', pid: this.pairing.pid, mac: await hmacB64(this.pairing.sec, nonce + '|rejoin') };
    return { t: 'join', pid: this.pendingPid, sec: this.pendingSec, proof: await hmacB64(this.code, nonce + '|join') };
  }

  private async savePairing() {
    if (this.pairing) return;
    this.pairing = { pid: this.pendingPid, sec: this.pendingSec };
    this.padSealer = await Sealer.create('p', this.pairing.sec);
    localStorage.setItem(this.storageKey, JSON.stringify(this.pairing));
    localStorage.setItem('bcs.lastCode', this.code);
    // Keep the pairing in the URL fragment too (never sent to the server).
    const h = new URLSearchParams(location.hash.slice(1));
    h.set('s', this.code); h.set('p', `${this.pairing.pid}.${this.pairing.sec}`);
    history.replaceState(null, '', '#' + h.toString());
  }

  private rejected(why: string) {
    this.rejectWhy = why;
    this.state = 'rejected';
    this.rtcReady = this.mqttReady = false;
    this.teardownRtc(); this.mqtt?.stop();
    clearTimeout(this.rtcRetry);
    this.onState();
  }

  // ---------------- MQTT relay ----------------
  private startMqtt() {
    this.mqtt = new MqttRelay(this.ids.topic + '/h', this.ids.topic + '/p', this.pendingPid + ':' + this.boot, (e) => this.onEnv(e));
    this.mqtt.onStatus = (ok) => { if (ok && !this.rtcReady && this.wantMqtt) this.useMqtt(); if (!ok) { this.mqttReady = false; this.onState(); } };
    this.mqtt.start();
  }

  private wantMqtt = false;
  private async useMqtt() {
    if (this.state === 'rejected') return;
    this.wantMqtt = true;
    if (!this.mqtt?.connected) return; // will retry on connect
    if (this.pairing && this.padSealer) {
      if (!this.mqttReady) {
        this.mqttReady = true; this.state = 'live';
        await this.mqtt.send(this.padSealer, { t: 'pong', id: -1, h0: 0, p1: nowMs() } satisfies Msg); // announce
        this.onLive('mqtt-relay');
        this.onState();
      }
      return;
    }
    if (this.mqttJoinPending) return;
    this.mqttJoinPending = true;
    await this.mqtt.send(this.codeSealer, { t: 'hello', v: PROTOCOL_VERSION, boot: this.boot } satisfies Msg);
    setTimeout(() => { this.mqttJoinPending = false; if (!this.live && this.state !== 'rejected') this.useMqtt(); }, 4000);
  }

  private async onEnv(env: Envelope) {
    if (env.k === 'c') {
      const m = (await this.codeSealer.open(env)) as Msg | null;
      if (!m) return;
      if (m.t === 'chal' && this.mqttJoinPending) await this.mqtt!.send(this.codeSealer, await this.authMsg(m.n));
      else if (m.t === 'ok' && this.mqttJoinPending) {
        this.mqttJoinPending = false;
        await this.savePairing();
        this.mqttReady = true; this.state = 'live';
        this.onLive('mqtt-relay'); this.onState();
      } else if (m.t === 'reject' && this.mqttJoinPending) this.rejected(m.why);
      return;
    }
    if (!this.padSealer) return;
    const m = (await this.padSealer.open(env)) as Msg | null;
    if (m) this.handle(m, 'mqtt');
  }

  // ---------------- common ----------------
  private handle(m: Msg, via: 'rtc' | 'mqtt') {
    if (m.t === 'ping') {
      if (via === 'rtc') this.lastHostPing = nowMs();
      const pong: Msg = { t: 'pong', id: m.id, h0: m.h0, p1: nowMs() };
      if (via === 'rtc') this.evt?.send(pong); else if (this.padSealer) void this.mqtt?.send(this.padSealer, pong);
      return;
    }
    this.onMsg(m);
  }

  sendFrame(s: string) {
    if (this.rtcReady && this.mot?.open) { this.mot.send(s); return; }
    if (this.mqttReady && this.padSealer) void this.mqtt!.send(this.padSealer, { t: 'mframe', f: s } satisfies Msg);
  }

  sendEvt(m: Msg) {
    if (this.rtcReady && this.evt?.open) { this.evt.send(m); return; }
    if (this.mqttReady && this.padSealer) void this.mqtt!.send(this.padSealer, m);
  }

  /** Called on visibilitychange -> visible, pageshow, online. */
  wake() {
    if (this.state === 'rejected') return;
    const stale = !this.rtcReady || !this.peer || this.peer.destroyed || nowMs() - this.lastHostPing > 2500;
    if (stale && this.allowRtc) { this.rtcReady = false; this.startRtc(); }
    if (!this.rtcReady) this.useMqtt();
    this.armGrace();
    this.onState();
  }

  private watch() {
    // A data channel can look open after iOS sleep while being dead: no host ping for 3 s => rebuild.
    if (this.rtcReady && nowMs() - this.lastHostPing > 3000) this.rtcDown('no host ping for 3 s');
  }

  /** Test hook: hard-kill the WebRTC side. */
  killRtc() { this.rtcDown('killed by test'); }
}
