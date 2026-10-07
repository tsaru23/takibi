// シーン「季節の木」（森）。仮の円錐の木、FABOTANIC の草地フィールド、季節ごとの舞うもの（花びら・落ち葉・雪）、雪だまり。
// 形式は scenes/index.js のコメントを参照。
import * as THREE from 'three';
import { mulberry32, rnd, clamp, rgb, radialTexture, mergeGeoms, disposeTree, makePoints, inCameraWedge, HILLS, hillGround } from './util.js';
import { makeSnowPoints } from './snow.js';
import { loadFarTrees } from './farTrees.js';

const SEASON_INDEX = { spring: 0, summer: 1, autumn: 2, winter: 3 };
const ROOT = new URL('../', import.meta.url);   // サイトのルート

/* 仮の草木の色 */
const PLANT_STYLE = {
  spring: { trees: [0x9ccf86, 0x88c078, 0xb5d99a], tuft: [0x7fb069, 0x6da85c, 0x92c37a], accent: 0xffa6c1, accentN: 90 },
  summer: { trees: [0x1f5a2a, 0x276b32, 0x184a22], tuft: [0x2b6b2f, 0x357a38, 0x235a28], accent: null, accentN: 0 },
  autumn: { trees: [0xc0431b, 0xe07a24, 0xa02a14, 0xd9a12e], tuft: [0x9a5a20, 0xb0702a, 0x80441a], accent: null, accentN: 0 },
  winter: { trees: [0x1a3324, 0x12281c, 0x203c2b], tuft: [0x6b7a8c, 0x5a6878, 0x7a8898], accent: 0xeef4ff, accentN: 46 }
};

const LEAF_COLORS = [0xc8471c, 0xe0842a, 0xa02c14, 0xd9a12e];

/* 葉・花びらの形（コードで生成した白いシルエット。色は instance 色で付ける） */
function leafTexture(kind) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.strokeStyle = '#fff'; x.lineCap = 'round';
  if (kind === 'petal') {
    x.beginPath(); x.moveTo(32, 58); x.bezierCurveTo(4, 42, 8, 10, 26, 6); x.lineTo(32, 15); x.lineTo(38, 6);
    x.bezierCurveTo(56, 10, 60, 42, 32, 58); x.fill();
  } else {
    x.beginPath();
    for (let i = 0; i <= 90; i++) {
      const th = i / 90 * Math.PI * 2, r = 29 * (0.34 + 0.66 * Math.pow(Math.abs(Math.cos(2.5 * (th - Math.PI / 2))), 1.6));
      const px = 32 + Math.cos(th) * r, py = 30 - Math.sin(th) * r;
      if (i) x.lineTo(px, py); else x.moveTo(px, py);
    }
    x.closePath(); x.fill();
    x.lineWidth = 3; x.beginPath(); x.moveTo(32, 30); x.lineTo(32, 62); x.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------- 仮の草木（プロシージャル） ---------- */
function buildProcedural(season, noTrees) {
  const st = PLANT_STYLE[season], rng = mulberry32(1000 + SEASON_INDEX[season] * 77);
  const group = new THREE.Group();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v3 = new THREE.Vector3(), sc = new THREE.Vector3();
  const col = new THREE.Color();

  // 木: 幹 + 3段の円錐
  const trunkGeo = new THREE.CylinderGeometry(0.08, 0.12, 0.7, 6); trunkGeo.translate(0, 0.35, 0);
  const cone = (r, h, y) => ({ geo: new THREE.ConeGeometry(r, h, 8), matrix: new THREE.Matrix4().makeTranslation(0, y, 0) });
  const foliGeo = mergeGeoms([cone(0.85, 1.6, 1.4), cone(0.62, 1.4, 2.15), cone(0.4, 1.1, 2.8)]);
  const NT = noTrees ? 0 : 100, NNEAR = 30;
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x2c1c10 }), Math.max(1, NT));
  const foli = new THREE.InstancedMesh(foliGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(1, NT));
  let nt = 0, guard = 0;
  while (nt < NT && guard++ < 500) {
    const far = nt >= NNEAR;   // 手前30本は12〜26m、残りは遠景の稜線の上
    const a = rng() * Math.PI * 2, r = far ? 27 + rng() * 7 : Math.sqrt(12 * 12 + rng() * (26 * 26 - 12 * 12));
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!far && r < 16 && Math.abs(Math.atan2(x, z)) < 1.0) continue;
    const s = far ? 1.3 + rng() * 1.1 : 0.7 + rng() * 0.7;
    q.setFromEuler(e.set(0, rng() * 6.28, 0)); v3.set(x, hillGround(HILLS[0], r, Math.atan2(z, x)) - 0.1, z); sc.set(s * (0.9 + rng() * 0.2), s, s * (0.9 + rng() * 0.2));
    m4.compose(v3, q, sc);
    trunks.setMatrixAt(nt, m4); foli.setMatrixAt(nt, m4);
    foli.setColorAt(nt, col.setHex(st.trees[Math.floor(rng() * st.trees.length)]).multiplyScalar(0.55));
    nt++;
  }
  trunks.count = foli.count = nt;
  group.add(trunks, foli);
  group.userData.trees = [trunks, foli];

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
  // 手前の地面に落ち葉（秋）・花びら（春）
  if (season === 'autumn' || season === 'spring') {
    const NL = 90, lg = new THREE.PlaneGeometry(0.16, 0.16); lg.rotateX(-Math.PI / 2);
    const leaves = new THREE.InstancedMesh(lg, new THREE.MeshLambertMaterial({ map: leafTexture(season === 'autumn' ? 'maple' : 'petal'), alphaTest: 0.5, side: THREE.DoubleSide }), NL);
    const cs = season === 'autumn' ? LEAF_COLORS : [0xffb6cc, 0xffc9d8, 0xf5a3bd];
    for (let i = 0; i < NL; i++) {
      const a = rng() * Math.PI * 2, r = 1.5 + Math.sqrt(rng()) * 3.2;
      q.setFromEuler(e.set((rng() - 0.5) * 0.3, rng() * 6.28, (rng() - 0.5) * 0.3));
      m4.compose(v3.set(Math.sin(a) * r, 0.015, Math.cos(a) * r), q, sc.setScalar(0.7 + rng() * 0.8));
      leaves.setMatrixAt(i, m4);
      leaves.setColorAt(i, col.setHex(cs[Math.floor(rng() * cs.length)]).multiplyScalar(0.7));
    }
    group.add(leaves);
  }
  return group;
}

