// PeerJS opens "unreliable" channels as ordered:false but still fully retransmitting.
// For motion frames we want fire-and-forget: unordered + maxRetransmits 0. The channel is created by the
// offerer (the pad) and the params are negotiated in-band, so patching createDataChannel is enough.
export const MOTION_LABEL_PREFIX = 'bcsm-';
export const EVENT_LABEL_PREFIX = 'bcse-';

let patched = false;
export function patchUnreliableChannels() {
  if (patched || typeof RTCPeerConnection === 'undefined') return;
  patched = true;
  const orig = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (label: string, init?: RTCDataChannelInit) {
    if (label.startsWith(MOTION_LABEL_PREFIX)) {
      init = { ...(init || {}), ordered: false, maxRetransmits: 0 };
      delete (init as { maxPacketLifeTime?: number }).maxPacketLifeTime;
    }
    return orig.call(this, label, init);
  };
}

export interface IcePair { local: string; remote: string; protocol: string; localAddrKind: string; remoteAddrKind: string }

/**
 * Classify the selected ICE pair. Both sides 'host' = direct LAN link. 'srflx'/'prflx' = still a direct
 * phone<->Mac WebRTC link (no relay server: we run no TURN), just found via STUN/peer-reflexive addresses,
 * which is common when iOS hides local IPs behind mDNS. A 'relay' candidate (TURN) cannot occur here.
 */
export async function classifyPath(pc: RTCPeerConnection | undefined | null): Promise<{ path: 'direct' | 'p2p-nat'; pair: IcePair } | null> {
  if (!pc) return null;
  try {
    const stats = await pc.getStats();
    let pair: any = null;
    stats.forEach((r: any) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
    });
    if (!pair) stats.forEach((r: any) => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r; });
    if (!pair) return null;
    const l: any = stats.get(pair.localCandidateId);
    const rm: any = stats.get(pair.remoteCandidateId);
    const kind = (a?: string) => !a ? 'unknown' : a.endsWith('.local') ? 'mdns' : /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fe80|fd)/i.test(a) ? 'private' : 'public';
    const info: IcePair = { local: l?.candidateType ?? '?', remote: rm?.candidateType ?? '?', protocol: l?.protocol ?? '?',
      localAddrKind: kind(l?.address ?? l?.ip), remoteAddrKind: kind(rm?.address ?? rm?.ip) };
    return { path: info.local === 'host' && info.remote === 'host' ? 'direct' : 'p2p-nat', pair: info };
  } catch {
    return null;
  }
}
