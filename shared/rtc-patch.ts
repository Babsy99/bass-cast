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

/** Classify the selected ICE pair: host<->host = direct (LAN), anything else peer-to-peer via STUN. */
export async function classifyPath(pc: RTCPeerConnection | undefined | null): Promise<'direct' | 'relay-p2p' | null> {
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
    const lt = l?.candidateType, rt = rm?.candidateType;
    return lt === 'host' && rt === 'host' ? 'direct' : 'relay-p2p';
  } catch {
    return null;
  }
}
