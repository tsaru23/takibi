// シーン「庭園・竹藪」。鹿威し、石灯籠、縁台の盆栽（松・もみじ・梅）、風にしなる竹藪、苔の地面と飛び石、枯山水の砂紋。
// 形式は scenes/index.js のコメントを参照。
import * as THREE from 'three';
import { mulberry32, rnd, clamp, mergeGeoms, tileNoise, heightToNormalTexture, radialTexture, disposeTree } from './util.js';

/* ---------- 配置（x は右、z は奥がマイナス。カメラは +Z 側から焚火を見る） ---------- */
const SH_POS = { x: 2.3, z: -1.3 };          // 鹿威し
const LANTERN = { x: 3.5, z: -3.1 };         // 石灯籠
const STAND = { x: -1.0, z: -2.7, len: 1.9 }; // 盆栽の縁台
const SAND = { x: -3.2, z: -0.9, w: 2.6, d: 1.8 };   // 枯山水

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
const BAMBOO_N = 110, CLUSTERS = 3;

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
  audio: { autoOn: ['bamboo', 'scenesfx'], reverb: { seconds: 1.6, decay: 3, wet: 0.22 } },
  props: { logPile: { x: -2.0, z: 0.6, rotY: 0.35 } },   // 枯山水（x -4.5〜-1.9, z -1.8〜0）に重ならない手前へ

  build(ctx) {
    const { scene, root, api, ground } = ctx;
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
    const NMOSS = 40, mossGeo = own(geos, new THREE.CircleGeometry(1, 16)); mossGeo.rotateX(-Math.PI / 2);
    const moss = new THREE.InstancedMesh(mossGeo, mossMat, NMOSS); moss.frustumCulled = false;
    {
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color(), mr = mulberry32(61);
      for (let i = 0; i < NMOSS; i++) {
        let x = (mr() - 0.5) * 11, z = -5 + mr() * 6.6; const s = 0.5 + mr() * 1.1; if (Math.hypot(x, z) < 2.4) { x *= 2.2; z = z * 2.2 - 1; }
        q.setFromEuler(e.set(0, mr() * 6, 0)); m4.compose(new THREE.Vector3(x, 0.006 + i * 0.00005, z), q, new THREE.Vector3(s * (1 + mr()), 1, s));
        moss.setMatrixAt(i, m4); moss.setColorAt(i, c.setScalar(0.75 + mr() * 0.5));
      }
      root.add(moss);
    }

    /* --- 飛び石 --- */
    {
      const stoneGeo = own(geos, new THREE.CylinderGeometry(1, 1.1, 0.07, 9));
      const pos = [[1.5, 2.5], [1.95, 1.6], [2.3, 0.7], [2.45, -0.2], [-1.0, -1.35], [-0.75, -1.9], [-2.0, 1.8], [-2.5, 1.0], [-2.3, 0.2]];
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
    const sh = new THREE.Group(); sh.position.set(SH_POS.x, 0, SH_POS.z); root.add(sh);
    const bambooMat = own(mats, new THREE.MeshLambertMaterial({ color: 0x7a8a3c }));
    const bambooDark = own(mats, new THREE.MeshLambertMaterial({ color: 0x4e5a24 }));
    const woodMat = own(mats, new THREE.MeshLambertMaterial({ color: 0x6b4a2c }));
    const TH_REST = -0.42, TH_TIP = 0.75, TS = 1.9, PIV_Y = 0.85;
    const tube = new THREE.Group(); tube.position.set(0, PIV_Y, 0); tube.scale.setScalar(TS); sh.add(tube);
    let waterBox, pourSheet, stream, rings = [];
    {
      const trough = own(geos, new THREE.CylinderGeometry(0.04, 0.04, 0.3, 12, 1, true, Math.PI * 0.9, Math.PI * 1.2)); trough.rotateZ(Math.PI / 2); trough.translate(-0.15, 0, 0);
      const tm = own(mats, new THREE.MeshLambertMaterial({ color: 0x7a8a3c, side: THREE.DoubleSide }));
      tube.add(new THREE.Mesh(trough, tm));
      const rear = own(geos, new THREE.CylinderGeometry(0.04, 0.04, 0.22, 12)); rear.rotateZ(Math.PI / 2); rear.translate(0.11, 0, 0);
      tube.add(new THREE.Mesh(rear, bambooMat));
      const ring = own(geos, new THREE.CylinderGeometry(0.044, 0.044, 0.012, 12)); ring.rotateZ(Math.PI / 2);
      [-0.02, 0.2, -0.28].forEach((x) => { const r = new THREE.Mesh(ring, bambooDark); r.position.x = x; tube.add(r); });
      const wg = own(geos, new THREE.BoxGeometry(1, 0.05, 0.07));
      waterBox = new THREE.Mesh(wg, own(mats, new THREE.MeshLambertMaterial({ color: 0x9fd0f0, emissive: 0x1a3048, transparent: true, opacity: 0.8 }))); waterBox.position.set(-0.01, -0.012, 0); waterBox.visible = false; tube.add(waterBox);
      // 軸と支柱
      const post = own(geos, new THREE.CylinderGeometry(0.026, 0.03, 0.95, 8)); post.translate(0, 0.475, 0);
      [-0.09, 0.09].forEach((z) => { const p = new THREE.Mesh(post, bambooMat); p.position.set(0, 0, z); sh.add(p); });
      const axle = own(geos, new THREE.CylinderGeometry(0.012, 0.012, 0.24, 8)); axle.rotateX(Math.PI / 2);
      const ax = new THREE.Mesh(axle, woodMat); ax.position.set(0, PIV_Y, 0); sh.add(ax);
      // 竹の樋（右から左へ、わずかに下る）と支柱
      const fl = own(geos, new THREE.CylinderGeometry(0.05, 0.05, 0.8, 10, 1, true, Math.PI * 0.9, Math.PI * 1.2));
      const flume = new THREE.Mesh(fl, own(mats, new THREE.MeshLambertMaterial({ color: 0x7a8a3c, side: THREE.DoubleSide })));
      flume.rotation.z = Math.PI / 2 - 0.28; flume.position.set(-0.93, 1.41, 0); sh.add(flume);
      const fp = own(geos, new THREE.CylinderGeometry(0.022, 0.028, 1, 6)); fp.translate(0, 0.5, 0);
      const fpm = new THREE.Mesh(fp, bambooMat); fpm.position.set(-1.2, 0, 0); fpm.scale.y = 1.45; sh.add(fpm);
      const fp2 = new THREE.Mesh(fp, bambooMat); fp2.position.set(-0.75, 0, 0); fp2.scale.y = 1.33; sh.add(fp2);
      // 落ちる水
      const st = own(geos, new THREE.CylinderGeometry(0.0055, 0.0055, 1, 5)); st.translate(0, -0.5, 0);
      stream = new THREE.Mesh(st, own(mats, new THREE.MeshBasicMaterial({ map: own(texs, stripeTex()), transparent: true, depthWrite: false, opacity: 0.85 }))); stream.position.set(-0.53, 1.29, 0); stream.scale.set(1, 0.2, 1); stream.renderOrder = 3; sh.add(stream);
      const sg = own(geos, new THREE.BoxGeometry(0.03, 1, 0.07)); sg.translate(0, -0.5, 0);
      pourSheet = new THREE.Mesh(sg, own(mats, new THREE.MeshBasicMaterial({ color: 0xcfe6ff, transparent: true, opacity: 0.7, depthWrite: false }))); pourSheet.visible = false; pourSheet.renderOrder = 3; sh.add(pourSheet);
      // 打たれる石
      const sg2 = own(geos, new THREE.CylinderGeometry(0.11, 0.14, 0.6, 9)); sg2.translate(0, 0.3, 0);
      const stn = new THREE.Mesh(sg2, own(mats, new THREE.MeshStandardMaterial({ color: 0x5c5a54, roughness: 0.95, flatShading: true }))); stn.position.set(0.4, 0, 0); stn.scale.set(1.1, 1, 0.9); sh.add(stn);
      // 受けの石鉢（水面は動く波紋）
      const bg = own(geos, new THREE.CylinderGeometry(0.27, 0.3, 0.26, 14)); bg.translate(0, 0.13, 0);
      const bm = own(mats, new THREE.MeshStandardMaterial({ color: 0x5a5852, roughness: 0.95, flatShading: true }));
      const basin = new THREE.Mesh(bg, bm); basin.position.set(-0.45, 0, 0); sh.add(basin);
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
      SHI.trickle = api.playSfx && SHI.tFill - skip > 1 ? api.playSfx('trickle', { dur: SHI.tFill - skip, pan: 0.3 }) : null;
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
          api.playSfx && api.playSfx('kakon', { delay: remain, pan, vol: rnd(0.85, 1) });
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
      waterBox.visible = len > 0.003; waterBox.scale.x = Math.max(0.001, len); waterBox.position.x = -len / 2 - 0.012; waterBox.position.y = -0.016 + 0.002;
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
    function ctxSfx(name, dx, p, delay) { api.playSfx && api.playSfx(name, { vol: 1, pan: p, delay: delay || 0 }); }

    /* --- 石灯籠 --- */
    const lantern = new THREE.Group(); lantern.position.set(LANTERN.x, 0, LANTERN.z); root.add(lantern);
    const stoneMat = own(mats, new THREE.MeshStandardMaterial({ color: 0x74716a, roughness: 0.95, flatShading: true }));
    const lamp = { light: new THREE.PointLight(0xffa860, 2, 5.5, 2), win: null, halo: null, snowCap: [] };
    {
      const add = (geo, y, mat = stoneMat) => { const m = new THREE.Mesh(own(geos, geo), mat); m.position.y = y; lantern.add(m); return m; };
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
        const isZ = i % 2 === 0; w.position.set(isZ ? 0 : x, 0.87, isZ ? z : 0); w.rotation.y = isZ ? (i === 0 ? 0 : Math.PI) : (i === 1 ? Math.PI / 2 : -Math.PI / 2); lantern.add(w);
      });
      const hm = own(mats, new THREE.SpriteMaterial({ map: own(texs, radialTexture(64, [[0, 'rgba(255,190,110,0.9)'], [0.35, 'rgba(255,150,70,0.3)'], [1, 'rgba(255,120,40,0)']])), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
      lamp.halo = new THREE.Sprite(hm); lamp.halo.position.set(0, 0.87, 0); lamp.halo.scale.setScalar(1.3); lantern.add(lamp.halo);
      // 雪（冬）
      const snowMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xeef4ff, emissive: 0x1c2630 }));
      const roofSnow = new THREE.Mesh(own(geos, new THREE.CylinderGeometry(0.0, 0.5, 0.2, 6)), snowMat); roofSnow.position.y = 1.22; lantern.add(roofSnow);
      const topSnow = new THREE.Mesh(own(geos, new THREE.SphereGeometry(0.075, 8, 6)), snowMat); topSnow.scale.y = 0.6; topSnow.position.y = 1.4; lantern.add(topSnow);
      const baseSnow = new THREE.Mesh(own(geos, new THREE.CylinderGeometry(0.24, 0.28, 0.04, 8)), snowMat); baseSnow.position.y = 0.14; lantern.add(baseSnow);
      lamp.snowCap = [roofSnow, topSnow, baseSnow];
      lamp.light.position.set(LANTERN.x, 0.95, LANTERN.z); scene.add(lamp.light);
    }

    /* --- 縁台と盆栽 --- */
    const stand = new THREE.Group(); stand.position.set(STAND.x, 0, STAND.z); root.add(stand);
    {
      const top = new THREE.Mesh(own(geos, new THREE.BoxGeometry(STAND.len, 0.06, 0.46)), woodMat); top.position.y = 0.5; stand.add(top);
      const lg = own(geos, new THREE.BoxGeometry(0.06, 0.5, 0.06));
      [[-0.88, -0.19], [0.88, -0.19], [-0.88, 0.19], [0.88, 0.19]].forEach(([x, z]) => { const l = new THREE.Mesh(lg, woodMat); l.position.set(x, 0.25, z); stand.add(l); });
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
        const tree = buildBonsai(kind, cfg, 300 + i * 17); tree.position.y = 0.08; tree.scale.setScalar(1.25); g.add(tree);
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
          else { x = (br() < 0.5 ? -1 : 1) * (6.2 + br() * 7); z = -6 + br() * 9.5; }                  // 左右の端
          guard++;
        } while ((Math.abs(Math.atan2(x, z)) < 1.05 && Math.hypot(x, z) < 11) && guard < 30);
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
        const x = (lr() - 0.5) * 9, z = -4.5 + lr() * 6.5;
        if (Math.hypot(x, z) < 1.4) { gLeaf.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0)); continue; }
        q.setFromEuler(e.set((lr() - 0.5) * 0.3, lr() * 6.28, (lr() - 0.5) * 0.3)); m4.compose(new THREE.Vector3(x, 0.02, z), q, new THREE.Vector3(1, 1, 1).multiplyScalar(0.7 + lr() * 0.8));
        gLeaf.setMatrixAt(i, m4); gLeaf.setColorAt(i, c.setHex([0xc8471c, 0xe0842a, 0xa02c14, 0xd9a12e][i % 4]).multiplyScalar(0.7));
      }
      for (let i = 0; i < NSNOW; i++) {
        const x = (lr() - 0.5) * 11, z = -5 + lr() * 6.8;
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
      stoneMat.color.setScalar(cfg.stoneTone);
      gLeaf.visible = cfg.groundLeaves > 0; gLeaf.count = cfg.groundLeaves || 1;
      snowPatch.visible = !!cfg.snow; petals.visible = cfg.petals > 0;
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
      },
      dispose() {
        disposed = true;
        if (SHI.trickle) { try { SHI.trickle.stop(); } catch (e) {} }
        scene.remove(lamp.light);
        if (ground && origGroundColor) ground.material.color.copy(origGroundColor);
        texs.forEach((x) => x.dispose()); geos.forEach((x) => x.dispose()); mats.forEach((x) => x.dispose());
        disposeTree(bonsaiRoot);
      }
    };
  }
};

function smoothstepJS(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
