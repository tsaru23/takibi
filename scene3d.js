// 焚火 3D 表示（three.js）。index.html から、設定で 3D を選んだときだけ動的 import される。
// 状態は index.html の window.TAKIBI（opts.api）から読む。ここからは状態を書き換えない（薪をくべる addLog のみ）。
import * as THREE from 'three';

const MAX_FLAME = 420, MAX_SPARK = 200;
const FRAME_MS = 1000 / 30;          // 描画は30fpsに制限
const MAX_DPR = 1.25;             // 3D は内蔵GPUでも回るようピクセル比の上限を低めにする
const SLOW_FPS = 20, SLOW_WINDOW_MS = 5000;   // 5秒間の平均がこれを下回ったら草を減らす
const FOV = 50;

/* 季節ごとの環境色（2D の SEAS の考え方に合わせる） */
const SEASON_ENV = {
  spring: { bg: 0x180e1e, sky: 0x5a4470, grass: 0x1f3320, exposure: 1.0 },
  summer: { bg: 0x081334, sky: 0x2a4488, grass: 0x122c14, exposure: 1.0 },
  autumn: { bg: 0x22100a, sky: 0x6a3c24, grass: 0x33200f, exposure: 1.0 },
  winter: { bg: 0x15263a, sky: 0x5f86ac, grass: 0x465668, exposure: 1.0 }
};

/* 仮の草木の色 */
const PLANT_STYLE = {
  spring: { trees: [0x9ccf86, 0x88c078, 0xb5d99a], tuft: [0x7fb069, 0x6da85c, 0x92c37a], accent: 0xffa6c1, accentN: 90 },
  summer: { trees: [0x1f5a2a, 0x276b32, 0x184a22], tuft: [0x2b6b2f, 0x357a38, 0x235a28], accent: null, accentN: 0 },
  autumn: { trees: [0xc0431b, 0xe07a24, 0xa02a14, 0xd9a12e], tuft: [0x9a5a20, 0xb0702a, 0x80441a], accent: null, accentN: 0 },
  winter: { trees: [0x1a3324, 0x12281c, 0x203c2b], tuft: [0x6b7a8c, 0x5a6878, 0x7a8898], accent: 0xeef4ff, accentN: 46 }
};

const LEAF_COLORS = [0xc8471c, 0xe0842a, 0xa02c14, 0xd9a12e];
const FLAME_STOPS = [[255, 225, 140], [255, 190, 80], [255, 160, 50], [235, 100, 25], [190, 50, 15], [110, 25, 10]];

/* ---------- 小道具 ---------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const rgb = (hex) => [(hex >> 16 & 255) / 255, (hex >> 8 & 255) / 255, (hex & 255) / 255];
function flameColor(t, out, o) {
  const n = FLAME_STOPS.length - 1;
  const p = clamp(t, 0, 1) * n, a = Math.min(n - 1, Math.floor(p)), fr = p - a;
  const A = FLAME_STOPS[a], B = FLAME_STOPS[a + 1];
  out[o] = (A[0] + (B[0] - A[0]) * fr) / 255;
  out[o + 1] = (A[1] + (B[1] - A[1]) * fr) / 255;
  out[o + 2] = (A[2] + (B[2] - A[2]) * fr) / 255;
}
function radialTexture(size, stops) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d'), h = size / 2, g = x.createRadialGradient(h, h, 0, h, h, h);
  stops.forEach((s) => g.addColorStop(s[0], s[1]));
  x.fillStyle = g; x.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function mergeGeoms(parts) {
  const P = [], N = [], I = []; let off = 0;
  for (const { geo, matrix } of parts) {
    const g = geo.clone(); g.applyMatrix4(matrix);
    P.push(...g.attributes.position.array); N.push(...g.attributes.normal.array);
    const idx = g.index ? g.index.array : null;
    if (idx) for (let i = 0; i < idx.length; i++) I.push(idx[i] + off);
    off += g.attributes.position.count; g.dispose();
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  m.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  m.setIndex(I);
  return m;
}
function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.isInstancedMesh) o.dispose();
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      ms.forEach((m) => {
        for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
        m.dispose();
      });
    }
  });
}

/* ---------- 加算合成のポイントスプライト ---------- */
const VERT = `
attribute float aSize; attribute vec3 aColor; attribute float aAlpha;
uniform float uScale;
varying vec3 vColor; varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(aSize * uScale / max(0.1, -mv.z), 256.0);
  vColor = aColor; vAlpha = aAlpha;
}`;
const FRAG = `
uniform float uPow;
varying vec3 vColor; varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  gl_FragColor = vec4(vColor, vAlpha * pow(1.0 - d, uPow));
}`;
function makePoints(max, blending, pw, uScale) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(max * 3), size = new Float32Array(max), col = new Float32Array(max * 3), alp = new Float32Array(max);
  const aP = new THREE.BufferAttribute(pos, 3), aS = new THREE.BufferAttribute(size, 1), aC = new THREE.BufferAttribute(col, 3), aA = new THREE.BufferAttribute(alp, 1);
  [aP, aS, aC, aA].forEach((a) => a.setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('position', aP); geo.setAttribute('aSize', aS); geo.setAttribute('aColor', aC); geo.setAttribute('aAlpha', aA);
  geo.setDrawRange(0, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale, uPow: { value: pw } }, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, blending
  });
  const points = new THREE.Points(geo, mat); points.frustumCulled = false;
  return {
    points, geo, mat, pos, size, col, alp,
    flush(n) { geo.setDrawRange(0, n); aP.needsUpdate = aS.needsUpdate = aC.needsUpdate = aA.needsUpdate = true; }
  };
}

