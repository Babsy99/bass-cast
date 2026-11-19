# PAIRING.md: how the phone talks to the Mac

## The stack

```
 iPhone (pad, github.io page)                         Mac (BassCast.app, Tauri / WKWebView)
 ───────────────────────────                          ─────────────────────────────────────
 DeviceMotion ~60 Hz ─┐                                ┌─ cast detector · clock sync · game
 bail / touch events ─┤                                │
                      ▼                                ▼
   1) WebRTC DataChannels (PeerJS signaling on 0.peerjs.com:443, Google STUN, no TURN)
        "bcsm-…"  motion   unordered, maxRetransmits 0  (stale frames are dropped, never queued)
        "bcse-…"  events   reliable, ordered            (bail, pause/resume, ping/pong, haptic cues)
      path shown on the host: "direct Wi-Fi" (host↔host candidates on the LAN) or "direct P2P (NAT, via STUN)" (value `p2p-nat`)
      (srflx/prflx candidates: still a straight phone↔Mac WebRTC link, no server carries the data; it was
      mislabelled "relay-p2p" before). The exact ICE pair (local/remote candidate type, address kind
      mdns/private/public, udp/tcp) is logged in the link events and the latency export (`link.ice`, per-row `ice`).
      Every lag-export row also carries link = direct | relay | local.
   2) MQTT over WSS relay (emqx :8084 → test.mosquitto.org :8081 → eclipse :443)
        if WebRTC isn't up within 3 s, or drops; WebRTC keeps retrying and takes over again when up
      path shown on the host: MQTT relay
```

**Pairing:** the Mac shows a QR code. The phone camera opens
`https://<owner>.github.io/<repo>/#s=<code>`. One tap grants Motion & Orientation and connects. The code is
in the URL **fragment**, so it is never sent to GitHub's servers or any referrer (the page also sets `no-referrer`).

### Why this stack

- **No install on the phone, no keys, no server of ours.** PeerJS's public signaling server and Google's STUN
  servers are free and keyless. Public MQTT brokers are free and keyless. That fits "no paid domain, no secrets".
- **WebRTC first** because on home Wi-Fi it is a direct LAN link: a few ms, and no third party sees game traffic after signaling.
  The motion channel is unordered with zero retransmits, because a late motion frame is worse than a missing one.
- **MQTT relay second** because WebSockets on 443/8084 get through almost everything WebRTC can't (no UDP,
  symmetric NAT, AP isolation). It is TCP, so loss shows up as delay, not as gaps.
- **Trystero** (MIT; serverless WebRTC signaling over public BitTorrent trackers, Nostr or MQTT) was evaluated as the backup
  signaling layer. It removes the dependency on one PeerJS server, but tracker and Nostr relay availability varies more, and it adds a
  second WebRTC wrapper. Decision: keep PeerJS for signaling plus our own MQTT relay for data. Swap in Trystero only if
  0.peerjs.com proves unreliable. **Not tested end-to-end here** (see "What the box could not test").

## Security model (single-use session codes)

| Piece | How |
|---|---|
| Session code | 16 random bytes (128 bits) from `crypto.getRandomValues`, base64url, in the QR fragment `#s=` |
| New code | on every game launch (a webview reload keeps the session; quitting the app makes a new one), via Panel → New session, and after 15 min if unused |
| Rendezvous names | PeerJS id = `bcs-` + SHA-256("bcs-peer\|code")[0:32]; MQTT topic = `bcs/` + SHA-256("bcs-topic\|code")[0:32]. The code itself never goes on the wire |
| First join | host sends a random challenge; pad answers `HMAC(code, nonce\|join)` plus a fresh per-pad id and 128-bit secret |
| Single use | the host accepts the **first** valid pad and retires the code. Any later join gets `rejected: used` (the pad shows "This QR was already used, scan the new one"); the host logs `REJECTED join over <path>: used`. Expired codes get `rejected: expired` |
| Reconnect | only that pad can come back: it answers `HMAC(pad secret, nonce\|rejoin)`. The secret lives in the pad's localStorage **and** in its own URL fragment (`&p=`), so it survives the iOS camera's in-app Safari sheet |
| MQTT payloads | AES-GCM encrypted, then HMAC-SHA256 tagged (encrypt-then-MAC). Keys are derived from the code (join phase) or the pad secret (after join). Per-sender counters reject replays. Anyone on the public broker sees only opaque blobs on a hashed topic |
| WebRTC | DTLS-encrypted by WebRTC itself, and the same challenge/response runs over the event channel before any frame is accepted |

