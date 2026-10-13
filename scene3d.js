// 焚火の3D表示（three.js）。index.html が起動時に import して start() を呼ぶ。
// 状態は index.html の window.TAKIBI（opts.api）から読む。ここからは状態を書き換えない（薪をくべる addLog と、シーンの音の窓口だけ）。
// 共通部分（焚火・石囲い・薪・地面・夜空・ホタル・カメラ・性能制御）はここ、シーン固有のものは scenes/*.js。
import * as THREE from 'three';
import { createFire } from './fire3d.js';
import { SCENES } from './scenes/index.js';
import * as util from './scenes/util.js';
import { loadProps, buildRockRing } from './scenes/props.js';
import { makeFireflyPoints } from './scenes/firefly.js';

const { mulberry32, clamp, rnd, rgb, radialTexture, disposeTree, makePoints, HILLS, hillH } = util;

export { SCENES };

/* 視点の窓口（index.html から使う）。
   setCameraAuto(on, seconds = 240): 「ゆっくり見回す」。何も操作していないとき、焚火のまわりを seconds 秒で1周する（操作すると止まり、少しして再開）
   getCameraAuto() -> {on, seconds}
   resetCameraView(): 初期の視点へなめらかに戻す（ダブルクリックと同じ）
   getCameraView() / setCameraView({az, pit, dist}): 方位(rad)・上下の増減(rad)・距離(m)。検証や保存・復元用（すぐ反映） */
export function setCameraAuto(on, seconds) { if (ctx) ctx.setAuto(!!on, seconds); }
export function getCameraAuto() { return ctx ? ctx.getAuto() : { on: false, seconds: 240 }; }
export function resetCameraView() { if (ctx) ctx.resetView(); }
export function getCameraView() { return ctx ? ctx.getView() : null; }
export function setCameraView(v) { if (ctx) ctx.setView(v); }
/* getRenderStats() -> {triangles, calls, geometries, textures}: 直前の1フレーム（炎の発光パスを含む）の描画量と、GPU 上の資源の数。性能・リーク確認用 */
export function getRenderStats() { return ctx ? ctx.getStats() : null; }

const FRAME_MS = 1000 / 30;          // 描画は30fpsに制限
const MAX_DPR = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) ? 1.1 : 1.25;   // 内蔵GPU・スマホでも回るようピクセル比の上限を低めにする（タッチ端末は 1.1）
const SLOW_FPS = 20, SLOW_WINDOW_MS = 5000;   // 5秒間の平均がこれを下回ったら草を減らす
const GAP_MS = 250;                  // これを超えるフレーム間隔は「止まっていた」とみなして計測に含めない
const FOV = 55;
const EYE_Y = 1.03, AIM_Y = 0.68;    // 焚火の前に座った人の目線（目の高さ 約1.03m）と、見つめる焚火の中心の高さ
const CAM_R = 2.5;                   // 初期の、焚火からの水平距離(m)
const DIST_MIN = 1.6, DIST_MAX = 4.0;   // ホイール・ピンチで変えられる範囲
const PITCH_MIN = -0.16, PITCH_MAX = 0.75;   // 上下: 初期の向きからの増減(rad)。-0.16 = さらに約9°見下ろす、+0.75 = 夜空を見上げて約 +35°（初期は約 -8°）
const TAP_PX = 10, TAP_MS = 400, DBL_MS = 320;   // タップの判定（これ未満の移動・時間）と、ダブルタップの間隔
const SKY_R = 150;                   // 空の物（月・流れ星・星）を置く半径
const TILE_M = 1.75;                 // 土のテクスチャ1タイルの大きさ(m)
// 世界の縮尺は 1 unit = 1 m。焚火まわり（実物の目安: 石囲い外径 約1.1m・石 20〜35cm・薪 長さ約45cm 太さ約12cm・切り株 直径約40cm 高さ約40cm）
const LOG_K = 0.5;                   // 薪の長さの倍率（元の GLB の薪は 長さ 0.9 → 約 0.45m）
const POS_K = 0.45;                  // 焚火まわりの置き位置の倍率（薪の根元など）
const RING_R = 0.45;                 // 石囲いの石の中心を結ぶ円の半径(m)
const SITE = new URL('./', import.meta.url);

/* 季節ごとの環境色と月 */
const SEASON_ENV = {
  spring: { bg: 0x180e1e, mid: 0x231529, hemi: 0x5a4470, fog: 0x0f0c16, moon: { el: 0.16, az: 0.5, color: 0xffe6d6, light: 0xbcc8f0, power: 0.22, size: 40 } },
  summer: { bg: 0x081334, mid: 0x0d1d48, hemi: 0x2a4488, fog: 0x080b16, moon: { el: 0.1, az: 0.55, color: 0xffdf95, light: 0xc8d0f0, power: 0.2, size: 44 } },
  autumn: { bg: 0x22100a, mid: 0x321a10, hemi: 0x6a3c24, fog: 0x0f0b0c, moon: { el: 0.18, az: 0.45, color: 0xffd9aa, light: 0xc0c8ea, power: 0.22, size: 42 } },
  winter: { bg: 0x15263a, mid: 0x1f3550, hemi: 0x5f86ac, fog: 0x0a0e17, moon: { el: 0.21, az: 0.5, color: 0xeef4ff, light: 0xb4ccff, power: 0.3, size: 36 } }
};

function skyDir(az, el, r) {
  return new THREE.Vector3(Math.sin(az) * Math.cos(el) * r, Math.sin(el) * r, -Math.cos(az) * Math.cos(el) * r);
}

/* 頂点位置から作るノイズ（共有頂点が同じ値になる） */
function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), u), l(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), u), v),
    l(l(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), u), l(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), u), v), w);
}