/* ---------- 仮の草木（プロシージャル） ---------- */
function inCameraWedge(x, z, r) {
  return r < 9 && Math.abs(Math.atan2(x, z)) < 1.0;   // カメラ手前は木で塞がない
}
function buildProcedural(season) {
  const st = PLANT_STYLE[season], rng = mulberry32(1000 + SEASON_INDEX[season] * 77);
  const group = new THREE.Group();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v3 = new THREE.Vector3(), sc = new THREE.Vector3();
  const col = new THREE.Color();

  // 木: 幹 + 3段の円錐
  const trunkGeo = new THREE.CylinderGeometry(0.08, 0.12, 0.7, 6); trunkGeo.translate(0, 0.35, 0);
  const cone = (r, h, y) => ({ geo: new THREE.ConeGeometry(r, h, 8), matrix: new THREE.Matrix4().makeTranslation(0, y, 0) });
  const foliGeo = mergeGeoms([cone(0.85, 1.6, 1.4), cone(0.62, 1.4, 2.15), cone(0.4, 1.1, 2.8)]);
  const NT = 18;
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x2c1c10 }), NT);
  const foli = new THREE.InstancedMesh(foliGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), NT);
  let nt = 0, guard = 0;
  while (nt < NT && guard++ < 500) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(4.5 * 4.5 + rng() * (13 * 13 - 4.5 * 4.5));
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (inCameraWedge(x, z, r)) continue;
    const s = 0.75 + rng() * 0.9;
    q.setFromEuler(e.set(0, rng() * 6.28, 0)); v3.set(x, 0, z); sc.set(s * (0.9 + rng() * 0.2), s, s * (0.9 + rng() * 0.2));
    m4.compose(v3, q, sc);
    trunks.setMatrixAt(nt, m4); foli.setMatrixAt(nt, m4);
    foli.setColorAt(nt, col.setHex(st.trees[Math.floor(rng() * st.trees.length)]).multiplyScalar(0.55));
    nt++;
  }
  trunks.count = foli.count = nt;
  group.add(trunks, foli);

  // 草の束: 細い円錐5本
  const blades = [];
  for (let i = 0; i < 5; i++) {
    const g = new THREE.ConeGeometry(0.03, 0.42, 4); g.translate(0, 0.21, 0);
    const mx = new THREE.Matrix4().compose(
      new THREE.Vector3((rng() - 0.5) * 0.14, 0, (rng() - 0.5) * 0.14),
      new THREE.Quaternion().setFromEuler(new THREE.Euler((rng() - 0.5) * 0.5, rng() * 6, (rng() - 0.5) * 0.5)),
      new THREE.Vector3(1, 0.7 + rng() * 0.7, 1));
    blades.push({ geo: g, matrix: mx });
  }
  const tuftGeo = mergeGeoms(blades);
  const NG = 280;
  const tufts = new THREE.InstancedMesh(tuftGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), NG);
  for (let i = 0; i < NG; i++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(1.9 * 1.9 + rng() * (15 * 15 - 1.9 * 1.9));
    const s = 0.7 + rng() * 1.1;
    q.setFromEuler(e.set(0, rng() * 6.28, 0)); v3.set(Math.sin(a) * r, 0, Math.cos(a) * r); sc.set(s, s, s);
    m4.compose(v3, q, sc); tufts.setMatrixAt(i, m4);
    tufts.setColorAt(i, col.setHex(st.tuft[Math.floor(rng() * st.tuft.length)]).multiplyScalar(0.6));
  }
  group.add(tufts);
  group.userData.tufts = tufts;

  // 春=ピンクの花、冬=縁の柔らかい雪だまり（放射状グラデーションの透明テクスチャ。遠いものは出さず、暗くする）
  if (st.accent !== null) {
    const isSnow = season === 'winter';
    let geo, mat;
    if (isSnow) {
      geo = new THREE.CircleGeometry(0.5, 20); geo.rotateX(-Math.PI / 2);
      const tex = radialTexture(128, [[0, 'rgba(255,255,255,0.8)'], [0.45, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]);
      mat = new THREE.MeshLambertMaterial({ color: 0x6f7e93, map: tex, transparent: true, depthWrite: false });
    } else {
      geo = new THREE.IcosahedronGeometry(0.055, 0);
      mat = new THREE.MeshLambertMaterial({ color: st.accent, emissive: 0x401828 });
    }
    const acc = new THREE.InstancedMesh(geo, mat, st.accentN);
    const RMAX = isSnow ? 8.5 : 14;
    for (let i = 0; i < st.accentN; i++) {
      let a = rng() * Math.PI * 2;
      const r = Math.sqrt(2.2 * 2.2 + rng() * (RMAX * RMAX - 2.2 * 2.2));
      if (isSnow && inCameraWedge(Math.sin(a) * r, Math.cos(a) * r, r)) a += Math.PI;   // カメラ手前には置かない
      const s = isSnow ? 0.45 + rng() * 0.8 : 0.8 + rng() * 0.6;
      q.setFromEuler(e.set(0, rng() * 6.28, 0));
      v3.set(Math.sin(a) * r, isSnow ? 0.02 : 0.25 + rng() * 0.15, Math.cos(a) * r);
      if (isSnow) sc.set(s, 1, s * (0.7 + rng() * 0.6)); else sc.set(s, s, s);
      m4.compose(v3, q, sc); acc.setMatrixAt(i, m4);
      if (isSnow) acc.setColorAt(i, col.setScalar(clamp(1 - 0.75 * (r - 2.2) / (RMAX - 2.2), 0.25, 1)));
    }
    group.add(acc);
  }
  return group;
}
const SEASON_INDEX = { spring: 0, summer: 1, autumn: 2, winter: 3 };

