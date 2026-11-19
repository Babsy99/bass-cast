// Keyless public MQTT-over-WSS relay used only when WebRTC is not up (or drops).
// Topic is derived from the session code by hash; every payload is AES-GCM sealed and HMAC-tagged.
import mqtt from 'mqtt';
import { mqttBrokers } from './protocol';
import type { Envelope, Sealer } from './crypto';

type Handler = (env: Envelope) => void | Promise<void>;

export class MqttRelay {
  client: mqtt.MqttClient | null = null;
  connected = false;
  brokerUrl = '';
  private brokerIdx = 0;
  private counter = 0;
  private seen = new Map<string, number>();
  onStatus: (connected: boolean) => void = () => {};

  constructor(private topicIn: string, private topicOut: string, private sender: string, private onEnv: Handler) {}

  start() {
    this.connect();
  }

  private connect() {
    const list = mqttBrokers();
    const url = list[this.brokerIdx % list.length];
    this.brokerUrl = url;
    const c = mqtt.connect(url, {
      clientId: 'bcs_' + Math.random().toString(36).slice(2, 12),
      clean: true,
      connectTimeout: 4000,
      reconnectPeriod: 1500,
      keepalive: 20,
      protocolVersion: 4,
    });
    this.client = c;
    let everConnected = false;
    c.on('connect', () => {
      everConnected = true;
      this.connected = true;
      c.subscribe(this.topicIn, { qos: 0 });
      this.onStatus(true);
    });
    c.on('close', () => {
      if (this.connected) { this.connected = false; this.onStatus(false); }
    });
    c.on('error', () => {});
    c.on('offline', () => {
      // Rotate to the next public broker if this one never came up.
      if (!everConnected) { c.end(true); this.brokerIdx++; setTimeout(() => this.connect(), 300); }
    });
    c.on('message', (_t, buf) => {
      let env: Envelope;
      try { env = JSON.parse(new TextDecoder().decode(buf)); } catch { return; }
      if (!env || typeof env.s !== 'string' || typeof env.n !== 'number' || env.s === this.sender) return;
      const last = this.seen.get(env.s) ?? -1;
      if (env.n <= last) return; // replay / duplicate
      this.seen.set(env.s, env.n);
      // Decrypt/verify is async: process strictly in arrival order so frames and events never reorder.
      this.rx = this.rx.then(() => this.onEnv(env)).catch(() => {});
    });
  }

  private chain: Promise<unknown> = Promise.resolve();
  private rx: Promise<unknown> = Promise.resolve();
  /** Sends are serialized so sealing (async WebCrypto) can never reorder messages. */
  send(sealer: Sealer, payload: unknown): Promise<boolean> {
    if (!this.client || !this.connected) return Promise.resolve(false);
    const n = ++this.counter;
    const p = this.chain.then(async () => {
      const env = await sealer.seal(this.sender, n, payload);
      if (!this.client || !this.connected) return false;
      this.client.publish(this.topicOut, JSON.stringify(env), { qos: 0 });
      return true;
    }).catch(() => false);
    this.chain = p;
    return p;
  }

  stop() {
    this.client?.end(true);
    this.client = null;
    this.connected = false;
  }
}
