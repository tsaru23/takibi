// シーン「池」。焚火の右奥〜右側に置いた、夜の池。水面（ノーマルマップ2枚＋フレネル反射の近似）、蓮の葉と花、錦鯉、メダカの群れ、蛙。
// 形式は scenes/index.js のコメントを参照。水面の反射は Reflector ではなく、空・月・焚火を式で近似する（内蔵GPUでも軽い）。
import * as THREE from 'three';
import { mulberry32, rnd, clamp, mergeGeoms, tileNoise, heightToNormalTexture, loadOptionalModel, materialTextures } from './util.js';
import { loadFarTrees, surroundPoints } from './farTrees.js';

/* ---------- 池の形（焚火の右奥〜右） ----------
   カメラ（0, 1.03, 2.5 から -Z を見る・縦画角55°）は低いので、手前の石囲いの陰にならないよう池を焚火から離し、
   水面が帯として見渡せる位置に置く。右端は 4:3 の画面の右端（奥行き d のとき x = 0.69 d）より内側に収める。
   月の映り込みの筋（カメラから右へ約29°の方向）が池を横切る位置でもある */
const PC = { x: 1.3, z: -3.3, a: 1.95, b: 1.65 };    // 中心と楕円の半径（x 方向 a, z 方向 b）。直径 約3.9 × 3.3m（輪郭のゆらぎで ±10%）
const Y_WATER = -0.06, Y_FLOOR = -1.0;
const outline = (th) => 1 + 0.10 * Math.sin(3 * th + 1.0) + 0.06 * Math.sin(5 * th + 2.0) + 0.04 * Math.sin(2 * th + 0.3);
const pondXZ = (th, u) => { const r = outline(th) * u; return [PC.x + Math.cos(th) * PC.a * r, PC.z + Math.sin(th) * PC.b * r]; };
const pondU = (x, z) => { const dx = (x - PC.x) / PC.a, dz = (z - PC.z) / PC.b; return Math.hypot(dx, dz) / outline(Math.atan2(dz, dx)); };
const FIRE = new THREE.Vector3(0, 0.35, 0);

const SEASON = {
  spring: { leafN: 6, leaf: 0x3d7a3a, frogs: 3, flowers: 0, floating: 0, ice: false, ff: 1, riseEvery: [60, 140], grass: 0x6da85c,
            zen: 0x2a1c3c, hor: 0x6a4a80, moon: { az: 0.5, el: 0.16, col: 0xffe6d6 }, berm: 0x3a2a1c, stone: 1.0, frog: 0x5e8a30 },
  summer: { leafN: 6, leaf: 0x2a6a32, frogs: 3, flowers: 4, floating: 0, ice: false, ff: 2, riseEvery: [50, 120], grass: 0x2f7a33,
            zen: 0x0c1a48, hor: 0x24407e, moon: { az: 0.55, el: 0.1, col: 0xffdf95 }, berm: 0x33261a, stone: 1.0, frog: 0x4a8a2a },
  autumn: { leafN: 5, leaf: 0x6b6a2c, frogs: 1, flowers: 0, floating: 30, ice: false, ff: 1, riseEvery: [100, 220], grass: 0x9a6a2a,
            zen: 0x3a1e12, hor: 0x80502c, moon: { az: 0.45, el: 0.18, col: 0xffd9aa }, berm: 0x3b2a1a, stone: 1.0, frog: 0x7a7a3a },
  winter: { leafN: 4, leaf: 0x5a4a38, frogs: 0, flowers: 0, floating: 0, ice: true, ff: 1, riseEvery: [1e9, 1e9], grass: 0x6b7a8c,
            zen: 0x284a70, hor: 0x6a98c8, moon: { az: 0.5, el: 0.21, col: 0xeef4ff }, berm: 0x8a96a6, stone: 1.6, frog: 0x5e8a30 }
};
const GRASS_N = { many: 70, normal: 40, few: 16, none: 0 };

