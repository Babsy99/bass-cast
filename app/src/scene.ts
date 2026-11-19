// Golden-hour lake, built procedurally with three.js node materials (TSL), so the same scene runs on
// the WebGPU backend and the WebGL2 fallback. No external textures, models or assets.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, vec3, float, sin, cos, time, positionWorld, cameraPosition, normalize, dot, pow, mix, max,
  reflect, smoothstep, mx_noise_float, clamp, length, exp, vec2, abs,
} from 'three/tsl';
import type { Trajectory } from './cast';

const SUN_DIR = new THREE.Vector3(-0.55, 0.13, -0.82).normalize();
const HORIZON = new THREE.Color(1.0, 0.63, 0.38);
const ZENITH = new THREE.Color(0.16, 0.3, 0.58);
const LAKE_CENTER = new THREE.Vector3(0, 0, -92);

// Seeded RNG so the lake is identical every launch.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

type N = any; // TSL node

function skyColor(dir: N, sunDir: N): N {
  const h = clamp(dir.y, -1, 1);
  const up = pow(clamp(h, 0, 1), 0.45);
  const base = mix(vec3(HORIZON.r, HORIZON.g, HORIZON.b), vec3(ZENITH.r, ZENITH.g, ZENITH.b), up);
  const below = mix(vec3(0.55, 0.38, 0.28), vec3(HORIZON.r, HORIZON.g, HORIZON.b), smoothstep(-0.25, 0.0, h));
  const sky = mix(below, base, smoothstep(-0.02, 0.02, h));
  const d = max(dot(dir, sunDir), 0);
  const disk = smoothstep(0.9993, 0.9997, d).mul(vec3(9, 6.5, 3.5));
  const glow = pow(d, 48).mul(vec3(1.2, 0.6, 0.25)).add(pow(d, 5).mul(vec3(0.35, 0.18, 0.06)));
  return sky.add(disk).add(glow);
}

export interface RendererInfo { kind: 'WebGPU' | 'WebGL2'; reason: string }

export class LakeScene {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  rodPivot = new THREE.Group();
  rodTip = new THREE.Object3D();
  lure = new THREE.Group();
  target = new THREE.Group();
  private line: THREE.Line;
  private linePos: Float32Array;
  private droplets: THREE.InstancedMesh;
  private dropVel: THREE.Vector3[] = [];
  private dropPos: THREE.Vector3[] = [];
  private rings: { mesh: THREE.Mesh; t0: number; mat: THREE.MeshBasicNodeMaterial }[] = [];
  private traj: Trajectory | null = null;
  private flightT0 = 0;
  private landedAt = -1;
  private landPos = new THREE.Vector3();
  private rodPitch = 30; // deg
  private rodVel = 0;
  private whipKick = 0;
  liveBeta: number | null = null;
  state: 'idle' | 'flying' | 'landed' = 'idle';
  onLand: (t: Trajectory) => void = () => {};
  private tmp = new THREE.Vector3();
  private dummy = new THREE.Object3D();

