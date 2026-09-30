// 焚火の3D表示（three.js）。index.html が起動時に import して start() を呼ぶ。
// 状態は index.html の window.TAKIBI（opts.api）から読む。ここからは状態を書き換えない（薪をくべる addLog と、シーンの音の窓口だけ）。
// 共通部分（焚火・石囲い・薪・地面・夜空・ホタル・カメラ・性能制御）はここ、シーン固有のものは scenes/*.js。
import * as THREE from 'three';
import { createFire } from './fire3d.js';
import { SCENES } from './scenes/index.js';
import * as util from './scenes/util.js';

const { mulberry32, clamp, rnd, rgb, radialTexture, disposeTree, makePoints, HILLS, hillH } = util;

export { SCENES };

const FRAME_MS = 1000 / 30;          // 描画は30fpsに制限
const MAX_DPR = 1.25;                // 内蔵GPUでも回るようピクセル比の上限を低めにする
const SLOW_FPS = 20, SLOW_WINDOW_MS = 5000;   // 5秒間の平均がこれを下回ったら草を減らす
const GAP_MS = 250;                  // これを超えるフレーム間隔は「止まっていた」とみなして計測に含めない
const FOV = 55;
const SKY_R = 150;                   // 空の物（月・流れ星・星）を置く半径
const TILE_M = 1.75;                 // 土のテクスチャ1タイルの大きさ(m)
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
  }`);
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
  if (stopped) return;

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

  /* 遠景の丘: 地面の端（世界の果て）を隠す。霧で夜空の色になじませる */
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
    scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: l.color, side: THREE.DoubleSide })));
  }

  /* 手前の小物: 予備の薪の束、切り株の腰掛け、小石（視界はふさがない位置） */
  {
    const barkMat = new THREE.MeshStandardMaterial({ color: 0x3b2a1d, roughness: 1 });
    const cutMat = new THREE.MeshStandardMaterial({ color: 0x7d5f40, roughness: 0.95 });
    const stumpGeo = new THREE.CylinderGeometry(0.27, 0.33, 0.42, 14);
    const stump = new THREE.Mesh(stumpGeo, [barkMat, cutMat, cutMat]);
    stump.position.set(2.05, 0.19, 0.55); stump.rotation.y = 0.5; scene.add(stump);
    const bundleGeo = new THREE.CylinderGeometry(0.065, 0.06, 0.85, 8); bundleGeo.rotateZ(Math.PI / 2);
    const bundle = new THREE.Group();
    [[-0.07, 0.065], [0.07, 0.065], [0.21, 0.065], [0, 0.175], [0.14, 0.175]].forEach(([z, y], i) => {
      const m = new THREE.Mesh(bundleGeo, i % 2 ? barkMat : new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1 }));
      m.position.set((i % 3 - 1) * 0.04, y, z); m.rotation.y = (i - 2) * 0.05; bundle.add(m);
    });
    bundle.position.set(-2.0, 0, 0.1); bundle.rotation.y = 0.35; scene.add(bundle);
    const pebGeo = new THREE.IcosahedronGeometry(1, 0);
    const pebbles = new THREE.InstancedMesh(pebGeo, new THREE.MeshStandardMaterial({ color: 0x3a3836, roughness: 0.95, flatShading: true }), 16);
    const pr = mulberry32(5), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e3 = new THREE.Euler();
    for (let i = 0; i < 16; i++) {
      const a = pr() * Math.PI * 2, r = 1.7 + pr() * 1.5, s2 = 0.03 + pr() * 0.05;
      q.setFromEuler(e3.set(pr() * 3, pr() * 3, pr() * 3));
      m4.compose(new THREE.Vector3(Math.sin(a) * r, s2 * 0.4, Math.cos(a) * r), q, new THREE.Vector3(s2 * 1.3, s2 * 0.7, s2));
      pebbles.setMatrixAt(i, m4);
    }
    scene.add(pebbles);
  }

  /* 焚火の周りの灰 */
  const ashMat = new THREE.MeshStandardMaterial({
    map: assets.loadTexture('assets/textures/ash_decal.png', { srgb: true }),
    normalMap: assets.loadTexture('assets/textures/ash_normal.png'),
    roughness: 1, metalness: 0, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
  });
  const ash = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), ashMat);
  ash.rotation.x = -Math.PI / 2; ash.position.y = 0.012; scene.add(ash);

  /* 石囲い */
  const stoneGeo = buildStones(BU.mergeVertices, BU.mergeGeometries);
  const stoneMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  const stones = new THREE.Mesh(stoneGeo, stoneMat);
  scene.add(stones);

  /* 薪: 燃料の量に応じて本数が変わる。手前（カメラ側）の薪は低く寝かせて、炎を隠さない */
  const logGeo = new THREE.CylinderGeometry(0.085, 0.075, 1, 8);
  const LOG_ORDER = [0, 4, 2, 6, 1, 5, 3, 7];
  // 手前(+Z)の3本は、断面がカメラを向かないよう横向きに寝かせる。base=根元、h=水平方向の向き
  const FRONT = {
    1: { base: [0.45, 0.15, 0.75], h: [-0.9, -0.45] },
    2: { base: [-0.55, 0.09, 0.55], h: [0.9, -0.4] },
    3: { base: [0.8, 0.09, 0.15], h: [-0.85, -0.5] }
  };
  const logs = [];
  for (let i = 0; i < 8; i++) {
    const slot = LOG_ORDER[i], fr = FRONT[slot];
    let base, dir, len;
    if (fr) {
      const hl = Math.hypot(fr.h[0], fr.h[1]), th = 1.2;
      dir = new THREE.Vector3(fr.h[0] / hl * Math.sin(th), Math.cos(th), fr.h[1] / hl * Math.sin(th));
      base = new THREE.Vector3(...fr.base); len = 0.78;
    } else {
      const a = slot * (Math.PI / 4) + (slot % 2) * 0.12;
      const R0 = 0.5 + (slot % 2) * 0.12, th = 0.52 + (slot % 2) * 0.14;
      len = 1.0 - (slot % 2) * 0.16;
      dir = new THREE.Vector3(-Math.cos(a) * Math.sin(th), Math.cos(th), -Math.sin(a) * Math.sin(th));
      base = new THREE.Vector3(Math.cos(a) * R0, 0.1, Math.sin(a) * R0);
      // 奥側の薪も、上の断面がカメラを向きすぎないよう水平方向にひねる（視点を回したときの偏りも減らす）
      const twist = { 5: 0.6, 6: 1.0, 7: -0.6 }[slot];
      if (twist) dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), twist);
    }
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a2f1c, roughness: 0.92, emissive: 0x000000 });
    const m = new THREE.Mesh(logGeo, mat);
    m.scale.y = len;
    m.position.copy(base).addScaledVector(dir, len / 2);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    m.userData.seed = i;
    scene.add(m); logs.push(m);
  }
  const dropMat = new THREE.MeshStandardMaterial({ color: 0x4a2f1c, roughness: 0.92 });
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
  const NFF = 22;
  const ffPts = makePoints(NFF, THREE.AdditiveBlending, 1.2, uScale);
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
    const P = ffPts;
    for (let i = 0; i < NFF; i++) {
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
    P.flush(NFF);
  }

  /* ---------- カメラ ---------- */
  const target = new THREE.Vector3(0, 0.9, 0);
  let azT = 0, az = 0, elT = 0, el = 0;
  const CAM_R = 3.6, CAM_EL = 0.155;   // 焚火の前に座って、火と空を一緒に見る目線

  /* 入力: ドラッグで視点、ドラッグでないクリックで薪をくべる */
  let down = null, dragged = false;
  const onDown = (e) => { down = { x: e.clientX, y: e.clientY, az: azT, el: elT, id: e.pointerId }; dragged = false; try { canvas.setPointerCapture(e.pointerId); } catch (err) {} };
  const onMove = (e) => {
    if (!down || e.pointerId !== down.id) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!dragged && Math.hypot(dx, dy) > 6) dragged = true;
    if (dragged) { azT = clamp(down.az - dx * 0.005, -0.7, 0.7); elT = clamp(down.el + dy * 0.003, -0.1, 0.16); }
  };
  const onUp = (e) => {
    if (!down || e.pointerId !== down.id) return;
    const was = dragged; down = null; dragged = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    if (!was && e.type === 'pointerup') api.addLog();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

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
  const sceneCtx = {
    THREE, scene, renderer, camera, api, util, assets, uScale, isStopped,
    fireCenter: { x: 0, z: 0 }, root: null
  };
  function switchScene(id) {
    const def = SCENES.find((s) => s.id === id) || SCENES[0];
    curSceneId = id;
    if (curScene && curScene.def === def) return;
    if (curScene) {
      try { curScene.inst.dispose(); } catch (err) { console.error(err); }
      scene.remove(curScene.root); disposeTree(curScene.root);
      curScene = null;
    }
    const root = new THREE.Group();
    scene.add(root);
    sceneCtx.root = root;
    let inst;
    try { inst = def.build(sceneCtx); } catch (err) { console.error('[takibi] scene build:', err); scene.remove(root); return; }
    curScene = { def, inst, root };
    if (curSeason) inst.setSeason(curSeason);
    if (api.applySceneAudio) api.applySceneAudio(def.audio || {});
  }

  /* 購読 */
  const unsubs = [
    api.onLogAdded((ev) => {
      if (ev.type === 'drop') {
        const mesh = new THREE.Mesh(logGeo, dropMat); mesh.scale.y = 0.95; scene.add(mesh);
        falling.push({ mesh, t0: ev.t0, landAt: ev.landAt, dx: ev.dx * 1.6, ang: ev.ang });
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
    const ek = curSeason + (st.nightSky ? 'S' : 'G');
    if (ek !== envKey) {
      envKey = ek;
      if (st.nightSky && skyTex) { scene.background = skyTex; scene.backgroundIntensity = 0.75; scene.fog.color.setHex(env.fog); }
      else { scene.background = gradientBg(curSeason); scene.backgroundIntensity = 1; scene.fog.color.setHex(st.nightSky ? env.fog : env.bg); }
      hemi.color.setHex(env.hemi);
      const m = env.moon;
      moon.position.copy(skyDir(m.az, m.el, SKY_R)); moon.scale.setScalar(m.size);
      moonMat.color.setHex(m.color);
      moonLight.color.setHex(m.light); moonLight.intensity = m.power;
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
      d.mesh.position.set(d.dx * (1 - e2 * 0.6), 3.4 + (0.6 - 3.4) * e2, 0);
      d.mesh.rotation.set(0, 0, Math.PI / 2 + d.ang * (1 - 0.6 * e2));
      if (now >= d.landAt + 40) { scene.remove(d.mesh); falling.splice(i, 1); }
    }

    // 炎・火の粉・煙・熾火・光
    api.pump();
    fire.update(dt, t, st);

    updateFireflies(dt, t, !!st.fireflies);
    if (curScene) curScene.inst.update(dt, t, st);

    // カメラ（ドラッグで少し回せる。何もしなければごくゆっくり揺れる）
    az += (azT - az) * (1 - Math.exp(-dt * 6)); el += (elT - el) * (1 - Math.exp(-dt * 6));
    const a = az + 0.05 * Math.sin(t * 0.13) + 0.02 * Math.sin(t * 0.31), e = CAM_EL + el + 0.015 * Math.sin(t * 0.11);
    camera.position.set(Math.sin(a) * CAM_R * Math.cos(e), target.y + CAM_R * Math.sin(e), Math.cos(a) * CAM_R * Math.cos(e));
    camera.lookAt(target);
  }

  /* 描画ループ（30fps。タブ非表示 / 映像オフの間は止める） */
  let raf = 0, last = 0, active = false, winStart = 0, winFrames = 0, winWarm = true;   // 表示開始直後の最初の5秒は読み込み・シェーダー生成で遅くなるので判定しない
  function resetPerf() { winStart = 0; winFrames = 0; }
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (ts - last < FRAME_MS - 2) return;
    const gap = ts - last;
    const dt = last ? Math.min(0.05, gap / 1000) : 1 / 30;
    const hadLast = last > 0;
    last = ts;
    update(dt);
    fire.render();
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
    canvas, renderer, scene, stop() {
      stopped = true;
      setActive(false);
      unsubs.forEach((u) => { try { u(); } catch (err) {} });
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp);
      falling.forEach((d) => scene.remove(d.mesh));
      if (curScene) { try { curScene.inst.dispose(); } catch (err) {} scene.remove(curScene.root); curScene = null; }
      fire.dispose();
      disposeTree(scene);
      Object.values(gradTex).forEach((x) => x.dispose());
      if (skyTex) skyTex.dispose();
      moonTex.dispose(); logGeo.dispose(); stoneGeo.dispose();
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
