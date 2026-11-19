// Bass Cast spike — wire protocol shared by the game host (app/) and the phone pad (pad/).
// All names here are original to this project.

export const PROTOCOL_VERSION = 1;

/** Public, keyless infrastructure. No credentials anywhere. */
export const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
export const PEER_BROKER = { host: '0.peerjs.com', port: 443, secure: true, path: '/' };
export const MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://mqtt.eclipseprojects.io:443/mqtt', // port 443: survives networks that block non-HTTPS ports
];

/** Broker override for testing (?mqtt=ws://127.0.0.1:9001 on the host; carried to the pad as #m=). */
export function brokerOverride(): string | null {
  const q = new URLSearchParams(location.search).get('mqtt');
  const h = new URLSearchParams(location.hash.slice(1)).get('m');
  const v = q || h;
  return v && /^wss?:\/\//.test(v) ? v : null;
}

export function mqttBrokers(): string[] {
  const o = brokerOverride();
  return o ? [o] : MQTT_BROKERS;
}

/** How long the pad waits for WebRTC before it relays over MQTT. */
export const RTC_GRACE_MS = 3000;
/** Unused session codes expire after this long; the host then shows a fresh QR. */
export const CODE_TTL_MS = 15 * 60 * 1000;

export type Path = 'direct' | 'relay-p2p' | 'mqtt-relay';

/**
 * Motion frame (pad -> host), sent ~60 Hz on the unreliable channel as a compact JSON array:
 * [0, seq, tPad, rrAlpha, rrBeta, rrGamma, ax, ay, az, oriAlpha, oriBeta, oriGamma, bail]
 * rotationRate in deg/s, acceleration in m/s^2 (without gravity when available), orientation in deg.
 */
export type FrameArr = [0, number, number, number, number, number, number, number, number, number, number, number, 0 | 1];

export interface Frame {
  seq: number;
  tPad: number;
  rr: [number, number, number];
  acc: [number, number, number];
  ori: [number, number, number];
  bail: boolean;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function packFrame(f: Frame): string {
  const a: FrameArr = [0, f.seq, Math.round(f.tPad * 10) / 10, r1(f.rr[0]), r1(f.rr[1]), r1(f.rr[2]),
    r1(f.acc[0] * 10) / 10, r1(f.acc[1] * 10) / 10, r1(f.acc[2] * 10) / 10, r1(f.ori[0]), r1(f.ori[1]), r1(f.ori[2]), f.bail ? 1 : 0];
  return JSON.stringify(a);
}

export function unpackFrame(s: string | FrameArr): Frame | null {
  let a: unknown;
  try { a = typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; }
  if (!Array.isArray(a) || a.length !== 13 || a[0] !== 0) return null;
  if (!a.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return { seq: a[1], tPad: a[2], rr: [a[3], a[4], a[5]], acc: [a[6], a[7], a[8]], ori: [a[9], a[10], a[11]], bail: a[12] === 1 };
}

/** Reliable event messages (both directions). */
export type Msg =
  | { t: 'hello'; v: number; boot: string }
  | { t: 'chal'; n: string }
  | { t: 'join'; pid: string; sec: string; proof: string }
  | { t: 'auth'; pid: string; mac: string }
  | { t: 'ok'; first: boolean }
  | { t: 'reject'; why: 'used' | 'expired' | 'bad' | 'unknown' }
  | { t: 'ping'; id: number; h0: number }
  | { t: 'pong'; id: number; h0: number; p1: number }
  | { t: 'bail'; d: 0 | 1; tp: number }
  | { t: 'tcast'; power: number; aim: number; dt: number; tFlick: number; tRel: number }
  | { t: 'pause'; tp: number; why: string }
  | { t: 'resume'; tp: number; reconnectMs: number; via: string }
  | { t: 'hap'; p: 'tick' | 'thunk' | 'buzz' | 'double' }
  | { t: 'mode'; touch: boolean }
  | { t: 'mframe'; f: string }; // a motion frame carried inside the MQTT relay

/** Epoch-ms clock with sub-ms resolution, same definition on host and pad. */
export const nowMs = () => performance.timeOrigin + performance.now();