  constructor(private renderer: THREE.WebGPURenderer, aspect: number) {
    this.camera = new THREE.PerspectiveCamera(58, aspect, 0.05, 2000);
    this.camera.position.set(0, 1.75, 0);
    this.camera.lookAt(0, 0.2, -70);
    this.scene.add(this.camera);
    this.scene.fog = new THREE.Fog(HORIZON.clone().multiplyScalar(0.95), 70, 560);
    this.buildSky();
    this.buildWater();
    this.buildShore();
    this.buildVegetation();
    this.buildRod();
    this.buildLure();
    this.buildTarget();
    const { line, pos } = this.buildLine();
    this.line = line; this.linePos = pos;
    this.droplets = this.buildDroplets();
    const sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.78, 0.55), 2.4);
    sun.position.copy(SUN_DIR).multiplyScalar(300);
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(new THREE.Color(0.55, 0.62, 0.8), new THREE.Color(0.35, 0.25, 0.15), 0.9));
  }

  private buildSky() {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
    m.fog = false;
    const sunU = uniform(SUN_DIR);
    m.colorNode = skyColor(normalize(positionWorld.sub(cameraPosition)), sunU);
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 24, 12), m);
    sky.renderOrder = -1;
    this.scene.add(sky);
  }

  private buildWater() {
    const m = new THREE.MeshBasicNodeMaterial();
    const sunU = uniform(SUN_DIR);
    m.colorNode = Fn(() => {
      const p = positionWorld.xz;
      const dist = length(positionWorld.sub(cameraPosition));
      const fade = float(1).div(dist.mul(0.025).add(1)); // calm normals with distance (anti-shimmer)
      // Large directional swell (analytic derivatives)
      let dx: N = float(0), dz: N = float(0);
      const waves: [number, number, number, number, number][] = [
        [0.8, 0.6, 0.35, 0.9, 0.06], [-0.4, 0.9, 0.62, 1.3, 0.035], [0.95, -0.3, 1.1, 1.7, 0.02], [0.2, 1.0, 1.9, 2.3, 0.012],
      ];
      for (const [wx, wz, f, s, a] of waves) {
        const ph = p.x.mul(wx * f).add(p.y.mul(wz * f)).add(time.mul(s));
        const c = cos(ph).mul(f * a * 6);
        dx = dx.add(c.mul(wx)); dz = dz.add(c.mul(wz));
      }
      // Fine ripples from noise gradient
      const q = p.mul(0.9);
      const e = 0.15;
      const n0 = mx_noise_float(vec3(q.x, q.y, time.mul(0.45)));
      const nx = mx_noise_float(vec3(q.x.add(e), q.y, time.mul(0.45)));
      const nz = mx_noise_float(vec3(q.x, q.y.add(e), time.mul(0.45)));
      dx = dx.add(nx.sub(n0).div(e).mul(0.09));
      dz = dz.add(nz.sub(n0).div(e).mul(0.09));
      const N0 = normalize(vec3(dx.mul(fade).negate(), float(1), dz.mul(fade).negate()));
      const V = normalize(cameraPosition.sub(positionWorld));
      const R = reflect(V.negate(), N0);
      const Rc = normalize(vec3(R.x, max(R.y, 0.004), R.z));
      const fres = float(0.02).add(pow(float(1).sub(max(dot(N0, V), 0)), 5).mul(0.98));
      let refl: N = skyColor(Rc, sunU);
      // Fake treeline reflection: a dark olive band just above the horizon in reflected rays
      const band = smoothstep(0.075, 0.018, Rc.y).mul(smoothstep(-0.2, 0.15, Rc.z.negate().add(0.6)));
      refl = mix(refl, vec3(0.07, 0.09, 0.04), band.mul(0.85));
      const deep = mix(vec3(0.02, 0.075, 0.065), vec3(0.06, 0.13, 0.09), smoothstep(40, 4, dist));
      const sunD = max(dot(R, sunU), 0);
      const glint = pow(sunD, 600).mul(28).add(pow(sunD, 60).mul(0.6)).mul(vec3(1.0, 0.75, 0.45));
      return mix(deep, refl, fres).add(glint);
    })();
    const water = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400, 1, 1), m);
    water.rotation.x = -Math.PI / 2;
    this.scene.add(water);
  }

  private shoreRadius(theta: number): number {
    // Lake outline in polar coords around LAKE_CENTER; camera bank is at theta = +PI/2 (towards +z).
    const r = rng(7);
    let rad = 96;
    for (let k = 1; k <= 4; k++) rad += Math.sin(theta * k * 1.7 + r() * 6) * (10 / k);
    const toCam = Math.abs(Math.atan2(Math.sin(theta - Math.PI / 2), Math.cos(theta - Math.PI / 2)));
    const w = Math.exp(-toCam * toCam * 6);
    return rad * (1 - w) + 89 * w;
  }

  private buildShore() {
    const seg = 160, rings = 7;
    const geo = new THREE.BufferGeometry();
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    const r = rng(11);
    const heights: number[] = [];
    for (let j = 0; j < rings; j++) for (let i = 0; i <= seg; i++) heights.push(r());
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i <= seg; i++) {
        const th = (i / seg) * Math.PI * 2;
        const r0 = this.shoreRadius(th);
        const off = [-2, 0.5, 4, 14, 40, 110, 320][j];
        const rad = r0 + off;
        const hy = [-0.6, 0.15, 0.6, 1.4 + heights[j * (seg + 1) + i] * 2.5, 3 + heights[j * (seg + 1) + i] * 7, 6 + heights[j * (seg + 1) + i] * 22, 20 + heights[j * (seg + 1) + i] * 50][j];
        pos.push(LAKE_CENTER.x + Math.cos(th) * rad, hy, LAKE_CENTER.z + Math.sin(th) * rad);
        const c = j <= 1 ? [0.42, 0.33, 0.2] : j === 2 ? [0.24, 0.3, 0.1] : j < 5 ? [0.17, 0.23, 0.08] : [0.2, 0.22, 0.16];
        const v = 0.85 + heights[j * (seg + 1) + i] * 0.3;
        col.push(c[0] * v, c[1] * v, c[2] * v);
      }
    }
    for (let j = 0; j < rings - 1; j++) for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 });
    m.side = THREE.DoubleSide;
    this.scene.add(new THREE.Mesh(geo, m));
  }

  private groundY(x: number, z: number) {
    const th = Math.atan2(z - LAKE_CENTER.z, x - LAKE_CENTER.x);
    const d = Math.hypot(x - LAKE_CENTER.x, z - LAKE_CENTER.z) - this.shoreRadius(th);
    if (d < 4) return 0.3;
    if (d < 14) return 0.6 + (d - 4) * 0.12;
    return 2 + Math.min(10, (d - 14) * 0.15);
  }

  private buildVegetation() {
    const r = rng(23);
    // Cedars (cones) and live oaks (squashed icosahedra), instanced.
    const cedarGeo = new THREE.ConeGeometry(1, 1, 6, 1);
    cedarGeo.translate(0, 0.5, 0);
    const oakGeo = new THREE.IcosahedronGeometry(1, 0);
    const trunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 1, 5);
    trunkGeo.translate(0, 0.5, 0);
    const mk = (geo: THREE.BufferGeometry, n: number) => {
      const m = new THREE.MeshStandardNodeMaterial({ flatShading: true, roughness: 0.9 });
      const im = new THREE.InstancedMesh(geo, m, n);
      im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      return im;
    };
    const NC = 220, NO = 160;
    const cedars = mk(cedarGeo, NC), oaks = mk(oakGeo, NO), trunks = mk(trunkGeo, NO);
    const c = new THREE.Color();
    const place = (i: number, im: THREE.InstancedMesh, kind: 'cedar' | 'oak') => {
      let th = r() * Math.PI * 2;
      // keep the view out over the lake clear near the camera bank
      const toCam = Math.abs(Math.atan2(Math.sin(th - Math.PI / 2), Math.cos(th - Math.PI / 2)));
      if (toCam < 0.35) th += (r() < 0.5 ? -1 : 1) * 0.5;
      const rad = this.shoreRadius(th) + 6 + r() * r() * 70;
      const x = LAKE_CENTER.x + Math.cos(th) * rad, z = LAKE_CENTER.z + Math.sin(th) * rad;
      const y = this.groundY(x, z);
      const s = kind === 'cedar' ? 5 + r() * 9 : 4 + r() * 5;
      this.dummy.position.set(x, y, z);
      this.dummy.rotation.set(0, r() * 6.28, 0);
      if (kind === 'cedar') this.dummy.scale.set(s * 0.32, s, s * 0.32);
      else { this.dummy.position.y = y + s * 0.9; this.dummy.scale.set(s, s * 0.6, s * 0.95); }
      this.dummy.updateMatrix();
      im.setMatrixAt(i, this.dummy.matrix);
      if (kind === 'cedar') c.setRGB(0.07 + r() * 0.04, 0.16 + r() * 0.07, 0.06 + r() * 0.03);
      else c.setRGB(0.16 + r() * 0.08, 0.24 + r() * 0.08, 0.07 + r() * 0.03);
      im.setColorAt(i, c);
      if (kind === 'oak') {
        this.dummy.position.y = y; this.dummy.scale.set(s * 0.25, s * 0.95, s * 0.25); this.dummy.updateMatrix();
        trunks.setMatrixAt(i, this.dummy.matrix); trunks.setColorAt(i, c.setRGB(0.22, 0.15, 0.09));
      }
    };
    for (let i = 0; i < NC; i++) place(i, cedars, 'cedar');
    for (let i = 0; i < NO; i++) place(i, oaks, 'oak');
    this.scene.add(cedars, oaks, trunks);

    // Cattails in the near shallows, left and right of the casting lane.
    const stemGeo = new THREE.CylinderGeometry(0.008, 0.012, 1, 4); stemGeo.translate(0, 0.5, 0);
    const headGeo = new THREE.CapsuleGeometry(0.03, 0.16, 2, 5);
    const NT = 140;
    const stems = mk(stemGeo, NT), heads = mk(headGeo, NT);
    for (let i = 0; i < NT; i++) {
      const side = i % 2 ? 1 : -1;
      const x = side * (2.5 + r() * 9), z = -1.5 - r() * 7;
      const h = 1.1 + r() * 0.9;
      this.dummy.position.set(x, -0.2, z); this.dummy.rotation.set((r() - 0.5) * 0.25, 0, (r() - 0.5) * 0.25);
      this.dummy.scale.set(1, h, 1); this.dummy.updateMatrix();
      stems.setMatrixAt(i, this.dummy.matrix); stems.setColorAt(i, c.setRGB(0.25 + r() * 0.1, 0.35 + r() * 0.1, 0.12));
      this.dummy.position.y = -0.2 + h * 0.86; this.dummy.scale.set(1, 1, 1); this.dummy.updateMatrix();
      heads.setMatrixAt(i, this.dummy.matrix); heads.setColorAt(i, c.setRGB(0.3, 0.17, 0.08));
    }
    this.scene.add(stems, heads);

    // Lily pads: notched discs floating on the left.
    const padGeo = new THREE.CircleGeometry(0.45, 9, 0.3, Math.PI * 2 - 0.6); padGeo.rotateX(-Math.PI / 2);
    const NP = 70;
    const pads = mk(padGeo, NP);
    for (let i = 0; i < NP; i++) {
      const cx = -16 - r() * 14, cz = -12 - r() * 20;
      this.dummy.position.set(cx + (r() - 0.5) * 8, 0.02, cz + (r() - 0.5) * 8);
      this.dummy.rotation.set(0, r() * 6.28, 0); const s = 0.6 + r() * 0.9; this.dummy.scale.set(s, 1, s);
      this.dummy.updateMatrix(); pads.setMatrixAt(i, this.dummy.matrix);
      pads.setColorAt(i, c.setRGB(0.12 + r() * 0.08, 0.3 + r() * 0.1, 0.1));
    }
    this.scene.add(pads);
  }

  private buildRod() {
    const blank = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(0.08, 0.08, 0.09), roughness: 0.35, metalness: 0.3 });
    const cork = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(0.62, 0.46, 0.3), roughness: 0.9 });
    const reelM = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(0.5, 0.52, 0.55), roughness: 0.3, metalness: 0.8 });
    const L = 2.1;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.013, L, 6), blank);
    rod.position.y = L / 2 + 0.2;
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.015, 0.34, 8), cork);
    handle.position.y = 0.0;
    const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 12), reelM);
    reel.rotation.z = Math.PI / 2; reel.position.set(0.0, 0.16, 0.045);
    this.rodTip.position.y = L + 0.2;
    this.rodPivot.add(rod, handle, reel, this.rodTip);
    this.rodPivot.position.set(0.33, -0.42, -0.55);
    this.camera.add(this.rodPivot);
  }

  private buildLure() {
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.09, 3, 8), new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(0.75, 0.95, 0.15), roughness: 0.4 }));
    body.rotation.x = Math.PI / 2;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(0.9, 0.15, 0.1), roughness: 0.4 }));
    head.position.z = -0.08;
    this.lure.add(body, head);
    this.lure.scale.setScalar(2.2);
    this.lure.visible = false;
    this.scene.add(this.lure);
  }

  private buildTarget() {
    const floatM = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(1, 0.45, 0.1), roughness: 0.5 });
    const f = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.5, 10), floatM);
    f.position.y = 0.15;
    const top = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.4, 10), new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(1, 1, 1) }));
    top.position.y = 0.6;
    // Target band: everything inside this ring counts as the right distance (±tolerance).
    const ringM = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1, 0.85, 0.3), transparent: true, opacity: 0.85, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.93, 1.0, 64), ringM);
    const fillM = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1, 0.85, 0.3), transparent: true, opacity: 0.12, depthWrite: false });
    ring.add(new THREE.Mesh(new THREE.CircleGeometry(0.93, 64), fillM));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.name = 'zone';
    this.target.add(f, top, ring);
    this.target.visible = false;
    this.scene.add(this.target);
  }

  showTarget(distFt: number | null, aimDeg = 0, tolFrac = 0.15) {
    if (distFt === null) { this.target.visible = false; return; }
    const d = distFt / 3.28084, a = (aimDeg * Math.PI) / 180;
    this.target.position.set(Math.sin(a) * d, 0, -Math.cos(a) * d);
    const zone = this.target.getObjectByName('zone')!;
    zone.scale.setScalar(Math.max(1, d * tolFrac));
    this.target.visible = true;
  }

  private buildLine() {
    const n = 40;
    const pos = new Float32Array(n * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.LineBasicNodeMaterial({ color: new THREE.Color(0.95, 0.95, 0.85), transparent: true, opacity: 0.75 });
    const line = new THREE.Line(g, m);
    line.frustumCulled = false;
    line.visible = false;
    this.scene.add(line);
    return { line, pos };
  }

  private buildDroplets() {
    const m = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0.9, 0.95, 1.0), transparent: true, opacity: 0.85 });
    const im = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.04, 0), m, 36);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.visible = false;
    im.frustumCulled = false;
    for (let i = 0; i < 36; i++) { this.dropVel.push(new THREE.Vector3()); this.dropPos.push(new THREE.Vector3()); }
    this.scene.add(im);
    return im;
  }

  private spawnRing(at: THREE.Vector3, t: number, delay = 0) {
    const mat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1, 0.92, 0.75), transparent: true, opacity: 0.0, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.92, 1.0, 48), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(at.x, 0.02, at.z);
    this.scene.add(mesh);
    this.rings.push({ mesh, t0: t + delay, mat });
  }

  // ---- rod control ----
  armRod() { this.whipKick = 0; }
  backRod() { /* follows live pitch */ }
  whip() { this.whipKick = 1; }

  /** Start the lure flight. Trajectory is camera-local (x right, -z forward) from the rod tip. */
  launch(traj: Trajectory, nowS: number) {
    this.traj = traj;
    this.flightT0 = nowS;
    this.state = 'flying';
    this.lure.visible = true;
    this.line.visible = true;
    this.droplets.visible = false;
    this.landedAt = -1;
  }

  reset() {
    this.state = 'idle';
    this.lure.visible = false;
    this.line.visible = false;
    this.traj = null;
  }

  update(nowS: number, dtS: number) {
    // Rod pitch: follow the phone's live pitch when we have it, plus a whip impulse.
    let target = 28;
    if (this.liveBeta !== null) target = Math.max(-8, Math.min(105, this.liveBeta - 50));
    if (this.whipKick > 0) { target = -12; this.whipKick = Math.max(0, this.whipKick - dtS * 4); }
    const k = 260, c = 26;
    this.rodVel += ((target - this.rodPitch) * k - this.rodVel * c) * dtS;
    this.rodPitch += this.rodVel * dtS;
    this.rodPivot.rotation.set((-(90 - this.rodPitch) * Math.PI) / 180 * 0.85, 0, -0.12);

    const tip = this.rodTip.getWorldPosition(this.tmp).clone();
    if (this.state === 'flying' && this.traj) {
      const t = nowS - this.flightT0;
      const pts = this.traj.pts;
      let i = 0;
      while (i < pts.length - 1 && pts[i + 1].t < t) i++;
      const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
      const f = b.t > a.t ? Math.min(1, (t - a.t) / (b.t - a.t)) : 1;
      const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f, z = a.z + (b.z - a.z) * f;
      // trajectory origin is the rod tip at launch height
      this.lure.position.set(x, y, z);
      this.lure.lookAt(this.lure.position.x + (b.x - a.x), this.lure.position.y + (b.y - a.y), this.lure.position.z + (b.z - a.z));
      if (t >= this.traj.flightS) {
        this.state = 'landed';
        this.landedAt = nowS;
        this.landPos.set(x, 0, z);
        this.lure.position.set(x, 0.03, z);
        this.splash(this.landPos, nowS);
        this.onLand(this.traj);
      }
    } else if (this.state === 'landed') {
      const t = nowS - this.landedAt;
      this.lure.position.y = 0.03 + Math.sin(t * 5) * 0.05 * Math.exp(-t * 0.8);
      this.lure.rotation.set(0, t * 0.2, Math.sin(t * 3) * 0.2 * Math.exp(-t));
    }
    // Keep the lure readable at range (min ~6 px tall)
    if (this.lure.visible) this.lure.scale.setScalar(Math.max(2.2, this.lure.position.distanceTo(this.camera.position) * 0.06));
    // Fishing line from rod tip to lure
    if (this.line.visible) {
      const L = this.lure.position;
      const n = this.linePos.length / 3;
      const sag = this.state === 'landed' ? 0.55 : 0.12;
      const span = tip.distanceTo(L);
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const x = tip.x + (L.x - tip.x) * u, z = tip.z + (L.z - tip.z) * u;
        let y = tip.y + (L.y - tip.y) * u - Math.sin(Math.PI * u) * span * 0.05 * sag;
        if (this.state === 'landed') y = Math.max(0.01, y);
        this.linePos[i * 3] = x; this.linePos[i * 3 + 1] = y; this.linePos[i * 3 + 2] = z;
      }
      (this.line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }
    // Splash droplets
    if (this.droplets.visible) {
      let alive = 0;
      for (let i = 0; i < this.dropPos.length; i++) {
        const p = this.dropPos[i], v = this.dropVel[i];
        v.y -= 9.81 * dtS; p.addScaledVector(v, dtS);
        if (p.y > -0.1) alive++;
        this.dummy.position.copy(p); this.dummy.scale.setScalar(p.y > 0 ? 1 : 0.001); this.dummy.updateMatrix();
        this.droplets.setMatrixAt(i, this.dummy.matrix);
      }
      this.droplets.instanceMatrix.needsUpdate = true;
      if (!alive) this.droplets.visible = false;
    }
    // Ripple rings
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      const t = nowS - r.t0;
      if (t < 0) continue;
      const s = 0.2 + t * 1.6;
      r.mesh.scale.set(s, s, 1);
      r.mat.opacity = Math.max(0, 0.6 * (1 - t / 2.8));
      if (t > 2.8) { this.scene.remove(r.mesh); r.mesh.geometry.dispose(); r.mat.dispose(); this.rings.splice(i, 1); }
    }
    // Gentle idle camera breathing
    this.camera.position.y = 1.75 + Math.sin(nowS * 0.7) * 0.01;
  }

  private splash(at: THREE.Vector3, nowS: number) {
    const r = Math.random;
    for (let i = 0; i < this.dropPos.length; i++) {
      this.dropPos[i].set(at.x + (r() - 0.5) * 0.2, 0.02, at.z + (r() - 0.5) * 0.2);
      const a = r() * Math.PI * 2, sp = 0.5 + r() * 1.6;
      this.dropVel[i].set(Math.cos(a) * sp, 1.8 + r() * 2.4, Math.sin(a) * sp);
    }
    this.droplets.visible = true;
    this.spawnRing(at, nowS, 0);
    this.spawnRing(at, nowS, 0.35);
    this.spawnRing(at, nowS, 0.8);
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 1 ? 72 : 58;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

/** Probe WebGPU properly (navigator.gpu AND a real adapter) before using it; otherwise go straight to WebGL2. */
export async function createRenderer(canvas: HTMLCanvasElement): Promise<{ renderer: THREE.WebGPURenderer; info: RendererInfo }> {
  const force = new URLSearchParams(location.search).get('renderer');
  let reason = '';
  let useGPU = false;
  let device: any = null;
  if (force === 'webgl2') reason = 'forced by ?renderer=webgl2';
  else if (sessionStorage.getItem('bcs.gpuLost')) reason = 'WebGPU device was lost earlier this session';
  else {
    const gpu = (navigator as any).gpu;
    if (!gpu) reason = 'navigator.gpu missing';
    else {
      try {
        const adapter = await Promise.race([gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 2500))]);
        if (adapter) {
          // Reuse the probed adapter's device so we never hold two WebGPU instances.
          device = await (adapter as any).requestDevice({ requiredFeatures: [...(adapter as any).features].filter((f: string) => ['float32-filterable', 'texture-compression-bc', 'texture-compression-etc2', 'texture-compression-astc', 'timestamp-query', 'float32-blendable', 'rg11b10ufloat-renderable', 'depth32float-stencil8'].includes(f)) });
          useGPU = true; reason = 'adapter ok';
        } else reason = 'requestAdapter() returned null';
      } catch (e) { reason = 'requestAdapter() threw: ' + (e as Error).message; }
    }
  }
  const make = async (webgl: boolean) => {
    const r = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: webgl, powerPreference: 'high-performance', ...(!webgl && device ? { device } : {}) } as any);
    await r.init();
    return r;
  };
  let renderer: THREE.WebGPURenderer;
  if (useGPU) {
    try { renderer = await make(false); }
    catch (e) { reason = 'WebGPU init failed: ' + (e as Error).message; useGPU = false; renderer = await make(true); }
  } else renderer = await make(true);
  const isGPU = !!(renderer.backend as any).isWebGPUBackend;
  if (isGPU) {
    // If the GPU device is lost (driver reset, sleep, headless quirks), fall back to WebGL2 by reloading.
    // The pairing survives because the host session lives in sessionStorage.
    (renderer as any).onDeviceLost = (i: any) => {
      console.warn('[renderer] WebGPU device lost -> switching to WebGL2:', i?.message || i?.reason);
      sessionStorage.setItem('bcs.gpuLost', String(i?.reason || 'lost'));
      location.reload();
    };
    // Some drivers surface a dead device only as rejected popErrorScope() promises.
    addEventListener('unhandledrejection', (e) => {
      const msg = String((e.reason && (e.reason.message || e.reason)) || '');
      if (/Instance dropped|device (was )?(lost|destroyed)/i.test(msg)) {
        e.preventDefault();
        if (!sessionStorage.getItem('bcs.gpuLost')) (renderer as any).onDeviceLost({ reason: 'instance-dropped', message: msg });
      }
    });
  }
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return { renderer, info: { kind: isGPU ? 'WebGPU' : 'WebGL2', reason } };
}
