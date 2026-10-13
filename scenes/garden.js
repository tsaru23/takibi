// シーン「庭園・竹藪」。鹿威し、石灯籠、縁台の盆栽（松・もみじ・梅）、風にしなる竹藪、苔の地面と飛び石、枯山水の砂紋。
// 形式は scenes/index.js のコメントを参照。
import * as THREE from 'three';
import { mulberry32, rnd, clamp, mergeGeoms, tileNoise, heightToNormalTexture, radialTexture, disposeTree } from './util.js';

/* ---------- 配置（x は右、z は奥がマイナス。カメラは +Z 側から焚火を見る） ---------- */
const SH_POS = { x: 1.8, z: -1.4 };         // 鹿威し
const SH_K = 0.7;                             // 鹿威しの倍率（元は 筒 約1.0m・支柱の先までの高さ 約1.7m。0.7 で 筒 約0.7m・高さ 約1.2m・石鉢の直径 約0.44m）
const SH_SND = { x: SH_POS.x, y: 0.35, z: SH_POS.z };   // 鹿威しの音の位置
const LANTERN = { x: 3.0, z: -3.5 };         // 石灯籠
const STAND = { x: -0.9, z: -2.7, len: 1.7 }; // 盆栽の縁台
const SAND = { x: -2.5, z: -1.2, w: 2.6, d: 1.8 };   // 枯山水

const SEASON = {
  spring: { tint: [0.9, 1.0, 0.86], moss: 0x4f8a3c, bamboo: 0x7aa84a, leaf: 0x86b64c, snow: 0, groundLeaves: 0, petals: 24, wind: 1.0,
            maple: 0x8fc060, pine: 0x24502c, ume: 'bloom', stoneTone: 1.0 },
  summer: { tint: [0.86, 1.0, 0.82], moss: 0x2f7a33, bamboo: 0x2a6a3c, leaf: 0x1d5a2a, snow: 0, groundLeaves: 0, petals: 0, wind: 0.8,
            maple: 0x2f7a35, pine: 0x1f4a28, ume: 'leaf', stoneTone: 1.0 },
  autumn: { tint: [1.0, 0.98, 0.84], moss: 0x6a7a30, bamboo: 0x86923e, leaf: 0x9aa63c, snow: 0, groundLeaves: 80, petals: 0, wind: 1.2,
            maple: 0xc8301a, pine: 0x26482a, ume: 'bare', stoneTone: 1.0 },
  winter: { tint: [0.9, 0.97, 1.08], moss: 0x4a6a58, bamboo: 0x55705e, leaf: 0x4c6a54, snow: 1, groundLeaves: 0, petals: 0, wind: 0.7,
            maple: 0x000000, pine: 0x1f3a2a, ume: 'bare', stoneTone: 1.25 }
};
const BAMBOO_N = 150, CLUSTERS = 3;
const ROOT = new URL('../', import.meta.url);
const BAMBOO_DIR = 'assets/plants/vd-bamboo-b0c4849ceaaf82c4a67b/';
const BAMBOO_CLUMPS = 52;
const WALL_Z = 7.6;                          // 背後の土塀の位置（庭の外との境）。焚火から +Z へ約 7.6m
/* 全周の竹藪: 焚火のまわり r 8.5〜14m の輪。背後の土塀（z 5.5〜8.6）の上には立てない（塀のうしろに立つ） */
function bambooRing(br) {
  for (let g = 0; g < 40; g++) {
    const a = br() * Math.PI * 2, r = 8.5 + br() * 5.5, x = Math.sin(a) * r, z = Math.cos(a) * r;
    if ((z > 5.5 && z < 8.8) || z < -3) continue;   // 前（-Z）は元の奥の帯のまま。初期の構図の夜空を守る
    return [x, z];
  }
  return [-11, -2];
}
/* FABOTANIC の竹（竹類A）に掛ける季節の色（材質の色に掛け算。leaf = 葉、stem = 幹）。冬は葉に雪をのせたように白っぽく */
const BAMBOO_TINT = {
  spring: { leaf: [1.7, 2.2, 1.2], stem: [1.1, 1.3, 0.8], em: [0.05, 0.11, 0.03] },
  summer: { leaf: [1.4, 1.9, 1.3], stem: [0.85, 1.0, 0.75], em: [0.02, 0.08, 0.04] },
  autumn: { leaf: [2.3, 2.0, 0.9], stem: [1.2, 1.05, 0.65], em: [0.09, 0.08, 0.0] },
  winter: { leaf: [1.8, 2.1, 2.2], stem: [0.9, 1.05, 1.15], em: [0.07, 0.09, 0.11] }
};

