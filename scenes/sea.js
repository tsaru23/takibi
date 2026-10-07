// シーン「海」。砂浜の焚火の奥に夜の海と水平線。月の光の道、寄せて引く波（泡・濡れた砂）、流木と貝殻、季節の演出（花びら・花火・雪）。
// 形式は scenes/index.js のコメントを参照。波の寄せる時刻は、環境音「さざ波」の予約時刻（index.html の onEnvEvent {kind:'wave'}）に合わせる。
import * as THREE from 'three';
import { mulberry32, rnd, clamp, tileNoise, heightToNormalTexture, makePoints } from './util.js';
import { makeSnowPoints } from './snow.js';

/* ---------- 浜の形（z は奥がマイナス。焚火は原点、カメラは +Z 側から見る）----------
   z > -3 は平ら（y = 0）。沖へ向かってなだらかに下り、y = Y_WATER と交わる z = Z_BASE が静止時の波打ち際。 */
const Y_WATER = -0.143, Z_BASE = -5.4;
const sandY = (z) => { const d = Math.max(-3 - z, 0); return -(0.05 * d + 0.004 * d * d); };
const NFR = 6;   // 同時に持つ波の線の数（波2つ × 3本）
const LAYER = { delay: [0, 0.8, 1.8], amp: [1.0, 0.78, 0.52] };

/* 月は scene3d.js の SEASON_ENV と同じ位置（水面の光の道を月に合わせる）。冷たい秋の月は、月の見た目の色をこのシーンが上書きする */
const SEASON = {
  spring: { zen: 0x1c2a4a, hor: 0x4a4e80, moon: { az: 0.5, el: 0.16, col: 0xffe6d6 }, sand: [1.0, 0.92, 0.9], deep: 0x04121a },
  summer: { zen: 0x0c1a48, hor: 0x24407e, moon: { az: 0.55, el: 0.1, col: 0xffdf95 }, sand: [0.98, 0.95, 0.9], deep: 0x03141c },
  autumn: { zen: 0x1a2a48, hor: 0x40608a, moon: { az: 0.45, el: 0.18, col: 0xdbe8ff, sprite: 0xe4eeff, light: 0xb4ccff }, sand: [0.92, 0.94, 1.0], deep: 0x03121c },
  winter: { zen: 0x284a70, hor: 0x6a98c8, moon: { az: 0.5, el: 0.21, col: 0xeef4ff }, sand: [0.88, 0.94, 1.06], deep: 0x041620 }
};
const skyDir = (az, el) => new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));

/* ---------- 波の泡（水面と砂で共通の GLSL）---------- */
const SWASH_GLSL = `
uniform sampler2D uFoam;
uniform vec4 uFr[${NFR}];   // x: 波頭の z / y: 泡の強さ / z: 泡の帯の幅(m) / w: 有効なら 1
float tkSandY(float z) { float d = max(-3.0 - z, 0.0); return -(0.05 * d + 0.004 * d * d); }
float tkWob(float x, float k) { return 0.32 * sin(x * 0.31 + k * 2.1) + 0.18 * sin(x * 0.83 + k * 4.7 + 1.0) + 0.08 * sin(x * 2.1 + k * 1.3); }
vec2 tkSwash(vec2 p, int i, vec4 f) {
  float kk = float(i);
  float zf = f.x + tkWob(p.x, kk);
  float dz = zf - p.y, w = f.z;
  float n1 = texture2D(uFoam, p * 0.5 + vec2(kk * 0.37, uTime * 0.02)).r;
  float n2 = texture2D(uFoam, p * 1.9 + vec2(0.0, -uTime * 0.05)).r;
  float film = step(0.0, dz);
  float edge = smoothstep(-0.02, 0.05, dz) * (1.0 - smoothstep(0.0, w, dz));
  float lace = smoothstep(0.30, 0.62, n1 * 0.65 + n2 * 0.45 + (1.0 - clamp(dz / w, 0.0, 1.0)) * 0.45);
  float line = 1.0 - smoothstep(0.0, 0.07, abs(dz + 0.02));
  float trail = (1.0 - smoothstep(w, w * 4.5, dz)) * step(w, dz) * smoothstep(0.64, 0.84, n1 * 0.7 + n2 * 0.4) * 0.55;
  return vec2((edge * lace * 0.9 + line * 0.9 + trail) * f.y, film);
}`;

