// シーン「川」。焚火の奥を左右に川が流れる河原。手前は丸い石の河原、対岸は土手と木のシルエット。
// 水面は池と同じ作り（ノーマルマップ＋フレネル反射の近似）に、流れの向きのスクロールと、岩・浅瀬の白い泡を足してある。
// 形式は scenes/index.js のコメントを参照。草地（FABOTANIC）ではなく、池と同じ簡易の草の束を、対岸側と左右の端にだけ置く（草の量の設定に従う）。
import * as THREE from 'three';
import { mulberry32, rnd, clamp, tileNoise, heightToNormalTexture, radialTexture, disposeTree } from './util.js';
import { fbm3, rockNormalMap, noisedRockGeometry } from './rock.js';
import { buildTrees, leafTexture } from './trees.js';

/* ---------- 川の形（x が川に沿う。流れは右 +x から左 -x へ）。川幅 4〜6m。両端は絞って霧の中に消える ---------- */
const Y_WATER = -0.08;
const FLOW = -1;                                       // 流れの向き（x 方向の符号）
const smooth = (a, b, x) => { x = clamp((x - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
const zc = (x) => -4.6 + 0.5 * Math.sin(0.22 * x + 0.5) + 0.22 * Math.sin(0.51 * x + 2.0);
const hw = (x) => Math.max(0.05, (2.3 + 0.3 * Math.sin(0.31 * x + 1.2)) * (1 - smooth(15, 24, Math.abs(x))));
const X_END = 24;
const bedY = (w) => -0.02 - 0.75 * smooth(0, 0.45, w);   // w: 岸 0 → 中央 1
const bermH = (d) => {                                   // 対岸の土手の高さ（岸からの距離 d）
  const P = [[0, 0.0], [0.5, 0.12], [1.2, 0.28], [2.2, 0.4], [3.5, 0.36], [5.5, 0.2], [8, 0.0]];
  if (d <= 0) return 0; if (d >= 8) return 0;
  for (let i = 1; i < P.length; i++) if (d <= P[i][0]) { const t = (d - P[i - 1][0]) / (P[i][0] - P[i - 1][0]); return P[i - 1][1] + (P[i][1] - P[i - 1][1]) * t * t * (3 - 2 * t); }
  return 0;
};

const ROCKS = [   // 水面に頭を出した岩: x, z（川の中心線からの比 off）, 半径, 高さ, 泡の尾の長さ
  { x: -4.2, off: 0.15, r: 0.62, ry: 0.42, tail: 2.6 }, { x: 0.8, off: -0.3, r: 0.5, ry: 0.36, tail: 2.2 },
  { x: 4.3, off: 0.35, r: 0.58, ry: 0.46, tail: 2.8 }, { x: -1.7, off: -0.55, r: 0.4, ry: 0.32, tail: 1.8 },
  { x: 8.2, off: -0.1, r: 0.46, ry: 0.36, tail: 2.0 }, { x: -8.6, off: 0.3, r: 0.54, ry: 0.4, tail: 2.4 }
];
ROCKS.forEach((r) => { r.z = zc(r.x) + r.off * hw(r.x); });

const SEASON = {
  spring: { moonAz: 0.5, crown: 0x3a2433, crownE: 0x6a2f50, coniE: 0x0c1c14, grass: 0x4f7a3a, berm: 0x000000, snow: false, float: 'petal', ff: 1, deep: 0x04161c },
  summer: { moonAz: 0.55, crown: 0x0e1c14, crownE: 0x103a26, coniE: 0x0a2016, grass: 0x2f7a33, berm: 0x000000, snow: false, float: '', ff: 2, deep: 0x03141a },
  autumn: { moonAz: 0.45, crown: 0x2a160a, crownE: 0x6a3410, coniE: 0x101a0e, grass: 0x9a6a2a, berm: 0x000000, snow: false, float: 'leaf', ff: 1, deep: 0x04151a },
  winter: { moonAz: 0.5, crown: 0x1c2634, crownE: 0x3a5878, coniE: 0x182838, grass: 0x6b7a8c, berm: 0x2c3846, snow: true, float: '', ff: 1, deep: 0x04141f }
};
const GRASS_N = { many: 200, normal: 120, few: 50, none: 0 };

function skyDir(az, el) { return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)); }
const MOON_EL = { spring: 0.16, summer: 0.1, autumn: 0.18, winter: 0.21 };
const MOON_COL = { spring: 0xffe6d6, summer: 0xffdf95, autumn: 0xffd9aa, winter: 0xeef4ff };
const SKY_ZEN = { spring: 0x2a1c3c, summer: 0x0c1a48, autumn: 0x3a1e12, winter: 0x284a70 };
const SKY_HOR = { spring: 0x6a4a80, summer: 0x24407e, autumn: 0x80502c, winter: 0x6a98c8 };

/* ---------- 水面のシェーダー ---------- */
const WATER_VERT = `
#include <fog_pars_vertex>
varying vec3 vW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const WATER_FRAG = `
uniform float uTime, uFlame;
uniform sampler2D uN1, uN2, uFoam;
uniform vec3 uFire, uMoonDir, uMoonCol, uZen, uHor, uDeep, uShallow;
uniform vec4 uRock[${ROCKS.length}];
varying vec3 vW;
#include <fog_pars_fragment>
float tkZc(float x) { return -4.6 + 0.5 * sin(0.22 * x + 0.5) + 0.22 * sin(0.51 * x + 2.0); }
float tkHw(float x) { return max(0.05, (2.3 + 0.3 * sin(0.31 * x + 1.2)) * (1.0 - smoothstep(15.0, 24.0, abs(x)))); }
void main() {
  vec2 p = vW.xz;
  float c = tkZc(p.x), h = tkHw(p.x);
  float edge = h - abs(p.y - c);                     // 岸までの距離（水の上なら正）
  if (edge < 0.0) discard;
  // 流れ: 右から左へ。ノーマルマップを流れの向きに引き伸ばし、速さの違う2枚をずらして重ねる
  vec3 a = texture2D(uN1, vec2(p.x + uTime * 0.85, p.y) * vec2(0.17, 0.6)).xyz * 2.0 - 1.0;
  vec3 b = texture2D(uN2, vec2(p.x + uTime * 1.3 + 3.7, p.y) * vec2(0.33, 1.05)).xyz * 2.0 - 1.0;
  // 泡: 岩の周り（ぶつかる所と、下流へ伸びる尾）、浅瀬、岸
  float f1 = texture2D(uFoam, vec2(p.x + uTime * 1.0, p.y) * vec2(0.5, 2.3)).r;
  float f2 = texture2D(uFoam, vec2(p.x + uTime * 1.35 + 1.3, p.y) * vec2(1.05, 4.4) + 0.37).r;
  float fn = f1 * 0.6 + f2 * 0.4;
  float foam = 0.0;
  for (int i = 0; i < ${ROCKS.length}; i++) {
    vec4 r = uRock[i];
    vec2 d = p - r.xy;
    float s = -d.x;                                  // 下流（-x）への距離
    float rim = 1.0 - smoothstep(0.0, 0.55, length(d) - r.z);
    float wd = r.z * 1.05 + 0.11 * max(s, 0.0);
    float tail = step(-r.z * 0.6, s) * exp(-max(s, 0.0) / r.w) * (1.0 - smoothstep(wd * 0.3, wd, abs(d.y)));
    float up = 1.0 - smoothstep(0.0, 0.4, length(d + vec2(r.z * 0.8, 0.0)) - r.z * 0.45);
    float con = 1.0 - smoothstep(r.z * 0.95, r.z * 1.3 + 0.06, length(d));   // 岩が水面と接するふち: 白い泡の縁
    foam = max(foam, max(max(rim * 0.85, con * 0.95), max(tail, up * 0.7)));
  }
  float pn = texture2D(uFoam, p * vec2(0.06, 0.22) + vec2(uTime * 0.02, 0.0)).r;
  float riffle = smoothstep(0.55, 0.8, pn) * smoothstep(0.5, 1.2, edge) * 0.7;      // 瀬: ところどころ白く泡立つ
  float shore = (1.0 - smoothstep(0.0, 0.35, edge)) * 0.6;
  float mask = clamp(max(foam, max(riffle, shore)), 0.0, 1.0);
  float foamV = clamp(mask * smoothstep(0.34, 0.66, fn + mask * 0.35), 0.0, 1.0);
  vec2 sl = (a.xy + b.xy * 0.8) * 0.62 * (1.0 + mask * 1.1);
  vec3 N = normalize(vec3(sl.x, 1.0, sl.y));
  vec3 V = normalize(cameraPosition - vW);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  float fres = 0.03 + 0.97 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 skyTop = mix(vec3(0.010, 0.024, 0.045), uZen, 0.22);
  vec3 skyHor = mix(vec3(0.030, 0.062, 0.085), uHor, 0.20);
  vec3 sky = mix(skyHor, skyTop, smoothstep(0.0, 0.8, R.y));
  // 月: 流れで細かく割れた筋になって揺らぐ
  float md = max(dot(R, uMoonDir), 0.0);
  float shim = 0.65 + 0.35 * sin(uTime * 2.3 + p.x * 7.0 + p.y * 9.0 + a.x * 6.0);
  vec3 moon = uMoonCol * (pow(md, 900.0) * 7.0 + pow(md, 260.0) * 0.8 + pow(md, 50.0) * 0.07) * shim;
  // 焚火: 波の面が焚火を向いたところが橙に光る（炎のゆらぎに連動）
  vec3 toF = uFire - vW; float dF = length(toF); vec3 Lf = toF / dF;
  vec3 fireC = vec3(1.0, 0.46, 0.15);
  float lit = pow(max(dot(N, Lf), 0.0), 1.5);
  vec3 H = normalize(V + Lf);
  float glit = pow(max(dot(N, H), 0.0), 60.0);
  float att = uFlame / (1.0 + dF * dF * 0.1);
  vec3 fire = fireC * att * (lit * 0.22 + glit * 1.2);
  vec3 Rq = floor(R * 70.0); float sh = fract(sin(dot(Rq, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  sky += vec3(0.7, 0.8, 1.0) * step(0.9965, sh) * smoothstep(0.1, 0.4, R.y) * (0.6 + 0.4 * sin(uTime * 2.0 + sh * 50.0)) * 0.7;
  // 水の色: 深い所は暗い青緑、岸の浅い所は明るく透ける
  float sh2 = 1.0 - smoothstep(0.0, 1.3, edge);
  vec3 body = mix(uDeep * (0.8 + 0.4 * a.z), uShallow, sh2) + fireC * uFlame * 0.025 / (1.0 + dF * dF * 0.06);
  vec3 mixc = body * (1.0 - fres) + sky * fres;
  float alpha = clamp(0.34 + fres * 0.6 - sh2 * 0.2, 0.0, 0.94);
  vec3 col = mixc * alpha + (moon + fire) * (0.5 + fres * 1.6);
  // 泡の色: 月と焚火の光を受けた白
  vec3 foamC = vec3(0.2, 0.25, 0.32) * (0.6 + 0.6 * length(uMoonCol)) + fireC * att * 0.8 + vec3(0.04, 0.05, 0.07);
  // 流れに沿って走る細い白い筋（川全体。流れの速さで左へ動く）
  float lines = smoothstep(0.72, 0.92, texture2D(uFoam, vec2(p.x + uTime * 1.1 + 5.1, p.y) * vec2(0.24, 2.7)).r) * smoothstep(0.0, 0.5, edge);
  foamV = max(foamV, lines * 0.32);
  col = col * (1.0 - foamV) + foamC * foamV;
  alpha = max(alpha, foamV * 0.94);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export default {
  id: 'river',
  label: '川',
  audio: { autoOn: ['river'], reverb: null },
  props: { logPile: { x: -2.0, z: 0.45, rotY: 0.45 }, pebbles: false },   // 水際から離す。共通の小石は川の水の中に出るので置かない

  build(ctx) {
    const { scene, root, ground, uScale } = ctx;
    let disposed = false, cfg = SEASON.summer, season = 'summer', grassLevel = '', curT = 0;
    const texs = [], geos = [], mats = [];
    const own = (list, x) => { list.push(x); return x; };
    const rng = mulberry32(5521);
    const tmp = new THREE.Vector3();
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), col = new THREE.Color();
    const NX = 100, step = (2 * X_END) / NX;

    /* --- 地面に川の穴をあける（地面の形を差し替え、dispose で戻す） --- */
    let origGround = null, holeGeo = null;
    const origGroundColor = ground ? ground.material.color.clone() : null;
    if (ground) {
      const R = ground.geometry.parameters ? ground.geometry.parameters.radius : 140;
      const shape = new THREE.Shape();
      for (let i = 0; i < 64; i++) { const a = i / 64 * Math.PI * 2; i ? shape.lineTo(Math.cos(a) * R, Math.sin(a) * R) : shape.moveTo(Math.cos(a) * R, Math.sin(a) * R); }
      const hole = new THREE.Path();
      for (let i = 0; i <= NX; i++) { const x = -X_END + i * step; const z = zc(x) + hw(x); i ? hole.lineTo(x, -z) : hole.moveTo(x, -z); }
      for (let i = NX; i >= 0; i--) { const x = -X_END + i * step; hole.lineTo(x, -(zc(x) - hw(x))); }
      shape.holes.push(hole);
      holeGeo = new THREE.ShapeGeometry(shape);
      const pp = holeGeo.attributes.position, uv = holeGeo.attributes.uv;
      for (let i = 0; i < pp.count; i++) uv.setXY(i, pp.getX(i) / R / 2 + 0.5, pp.getY(i) / R / 2 + 0.5);
      origGround = ground.geometry; ground.geometry = holeGeo;
      ground.material.color.setRGB(0.82, 0.84, 0.9);   // 河原は少し灰色に（dispose で戻す）
    }

    /* --- 川底と対岸の土手 --- */
    {
      const NU = 14, P = [], C = [], I = [], cc = new THREE.Color();
      for (let j = 0; j <= NU; j++) for (let i = 0; i <= NX; i++) {
        const x = -X_END + i * step, u = -1 + 2 * j / NU, w = 1 - Math.abs(u);
        P.push(x, bedY(w), zc(x) + u * hw(x));
        const k = 0.55 + 0.7 * fbm3(x * 1.3, j * 0.9, 3, 3);
        cc.setHex(w < 0.15 ? 0x3a352e : 0x23221f).multiplyScalar(k); C.push(cc.r, cc.g, cc.b);
      }
      for (let j = 0; j < NU; j++) for (let i = 0; i < NX; i++) { const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1; I.push(a, c, b, b, c, d); }
      const g = own(geos, new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); g.setIndex(I); g.computeVertexNormals();
      root.add(new THREE.Mesh(g, own(mats, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }))));
    }
    const bermMat = own(mats, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    {
      const D = [0, 0.5, 1.2, 2.2, 3.5, 5.5, 8], P = [], C = [], I = [], cc = new THREE.Color();
      for (let j = 0; j < D.length; j++) for (let i = 0; i <= NX; i++) {
        const x = -X_END + i * step, d = D[j];
        const bump = 0.08 * (fbm3(x * 0.7, d * 0.6, 7, 3) - 0.5) * 2 * Math.min(1, d);
        P.push(x, Math.max(0.006, bermH(d) + bump), zc(x) - hw(x) - d);
        const k = 0.5 + 0.8 * fbm3(x * 1.1, d * 0.8, 1, 3), grassy = smooth(0.4, 3, d) * (0.4 + 0.6 * fbm3(x * 0.5, d * 0.5, 9, 2));
        cc.setHex(0x4a3a2a).lerp(cc.clone().setHex(0x3c5030), grassy).multiplyScalar(k); C.push(cc.r, cc.g, cc.b);
      }
      for (let j = 0; j < D.length - 1; j++) for (let i = 0; i < NX; i++) { const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1; I.push(a, b, c, b, d, c); }
      const g = own(geos, new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); g.setIndex(I); g.computeVertexNormals();
      root.add(new THREE.Mesh(g, bermMat));
    }

    /* --- 水面 --- */
    const nt1 = own(texs, heightToNormalTexture(tileNoise(128, 4, 4, 11), 128, 128, 5.0));
    const nt2 = own(texs, heightToNormalTexture(tileNoise(128, 6, 3, 23), 128, 128, 3.5));
    const foamTex = (() => {
      const n = tileNoise(128, 5, 3, 41), d = new Uint8Array(128 * 128 * 4);
      for (let i = 0; i < n.length; i++) { const v = Math.round(clamp((n[i] - 0.25) * 1.9, 0, 1) * 255); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
      const t = new THREE.DataTexture(d, 128, 128, THREE.RGBAFormat);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
      return own(texs, t);
    })();
    const rockU = ROCKS.map((r) => new THREE.Vector4(r.x, r.z, r.r, r.tail));
    const WU = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]);
    Object.assign(WU, {
      uTime: { value: 0 }, uFlame: { value: 0 }, uN1: { value: nt1 }, uN2: { value: nt2 }, uFoam: { value: foamTex },
      uFire: { value: new THREE.Vector3(0, 0.55, 0) }, uMoonDir: { value: new THREE.Vector3() }, uMoonCol: { value: new THREE.Color() },
      uZen: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uDeep: { value: new THREE.Color(0x03141a) }, uShallow: { value: new THREE.Color(0x0e2a2c) },
      uRock: { value: rockU }
    });
    const waterMat = own(mats, new THREE.ShaderMaterial({
      uniforms: WU, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, fog: true,
      transparent: true, depthWrite: false, premultipliedAlpha: true, side: THREE.DoubleSide
    }));
    {
      const NU = 6, P = [], I = [];
      for (let j = 0; j <= NU; j++) for (let i = 0; i <= NX; i++) {
        const x = -X_END + i * step, u = -1.06 + 2.12 * j / NU;
        P.push(x, Y_WATER, zc(x) + u * hw(x));
      }
      for (let j = 0; j < NU; j++) for (let i = 0; i < NX; i++) { const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1; I.push(a, c, b, b, c, d); }
      const g = own(geos, new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I);
      const water = new THREE.Mesh(g, waterMat); water.renderOrder = 4; water.frustumCulled = false; root.add(water);
    }

    /* --- 川の中の岩 --- */
    const rockNormal = own(texs, rockNormalMap(256, 29, 5));
    const rockMat = own(mats, new THREE.MeshStandardMaterial({ color: 0x9a968c, roughness: 0.42, metalness: 0, emissive: 0x0a1018, normalMap: rockNormal, normalScale: new THREE.Vector2(1.3, 1.3) }));
    // 水に濡れた跡: 水面より下と、水面すれすれの帯を暗く青黒くする（水から頭を出して見える）。座標はワールドの高さ
    rockMat.onBeforeCompile = (sh) => {
      sh.vertexShader = 'varying float vTkY;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
  { vec4 tkp = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      tkp = instanceMatrix * tkp;
    #endif
    vTkY = (modelMatrix * tkp).y; }`);
      sh.fragmentShader = 'varying float vTkY;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
  { float tkWet = 1.0 - smoothstep(${Y_WATER.toFixed(3)}, ${(Y_WATER + 0.2).toFixed(3)}, vTkY);
    diffuseColor.rgb *= mix(1.0, 0.28, tkWet) * mix(vec3(1.0), vec3(0.75, 0.88, 1.0), tkWet); }`);
    };
    rockMat.customProgramCacheKey = () => 'tkriverrock';
    {
      const geo = own(geos, noisedRockGeometry(2, 4.4, 0.26));
      const im = new THREE.InstancedMesh(geo, rockMat, ROCKS.length);
      ROCKS.forEach((r, i) => {
        q.setFromEuler(e.set((rng() - 0.5) * 0.2, rng() * 6, (rng() - 0.5) * 0.2));
        m4.compose(tmp.set(r.x, Y_WATER - r.ry * 0.35, r.z), q, new THREE.Vector3(r.r * 1.05, r.ry, r.r * 1.05));   // 水面より下へ沈め、頭だけ出す
        im.setMatrixAt(i, m4); im.setColorAt(i, col.setScalar(0.7 + rng() * 0.5));
      });
      im.frustumCulled = false; root.add(im);
    }

    /* --- 手前の河原: 大小の丸い石 --- */
    const stoneMat = own(mats, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0, normalMap: rockNormal, normalScale: new THREE.Vector2(0.6, 0.6) }));
    const stoneSets = [
      { geo: own(geos, noisedRockGeometry(1, 2.2, 0.22)), list: [], lo: 0.14 },
      { geo: own(geos, noisedRockGeometry(1, 6.1, 0.2)), list: [], lo: 0.07 },
      { geo: own(geos, noisedRockGeometry(0, 9.3, 0.18)), list: [], lo: 0 }
    ];
    {
      let guard = 0, n = 0;
      while (n < 1000 && guard++ < 6000) {
        const x = (rng() * 2 - 1) * 13.5, zn = zc(x) + hw(x), z = (zn + 0.7) + (2.7 - zn - 0.7) * Math.pow(rng(), 1.7);
        if (Math.hypot(x, z) < 1.55 || Math.hypot(x + 2.0, z - 0.1) < 0.55 || Math.hypot(x - 2.05, z - 0.55) < 0.5) continue;
        const k = clamp((2.7 - z) / (2.7 - zn), 0, 1);
        let r = (0.03 + Math.pow(rng(), 2.2) * 0.3) * (0.4 + 0.6 * k);
        if (z > 0.4) r = Math.min(r, 0.06);          // カメラ手前は小さく（焚火をふさがない）
        const set = r >= stoneSets[0].lo ? stoneSets[0] : r >= stoneSets[1].lo ? stoneSets[1] : stoneSets[2];
        set.list.push({ x, z, r, k, zn }); n++;
      }
    }
    const stoneMeshes = stoneSets.map((set) => {
      const im = new THREE.InstancedMesh(set.geo, stoneMat, Math.max(1, set.list.length)); im.frustumCulled = false; im.count = set.list.length;
      set.list.forEach((s, i) => {
        const ry = s.r * (0.55 + rng() * 0.3);
        let y;
        if (s.z < s.zn) { const w = clamp(1 - Math.abs(s.z - zc(s.x)) / hw(s.x), 0, 1); y = bedY(w) + ry * 0.3; } else y = ry * 0.28;
        q.setFromEuler(e.set(rng() * 0.5, rng() * 6, rng() * 0.5));
        m4.compose(tmp.set(s.x, y, s.z), q, new THREE.Vector3(s.r * (1 + rng() * 0.45), ry, s.r * (0.8 + rng() * 0.4)));
        im.setMatrixAt(i, m4);
        s.rn = rng();
      });
      root.add(im); return im;
    });
    const STONE_TONES = [0x6a6a68, 0x5c5650, 0x4e5660, 0x8a8880, 0x6e6254, 0x58585a];
    function paintStones(snow) {
      stoneSets.forEach((set, si) => set.list.forEach((s, i) => {
        col.setHex(STONE_TONES[Math.floor(s.rn * 6)]).multiplyScalar(0.7 + ((s.rn * 97) % 1) * 0.5);
        if (s.z < s.zn + 0.5) col.multiplyScalar(0.7);                   // 水際は濡れて暗い
        if (snow && ((s.rn * 13) % 1) < 0.4 && s.z >= s.zn) col.lerp(tmp2.setHex(0xdfe8f4), 0.75);
        stoneMeshes[si].setColorAt(i, col);
      }));
      stoneMeshes.forEach((m) => { if (m.instanceColor) m.instanceColor.needsUpdate = true; });
    }
    const tmp2 = new THREE.Color();

    /* --- 草の束（対岸側と左右の端だけ。量は設定「草の量」に従う） --- */
    const grassMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xffffff }));
    const NG = 200;
    const tufts = (() => {
      const blades = [];
      for (let i = 0; i < 5; i++) {
        const g = new THREE.ConeGeometry(0.03, 0.42, 4); g.translate(0, 0.21, 0);
        g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3((rng() - 0.5) * 0.14, 0, (rng() - 0.5) * 0.14),
          new THREE.Quaternion().setFromEuler(new THREE.Euler((rng() - 0.5) * 0.5, rng() * 6, (rng() - 0.5) * 0.5)), new THREE.Vector3(1, 0.7 + rng() * 0.7, 1)));
        blades.push(g);
      }
      let P = [], N = [], I = [], off = 0;
      blades.forEach((g) => { P.push(...g.attributes.position.array); N.push(...g.attributes.normal.array); g.index.array.forEach((v) => I.push(v + off)); off += g.attributes.position.count; g.dispose(); });
      const geo = own(geos, new THREE.BufferGeometry());
      geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); geo.setIndex(I);
      const im = new THREE.InstancedMesh(geo, grassMat, NG); im.frustumCulled = false;
      const gr = mulberry32(31);
      for (let i = 0; i < NG; i++) {
        let x, z, y = 0;
        if (i % 2 === 0) {                              // 対岸の土手
          x = (gr() * 2 - 1) * 15; const d = 0.6 + gr() * 6.5; z = zc(x) - hw(x) - d; y = bermH(d);
        } else {                                        // 左右の端（河原の外側）
          const sd = gr() < 0.5 ? -1 : 1; x = sd * (7 + gr() * 6.5); z = -1.5 + gr() * 4.3;
          if (z < zc(x) + hw(x) + 0.4) z = zc(x) + hw(x) + 0.4 + gr();
        }
        if (Math.hypot(x, z) < 2.4) { x *= 2; }
        const s = 0.35 + gr() * 0.45;
        q.setFromEuler(e.set(0, gr() * 6, 0)); m4.compose(tmp.set(x, y, z), q, new THREE.Vector3(s, s, s)); im.setMatrixAt(i, m4);
      }
      im.count = 0; root.add(im); return im;
    })();

    /* --- 対岸の木のシルエット --- */
    const trees = (() => {
      const pts = []; let guard = 0;
      while (pts.length < 48 && guard++ < 800) {
        const x = (rng() * 2 - 1) * 28, d = 4 + rng() * 22, z = zc(clamp(x, -X_END, X_END)) - hw(clamp(x, -X_END, X_END)) - d;
        const az = Math.atan2(x, 3.6 - z);
        if (Math.abs(az - 0.5) < 0.17) continue;          // 月の前には立てない
        pts.push({ x, z, s: 0.9 + rng() * 1.1, y: bermH(Math.min(d, 8)) - 0.05 });
      }
      for (let i = 0; i < 8; i++) { const sd = i % 2 ? 1 : -1; pts.push({ x: sd * (14 + rng() * 9), z: -2 - rng() * 8, s: 0.9 + rng() * 0.8, y: -0.05 }); }
      return buildTrees(pts, 91, 0.55);
    })();
    root.add(trees.group);

    /* --- 季節: 春の花びら・秋の落ち葉（流れに浮かぶ）、冬の雪と氷 --- */
    const NFL = 120;
    const floatMat = own(mats, new THREE.MeshLambertMaterial({ map: own(texs, leafTexture('petal')), transparent: true, alphaTest: 0.04, side: THREE.DoubleSide, depthWrite: false, emissive: 0xb06a88 }));
    const floatLeafMat = own(mats, new THREE.MeshLambertMaterial({ map: own(texs, leafTexture('maple')), transparent: true, alphaTest: 0.04, side: THREE.DoubleSide, depthWrite: false, emissive: 0x8a4418 }));
    const flGeo = own(geos, new THREE.PlaneGeometry(1, 1)); flGeo.rotateX(-Math.PI / 2);
    const floaters = new THREE.InstancedMesh(flGeo, floatMat, NFL); floaters.frustumCulled = false; floaters.visible = false; floaters.renderOrder = 6; root.add(floaters);   // 水面（renderOrder 4）のあとに描いて、水に隠れないようにする
    const fl = [];
    for (let i = 0; i < NFL; i++) fl.push({ x0: (rng() * 2 - 1) * 16, off: (rng() * 2 - 1) * 0.88, ph: rng() * 6.28, r: rng() * 6.28, s: 0.7 + rng() * 0.8, v: 0.5 + rng() * 0.2 });
    function paintFloaters(kind) {
      const cs = kind === 'leaf' ? [0xe0842a, 0xc8471c, 0xd9a12e, 0xa02c14] : [0xffd2e0, 0xffc2d6, 0xffe4ec, 0xf7b0c8];
      floaters.material = kind === 'leaf' ? floatLeafMat : floatMat;
      const size = kind === 'leaf' ? 0.36 : 0.22;
      fl.forEach((f, i) => { f.size = size * f.s; floaters.setColorAt(i, col.setHex(cs[i % cs.length]).multiplyScalar(0.85)); });
      if (floaters.instanceColor) floaters.instanceColor.needsUpdate = true;
    }
    const fsc = new THREE.Vector3();
    function updateFloaters(t) {
      for (let i = 0; i < NFL; i++) {
        const f = fl[i];
        let x = ((f.x0 + FLOW * f.v * t + X_END) % (2 * X_END) + 2 * X_END) % (2 * X_END) - X_END;
        const h = hw(x), edgeFade = smooth(1.4, 2.2, h);                  // 川が細くなる端では消す
        let z = zc(x) + f.off * h + Math.sin(t * 0.7 + f.ph) * 0.08;
        for (const r of ROCKS) { const dx = x - r.x, dz = z - r.z, d = Math.hypot(dx, dz), lim = r.r + 0.16; if (d < lim) z += (dz >= 0 ? 1 : -1) * (lim - d + 0.02); }
        q.setFromEuler(e.set(Math.sin(t * 1.3 + f.ph) * 0.06, f.r + Math.sin(t * 0.4 + f.ph) * 0.25, Math.cos(t * 1.1 + f.ph) * 0.06));
        m4.compose(tmp.set(x, Y_WATER + 0.012 + 0.006 * Math.sin(t * 1.6 + f.ph), z), q, fsc.set(f.size * edgeFade, 1, f.size * edgeFade));
        floaters.setMatrixAt(i, m4);
      }
      floaters.instanceMatrix.needsUpdate = true;
    }
    // 冬: 水際の薄い氷（流れの中は凍らない）と、河原・土手の雪
    const ice = (() => {
      const NR = 4, P = [], C = [], I = [];
      for (const side of [1, -1]) {
        const base = P.length / 3;
        for (let i = 0; i <= NX; i++) {
          const x = -X_END + i * step, h = hw(x), w = (0.4 + 0.3 * fbm3(x * 0.8, side, 2, 2)) * smooth(0.3, 1.5, h);
          for (let j = 0; j <= NR; j++) {
            const off = h + 0.12 - (j / NR) * (w + 0.12);
            P.push(x, Y_WATER + 0.02 + 0.004 * Math.sin(x * 3 + j), zc(x) + side * off);
            C.push(0.86, 0.92, 0.98, j === NR ? 0.0 : j === NR - 1 ? 0.5 : 0.88);
          }
        }
        for (let i = 0; i < NX; i++) for (let j = 0; j < NR; j++) {
          const a = base + i * (NR + 1) + j, b = a + 1, c = a + NR + 1, d = c + 1; I.push(a, b, c, b, d, c);
        }
      }
      const g = own(geos, new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 4)); g.setIndex(I); g.computeVertexNormals();
      const m = new THREE.Mesh(g, own(mats, new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, depthWrite: false, roughness: 0.3, metalness: 0, side: THREE.DoubleSide })));
      m.renderOrder = 5; m.visible = false; root.add(m); return m;
    })();
    const snowTex = own(texs, radialTexture(128, [[0, 'rgba(255,255,255,0.9)'], [0.5, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]));
    const snowGeo = own(geos, new THREE.CircleGeometry(0.5, 14)); snowGeo.rotateX(-Math.PI / 2);
    const snowMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xcfdcee, emissive: 0x1a2840, map: snowTex, transparent: true, depthWrite: false }));
    const snowPatches = new THREE.InstancedMesh(snowGeo, snowMat, 70); snowPatches.frustumCulled = false; snowPatches.visible = false;
    {
      const sr = mulberry32(8);
      for (let i = 0; i < 70; i++) {
        let x, z, y = 0.02;
        if (i % 3) { x = (sr() * 2 - 1) * 12; z = zc(x) + hw(x) + 0.1 + sr() * 5; if (z > 2.4) z = 2.4 - sr(); }
        else { x = (sr() * 2 - 1) * 14; const d = 0.4 + sr() * 6; z = zc(x) - hw(x) - d; y = bermH(d) + 0.02; }
        if (Math.hypot(x, z) < 1.9) x += 2.5;
        const s = 0.6 + sr() * 1.3; q.setFromEuler(e.set(0, sr() * 6, 0));
        m4.compose(tmp.set(x, y, z), q, new THREE.Vector3(s * 1.4, 1, s)); snowPatches.setMatrixAt(i, m4);
      }
      root.add(snowPatches);
    }

    /* --- 季節 --- */
    function applySeason(s) {
      season = s; cfg = SEASON[s];
      WU.uMoonDir.value.copy(skyDir(cfg.moonAz, MOON_EL[s])); WU.uMoonCol.value.setHex(MOON_COL[s]);
      WU.uZen.value.setHex(SKY_ZEN[s]); WU.uHor.value.setHex(SKY_HOR[s]); WU.uDeep.value.setHex(cfg.deep);
      trees.setColors(cfg.crown, cfg.crownE, cfg.coniE);
      grassMat.color.setHex(cfg.grass).multiplyScalar(0.7);
      bermMat.emissive.setHex(cfg.berm);
      paintStones(cfg.snow);
      floaters.visible = !!cfg.float; if (cfg.float) paintFloaters(cfg.float);
      ice.visible = cfg.snow; snowPatches.visible = cfg.snow;
      ctx.fireflies && (ctx.fireflies.value = cfg.ff);
    }

    return {
      setSeason(s) { applySeason(s); },
      update(dt, t, st) {
        curT = t; WU.uTime.value = t;
        const f0 = st.started ? clamp(st.flame, 0, 1.3) : 0;
        WU.uFlame.value = f0 * (0.85 + 0.15 * Math.sin(t * 13 + Math.sin(t * 5) * 2)) + 0.12 * (st.ember || 0);
        const gl = st.grass || 'normal';
        if (gl !== grassLevel) { grassLevel = gl; tufts.count = GRASS_N[gl] || 0; }
        if (cfg.float && st.seasonFx !== false) { floaters.visible = true; updateFloaters(t); } else floaters.visible = false;
      },
      dispose() {
        disposed = true;
        if (ground && origGround) { ground.geometry = origGround; if (holeGeo) holeGeo.dispose(); }
        if (ground && origGroundColor) ground.material.color.copy(origGroundColor);
        ctx.fireflies && (ctx.fireflies.value = 1);
        trees.dispose();
        texs.forEach((x) => x.dispose()); geos.forEach((x) => x.dispose()); mats.forEach((x) => x.dispose());
      }
    };
  }
};