Known limits: anyone who photographs the QR **before** the phone scans it could join first (then the real phone sees
"used", and the host can make a new session). Public PeerJS and MQTT services can see connection metadata (IP, timing), not content.

## Weak network behaviour

- **Motion over WebRTC:** frames are fire-and-forget. With loss, the detector just sees a slightly coarser curve (peak
  detection tolerates missing frames). With latency, the cast is late but not wrong.
- **Motion over MQTT (TCP):** loss turns into head-of-line stalls. Each frame carries the phone timestamp, so the host measures
  **delivery age** and computes the flick time in host time via clock sync. Distances stay right, only the response is later.
- **Clock sync:** 10 pings 40 ms apart, keep the 5 lowest-RTT samples, median offset. Runs at connect and every 10 s, so jitter barely moves it.
- **Ping/pong every 1 s** on the reliable path. RTT/2 and delivery age are logged and exported. No host ping for 3 s → the pad rebuilds the link.
  No frames for 1.2 s → the host shows "lost".
- **Phone sleep / notification / app switch:** the pad sends `pause`, the host shows "Controller paused" and cancels any cast in
  progress. On return the pad reconnects by itself. If motion events don't resume within 1 s (iOS drops the motion permission on
  reload), a full-screen **Tap to resume** re-requests it. Never a rescan.

## Failure modes

| Situation | What happens | Fix |
|---|---|---|
| Phone and Mac on **different networks** (phone on cellular, guest Wi-Fi) | WebRTC needs TURN, which we don't run, so ICE fails → MQTT relay (more lag) | self-hosted TURN |
| **Carrier-grade NAT / symmetric NAT** | same: no TURN → MQTT relay | TURN |
| **Corporate / guest / hotel Wi-Fi** with client isolation or UDP blocked | no LAN path, maybe no STUN → MQTT relay. If WebSockets to the brokers' ports are blocked too, the eclipse broker on :443 is the last hope | own relay on 443 |
| **0.peerjs.com down** | no WebRTC signaling → MQTT relay only | Trystero or own signaling |
| **All public MQTT brokers down or blocked** and WebRTC fails | no connection; the host shows the broker state | own relay |
| **macOS Local Network permission denied** | the Mac may not expose LAN candidates → p2p-nat (still direct) or MQTT | re-allow in Privacy & Security → Local Network |
| iOS **Low Power Mode** / background | motion events throttled or stopped | pad pauses, Tap to resume |
| Someone scans the QR first | real phone gets "used" | Panel → New session |

## Upgrade path

1. **Own signaling + TURN:** a small Cloudflare Worker (Durable Object) or a $5 VPS running a PeerJS server plus
   **coturn** with short-lived TURN credentials (HMAC REST API). That fixes cellular, CGNAT and guest Wi-Fi. A Cloudflare Worker or a
   managed TURN service needs **the project owner's account**, and a TURN secret that must live server-side, never in the repo.
2. **Own MQTT/WebSocket relay** on 443 (same Worker) instead of public brokers: better uptime, no shared topics.
3. Later, a **native iOS controller** (CoreMotion at 100–200 Hz, background-safe) using the same protocol and QR.

## What the box could not test

- **WebRTC end-to-end.** The test box's Chrome has a managed policy (`WebRtcIPHandling: disable_non_proxied_udp`) that removes all UDP
  ICE candidates. That is a deliberate sandbox control, so it was left alone. Signaling did work (peer registered on 0.peerjs.com,
  offer seen by the host, signalingState stable). Every test pairing therefore fell back to the MQTT relay after the 3 s grace,
  which also proves the fallback. **Direct-link lag is unmeasured.** It must be measured on the real home Wi-Fi.
- **Public MQTT brokers.** The box's egress blocks TLS on non-443 ports, so the tests use a local MQTT-over-WebSocket broker
  (`tests/local-broker.mjs`, aedes) via `?mqtt=`. The protocol, crypto and code paths are identical. Broker distance is not.
- **Throttled network:** `tc netem` is not available in this kernel, so the throttled run puts the pad's broker connection
  behind `tests/lag-proxy.mjs` (+150 ms each way and 5% segment loss with a 200 ms retransmit stall).

## Test results (headless, this box)