/* ---------- 本番の草木（FABOTANIC の GLB。assets/plants/manifest.json） ---------- */
let manifestPromise = null;
function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(new URL('assets/plants/manifest.json', ROOT), { cache: 'no-cache' })
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
    try { gltf = await loader.loadAsync(new URL('assets/plants/' + en.file, ROOT).href); } catch (err) { continue; }
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
export async function collectFieldEntries() {
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
export async function loadField(entry, isStopped) {
  const dirURL = new URL('assets/plants/' + entry.dir.replace(/\/*$/, '/'), ROOT);
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
// levels: シーンごとの上書き（省略可。manifest の levels より優先）。家など別の物で三角形を使うシーンが、草を絞るのに使う
export function applyFieldLevel(field, level, levels) {
  if (!field) return;
  const cfg = (levels && levels[level]) || (field.entry.levels && field.entry.levels[level]) || DEFAULT_LEVELS[level];
  field.group.visible = !!cfg;
  if (!cfg) return;
  const dens = clamp(cfg.density, 0.05, 1);
  field.group.children.forEach((c, i) => {
    c.visible = cfg.slots.indexOf(i) >= 0;
    if (!c.visible) return;
    c.traverse((o) => { if (o.isInstancedMesh && o.userData.tkFull) o.count = Math.max(1, Math.floor(o.userData.tkFull * dens)); });
  });
}
export function applyFieldTint(field, season) {
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

/* ---------- シーン本体 ---------- */
export default {
  id: 'forest',
  label: '季節の木',
  audio: { autoOn: [], reverb: null },

  build(ctx) {
    const { scene, root, uScale } = ctx;
    let disposed = false;
    const isStopped = () => disposed || ctx.isStopped();
    let curSeason = '', grassLevel = '', fieldObj = null, fieldLoading = false;
    const plants = {};   // season -> {group, real}
    let far = null;      // 遠景の木（FABOTANIC）。読めたら仮の円錐の木と入れ替える

    /* 季節の舞うもの: 春は花びら、秋は落ち葉（形のテクスチャを貼った板が、ひらひら回りながら落ちる。通常の半透明合成で、焚火の光を受ける）。冬は雪の点。蛍は共通のホタルに統合したので、夏は何も出さない */
    const NDR = 150;
    function mkDriftMesh(kind, size) {
      const mat = new THREE.MeshLambertMaterial({
        map: leafTexture(kind), transparent: true, alphaTest: 0.04, side: THREE.DoubleSide, depthWrite: false,
        emissive: kind === 'petal' ? 0x2a1520 : 0x241208
      });
      const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(size, size), mat, NDR);
      im.frustumCulled = false; im.visible = false; root.add(im);
      return im;
    }
    const driftMesh = { spring: mkDriftMesh('petal', 0.11), autumn: mkDriftMesh('maple', 0.19) };
    const driftPts = makeSnowPoints(900, uScale);   // 雪
    driftPts.points.visible = false; root.add(driftPts.points);
    let drift = [], driftKey = '';
    const dm4 = new THREE.Matrix4(), dq = new THREE.Quaternion(), de = new THREE.Euler(), dp = new THREE.Vector3(), ds = new THREE.Vector3(), dc = new THREE.Color();
    function initDrift(season, on) {
      drift = []; driftKey = season + (on ? '1' : '0');
      const N = { spring: 130, summer: 0, autumn: 110, winter: 620 }[season];
      driftPts.points.visible = on && season === 'winter';
      for (const k in driftMesh) driftMesh[k].visible = on && k === season;
      if (!on || !N) { driftPts.flush(0); return; }
      const cs = season === 'autumn' ? LEAF_COLORS : [0xffc4d6, 0xffd6e2, 0xf7b0c8];
      for (let i = 0; i < N; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * (season === 'winter' ? 12 : 8);
        drift.push({
          x: Math.cos(a) * r, z: Math.sin(a) * r, y: rnd(0, 6),
          vy: rnd(0.3, 0.7), ph: rnd(0, 20), sz: rnd(0.75, 1.3), c: Math.floor(Math.random() * 4),
          f1: rnd(1.2, 2.6), f2: rnd(1.0, 2.2), spin: rnd(-2.2, 2.2), tilt: rnd(0.5, 1.1)
        });
        if (season !== 'winter') driftMesh[season].setColorAt(i, dc.setHex(cs[i % cs.length]));
      }
      if (season !== 'winter') { driftMesh[season].count = N; driftMesh[season].instanceColor.needsUpdate = true; }
    }
    function updateDrift(season, dt, t) {
      const n = drift.length;
      if (season === 'winter') {
        const P = driftPts;
        for (let i = 0; i < n; i++) {
          const d = drift[i], o = i * 3;
          d.y -= d.vy * dt * 0.5;
          d.x += Math.sin(t * 1.1 + d.ph) * 0.22 * dt; d.z += Math.cos(t * 0.9 + d.ph) * 0.22 * dt;
          if (d.y < 0) { d.y = 6.5; const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 12; d.x = Math.cos(a) * r; d.z = Math.sin(a) * r; }
          P.pos[o] = d.x; P.pos[o + 1] = d.y; P.pos[o + 2] = d.z;
          P.size[i] = 0.032 * d.sz * d.sz; P.alp[i] = 0.92; P.col[o] = 0.93; P.col[o + 1] = 0.96; P.col[o + 2] = 1;
        }
        P.flush(n);
        return;
      }
      const im = driftMesh[season];
      if (!im) return;
      for (let i = 0; i < n; i++) {
        const d = drift[i];
        d.y -= d.vy * dt * (season === 'autumn' ? 1.0 : 0.75);
        const sway = season === 'autumn' ? 0.7 : 0.5;
        d.x += Math.sin(t * 1.1 + d.ph) * sway * dt; d.z += Math.cos(t * 0.9 + d.ph) * sway * dt;
        if (d.y < 0.03) { d.y = 6; const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 8; d.x = Math.cos(a) * r; d.z = Math.sin(a) * r; }
        // ひらひら: 左右に傾きながら回る
        de.set(Math.sin(t * d.f1 + d.ph) * d.tilt + Math.PI / 2 * 0, t * d.spin + d.ph, Math.cos(t * d.f2 + d.ph) * d.tilt);
        dq.setFromEuler(de);
        dm4.compose(dp.set(d.x, d.y, d.z), dq, ds.setScalar(d.sz));
        im.setMatrixAt(i, dm4);
      }
      im.instanceMatrix.needsUpdate = true;
    }

    function ensurePlants(season) {
      if (plants[season]) return;
      const proc = buildProcedural(season, !!far);
      plants[season] = { group: proc, real: false };
      root.add(proc);
      proc.visible = curSeason === season;
      buildFromManifest(season, isStopped).then((real) => {
        if (!real || isStopped()) { if (real) disposeTree(real); return; }
        const cur = plants[season];
        root.remove(cur.group); disposeTree(cur.group);
        cur.group = real; cur.real = true; real.visible = (curSeason === season);
        root.add(real);
      }).catch((err) => console.warn('[takibi] plants manifest:', err));
    }

    /* 遠景の木: 手前の輪（16〜28m）と遠景の稜線の上。カメラ手前の扇形は空ける */
    (function loadFar() {
      const rng = mulberry32(4242), pts = [];
      let guard = 0;
      while (pts.length < 150 && guard++ < 3000) {
        const ridge = pts.length >= 55;
        const a = rng() * Math.PI * 2, r = ridge ? 26 + rng() * 9 : Math.sqrt(16 * 16 + rng() * (28 * 28 - 16 * 16));
        const x = Math.sin(a) * r, z = Math.cos(a) * r;
        if (!ridge && r < 21 && Math.abs(Math.atan2(x, z)) < 1.0) continue;
        pts.push({ x, z, y: hillGround(HILLS[0], r, Math.atan2(z, x)) - 0.1, h: ridge ? 9 + rng() * 5 : 6 + rng() * 4 });
      }
      loadFarTrees(ctx, pts, { seed: 11 }).then((h) => {
        if (!h || isStopped()) { if (h) h.dispose(); return; }
        far = h; root.add(h.group);
        if (curSeason) h.setSeason(curSeason);
        for (const k in plants) { const t = plants[k].group.userData.trees; if (t) { t.forEach((m) => { plants[k].group.remove(m); disposeTree(m); }); plants[k].group.userData.trees = null; } }
      }).catch((err) => console.warn('[takibi] far trees:', err));
    })();

    // フィールド型素材: 草の量が「なし」以外になったとき1回だけ読み込む
    function ensureField(level) {
      if (level === 'none') { if (fieldObj) fieldObj.group.visible = false; return; }
      if (fieldObj) { applyFieldLevel(fieldObj, level); return; }
      if (fieldLoading) return;
      fieldLoading = true;
      collectFieldEntries().then((list) => (list.length ? loadField(list[0], isStopped) : null)).then((f) => {
        if (!f) return;
        if (isStopped()) { f.asset.dispose(); return; }
        fieldObj = f;
        root.add(f.group);
        applyFieldLevel(f, grassLevel === 'none' ? 'many' : grassLevel);
        f.group.visible = grassLevel !== 'none';
        applyFieldTint(f, curSeason);
      }).catch((err) => console.warn('[takibi] field asset:', err));
    }

    let seasonFx = true;
    return {
      setSeason(season) {
        curSeason = season; ensurePlants(season); if (far) far.setSeason(season);
        for (const k in plants) plants[k].group.visible = (k === season);
        applyFieldTint(fieldObj, season);
        driftKey = '';
      },
      update(dt, t, st) {
        const gl = st.grass || 'normal';
        if (gl !== grassLevel) { grassLevel = gl; ensureField(gl); }
        // 仮の草の束は、フィールドが無い（未読込・読込失敗）ときだけ、かつ草の量が「なし」以外のときだけ出す
        const tuftsOn = gl !== 'none' && !fieldObj;
        for (const k in plants) { const tf = plants[k].group.userData && plants[k].group.userData.tufts; if (tf) tf.visible = tuftsOn; }
        seasonFx = st.seasonFx;
        if (driftKey !== curSeason + (seasonFx ? '1' : '0')) initDrift(curSeason, seasonFx);
        if (seasonFx && drift.length) updateDrift(curSeason, dt, t);
        if (fieldObj) fieldObj.asset.update(dt, t, ctx.camera);
      },
      dispose() {
        disposed = true;
        if (far) { far.dispose(); far = null; }
        if (fieldObj) { root.remove(fieldObj.group); fieldObj.group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); }); fieldObj.asset.dispose(); fieldObj = null; }
        for (const k in plants) disposeTree(plants[k].group);
        disposeTree(driftPts.points); for (const k in driftMesh) disposeTree(driftMesh[k]);
      }
    };
  }
};
