# Bass Cast spike

M0 / B0 spike for a Texas bass-fishing game: **the Mac runs the game, the iPhone is the rod.**
You hold the phone like a rod handle, press and hold the on-screen bail, swing back, flick forward
and let go. The Mac shows a golden-hour lake, and the lure flies as far as your flick earns.

Everything here is original: procedural visuals (no textures, models or sounds from anywhere else),
procedural WebAudio, and original names. Third-party code is MIT-licensed only (see below).

```
bass-cast-spike/
├─ app/                 Mac host: Tauri 2 + TypeScript + Vite + three.js (WebGPU → WebGL2 fallback)
│  ├─ src/              game, scene, cast detector, host link (QR, pairing, transport), audio, HUD
│  └─ src-tauri/        Rust shell: default permissions only, no plugins, no updater
├─ pad/                 Phone controller: static page for GitHub Pages (the only hosted piece)
├─ shared/              protocol, crypto (session codes, HMAC, AES-GCM), clock sync, MQTT relay,
│                       WebRTC channel patch, sensors, touch-cast
├─ tests/               headless puppeteer suite + test-only local MQTT broker
├─ shots/               (not committed) screenshots + cast.mp4 from the last test run
├─ .github/workflows/   mac.yml (universal .app/.dmg, ad-hoc signed, prerelease v0.1.1-m0.1; v0.1.0-m0 kept)
├─ PAIRING.md           transport, pairing, security, failure modes, upgrade path
└─ ENGINE.md            engine comparison and pick
```

## Play it