Generated by `node tests/summarize.mjs` from `tests/results/summary.json` (run finished 2026-11-19T02:03:01.308Z) and `summary-expired.json`.
Console errors across the run: **0** (expired run: 0). Renderer in headless Chrome: `13 fps · WebGL2 · 90% res` (WebGPU device was lost earlier this session).

**Synthetic casts** (`summary.json → syntheticCasts`; order check: OK)

| cast | distance | power | release vs peak | launch angle |
|---|---|---|---|---|
| weak | 48.3 ft | 0.316 | 33 ms (good) | 30° |
| good | 122.7 ft | 0.899 | 32 ms (good) | 30° |
| late | 30.8 ft | 0.899 | 260 ms (late) | -5.9° |
| early | 104.4 ft | 0.899 | -98 ms (early) | 45.5° |
| aimedRight12 | 95.6 ft | 0.694 | 33 ms (good) | 30°, landed 10° right |

Touch-cast: pad 112.2 ft, host mouse 46.2 ft.

**Test 10 casts** (`test10-casts.json`): **10/10** (synthetic thrower with noise; good = within ±15% and inside the aim cone).

**5 fresh pairings** (`summary.json → pairings`): **5/5**

| # | tap → connected | QR shown → first cast | path |
|---|---|---|---|
| 1 | 3102 ms | 4966 ms | mqtt-relay |
| 2 | 3069 ms | 4658 ms | mqtt-relay |
| 3 | 3102 ms | 4904 ms | mqtt-relay |
| 4 | 3023 ms | 4887 ms | mqtt-relay |
| 5 | 3042 ms | 4945 ms | mqtt-relay |

Median tap → connected 3069 ms; median QR → first cast 4904 ms (max 4966 ms; pass ≤ 10 000 ms). The 3 s in each connect is the WebRTC grace before the MQTT fallback, because WebRTC can't connect on this box.

**Reconnect** (`summary.json → reconnect`)

| test | result |
|---|---|
| 1. phone sleeps 30 s, network drops, wakes | host showed "paused", Tap to resume shown: true, wake → controlling **1324 ms**, cast after: 109.3 ft |
| 2. pad page reload (iOS drops motion permission) | button "Tap to resume", tap → controlling **3196 ms**, cast after: 109.3 ft |
| 3. camera-scan context, empty storage (pairing only in URL fragment) | tap → controlling **3167 ms**, cast after: 109.3 ft |
| extra: data channel killed | frames back after 1527 ms, cast after: 109.3 ft |
| extra: game (host) reload | still paired: true, 1324 ms |

3/3 reconnects without a rescan; all under the 5 s bar.

**B0a** — used code: pad `rejected:used`, host log `2026-11-19T01:47:38.723Z REJECTED join over MQTT: used`. Expired code: pad `rejected:expired` ("This QR code expired."), host log `2026-11-19T02:08:18.886Z REJECTED join over MQTT: expired`.

**Cast latency, 50 casts each** (ms; lag = flick on phone → first frame showing the rod whip, in host time via clock sync)

| run | path | casts | lag median | lag p95 | detect med / p95 | ping RTT/2 med / p95 | delivery age med / p95 | file |
|---|---|---|---|---|---|---|---|---|
| MQTT relay, normal (local broker) | mqtt-relay | 50 | 54.2 | 70.1 | 49.6 / 50.9 | 0.8 / 1.8 | 1 / 2.3 | `tests/results/latency-mqtt-local.json` |
| MQTT relay, throttled: pad +150 ms each way, 5% loss | mqtt-relay | 50 | 218.2 | 375.2 | 200.1 / 365.7 | 170.7 / 271.7 | 151.1 / 318 | `tests/results/latency-mqtt-throttled-rtt300-loss5.json` |
| MQTT relay, CDP latency 300 ms on pad* | mqtt-relay | 50 | 56.1 | 87.9 | 49.6 / 51.6 | 0.8 / 1.9 | 1 / 2.1 | `tests/results/latency-mqtt-cdp-pad-300ms.json` |
| Direct WebRTC, normal / throttled | — | 0 | not measurable here | | | | | |

*CDP network emulation did not touch the already-open WebSocket (RTT/2 stayed 0.8 ms), so this run is effectively a second unthrottled run. The proxy run is the real throttled number. Proxy stats: 694/13570 chunks held as "lost".
About 50 ms of every lag figure is the detector itself: it confirms the flick when pitch rate falls to 80% of its peak.
Pass bar: median ≤ 100 ms, p95 ≤ 150 ms. Normal relay passes. The throttled relay fails, as expected for a phone on a bad network.