function skyDir(az, el) { return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)); }
function smooth(a, b, x) { x = clamp((x - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); }

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
uniform float uTime, uFlame, uWaterY;
uniform sampler2D uN1, uN2;
uniform vec3 uFire, uMoonDir, uMoonCol, uZen, uHor, uDeep;
uniform vec4 uRip[8];
varying vec3 vW;
#include <fog_pars_fragment>
void main() {
  vec2 p = vW.xz;
  vec3 a = texture2D(uN1, p * 0.33 + vec2(uTime * 0.013, uTime * 0.009)).xyz * 2.0 - 1.0;
  vec3 b = texture2D(uN2, p * 0.81 + vec2(-uTime * 0.021, uTime * 0.016)).xyz * 2.0 - 1.0;
  vec2 sl = (a.xy + b.xy * 0.8) * 0.62;
  for (int i = 0; i < 8; i++) {
    vec4 r = uRip[i];
    if (r.w > 0.0) {
      vec2 d = p - r.xy; float L = length(d) + 1e-4;
      float ring = L - r.z * 0.5;
      float e = exp(-ring * ring * 55.0) * exp(-r.z * 0.55) * r.w;
      sl += d / L * cos(ring * 30.0) * e * 0.9;
    }
  }
  vec3 N = normalize(vec3(sl.x, 1.0, sl.y));
  vec3 V = normalize(cameraPosition - vW);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  float fres = 0.03 + 0.97 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  // 空の映り込み: 夜の水は暗い青緑〜黒。季節の空の色はうっすら混ぜるだけ（紫に寄せない）
  vec3 skyTop = mix(vec3(0.010, 0.024, 0.045), uZen, 0.22);
  vec3 skyHor = mix(vec3(0.030, 0.062, 0.085), uHor, 0.20);
  vec3 sky = mix(skyHor, skyTop, smoothstep(0.0, 0.8, R.y));
  // 月の映り込み: 波の面が月を向いたところだけ光る。細かく割れた筋になって揺らぐ
  float md = max(dot(R, uMoonDir), 0.0);
  float shim = 0.65 + 0.35 * sin(uTime * 1.7 + p.x * 9.0 + p.y * 6.0 + a.x * 5.0);
  vec3 moon = uMoonCol * (pow(md, 900.0) * 7.0 + pow(md, 260.0) * 0.8 + pow(md, 50.0) * 0.07) * shim;
  // 焚火の光: 池は焚火の斜め奥にあるので鏡像は見えない。かわりに、波の面が焚火の方を向いたところが橙に光る（炎のゆらぎに連動）
  vec3 toF = uFire - vW; float dF = length(toF); vec3 Lf = toF / dF;
  vec3 fireC = vec3(1.0, 0.46, 0.15);
  float lit = pow(max(dot(N, Lf), 0.0), 1.5);
  vec3 H = normalize(V + Lf);
  float glit = pow(max(dot(N, H), 0.0), 60.0);
  float att = uFlame / (1.0 + dF * dF * 0.1);
  vec3 fire = fireC * att * (lit * 0.22 + glit * 1.2);
  // 星の映り込み
  vec3 Rq = floor(R * 70.0); float sh = fract(sin(dot(Rq, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  sky += vec3(0.7, 0.8, 1.0) * step(0.9965, sh) * smoothstep(0.1, 0.4, R.y) * (0.6 + 0.4 * sin(uTime * 2.0 + sh * 50.0)) * 0.7;
  // 水の色: 深い青緑〜黒。濁りは弱め（鯉が透けて見える）。焚火の近くはほんのり温かい
  vec3 body = uDeep * (0.8 + 0.4 * a.z) + fireC * uFlame * 0.025 / (1.0 + dF * dF * 0.06);
  vec3 mixc = body * (1.0 - fres) + sky * fres;
  float alpha = clamp(0.3 + fres * 0.62, 0.0, 0.94);
  vec3 col = mixc * alpha + (moon + fire) * (0.5 + fres * 1.6);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/* 鯉の頂点シェーダー差し込み: 頭は固定、尾に向かって振れ幅が大きくなる進行波。体の模様は局所座標から作る */
function patchKoi(mat, uKT) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uKT = uKT;
    shader.vertexShader = `attribute vec3 aPh; attribute vec3 aC1; attribute vec3 aC2; uniform float uKT;
varying vec3 vC1; varying vec3 vC2; varying vec3 vLp; varying float vSeed; varying float vWY;
` + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
  vec4 tkW = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  tkW = instanceMatrix * tkW;
#endif
  vWY = (modelMatrix * tkW).y;
  vLp = position; vC1 = aC1; vC2 = aC2; vSeed = aPh.z;
  float kw = smoothstep(0.3, -0.75, position.x);
  transformed.z += sin(uKT * aPh.y * 5.5 + aPh.x - position.x * 5.0) * 0.085 * aPh.y * kw * kw
                 + sin(uKT * aPh.y * 5.5 + aPh.x) * 0.012;`);
    shader.fragmentShader = `varying vec3 vC1; varying vec3 vC2; varying vec3 vLp; varying float vSeed; varying float vWY;
` + shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
  {
    float kn = sin(vLp.x * 8.0 + vSeed * 6.0) + sin(vLp.x * 3.1 - vLp.z * 23.0 + vSeed * 3.0) * 0.8 + sin(vLp.x * 13.0 + vLp.y * 17.0 - vSeed) * 0.5;
    float pat = smoothstep(0.15, 0.55, kn * 0.4 + 0.25);
    float top = smoothstep(-0.02, 0.03, vLp.y);
    vec3 kc = mix(vC1, vC2, pat * top);
    kc = mix(kc, vec3(0.92, 0.9, 0.85), smoothstep(-0.02, -0.06, vLp.y) * 0.6);
    // 水の中は暗く青みがかる（水面 y=-0.06 から深いほど）。水面より上に出た部分はそのまま
    float dep = smoothstep(-0.06, -0.30, vWY);
    kc = mix(kc, kc * vec3(0.5, 0.68, 0.88), dep * 0.7);
    diffuseColor.rgb = kc;
  }`).replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += diffuseColor.rgb * 1.0;`);
  };
  mat.customProgramCacheKey = () => 'tkkoi';
}

/* ---------- 形を作る小道具 ---------- */
function koiGeometry() {
  // 体（頭が +X、尾が -X の長さ1）を断面の楕円でつなぎ、尾びれ・胸びれ・背びれを足す。ポリゴン数は約 300
  const NS = 14, NR = 8, P = [], I = [];
  const prof = (t) => 0.095 * Math.pow(Math.sin(Math.PI * Math.pow(clamp(t, 0, 1), 0.85)), 0.9) + 0.008;
  for (let i = 0; i <= NS; i++) {
    const t = i / NS, x = t - 0.5, w = prof(t), h = w * 0.8;
    for (let k = 0; k < NR; k++) {
      const a = k / NR * Math.PI * 2;
      P.push(x, Math.sin(a) * h + (t > 0.3 ? 0.0 : 0.0), Math.cos(a) * w);
    }
  }
  for (let i = 0; i < NS; i++) for (let k = 0; k < NR; k++) {
    const a = i * NR + k, b = i * NR + (k + 1) % NR, c = a + NR, d = b + NR;
    I.push(a, c, b, b, c, d);
  }
  const tri = (a, b, c) => { const o = P.length / 3; P.push(...a, ...b, ...c); I.push(o, o + 1, o + 2, o, o + 2, o + 1); };
  tri([-0.47, 0.0, 0], [-0.78, 0.14, 0], [-0.68, 0.0, 0]);     // 尾びれ（上下2枚でV字）
  tri([-0.47, 0.0, 0], [-0.68, 0.0, 0], [-0.78, -0.14, 0]);
  tri([0.18, 0.02, 0.06], [0.06, -0.03, 0.17], [0.0, 0.0, 0.05]);     // 胸びれ（左右）
  tri([0.18, 0.02, -0.06], [0.06, -0.03, -0.17], [0.0, 0.0, -0.05]);
  tri([0.12, 0.07, 0], [-0.14, 0.15, 0], [-0.2, 0.06, 0]);             // 背びれ
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I); g.computeVertexNormals();
  return g;
}
function leafGeometry() {
  // 蓮の葉: 円形（切れ込み1本）。縁が反った浅い皿
  const NA = 28, NR = 4, notch = 0.42, P = [], I = [];
  for (let j = 0; j <= NR; j++) {
    const r = j / NR;
    for (let i = 0; i <= NA; i++) {
      const a = notch / 2 + (Math.PI * 2 - notch) * i / NA;
      P.push(Math.cos(a) * r, 0.12 * r * r * r + 0.012 * Math.sin(a * 5) * r, Math.sin(a) * r);
    }
  }
  for (let j = 0; j < NR; j++) for (let i = 0; i < NA; i++) {
    const a = j * (NA + 1) + i, b = a + 1, c = a + NA + 1, d = c + 1;
    I.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I); g.computeVertexNormals();
  return g;
}
function flowerGeometry() {
  // 蓮の花: 細長い花びら（楕円体）を2段に並べる
  const parts = [], m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const pg = new THREE.SphereGeometry(1, 6, 4);
  for (let ring = 0; ring < 2; ring++) {
    const n = ring ? 7 : 8;
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2 + ring * 0.4, tilt = ring ? 0.35 : 0.85;
      q.setFromEuler(e.set(tilt, -a, 0, 'YXZ'));
      const r = 0.045 + ring * 0.0;
      m.compose(new THREE.Vector3(Math.cos(a) * r, 0.05 + ring * 0.03, Math.sin(a) * r), q, new THREE.Vector3(0.03, 0.085 - ring * 0.01, 0.012));
      // 花びらは +Y 方向に伸びる楕円体。傾けて外へ開く
      const mm = new THREE.Matrix4().makeRotationY(a).multiply(new THREE.Matrix4().makeRotationZ(-tilt)).premultiply(new THREE.Matrix4().makeTranslation(Math.cos(a) * r, 0.05 + ring * 0.035, Math.sin(a) * r));
      mm.multiply(new THREE.Matrix4().makeScale(0.03, 0.085 - ring * 0.012, 0.014));
      parts.push({ geo: pg, matrix: mm });
    }
  }
  const g = mergeGeoms(parts); pg.dispose();
  return g;
}
function frogParts() {
  // 蛙（+X が正面、体長およそ 1）。体・頭・足 / 目 / 喉袋 の3つに分ける
  const sg = new THREE.SphereGeometry(1, 10, 8);
  const S = (x, y, z, sx, sy, sz, ry = 0) => ({ geo: sg, matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(sx, sy, sz)) });
  const body = mergeGeoms([
    S(0, 0.3, 0, 0.5, 0.33, 0.38), S(0.42, 0.36, 0, 0.27, 0.2, 0.3),
    S(-0.15, 0.17, 0.4, 0.34, 0.14, 0.14, 0.5), S(-0.15, 0.17, -0.4, 0.34, 0.14, 0.14, -0.5),
    S(0.28, 0.1, 0.24, 0.13, 0.08, 0.06), S(0.28, 0.1, -0.24, 0.13, 0.08, 0.06)
  ]);
  const eyes = mergeGeoms([S(0.52, 0.6, 0.15, 0.085, 0.085, 0.085), S(0.52, 0.6, -0.15, 0.085, 0.085, 0.085)]);
  const throat = new THREE.SphereGeometry(1, 10, 8); throat.translate(0, 0, 0);
  sg.dispose();
  return { body, eyes, throat };
}
function petalTex() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.strokeStyle = '#fff'; x.lineCap = 'round';
  x.beginPath();
  for (let i = 0; i <= 90; i++) {
    const th = i / 90 * Math.PI * 2, r = 29 * (0.34 + 0.66 * Math.pow(Math.abs(Math.cos(2.5 * (th - Math.PI / 2))), 1.6));
    const px = 32 + Math.cos(th) * r, py = 30 - Math.sin(th) * r;
    if (i) x.lineTo(px, py); else x.moveTo(px, py);
  }
  x.closePath(); x.fill(); x.lineWidth = 3; x.beginPath(); x.moveTo(32, 30); x.lineTo(32, 62); x.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/* ---------- シーン本体 ---------- */
export default {
  id: 'pond',
  label: '池',
  audio: { autoOn: ['frog', 'scenesfx'], reverb: null, sources: { frog: [{ x: PC.x - 1.2, z: PC.z - 0.9 }, { x: PC.x + 1.3, z: PC.z + 0.5 }, { x: PC.x + 0.2, z: PC.z - 1.3 }], brook: [{ x: PC.x - 2.2, y: 0.1, z: PC.z + 0.3 }] } },

  build(ctx) {
    const { scene, root, api, assets, ground } = ctx;
    let disposed = false;
    const isStopped = () => disposed || ctx.isStopped();
    const texs = [], geos = [], mats = [];
    const own = (list, x) => { list.push(x); return x; };
    const rng = mulberry32(4242);
    let cfg = SEASON.summer, season = '', curT = 0;
    const grp = { leaves: null };

    /* --- 地面に池の穴をあけ、底と岸をつくる（地面の形を差し替え、dispose で戻す） --- */
    let origGround = null, holeGeo = null;
    if (ground) {
      const R = ground.geometry.parameters ? ground.geometry.parameters.radius : 140;
      const shape = new THREE.Shape();
      for (let i = 0; i < 64; i++) { const a = i / 64 * Math.PI * 2; i ? shape.lineTo(Math.cos(a) * R, Math.sin(a) * R) : shape.moveTo(Math.cos(a) * R, Math.sin(a) * R); }
      const hole = new THREE.Path();
      for (let i = 0; i < 96; i++) { const [x, z] = pondXZ(i / 96 * Math.PI * 2, 1.0); i ? hole.lineTo(x, -z) : hole.moveTo(x, -z); }   // 地面は X 軸で -90° 回っているので y = -z
      shape.holes.push(hole);
      holeGeo = new THREE.ShapeGeometry(shape);
      const pp = holeGeo.attributes.position, uv = holeGeo.attributes.uv;
      for (let i = 0; i < pp.count; i++) uv.setXY(i, pp.getX(i) / R / 2 + 0.5, pp.getY(i) / R / 2 + 0.5);   // CircleGeometry と同じ UV（土のタイルを合わせる）
      origGround = ground.geometry; ground.geometry = holeGeo;
    }
    // 底と岸の斜面
    {
      const NT = 96, prof = [[1.0, 0.0], [0.975, -0.12], [0.9, -0.45], [0.82, -0.85], [0.76, Y_FLOOR], [0.0, Y_FLOOR]];
      const P = [], C = [], I = [], nr = mulberry32(7), col = new THREE.Color();
      for (let j = 0; j < prof.length; j++) for (let i = 0; i <= NT; i++) {
        const th = i / NT * Math.PI * 2, [x, z] = pondXZ(th, prof[j][0]);
        P.push(x, prof[j][1], z);
        const k = 0.6 + 0.5 * nr() * (j < 3 ? 1 : 0.5);
        col.setHex(j < 2 ? 0x2a2018 : 0x1a1714).multiplyScalar(k); C.push(col.r, col.g, col.b);
      }
      for (let j = 0; j < prof.length - 1; j++) for (let i = 0; i < NT; i++) {
        const a = j * (NT + 1) + i, b = a + 1, c = a + NT + 1, d = c + 1; I.push(a, c, b, b, c, d);
      }
      const g = own(geos, new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); g.setIndex(I); g.computeVertexNormals();
      const basin = new THREE.Mesh(g, own(mats, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide })));
      root.add(basin);
      // 底の小石
      const pg = new THREE.IcosahedronGeometry(1, 0), pm = new THREE.InstancedMesh(pg, new THREE.MeshStandardMaterial({ color: 0x3a3632, roughness: 1, flatShading: true }), 40);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      for (let i = 0; i < 40; i++) {
        const [x, z] = pondXZ(rng() * 6.28, Math.sqrt(rng()) * 0.74), s = 0.04 + rng() * 0.08;
        q.setFromEuler(e.set(rng() * 3, rng() * 3, rng() * 3)); m4.compose(new THREE.Vector3(x, Y_FLOOR + s * 0.3, z), q, new THREE.Vector3(s * 1.4, s * 0.6, s)); pm.setMatrixAt(i, m4);
      }
      root.add(pm);
    }

    /* --- 水面 --- */
    const nt1 = own(texs, heightToNormalTexture(tileNoise(128, 4, 4, 11), 128, 128, 5.0));
    const nt2 = own(texs, heightToNormalTexture(tileNoise(128, 6, 3, 23), 128, 128, 3.5));
    const ripU = []; for (let i = 0; i < 8; i++) ripU.push(new THREE.Vector4(0, 0, 0, 0));
    const U = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]);
    Object.assign(U, {
      uTime: { value: 0 }, uFlame: { value: 0 }, uWaterY: { value: Y_WATER }, uN1: { value: nt1 }, uN2: { value: nt2 },
      uFire: { value: FIRE }, uMoonDir: { value: new THREE.Vector3() }, uMoonCol: { value: new THREE.Color() },
      uZen: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uDeep: { value: new THREE.Color(0x03141a) }, uRip: { value: ripU }
    });
    const waterMat = own(mats, new THREE.ShaderMaterial({
      uniforms: U, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, fog: true,
      transparent: true, depthWrite: false, premultipliedAlpha: true, side: THREE.DoubleSide
    }));
    {
      const NT = 96, NRG = 12, P = [], I = [];
      for (let j = 0; j <= NRG; j++) for (let i = 0; i <= NT; i++) {
        const [x, z] = pondXZ(i / NT * Math.PI * 2, j / NRG * 1.0); P.push(x, Y_WATER, z);
      }
      for (let j = 0; j < NRG; j++) for (let i = 0; i < NT; i++) {
        const a = j * (NT + 1) + i, b = a + 1, c = a + NT + 1, d = c + 1; I.push(a, c, b, b, c, d);
      }
      const g = own(geos, new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I);
      const water = new THREE.Mesh(g, waterMat); water.renderOrder = 4; water.frustumCulled = false;
      root.add(water);
    }

    /* --- 縁: 土の盛り上がり・石・草 --- */
    const bermMat = own(mats, new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 1 }));
    {
      const NT = 96, prof = [[0.94, -0.06], [1.0, 0.03], [1.07, 0.05], [1.16, 0.03], [1.26, 0.0]], P = [], I = [];
      for (let j = 0; j < prof.length; j++) for (let i = 0; i <= NT; i++) {
        const th = i / NT * Math.PI * 2, [x, z] = pondXZ(th, prof[j][0]);
        P.push(x, prof[j][1] + 0.012 * Math.sin(th * 13 + j), z);
      }
      for (let j = 0; j < prof.length - 1; j++) for (let i = 0; i < NT; i++) {
        const a = j * (NT + 1) + i, b = a + 1, c = a + NT + 1, d = c + 1; I.push(a, b, c, b, d, c);
      }
      const g = own(geos, new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I); g.computeVertexNormals();
      root.add(new THREE.Mesh(g, bermMat));
    }
    const NSTONE = 40;
    const stoneMat = own(mats, new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }));
    const stones = new THREE.InstancedMesh(own(geos, new THREE.IcosahedronGeometry(1, 1)), stoneMat, NSTONE);
    {
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sr = mulberry32(99), c = new THREE.Color();
      const tones = [0x4a4844, 0x3c3a38, 0x55514a, 0x46423c];
      for (let i = 0; i < NSTONE; i++) {
        const th = (i + sr() * 0.8) / NSTONE * Math.PI * 2, [x, z] = pondXZ(th, 1.02 + sr() * 0.1), s = 0.1 + sr() * 0.17;
        q.setFromEuler(e.set(sr() * 0.5, sr() * 6, sr() * 0.5));
        // カメラ側の縁は、水面をふさがないよう小さく低くする
        const near = Math.sin(th) > 0.1, hk = near ? 0.55 : 1, ss = near ? s * 0.6 : s;
        m4.compose(new THREE.Vector3(x, 0.02 + ss * 0.1, z), q, new THREE.Vector3(ss * (1.1 + sr() * 0.5), ss * (0.32 + sr() * 0.22) * hk, ss * (0.9 + sr() * 0.4)));
        stones.setMatrixAt(i, m4); stones.setColorAt(i, c.setHex(tones[Math.floor(sr() * 4)]).multiplyScalar(0.8 + sr() * 0.5));
      }
      root.add(stones);
    }
    // 草（池の縁に少し）。量は設定「草の量」に従う
    const NGR = 70;
    const blades = [];
    for (let i = 0; i < 5; i++) {
      const g = new THREE.ConeGeometry(0.03, 0.42, 4); g.translate(0, 0.21, 0);
      blades.push({ geo: g, matrix: new THREE.Matrix4().compose(new THREE.Vector3((rng() - 0.5) * 0.14, 0, (rng() - 0.5) * 0.14),
        new THREE.Quaternion().setFromEuler(new THREE.Euler((rng() - 0.5) * 0.5, rng() * 6, (rng() - 0.5) * 0.5)), new THREE.Vector3(1, 0.7 + rng() * 0.7, 1)) });
    }
    const tuftGeo = own(geos, mergeGeoms(blades)); blades.forEach((b) => b.geo.dispose());
    const grassMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xffffff }));
    const tufts = new THREE.InstancedMesh(tuftGeo, grassMat, NGR);
    {
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), gr = mulberry32(31);
      for (let i = 0; i < NGR; i++) {
        // カメラ側（手前の縁）には生やさない: 低い視点で水面をふさいでしまう
        let th = gr() * 6.28; if (Math.sin(th) > 0.15) th = -th;
        const [x, z] = pondXZ(th, 1.2 + gr() * 0.5), s = 0.35 + gr() * 0.4;
        q.setFromEuler(e.set(0, gr() * 6, 0)); m4.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s, s)); tufts.setMatrixAt(i, m4);
      }
      tufts.count = 0; root.add(tufts);
    }

    /* --- 池のまわり全周の草地（低い草の束）と遠景の木。池は今の方向のまま、ほかの方向は草地と木 --- */
    const NMEAD = 160;
    const meadow = new THREE.InstancedMesh(tuftGeo, grassMat, NMEAD);
    {
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), mr = mulberry32(2718);
      for (let i = 0, n = 0, guard = 0; n < NMEAD && guard++ < 2000; ) {
        const a = mr() * 6.28, r = 2.3 + Math.pow(mr(), 0.8) * 14, x = Math.sin(a) * r, z = Math.cos(a) * r;
        if (pondU(x, z) < 1.45) continue;
        const s = 0.35 + mr() * 0.45;
        q.setFromEuler(e.set(0, mr() * 6, 0)); m4.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s, s)); meadow.setMatrixAt(n++, m4);
      }
      meadow.frustumCulled = false; meadow.count = 0; root.add(meadow);
    }
    let far = null;
    {
      const pts = surroundPoints(mulberry32(777), 260, { reject: (x, z) => pondU(x, z) < 1.6 });
      loadFarTrees(ctx, pts, { seed: 51, brightness: 1 }).then((h) => {
        if (!h || disposed) { if (h) h.dispose(); return; }
        far = h; root.add(h.group); if (season) h.setSeason(season);
      }).catch((err) => console.warn('[takibi] far trees:', err));
    }

    /* --- 蓮の葉 --- */
    const NLEAF_MAX = 16;
    const leafGeo = own(geos, leafGeometry());
    const leafMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    const leafMesh = new THREE.InstancedMesh(leafGeo, leafMat, NLEAF_MAX);
    leafMesh.frustumCulled = false; root.add(leafMesh);
    const leaves = [];   // {x,z,r,ph,rot,tilt,y}
    function placeLeaves(n) {
      leaves.length = 0;
      const lr = mulberry32(555), c = new THREE.Color(), base = new THREE.Color(cfg.leaf);
      let guard = 0;
      while (leaves.length < n && guard++ < 800) {
        const [x, z] = pondXZ(lr() * 6.28, Math.sqrt(0.04 + lr() * 0.6)), r = 0.16 + lr() * 0.08;   // 葉の直径 約0.3〜0.5m（leafK=2 を掛けて描く）
        if (leaves.some((l) => Math.hypot(l.x - x, l.z - z) < (l.r + r) * 0.95)) continue;
        if (pondU(x, z) > 0.84) continue;
        leaves.push({ x, z, r, ph: lr() * 6.28, rot: lr() * 6.28, tx: (lr() - 0.5) * 0.12, tz: (lr() - 0.5) * 0.12, y: Y_WATER + 0.01, occ: -1 });
      }
      leaves.forEach((l, i) => leafMesh.setColorAt(i, c.copy(base).multiplyScalar(0.8 + lr() * 0.45)));
      leafMesh.count = leaves.length;
      if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true;
    }
    let leafK = 1;   // GLB の葉は直径 1（半径 0.5）に正規化されるので 2 倍にする
    const lm = new THREE.Matrix4(), lq = new THREE.Quaternion(), le = new THREE.Euler(), lv = new THREE.Vector3(), ls = new THREE.Vector3();
    function updateLeaves(t) {
      for (let i = 0; i < leaves.length; i++) {
        const l = leaves[i];
        l.y = Y_WATER + 0.012 + 0.008 * Math.sin(t * 0.9 + l.ph);
        const dx = Math.sin(t * 0.13 + l.ph) * 0.03, dz = Math.cos(t * 0.11 + l.ph * 1.3) * 0.03;
        l.cx = l.x + dx; l.cz = l.z + dz;
        lq.setFromEuler(le.set(l.tx + Math.sin(t * 0.7 + l.ph) * 0.015, l.rot + Math.sin(t * 0.1 + l.ph) * 0.15, l.tz + Math.cos(t * 0.8 + l.ph) * 0.015));
        lm.compose(lv.set(l.cx, l.y, l.cz), lq, ls.setScalar(l.r * leafK)); leafMesh.setMatrixAt(i, lm);
      }
      leafMesh.instanceMatrix.needsUpdate = true;
    }

    /* --- 蓮の花（夏） --- */
    const flowerGeo = own(geos, flowerGeometry());
    const petalMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xf29bc0, emissive: 0x3a1024, side: THREE.DoubleSide }));
    const stemGeo = own(geos, new THREE.CylinderGeometry(0.008, 0.01, 1, 5)); stemGeo.translate(0, 0.5, 0);
    const stemMat = own(mats, new THREE.MeshLambertMaterial({ color: 0x3f6a34 }));
    const coreGeo = own(geos, new THREE.ConeGeometry(0.03, 0.05, 6));
    const coreMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xe6c84a, emissive: 0x504010 }));
    const flowers = new THREE.Group(); root.add(flowers);
    let flowerA = null;   // lotus_flower.glb が読めたら { geo, mat, lift }。花の直径 1 に正規化されているので FLOWER_K を掛ける
    const FLOWER_K = 0.2;
    function placeFlowers(n) {
      while (flowers.children.length) flowers.remove(flowers.children[0]);
      const fr = mulberry32(808);
      for (let i = 0; i < n && leaves.length; i++) {
        const l = leaves[(i * 3 + 1) % leaves.length], a = fr() * 6.28, d = l.r * 0.9 + 0.12;
        const x = l.x + Math.cos(a) * d, z = l.z + Math.sin(a) * d;
        if (pondU(x, z) > 0.86) continue;
        const f = new THREE.Group(), h = 0.26 + fr() * 0.12;
        const st = new THREE.Mesh(stemGeo, stemMat); st.scale.set(1, h + 0.5, 1); st.position.y = -0.5; f.add(st);
        const head = new THREE.Group(); head.position.y = h;
        if (flowerA) {
          // GLB の花は花托とおしべ込み。花の底（がく）を茎の先に合わせ、コードの花托（円錐）は出さない
          const fm = new THREE.Mesh(flowerA.geo, flowerA.mat); fm.position.y = flowerA.lift; head.add(fm); head.scale.setScalar(FLOWER_K);
        } else {
          head.add(new THREE.Mesh(flowerGeo, petalMat)); const core = new THREE.Mesh(coreGeo, coreMat); core.position.y = 0.045; head.add(core);
          head.scale.setScalar(1.25);
        }
        f.add(head);
        f.position.set(x, Y_WATER, z); f.userData.ph = fr() * 6.28;
        flowers.add(f);
      }
    }

    /* --- 鯉（InstancedMesh 1つ） --- */
    const KOI_N = 5; let koiS = 0.55, koiDepth = [0.12, 0.2];   // GLB の鯉は全長 1 に正規化されるので、読めたら koiS を変える
    const uKT = { value: 0 };
    const koiGeo = koiGeometry();
    const koiPh = new THREE.InstancedBufferAttribute(new Float32Array(KOI_N * 3), 3), koiC1 = new THREE.InstancedBufferAttribute(new Float32Array(KOI_N * 3), 3), koiC2 = new THREE.InstancedBufferAttribute(new Float32Array(KOI_N * 3), 3);
    {
      const KC = [[0xeeeae0, 0xd8401e], [0xc8341a, 0xe65a2c], [0xd8a83a, 0xf4d264], [0xf0ebe0, 0xc8301a], [0xe4e0d6, 0xe9bf52]];
      const c = new THREE.Color();
      for (let i = 0; i < KOI_N; i++) {
        koiPh.setXYZ(i, rnd(0, 6.28), rnd(0.8, 1.15), rnd(0, 6));
        c.setHex(KC[i][0]); koiC1.setXYZ(i, c.r, c.g, c.b); c.setHex(KC[i][1]); koiC2.setXYZ(i, c.r, c.g, c.b);
      }
    }
    koiGeo.setAttribute('aPh', koiPh); koiGeo.setAttribute('aC1', koiC1); koiGeo.setAttribute('aC2', koiC2);
    own(geos, koiGeo);
    const koiMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, emissive: 0x1a1210 }));
    patchKoi(koiMat, uKT);
    const koiMesh = new THREE.InstancedMesh(koiGeo, koiMat, KOI_N); koiMesh.frustumCulled = false; koiMesh.renderOrder = 2; root.add(koiMesh);
    const koi = [];
    for (let i = 0; i < KOI_N; i++) {
      const [x, z] = pondXZ(rnd(0, 6.28), Math.sqrt(rnd(0.2, 0.55)));
      koi.push({ x, z, psi: rnd(0, 6.28), v: 0.2, y: -0.15, pitch: 0, roll: 0, depth: -rnd(0.24, 0.3), tx: x, tz: z, state: 'swim', t0: 0, nextRise: 12 + i * 6 + rnd(0, 12), speed: rnd(0.2, 0.34), wob: rnd(0, 6) });
    }
    let lastRise = -99;
    // 池は焚火の右奥にあり、カメラから水面が見渡せる。池のどこでも泳げる（岸の浅いところだけ避ける）
    function koiSpot(umin, umax) { return pondXZ(rnd(0, 6.28), Math.sqrt(rnd(umin, umax))); }
    function koiTarget(k) { const [x, z] = koiSpot(0.04, 0.6); k.tx = x; k.tz = z; }
    koi.forEach(koiTarget);

    /* --- メダカ（InstancedMesh 1つ・群れ） --- */
    const MED_N = 16;
    const medGeo = own(geos, new THREE.ConeGeometry(0.012, 0.07, 4)); medGeo.rotateZ(-Math.PI / 2); medGeo.scale(1, 0.6, 1);
    const medMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xd8e2ea, emissive: 0x465a66 }));
    const medMesh = new THREE.InstancedMesh(medGeo, medMat, MED_N); medMesh.frustumCulled = false; root.add(medMesh);
    const med = [];
    {
      const [cx, cz] = pondXZ(0.6, 0.35);
      for (let i = 0; i < MED_N; i++) { const a = Math.random() * 6.28; med.push({ x: cx + Math.cos(a) * rnd(0, 0.3), z: cz + Math.sin(a) * rnd(0, 0.3), vx: rnd(-0.1, 0.1), vz: rnd(-0.1, 0.1), h: a, ph: rnd(0, 6), dy: rnd(0, 0.03) }); }
    }
    const goal = { x: 0, z: 0, next: 0, boost: 0, startle: 6 };
    function pickGoal(away) {
      let cx = 0, cz = 0; med.forEach((m) => { cx += m.x; cz += m.z; }); cx /= MED_N; cz /= MED_N;
      for (let k = 0; k < 12; k++) {
        const [x, z] = pondXZ(rnd(0, 6.28), Math.sqrt(rnd(0.05, 0.6)));
        if (!away || Math.hypot(x - cx, z - cz) > 1.6) { goal.x = x; goal.z = z; return; }
      }
    }
    pickGoal(false);

    /* --- 蛙 --- */
    const fp = frogParts();
    own(geos, fp.body); own(geos, fp.eyes); own(geos, fp.throat);
    const frogMat = own(mats, new THREE.MeshLambertMaterial({ color: 0x5e8a30, emissive: 0x0a1204 }));
    const eyeMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xc9a52a, emissive: 0x3a2a04 }));
    const throatMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xdfe6a8, emissive: 0x2a2a10 }));
    const frogs = [];
    for (let i = 0; i < 3; i++) {
      const g = new THREE.Group(), body = new THREE.Mesh(fp.body, frogMat), eyes = new THREE.Mesh(fp.eyes, eyeMat), throat = new THREE.Mesh(fp.throat, throatMat);
      throat.position.set(0.5, 0.22, 0); throat.scale.set(0.12, 0.1, 0.12);
      g.add(body, eyes, throat); g.scale.setScalar(0.08); g.visible = false;   // 体長 約8cm root.add(g);
      frogs.push({ g, body, eyes, throat, state: 'sit', until: 0, leaf: -1, calls: [], t0: 0, dur: 1, from: new THREE.Vector3(), to: new THREE.Vector3(), nextLeaf: -1, psi: 0, active: false });
    }
    // frog.glb が読めたら { lift（体の底を原点に合わせる持ち上げ量）, tp（喉の中心）, tgeo } 。喉は GLB の楕円体を中心に置き直し、膨らませる
    let frogA = null;
    const FROG_REF = new THREE.Color(0x5e8a30);
    function frogTint() {
      if (!frogA) { frogMat.color.setHex(cfg.frog); return; }
      const c = new THREE.Color(cfg.frog);   // 春の色を基準（白）にして、季節の色の比を GLB の材質の color に掛ける
      frogA.bodyMat.color.setRGB(c.r / FROG_REF.r, c.g / FROG_REF.g, c.b / FROG_REF.b);
    }
    function setThroat(f, e, br) {
      if (frogA) {
        f.throat.scale.set(1 + 1.1 * e + br * 0.25, 1 + 0.9 * e + br * 0.25, 1 + 1.6 * e + br * 0.25);
        f.throat.position.set(frogA.tp.x + 0.07 * e, frogA.tp.y + 0.02 * e, 0);
      } else {
        f.throat.scale.set(0.12 + 0.3 * e + br * 0.3, 0.1 + 0.26 * e + br * 0.3, 0.12 + 0.28 * e + br * 0.3);
        f.throat.position.set(0.5 + 0.06 * e, 0.22, 0);
      }
    }
    const nowS = () => performance.now() / 1000;
    const offEnv = api.onEnvEvent ? api.onEnvEvent((ev) => {
      if (ev.kind !== 'frog') return;
      const f = frogs[ev.voice % frogs.length];
      if (f && f.active && f.state === 'sit') f.calls.push({ t0: nowS(), syl: ev.syl });
    }) : () => {};
    function throatLevel(f) {
      const n = nowS(); let e = 0;
      for (let i = f.calls.length - 1; i >= 0; i--) {
        const c = f.calls[i], dt = n - c.t0;
        if (dt > 3) { f.calls.splice(i, 1); continue; }
        for (const [o, d] of c.syl) {
          const x = (dt - o) / d;
          if (x >= 0 && x <= 1) e = Math.max(e, Math.min(1, x * 6) * (1 - smooth(0.7, 1, x)));
        }
      }
      return e;
    }
    function pickFreeLeaf(x, z, avoid) {
      let best = -1, bd = 1e9;
      leaves.forEach((l, i) => {
        if (l.occ >= 0 || i === avoid || pondU(l.x, l.z) > 0.78) return;
        const d = Math.hypot(l.x - x, l.z - z) + rnd(0, 0.6); if (d < bd) { bd = d; best = i; }
      });
      return best;
    }
    function setupFrogs(n) {
      leaves.forEach((l) => { l.occ = -1; });
      frogs.forEach((f, i) => {
        f.active = i < n; f.g.visible = f.active; f.calls.length = 0; f.state = 'sit'; f.until = curT + rnd(40, 100);
        if (!f.active) { f.leaf = -1; return; }
        // 手前（焚火側・カメラ側）に近い葉を選ぶ
        f.leaf = pickFreeLeaf(PC.x - 1.2 + i * 0.9, PC.z + 1.4, -1);
        if (f.leaf >= 0) leaves[f.leaf].occ = i;
        f.psi = rnd(0, 6.28);
        frogTint();
      });
    }
    const frogLift = () => (frogA ? 0.004 : 0.03);   // 葉の中心の上（GLB の葉は中心がいちばん低い皿）
    function frogLeafPos(f, out) { const l = leaves[f.leaf]; if (!l) return out.set(PC.x, Y_WATER, PC.z); return out.set(l.cx ?? l.x, (l.y ?? Y_WATER) + frogLift(), l.cz ?? l.z); }
    const tmpV = new THREE.Vector3();
    function updateFrog(f, i, t) {
      if (!f.active) return;
      const pn = nowS();
      if (f.state === 'sit') {
        if (f.leaf < 0) { f.leaf = pickFreeLeaf(PC.x, PC.z + 1, -1); if (f.leaf >= 0) leaves[f.leaf].occ = i; if (f.leaf < 0) { f.g.visible = false; return; } }
        f.g.visible = true;
        frogLeafPos(f, f.g.position);
        f.g.rotation.set(0, -f.psi, 0);
        const e = throatLevel(f), br = 0.04 * Math.sin(t * 2.2 + i);
        setThroat(f, e, br);
        f.body.scale.set(1, 1 + 0.03 * Math.sin(t * 2.2 + i) + 0.05 * e, 1);
        if (t > f.until && cfg.frogs > 0) startJumpOut(f, i, t);
      } else if (f.state === 'jumpOut' || f.state === 'jumpIn') {
        const p = clamp((t - f.t0) / f.dur, 0, 1);
        f.g.position.lerpVectors(f.from, f.to, p); f.g.position.y += 0.2 * 4 * p * (1 - p);
        f.g.rotation.set(0, -f.psi, 0); f.g.rotation.z = (0.5 - p) * 0.9;
        setThroat(f, 0, 0);
        if (p >= 1) {
          if (f.state === 'jumpOut') {
            ripple(f.to.x, f.to.z, 1.0); f.g.visible = false; f.state = 'hidden'; f.until = t + rnd(6, 12);
            const l = leaves[f.nextLeaf]; if (l) l.occ = i;
          } else { f.state = 'sit'; f.g.rotation.z = 0; f.until = t + rnd(70, 150) * (season === 'autumn' ? 1.5 : 1); }
        }
      } else if (f.state === 'hidden') {
        if (t > f.until) {
          const l = leaves[f.nextLeaf]; if (!l) { f.state = 'sit'; return; }
          const a = rnd(0, 6.28), sx = l.x + Math.cos(a) * (l.r + 0.25), sz = l.z + Math.sin(a) * (l.r + 0.25);
          f.from.set(sx, Y_WATER + 0.01, sz); ripple(sx, sz, 0.45);
          ctxSfx('plip', sx, sz, 0.8);
          f.state = 'surf'; f.t0 = t; f.dur = 0.7; f.g.visible = true; f.g.position.copy(f.from); f.psi = Math.atan2(l.z - sz, l.x - sx);
        }
      } else if (f.state === 'surf') {
        f.g.position.y = Y_WATER - 0.01 + 0.02 * Math.sin((t - f.t0) * 6); f.g.rotation.set(0, -f.psi, 0);
        if (t - f.t0 >= f.dur) {
          const l = leaves[f.nextLeaf]; f.leaf = f.nextLeaf; f.state = 'jumpIn'; f.t0 = t; f.dur = 0.4;
          f.to.set(l.cx ?? l.x, l.y + frogLift(), l.cz ?? l.z);
        }
      }
    }
    function startJumpOut(f, i, t) {
      const l = leaves[f.leaf]; if (!l) { f.until = t + 20; return; }
      const nl = pickFreeLeaf(l.x, l.z, f.leaf);
      if (nl < 0) { f.until = t + 20; return; }
      let a = rnd(0, 6.28), tx, tz, tries = 0;
      do { a = rnd(0, 6.28); tx = l.x + Math.cos(a) * rnd(0.6, 0.9); tz = l.z + Math.sin(a) * rnd(0.6, 0.9); } while ((pondU(tx, tz) > 0.85 || leaves.some((o, k) => k !== f.leaf && Math.hypot(o.x - tx, o.z - tz) < o.r)) && tries++ < 30);
      frogLeafPos(f, f.from); f.to.set(tx, Y_WATER, tz);
      f.psi = Math.atan2(tz - f.from.z, tx - f.from.x); f.t0 = t; f.dur = 0.5; f.state = 'jumpOut'; f.nextLeaf = nl;
      leaves[f.leaf].occ = -1; f.leaf = -1;
      ctxSfx('splash', tx, tz, 1, f.dur);   // 着水の時刻に合わせて予約する
    }
    function ctxSfx(name, x, z, vol, delay) { api.playSfx && api.playSfx(name, { vol, pos: { x, y: 0, z }, delay: delay || 0 }); }

    /* --- 波紋（水面シェーダーへ最大8つ） --- */
    const ripples = [];
    function ripple(x, z, amp) { ripples.push({ x, z, t0: curT, amp }); if (ripples.length > 8) ripples.shift(); }
    function updateRipples(t) {
      for (let i = ripples.length - 1; i >= 0; i--) if (t - ripples[i].t0 > 6) ripples.splice(i, 1);
      for (let i = 0; i < 8; i++) { const r = ripples[i]; if (r) ripU[i].set(r.x, r.z, t - r.t0, r.amp); else ripU[i].set(0, 0, 0, 0); }
    }

    /* --- 秋の浮き葉 / 冬の氷 --- */
    const FL_MAX = 30;
    const flMat = own(mats, new THREE.MeshLambertMaterial({ map: own(texs, petalTex()), alphaTest: 0.4, side: THREE.DoubleSide, emissive: 0x1c0e06 }));
    const flGeo = own(geos, new THREE.PlaneGeometry(0.15, 0.15)); flGeo.rotateX(-Math.PI / 2);
    const fl = new THREE.InstancedMesh(flGeo, flMat, FL_MAX); fl.frustumCulled = false; fl.visible = false; root.add(fl);
    const flData = [];
    {
      const c = new THREE.Color(), cs = [0xc8471c, 0xe0842a, 0xa02c14, 0xd9a12e];
      for (let i = 0; i < FL_MAX; i++) {
        const [x, z] = pondXZ(rnd(0, 6.28), Math.sqrt(rnd(0.02, 0.8)));
        flData.push({ x, z, r: rnd(0, 6.28), vx: rnd(-0.01, 0.01), vz: rnd(-0.01, 0.01), ph: rnd(0, 6), s: rnd(0.8, 1.5) });
        fl.setColorAt(i, c.setHex(cs[i % 4]).multiplyScalar(0.75));
      }
    }
    const ice = (() => {
      const NT = 96, NR = 4, P = [], C = [], I = [], ir = mulberry32(3);
      for (let i = 0; i <= NT; i++) {
        const th = i / NT * Math.PI * 2, inner = 0.62 + 0.07 * Math.sin(th * 7 + 1) + 0.05 * Math.sin(th * 13) + 0.03 * Math.sin(th * 23 + 2);
        for (let j = 0; j <= NR; j++) {
          const u = inner + (1.0 - inner) * j / NR, [x, z] = pondXZ(th, u);
          P.push(x, Y_WATER + 0.02 + 0.004 * Math.sin(th * 17 + j * 2), z);
          C.push(0.86, 0.92, 0.98, j === 0 ? 0.0 : j === 1 ? 0.55 : 0.9);
        }
      }
      for (let i = 0; i < NT; i++) for (let j = 0; j < NR; j++) {
        const a = i * (NR + 1) + j, b = a + 1, c = a + NR + 1, d = c + 1; I.push(a, b, c, b, d, c);
      }
      const g = own(geos, new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 4)); g.setIndex(I); g.computeVertexNormals();
      const m = new THREE.Mesh(g, own(mats, new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, depthWrite: false, roughness: 0.3, metalness: 0.0, side: THREE.DoubleSide })));
      m.renderOrder = 5; m.visible = false; root.add(m); return m;
    })();

    /* --- Blender 製の GLB（assets/models/）があれば、コードの簡易モデルの代わりに使う。読めなかったものはコード製のまま --- */
    // 使うファイル名は assets/plants/manifest.json の "models" 配列に書く（util.loadOptionalModel）
    // koi.glb: 形（頭 +X・全長 1 に正規化）と鱗の法線マップ。体の模様と尾の振りはコード側のシェーダー（koiMat）
    // lotus_leaf.glb: 直径 1 に正規化 → インスタンスの拡大を 2 倍。材質は季節色を乗算する前提の淡い緑
    // lotus_flower.glb: 花（花托・おしべ込み）。茎はコードの円柱
    // frog.glb: 体・目・喉。体長 1 に正規化し、底が原点（葉に接する）になるよう持ち上げる。喉は GLB の楕円体を膨らませる
    const ownMat = (m) => { materialTextures(m).forEach((t) => own(texs, t)); return own(mats, m); };
    (async () => {
      const [mk, ml, mf, mfr] = await Promise.all(['koi.glb', 'lotus_leaf.glb', 'lotus_flower.glb', 'frog.glb'].map((f) => loadOptionalModel(assets, f, isStopped)));
      const all = [mk, ml, mf, mfr].filter(Boolean);
      if (isStopped()) { all.forEach((m) => { m.geometry.dispose(); m.extras.forEach((x) => x.geometry.dispose()); }); return; }
      if (mk) {
        mk.geometry.setAttribute('aPh', koiPh); mk.geometry.setAttribute('aC1', koiC1); mk.geometry.setAttribute('aC2', koiC2);
        koiMesh.geometry = mk.geometry; own(geos, mk.geometry);
        const km0 = ownMat(mk.material);
        if (km0.normalMap) { koiMat.normalMap = km0.normalMap; koiMat.normalScale.set(0.7, 0.7); koiMat.needsUpdate = true; }   // 鱗（模様はコードのまま）
        koiS = 0.62; koiDepth = [0.25, 0.31]; if (!cfg.ice) koi.forEach((k) => { k.depth = -rnd(koiDepth[0], koiDepth[1]); });   // 背びれの先まで水面（y=-0.06）より下。体の高さは koiS×約±0.2
      }
      if (ml) {
        ml.geometry.computeBoundingBox(); ml.geometry.translate(0, -ml.geometry.boundingBox.min.y, 0);   // 皿の中心（いちばん低い所）が y=0
        leafMesh.geometry = ml.geometry; own(geos, ml.geometry); leafK = 2;
        if (ml.material) { leafMesh.material = ownMat(ml.material); }
      }
      if (mf) {
        mf.geometry.computeBoundingBox();
        flowerA = { geo: own(geos, mf.geometry), mat: ownMat(mf.material), lift: -mf.geometry.boundingBox.min.y };
        flowerA.mat.emissive.setHex(0x26101a);   // 夜でも花がほのかに見える（コード製の花びらの emissive と同じ考え方）
        mf.extras.forEach((x) => x.geometry.dispose());   // 茎はコードのものを使う
        placeFlowers(cfg.flowers);
      }
      if (mfr) {
        const ex = (n) => mfr.extras.find((x) => x.name === n);
        const eg = ex('frog_eyes'), tg = ex('frog_throat');
        mfr.geometry.computeBoundingBox();
        const lift = -mfr.geometry.boundingBox.min.y;
        const bodyMat = ownMat(mfr.material); bodyMat.emissive.setHex(0x0a1204);
        frogA = { lift, bodyMat, tp: new THREE.Vector3() };
        own(geos, mfr.geometry);
        let eyeM = null, throatM = null, throatGeo = null;
        if (eg) { own(geos, eg.geometry); eyeM = ownMat(eg.material); eyeM.emissive.setHex(0x120e02); }
        if (tg) {
          tg.geometry.computeBoundingBox(); tg.geometry.boundingBox.getCenter(frogA.tp);
          tg.geometry.translate(-frogA.tp.x, -frogA.tp.y, -frogA.tp.z); frogA.tp.y += lift;
          throatGeo = own(geos, tg.geometry); throatM = ownMat(tg.material); throatM.emissive.setHex(0x2a2a10);
        }
        frogs.forEach((f) => {
          f.body.geometry = mfr.geometry; f.body.material = bodyMat; f.body.position.y = lift;
          if (eg) { f.eyes.geometry = eg.geometry; f.eyes.material = eyeM; f.eyes.position.y = lift; }
          if (tg) { f.throat.geometry = throatGeo; f.throat.material = throatM; } else { f.throat.visible = false; }
          setThroat(f, 0, 0);
        });
        frogTint();
      }
    })().catch((e) => console.warn('[takibi] pond models:', e));

    /* --- 季節 --- */
    function applySeason(s) {
      season = s; cfg = SEASON[s];
      U.uZen.value.setHex(cfg.zen); U.uHor.value.setHex(cfg.hor);
      const mo = cfg.moon; U.uMoonDir.value.copy(skyDir(mo.az, mo.el)); U.uMoonCol.value.setHex(mo.col);
      bermMat.color.setHex(cfg.berm);
      const sc = new THREE.Color(); stoneMat.color.setScalar(cfg.stone);
      grassMat.color.setHex(cfg.grass).multiplyScalar(0.7);
      if (far) far.setSeason(s);
      meadow.visible = true;
      placeLeaves(cfg.leafN); placeFlowers(cfg.flowers); setupFrogs(cfg.frogs);
      fl.visible = cfg.floating > 0; fl.count = cfg.floating;
      ice.visible = cfg.ice;
      ctx.fireflies && (ctx.fireflies.value = cfg.ff);
      koi.forEach((k) => { k.state = 'swim'; k.nextRise = curT + rnd(6, 16) + rnd(cfg.riseEvery[0], cfg.riseEvery[1]) * rnd(0.3, 1); });
      const deep = cfg.ice; koi.forEach((k) => { k.depth = deep ? -rnd(0.75, 0.9) : -rnd(koiDepth[0], koiDepth[1]); });   // 夏〜秋は水面のすぐ下（氷の下では深く）
    }

    /* --- 更新 --- */
    let grassLevel = '', nextLap = 2;
    const km = new THREE.Matrix4(), kq = new THREE.Quaternion(), ke = new THREE.Euler(), kv = new THREE.Vector3(), ksc = new THREE.Vector3(1, 1, 1);
    function updateKoi(dt, t) {
      const deep = cfg.ice;
      ksc.set(koiS, koiS, koiS);
      koi.forEach((k, i) => {
        const dxT = k.tx - k.x, dzT = k.tz - k.z, dist = Math.hypot(dxT, dzT);
        const spd = deep ? 0.05 : k.speed * (season === 'autumn' ? 0.75 : 1) * (k.state === 'swim' ? 1 : 0.55);
        const want = Math.atan2(dzT, dxT);
        let d = want - k.psi; d = Math.atan2(Math.sin(d), Math.cos(d));
        k.psi += clamp(d, -1.1 * dt, 1.1 * dt);
        k.v += (spd - k.v) * Math.min(1, dt * 1.5);
        k.x += Math.cos(k.psi) * k.v * dt; k.z += Math.sin(k.psi) * k.v * dt;
        const u = pondU(k.x, k.z);
        if (u > 0.82) { k.tx = PC.x; k.tz = PC.z; k.x += (PC.x - k.x) * dt * 0.3; k.z += (PC.z - k.z) * dt * 0.3; }
        if (dist < 0.35 && (k.state === 'swim' || k.state === 'approach')) {
          if (k.state === 'approach') { k.state = 'rising'; k.t0 = t; k.y0 = k.y; }
          else koiTarget(k);
        }
        let yT = deep ? k.depth : k.depth + 0.025 * Math.sin(t * 0.4 + k.wob), pT = 0;
        if (k.state === 'swim' && !deep && t > k.nextRise && t - lastRise > 8) {
          const [x, z] = koiSpot(0.2, 0.55);   // 顔を出す場所（焚火と月の光が当たる、池の手前寄りが見やすい）
          k.tx = x; k.tz = z;
          k.state = 'approach'; lastRise = t;
        }
        if (k.state === 'rising') {
          const p = clamp((t - k.t0) / 0.9, 0, 1), e = p * p * (3 - 2 * p);
          yT = k.y0 + (-0.12 - k.y0) * e; pT = 0.5 * e;
          if (p >= 1) { k.state = 'hold'; k.t0 = t; const hx = k.x + Math.cos(k.psi) * koiS * 0.5, hz = k.z + Math.sin(k.psi) * koiS * 0.5;
            ripple(hx, hz, 1.0); ctxSfx('plop', hx, hz, 1); k.sec = false; }
          else { k.y = yT; }
        } else if (k.state === 'hold') {
          yT = -0.12; pT = 0.5;
          if (!k.sec && t - k.t0 > 0.3) { k.sec = true; ripple(k.x + Math.cos(k.psi) * koiS * 0.45, k.z + Math.sin(k.psi) * koiS * 0.45, 0.55); }
          if (t - k.t0 > 0.45) { k.state = 'diving'; k.t0 = t; }
        } else if (k.state === 'diving') {
          pT = -0.15;
          if (t - k.t0 > 1.0) { k.state = 'swim'; k.nextRise = t + rnd(cfg.riseEvery[0], cfg.riseEvery[1]); koiTarget(k); }
        }
        if (k.state !== 'rising') k.y += (yT - k.y) * Math.min(1, dt * (k.state === 'hold' ? 10 : 1.2));
        k.pitch += (pT - k.pitch) * Math.min(1, dt * 5);
        k.roll = -d * 0.35;
        ke.set(k.roll, -k.psi, k.pitch, 'YZX'); kq.setFromEuler(ke);
        km.compose(kv.set(k.x, k.y, k.z), kq, ksc); koiMesh.setMatrixAt(i, km);
      });
      koiMesh.instanceMatrix.needsUpdate = true;
    }
    function updateMedaka(dt, t) {
      if (t > goal.next) { pickGoal(false); goal.next = t + rnd(4, 9); }
      goal.startle -= dt;
      if (goal.startle < 0) { pickGoal(true); goal.startle = rnd(10, 24); goal.boost = 1; goal.next = t + rnd(5, 9); }
      goal.boost = Math.max(0, goal.boost - dt * 0.8);
      let cx = 0, cz = 0, ax = 0, az = 0; med.forEach((m) => { cx += m.x; cz += m.z; ax += m.vx; az += m.vz; });
      cx /= MED_N; cz /= MED_N; ax /= MED_N; az /= MED_N;
      const base = (cfg.ice ? 0.03 : 0.14) * (1 + 2.2 * goal.boost), y0 = cfg.ice ? -0.7 : -0.09;
      med.forEach((m, i) => {
        let sx = (goal.x - m.x) * 0.25 + (cx - m.x) * 0.5 + (ax - m.vx) * 0.6, sz = (goal.z - m.z) * 0.25 + (cz - m.z) * 0.5 + (az - m.vz) * 0.6;
        for (let j = 0; j < MED_N; j++) { if (j === i) continue; const o = med[j], dx = m.x - o.x, dz = m.z - o.z, d2 = dx * dx + dz * dz; if (d2 < 0.0064 && d2 > 1e-6) { sx += dx / d2 * 0.004; sz += dz / d2 * 0.004; } }
        const u = pondU(m.x, m.z); if (u > 0.78) { sx += (PC.x - m.x) * 0.8; sz += (PC.z - m.z) * 0.8; }
        m.vx += sx * dt * (2.5 + goal.boost * 3); m.vz += sz * dt * (2.5 + goal.boost * 3);
        const sp = Math.hypot(m.vx, m.vz) || 1, lim = base * (0.8 + 0.3 * Math.sin(m.ph + t * 0.7));
        if (sp > lim) { m.vx *= lim / sp; m.vz *= lim / sp; }
        m.x += m.vx * dt; m.z += m.vz * dt;
        let d = Math.atan2(m.vz, m.vx) - m.h; d = Math.atan2(Math.sin(d), Math.cos(d)); m.h += d * Math.min(1, dt * 8);
        ke.set(0, -m.h, Math.sin(t * 9 + m.ph) * 0.08); kq.setFromEuler(ke);
        km.compose(kv.set(m.x, y0 - m.dy, m.z), kq, ksc.set(1, 1, 1)); medMesh.setMatrixAt(i, km);
      });
      medMesh.instanceMatrix.needsUpdate = true;
    }
    const fm = new THREE.Matrix4(), fq = new THREE.Quaternion(), fe = new THREE.Euler(), fv = new THREE.Vector3(), fs = new THREE.Vector3();
    function updateFloating(t) {
      for (let i = 0; i < cfg.floating; i++) {
        const d = flData[i]; d.x += d.vx * 0.016; d.z += d.vz * 0.016;
        if (pondU(d.x, d.z) > 0.9) { d.vx = -d.vx; d.vz = -d.vz; }
        fq.setFromEuler(fe.set(Math.sin(t * 0.8 + d.ph) * 0.05, d.r + Math.sin(t * 0.2 + d.ph) * 0.3, 0));
        fm.compose(fv.set(d.x, Y_WATER + 0.004, d.z), fq, fs.setScalar(d.s)); fl.setMatrixAt(i, fm);
      }
      fl.instanceMatrix.needsUpdate = true;
    }

    return {
      setSeason(s) { applySeason(s); },
      update(dt, t, st) {
        curT = t; uKT.value = t; U.uTime.value = t;
        const fl0 = st.started ? clamp(st.flame, 0, 1.3) : 0;
        U.uFlame.value = fl0 * (0.85 + 0.15 * Math.sin(t * 13 + Math.sin(t * 5) * 2)) + 0.12 * (st.ember || 0);
        const gl = st.grass || 'normal';
        if (gl !== grassLevel) { grassLevel = gl; tufts.count = GRASS_N[gl] || 0; meadow.count = Math.round(NMEAD * (GRASS_N[gl] || 0) / GRASS_N.many); }
        updateLeaves(t); updateKoi(dt, t); updateMedaka(dt, t); updateRipples(t);
        frogs.forEach((f, i) => updateFrog(f, i, t));
        flowers.children.forEach((f) => { f.rotation.z = Math.sin(t * 0.6 + f.userData.ph) * 0.03; f.position.y = Y_WATER; });
        if (cfg.floating) updateFloating(t);
        nextLap -= dt;
        if (nextLap < 0) { nextLap = rnd(1.5, 4); if (api.playSfx) { const [lx, lz] = pondXZ(rnd(0, 6.28), rnd(0.3, 0.9)); api.playSfx('lap', { vol: rnd(0.5, 1), pos: { x: lx, y: 0, z: lz } }); } }
      },
      dispose() {
        disposed = true;
        offEnv();
        if (ground && origGround) { ground.geometry = origGround; if (holeGeo) holeGeo.dispose(); }
        ctx.fireflies && (ctx.fireflies.value = 1);
        if (far) { far.dispose(); far = null; }
        texs.forEach((x) => x.dispose()); geos.forEach((x) => x.dispose()); mats.forEach((x) => x.dispose());
      }
    };
  }
};