1. Launch **BassCast.app** on the Mac. A QR code appears.
2. Scan it with the iPhone camera. The controller page (https://babsy99.github.io/bass-cast/) opens in Safari: tap **Start**, allow Motion & Orientation.
3. Grip the phone firmly (wrist strap if you have one). Hold the bail button, swing back, flick
   forward, release the bail near the top of the flick.
   - Release too early: the lure lobs high and short. Too late: it slaps into the water close in.
   - Power comes from how fast the phone pitches forward; aim comes from where it points when you let go.
4. After the first cast the Mac offers an optional 3-swing calibration (skip it if you like).

No phone pairing? Switch on **touch-cast** in the Panel and drag-flick with the mouse or trackpad. Single-device mode
(`?solo`, for opening the host page on the phone itself) uses the phone's own sensors and an on-screen bail.

**Casting:** hold the phone upright like a rod handle, swing back, flick forward. No button needed (holding
the on-screen button is optional; letting go then releases). The game learns your swing axis and direction from
the first swing and scales power so that swing is ~65%; a relaxed 300–500°/s wrist flick covers the whole lake.
A live gyro meter (Mac bottom-left and on the phone) shows each axis, the thresholds and the swing phase; a
failed swing says why ("Swing back further", "Flick forward faster", "Let go right after the flick", …).

**Before the QR:** the Mac shows the setup and casting instructions first (reading only) with one **Show QR**
button; the pairing clock runs from that click to the first cast, and the split from the phone joining to the
first cast is logged too (`scanToCastMs`).

**Lag proof (Panel):** the phone flashes white and beeps (880 Hz) the moment it detects the flick; the Mac
flashes a white top-right square and beeps (1760 Hz) on the exact frame the rod whip is first drawn. Film both
screens with a slow-motion camera and count frames between the two flashes.

**Modes (toolbar):** Test 10 casts (a cast counts only if it lands within ±15% of the target distance and inside the
aim cone, peaks at ≤500°/s, and you tap 👍 "felt relaxed" on the phone; misses say "Long/Short by N ft",
"Left/Right by N°"; X/10 score, JSON export) · 50-cast latency run (median / p95 JSON export) · Panel (pass criteria,
cast log, exports, new session) · Debug overlay · Show QR.

### First launch on a Mac — one time only

Download **BassCast.zip** from the release (recommended; the `.dmg` holds the same app). Double-click the
zip, drag **BassCast.app** to **Applications**, then paste this one line into Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/BassCast.app && open /Applications/BassCast.app
```

That removes the "downloaded from the internet" flag from this one app and opens it: no Gatekeeper dialog,
now or later. Why it's needed: the build is ad-hoc signed, not notarized. Only an app signed with an Apple
**Developer ID** and **notarized** by Apple (Apple Developer Program, $99/year) opens from a download without the
"can't verify" block, and even then macOS shows a one-time "downloaded from the Internet — Open?" confirmation.
We deliberately don't ship a helper `.command` script for this: a downloaded script gets the same quarantine
flag and is itself blocked by Gatekeeper, so it would add a prompt instead of removing one.

Without Terminal (macOS 15+; Control-click → Open no longer bypasses Gatekeeper):
1. Open BassCast.app once. macOS says it can't verify it; click **Done**.
2. **System Settings → Privacy & Security**, scroll down, click **Open Anyway** next to BassCast, confirm with your password.

Then macOS may ask **"Allow BassCast to find devices on local networks?"** Click **Allow**. That lets
the phone talk to the Mac directly over Wi-Fi. If you click Don't Allow it still works through the
relay, just with more lag. You can change this later in Privacy & Security → Local Network.

Both prompts happen once.

## Develop

Requires Node 20+. For the Mac app you also need Rust and Xcode Command Line Tools.

```bash
npm install
npm run dev:app        # host at http://127.0.0.1:5173 (plain web; works in any browser)
npm run dev:pad        # pad at http://<your-LAN-ip>:5174 (the QR points here in dev)
npm run tauri -w app -- dev     # the same host inside the Tauri window (macOS)
npm run typecheck
npm run build          # app/dist + pad/dist
```

Handy URL flags on the host: `?solo` (one device), `?renderer=webgl2` (force fallback),
`?pad=<url>` (where the QR points), `?mqtt=<ws url>` (use a specific broker, e.g. a local one).
Pad flag: `?rtc=0` (MQTT only).

Note: iOS only allows motion sensors on **https** pages. For phone testing in dev use the hosted pad
(`VITE_PAD_URL`) or a local https tunnel/cert.

## Tests

Headless Chrome + puppeteer-core (Chrome at `/usr/bin/google-chrome`, SwiftShader flags; the pad
runs at 390×844 @2x, touch + mobile). Test-only deps (`puppeteer-core`, `aedes`, `ws`, `esbuild`) are
not in package.json; install them where `tests/lib.mjs` expects them (`/tmp/pw`) or adjust the path.

```bash
node tests/run-all.mjs              # everything
ONLY=basic node tests/run-all.mjs   # renderer, casts, touch, Test 10, used-QR, reconnects
ONLY=pair  node tests/run-all.mjs   # 5 fresh pairings
ONLY=lat   node tests/run-all.mjs   # latency runs (relay, netem 75 ms + 5% loss, CDP 300 ms)
```

Results go to `tests/results/*.json`, screenshots and `cast.mp4` to `shots/`.

## Build the Mac app (CI)

`.github/workflows/mac.yml` runs on `macos-latest` on every push to `main` that touches the app (or by hand).
It restores the app icons from `app/src-tauri/icons-b64/` (stored as base64 text), builds a universal
(arm64 + x86_64) `.app`, ad-hoc signs it with `codesign --force --deep -s -`, zips it as `BassCast.zip` with
`ditto -c -k --keepParent` (re-verifying the signature after unzip) and wraps it in a `.dmg`, uploads both as a
workflow artifact and attaches them to the public **prerelease `v0.1.1-m0.1`** (the earlier `v0.1.0-m0` stays as it was). It uses no secrets, only the built-in `GITHUB_TOKEN`.
The QR points to the repo variable `PAD_URL` if set, otherwise `https://babsy99.github.io/bass-cast/`.

The controller page is served by GitHub Pages from the `gh-pages` branch: the `vite build` output of `pad/`
(base `/bass-cast/`, override with `PAD_BASE`) plus `.nojekyll`. Rebuild and push that branch to update it.

## Third-party licenses

| Package | License | Used for |
|---|---|---|
| three.js | MIT | rendering (WebGPU / WebGL2, TSL node materials) |
| PeerJS | MIT | WebRTC signaling via the public PeerJS server |
| MQTT.js | MIT | MQTT-over-WebSocket relay fallback |
| qrcode-generator | MIT | QR code on the host |
| Tauri 2 | MIT / Apache-2.0 | Mac app shell |
| Vite, TypeScript | MIT, Apache-2.0 | build tooling |
| puppeteer-core, aedes, ws, esbuild (tests only) | Apache-2.0, MIT, MIT, MIT | headless tests |

Spike code: MIT (see LICENSE).