/* ---------- 本番の草木（FABOTANIC の GLB。assets/plants/manifest.json） ---------- */
let manifestPromise = null;
function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(new URL('./assets/plants/manifest.json', import.meta.url), { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  return manifestPromise;
}
function manifestEntries(manifest, season) {
  if (!manifest) return [];
  if (Array.isArray(manifest)) return manifest;
  const a = Array.isArray(manifest[season]) ? manifest[season] : [];
  const b = Array.isArray(manifest.all) ? manifest.all : [];
  return a.concat(b);
}
async function buildFromManifest(season, isStopped) {
  const entries = manifestEntries(await loadManifest(), season).filter((en) => en && en.type !== 'field' && typeof en.file === 'string');
  if (!entries.length) return null;
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  if (isStopped()) return null;
  const loader = new GLTFLoader();
  const rng = mulberry32(5000 + SEASON_INDEX[season] * 131);
  const group = new THREE.Group();
  for (const en of entries) {
    let gltf;
    try { gltf = await loader.loadAsync(new URL('./assets/plants/' + en.file, import.meta.url).href); } catch (err) { continue; }
    if (isStopped()) { disposeTree(gltf.scene); return null; }
    const count = Math.max(0, en.count | 0), rmin = Number.isFinite(en.radiusMin) ? en.radiusMin : 4, rmax = Number.isFinite(en.radiusMax) ? en.radiusMax : 12;
    const base = Number.isFinite(en.scale) ? en.scale : 1;
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rmin * rmin + rng() * Math.max(0, rmax * rmax - rmin * rmin));
      const x = Math.sin(a) * r, z = Math.cos(a) * r;
      if (inCameraWedge(x, z, r) && r > 2.5) continue;
      const o = gltf.scene.clone(true);
      o.position.set(x, 0, z); o.rotation.y = rng() * Math.PI * 2; o.scale.setScalar(base * (0.85 + rng() * 0.3));
      group.add(o);
    }
  }
  return group.children.length ? group : null;
}


