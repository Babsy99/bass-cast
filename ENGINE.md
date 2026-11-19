# ENGINE.md: what to build Bass Cast on

**Pick: Tauri 2 + TypeScript + three.js (WebGPU renderer, automatic WebGL2 fallback) for the Mac host,
with a static web page as the phone controller.** That is what this spike runs on. See "Why" and "Migration path" below.

License and pricing terms checked on 2026-11-18. Sources are linked inline.

## Comparison

| | Unity 6 (URP) | Unreal Engine 5 (mobile / desktop) | Web: three.js or Babylon.js (WebGPU) in Tauri |
|---|---|---|---|
| **Visual ceiling** | High. URP gives water, volumetrics-lite, good post FX. HDRP is Windows/console-oriented. | Highest. Lumen, Nanite, water plugin. Overkill for a phone-controlled lake and heavy on Intel Macs. | Medium-high. WebGPU + TSL node materials (custom water with fresnel, glints and normal ripples, fog, ACES tone mapping as here). No Lumen-class GI; baked or faked lighting is fine for a stylised golden-hour lake. |
| **Tooling** | Mature editor, asset pipeline, profiler. | Mature editor, Blueprints, huge but heavy. | Code-first. Vite hot reload in under a second. Scene editing is in code or glTF from Blender. Fewer artist tools. |
| **Phone as controller (sensors)** | Needs a companion app or a web pad plus your own networking (Netcode/Relay). | Same: companion app or web pad plus networking. | The pad is a web page: DeviceMotion/DeviceOrientation after one tap, WebRTC/MQTT built in, and **no App Store install for the phone**. Native access (CoreMotion at higher rates) would need a native iOS app later. |
| **Iteration speed** | Domain reload and compile waits; builds take minutes. | C++ compiles and shader compiles; slowest of the three. | Fastest: save → reload. The whole cast pipeline is testable headless (this repo's puppeteer suite). |
| **Distribution** | Mac App Store / Steam / direct. Player builds are hundreds of MB. | Same, with bigger builds. | Tauri .app/.dmg in the low tens of MB (system WKWebView, no bundled browser). Also runs as a plain web page. Mac App Store possible later with real signing and notarization. |
| **Cost / licensing** | Personal is free up to **$200K** revenue+funding in the trailing 12 months. Above that Pro is **$2,310/yr per seat** (5% increase from Jan 12, 2026). The Runtime Fee is cancelled. ([pricing updates](https://unity.com/products/pricing-updates), [Editor terms](https://unity.com/legal/editor-terms-of-service/software)) | Free to use. **5% royalty on lifetime gross revenue above $1M per product** (3.5% under "Launch Everywhere with Epic"). Release form needed before revenue. Seats are needed only for companies with ≥$1M/yr that aren't making games. ([license](https://www.unrealengine.com/en-US/license), [EULA](https://www.unrealengine.com/eula/unreal), [release](https://www.unrealengine.com/en-US/release)) | three.js **MIT**, Babylon.js **Apache-2.0**, Tauri **MIT/Apache-2.0**. No fees, no royalties, no seats. ([three.js license](https://github.com/mrdoob/three.js/blob/dev/LICENSE), [Babylon.js license](https://github.com/BabylonJS/Babylon.js/blob/master/license.md), [Tauri](https://github.com/tauri-apps/tauri)) |
| **On-device AI bite detection** | Barracuda/Sentis for on-device inference; possible but adds a pipeline. | NNE plugin; possible, heavy. | Not needed at first: a "bite" is a game event the host decides (simulated fish behaviour: lure depth, speed, retrieve pauses, cover, time of day, plus noise). Phone-side "strike detection" (a sharp upward jerk) is the same detector that does casts. If ML is wanted later, ONNX Runtime Web / Transformers.js run on WebGPU in WebKit ([WebKit Safari 26](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)). |

## WebGPU vs WebGL2 on the Mac

WebKit shipped WebGPU in Safari 26 (macOS Tahoe, iOS 26; also Safari 26 on Sequoia/Sonoma)
([WebKit](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/), [web.dev](https://web.dev/blog/webgpu-supported-major-browsers)).
Tauri uses the **system WKWebView**, which follows the OS, not the Safari app
([Tauri webview versions](https://v2.tauri.app/reference/webview-versions/)). The Tauri maintainers expect WebGPU in
WKWebView to light up automatically wherever Apple enables it, and only on macOS 26+
([tauri#6381](https://github.com/tauri-apps/tauri/issues/6381)). That is exactly why the spike:

- probes `navigator.gpu` and `requestAdapter()` (with a timeout), and if either fails goes straight to WebGL2;
- if the WebGPU device is lost mid-session, remembers it and reloads into WebGL2;
- shows the detected renderer in the fps overlay (`60 fps · WebGPU · 100% res`);
- caps pixel ratio at 2 and drops render scale down to 60% if fps sags.

The same TSL materials compile to WGSL (WebGPU) or GLSL (WebGL2), so there is one shader codebase.

## Why the web stack wins for this game, now

1. **The controller must be zero-install.** A QR → Safari page with motion permission is the whole onboarding. Every engine
   option still needs this web pad (or an App Store companion app), plus networking. The web stack shares code
   (protocol, crypto, detector) between host and pad.
2. **The risky part is feel and latency, not graphics.** Iteration speed and headless testability matter more than
   Lumen. The spike already measures pairing time, reconnect, cast lag (median/p95) and the cast-scoring gate in CI-able tests.
3. **Cost is zero** and there are no revenue thresholds to track.
4. **The visual target is reachable:** stylised golden-hour water, fog, low-poly shore and good motion read as
   "premium" on a Mac without GI.

## When to switch, and the migration path

Revisit at M2 if any of these hold: (a) art direction needs realistic GI/foliage beyond the web renderer at 60 fps
on a base M1, (b) we need console ports, or (c) the phone needs native CoreMotion rates (>100 Hz) or background execution.

Path (nothing is thrown away):

1. **Keep the protocol** (`shared/protocol.ts`, `crypto.ts`, `clock.ts`). It is plain JSON/arrays over WebRTC/MQTT and
   can be implemented in C# or C++. The pad page stays as is.
2. **Keep the cast model** (`app/src/cast.ts`). It is pure functions (detector state machine, timing window, ballistic sim with drag),
   so port it one-to-one and diff against the JSON test exports from this repo (golden casts).
3. **Port the host** to Unity 6 URP: WebRTC via `com.unity.webrtc`, MQTT via a C# client, water via Shader Graph.
   This is the cheaper port while revenue stays under Unity Personal's $200K. Unreal is the alternative if photoreal
   is the brief; budget the 5% royalty above $1M.
4. A **native iOS controller** only if needed: Swift + CoreMotion, same protocol and pairing QR.

Inside the web stack the cheap upgrades come first: baked lightmaps/AO from Blender as glTF, a compute-shader
(WebGPU) wave sim, and Babylon.js if we want its inspector/editor tooling. Babylon has the same WebGPU/WebGL2 dual path, Apache-2.0.