/* ---------- 竹の揺れ（頂点シェーダー）: 上ほど大きくしなる。幹とは別の InstancedMesh（葉の塊）も同じ式で動かす ---------- */
const SWAY_GLSL = `
uniform float uTime, uWind;
attribute vec4 aS;   // x,z: 根元 / y: 高さ(m) / w: 幹のどの高さか(0..1。幹自身は -1)
vec3 tkSway(float t, vec4 s) {
  float ph = s.x * 0.37 + s.y * 0.21;
  float g = 0.55 + 0.45 * sin(uTime * 0.31 + ph * 0.5);                 // 風の強弱（突風）
  float sw = sin(uTime * 1.25 + ph) + 0.5 * sin(uTime * 2.3 + ph * 1.7);
  float a = t * t * s.z * 0.028 * uWind * (0.35 + g) * (0.6 + 0.4 * sw);
  return vec3(a * 1.0, -t * t * s.z * 0.004 * uWind * g, a * 0.35 * sin(uTime * 0.9 + ph));
}`;
function patchBamboo(mat, U, isLeaf) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = U.uTime; shader.uniforms.uWind = U.uWind;
    shader.vertexShader = SWAY_GLSL + 'varying float vNode; varying float vH;\n' + shader.vertexShader.replace('#include <project_vertex>', `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
float tkT = ${isLeaf ? 'aS.w' : 'position.y'};
vNode = mvPosition.y; vH = tkT;
mvPosition.xyz += tkSway(tkT, vec4(aS.x, aS.z, aS.y, 0.0));
${isLeaf ? 'mvPosition.xyz += vec3(sin(uTime * 4.2 + position.x * 31.0 + aS.x) * 0.02, sin(uTime * 3.3 + position.z * 27.0) * 0.015, cos(uTime * 3.7 + position.y * 23.0 + aS.y) * 0.02) * uWind;' : ''}
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`);
    if (!isLeaf) {
      shader.fragmentShader = 'varying float vNode; varying float vH;\n' + shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
  { float nd = fract(vNode / 0.42); diffuseColor.rgb *= 1.0 - 0.35 * smoothstep(0.93, 1.0, nd) - 0.18 * (1.0 - smoothstep(0.0, 0.05, nd)); }`);
    }
  };
  mat.customProgramCacheKey = () => 'tkbamboo' + (isLeaf ? 'L' : 'S');
}

/* ---------- 形を作る小道具 ---------- */
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const unitCyl = new THREE.CylinderGeometry(0.62, 1, 1, 5, 1); unitCyl.translate(0, 0.5, 0);
const _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _v = new THREE.Vector3();
function seg(parts, a, b, r) {
  const d = _v.copy(b).sub(a), len = d.length();
  _q.setFromUnitVectors(Y_AXIS, d.normalize());
  parts.push({ geo: unitCyl, matrix: new THREE.Matrix4().compose(a, _q.clone(), new THREE.Vector3(r, len, r)) });
}
function bendDir(dir, ang, rng, up) {
  const axis = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).cross(dir);
  if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
  axis.normalize();
  const d = dir.clone().applyAxisAngle(axis, ang); d.y += up; return d.normalize();
}
function grow(parts, tips, nodes, p, dir, len, rad, depth, rng, st) {
  const e = p.clone().addScaledVector(dir, len);
  seg(parts, p, e, rad);
  if (depth <= 0) { tips.push(e); return; }
  nodes.push(e);
  const n = (depth === st.depth ? st.split : rng() < 0.65 ? 2 : 3);
  for (let i = 0; i < n; i++) grow(parts, tips, nodes, e, bendDir(dir, st.spread * (0.6 + rng() * 0.8), rng, st.up), len * st.shrink, rad * 0.68, depth - 1, rng, st);
}
function sphereMesh(geo, mat, n) { const im = new THREE.InstancedMesh(geo, mat, n); im.frustumCulled = false; return im; }

/* 盆栽: 松・もみじ・梅（枝は L-system 風の再帰で作り、葉・花は InstancedMesh の塊） */
function buildBonsai(kind, cfg, seed) {
  const rng = mulberry32(seed), g = new THREE.Group();
  const parts = [], tips = [], nodes = [], pads = [];
  if (kind === 'pine') {
    let p = new THREE.Vector3(0, 0, 0), dir = new THREE.Vector3(0.18, 1, 0).normalize();
    for (let i = 0; i < 6; i++) {
      const len = 0.1 - i * 0.008, e = p.clone().addScaledVector(dir, len);
      seg(parts, p, e, 0.024 - i * 0.0028);
      if (i >= 2) {
        const side = i % 2 ? 1 : -1, bd = new THREE.Vector3(side * 0.9, 0.18, (rng() - 0.5) * 0.9).normalize(), bl = 0.2 - i * 0.02;
        const be = e.clone().addScaledVector(bd, bl); seg(parts, e, be, 0.011);
        const be2 = be.clone().addScaledVector(new THREE.Vector3(side * 0.6, -0.2, rng() - 0.5).normalize(), 0.08); seg(parts, be, be2, 0.007);
        pads.push({ p: be2.clone().add(new THREE.Vector3(0, 0.02, 0)), s: 0.1 + rng() * 0.03 }); pads.push({ p: be.clone().add(new THREE.Vector3(0, 0.035, 0)), s: 0.075 + rng() * 0.02 });
      }
      p = e; dir = bendDir(dir, 0.22, rng, 0.05);
    }
    pads.push({ p: p.clone().add(new THREE.Vector3(0, 0.03, 0)), s: 0.085 });
  } else {
    const st = kind === 'maple' ? { depth: 4, split: 2, spread: 0.55, up: 0.28, shrink: 0.76 } : { depth: 4, split: 2, spread: 0.85, up: 0.1, shrink: 0.72 };
    grow(parts, tips, nodes, new THREE.Vector3(0, 0, 0), new THREE.Vector3(kind === 'ume' ? 0.35 : 0.1, 1, 0.05).normalize(), kind === 'maple' ? 0.15 : 0.13, kind === 'maple' ? 0.02 : 0.017, st.depth, rng, st);
  }
  const bark = new THREE.Mesh(mergeGeoms(parts), new THREE.MeshLambertMaterial({ color: kind === 'pine' ? 0x3a2a1e : kind === 'ume' ? 0x2e231c : 0x4a3626 }));
  g.add(bark);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
  const blobGeo = new THREE.IcosahedronGeometry(1, 0);
  const addBlobs = (list, mat, sizeFn, flat) => {
    if (!list.length) return null;
    const im = sphereMesh(blobGeo, mat, list.length);
    list.forEach((it, i) => { const s = sizeFn(it, i); q.setFromEuler(new THREE.Euler(rng() * 3, rng() * 6, rng() * 3)); m4.compose(it.p || it, q, flat ? new THREE.Vector3(s, s * 0.42, s) : new THREE.Vector3(s, s * 0.85, s)); im.setMatrixAt(i, m4); im.setColorAt(i, col.set(0xffffff).multiplyScalar(0.8 + rng() * 0.4)); });
    g.add(im); return im;
  };
  const snow = cfg.snow;
  if (kind === 'pine') {
    addBlobs(pads, new THREE.MeshLambertMaterial({ color: cfg.pine }), (it) => it.s, true);
    if (snow) addBlobs(pads.map((p) => ({ p: p.p.clone().add(new THREE.Vector3(0, 0.022, 0)), s: p.s * 0.85 })), new THREE.MeshLambertMaterial({ color: 0xe8f0fa, emissive: 0x1c2630 }), (it) => it.s, true);
  } else if (kind === 'maple') {
    if (!snow) { const pts = []; tips.forEach((t) => { for (let k = 0; k < 3; k++) pts.push({ p: t.clone().add(new THREE.Vector3((rng() - 0.5) * 0.09, (rng() - 0.3) * 0.06, (rng() - 0.5) * 0.09)) }); }); addBlobs(pts, new THREE.MeshLambertMaterial({ color: cfg.maple, emissive: cfg.maple === 0xc8301a ? 0x2a0804 : 0x000000 }), () => 0.045 + rng() * 0.02, false); }
    else addBlobs(tips.filter((_, i) => i % 3 === 0).map((t) => ({ p: t.clone().add(new THREE.Vector3(0, 0.012, 0)), s: 0.03 })), new THREE.MeshLambertMaterial({ color: 0xe8f0fa, emissive: 0x1c2630 }), (it) => it.s, false);
  } else {
    if (cfg.ume === 'bloom') {
      const pts = []; tips.concat(nodes.filter((_, i) => i % 2 === 0)).forEach((t) => { for (let k = 0; k < 3; k++) pts.push({ p: t.clone().add(new THREE.Vector3((rng() - 0.5) * 0.07, (rng() - 0.4) * 0.05, (rng() - 0.5) * 0.07)) }); });
      addBlobs(pts, new THREE.MeshLambertMaterial({ color: 0xffd3e0, emissive: 0x4a2230 }), () => 0.017 + rng() * 0.008, false);
    } else if (cfg.ume === 'leaf') {
      addBlobs(tips.map((t) => ({ p: t.clone() })), new THREE.MeshLambertMaterial({ color: 0x3e7a34 }), () => 0.042 + rng() * 0.015, false);
    } else if (!snow) {
      addBlobs(tips.filter((_, i) => i % 4 === 0).map((t) => ({ p: t.clone() })), new THREE.MeshLambertMaterial({ color: 0xc89a2a }), () => 0.022, false);
    }
    if (snow) addBlobs(tips.filter((_, i) => i % 2 === 0).map((t) => ({ p: t.clone().add(new THREE.Vector3(0, 0.012, 0)), s: 0.03 })), new THREE.MeshLambertMaterial({ color: 0xe8f0fa, emissive: 0x1c2630 }), (it) => it.s, false);
  }
  blobGeo.dispose();
  return g;
}

function mapleTex() {
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
function stripeTex() {
  const c = document.createElement('canvas'); c.width = 8; c.height = 64;
  const x = c.getContext('2d'); x.fillStyle = 'rgba(190,225,255,0.55)'; x.fillRect(0, 0, 8, 64);
  for (let i = 0; i < 6; i++) { x.fillStyle = 'rgba(255,255,255,0.8)'; x.fillRect(Math.random() * 7, Math.random() * 64, 1.5, 14); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}

/* ---------- シーン本体 ---------- */
export default {
  id: 'garden',
  label: '庭園・竹藪',
  audio: { autoOn: ['bamboo', 'scenesfx'], reverb: { seconds: 1.6, decay: 3, wet: 0.22 }, sources: { brook: [{ x: SH_POS.x, y: 0.2, z: SH_POS.z }] } },
  props: { logPile: { x: -1.4, z: 0.5, rotY: 0.35 } },   // 枯山水（x -4.5〜-1.9, z -1.8〜0）に重ならない手前へ

  build(ctx) {
    const { scene, root, api, assets, ground } = ctx;
    let disposed = false, season = '', cfg = SEASON.summer, curT = 0;
    const texs = [], geos = [], mats = [];
    const own = (list, x) => { list.push(x); return x; };
    const rng = mulberry32(2025);
    const U = { uTime: { value: 0 }, uWind: { value: 1 } };
    const stoneColor = (k = 1) => new THREE.Color(0x6a6862).multiplyScalar(k);

    /* --- 地面: 土のテクスチャに緑を乗せる（地面の材質の色を変え、dispose で戻す）＋苔のまだら --- */
    const origGroundColor = ground ? ground.material.color.clone() : null;
    const mossTex = own(texs, radialTexture(64, [[0, 'rgba(255,255,255,0.95)'], [0.55, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]));
    const mossMat = own(mats, new THREE.MeshLambertMaterial({ color: 0x34602c, map: mossTex, transparent: true, opacity: 0.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    const NMOSS = 70, mossGeo = own(geos, new THREE.CircleGeometry(1, 16)); mossGeo.rotateX(-Math.PI / 2);
    const moss = new THREE.InstancedMesh(mossGeo, mossMat, NMOSS); moss.frustumCulled = false;
    {
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color(), mr = mulberry32(61);
      for (let i = 0; i < NMOSS; i++) {
        let x = (mr() - 0.5) * 11, z = -5 + mr() * 6.6; const s = 0.5 + mr() * 1.1; if (Math.hypot(x, z) < 2.4) { x *= 2.2; z = z * 2.2 - 1; }
        if (i >= 40) { const a = mr() * 6.28, r = 2.6 + Math.sqrt(mr()) * 6; x = Math.sin(a) * r; z = Math.cos(a) * r; }   // 全周（背後・左右にも）
        q.setFromEuler(e.set(0, mr() * 6, 0)); m4.compose(new THREE.Vector3(x, 0.006 + i * 0.00005, z), q, new THREE.Vector3(s * (1 + mr()), 1, s));
        moss.setMatrixAt(i, m4); moss.setColorAt(i, c.setScalar(0.75 + mr() * 0.5));
      }
      root.add(moss);
    }

    /* --- 飛び石 --- */
    {
      const stoneGeo = own(geos, new THREE.CylinderGeometry(1, 1.1, 0.07, 9));
      const pos = [[1.05, 1.8], [1.4, 1.1], [1.7, 0.4], [1.85, -0.35], [-0.6, -1.15], [-0.45, -1.6], [-1.3, 1.5], [-1.6, 0.9], [-1.75, 0.3]];
      const sm = own(mats, new THREE.MeshStandardMaterial({ color: 0x77746c, roughness: 0.95, flatShading: true }));
      const im = new THREE.InstancedMesh(stoneGeo, sm, pos.length), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color();
      pos.forEach(([x, z], i) => {
        const s = 0.17 + rng() * 0.07; q.setFromEuler(e.set(0, rng() * 6, 0));
        m4.compose(new THREE.Vector3(x, 0.025, z), q, new THREE.Vector3(s * (1 + rng() * 0.5), 1, s * (0.9 + rng() * 0.4))); im.setMatrixAt(i, m4); im.setColorAt(i, c.setScalar(0.8 + rng() * 0.4));
      });
      root.add(im);
    }

    /* --- 枯山水（法線マップをコードで作る砂紋） --- */
    {
      const W = 256, H = 176, hgt = new Float32Array(W * H);
      const rocks = [[-0.45, 0.2, 0.34], [0.5, -0.15, 0.22], [0.12, -0.38, 0.14]];   // 中心からのずれ(x, z)と半径
      const noise = tileNoise(64, 8, 3, 5);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const wx = (x / W - 0.5) * SAND.w, wz = -(y / H - 0.5) * SAND.d;
        let dmin = 9, ri = 0;
        for (let k = 0; k < rocks.length; k++) { const d = Math.hypot(wx - rocks[k][0], wz - rocks[k][1]) - rocks[k][2]; if (d < dmin) { dmin = d; ri = k; } }
        const ring = 0.5 + 0.5 * Math.cos(dmin * Math.PI * 2 / 0.085), line = 0.5 + 0.5 * Math.cos(wz * Math.PI * 2 / 0.085 + Math.sin(wx * 2.2) * 0.4);
        const m = smoothstepJS(0.62, 0.46, dmin);
        let v = line * (1 - m) + ring * m;
        if (dmin < 0.02) v = 0.5;
        hgt[y * W + x] = v * 0.8 + 0.2 * noise[(y % 64) * 64 + (x % 64)];
      }
      const nt = own(texs, heightToNormalTexture(hgt, W, H, 3.2, false));
      const sandMat = own(mats, new THREE.MeshStandardMaterial({ color: 0xcfd0c8, roughness: 0.92, normalMap: nt, normalScale: new THREE.Vector2(1, 1) }));
      const sg = own(geos, new THREE.PlaneGeometry(SAND.w, SAND.d)); sg.rotateX(-Math.PI / 2);
      const sand = new THREE.Mesh(sg, sandMat); sand.position.set(SAND.x, 0.03, SAND.z); root.add(sand);
      // 縁取り（石）と庭石
      const edgeMat = own(mats, new THREE.MeshStandardMaterial({ color: 0x4a4844, roughness: 0.95, flatShading: true }));
      const eg = own(geos, new THREE.BoxGeometry(1, 0.08, 0.07));
      [[0, SAND.d / 2, SAND.w + 0.07], [0, -SAND.d / 2, SAND.w + 0.07]].forEach(([x, z, w]) => { const m = new THREE.Mesh(eg, edgeMat); m.scale.x = w; m.position.set(SAND.x + x, 0.04, SAND.z + z); root.add(m); });
      [[SAND.w / 2, 0], [-SAND.w / 2, 0]].forEach(([x]) => { const m = new THREE.Mesh(eg, edgeMat); m.scale.x = SAND.d; m.rotation.y = Math.PI / 2; m.position.set(SAND.x + x, 0.04, SAND.z); root.add(m); });
      const rg = new THREE.IcosahedronGeometry(1, 1); const pp = rg.attributes.position;
      for (let i = 0; i < pp.count; i++) { const k = 1 + 0.2 * Math.sin(pp.getX(i) * 4 + pp.getZ(i) * 3) * Math.cos(pp.getY(i) * 5); pp.setXYZ(i, pp.getX(i) * k, pp.getY(i) * k, pp.getZ(i) * k); }
      rg.computeVertexNormals(); own(geos, rg);
      rocks.forEach(([x, z, r], i) => {
        const rm = new THREE.Mesh(rg, edgeMat); const s = r * 1.1;
        rm.scale.set(s * 1.3, s * (1.1 + i * 0.2), s); rm.position.set(SAND.x + x, 0.03 + s * 0.45, SAND.z + z); rm.rotation.y = i * 1.7; root.add(rm);
      });
    }

    /* --- 鹿威し --- */
    const sh = new THREE.Group(); sh.position.set(SH_POS.x, 0, SH_POS.z); sh.scale.setScalar(SH_K); root.add(sh);   // 部品の位置・水・波紋は sh のローカル座標なので、まとめて縮む
    const bambooMat = own(mats, new THREE.MeshLambertMaterial({ color: 0x7a8a3c }));
    const bambooDark = own(mats, new THREE.MeshLambertMaterial({ color: 0x4e5a24 }));
    const woodMat = own(mats, new THREE.MeshLambertMaterial({ color: 0x6b4a2c }));
    const TH_REST = -0.42, TH_TIP = 0.75, TS = 1.9, PIV_Y = 0.85;
    const tube = new THREE.Group(); tube.position.set(0, PIV_Y, 0); sh.add(tube);   // 支点。rotation.z がそのまま傾き
    // コード製の筒・水は TS 倍の実寸で作るので、拡大した子グループ tubeS に入れる（GLB の筒は TS=1.9 を焼き込み済みなので拡大しない）
    const tubeS = new THREE.Group(); tubeS.scale.setScalar(TS); tube.add(tubeS);
    const tubeFB = new THREE.Group(); tubeS.add(tubeFB);        // コード製の筒（GLB が読めたら隠す）
    const fbSh = new THREE.Group(); sh.add(fbSh);               // コード製の支柱・樋・石・鉢（GLB が読めたら隠す）
    let waterBox, pourSheet, stream, rings = [], waterY = -0.014;   // waterY: 水の箱の高さ（筒のローカル。TS 倍前）
    {
      const trough = own(geos, new THREE.CylinderGeometry(0.04, 0.04, 0.3, 12, 1, true, Math.PI * 0.9, Math.PI * 1.2)); trough.rotateZ(Math.PI / 2); trough.translate(-0.15, 0, 0);
      const tm = own(mats, new THREE.MeshLambertMaterial({ color: 0x7a8a3c, side: THREE.DoubleSide }));
      tubeFB.add(new THREE.Mesh(trough, tm));
      const rear = own(geos, new THREE.CylinderGeometry(0.04, 0.04, 0.22, 12)); rear.rotateZ(Math.PI / 2); rear.translate(0.11, 0, 0);
      tubeFB.add(new THREE.Mesh(rear, bambooMat));
      const ring = own(geos, new THREE.CylinderGeometry(0.044, 0.044, 0.012, 12)); ring.rotateZ(Math.PI / 2);
      [-0.02, 0.2, -0.28].forEach((x) => { const r = new THREE.Mesh(ring, bambooDark); r.position.x = x; tubeFB.add(r); });
      const wg = own(geos, new THREE.BoxGeometry(1, 0.05, 0.07));
      waterBox = new THREE.Mesh(wg, own(mats, new THREE.MeshLambertMaterial({ color: 0x9fd0f0, emissive: 0x1a3048, transparent: true, opacity: 0.8 }))); waterBox.position.set(-0.01, -0.012, 0); waterBox.visible = false; tubeS.add(waterBox);
      // 軸と支柱
      const post = own(geos, new THREE.CylinderGeometry(0.026, 0.03, 0.95, 8)); post.translate(0, 0.475, 0);
      [-0.09, 0.09].forEach((z) => { const p = new THREE.Mesh(post, bambooMat); p.position.set(0, 0, z); fbSh.add(p); });
      const axle = own(geos, new THREE.CylinderGeometry(0.012, 0.012, 0.24, 8)); axle.rotateX(Math.PI / 2);
      const ax = new THREE.Mesh(axle, woodMat); ax.position.set(0, PIV_Y, 0); fbSh.add(ax);
      // 竹の樋（右から左へ、わずかに下る）と支柱
      const fl = own(geos, new THREE.CylinderGeometry(0.05, 0.05, 0.8, 10, 1, true, Math.PI * 0.9, Math.PI * 1.2));
      const flume = new THREE.Mesh(fl, own(mats, new THREE.MeshLambertMaterial({ color: 0x7a8a3c, side: THREE.DoubleSide })));
      flume.rotation.z = Math.PI / 2 - 0.28; flume.position.set(-0.93, 1.41, 0); fbSh.add(flume);
      const fp = own(geos, new THREE.CylinderGeometry(0.022, 0.028, 1, 6)); fp.translate(0, 0.5, 0);
      const fpm = new THREE.Mesh(fp, bambooMat); fpm.position.set(-1.2, 0, 0); fpm.scale.y = 1.45; fbSh.add(fpm);
      const fp2 = new THREE.Mesh(fp, bambooMat); fp2.position.set(-0.75, 0, 0); fp2.scale.y = 1.33; fbSh.add(fp2);
      // 落ちる水
      const st = own(geos, new THREE.CylinderGeometry(0.0055, 0.0055, 1, 5)); st.translate(0, -0.5, 0);
      stream = new THREE.Mesh(st, own(mats, new THREE.MeshBasicMaterial({ map: own(texs, stripeTex()), transparent: true, depthWrite: false, opacity: 0.85 }))); stream.position.set(-0.53, 1.29, 0); stream.scale.set(1, 0.2, 1); stream.renderOrder = 3; sh.add(stream);
      const sg = own(geos, new THREE.BoxGeometry(0.03, 1, 0.07)); sg.translate(0, -0.5, 0);
      pourSheet = new THREE.Mesh(sg, own(mats, new THREE.MeshBasicMaterial({ color: 0xcfe6ff, transparent: true, opacity: 0.7, depthWrite: false }))); pourSheet.visible = false; pourSheet.renderOrder = 3; sh.add(pourSheet);
      // 打たれる石
      const sg2 = own(geos, new THREE.CylinderGeometry(0.11, 0.14, 0.6, 9)); sg2.translate(0, 0.3, 0);
      const stn = new THREE.Mesh(sg2, own(mats, new THREE.MeshStandardMaterial({ color: 0x5c5a54, roughness: 0.95, flatShading: true }))); stn.position.set(0.4, 0, 0); stn.scale.set(1.1, 1, 0.9); fbSh.add(stn);
      // 受けの石鉢（水面は動く波紋）
      const bg = own(geos, new THREE.CylinderGeometry(0.27, 0.3, 0.26, 14)); bg.translate(0, 0.13, 0);
      const bm = own(mats, new THREE.MeshStandardMaterial({ color: 0x5a5852, roughness: 0.95, flatShading: true }));
      const basin = new THREE.Mesh(bg, bm); basin.position.set(-0.45, 0, 0); fbSh.add(basin);
      const wm = own(mats, new THREE.MeshStandardMaterial({ color: 0x142634, roughness: 0.08, metalness: 0.2 }));
      const wd = own(geos, new THREE.CircleGeometry(0.22, 20)); wd.rotateX(-Math.PI / 2);
      const wsurf = new THREE.Mesh(wd, wm); wsurf.position.set(-0.45, 0.262, 0); sh.add(wsurf);
      const rg = own(geos, new THREE.RingGeometry(0.9, 1, 28)); rg.rotateX(-Math.PI / 2);
      for (let i = 0; i < 3; i++) { const r = new THREE.Mesh(rg, own(mats, new THREE.MeshBasicMaterial({ color: 0xbfd8ee, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }))); r.position.set(-0.43, 0.268, 0); r.visible = false; sh.add(r); rings.push({ m: r, t0: -99 }); }
    }
    // 鹿威しの動きと音（同じ時刻表から作る）。周期 20〜40 秒＋揺らぎ。1周期 = 水が溜まる → 傾く → 水がこぼれる → 勢いよく戻って石を打つ（カコーン）→ 余韻
    const SHI = { t0: 0, T: 30, tFill: 27, strikeDone: true, trickle: null, played: { pour: false, kakon: false }, log: [] };
    const D_TIP = 0.9, D_HOLD = 0.6, D_RET = 0.42, D_BOUNCE = 0.9;
    function startCycle(t, skip = 0) {
      SHI.t0 = t - skip; SHI.T = rnd(20, 40); SHI.tFill = SHI.T - (D_TIP + D_HOLD + D_RET + D_BOUNCE);
      SHI.played = { pour: false, kakon: false, drip: false }; SHI.struck = false;
      if (SHI.trickle) { try { SHI.trickle.stop(); } catch (e) {} }
      SHI.trickle = api.playSfx && SHI.tFill - skip > 1 ? api.playSfx('trickle', { dur: SHI.tFill - skip, pos: SH_SND }) : null;
    }
    function ringAdd(t) { const r = rings.reduce((a, b) => (a.t0 < b.t0 ? a : b)); r.t0 = t; }
    const pan = clamp(SH_POS.x / 5, -0.8, 0.8);
    function updateShishi(t) {
      let a = t - SHI.t0;
      if (a >= SHI.T) { startCycle(t); a = 0; }
      const tF = SHI.tFill, tTip = tF, tHold = tTip + D_TIP, tRet = tHold + D_HOLD, tBounce = tRet + D_RET;
      let th = TH_REST, fill = 0, pour = 0;
      if (a < tF) {
        fill = a / tF; th = TH_REST + 0.05 * smoothstepJS(0.9, 1, fill);
      } else if (a < tHold) {
        const p = (a - tTip) / D_TIP, e = p * p * (3 - 2 * p);
        th = TH_REST + 0.05 + (TH_TIP - TH_REST - 0.05) * e;
        fill = 1 - clamp((p - 0.3) / 0.4, 0, 1);
        pour = smoothstepJS(0.3, 0.45, p);
        if (!SHI.played.pour && p > 0.3) { SHI.played.pour = true; ctxSfx('pour', 0, pan); ringAdd(t); }
      } else if (a < tRet) {
        th = TH_TIP + 0.015 * Math.sin((a - tHold) * 9); fill = 0; pour = (a - tHold) < 0.25 ? 1 - (a - tHold) / 0.25 : 0;
        if (!SHI.played.drip && a - tHold > 0.2) { SHI.played.drip = true; ctxSfx('drip', 0.4, pan, 0.0); ringAdd(t); }
      } else if (a < tBounce) {
        const p = (a - tRet) / D_RET;
        th = TH_TIP + (TH_REST - TH_TIP) * p * p;
        if (!SHI.played.kakon) {          // 戻り始めの時点で、石に当たる時刻（D_RET 秒後）に合わせて音を予約する
          SHI.played.kakon = true;
          const remain = Math.max(0, SHI.t0 + tBounce - t);     // 石に当たる時刻までの残り（映像と同じ時刻表）
          api.playSfx && api.playSfx('kakon', { delay: remain, pos: SH_SND, vol: rnd(0.85, 1) });
          SHI.schedPerf = performance.now() / 1000 + remain;
        }
      } else {
        const b = a - tBounce;
        th = TH_REST + 0.11 * Math.exp(-b * 7) * Math.abs(Math.sin(b * 15));
        if (!SHI.struck) { SHI.struck = true; SHI.log.push({ strikePerf: performance.now() / 1000, schedPerf: SHI.schedPerf }); ringAdd(t); }   // 石を打った瞬間
      }
      tube.rotation.z = th;
      // 水
      const len = fill * 0.27;
      waterBox.visible = len > 0.003; waterBox.scale.x = Math.max(0.001, len); waterBox.position.x = -len / 2 - 0.012; waterBox.position.y = waterY;
      const flowing = a < tF;
      stream.visible = flowing && a > 0.05; stream.scale.y = 0.24;
      if (stream.material.map) stream.material.map.offset.y -= 0.12;
      pourSheet.visible = pour > 0.02;
      if (pourSheet.visible) {
        const c = Math.cos(th), s = Math.sin(th), mx = (-0.3 * c) * TS, my = PIV_Y + (-0.3 * s) * TS;
        pourSheet.position.set(mx, my - 0.02, 0); pourSheet.scale.set(1, Math.max(0.01, my - 0.25) * pour, 1);
      }
      rings.forEach((r) => {
        const age = t - r.t0, on = age >= 0 && age < 1.6; r.m.visible = on;
        if (on) { r.m.scale.setScalar(0.04 + age * 0.14); r.m.material.opacity = 0.7 * (1 - age / 1.6); }
      });
    }
    function ctxSfx(name, dx, p, delay) { api.playSfx && api.playSfx(name, { vol: 1, pos: SH_SND, delay: delay || 0 }); }

    /* --- 石灯籠 --- */
    const lantern = new THREE.Group(); lantern.position.set(LANTERN.x, 0, LANTERN.z); root.add(lantern);
    const stoneMat = own(mats, new THREE.MeshStandardMaterial({ color: 0x74716a, roughness: 0.95, flatShading: true }));
    const lamp = { light: new THREE.PointLight(0xffa860, 2, 5.5, 2), win: null, halo: null, snowCap: [], snowMat: null, winMeshes: [], glbMats: [] };
    const fbLantern = new THREE.Group(); lantern.add(fbLantern);     // コード製の灯籠本体（GLB が読めたら隠す）
    {
      const add = (geo, y, mat = stoneMat) => { const m = new THREE.Mesh(own(geos, geo), mat); m.position.y = y; fbLantern.add(m); return m; };
      add(new THREE.CylinderGeometry(0.3, 0.34, 0.12, 6), 0.06);
      add(new THREE.CylinderGeometry(0.09, 0.11, 0.5, 8), 0.37);
      add(new THREE.CylinderGeometry(0.22, 0.16, 0.1, 6), 0.67);
      add(new THREE.BoxGeometry(0.3, 0.3, 0.3), 0.87);
      add(new THREE.CylinderGeometry(0.1, 0.5, 0.2, 6), 1.1);
      add(new THREE.CylinderGeometry(0.0, 0.1, 0.12, 6), 1.26);
      add(new THREE.SphereGeometry(0.06, 8, 6), 1.34);
      const wm = own(mats, new THREE.MeshBasicMaterial({ color: 0xffb468, toneMapped: false }));
      lamp.win = wm;
      [[0, 0.152, 0], [0.152, 0, Math.PI / 2], [0, -0.152, 0], [-0.152, 0, Math.PI / 2]].forEach(([x, z, ry], i) => {
        const w = new THREE.Mesh(own(geos, new THREE.PlaneGeometry(0.15, 0.17)), wm);
        const isZ = i % 2 === 0; w.position.set(isZ ? 0 : x, 0.87, isZ ? z : 0); w.rotation.y = isZ ? (i === 0 ? 0 : Math.PI) : (i === 1 ? Math.PI / 2 : -Math.PI / 2); lantern.add(w); lamp.winMeshes.push(w);
      });
      const hm = own(mats, new THREE.SpriteMaterial({ map: own(texs, radialTexture(64, [[0, 'rgba(255,190,110,0.9)'], [0.35, 'rgba(255,150,70,0.3)'], [1, 'rgba(255,120,40,0)']])), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
      lamp.halo = new THREE.Sprite(hm); lamp.halo.position.set(0, 0.87, 0); lamp.halo.scale.setScalar(1.3); lantern.add(lamp.halo);
      // 雪（冬）
      const snowMat = lamp.snowMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xeef4ff, emissive: 0x1c2630 }));
      const roofSnow = new THREE.Mesh(own(geos, new THREE.CylinderGeometry(0.0, 0.5, 0.2, 6)), snowMat); roofSnow.position.y = 1.22; lantern.add(roofSnow);
      const topSnow = new THREE.Mesh(own(geos, new THREE.SphereGeometry(0.075, 8, 6)), snowMat); topSnow.scale.y = 0.6; topSnow.position.y = 1.4; lantern.add(topSnow);
      const baseSnow = new THREE.Mesh(own(geos, new THREE.CylinderGeometry(0.24, 0.28, 0.04, 8)), snowMat); baseSnow.position.y = 0.14; lantern.add(baseSnow);
      lamp.snowCap = [roofSnow, topSnow, baseSnow];
      lamp.light.position.set(LANTERN.x, 0.95, LANTERN.z); scene.add(lamp.light);
    }

    /* --- Blender 製の鹿威し・石灯籠（GLB）。読めたらコード製の本体と入れ替え、読めなければコード製のまま。
           動き・水・波紋・灯りの揺らぎ・雪・季節の色はコード側のまま。鹿威しの筒は TS=1.9 を焼き込んだ実寸なので tube.scale は使わない --- */
    let shishiGLB = null, lanternGLB = null;
    function applyLanternTone() { lamp.glbMats.forEach((m) => m.color.setScalar(cfg.stoneTone)); }
    (async () => {
      const [g1, g2] = await Promise.all(['shishiodoshi.glb', 'stone_lantern.glb'].map((f) => assets.loadGLTF('assets/models/' + f).catch(() => null)));
      if (disposed || ctx.isStopped()) { [g1, g2].forEach((g) => g && disposeTree(g.scene)); return; }
      if (g1) {
        const sc = g1.scene, tu = sc.getObjectByName('shishi_tube');
        if (tu && ['shishi_basin', 'shishi_flume', 'shishi_posts', 'shishi_stone'].every((n) => sc.getObjectByName(n))) {
          tu.removeFromParent(); tu.position.set(0, 0, 0); tube.add(tu);    // 支点（0, 0.85, 0）はコード側の tube に任せる
          sh.add(sc); tubeFB.visible = false; fbSh.visible = false; shishiGLB = sc;
          // GLB の筒は内半径 約0.061・縁 y +0.033 の半割りの樋。水の箱を内側に収まる大きさにする（ローカル値。×1.9 で実寸）
          waterBox.geometry = own(geos, new THREE.BoxGeometry(1, 0.034, 0.04)); waterY = -0.0066;
        } else disposeTree(sc);
      }
      if (g2) {
        const sc = g2.scene, lt = sc.getObjectByName('lantern_light'), wins = [0, 1, 2].map((i) => sc.getObjectByName('lantern_window_' + i));
        if (lt && wins.every(Boolean)) {
          lantern.add(sc); fbLantern.visible = false; lanternGLB = sc;
          const seen = new Set(); sc.traverse((o) => { if (o.isMesh && !seen.has(o.material)) { seen.add(o.material); lamp.glbMats.push(o.material); } });
          applyLanternTone();
          lamp.light.position.set(LANTERN.x, lt.position.y, LANTERN.z); lamp.halo.position.y = lt.position.y;
          // 窓: 4枚の発光板 → 3つの窓の位置（外向き）に置き直す
          lamp.winMeshes.forEach((w) => { lantern.remove(w); });
          lamp.winMeshes = wins.map((wn) => {
            const px = wn.position.x, pz = wn.position.z, r = Math.hypot(px, pz);
            const w = new THREE.Mesh(own(geos, new THREE.PlaneGeometry(0.15, 0.17)), lamp.win);
            w.position.set(px / r * (r + 0.002), wn.position.y, pz / r * (r + 0.002)); w.rotation.y = Math.atan2(px, pz); lantern.add(w); return w;
          });
          // 雪の冠: 笠（y 1.00〜1.24・幅 0.97）、宝珠（頂点 1.43）、土台（上面 y 0.12）に合わせる。六角の頂点は ±x
          lamp.snowCap.forEach((m) => lantern.remove(m));
          const roofSnow = new THREE.Mesh(own(geos, new THREE.CylinderGeometry(0.09, 0.42, 0.12, 6)), lamp.snowMat); roofSnow.position.y = 1.19; roofSnow.rotation.y = Math.PI / 6;
          const topSnow = new THREE.Mesh(own(geos, new THREE.SphereGeometry(0.075, 8, 6)), lamp.snowMat); topSnow.scale.y = 0.55; topSnow.position.y = 1.4;
          const baseSnow = new THREE.Mesh(own(geos, new THREE.CylinderGeometry(0.27, 0.3, 0.04, 6)), lamp.snowMat); baseSnow.position.y = 0.14; baseSnow.rotation.y = Math.PI / 6;
          lamp.snowCap = [roofSnow, topSnow, baseSnow]; lamp.snowCap.forEach((m) => { m.visible = !!cfg.snow; lantern.add(m); });
        } else disposeTree(sc);
      }
    })().catch((e) => console.warn('[takibi] garden models:', e));

    /* --- 縁台と盆栽 --- */
    const stand = new THREE.Group(); stand.position.set(STAND.x, 0, STAND.z); root.add(stand);
    {
      const top = new THREE.Mesh(own(geos, new THREE.BoxGeometry(STAND.len, 0.06, 0.46)), woodMat); top.position.y = 0.5; stand.add(top);
      const lg = own(geos, new THREE.BoxGeometry(0.06, 0.5, 0.06));
      [[-1, -0.19], [1, -0.19], [-1, 0.19], [1, 0.19]].map(([sx, z]) => [sx * (STAND.len / 2 - 0.07), z]).forEach(([x, z]) => { const l = new THREE.Mesh(lg, woodMat); l.position.set(x, 0.25, z); stand.add(l); });
      const shelf = new THREE.Mesh(own(geos, new THREE.BoxGeometry(STAND.len - 0.1, 0.03, 0.4)), woodMat); shelf.position.y = 0.16; stand.add(shelf);
    }
    const potCols = [0x34344c, 0x6a4a3a, 0x30484a];
    const bonsaiRoot = new THREE.Group(); stand.add(bonsaiRoot);
    const snowTopMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xeef4ff, emissive: 0x1c2630 }));
    const standSnow = new THREE.Mesh(own(geos, new THREE.BoxGeometry(STAND.len, 0.03, 0.46)), snowTopMat); standSnow.position.y = 0.545; stand.add(standSnow);
    function buildAllBonsai() {
      while (bonsaiRoot.children.length) { const c = bonsaiRoot.children[0]; bonsaiRoot.remove(c); disposeTree(c); }
      ['pine', 'maple', 'ume'].forEach((kind, i) => {
        const x = (i - 1) * 0.62, g = new THREE.Group(); g.position.set(x, 0.53, 0);
        const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.095, 0.085, 10), new THREE.MeshStandardMaterial({ color: potCols[i], roughness: 0.4, metalness: 0.05 })); pot.position.y = 0.043; g.add(pot);
        const soil = new THREE.Mesh(new THREE.CircleGeometry(0.115, 10), new THREE.MeshLambertMaterial({ color: cfg.snow ? 0xe4ecf6 : 0x3a5a2c })); soil.rotation.x = -Math.PI / 2; soil.position.y = 0.087; g.add(soil);
        const tree = buildBonsai(kind, cfg, 300 + i * 17); tree.position.y = 0.08; tree.scale.setScalar(1.0); g.add(tree);   // 鉢と木で 約0.4〜0.7m
        bonsaiRoot.add(g);
      });
    }

    /* --- 竹藪 --- */
    const bambooStalkGeo = own(geos, new THREE.CylinderGeometry(0.8, 1, 1, 6, 12, true)); bambooStalkGeo.translate(0, 0.5, 0);
    const bambooMat2 = own(mats, new THREE.MeshLambertMaterial({ color: 0xffffff })); patchBamboo(bambooMat2, U, false);
    const stalks = new THREE.InstancedMesh(bambooStalkGeo, bambooMat2, BAMBOO_N); stalks.frustumCulled = false; root.add(stalks);
    // 葉の塊: 細い葉を放射状に垂らした板。幹と同じ式でしなる
    const leafG = (() => {
      const P = [], I = [], lr = mulberry32(13);
      for (let i = 0; i < 16; i++) {
        const a = i / 16 * Math.PI * 2 + lr() * 0.3, dx = Math.cos(a), dz = Math.sin(a), L = 0.26 + lr() * 0.12, o = P.length / 3;
        const bx = dx * 0.04, bz = dz * 0.04, tx = dx * L, tz = dz * L, ty = -0.12 - lr() * 0.08, w = 0.022;
        P.push(bx - dz * w, 0, bz + dx * w, bx + dz * w, 0, bz - dx * w, tx * 0.6 - dz * w * 1.4, ty * 0.35 + 0.03, tz * 0.6 + dx * w * 1.4, tx * 0.6 + dz * w * 1.4, ty * 0.35 + 0.03, tz * 0.6 - dx * w * 1.4, tx, ty, tz);
        I.push(o, o + 1, o + 2, o + 1, o + 3, o + 2, o + 2, o + 3, o + 4);
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I); g.computeVertexNormals(); return own(geos, g);
    })();
    const leafMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide })); patchBamboo(leafMat, U, true);
    const NCL = BAMBOO_N * CLUSTERS;
    const clusters = new THREE.InstancedMesh(leafG, leafMat, NCL); clusters.frustumCulled = false; root.add(clusters);
    {
      const aS = new THREE.InstancedBufferAttribute(new Float32Array(BAMBOO_N * 4), 4), aL = new THREE.InstancedBufferAttribute(new Float32Array(NCL * 4), 4);
      const br = mulberry32(777), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color();
      let ci = 0;
      for (let i = 0; i < BAMBOO_N; i++) {
        let x, z, guard = 0;
        do {
          if (i < 72) { x = -13 + br() * 26; z = -12.5 + br() * 7.2; }                                   // 奥の帯
          else if (i < 110) { x = (br() < 0.5 ? -1 : 1) * (6.2 + br() * 7); z = -6 + br() * 9.5; }     // 左右の端
          else [x, z] = bambooRing(br);                                                                  // 全周の輪（手前・背後も）
          guard++;
        } while ((i < 110 && Math.abs(Math.atan2(x, z)) < 1.05 && Math.hypot(x, z) < 11) && guard < 30);
        const H = 5.5 + br() * 3, r = 0.055 + br() * 0.03, lean = (br() - 0.5) * 0.06;
        q.setFromEuler(e.set(lean, br() * 6, (br() - 0.5) * 0.06)); m4.compose(new THREE.Vector3(x, -0.05, z), q, new THREE.Vector3(r, H, r));
        stalks.setMatrixAt(i, m4); stalks.setColorAt(i, c.setScalar(0.8 + br() * 0.4));
        for (let k = 0; k < CLUSTERS; k++) {
          const tc = 0.6 + k * 0.13 + br() * 0.05, y = tc * H, a = br() * 6.28, s = 1.5 + br() * 1.0;
          q.setFromEuler(e.set(0, br() * 6.28, 0)); m4.compose(new THREE.Vector3(x + Math.cos(a) * 0.1 + lean * y * 0.5, y, z + Math.sin(a) * 0.1), q, new THREE.Vector3(s, s, s));
          clusters.setMatrixAt(ci, m4); clusters.setColorAt(ci, c.setScalar(0.75 + br() * 0.5));
          aL.setXYZW(ci, x, H, z, tc); ci++;
        }
        aS.setXYZW(i, x, H, z, -1);
      }
      bambooStalkGeo.setAttribute('aS', aS); leafG.setAttribute('aS', aL);
      // aS は (根元x, 高さ, 根元z, t) の並び。GLSL 側では (x, z, H) に並べ替えて読む
      void 0;
    }

    /* --- FABOTANIC の竹（竹類A・約6,300三角形の株）。読めたら上のコード製の竹と入れ替える。
           株ごとに InstancedMesh（幹と葉の2つ）で置く。風のしなりは付属の VerdantVegetation.js（頂点シェーダー）で、強さは季節と時間で変える --- */
    let bamboo = null;
    (async () => {
      const dirURL = new URL(BAMBOO_DIR, ROOT);
      const V = await import(new URL('src/VerdantVegetation.js', dirURL).href);
      if (disposed) return;
      const asset = await V.loadVerdantAsset(dirURL.href, { windStrength: 3.0, windSpeed: 2.0, gust: 0.3, distanceWind: { enabled: false, near: 12, far: 30 } });
      if (disposed) { asset.dispose(); return; }
      asset.root.updateMatrixWorld(true);
      const br = mulberry32(4711), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color();
      const place = [];
      for (let i = 0; i < BAMBOO_CLUMPS; i++) {
        let x, z, guard = 0;
        do {
          if (i < 20) { x = -13 + br() * 26; z = -12.5 + br() * 7.2; }                                   // 奥の帯
          else if (i < 30) { x = (br() < 0.5 ? -1 : 1) * (7 + br() * 6.5); z = -6 + br() * 6.5; }      // 左右の端
          else [x, z] = bambooRing(br);                                                                  // 全周の輪（手前・背後も）
          guard++;
        } while ((i < 30 && Math.abs(Math.atan2(x, z)) < 1.05 && Math.hypot(x, z) < 11) && guard < 30);
        place.push({ x, z, s: 2.3 + br() * 1.3, yaw: br() * 6.28, k: 0.8 + br() * 0.3, lean: (br() - 0.5) * 0.05 });
      }
      const ims = [], tintMats = [];
      // 視錐台の外の株を描かないよう、焚火から見た方位 22.5° ずつの扇形ごとに InstancedMesh を分ける（全周に置いても1フレームの描画量が増えない）
      const NSEC = 16, sec = Array.from({ length: NSEC }, () => []);
      place.forEach((p) => sec[Math.floor(((Math.atan2(p.x, p.z) + Math.PI) / (Math.PI * 2)) * NSEC) % NSEC].push(p));
      asset.root.traverse((o) => {
        if (!o.isMesh) return;
        sec.forEach((list) => {
          if (!list.length) return;
          const im = new THREE.InstancedMesh(o.geometry, o.material, list.length);
          list.forEach((p, i) => {
            q.setFromEuler(e.set(p.lean, p.yaw, 0)); m4.compose(new THREE.Vector3(p.x, -0.05, p.z), q, new THREE.Vector3(p.s, p.s, p.s)).multiply(o.matrixWorld);
            im.setMatrixAt(i, m4); im.setColorAt(i, c.setScalar(p.k));
          });
          im.frustumCulled = true; root.add(im); ims.push(im);
        });
        const list = Array.isArray(o.material) ? o.material : [o.material];
        list.forEach((m) => tintMats.push({ m, key: (m.userData && m.userData.verdantMaterial) || m.name || '', base: m.color.clone() }));
      });
      bamboo = { asset, ims, tintMats };
      root.remove(stalks, clusters); stalks.dispose(); clusters.dispose();
      applyBambooTint();
    })().catch((err) => console.warn('[takibi] bamboo asset:', err));
    function applyBambooTint() {
      if (!bamboo) return;
      const t = BAMBOO_TINT[season] || BAMBOO_TINT.summer;
      bamboo.tintMats.forEach(({ m, key, base }) => {
        const k = /stem|culm|trunk/i.test(key) ? t.stem : t.leaf;
        m.color.copy(base).multiply(c3.setRGB(k[0], k[1], k[2]));
        m.emissive.setRGB(t.em[0], t.em[1], t.em[2]);
      });
    }
    const c3 = new THREE.Color();

    /* --- 背後の境: 土塀・木戸・竹垣（庭の外との境）。焚火の背後（+Z）約 7.6m。盆栽・鹿威し・灯籠・枯山水のある側（-Z）の配置は変えない --- */
    const boundary = new THREE.Group(); boundary.position.set(0, 0, WALL_Z); root.add(boundary);
    const snowCaps = [];     // 冬だけ見える雪（塀の瓦・門の屋根・竹垣の笠木）
    {
      const wc = document.createElement('canvas'); wc.width = 128; wc.height = 64;
      { const x = wc.getContext('2d'), r = mulberry32(44); x.fillStyle = '#9a8a70'; x.fillRect(0, 0, 128, 64);
        for (let i = 0; i < 260; i++) { x.fillStyle = r() < 0.5 ? 'rgba(60,45,30,' + (0.05 + r() * 0.12) + ')' : 'rgba(200,185,160,' + (0.05 + r() * 0.12) + ')'; x.fillRect(r() * 128, r() * 64, 2 + r() * 14, 1 + r() * 4); }
        x.fillStyle = 'rgba(70,55,40,0.22)'; for (let k = 1; k < 4; k++) x.fillRect(0, k * 16, 128, 1.4); }
      const wallTex = own(texs, new THREE.CanvasTexture(wc)); wallTex.colorSpace = THREE.SRGBColorSpace; wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;
      const wallMat = own(mats, new THREE.MeshStandardMaterial({ color: 0xc8b89c, map: wallTex, roughness: 1, emissive: 0x2a241a }));
      const tileMat = own(mats, new THREE.MeshStandardMaterial({ color: 0x3a3836, roughness: 0.7, emissive: 0x141414 }));
      const baseMat = own(mats, new THREE.MeshStandardMaterial({ color: 0x5a574f, roughness: 1, flatShading: true }));
      const doorMat = own(mats, new THREE.MeshStandardMaterial({ color: 0x6a4a30, roughness: 0.95, emissive: 0x25170b }));
      const snowM = own(mats, new THREE.MeshLambertMaterial({ color: 0xeef4ff, emissive: 0x1c2630 }));
      const box = (w, h, d, mat, x, y, z, parent = boundary, rx = 0, ry = 0, rz = 0, uvk = 0) => {
        const g = own(geos, new THREE.BoxGeometry(w, h, d));
        if (uvk) { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / uvk, uv.getY(i) * h / uvk); }
        const m = new THREE.Mesh(g, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); parent.add(m); return m;
      };
      const snowOn = (m) => { m.visible = false; snowCaps.push(m); return m; };
      // 土塀: 土台の石・塗り壁・瓦の笠（左右。中央は木戸）
      const wall = (x0, x1) => {
        const len = x1 - x0, cx = (x0 + x1) / 2;
        box(len + 0.04, 0.3, 0.56, baseMat, cx, 0.15, 0);
        box(len, 1.75, 0.4, wallMat, cx, 0.3 + 0.875, 0, boundary, 0, 0, 0, 2.2);
        for (const sd of [-1, 1]) box(len + 0.12, 0.06, 0.34, tileMat, cx, 2.18, sd * 0.13, boundary, sd * 0.5, 0, 0);
        box(len + 0.14, 0.1, 0.14, tileMat, cx, 2.3, 0);
        snowOn(box(len + 0.1, 0.07, 0.5, snowM, cx, 2.37, 0));
      };
      wall(-9, -1.0); wall(1.0, 9);
      // 木戸: 門柱・貫・小さな切妻屋根・扉（片方を少し開けておく）
      for (const sd of [-1, 1]) box(0.2, 2.4, 0.24, doorMat, sd * 0.88, 1.2, 0);
      box(2.1, 0.14, 0.2, doorMat, 0, 2.05, 0);
      for (const sd of [-1, 1]) box(1.3, 0.05, 1.15, doorMat, sd * 0.55, 2.62, 0, boundary, 0, 0, -sd * 0.42);
      box(0.1, 0.1, 1.2, doorMat, 0, 2.86, 0);
      snowOn(box(0.5, 0.06, 1.25, snowM, 0, 2.93, 0));
      {
        const lf = new THREE.Group(); lf.position.set(-0.76, 0, 0.06); lf.rotation.y = -0.2; boundary.add(lf);
        box(0.7, 1.75, 0.05, doorMat, 0.35, 0.95, 0, lf); box(0.7, 0.07, 0.02, wallMat, 0.35, 0.5, 0.035, lf); box(0.7, 0.07, 0.02, wallMat, 0.35, 1.5, 0.035, lf);
        const rf = new THREE.Group(); rf.position.set(0.76, 0, 0.06); rf.rotation.y = Math.PI + 0.75; boundary.add(rf);
        box(0.7, 1.75, 0.05, doorMat, 0.35, 0.95, 0, rf); box(0.7, 0.07, 0.02, wallMat, 0.35, 0.5, 0.035, rf); box(0.7, 0.07, 0.02, wallMat, 0.35, 1.5, 0.035, rf);
      }
      box(0.9, 0.12, 0.7, baseMat, 0, 0.06, -0.45);   // 沓脱ぎの石
      // 竹垣（建仁寺垣）: 土塀の端から左右の竹藪へ、ゆるく曲がって続く。竹の割り材（縦）・3段の胴縁・笠木
      const slatGeo = own(geos, new THREE.CylinderGeometry(0.03, 0.032, 1.7, 5, 1)); slatGeo.translate(0, 0.85, 0);
      const slatMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xb4a870, emissive: 0x1c1a0e }));
      const slatM4 = [], railM4 = [], capM4 = [], capSnowM4 = [];
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3(), fr = mulberry32(606);
      const Yax = new THREE.Vector3(0, 1, 0);
      for (const sd of [-1, 1]) {
        const path = [[9.0, 0], [10.8, -1.2], [12.1, -3.2], [12.8, -5.7], [13.0, -8.4]].map(([x, z]) => [sd * x, WALL_Z + z]);
        for (let k = 0; k < path.length - 1; k++) {
          const [ax, az] = path[k], [bx, bz] = path[k + 1], L = Math.hypot(bx - ax, bz - az), yaw = -Math.atan2(bz - az, bx - ax), n = Math.round(L / 0.115);
          for (let i = 0; i < n; i++) {
            const t = (i + 0.5) / n, h = 0.96 + fr() * 0.08;
            q.setFromEuler(e.set((fr() - 0.5) * 0.03, 0, (fr() - 0.5) * 0.03)); v.set(ax + (bx - ax) * t, 0, az + (bz - az) * t); sc.set(1, h, 1);
            slatM4.push(m4.clone().compose(v, q, sc));
          }
          const mx = (ax + bx) / 2, mz = (az + bz) / 2;
          q.setFromAxisAngle(Yax, yaw);
          for (const y of [0.3, 0.85, 1.4]) railM4.push(m4.clone().compose(v.set(mx, y, mz), q, sc.set(L + 0.02, 0.045, 0.06)));
          capM4.push(m4.clone().compose(v.set(mx, 1.74, mz), q, sc.set(L + 0.04, 0.07, 0.11)));
          capSnowM4.push(m4.clone().compose(v.set(mx, 1.8, mz), q, sc.set(L + 0.04, 0.06, 0.13)));
        }
      }
      const mkI = (geo, mat, list) => { const im = new THREE.InstancedMesh(geo, mat, list.length); list.forEach((m, i) => im.setMatrixAt(i, m)); im.frustumCulled = false; root.add(im); return im; };
      const boxG = own(geos, new THREE.BoxGeometry(1, 1, 1));
      mkI(slatGeo, slatMat, slatM4); mkI(boxG, own(mats, new THREE.MeshLambertMaterial({ color: 0x4a3a24 })), railM4); mkI(boxG, own(mats, new THREE.MeshLambertMaterial({ color: 0x6a5430 })), capM4);
      snowOn(mkI(boxG, snowM, capSnowM4));
    }
    ctx.camBlockers && ctx.camBlockers.push({ x: SH_POS.x, z: SH_POS.z, r: 0.55 }, { x: LANTERN.x, z: LANTERN.z, r: 0.5 },
      { x: STAND.x - 0.7, z: STAND.z, r: 0.36 }, { x: STAND.x, z: STAND.z, r: 0.36 }, { x: STAND.x + 0.7, z: STAND.z, r: 0.36 });   // 鹿威し・石灯籠・盆栽の縁台（カメラが頭を突っ込まない）

    /* --- 落ち葉（秋）・花びら（春）・雪だまり（冬） --- */
    const NLEAF = 90;
    const leafTexM = own(texs, mapleTex());
    const gLeaf = new THREE.InstancedMesh(own(geos, new THREE.PlaneGeometry(0.17, 0.17).rotateX(-Math.PI / 2)), own(mats, new THREE.MeshLambertMaterial({ map: leafTexM, alphaTest: 0.5, side: THREE.DoubleSide })), NLEAF);
    gLeaf.frustumCulled = false; gLeaf.visible = false; root.add(gLeaf);
    const snowTex = own(texs, radialTexture(128, [[0, 'rgba(255,255,255,0.85)'], [0.5, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]));
    const NSNOW = 40;
    const snowPatch = new THREE.InstancedMesh(own(geos, new THREE.CircleGeometry(0.5, 16).rotateX(-Math.PI / 2)), own(mats, new THREE.MeshLambertMaterial({ color: 0xb8c8de, map: snowTex, transparent: true, depthWrite: false })), NSNOW);
    snowPatch.frustumCulled = false; snowPatch.visible = false; root.add(snowPatch);
    {
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color(), lr = mulberry32(88);
      for (let i = 0; i < NLEAF; i++) {
        let x = (lr() - 0.5) * 9, z = -4.5 + lr() * 6.5;
        if (i % 2) { const a = lr() * 6.28, r = 1.6 + Math.sqrt(lr()) * 6.5; x = Math.sin(a) * r; z = Math.cos(a) * r; }   // 全周
        if (Math.hypot(x, z) < 1.4) { gLeaf.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0)); continue; }
        q.setFromEuler(e.set((lr() - 0.5) * 0.3, lr() * 6.28, (lr() - 0.5) * 0.3)); m4.compose(new THREE.Vector3(x, 0.02, z), q, new THREE.Vector3(1, 1, 1).multiplyScalar(0.7 + lr() * 0.8));
        gLeaf.setMatrixAt(i, m4); gLeaf.setColorAt(i, c.setHex([0xc8471c, 0xe0842a, 0xa02c14, 0xd9a12e][i % 4]).multiplyScalar(0.7));
      }
      for (let i = 0; i < NSNOW; i++) {
        let x = (lr() - 0.5) * 11, z = -5 + lr() * 6.8;
        if (i % 2) { const a = lr() * 6.28, r = 1.8 + Math.sqrt(lr()) * 6.5; x = Math.sin(a) * r; z = Math.cos(a) * r; }   // 全周
        if (Math.hypot(x, z) < 1.7) { snowPatch.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0)); continue; }
        const s = 0.6 + lr() * 1.2; q.setFromEuler(e.set(0, lr() * 6, 0)); m4.compose(new THREE.Vector3(x, 0.012, z), q, new THREE.Vector3(s * 1.4, 1, s));
        snowPatch.setMatrixAt(i, m4); snowPatch.setColorAt(i, c.setScalar(0.4 + 0.6 * Math.max(0, 1 - Math.hypot(x, z) / 8)));
      }
    }
    // 春: 梅の花びらが数枚、縁台のまわりに落ちている
    const petals = new THREE.InstancedMesh(own(geos, new THREE.PlaneGeometry(0.05, 0.05).rotateX(-Math.PI / 2)), own(mats, new THREE.MeshLambertMaterial({ color: 0xffd0dc, emissive: 0x3a1a24, side: THREE.DoubleSide })), 24);
    petals.frustumCulled = false; petals.visible = false; root.add(petals);
    { const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), lr = mulberry32(5);
      for (let i = 0; i < 24; i++) { q.setFromEuler(e.set(0, lr() * 6, 0)); m4.compose(new THREE.Vector3(STAND.x + (lr() - 0.5) * 2.0, 0.01, STAND.z + 0.3 + lr() * 0.5), q, new THREE.Vector3(1, 1, 1)); petals.setMatrixAt(i, m4); } }

    /* --- 季節 --- */
    function applySeason(s) {
      season = s; cfg = SEASON[s];
      if (ground) ground.material.color.setRGB(cfg.tint[0], cfg.tint[1], cfg.tint[2]);
      mossMat.color.setHex(cfg.moss);
      bambooMat2.color.setHex(cfg.bamboo); bambooMat2.emissive.setHex(cfg.bamboo).multiplyScalar(0.22); leafMat.color.setHex(cfg.leaf); leafMat.emissive.setHex(cfg.leaf).multiplyScalar(0.2);
      if (cfg.snow) leafMat.color.lerp(new THREE.Color(0xe4eef6), 0.8);
      U.uWind.value = cfg.wind;
      applyBambooTint();
      stoneMat.color.setScalar(cfg.stoneTone); applyLanternTone();
      gLeaf.visible = cfg.groundLeaves > 0; gLeaf.count = cfg.groundLeaves || 1;
      snowPatch.visible = !!cfg.snow; petals.visible = cfg.petals > 0;
      snowCaps.forEach((m) => { m.visible = !!cfg.snow; });
      lamp.snowCap.forEach((m) => { m.visible = !!cfg.snow; }); standSnow.visible = !!cfg.snow;
      buildAllBonsai();
    }

    /* --- 更新 --- */
    let inited = false;
    return {
      setSeason(s) { applySeason(s); },
      update(dt, t, st) {
        curT = t; U.uTime.value = t;
        if (!inited) { inited = true; startCycle(t, rnd(2, 12)); }   // 起動の少しあとに最初の傾きが来るよう、周期の途中から始める
        updateShishi(t);
        // 灯籠: ゆっくり揺らぐ柔らかい灯り
        const fl = 0.88 + 0.07 * Math.sin(t * 1.3) + 0.05 * Math.sin(t * 2.9 + 1) + 0.03 * Math.sin(t * 6.1);
        lamp.light.intensity = 2.0 * fl; lamp.win.color.setRGB(1.0 * fl, 0.62 * fl, 0.28 * fl); lamp.halo.material.opacity = 0.7 * fl;
        U.uWind.value = cfg.wind * (0.8 + 0.4 * Math.sin(t * 0.07));
        if (bamboo) { bamboo.asset.wind.strength = 3.0 * cfg.wind * (0.8 + 0.4 * Math.sin(t * 0.07)); bamboo.asset.update(dt, t, ctx.camera); }
      },
      dispose() {
        disposed = true;
        if (SHI.trickle) { try { SHI.trickle.stop(); } catch (e) {} }
        scene.remove(lamp.light);
        if (shishiGLB) disposeTree(shishiGLB); if (lanternGLB) disposeTree(lanternGLB);
        stalks.dispose(); clusters.dispose();
        if (bamboo) { bamboo.ims.forEach((im) => { root.remove(im); im.dispose(); }); bamboo.asset.dispose(); bamboo = null; }
        if (ground && origGroundColor) ground.material.color.copy(origGroundColor);
        texs.forEach((x) => x.dispose()); geos.forEach((x) => x.dispose()); mats.forEach((x) => x.dispose());
        disposeTree(bonsaiRoot);
      }
    };
  }
};

function smoothstepJS(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