/* ---------- フィールド型素材（FABOTANIC の草地ブロックを焚火の周りにリング状に複製） ---------- */
// manifest 内の { type:'field', dir, placements:'ring', count, radius, clearRadius, tint:{season:{...}} }
async function collectFieldEntries() {
  const m = await loadManifest();
  if (!m) return [];
  const all = Array.isArray(m) ? m : ['all', 'spring', 'summer', 'autumn', 'winter'].flatMap((k) => (Array.isArray(m[k]) ? m[k] : []));
  const seen = new Set();
  return all.filter((en) => en && en.type === 'field' && typeof en.dir === 'string' && !seen.has(en.dir) && seen.add(en.dir));
}
// 焚火の周りを空け（ディザで縁をぼかす）、カメラ手前の扇形は草を間引く
function patchFieldMaterial(mat, key, opt) {
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
  const thin = key !== 'soil' && key !== 'stone';
  mat.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    shader.vertexShader = 'varying vec3 vTkWp;\n' + shader.vertexShader.replace('#include <project_vertex>',
      `#include <project_vertex>
#ifdef USE_INSTANCING
  vTkWp = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
  vTkWp = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif`);
    const r0 = opt.clear.toFixed(3), r1 = (opt.clear + opt.fade).toFixed(3);
    shader.fragmentShader = 'varying vec3 vTkWp;\n' + shader.fragmentShader.replace('void main() {',
      `void main() {
  {
    float tkR = length(vTkWp.xz);
    float tkH = fract(sin(dot(floor(vTkWp.xz * 90.0 + vTkWp.y * 37.0), vec2(12.9898, 78.233))) * 43758.5453);
    if (tkR < ${r0}) discard;
    if (tkR < ${r1} && tkH > (tkR - ${r0}) / (${r1} - ${r0})) discard;
    ${thin ? `float tkA = abs(atan(vTkWp.x, vTkWp.z));
    if (tkA < 0.9 && tkR < 7.0 && tkH > 0.25 + 0.75 * smoothstep(0.35, 0.9, tkA)) discard;` : ''}
  }`);
  };
  mat.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + '|tkfield' + (thin ? 'T' : 'S'); };
  mat.needsUpdate = true;
}
async function loadField(entry, isStopped) {
  const dirURL = new URL('./assets/plants/' + entry.dir.replace(/\/*$/, '/'), import.meta.url);
  // VerdantVegetation.js は 'three' を import map 経由で読む（ページと同じ1組。二重読み込みにならない）
  const V = await import(new URL('src/VerdantVegetation.js', dirURL).href);
  if (isStopped()) return null;
  const asset = await V.loadVerdantAsset(dirURL.href, {
    windStrength: Number.isFinite(entry.windStrength) ? entry.windStrength : 0.4,
    windSpeed: Number.isFinite(entry.windSpeed) ? entry.windSpeed : 1.0,
    gust: Number.isFinite(entry.gust) ? entry.gust : 0.15
  });
  if (isStopped()) { asset.dispose(); return null; }
  const opt = { clear: Number.isFinite(entry.clearRadius) ? entry.clearRadius : 1.4, fade: 0.4 };
  const mats = new Map();     // material -> {key, base, baseEm}
  asset.root.traverse((o) => {
    if (!o.isMesh) return;
    // 風の揺れは数cmなので視錐台カリングを戻して、画面外の複製を描かない
    o.frustumCulled = true;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      if (mats.has(m)) continue;
      const key = (m.userData && m.userData.verdantMaterial) || o.userData.verdantMaterial || m.name || 'default';
      mats.set(m, { key, base: m.color.clone(), baseEm: m.emissive ? m.emissive.clone() : null, baseEi: m.emissiveIntensity });
      patchFieldMaterial(m, key, opt);
    }
    const k0 = (list[0].userData && list[0].userData.verdantMaterial) || o.userData.verdantMaterial || list[0].name;
    if (k0 === 'soil') o.visible = false;          // 四角い土は縁が見えるので描かず、地面の色を見せる
    if (o.isInstancedMesh) o.userData.tkFull = o.count;   // 草の量の切替で instance 数を増減する（読み込み直さない）
  });
  const group = new THREE.Group();
  const count = Math.max(1, (entry.count | 0) || 5), radius = Number.isFinite(entry.radius) ? entry.radius : 3.6;
  const gap = 0.75, arc = Math.PI * 2 - gap * 2;      // カメラ手前(+Z)の扇形には複製を置かない
  const rng = mulberry32(31337);
  for (let i = 0; i < count; i++) {
    const phi = gap + (i + 0.5) * (arc / count) + (rng() - 0.5) * 0.12;
    const c = asset.root.clone(true);           // ジオメトリと材質は共有
    c.position.set(Math.sin(phi) * radius, i * 0.006, Math.cos(phi) * radius);
    c.rotation.y = (i * 2.399963 + rng() * 0.8) % (Math.PI * 2);   // 黄金角ずらしで同じ見た目を並べない
    group.add(c);
  }
  return { asset, group, mats, entry };
}
// 草の量: 使う複製(slot)と instance の密度。ring の両端(手前側)から先に減らす
const DEFAULT_LEVELS = {
  many: { slots: [0, 1, 2, 3, 4], density: 0.75 },
  normal: { slots: [1, 2, 3], density: 0.6 },
  few: { slots: [1, 2, 3], density: 0.27 }
};
function applyFieldLevel(field, level) {
  if (!field) return;
  const cfg = (field.entry.levels && field.entry.levels[level]) || DEFAULT_LEVELS[level];
  field.group.visible = !!cfg;
  if (!cfg) return;
  const dens = clamp(cfg.density, 0.05, 1);
  field.group.children.forEach((c, i) => {
    c.visible = cfg.slots.indexOf(i) >= 0;
    if (!c.visible) return;
    c.traverse((o) => { if (o.isInstancedMesh && o.userData.tkFull) o.count = Math.max(1, Math.floor(o.userData.tkFull * dens)); });
  });
}
function applyFieldTint(field, season) {
  if (!field) return;
  const spec = (field.entry.tint && field.entry.tint[season]) || {};
  for (const [m, info] of field.mats) {
    let t = spec[info.key] !== undefined ? spec[info.key] : spec.default;
    m.color.copy(info.base);
    if (m.emissive && info.baseEm) { m.emissive.copy(info.baseEm); m.emissiveIntensity = info.baseEi; }
    if (t === undefined) continue;
    if (typeof t === 'string') t = { color: t };
    if (t.color) m.color.multiply(new THREE.Color(t.color));
    if (t.emissive && m.emissive) { m.emissive.set(t.emissive); m.emissiveIntensity = Number.isFinite(t.emissiveIntensity) ? t.emissiveIntensity : 0.05; }
  }
}

/* ---------- 本体 ---------- */
let ctx = null;

export function start(opts) {
  if (ctx) stop();
  const canvas = opts.canvas, api = opts.api;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' });
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = false;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x180e1e, 0.036);
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 120);
  const uScale = { value: 900 };
  const owned = [];   // dispose 対象

  /* 照明 */
  const hemi = new THREE.HemisphereLight(0x5a4470, 0x0a0806, 0.5);
  const fire = new THREE.PointLight(0xff8a3c, 0, 16, 2);
  fire.position.set(0, 0.95, 0);
  scene.add(hemi, fire);

  /* 地面 */
  const grassMat = new THREE.MeshLambertMaterial({ color: 0x1f3320 });
  const grass = new THREE.Mesh(new THREE.CircleGeometry(60, 48), grassMat);
  grass.rotation.x = -Math.PI / 2; scene.add(grass);
  const dirtTex = radialTexture(256, [[0, 'rgba(58,38,24,1)'], [0.55, 'rgba(46,30,19,0.95)'], [0.85, 'rgba(34,24,15,0.5)'], [1, 'rgba(30,20,12,0)']]);
  const dirt = new THREE.Mesh(new THREE.PlaneGeometry(11, 11), new THREE.MeshLambertMaterial({ map: dirtTex, transparent: true, depthWrite: false }));
  dirt.rotation.x = -Math.PI / 2; dirt.position.y = 0.01; scene.add(dirt);
  const ashTex = radialTexture(128, [[0, 'rgba(8,5,4,1)'], [0.7, 'rgba(12,8,6,0.85)'], [1, 'rgba(12,8,6,0)']]);
  const ash = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 2.0), new THREE.MeshBasicMaterial({ map: ashTex, transparent: true, depthWrite: false }));
  ash.rotation.x = -Math.PI / 2; ash.position.y = 0.02; scene.add(ash);

  /* 石囲い */
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x36322d, roughness: 0.95, flatShading: true });
  const stoneGeo = new THREE.IcosahedronGeometry(0.24, 0);
  const srng = mulberry32(77);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + srng() * 0.1, r = 1.0 + srng() * 0.08;
    const s = new THREE.Mesh(stoneGeo, stoneMat);
    s.position.set(Math.cos(a) * r, 0.1, Math.sin(a) * r);
    s.scale.set(1 + srng() * 0.4, 0.62 + srng() * 0.2, 1.1 + srng() * 0.4);
    s.rotation.set(srng() * 3, srng() * 6, srng() * 3);
    scene.add(s);
  }

  /* 薪: 燃料の量に応じて本数が変わる（2Dと同じ考え方）。円錐状に立てかける */
  const logGeo = new THREE.CylinderGeometry(0.085, 0.075, 1, 8);
  const LOG_ORDER = [0, 4, 2, 6, 1, 5, 3, 7];
  const logs = [];
  for (let i = 0; i < 8; i++) {
    const slot = LOG_ORDER[i];
    const a = slot * (Math.PI / 4) + (slot % 2) * 0.12;
    const R0 = 0.5 + (slot % 2) * 0.12, th = 0.52 + (slot % 2) * 0.14, len = 1.0 - (slot % 2) * 0.16;
    const dir = new THREE.Vector3(-Math.cos(a) * Math.sin(th), Math.cos(th), -Math.sin(a) * Math.sin(th));
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a2f1c, roughness: 0.92, emissive: 0x000000 });
    const m = new THREE.Mesh(logGeo, mat);
    m.scale.y = len;
    m.position.set(Math.cos(a) * R0, 0.1, Math.sin(a) * R0).addScaledVector(dir, len / 2);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    m.userData.seed = i;
    scene.add(m); logs.push(m);
  }
  const dropMat = new THREE.MeshStandardMaterial({ color: 0x4a2f1c, roughness: 0.92 });
  const falling = [];    // 落下中の薪 {mesh, t0, landAt, dx, ang}

  /* 炎・火の粉・熾火 */
  const flamePts = makePoints(MAX_FLAME, THREE.AdditiveBlending, 1.6, uScale);
  const sparkPts = makePoints(MAX_SPARK, THREE.AdditiveBlending, 0.8, uScale);
  const emberPts = makePoints(9, THREE.AdditiveBlending, 1.4, uScale);
  scene.add(flamePts.points, sparkPts.points, emberPts.points);
  const flames = [], sparks = [];
  const EMBER_POS = [];
  for (let m = 0; m < 9; m++) EMBER_POS.push([Math.sin(m * 2.3 + 1) * 0.75, 0.08 + 0.05 * ((m * 5) % 4), Math.cos(m * 2.3 + 1) * 0.75]);
  const glowTex = radialTexture(128, [[0, 'rgba(255,190,110,1)'], [0.35, 'rgba(255,130,50,0.45)'], [1, 'rgba(255,90,20,0)']]);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, opacity: 0 }));
  glow.position.set(0, 0.85, 0); scene.add(glow);

  /* 星 */
  {
    const n = 160, p = new Float32Array(n * 3), r = mulberry32(9);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, el = 0.15 + r() * 1.2, R = 90;
      p[i * 3] = Math.cos(a) * Math.cos(el) * R; p[i * 3 + 1] = Math.sin(el) * R; p[i * 3 + 2] = Math.sin(a) * Math.cos(el) * R;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xcfd8ff, size: 1.6 * dpr, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.55, depthWrite: false }));
    stars.frustumCulled = false; scene.add(stars);
  }

  /* 季節の舞うもの */
  const driftPts = makePoints(340, THREE.NormalBlending, 1.0, uScale);
  driftPts.points.visible = false; scene.add(driftPts.points);
  let drift = [], driftKey = '';
  function initDrift(season, on) {
    drift = []; driftKey = season + (on ? '1' : '0');
    driftPts.points.visible = on;
    if (!on) { driftPts.flush(0); return; }
    driftPts.mat.blending = season === 'summer' ? THREE.AdditiveBlending : THREE.NormalBlending;
    driftPts.mat.uniforms.uPow.value = season === 'summer' ? 1.4 : 0.6;
    driftPts.mat.needsUpdate = true;
    const N = { spring: 170, summer: 60, autumn: 130, winter: 330 }[season];
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 9;
      drift.push({
        x: Math.cos(a) * r, z: Math.sin(a) * r,
        y: season === 'summer' ? rnd(0.4, 3.2) : rnd(0, 6.5),
        vy: rnd(0.35, 0.8), ph: rnd(0, 20), a: rnd(0, 6.28), f: rnd(0.6, 1.6), sz: rnd(0.7, 1.3),
        c: Math.floor(Math.random() * 4)
      });
    }
  }
  function updateDrift(season, dt, t) {
    const P = driftPts, n = drift.length;
    for (let i = 0; i < n; i++) {
      const d = drift[i], o = i * 3;
      let size = 0.06, alpha = 0.85, c;
      if (season === 'summer') {
        d.a += (Math.random() - 0.5) * 2 * dt;
        const sp = 0.25 + 0.2 * d.sz;
        d.x += Math.cos(d.a) * sp * dt; d.z += Math.sin(d.a) * sp * dt; d.y += (Math.sin(d.a * 1.3) * sp * 0.5) * dt;
        if (d.x * d.x + d.z * d.z > 100) d.a += Math.PI;
        if (d.y < 0.4 || d.y > 3.4) d.a = -d.a, d.y = clamp(d.y, 0.4, 3.4);
        let b = Math.max(0, Math.sin(t * d.f + d.ph)); b *= b;
        alpha = b * 0.95; size = 0.16 * d.sz; c = rgb(0xd2ff8a);
      } else {
        d.y -= d.vy * dt * (season === 'winter' ? 0.55 : season === 'autumn' ? 1.0 : 0.75);
        const sway = season === 'autumn' ? 0.7 : season === 'winter' ? 0.25 : 0.5;
        d.x += Math.sin(t * 1.1 + d.ph) * sway * dt; d.z += Math.cos(t * 0.9 + d.ph) * sway * dt;
        if (d.y < 0) { d.y = 6.5; const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 9; d.x = Math.cos(a) * r; d.z = Math.sin(a) * r; }
        if (season === 'spring') { size = 0.1 * d.sz; c = rgb(0xffbad0); alpha = 0.85; }
        else if (season === 'autumn') { size = 0.13 * d.sz; c = rgb(LEAF_COLORS[d.c]); alpha = 0.9; }
        else { size = 0.055 * d.sz; c = rgb(0xe8f2ff); alpha = 0.8; }
      }
      P.pos[o] = d.x; P.pos[o + 1] = d.y; P.pos[o + 2] = d.z;
      P.size[i] = size; P.alp[i] = alpha; P.col[o] = c[0]; P.col[o + 1] = c[1]; P.col[o + 2] = c[2];
    }
    P.flush(n);
  }

  /* 草木 */
  const plants = {};         // season -> {group, real}
  let stopped = false, fieldObj = null, fieldLoading = false, grassLevel = '';
  const isStopped = () => stopped;
  function ensurePlants(season) {
    if (plants[season]) return;
    const proc = buildProcedural(season);
    plants[season] = { group: proc, real: false };
    scene.add(proc);
    buildFromManifest(season, isStopped).then((real) => {
      if (!real || stopped) { if (real) disposeTree(real); return; }
      const cur = plants[season];
      scene.remove(cur.group); disposeTree(cur.group);
      cur.group = real; cur.real = true; real.visible = (curSeason === season);
      scene.add(real);
    }).catch((err) => console.warn('[takibi] plants manifest:', err));
  }

  // フィールド型素材: 草の量が「なし」以外になったとき1回だけ読み込む（以後は instance 数と表示だけ切り替える）
  function ensureField(level) {
    if (level === 'none') { if (fieldObj) fieldObj.group.visible = false; return; }
    if (fieldObj) { applyFieldLevel(fieldObj, level); return; }
    if (fieldLoading) return;
    fieldLoading = true;
    collectFieldEntries().then((list) => (list.length ? loadField(list[0], isStopped) : null)).then((f) => {
      if (!f) return;
      if (stopped) { f.asset.dispose(); return; }
      fieldObj = f;
      scene.add(f.group);
      applyFieldLevel(f, grassLevel === 'none' ? 'many' : grassLevel);
      f.group.visible = grassLevel !== 'none';
      applyFieldTint(f, curSeason);
    }).catch((err) => console.warn('[takibi] field asset:', err));
  }

  /* カメラ */
  const target = new THREE.Vector3(0, 0.85, 0);
  let azT = 0, az = 0, elT = 0, el = 0;
  const CAM_R = 7.2, CAM_EL = 0.46;

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

  /* リサイズ */
  function resize() {
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // 縦長画面では画角を広げて焚火が収まるようにする
    camera.fov = w / h < 1 ? Math.min(75, FOV / Math.max(0.55, w / h)) : FOV;
    camera.updateProjectionMatrix();
    uScale.value = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }
  window.addEventListener('resize', resize);
  resize();

  /* 購読 */
  let sparkAcc = 0, flameAcc = 0, curSeason = '', envKey = '';
  const emitSparks = (n) => {
    const f = Math.min(1.2, api.getState().flame);
    for (let i = 0; i < n && sparks.length < MAX_SPARK; i++) {
      sparks.push({ x: gauss() * 0.18, y: 0.45, z: gauss() * 0.18, vx: gauss() * 0.3, vz: gauss() * 0.3, vy: rnd(0.45, 1.6) * (0.6 + 0.6 * f), life: rnd(0.8, 2.0), age: 0, size: rnd(0.035, 0.075) });
    }
  };
  const unsubs = [
    api.onCrackle((ev) => emitSparks(ev.n)),
    api.onLogAdded((ev) => {
      if (ev.type === 'drop') {
        const mesh = new THREE.Mesh(logGeo, dropMat); mesh.scale.y = 0.95; scene.add(mesh);
        falling.push({ mesh, t0: ev.t0, landAt: ev.landAt, dx: ev.dx * 1.6, ang: ev.ang });
      } else if (ev.type === 'land') {
        for (let i = 0; i < 26 && sparks.length < MAX_SPARK; i++) {
          sparks.push({ x: ev.dx * 1.6 + gauss() * 0.2, y: 0.4, z: gauss() * 0.2, vx: gauss() * 0.6, vz: gauss() * 0.6, vy: rnd(0.7, 2.3), life: rnd(0.9, 2.2), age: 0, size: rnd(0.04, 0.09) });
        }
      }
    }),
    api.onActiveChange((on) => setActive(on))
  ];

  /* 毎フレームの更新 */
  const tmpC = new THREE.Color();
  let elapsed = 0;
  function update(dt) {
    const st = api.getState(), now = performance.now();
    elapsed += dt;
    const t = elapsed;
    const f = Math.min(1.25, st.flame), em = st.ember;
    const flick = 0.92 + 0.08 * Math.sin(t * 9) * Math.sin(t * 3.1 + 1) + 0.03 * Math.sin(t * 23) + 0.02 * (Math.random() - 0.5);

    // 草の量
    const gl = st.grass || 'normal';
    if (gl !== grassLevel) { grassLevel = gl; ensureField(gl); }
    // 仮の草の束は、フィールドが無い（未読込・読込失敗）ときだけ、かつ草の量が「なし」以外のときだけ出す
    const tuftsOn = gl !== 'none' && !fieldObj;
    for (const k in plants) { const tf = plants[k].group.userData && plants[k].group.userData.tufts; if (tf) tf.visible = tuftsOn; }

    // 季節
    if (st.season !== curSeason) {
      curSeason = st.season; ensurePlants(curSeason);
      for (const k in plants) plants[k].group.visible = (k === curSeason);
      applyFieldTint(fieldObj, curSeason);
    }
    const env = SEASON_ENV[curSeason];
    const ek = curSeason;
    if (ek !== envKey) {
      envKey = ek;
      scene.background = new THREE.Color(env.bg); scene.fog.color.setHex(env.bg);
      hemi.color.setHex(env.sky); grassMat.color.setHex(env.grass);
    }
    if (driftKey !== curSeason + (st.seasonFx ? '1' : '0')) initDrift(curSeason, st.seasonFx);
    renderer.toneMappingExposure = 1.05 * st.brightness;

    // 薪
    const shown = st.started ? Math.min(st.maxFuel, Math.max(1, Math.ceil(st.fuel - 0.02))) : 1;
    const heat = st.started ? Math.min(1, f * 0.9 + em * (0.5 + 0.3 * Math.sin(t * 1.5))) : 0;
    for (let i = 0; i < logs.length; i++) {
      const m = logs[i];
      m.visible = i < shown;
      const h = heat * (0.6 + 0.4 * ((i * 37) % 10) / 10);
      m.material.emissive.setRGB(1.0 * h, 0.32 * h, 0.06 * h);
      m.material.emissiveIntensity = 0.55;
    }
    for (let i = falling.length - 1; i >= 0; i--) {
      const d = falling[i], p = clamp((now - d.t0) / (d.landAt - d.t0), 0, 1), e2 = p * p;
      d.mesh.position.set(d.dx * (1 - e2 * 0.6), 3.4 + (0.6 - 3.4) * e2, 0);
      d.mesh.rotation.set(0, 0, Math.PI / 2 + d.ang * (1 - 0.6 * e2));
      if (now >= d.landAt + 40) { scene.remove(d.mesh); falling.splice(i, 1); }
    }

    // 光
    fire.intensity = (38 * f + 4 * em) * flick;
    fire.position.set(0.04 * Math.sin(t * 5.3), 0.95 + 0.06 * f + 0.03 * Math.sin(t * 7.1), 0.04 * Math.cos(t * 4.1));
    tmpC.setRGB(1, 0.5 + 0.12 * Math.min(1, f) * (0.5 + 0.5 * Math.sin(t * 3)), 0.2);
    fire.color.copy(tmpC);
    glow.material.opacity = (0.33 * Math.min(1, f) + 0.05 * em) * flick;
    glow.scale.setScalar(1.6 + 1.6 * Math.min(1.2, f));
    glow.position.y = 0.75 + 0.35 * f;

    // 炎パーティクル
    if (st.started && f > 0.03) { flameAcc += 280 * f * dt; const nn = Math.floor(flameAcc); flameAcc -= nn; spawnFlame(nn, f); }
    let n = 0, o;
    const F = flamePts;
    for (let i = flames.length - 1; i >= 0; i--) {
      const q = flames[i]; q.age += dt;
      const tt = q.age / q.life;
      if (tt >= 1) { flames[i] = flames[flames.length - 1]; flames.pop(); continue; }
      q.x += (q.vx + Math.sin(q.age * 7 + q.seed) * 0.1 - q.x * 1.0) * dt;
      q.z += (q.vz + Math.cos(q.age * 6 + q.seed) * 0.1 - q.z * 1.0) * dt;
      q.y += q.vy * dt; q.vy *= (1 - 0.5 * dt);
    }
    for (let i = 0; i < flames.length; i++) {
      const q = flames[i], tt = q.age / q.life; o = n * 3;
      F.pos[o] = q.x; F.pos[o + 1] = q.y; F.pos[o + 2] = q.z;
      F.size[n] = q.size * (1 - tt * 0.75) * 2;
      F.alp[n] = Math.min(1, (1 - tt) * 0.4 * Math.min(1, tt * 8 + 0.2));
      flameColor(tt, F.col, o);
      n++;
    }
    F.flush(n);

    // 火の粉
    api.pump();
    if (st.started && f > 0.05) { sparkAcc += (2 + 8 * f) * dt; const sn = Math.floor(sparkAcc); sparkAcc -= sn; emitSparks(sn); }
    n = 0;
    const S = sparkPts;
    for (let j = sparks.length - 1; j >= 0; j--) {
      const sp = sparks[j]; sp.age += dt;
      const s = sp.age / sp.life;
      if (s >= 1) { sparks[j] = sparks[sparks.length - 1]; sparks.pop(); continue; }
      sp.vx += Math.sin(sp.age * 5 + j) * 0.25 * dt; sp.vz += Math.cos(sp.age * 4 + j) * 0.25 * dt;
      sp.vx *= (1 - 0.6 * dt); sp.vz *= (1 - 0.6 * dt);
      sp.vy = sp.vy * (1 - 0.7 * dt) + 0.09 * dt;
      sp.x += sp.vx * dt; sp.y += sp.vy * dt; sp.z += sp.vz * dt;
    }
    for (let j = 0; j < sparks.length; j++) {
      const sp = sparks[j], s = sp.age / sp.life; o = n * 3;
      S.pos[o] = sp.x; S.pos[o + 1] = sp.y; S.pos[o + 2] = sp.z;
      S.size[n] = sp.size * 2 * (1 - s * 0.6);
      S.alp[n] = (1 - s) * (0.6 + 0.4 * Math.sin(sp.age * 30 + j * 3));
      flameColor(0.05 + 0.4 * s, S.col, o);
      n++;
    }
    S.flush(n);

    // 熾火
    const E = emberPts;
    if (em > 0.02) {
      for (let m = 0; m < 9; m++) {
        const ep = EMBER_POS[m], pulse = 0.55 + 0.45 * Math.sin(t * (0.8 + m * 0.17) + m);
        E.pos[m * 3] = ep[0]; E.pos[m * 3 + 1] = ep[1]; E.pos[m * 3 + 2] = ep[2];
        E.size[m] = 0.2 + 0.07 * (m % 3); E.alp[m] = em * pulse * 0.8;
        flameColor(0.7, E.col, m * 3);
      }
      E.flush(9);
    } else E.flush(0);

    // 季節の舞うもの
    if (st.seasonFx) updateDrift(curSeason, dt, t);

    if (fieldObj) fieldObj.asset.update(dt, t, camera);

    // カメラ（ドラッグで少し回せる。何もしなければごくゆっくり揺れる）
    az += (azT - az) * (1 - Math.exp(-dt * 6)); el += (elT - el) * (1 - Math.exp(-dt * 6));
    const a = az + 0.05 * Math.sin(t * 0.13) + 0.02 * Math.sin(t * 0.31), e = CAM_EL + el + 0.015 * Math.sin(t * 0.11);
    camera.position.set(Math.sin(a) * CAM_R * Math.cos(e), target.y + CAM_R * Math.sin(e), Math.cos(a) * CAM_R * Math.cos(e));
    camera.lookAt(target);
  }
  function spawnFlame(n, f) {
    for (let i = 0; i < n && flames.length < MAX_FLAME; i++) {
      flames.push({
        x: gauss() * (0.16 + 0.24 * f), z: gauss() * (0.16 + 0.24 * f), y: 0.3 + rnd(0, 0.15),
        vx: gauss() * 0.06, vz: gauss() * 0.06, vy: (1.25 + 1.3 * f) * rnd(0.7, 1.3),
        size: (0.3 + 0.17 * f) * rnd(0.6, 1.3), life: rnd(0.55, 1.25) * (0.7 + 0.5 * f), age: 0, seed: Math.random() * 10
      });
    }
  }

  /* 描画ループ（30fps。タブ非表示 / 映像オフの間は止める） */
  let raf = 0, last = 0, active = false, winStart = 0, winFrames = 0, winWarm = true;   // 表示開始直後の最初の5秒は読み込み・シェーダー生成で遅くなるので判定しない
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (ts - last < FRAME_MS - 2) return;
    const dt = last ? Math.min(0.05, (ts - last) / 1000) : 1 / 30;
    last = ts;
    update(dt);
    renderer.render(scene, camera);
    // 映像が見えている間の実フレーム間隔を計り、遅ければ草を減らしてもらう
    if (!winStart) { winStart = ts; winFrames = 0; }
    else {
      winFrames++;
      if (ts - winStart >= SLOW_WINDOW_MS) {
        const fps = winFrames * 1000 / (ts - winStart);
        winStart = 0;
        if (winWarm) winWarm = false;
        else if (fps < SLOW_FPS && api.reportSlow) api.reportSlow(fps);
      }
    }
  }
  function setActive(on) {
    on = !!on;
    if (on === active) return;
    active = on;
    winStart = 0; winWarm = true;
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
      if (fieldObj) { scene.remove(fieldObj.group); fieldObj.asset.dispose(); fieldObj = null; }
      disposeTree(scene);
      dirtTex.dispose(); ashTex.dispose(); glowTex.dispose(); logGeo.dispose();
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