/* ---------- 水面 ---------- */
const WATER_VERT = `
varying vec3 vW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const WATER_FRAG = `
uniform float uTime, uFlame, uWaterY;
uniform sampler2D uN1, uN2, uN3;
uniform vec3 uFire, uMoonDir, uMoonCol, uZen, uHor, uDeep, uHaze;
uniform vec4 uFw[2];     // 花火: x,y = 方位(水平の単位ベクトル) / z = 強さ / w = 色相
varying vec3 vW;
${SWASH_GLSL}
vec3 tkHue(float h) { return clamp(abs(fract(h + vec3(0.0, 0.667, 0.333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0) * 0.7 + 0.3; }
void main() {
  vec2 p = vW.xz;
  float depth = uWaterY - tkSandY(p.y);
  if (depth < -0.01) discard;
  vec3 toC = cameraPosition - vW; float dist = length(toC); vec3 V = toC / dist;
  float far = smoothstep(10.0, 120.0, dist);
  vec3 a = texture2D(uN1, p * 0.09 + vec2(uTime * 0.010, uTime * 0.006)).xyz * 2.0 - 1.0;
  vec3 b = texture2D(uN2, p * 0.23 + vec2(-uTime * 0.015, uTime * 0.011)).xyz * 2.0 - 1.0;
  vec3 c = texture2D(uN3, p * 0.7 + vec2(uTime * 0.028, -uTime * 0.02)).xyz * 2.0 - 1.0;
  // 遠くほど細かい波を弱めて穏やかに
  vec2 sl = (a.xy + b.xy * 0.8 + c.xy * 0.5 * (1.0 - 0.8 * far)) * 0.5;
  vec3 N = normalize(vec3(sl.x, 1.0, sl.y));
  vec3 R = reflect(-V, N); R.y = abs(R.y);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 sky = mix(uHor, mix(vec3(0.004, 0.009, 0.02), uZen, 0.25), smoothstep(0.0, 0.6, R.y));
  // 月: 波の面が月を向いたところのきらめき + 月へ向かう光の道（月の方位を中心にした帯。手前ほど広く、遠くほど細い）
  float md = max(dot(R, uMoonDir), 0.0);
  float shim = 0.6 + 0.4 * sin(uTime * 1.3 + (p.x * 3.0 + p.y * 2.0 + a.x * 6.0) * (1.0 - far));
  vec3 moon = uMoonCol * (pow(md, 1200.0) * 10.0 + pow(md, 300.0) * 1.2 + pow(md, 60.0) * 0.12) * shim;
  vec2 hv = normalize(p - cameraPosition.xz), mh = normalize(uMoonDir.xz);
  float ang = length(vec2(dot(hv, mh) - 1.0, hv.x * mh.y - hv.y * mh.x));
  float spread = mix(0.05, 0.012, far);
  float env = exp(-ang * ang / (spread * spread));
  float facet = smoothstep(-0.02, 0.14, sl.y + 0.03 * (1.0 - far) * sin(p.x * 5.0 + uTime));
  vec3 path = uMoonCol * env * (0.05 + 0.4 * facet) * (0.65 + 0.35 * shim) * (1.0 - 0.3 * far) * 0.55;
  // 花火の光の映り込み（月の道と同じ考え方）
  vec3 fw = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    vec4 f = uFw[i];
    if (f.z > 0.01) {
      float an = length(vec2(dot(hv, f.xy) - 1.0, hv.x * f.y - hv.y * f.x));
      float sp = mix(0.07, 0.025, far);
      fw += tkHue(f.w) * exp(-an * an / (sp * sp)) * f.z * (0.15 + 0.85 * facet) * (0.6 + 0.4 * sin(uTime * 7.0 + p.y * 3.0 + float(i)));
    }
  }
  // 焚火の光: 波の面が焚火の方を向いたところが橙に光る
  vec3 toF = uFire - vW; float dF = length(toF); vec3 Lf = toF / dF;
  vec3 H = normalize(V + Lf);
  float att = uFlame / (1.0 + dF * dF * 0.08);
  vec3 fire = vec3(1.0, 0.46, 0.15) * att * (pow(max(dot(N, Lf), 0.0), 1.5) * 0.12 + pow(max(dot(N, H), 0.0), 60.0) * 0.8);
  // 泡（寄せる波の線・静止時の波打ち際）
  float foam = 0.0;
  for (int i = 0; i < ${NFR}; i++) { vec4 f = uFr[i]; if (f.w > 0.5) foam = max(foam, tkSwash(p, i, f).x); }
  float n1 = texture2D(uFoam, p * 0.7 + vec2(0.0, uTime * 0.03)).r;
  foam = max(foam, (1.0 - smoothstep(0.0, 0.09, depth)) * smoothstep(0.4, 0.8, n1) * 0.3);
  vec3 shallow = mix(vec3(0.03, 0.08, 0.08), uDeep, smoothstep(0.0, 1.4, depth));
  vec3 body = shallow * (0.8 + 0.4 * a.z);
  vec3 mixc = body * (1.0 - fres) + sky * fres;
  float alpha = clamp(mix(0.3, 0.6 + fres * 0.38, smoothstep(0.0, 0.7, depth)), 0.0, 0.97);
  vec3 col = mixc * alpha + (moon + path + fire + fw) * (0.5 + fres * 1.5) + vec3(0.5, 0.55, 0.62) * foam;
  alpha = max(alpha, foam);
  float fg = 1.0 - exp(-pow(dist * 0.0042, 1.7));      // 水平線に向かって空の色へなじむ
  col = col * (1.0 - fg) + uHaze * fg; alpha = mix(alpha, 1.0, fg);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function petalTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'); x.fillStyle = '#fff';
  x.beginPath(); x.moveTo(32, 58); x.bezierCurveTo(4, 42, 8, 10, 26, 6); x.lineTo(32, 15); x.lineTo(38, 6); x.bezierCurveTo(56, 10, 60, 42, 32, 58); x.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export default {
  id: 'sea',
  label: '海',
  audio: { autoOn: ['wave'], reverb: null },
  props: { logPile: { x: -2.0, z: 0.3, rotY: 0.35 } },   // 波が届かない平らな砂の上（z > -3）

  build(ctx) {
    const { root, api, assets, ground, uScale, camera, hills, sky } = ctx;
    let disposed = false;
    const isStopped = () => disposed || ctx.isStopped();
    const texs = [], geos = [], mats = [];
    const own = (list, x) => { list.push(x); return x; };
    let cfg = SEASON.summer, season = '', curT = 0;

    /* --- scene3d.js の共通部分のうち、海の邪魔になるものを控える（離れるとホスト側が戻す）--- */
    hills.setVisible(false);                             // 遠景の丘: 海の方角に出ると水平線を隠す
    if (ground) ground.visible = false;                  // 土の地面のかわりに砂浜を敷く

    /* --- 砂浜 --- */
    const NS = 1.8;
    const sandN = own(texs, heightToNormalTexture(tileNoise(256, 40, 3, 71), 256, 256, 2.4));
    const foamTex = own(texs, (() => {
      const n = tileNoise(128, 12, 3, 5), d = new Uint8Array(128 * 128 * 4);
      for (let i = 0; i < n.length; i++) { const v = Math.round(n[i] * 255); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
      const t = new THREE.DataTexture(d, 128, 128, THREE.RGBAFormat);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.needsUpdate = true; return t;
    })());
    const nt1 = own(texs, heightToNormalTexture(tileNoise(128, 3, 3, 11), 128, 128, 3.0));
    const nt2 = own(texs, heightToNormalTexture(tileNoise(128, 5, 3, 23), 128, 128, 4.0));
    const nt3 = own(texs, heightToNormalTexture(tileNoise(128, 8, 2, 37), 128, 128, 3.5));
    const frU = { value: Array.from({ length: NFR }, () => new THREE.Vector4(0, 0, 1, 0)) };
    const U = {
      uTime: { value: 0 }, uFr: frU, uFoam: { value: foamTex }, uWet: { value: 0 }, uMoonV: { value: new THREE.Vector3() }, uMoonColS: { value: new THREE.Color() },
      uFlame: { value: 0 }, uWaterY: { value: Y_WATER }, uN1: { value: nt1 }, uN2: { value: nt2 }, uN3: { value: nt3 }, uFire: { value: new THREE.Vector3(0, 0.55, 0) },
      uMoonDir: { value: new THREE.Vector3() }, uMoonCol: { value: new THREE.Color() }, uZen: { value: new THREE.Color() }, uHor: { value: new THREE.Color() },
      uDeep: { value: new THREE.Color() }, uHaze: { value: new THREE.Color(0x070a12) }, uFw: { value: [new THREE.Vector4(), new THREE.Vector4()] }
    };
    const sandMat = own(mats, new THREE.MeshStandardMaterial({ color: 0xc9b48c, roughness: 0.96, metalness: 0, normalMap: sandN, normalScale: new THREE.Vector2(0.7, 0.7) }));
    {
      const xs = [-160, -80, -40, -20, -10, -5, -2.5, 0, 2.5, 5, 10, 20, 40, 80, 160];
      const zs = [40, 25, 15, 10, 6, 4, 3];
      for (let z = 2.5; z > -12; z -= 0.4) zs.push(z);
      for (let z = -12; z >= -30; z -= 1.5) zs.push(z);
      const P = [], UV = [], I = [];
      for (const z of zs) for (const x of xs) { P.push(x, sandY(z), z); UV.push(x / NS, z / NS); }
      const W = xs.length;
      for (let j = 0; j < zs.length - 1; j++) for (let i = 0; i < W - 1; i++) { const a = j * W + i, b = a + 1, c = a + W, d = c + 1; I.push(a, b, c, b, d, c); }
      const g = own(geos, new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2)); g.setIndex(I); g.computeVertexNormals();
      sandMat.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, { uTime: U.uTime, uFr: U.uFr, uFoam: U.uFoam, uWet: U.uWet, uMoonV: U.uMoonV, uMoonColS: U.uMoonColS });
        sh.vertexShader = 'varying vec3 vWP;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        sh.fragmentShader = 'varying vec3 vWP;\nuniform float uTime, uWet;\nuniform vec3 uMoonV, uMoonColS;\n' + SWASH_GLSL + '\n' + sh.fragmentShader
          .replace('#include <color_fragment>', `#include <color_fragment>
  float tkWetV = 0.0, tkFoamV = 0.0; vec3 tkGlow = vec3(0.0);
  {
    vec2 sp = vWP.xz;
    float film = 0.0, foam = 0.0;
    for (int i = 0; i < ${NFR}; i++) { vec4 f = uFr[i]; if (f.w > 0.5) { vec2 r = tkSwash(sp, i, f); foam = max(foam, r.x); film = max(film, r.y); } }
    float mem = 1.0 - smoothstep(-0.05, 0.3, sp.y - (${Z_BASE.toFixed(2)} + uWet + tkWob(sp.x, 0.0) * 0.8));
    float n = texture2D(uFoam, sp * 0.06).r, n2 = texture2D(uFoam, sp * 0.5).r;
    tkWetV = max(film, mem * 0.85) * (0.8 + 0.2 * n2);
    tkFoamV = foam * smoothstep(${(Z_BASE - 0.5).toFixed(2)}, ${Z_BASE.toFixed(2)}, sp.y);
    tkGlow = diffuseColor.rgb * 0.07;
    diffuseColor.rgb *= (0.8 + 0.4 * n) * mix(1.0, 0.42, tkWetV) * mix(vec3(1.0), vec3(0.8, 0.9, 1.05), tkWetV);
  }`)
          .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.14, tkWetV);')
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    vec3 tkV = normalize(vViewPosition);
    float tkSp = pow(max(dot(reflect(-tkV, normal), uMoonV), 0.0), 50.0);
    totalEmissiveRadiance += tkGlow * (1.0 - 0.55 * tkWetV) + uMoonColS * tkSp * tkWetV * 0.9 + vec3(0.42, 0.46, 0.5) * tkFoamV;
  }`);
      };
      sandMat.customProgramCacheKey = () => 'tksea-sand';
      root.add(new THREE.Mesh(g, sandMat));
    }

    /* --- 海 --- */
    const waterMat = own(mats, new THREE.ShaderMaterial({ uniforms: U, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, transparent: true, depthWrite: false, premultipliedAlpha: true, side: THREE.DoubleSide }));
    {
      const g = own(geos, new THREE.PlaneGeometry(1800, 288)); g.rotateX(-Math.PI / 2); g.translate(0, Y_WATER, -150);
      const sea = new THREE.Mesh(g, waterMat); sea.renderOrder = 4; sea.frustumCulled = false; root.add(sea);
    }

    /* --- 流木（log.glb の流用）・貝殻・小石 --- */
    (async () => {
      let gltf = null;
      try { gltf = await assets.loadGLTF('assets/models/log.glb'); } catch (e) { return; }
      if (isStopped()) return;
      gltf.scene.updateMatrixWorld(true);
      let mesh = null; gltf.scene.traverse((o) => { if (!mesh && o.isMesh && /^log_/i.test(o.name)) mesh = o; });
      if (!mesh) gltf.scene.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
      if (!mesh) return;
      const geo = own(geos, mesh.geometry.clone()); geo.applyMatrix4(mesh.matrixWorld); geo.computeBoundingBox();
      const bb = geo.boundingBox, sz = bb.getSize(new THREE.Vector3()), c = bb.getCenter(new THREE.Vector3());
      geo.translate(-c.x, -c.y, -c.z);
      const axis = sz.x >= sz.y && sz.x >= sz.z ? 'x' : sz.y >= sz.z ? 'y' : 'z', len = sz[axis], thick = (sz.x + sz.y + sz.z - len) / 2;
      const mat = own(mats, (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material).clone());
      mat.color.setRGB(0.78, 0.74, 0.68); mat.roughness = 1; mat.emissive.setRGB(0.012, 0.012, 0.011);   // 海水にさらされて少し白っぽく（砂より明るくなりすぎない程度）
      [[-3.1, -1.4, 0.25, 1.5, 0.0], [3.1, -1.5, -0.5, 1.2, 0.0]].forEach(([x, z, yaw, L, tilt]) => {
        const m = new THREE.Mesh(geo, mat), s = L / len; m.scale.setScalar(s);
        if (axis === 'y') m.rotation.set(0, 0, Math.PI / 2); else if (axis === 'z') m.rotation.set(0, Math.PI / 2, 0);
        const holder = new THREE.Group(); holder.add(m);
        holder.position.set(x, sandY(z) + thick * s * 0.3, z);   // 波の届かない砂浜（波は最大でも z=-2.9 まで、濡れ跡は -2.6 まで）。砂に少し沈める
         holder.rotation.set(0, yaw, tilt); root.add(holder);
      });
      texs.push(...[mat.map, mat.normalMap, mat.roughnessMap].filter(Boolean));
    })().catch(() => {});
    {
      const rr = mulberry32(909), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), cc = new THREE.Color();
      const shellGeo = own(geos, new THREE.SphereGeometry(1, 7, 4));
      const shells = new THREE.InstancedMesh(shellGeo, own(mats, new THREE.MeshStandardMaterial({ color: 0xe6d8c8, roughness: 0.5, flatShading: true })), 26);
      const pebGeo = own(geos, new THREE.IcosahedronGeometry(1, 0));
      const peb = new THREE.InstancedMesh(pebGeo, own(mats, new THREE.MeshStandardMaterial({ color: 0x5c5852, roughness: 0.9, flatShading: true })), 60);
      const place = (im, n, zmin, zmax, s0, s1, flat) => {
        for (let i = 0; i < n; i++) {
          let x = (rr() - 0.5) * 16; const z = zmin + rr() * (zmax - zmin);
          if (Math.hypot(x, z) < 1.7) x += x < 0 ? -1.8 : 1.8;
          const s = s0 + rr() * (s1 - s0);
          q.setFromEuler(e.set((rr() - 0.5) * 0.3, rr() * 6.28, (rr() - 0.5) * 0.3));
          m4.compose(new THREE.Vector3(x, Math.max(sandY(z), Y_WATER + 0.01) + s * flat * 0.5, z), q, new THREE.Vector3(s, s * flat, s * 0.85));
          im.setMatrixAt(i, m4); im.setColorAt(i, cc.setScalar(0.75 + rr() * 0.5));
        }
      };
      place(shells, 26, -5.3, 1.5, 0.028, 0.055, 0.32); place(peb, 60, -5.4, 2.5, 0.025, 0.07, 0.6);
      shells.frustumCulled = peb.frustumCulled = false; root.add(shells, peb);
    }

    /* --- 季節の演出 --- */
    const petalTex = own(texs, petalTexture());
    const NP = 90;
    const petals = new THREE.InstancedMesh(own(geos, new THREE.PlaneGeometry(0.1, 0.1)), own(mats, new THREE.MeshLambertMaterial({ map: petalTex, transparent: true, alphaTest: 0.05, side: THREE.DoubleSide, depthWrite: false, emissive: 0x2a1520 })), NP);
    petals.frustumCulled = false; petals.visible = false; root.add(petals);
    const pd = []; {
      const cc = new THREE.Color(), cs = [0xffc4d6, 0xffd6e2, 0xf7b0c8];
      for (let i = 0; i < NP; i++) { pd.push({ x: rnd(-9, 9), z: rnd(-7, 4), y: rnd(0, 5), vy: rnd(0.25, 0.55), ph: rnd(0, 20), f1: rnd(1.2, 2.6), f2: rnd(1, 2.2), spin: rnd(-2, 2), tilt: rnd(0.5, 1.1), s: rnd(0.8, 1.4) }); petals.setColorAt(i, cc.setHex(cs[i % 3])); }
    }
    const NSNOW = 520, snow = makeSnowPoints(NSNOW, uScale);
    snow.points.visible = false; root.add(snow.points);
    const sd = []; for (let i = 0; i < NSNOW; i++) sd.push({ x: rnd(-14, 14), z: rnd(-16, 5), y: rnd(0, 6.5), vy: rnd(0.3, 0.7), ph: rnd(0, 20), sz: rnd(0.75, 1.3) });
    // 花火: 遠くの空に開き、水面に光の筋を落とす
    const fwPts = makePoints(260, THREE.AdditiveBlending, 1.5, uScale);
    fwPts.points.visible = false; fwPts.points.renderOrder = 6; root.add(fwPts.points);
    const bursts = []; let fwNext = rnd(12, 30), lastExtFw = -999;
    const hue2rgb = (h) => { const c = new THREE.Color(); c.setHSL(h, 0.85, 0.62); return [c.r, c.g, c.b]; };
    function startBurst(t) {
      const az = (Math.random() < 0.5 ? -1 : 1) * rnd(0.12, 0.8), el = rnd(0.2, 0.42), hue = Math.random();
      if (Math.abs(az - cfg.moon.az) < 0.12) return;
      const dirs = []; for (let i = 0; i < 90; i++) { const u = rnd(-1, 1), th = rnd(0, 6.283), r = Math.sqrt(1 - u * u); dirs.push([r * Math.cos(th), u, r * Math.sin(th), rnd(0.6, 1)]); }
      bursts.push({ t0: t, az, el, hue, col: hue2rgb(hue), col2: hue2rgb((hue + 0.12) % 1), dirs });
      if (bursts.length > 2) bursts.shift();
    }
    const FW_R = 120, FW_LIFE = 3.4, SHELL = 0.8;
    function updateFireworks(t) {
      const P = fwPts; let n = 0; const fwU = U.uFw.value; fwU[0].set(0, 0, 0, 0); fwU[1].set(0, 0, 0, 0);
      for (let bi = bursts.length - 1; bi >= 0; bi--) {
        const b = bursts[bi], u = t - b.t0;
        if (u > SHELL + FW_LIFE) { bursts.splice(bi, 1); continue; }
        const cx = Math.sin(b.az) * Math.cos(b.el) * FW_R, cy = Math.sin(b.el) * FW_R, cz = -Math.cos(b.az) * Math.cos(b.el) * FW_R;
        if (u < SHELL) {          // 打ち上げ: 水平線近くから昇る一粒
          const p = u / SHELL, o = n * 3;
          P.pos[o] = cx; P.pos[o + 1] = 3 + (cy - 3) * (1 - (1 - p) * (1 - p)); P.pos[o + 2] = cz;
          P.size[n] = 0.7; P.alp[n] = 0.9; P.col[o] = 1; P.col[o + 1] = 0.85; P.col[o + 2] = 0.6; n++;
          continue;
        }
        const v = u - SHELL, life = v / FW_LIFE, R = 21 * (1 - Math.exp(-v * 2.3)), fade = Math.pow(Math.max(0, 1 - life), 1.6);
        for (const d of b.dirs) {
          const o = n * 3, k = d[3], c = (n % 3 === 0) ? b.col2 : b.col;
          P.pos[o] = cx + d[0] * R * k; P.pos[o + 1] = cy + d[1] * R * k - 1.5 * v * v; P.pos[o + 2] = cz + d[2] * R * k;
          P.size[n] = 0.8; P.alp[n] = fade * (0.7 + 0.3 * Math.sin(t * 30 + n)); P.col[o] = c[0]; P.col[o + 1] = c[1]; P.col[o + 2] = c[2]; n++;
        }
        const slot = fwU[0].z > 0 ? 1 : 0, f = (v < 0.25 ? v / 0.25 : 1) * fade;
        fwU[slot].set(Math.sin(b.az), -Math.cos(b.az), 0.55 * f, b.hue);
      }
      fwPts.points.visible = n > 0; P.flush(n);
    }

    /* --- 波: 環境音「さざ波」の予約時刻（index.html の onEnvEvent {kind:'wave', rise, fall, peak}）に合わせる。音が無いときは同じ分布で自前の周期 --- */
    const waves = []; let lastExtWave = -999, nextAuto = 1.5, wetRun = 0;
    function addWave(t, a, b, pk) { waves.push({ t0: t, a, b, A: 0.9 + 1.6 * pk }); if (waves.length > 2) waves.shift(); }
    const offEnv = api.onEnvEvent ? api.onEnvEvent((ev) => {
      if (ev.kind === 'wave') { lastExtWave = curT; addWave(curT, ev.rise, ev.fall, ev.peak); }
      else if (ev.kind === 'fw' && season === 'summer') { lastExtFw = curT; fwNext = curT + rnd(40, 90); startBurst(curT); }
    }) : () => {};
    const frUv = (i, z, s, w, on = 1) => { frU.value[i].set(z, s, w, on); };
    function updateWaves(dt, t) {
      if (t - lastExtWave > 16 && t > nextAuto) { const a = rnd(2.2, 3.8), b = rnd(3, 5.5); addWave(t, a, b, rnd(0.6, 1)); nextAuto = t + a + b + rnd(0, 1.2); }
      while (waves.length && t - waves[0].t0 > waves[0].a + waves[0].b + 2.6) waves.shift();
      let slot = 0, run = 0;
      for (const w of waves) for (let k = 0; k < 3; k++) {
        const u = t - w.t0 - LAYER.delay[k], amp = w.A * LAYER.amp[k], zPeak = Z_BASE + amp, zStart = Z_BASE - 3.2 - 0.5 * k;
        let z, str, wd;
        if (u < 0 || u > w.a + w.b) continue;
        if (u < w.a) { const p = u / w.a; z = zStart + (zPeak - zStart) * (1 - Math.pow(1 - p, 2.2)); str = Math.min(1, u / 0.6); wd = 0.5; }
        else { const q = (u - w.a) / w.b; z = zPeak - (zPeak - Z_BASE) * q * q * (3 - 2 * q); str = 0.55 * (1 - q); wd = 0.3; }
        if (slot < NFR) frUv(slot++, z, str, wd);
        run = Math.max(run, z - Z_BASE);
      }
      while (slot < NFR) frUv(slot++, 0, 0, 1, 0);
      wetRun = Math.max(wetRun - dt * 0.035, run); U.uWet.value = wetRun;
    }

    /* --- 季節 --- */
    function applySeason(s) {
      season = s; cfg = SEASON[s];
      U.uZen.value.setHex(cfg.zen); U.uHor.value.setHex(cfg.hor).multiplyScalar(0.35); U.uDeep.value.setHex(cfg.deep);
      U.uMoonCol.value.setHex(cfg.moon.col); U.uMoonColS.value.setHex(cfg.moon.col);
      U.uMoonDir.value.copy(skyDir(cfg.moon.az, cfg.moon.el));
      U.uHaze.value.setHex(cfg.zen).lerp(new THREE.Color(cfg.hor), 0.5).multiplyScalar(0.22).lerp(new THREE.Color(0x090c13), 0.5);
      sandMat.color.setRGB(0.62 * cfg.sand[0], 0.5 * cfg.sand[1], 0.34 * cfg.sand[2]);
      petals.visible = s === 'spring'; snow.points.visible = s === 'winter';
      if (s !== 'winter') snow.flush(0);
      ctx.fireflies && (ctx.fireflies.value = s === 'summer' ? 0.5 : 1);
      // 月の見た目: 秋は涼しい白い月（他の季節は scene3d.js の季節の既定のまま。離れると自動で戻る）
      if (cfg.moon.sprite) sky.setMoonColor(cfg.moon.sprite, 1, cfg.moon.light); else sky.setMoonColor(null);
      bursts.length = 0; fwPts.flush(0);
    }

    const dm = new THREE.Matrix4(), dq = new THREE.Quaternion(), de = new THREE.Euler(), dp = new THREE.Vector3(), ds = new THREE.Vector3(), tmp = new THREE.Vector3();
    return {
      setSeason(s) { applySeason(s); },
      update(dt, t, st) {
        curT = t; U.uTime.value = t;
        const fl0 = st.started ? clamp(st.flame, 0, 1.3) : 0;
        U.uFlame.value = fl0 * (0.85 + 0.15 * Math.sin(t * 13 + Math.sin(t * 5) * 2)) + 0.12 * (st.ember || 0);
        tmp.copy(U.uMoonDir.value).transformDirection(camera.matrixWorldInverse); U.uMoonV.value.copy(tmp);
        updateWaves(dt, t);
        if (season === 'summer' && st.seasonFx !== false) {
          if (t > fwNext && t - lastExtFw > 20) {   // 音の花火がオフでも、遠くで数発
            const n = 1 + Math.floor(Math.random() * 3); for (let i = 0; i < n; i++) setTimeout(() => { if (!disposed) startBurst(curT); }, i * 1900);
            fwNext = t + rnd(45, 110);
          }
          updateFireworks(t);
        } else if (bursts.length) { bursts.length = 0; fwPts.flush(0); U.uFw.value[0].set(0, 0, 0, 0); U.uFw.value[1].set(0, 0, 0, 0); }
        if (season === 'spring' && st.seasonFx !== false) {
          petals.visible = true;
          for (let i = 0; i < NP; i++) {
            const d = pd[i]; d.y -= d.vy * dt * 0.75; d.x += Math.sin(t * 1.1 + d.ph) * 0.5 * dt + 0.15 * dt; d.z += Math.cos(t * 0.9 + d.ph) * 0.5 * dt;
            if (d.y < 0.03) { d.y = 5; d.x = rnd(-9, 9); d.z = rnd(-7, 4); }
            de.set(Math.sin(t * d.f1 + d.ph) * d.tilt + Math.PI / 2, t * d.spin + d.ph, Math.cos(t * d.f2 + d.ph) * d.tilt); dq.setFromEuler(de);
            dm.compose(dp.set(d.x, Math.max(d.y, sandY(d.z) + 0.02), d.z), dq, ds.setScalar(d.s)); petals.setMatrixAt(i, dm);
          }
          petals.instanceMatrix.needsUpdate = true;
        } else petals.visible = false;
        if (season === 'winter' && st.seasonFx !== false) {
          const P = snow;
          for (let i = 0; i < NSNOW; i++) {
            const d = sd[i], o = i * 3, floor = d.z < Z_BASE ? Y_WATER : sandY(d.z);
            d.y -= d.vy * dt * 0.5; d.x += Math.sin(t * 1.1 + d.ph) * 0.2 * dt; d.z += Math.cos(t * 0.9 + d.ph) * 0.2 * dt;
            if (d.y < floor) { d.y = 6.5; d.x = rnd(-14, 14); d.z = rnd(-16, 5); }
            P.pos[o] = d.x; P.pos[o + 1] = d.y; P.pos[o + 2] = d.z; P.size[i] = 0.032 * d.sz * d.sz;
            P.alp[i] = 0.9 * Math.min(1, (d.y - floor) / 0.35);       // 水面・砂に近づくと、すっと消える
            P.col[o] = 0.93; P.col[o + 1] = 0.96; P.col[o + 2] = 1;
          }
          P.flush(NSNOW); snow.points.visible = true;
        } else if (snow.points.visible) { snow.points.visible = false; snow.flush(0); }
      },
      dispose() {
        disposed = true; offEnv();
        if (ground) ground.visible = true;
        ctx.fireflies && (ctx.fireflies.value = 1);
        texs.forEach((x) => x.dispose()); geos.forEach((x) => x.dispose()); mats.forEach((x) => x.dispose());
      }
    };
  }
};
