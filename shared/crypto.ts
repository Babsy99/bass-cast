// Session crypto for the Bass Cast spike. WebCrypto only; nothing is ever sent to a server of ours.
const enc = new TextEncoder();
const dec = new TextDecoder();

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function b64url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(p);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** 128-bit single-use session code (base64url, 22 chars). */
export function newSessionCode(): string {
  return b64url(randomBytes(16));
}

export function isValidCode(s: string | null | undefined): s is string {
  return !!s && /^[A-Za-z0-9_-]{22,64}$/.test(s) && fromB64url(s).length >= 16;
}

export async function sha256hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function hmacB64(secret: string, msg: string): Promise<string> {
  const k = await hmacKey(secret);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg))));
}

/** Constant-time-ish compare of two base64url MACs. */
export function macEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Everything derived from the session code. The code itself never leaves the QR/URL fragment in clear. */
export interface SessionIds {
  hostPeerId: string; // PeerJS id of the game host
  topic: string; // MQTT relay topic root
  tag: string; // short, non-secret label shown on screen
}

export async function deriveIds(code: string): Promise<SessionIds> {
  const p = await sha256hex('bcs-peer|' + code);
  const t = await sha256hex('bcs-topic|' + code);
  return { hostPeerId: 'bcs-' + p.slice(0, 32), topic: 'bcs/' + t.slice(0, 32), tag: t.slice(32, 36).toUpperCase() };
}

/** Sealed envelope for the public MQTT relay: AES-GCM payload + HMAC-SHA256 tag (encrypt-then-MAC). */
export interface Envelope { s: string; n: number; k: 'c' | 'p'; iv: string; ct: string; mac: string }

export class Sealer {
  private encKey!: CryptoKey;
  private macSecret!: string;
  constructor(public readonly kind: 'c' | 'p') {}
  static async create(kind: 'c' | 'p', secret: string): Promise<Sealer> {
    const s = new Sealer(kind);
    const raw = fromB64url(await hmacB64(secret, 'bcs-enc'));
    s.encKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    s.macSecret = await hmacB64(secret, 'bcs-mac');
    return s;
  }
  async seal(sender: string, n: number, payload: unknown): Promise<Envelope> {
    const iv = randomBytes(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.encKey, enc.encode(JSON.stringify(payload))));
    const e = { s: sender, n, k: this.kind, iv: b64url(iv), ct: b64url(ct) };
    const mac = await hmacB64(this.macSecret, `${e.s}|${e.n}|${e.k}|${e.iv}|${e.ct}`);
    return { ...e, mac };
  }
  async open(e: Envelope): Promise<unknown | null> {
    if (!e || e.k !== this.kind || typeof e.ct !== 'string') return null;
    const mac = await hmacB64(this.macSecret, `${e.s}|${e.n}|${e.k}|${e.iv}|${e.ct}`);
    if (!macEq(mac, e.mac)) return null;
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(e.iv) }, this.encKey, fromB64url(e.ct));
      return JSON.parse(dec.decode(pt));
    } catch {
      return null;
    }
  }
}