/* 石囲い: 低ポリゴンの球を、頂点ノイズで崩して丸みのある岩にする。焚火側の面は煤で黒くする */
function buildStones(mergeVertices, mergeGeometries) {
  const rng = mulberry32(77), N = 13, geos = [];
  const tones = [0x3c3a38, 0x302e2c, 0x3a332c, 0x2b2a28, 0x35322f];
  const col = new THREE.Color();
  for (let i = 0; i < N; i++) {
    let g = new THREE.IcosahedronGeometry(1, 1);
    g.deleteAttribute('uv'); g.deleteAttribute('normal');
    g = mergeVertices(g, 1e-4);
    const seed = rng() * 100, p = g.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
      const n = vnoise3(x * 1.6 + seed, y * 1.6 + seed, z * 1.6 + seed) - 0.5;
      const n2 = vnoise3(x * 3.3 + seed, y * 3.3, z * 3.3 - seed) - 0.5;
      const s = 1 + 0.34 * n + 0.1 * n2;
      p.setXYZ(k, x * s, y * s, z * s);
    }
    const a = (i / N) * Math.PI * 2 + (rng() - 0.5) * 0.18, r = 1.02 + rng() * 0.1;
    const sz = 0.2 + rng() * 0.09;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(a) * r, 0.06 + rng() * 0.03, Math.sin(a) * r),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rng() * 3, rng() * 6, rng() * 3)),
      new THREE.Vector3(sz * (1 + rng() * 0.45), sz * (0.62 + rng() * 0.25), sz * (1.05 + rng() * 0.4)));
    g.applyMatrix4(m);
    g.computeVertexNormals();
    const tone = tones[Math.floor(rng() * tones.length)];
    const pp = g.attributes.position, cols = new Float32Array(pp.count * 3);
    for (let k = 0; k < pp.count; k++) {
      const x = pp.getX(k), y = pp.getY(k), z = pp.getZ(k);
      const d = Math.hypot(x, z);
      // 焚火に近い面ほど、また低い所ほど煤で黒い
      const soot = (1 - THREE.MathUtils.smoothstep(d, 0.86, 1.24)) * (1 - 0.45 * THREE.MathUtils.smoothstep(y, 0.12, 0.3));
      const mottle = 0.8 + 0.4 * vnoise3(x * 9 + seed, y * 9, z * 9);
      col.setHex(tone).multiplyScalar(mottle * (1 - 0.9 * soot));
      cols[k * 3] = col.r; cols[k * 3 + 1] = col.g; cols[k * 3 + 2] = col.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    geos.push(g);
  }
  const merged = mergeGeometries(geos);
  geos.forEach((g) => g.dispose());
  return merged;
}

/* 土の材質: 3枚の PBR テクスチャに、ワールド座標の低周波ノイズで色と明るさのむらを掛ける */
function patchSoil(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec2 vTkP;\n' + shader.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\n  vTkP = (modelMatrix * vec4(position, 1.0)).xz;');
    shader.fragmentShader = `varying vec2 vTkP;
float tkH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tkN(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(tkH(i), tkH(i + vec2(1.0, 0.0)), f.x), mix(tkH(i + vec2(0.0, 1.0)), tkH(i + vec2(1.0, 1.0)), f.x), f.y);
}
` + shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
  {
    float n1 = tkN(vTkP * 0.16), n2 = tkN(vTkP * 0.47 + 7.3), n3 = tkN(vTkP * 1.3 + 3.1);
    float k = 0.74 + 0.5 * (0.55 * n1 + 0.3 * n2 + 0.15 * n3);
    vec3 tint = mix(vec3(1.06, 0.97, 0.88), vec3(0.9, 0.97, 1.06), n2);
    diffuseColor.rgb *= k * tint;
  }`).replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = max(roughnessFactor, 0.93);   // 乾いた土: 低い月の光が斜めに当たっても、水面のような光の帯を作らない`);
  };
  mat.customProgramCacheKey = () => 'tksoil';
}

/* 本体 */
let ctx = null;

export async function start(opts) {
  if (ctx) stop();
  const canvas = opts.canvas, api = opts.api;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' });
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = false;
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0f0c16, 0.036);
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 300);
  const uScale = { value: 900 };
  const owned = [];   // dispose 対象
  let stopped = false;
  const isStopped = () => stopped;

  /* 素材ローダー（シーンにも渡す） */
  const texLoader = new THREE.TextureLoader();
  const assets = {
    url: (p) => new URL(p, SITE).href,
    loadTexture(p, o = {}) {
      const t = texLoader.load(new URL(p, SITE).href);
      if (o.srgb) t.colorSpace = THREE.SRGBColorSpace;
      if (o.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
      t.anisotropy = aniso;
      return t;
    },
    async loadGLTF(p) {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      return new GLTFLoader().loadAsync(new URL(p, SITE).href);
    }
  };
  const BU = await import('three/addons/utils/BufferGeometryUtils.js');
  // Blender 製の石・薪・切り株（GLB）を1回だけ読む。失敗したものは null になり、下でコード製の形に戻る
  const props = await loadProps(assets, aniso).catch((err) => { console.warn('[takibi] props:', err); return null; });
  if (stopped) { if (props) props.dispose(); return; }

  /* 照明 */
  const hemi = new THREE.HemisphereLight(0x5a4470, 0x0a0806, 0.5);
  scene.add(hemi);
  const moonLight = new THREE.DirectionalLight(0xbcc8f0, 0.22);
  scene.add(moonLight, moonLight.target);

  /* 地面（土の PBR） */
  const soilBase = assets.loadTexture('assets/textures/soil_basecolor.png', { srgb: true, repeat: true });
  const soilNorm = assets.loadTexture('assets/textures/soil_normal.png', { repeat: true });
  const soilRough = assets.loadTexture('assets/textures/soil_roughness.png', { repeat: true });
  const GROUND_R = 140;
  for (const t of [soilBase, soilNorm, soilRough]) t.repeat.set(GROUND_R * 2 / TILE_M, GROUND_R * 2 / TILE_M);
  const groundMat = new THREE.MeshStandardMaterial({
    map: soilBase, normalMap: soilNorm, roughnessMap: soilRough, roughness: 1.0, metalness: 0,
    normalScale: new THREE.Vector2(0.8, 0.8)
  });
  patchSoil(groundMat);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(GROUND_R, 64), groundMat);
  ground.rotation.x = -Math.PI / 2; scene.add(ground);

  /* 遠景の丘: 地面の端（世界の果て）を隠す。霧で夜空の色になじませる（シーンからは ctx.hills で表示・非表示を切り替える） */
  const hillMeshes = [];
  for (const l of HILLS) {
    const N = 128, P = [], I = [];
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * Math.PI * 2, h = hillH(l, th), c = Math.cos(th), sn = Math.sin(th);
      for (const [r, y] of [[l.R - 16, 0], [l.R, h], [l.R + 12, 0]]) P.push(c * r, y, sn * r);
    }
    for (let i = 0; i < N; i++) for (let k = 0; k < 2; k++) {
      const a = i * 3 + k, b = a + 3;
      I.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I);
    const hm = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: l.color, side: THREE.DoubleSide }));
    scene.add(hm); hillMeshes.push(hm);
  }

  /* 手前の小物: 予備の薪の束、切り株の腰掛け、小石（視界はふさがない位置）。GLB が読めなければ円柱でつくる */
  let stumpObj = null, stumpY = 0, bundleObj = null, pebbleObj = null;
  {
    if (props && props.stump) {
      const stump = new THREE.Mesh(props.stump, props.stumpMat);
      stump.scale.set(0.53, 0.95, 0.53);   // GLB は直径 約0.77m・高さ 0.42m。直径 約0.4m・高さ 約0.4m に
      stump.position.set(1.25, 0, 0.45); stump.rotation.y = 0.5; scene.add(stump); stumpObj = stump;
    } else {
      const barkMat = new THREE.MeshStandardMaterial({ color: 0x3b2a1d, roughness: 1 });
      const cutMat = new THREE.MeshStandardMaterial({ color: 0x7d5f40, roughness: 0.95 });
      const stump = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.23, 0.4, 14), [barkMat, cutMat, cutMat]);
      stump.position.set(1.25, 0.19, 0.45); stump.rotation.y = 0.5; scene.add(stump); stumpObj = stump; stumpY = 0.19;
    }
    const bundle = new THREE.Group();
    if (props && props.logs) {
      // 手前の予備の薪: 下に3本、上に2本。GLB の薪（長さ1に正規化済み・軸は Y）を横に寝かせて重ねる。半割は割り面を下にする
      const L = props.logs, halfI = L.findIndex((l) => l.half), full = L.map((l, i) => i).filter((i) => !L[i].half);
      const fi = (k) => (full.length ? full[k % full.length] : 0);
      const LEN = 0.45, rZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
      const D = (L[fi(0)].dia) * LEN;    // 丸太の太さ（断面の直径。軸の長さを含む thick を使うと、上の段が宙に浮く）
      const lay = [[-D, 0, halfI >= 0 ? halfI : fi(1)], [0, 0, fi(0)], [D, 0, fi(1)], [-D / 2, 1, fi(1)], [D / 2, 1, fi(0)]];
      const br = mulberry32(21);
      lay.forEach(([z, row, vi], i) => {
        const l = L[vi], isHalf = l.half, r = l.dia * LEN / 2;
        const m = new THREE.Mesh(l.geo, props.logMat);
        m.scale.setScalar(LEN * (0.94 + br() * 0.1));
        // Y 軸まわりの向き × 軸を水平に倒す回転 × （丸太は軸まわりにランダムに回す。半割は割り面を下に固定）
        m.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i - 2) * 0.05 + (br() - 0.5) * 0.05).multiply(rZ)
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), isHalf ? 0 : br() * 6.28));
        m.position.set((i % 3 - 1) * 0.02, row ? D * 0.88 + r : (isHalf ? 0.004 : r), z);
        bundle.add(m);
      });
    } else {
      const barkMat = new THREE.MeshStandardMaterial({ color: 0x3b2a1d, roughness: 1 });
      const bundleGeo = new THREE.CylinderGeometry(0.065, 0.06, 0.85, 8); bundleGeo.rotateZ(Math.PI / 2);
      [[-0.07, 0.065], [0.07, 0.065], [0.21, 0.065], [0, 0.175], [0.14, 0.175]].forEach(([z, y], i) => {
        const m = new THREE.Mesh(bundleGeo, i % 2 ? barkMat : new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1 }));
        m.position.set((i % 3 - 1) * 0.04, y, z); m.rotation.y = (i - 2) * 0.05; bundle.add(m);
      });
      bundle.scale.setScalar(0.55);
    }
    bundle.position.set(-1.4, 0, 0.1); bundle.rotation.y = 0.35; scene.add(bundle); bundleObj = bundle;
    const pebGeo = new THREE.IcosahedronGeometry(1, 0);
    const pebbles = new THREE.InstancedMesh(pebGeo, new THREE.MeshStandardMaterial({ color: 0x3a3836, roughness: 0.95, flatShading: true }), 16);
    const pr = mulberry32(5), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e3 = new THREE.Euler();
    for (let i = 0; i < 16; i++) {
      const a = pr() * Math.PI * 2, r = 0.9 + pr() * 1.5, s2 = 0.025 + pr() * 0.04;
      q.setFromEuler(e3.set(pr() * 3, pr() * 3, pr() * 3));
      m4.compose(new THREE.Vector3(Math.sin(a) * r, s2 * 0.4, Math.cos(a) * r), q, new THREE.Vector3(s2 * 1.3, s2 * 0.7, s2));
      pebbles.setMatrixAt(i, m4);
    }
    scene.add(pebbles); pebbleObj = pebbles;
  }

  /* 焚火の周りの灰 */
  const ashMat = new THREE.MeshStandardMaterial({
    map: assets.loadTexture('assets/textures/ash_decal.png', { srgb: true }),
    normalMap: assets.loadTexture('assets/textures/ash_normal.png'),
    roughness: 1, metalness: 0, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
  });
  const ash = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 1.25), ashMat);
  ash.rotation.x = -Math.PI / 2; ash.position.y = 0.012; scene.add(ash);

  /* 石囲い */
  let stoneGeo = null;
  if (props && props.rocks) scene.add(buildRockRing(props, { radius: RING_R }));      // Blender 製の石 rock_01〜08 を、焚火を囲むリングに並べる
  else {
    stoneGeo = buildStones(BU.mergeVertices, BU.mergeGeometries);
    const stoneMesh = new THREE.Mesh(stoneGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
    stoneMesh.scale.setScalar(RING_R / 1.12);   // コード製の石囲いは半径 1.12 で作ってあるので縮める
    scene.add(stoneMesh);
  }

  /* 薪: 燃料の量に応じて本数が変わる。手前（カメラ側）の薪は低く寝かせて、炎を隠さない。
     GLB の薪は軸を Y・長さ 1 に正規化済み（props.js）なので、円柱と同じ扱いで置ける。
     fire3d.js は logs の各 Mesh の材質に熾火の発光を重ねる（材質ごとに uniform を持つ）ため、薪1本ごとに材質を clone する（テクスチャは共有） */
  const GL = props && props.logs ? props.logs : null;
  const logGeo = GL ? null : new THREE.CylinderGeometry(0.085, 0.075, 1, 8);
  const LOG_ORDER = [0, 4, 2, 6, 1, 5, 3, 7];
  // 手前(+Z)の3本は、断面がカメラを向かないよう横向きに寝かせる。base=根元、h=水平方向の向き
  const FRONT = {
    1: { base: [0.45, 0.15, 0.75], h: [-0.9, -0.45] },
    2: { base: [-0.55, 0.09, 0.55], h: [0.9, -0.4] },
    3: { base: [0.8, 0.09, 0.15], h: [-0.85, -0.5] }
  };
  const logs = [];
  const halfI = GL ? GL.findIndex((l) => l.half) : -1, fullI = GL ? GL.map((l, i) => i).filter((i) => !GL[i].half) : [];
  const Y_UP = new THREE.Vector3(0, 1, 0), Y_AX = new THREE.Vector3(0, 1, 0), tmpV = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    const slot = LOG_ORDER[i], fr = FRONT[slot];
    let base, dir, len, outward = null;
    if (fr) {
      const hl = Math.hypot(fr.h[0], fr.h[1]), th = 1.2;
      dir = new THREE.Vector3(fr.h[0] / hl * Math.sin(th), Math.cos(th), fr.h[1] / hl * Math.sin(th));
      base = new THREE.Vector3(...fr.base).multiplyScalar(POS_K); len = (GL ? 0.74 : 0.78) * LOG_K;
    } else {
      const a = slot * (Math.PI / 4) + (slot % 2) * 0.12;
      const R0 = (0.5 + (slot % 2) * 0.12) * POS_K, th = 0.52 + (slot % 2) * 0.14;
      len = ((GL ? 0.9 : 1.0) - (slot % 2) * (GL ? 0.14 : 0.16)) * LOG_K;
      dir = new THREE.Vector3(-Math.cos(a) * Math.sin(th), Math.cos(th), -Math.sin(a) * Math.sin(th));
      base = new THREE.Vector3(Math.cos(a) * R0, 0.1 * POS_K, Math.sin(a) * R0);
      outward = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      // 奥側の薪も、上の断面がカメラを向きすぎないよう水平方向にひねる（視点を回したときの偏りも減らす）
      const twist = { 5: 0.6, 6: 1.0, 7: -0.6 }[slot];
      if (twist) dir.applyAxisAngle(Y_AX, twist);
    }
    let m;
    if (GL) {
      // 前の3本: 手前左右は丸太、真ん中は半割（割り面を下）。奥側は丸太2種と半割を順に
      const vi = fr ? (slot === 2 && halfI >= 0 ? halfI : fullI[(slot + 1) % fullI.length]) : (slot % 3 === 0 && halfI >= 0 ? halfI : fullI[slot % fullI.length]);
      const l = GL[vi];
      m = new THREE.Mesh(l.geo, props.logMat.clone());
      m.scale.setScalar(len);
      const q1 = new THREE.Quaternion().setFromUnitVectors(Y_UP, dir);
      if (l.half) {
        // 半割の丸い側（ジオメトリの -X）を、手前の薪は真上へ、奥側は外向きへ（割り面＝燃える面が焚火側を向く）
        const up = outward || Y_UP;
        const r1 = tmpV.set(-1, 0, 0).applyQuaternion(q1);
        const t = up.clone().addScaledVector(dir, -up.dot(dir));
        if (t.lengthSq() > 1e-4) {
          t.normalize();
          const ang = r1.angleTo(t) * (dir.dot(r1.clone().cross(t)) < 0 ? -1 : 1);
          q1.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, ang));
        }
        if (fr) base.y = Math.max(0.015, base.y - l.thick * len * 0.5);
      } else q1.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, i * 2.1));   // 丸太は軸まわりにばらす
      m.quaternion.copy(q1);
    } else {
      m = new THREE.Mesh(logGeo, new THREE.MeshStandardMaterial({ color: 0x4a2f1c, roughness: 0.92, emissive: 0x000000 }));
      m.scale.set(LOG_K, len, LOG_K);
      m.quaternion.setFromUnitVectors(Y_UP, dir);
    }
    m.position.copy(base).addScaledVector(dir, len / 2);
    m.userData.seed = i;
    scene.add(m); logs.push(m);
  }
  const dropMat = GL ? props.logMat : new THREE.MeshStandardMaterial({ color: 0x4a2f1c, roughness: 0.92 });
  const falling = [];    // 落下中の薪 {mesh, t0, landAt, dx, ang}

  /* 炎・火の粉・煙・熾火・火の光（fire3d.js） */
  const fire = createFire({ scene, renderer, camera, api, logs });

  /* ---------- 夜空 ---------- */
  let skyTex = null;
  const skyLoader = new THREE.TextureLoader();
  skyLoader.load(new URL('assets/textures/night_sky.png', SITE).href, (t) => {
    if (stopped) { t.dispose(); return; }
    t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace;
    skyTex = t; envKey = '';   // 背景を選び直させる
  });
  const gradTex = {};   // 夜空オフ時の暗いグラデーション（季節ごと）
  function gradientBg(season) {
    if (gradTex[season]) return gradTex[season];
    const e = SEASON_ENV[season], c = document.createElement('canvas'); c.width = 4; c.height = 256;
    const x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 0, 256);
    const hex = (h) => '#' + h.toString(16).padStart(6, '0');
    g.addColorStop(0, hex(e.bg)); g.addColorStop(0.7, hex(e.mid)); g.addColorStop(1, hex(e.bg));
    x.fillStyle = g; x.fillRect(0, 0, 4, 256);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return (gradTex[season] = t);
  }

  // 月: やわらかいにじみと円盤。季節で高さと色味を変える
  const moonTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const x = c.getContext('2d'), g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, 'rgba(255,255,255,0.55)'); g.addColorStop(0.16, 'rgba(255,255,255,0.28)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.08)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 256, 256);
    const d = x.createRadialGradient(122, 122, 2, 128, 128, 21);
    d.addColorStop(0, 'rgba(255,255,255,1)'); d.addColorStop(0.85, 'rgba(238,238,238,1)'); d.addColorStop(1, 'rgba(255,255,255,0.0)');
    x.fillStyle = d; x.beginPath(); x.arc(128, 128, 21, 0, Math.PI * 2); x.fill();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const moonMat = new THREE.SpriteMaterial({ map: moonTex, transparent: true, depthWrite: false, fog: false, toneMapped: false, color: 0xffffff });
  const moon = new THREE.Sprite(moonMat);
  scene.add(moon);

  // 星のまたたき: 背景画像の上に少数の点を重ねて、明るさだけ揺らす
  const NSTAR = 90;
  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(NSTAR * 3), starCol = new Float32Array(NSTAR * 3);
  const starPh = new Float32Array(NSTAR * 2), starBase = new Float32Array(NSTAR);
  {
    const r = mulberry32(9);
    for (let i = 0; i < NSTAR; i++) {
      const p = skyDir(r() * Math.PI * 2, 0.06 + r() * 1.1, SKY_R * 0.98);
      starPos.set([p.x, p.y, p.z], i * 3);
      starPh[i * 2] = r() * 20; starPh[i * 2 + 1] = 0.6 + r() * 1.8; starBase[i] = 0.35 + r() * 0.65;
    }
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starAttr = new THREE.BufferAttribute(starCol, 3); starAttr.setUsage(THREE.DynamicDrawUsage);
  starGeo.setAttribute('color', starAttr);
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
    size: 2.2 * dpr, sizeAttenuation: false, vertexColors: true, fog: false, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
  }));
  stars.frustumCulled = false; scene.add(stars);

  // 流れ星: 数十秒〜数分に1回、細い光の筋がすっと流れる
  const NS = 10;
  const ssGeo = new THREE.BufferGeometry();
  const ssPos = new Float32Array(NS * 3), ssCol = new Float32Array(NS * 3);
  const ssPosA = new THREE.BufferAttribute(ssPos, 3), ssColA = new THREE.BufferAttribute(ssCol, 3);
  ssPosA.setUsage(THREE.DynamicDrawUsage); ssColA.setUsage(THREE.DynamicDrawUsage);
  ssGeo.setAttribute('position', ssPosA); ssGeo.setAttribute('color', ssColA);
  const shooting = new THREE.Line(ssGeo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false
  }));
  shooting.frustumCulled = false; shooting.visible = false; scene.add(shooting);
  let ss = null, ssNext = rnd(25, 80);
  function startShooting(t) {
    const dir = Math.random() < 0.5 ? -1 : 1;
    ss = { t0: t, dur: rnd(0.7, 1.1), az: rnd(-0.7, 0.7), el: rnd(0.2, 0.42), daz: dir * rnd(0.22, 0.4), del: -rnd(0.1, 0.22) };
    shooting.visible = true;
  }
  function updateShooting(t) {
    const p = (t - ss.t0) / ss.dur;
    if (p >= 1) { ss = null; shooting.visible = false; ssNext = t + rnd(40, 160); return; }
    const env = Math.sin(Math.PI * p);
    for (let i = 0; i < NS; i++) {
      const back = (i / (NS - 1)) * 0.3, q = p - back * 0.6;   // 尾は少し遅れて追う
      const v = skyDir(ss.az + ss.daz * q, ss.el + ss.del * q, SKY_R);
      ssPos[i * 3] = v.x; ssPos[i * 3 + 1] = v.y; ssPos[i * 3 + 2] = v.z;
      const f = Math.pow(1 - i / (NS - 1), 1.6) * env;
      ssCol[i * 3] = 0.85 * f; ssCol[i * 3 + 1] = 0.92 * f; ssCol[i * 3 + 2] = f;
    }
    ssPosA.needsUpdate = ssColA.needsUpdate = true;
  }

  /* ---------- ホタル（季節の演出とは独立） ---------- */
  const NFF_BASE = 22, NFF = 44;        // 通常は22匹。シーンが ctx.fireflies.value（倍率）で最大44匹まで増やせる
  const ffScale = { value: 1 };
  const ffPts = makeFireflyPoints(NFF, uScale);   // 小さく鋭い芯（2〜4px）と弱いにじみ。画面上の大きさに上限あり（scenes/firefly.js）
  ffPts.points.visible = false; scene.add(ffPts.points);
  const ff = [];
  for (let i = 0; i < NFF; i++) {
    const a = Math.random() * Math.PI * 2, r = 1.8 + Math.sqrt(Math.random()) * 6;
    ff.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, y: rnd(0.25, 1.9), a: rnd(0, 6.28), sp: rnd(0.12, 0.28), per: rnd(2.2, 3.2), ph: Math.random(), sz: rnd(0.75, 1.25) });
  }
  let ffAmt = 0;
  const ffCol = rgb(0xc4ff6a);
  function updateFireflies(dt, t, on) {
    ffAmt += ((on ? 1 : 0) - ffAmt) * (1 - Math.exp(-dt * 1.5));
    if (ffAmt < 0.01 && !on) { ffPts.points.visible = false; return; }
    ffPts.points.visible = true;
    const P = ffPts, n = Math.min(NFF, Math.max(0, Math.round(NFF_BASE * ffScale.value)));
    for (let i = 0; i < n; i++) {
      const d = ff[i], o = i * 3;
      d.a += (Math.random() - 0.5) * 2.2 * dt;
      d.x += Math.cos(d.a) * d.sp * dt; d.z += Math.sin(d.a) * d.sp * dt; d.y += Math.sin(d.a * 1.3 + d.ph * 6) * d.sp * 0.4 * dt;
      const rr = d.x * d.x + d.z * d.z;
      if (rr > 64 || rr < 2.5) d.a += Math.PI;
      d.y = clamp(d.y, 0.2, 2.0);
      const u = (t / d.per + d.ph) % 1;                       // 2〜3秒周期で ふわっと光って消える
      const b = u < 0.72 ? Math.pow(Math.sin(Math.PI * u / 0.72), 2) : 0;
      P.pos[o] = d.x; P.pos[o + 1] = d.y; P.pos[o + 2] = d.z;
      P.size[i] = 0.26 * d.sz; P.alp[i] = b * 0.95 * ffAmt;
      P.col[o] = ffCol[0]; P.col[o + 1] = ffCol[1]; P.col[o + 2] = ffCol[2];
    }
    P.flush(n);
  }

  /* ---------- カメラ ----------
     焚火を中心に、左右（方位）は無制限に360度、上下は少し見下ろす角度から +35° の見上げまで。ドラッグ・1本指で見回し、ホイール・2本指のピンチで寄り引き。
     離したあとは少し惰性で止まる。ダブルクリック（ダブルタップ）で初期の視点へ。何もしないときはごくゆっくり揺れ、設定で「ゆっくり見回す」（setCameraAuto）も選べる。 */
  const view = { az: 0, azT: 0, vAz: 0, pit: 0, pitT: 0, vPit: 0, dst: CAM_R, dstT: CAM_R, reset: false, lastTouch: -1e9 };
  const aimPitch = (d) => Math.atan2(AIM_Y - EYE_Y, d);   // 焚火の中心を画面の中央に置く角度（距離ごと）
  const auto = { on: false, sec: 240, amt: 0 };
  const vo = { x: 0, y: 0 }; let voOn = false;   // 画面の見える範囲へ寄せるずらし(px)
  const camBlockers = [];   // シーンが置く {x, z, r}: カメラがこの円の中に入らない（シーンを離れると空にする）
  canvas.style.touchAction = 'none';

  const ptrs = new Map();   // pointerId -> {x, y}
  let gest = null;          // 進行中の操作 {t0, x0, y0, moved, pinched, drag, bx, by, baz, bpit, pd0, bdst, lt}
  let lastTap = { t: -1e9, x: 0, y: 0 };
  const nowMs = () => performance.now();
  const ptrList = () => Array.from(ptrs.values());
  function rebase() {
    const l = ptrList(); if (!gest) return;
    if (l.length === 1) { gest.bx = l[0].x; gest.by = l[0].y; gest.baz = view.azT; gest.bpit = view.pitT; gest.lt = nowMs(); }
    else if (l.length >= 2) { gest.pd0 = Math.hypot(l[0].x - l[1].x, l[0].y - l[1].y) || 1; gest.bdst = view.dstT; }
  }
  const onDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    const t = nowMs();
    if (!gest) gest = { t0: t, x0: e.clientX, y0: e.clientY, moved: 0, pinched: false, drag: false };
    if (ptrs.size >= 2) gest.pinched = true;
    view.vAz = view.vPit = 0; view.reset = false; view.lastTouch = t;
    rebase();
  };
  const onMove = (e) => {
    const pt = ptrs.get(e.pointerId); if (!pt || !gest) return;
    pt.x = e.clientX; pt.y = e.clientY;
    gest.moved = Math.max(gest.moved, Math.hypot(e.clientX - gest.x0, e.clientY - gest.y0));
    const t = nowMs(); view.lastTouch = t;
    const l = ptrList();
    if (l.length >= 2) {
      const d = Math.hypot(l[0].x - l[1].x, l[0].y - l[1].y) || 1;
      view.dstT = clamp(gest.bdst * gest.pd0 / d, DIST_MIN, DIST_MAX);   // 指を広げると近づく
      return;
    }
    if (gest.pinched) return;   // ピンチのあと残った1本では回さない（触り直す）
    if (!gest.drag) { if (gest.moved <= TAP_PX) return; gest.drag = true; rebase(); return; }
    const fk = camera.fov / FOV;
    const az2 = gest.baz - (pt.x - gest.bx) * 0.0055 * fk, pit2 = clamp(gest.bpit + (pt.y - gest.by) * 0.0045 * fk, PITCH_MIN, PITCH_MAX);
    const dtm = Math.max(1, t - gest.lt) / 1000;
    view.vAz = 0.55 * view.vAz + 0.45 * (az2 - view.azT) / dtm; view.vPit = 0.55 * view.vPit + 0.45 * (pit2 - view.pitT) / dtm;
    gest.lt = t; view.azT = az2; view.pitT = pit2;
  };
  const onUp = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    if (!gest) return;
    const t = nowMs();
    if (ptrs.size > 0) { rebase(); return; }
    const was = gest; gest = null; view.lastTouch = t;
    if (e.type === 'pointerup' && !was.pinched && was.moved < TAP_PX && t - was.t0 < TAP_MS) {
      // タップ: すぐあとの2回目のタップは「初期の視点へ戻す」（薪はくべない）
      if (t - lastTap.t < DBL_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) { lastTap.t = -1e9; resetView(); return; }
      lastTap = { t, x: e.clientX, y: e.clientY };
      api.addLog({ x: e.clientX, y: e.clientY });   // pointerup の中で同期的に（index.html の tapFeed が上端・下端の帯を振り分ける）
      return;
    }
    if (!was.drag || t - was.lt > 90) view.vAz = view.vPit = 0;   // 離す直前まで動いていたときだけ惰性
    view.vAz = clamp(view.vAz, -2.5, 2.5); view.vPit = clamp(view.vPit, -1.0, 1.0);
  };
  const onWheel = (e) => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
    view.dstT = clamp(view.dstT * Math.exp(clamp(dy, -200, 200) * 0.0012), DIST_MIN, DIST_MAX);
    view.reset = false; view.lastTouch = nowMs();
  };
  const noGesture = (e) => e.preventDefault();
  function resetView() {
    view.azT = Math.round(view.az / (Math.PI * 2)) * Math.PI * 2;   // いちばん近い「正面」へ
    view.pitT = 0; view.dstT = CAM_R; view.vAz = view.vPit = 0; view.reset = true;
  }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('gesturestart', noGesture);
  canvas.addEventListener('gesturechange', noGesture);

  function resize() {
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // 縦長画面では画角を広げて焚火が収まるようにする
    camera.fov = w / h < 1 ? Math.min(75, FOV / Math.max(0.55, w / h)) : FOV;
    camera.updateProjectionMatrix();
    uScale.value = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    fire.setSize(w, h);
  }
  window.addEventListener('resize', resize);
  resize();

  /* ---------- シーンの切り替え ---------- */
  let curScene = null, curSceneId = '', curSeason = '', envKey = '';
  // シーン向けの窓口（どれも、シーンを離れるとホスト側で元に戻す）:
  //   fireLights = 焚火の2つの点光源（distance を変えて届く範囲を調整してよい。dispose で戻す）
  //   lights     = {hemi, moon}（環境光と月の光の強さを変えてよい）
  //   sky.setMoon(az, el)               = 月の位置の上書き（洞窟の入口から月が見えるように）
  //   sky.setMoonColor(color, intensity) = 月の見た目と月光の色の上書き（null で解除）
  //   hills.setVisible(bool)            = 遠景の丘の表示・非表示（海のように水平線を見せたいシーン用）
  const fireLights = []; scene.traverse((o) => { if (o.isPointLight) fireLights.push(o); });
  const sky = {
    moon: null, moonColor: null, dirty: false,
    setMoon(az, el) { sky.moon = { az, el }; sky.dirty = true; },
    /* color: 月の見た目（円盤とにじみ）の色。intensity（既定 1）: 月光の強さの倍率。lightColor（省略時は color）: 月光の色 */
    setMoonColor(color, intensity = 1, lightColor = color) {
      sky.moonColor = color == null ? null : { color, intensity, light: lightColor };
      sky.dirty = true;
    }
  };
  const hills = {
    visible: true,
    setVisible(v) { hills.visible = !!v; hillMeshes.forEach((h) => { h.visible = hills.visible; }); }
  };
  /* 共通の小物の置き場所: シーン定義の props で上書きできる（未指定は既定、null は非表示）。位置は地面の上（y は自動） */
  const DEFAULT_PROPS = { logPile: { x: -1.4, z: 0.1, rotY: 0.35 }, stump: { x: 1.25, z: 0.45, rotY: 0.5 }, pebbles: true };
  function applyProps(p) {
    p = p || {};
    const pick = (k) => (p[k] === undefined ? DEFAULT_PROPS[k] : p[k]);
    const lp = pick('logPile'), st = pick('stump');
    if (bundleObj) { bundleObj.visible = !!lp; if (lp) { bundleObj.position.set(lp.x, 0, lp.z); bundleObj.rotation.y = lp.rotY || 0; } }
    if (stumpObj) { stumpObj.visible = !!st; if (st) { stumpObj.position.set(st.x, stumpY, st.z); stumpObj.rotation.y = st.rotY || 0; } }
    if (pebbleObj) pebbleObj.visible = pick('pebbles') !== false;
  }
  const fireLight0 = fireLights.map((l) => ({ distance: l.distance, decay: l.decay }));
  const groundGeo0 = ground.geometry, groundColor0 = ground.material.color.clone();
  let baseChildren = null;
  const sceneCtx = {
    THREE, scene, renderer, camera, api, util, assets, uScale, isStopped,
    fireCenter: { x: 0, z: 0 }, root: null, camBlockers, fireLights, lights: { hemi, moon: moonLight }, sky, hills,
    ground, fireflies: ffScale,   // ground: 地面のメッシュ（シーンが穴や色を変えたら dispose で戻す）。fireflies.value: ホタルの数の倍率（1=22匹、最大2）
  };
  function switchScene(id) {
    const def = SCENES.find((s) => s.id === id) || SCENES[0];
    curSceneId = id;
    if (curScene && curScene.def === def) return;
    if (!baseChildren) baseChildren = new Set(scene.children);   // 共通部分（シーン無しの状態）の物
    camBlockers.length = 0;
    if (curScene) {
      try { curScene.inst.dispose(); } catch (err) { console.error(err); }
      scene.remove(curScene.root); disposeTree(curScene.root);
      curScene = null;
    }
    // 前のシーンが scene 直下に残したもの（ライトなど）を、共通部分の物と落下中の薪以外すべて外す
    for (const c of scene.children.slice()) {
      if (baseChildren.has(c) || falling.some((d) => d.mesh === c)) continue;
      console.warn('[takibi] scene dispose で外されなかった物を外しました:', c.type);
      scene.remove(c); disposeTree(c);
    }
    // 地面・丘・光・月・ホタル・小物を、共通の状態へ戻す（シーンの dispose の戻し忘れがあっても残さない）
    if (ground.geometry !== groundGeo0) ground.geometry = groundGeo0;
    ground.material.color.copy(groundColor0); ground.visible = true;
    hills.setVisible(true);
    ffScale.value = 1;
    hemi.intensity = 0.5; sky.moon = null; sky.moonColor = null; sky.dirty = false; envKey = '';   // シーンが変えた光・月を元に戻す（次の更新で季節の値を入れ直す）
    fireLights.forEach((l, i) => { l.distance = fireLight0[i].distance; l.decay = fireLight0[i].decay; });
    applyProps(null);
    const root = new THREE.Group();
    scene.add(root);
    sceneCtx.root = root;
    let inst;
    try { inst = def.build(sceneCtx); } catch (err) { console.error('[takibi] scene build:', err); scene.remove(root); return; }
    curScene = { def, inst, root };
    applyProps(def.props);
    if (curSeason) inst.setSeason(curSeason);
    if (api.applySceneAudio) api.applySceneAudio(def.audio || {});
  }

  /* 購読 */
  const unsubs = [
    api.onLogAdded((ev) => {
      if (ev.type === 'drop') {
        const mesh = new THREE.Mesh(GL ? GL[fullI.length ? fullI[0] : 0].geo : logGeo, dropMat);
        if (GL) mesh.scale.setScalar(0.85 * LOG_K); else mesh.scale.set(LOG_K, 0.95 * LOG_K, LOG_K);
        scene.add(mesh);
        falling.push({ mesh, t0: ev.t0, landAt: ev.landAt, dx: ev.dx * 1.6 * POS_K, ang: ev.ang });
      }
    }),
    api.onActiveChange((on) => setActive(on))
  ];

  /* 毎フレームの更新 */
  let elapsed = 0;
  function update(dt) {
    const st = api.getState(), now = performance.now();
    elapsed += dt;
    const t = elapsed;

    // 季節・シーン・空
    const seasonChanged = st.season !== curSeason;
    if (seasonChanged) curSeason = st.season;
    if (st.scene !== curSceneId || !curScene) switchScene(st.scene);
    else if (seasonChanged && curScene) curScene.inst.setSeason(curSeason);
    const env = SEASON_ENV[curSeason];
    if (sky.dirty) { sky.dirty = false; envKey = ''; }
    const ek = curSeason + (st.nightSky ? 'S' : 'G');
    if (ek !== envKey) {
      envKey = ek;
      if (st.nightSky && skyTex) { scene.background = skyTex; scene.backgroundIntensity = 0.75; scene.fog.color.setHex(env.fog); }
      else { scene.background = gradientBg(curSeason); scene.backgroundIntensity = 1; scene.fog.color.setHex(st.nightSky ? env.fog : env.bg); }
      hemi.color.setHex(env.hemi);
      const m = sky.moon ? Object.assign({}, env.moon, sky.moon) : env.moon;
      moon.position.copy(skyDir(m.az, m.el, SKY_R)); moon.scale.setScalar(m.size);
      moonMat.color.setHex(m.color);
      moonLight.color.setHex(m.light); moonLight.intensity = m.power;
      const mc = sky.moonColor;
      if (mc) { moonMat.color.setHex(mc.color); moonLight.color.setHex(mc.light); moonLight.intensity = m.power * mc.intensity; }
      moonLight.position.copy(skyDir(m.az, m.el, 40));
    }
    moon.visible = stars.visible = !!st.nightSky;
    renderer.toneMappingExposure = 1.05 * st.brightness;

    // 星のまたたき・流れ星
    if (st.nightSky) {
      for (let i = 0; i < NSTAR; i++) {
        const b = starBase[i] * (0.55 + 0.45 * Math.sin(t * starPh[i * 2 + 1] + starPh[i * 2])) * 0.8;
        starCol[i * 3] = 0.8 * b; starCol[i * 3 + 1] = 0.86 * b; starCol[i * 3 + 2] = b;
      }
      starAttr.needsUpdate = true;
      if (ss) updateShooting(t); else if (t > ssNext) startShooting(t);
    } else if (ss) { ss = null; shooting.visible = false; }

    // 薪
    const shown = st.started ? Math.min(st.maxFuel, Math.max(1, Math.ceil(st.fuel - 0.02))) : 1;
    for (let i = 0; i < logs.length; i++) logs[i].visible = i < shown;
    for (let i = falling.length - 1; i >= 0; i--) {
      const d = falling[i], p = clamp((now - d.t0) / (d.landAt - d.t0), 0, 1), e2 = p * p;
      d.mesh.position.set(d.dx * (1 - e2 * 0.6), 2.2 + (0.35 - 2.2) * e2, 0);
      d.mesh.rotation.set(0, 0, Math.PI / 2 + d.ang * (1 - 0.6 * e2));
      if (now >= d.landAt + 40) { scene.remove(d.mesh); falling.splice(i, 1); }
    }

    // 炎・火の粉・煙・熾火・光
    api.pump();
    fire.update(dt, t, st);

    updateFireflies(dt, t, !!st.fireflies);
    if (curScene) curScene.inst.update(dt, t, st);

    // カメラ（見回し・寄り引き・惰性・ゆっくり見回す・初期の視点へ戻る）
    const touching = ptrs.size > 0;
    if (!touching) {
      view.azT += view.vAz * dt; view.pitT = clamp(view.pitT + view.vPit * dt, PITCH_MIN, PITCH_MAX);
      const dec = Math.exp(-dt * 4.5); view.vAz *= dec; view.vPit *= dec;
      if (Math.abs(view.vAz) < 0.01) view.vAz = 0;
      if (Math.abs(view.vPit) < 0.01) view.vPit = 0;
    }
    const calm = !touching && !view.reset && view.vAz === 0 && now - view.lastTouch > 2500;
    auto.amt += ((auto.on && calm ? 1 : 0) - auto.amt) * (1 - Math.exp(-dt * 1.2));
    if (auto.amt > 0.001) view.azT += auto.amt * (Math.PI * 2 / auto.sec) * dt;
    const kf = 1 - Math.exp(-dt * (view.reset ? 3.2 : 8));
    view.az += (view.azT - view.az) * kf; view.pit += (view.pitT - view.pit) * kf; view.dst += (view.dstT - view.dst) * kf;
    if (view.reset && Math.abs(view.azT - view.az) < 0.002 && Math.abs(view.dstT - view.dst) < 0.005) view.reset = false;
    const a = view.az + (auto.amt > 0.5 ? 0 : 0.05 * Math.sin(t * 0.13) + 0.02 * Math.sin(t * 0.31));
    const pit = aimPitch(view.dst) + view.pit + 0.015 * Math.sin(t * 0.11);
    let cx = Math.sin(a) * view.dst, cz = Math.cos(a) * view.dst;
    for (const b of camBlockers) {   // シーンの置物（鹿威し・縁台など）に頭を突っ込まない
      const dx = cx - b.x, dz = cz - b.z, d = Math.hypot(dx, dz), lim = b.r + 0.2;
      if (d < lim) { if (d > 1e-4) { cx = b.x + dx * lim / d; cz = b.z + dz * lim / d; } else cx = b.x + lim; }
    }
    // スマホで設定のシートが半分開いているとき、焚火がシートに隠れないよう、画面の見える範囲の中央へ寄せる（閉じたら戻す）
    {
      const b = document.body, w = window.innerWidth, h = window.innerHeight;
      const open = b.classList.contains('m') && b.classList.contains('panel-open');
      const tx = open && w > h ? 0.22 * w : 0, ty = open && w <= h ? 0.3 * h : 0;
      const kp = 1 - Math.exp(-dt * 7);
      vo.x += (tx - vo.x) * kp; vo.y += (ty - vo.y) * kp;
      if (Math.abs(vo.x) + Math.abs(vo.y) > 0.5) { camera.setViewOffset(w, h, vo.x, vo.y, w, h); voOn = true; }
      else if (voOn) { camera.clearViewOffset(); voOn = false; }
    }
    camera.position.set(cx, EYE_Y, cz);
    const cp = Math.cos(pit);
    camera.lookAt(cx - Math.sin(a) * cp, EYE_Y + Math.sin(pit), cz - Math.cos(a) * cp);
  }

  /* 描画ループ（30fps。タブ非表示 / 映像オフの間は止める） */
  renderer.info.autoReset = false;
  let lastTris = 0, lastCalls = 0;
  let raf = 0, last = 0, active = false, winStart = 0, winFrames = 0, winWarm = true;   // 表示開始直後の最初の5秒は読み込み・シェーダー生成で遅くなるので判定しない
  function resetPerf() { winStart = 0; winFrames = 0; }
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (ts - last < FRAME_MS - 2) return;
    const gap = ts - last;
    const dt = last ? Math.min(0.05, gap / 1000) : 1 / 30;
    const hadLast = last > 0;
    last = ts;
    renderer.info.reset();
    update(dt);
    fire.render();
    lastTris = renderer.info.render.triangles; lastCalls = renderer.info.render.calls;
    // 計測: 止まっていた・間引かれたフレーム（間隔が GAP_MS 超）は除外し、非表示中はリセット
    if (document.hidden || (hadLast && gap > GAP_MS)) { resetPerf(); return; }
    if (!winStart) { winStart = ts; winFrames = 0; return; }
    winFrames++;
    if (ts - winStart >= SLOW_WINDOW_MS) {
      const fps = winFrames * 1000 / (ts - winStart);
      resetPerf();
      if (winWarm) winWarm = false;
      else if (fps < SLOW_FPS && api.reportSlow) api.reportSlow(fps);
    }
  }
  function setActive(on) {
    on = !!on;
    if (on === active) return;
    active = on;
    resetPerf(); winWarm = true;
    if (on) { last = 0; if (!raf) raf = requestAnimationFrame(loop); }
    else if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  setActive(api.getState().active);

  ctx = {
    canvas, renderer, scene,
    setAuto(on, sec) { auto.on = on; if (Number.isFinite(sec) && sec >= 30) auto.sec = sec; },
    getStats() { const m = renderer.info.memory; return { triangles: lastTris, calls: lastCalls, geometries: m.geometries, textures: m.textures }; },
    getAuto() { return { on: auto.on, seconds: auto.sec }; },
    resetView,
    getView() { return { az: view.az, pit: view.pit, dist: view.dst }; },
    setView(v) {
      if (Number.isFinite(v.az)) view.az = view.azT = v.az;
      if (Number.isFinite(v.pit)) view.pit = view.pitT = clamp(v.pit, PITCH_MIN, PITCH_MAX);
      if (Number.isFinite(v.dist)) view.dst = view.dstT = clamp(v.dist, DIST_MIN, DIST_MAX);
      view.vAz = view.vPit = 0; view.reset = false;
    },
    stop() {
      stopped = true;
      setActive(false);
      unsubs.forEach((u) => { try { u(); } catch (err) {} });
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('gesturestart', noGesture); canvas.removeEventListener('gesturechange', noGesture);
      falling.forEach((d) => scene.remove(d.mesh));
      if (curScene) { try { curScene.inst.dispose(); } catch (err) {} scene.remove(curScene.root); curScene = null; }
      fire.dispose();
      disposeTree(scene);
      Object.values(gradTex).forEach((x) => x.dispose());
      if (skyTex) skyTex.dispose();
      moonTex.dispose(); if (logGeo) logGeo.dispose(); if (stoneGeo) stoneGeo.dispose(); if (props) props.dispose();
      owned.forEach((x) => x.dispose && x.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
    }
  };
}

export function stop() {
  if (!ctx) return;
  const c = ctx; ctx = null;
  c.stop();
}
