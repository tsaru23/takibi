// シーン共通の小道具。scene3d.js と各シーンが使う。
import * as THREE from 'three';

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const rnd = (a, b) => a + Math.random() * (b - a);
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const rgb = (hex) => [(hex >> 16 & 255) / 255, (hex >> 8 & 255) / 255, (hex & 255) / 255];

export function radialTexture(size, stops) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d'), h = size / 2, g = x.createRadialGradient(h, h, 0, h, h, h);
  stops.forEach((s) => g.addColorStop(s[0], s[1]));
  x.fillStyle = g; x.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function mergeGeoms(parts) {
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

export function disposeTree(obj) {
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

/* 加算 / 通常合成のポイントスプライト（頂点ごとに大きさ・色・不透明度） */
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
export function makePoints(max, blending, pw, uScale) {
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

/* カメラ手前(+Z)の扇形。木などで塞がない */
export function inCameraWedge(x, z, r) {
  return r < 9 && Math.abs(Math.atan2(x, z)) < 1.0;
}

/* 遠景の丘（地平線を隠す）。角度 th の稜線の高さ。sin の和なので一周でつながる */
export const HILLS = [
  { R: 34, base: 2.7, amp: 0.9, s: [0.7, 2.1, 4.0], color: 0x05070b },
  { R: 60, base: 4.3, amp: 1.5, s: [3.3, 0.4, 5.2], color: 0x090c15 }
];
export function hillH(l, th) {
  return l.base + l.amp * (0.5 * Math.sin(3 * th + l.s[0]) + 0.3 * Math.sin(7 * th + l.s[1]) + 0.2 * Math.sin(13 * th + l.s[2]));
}
/* 半径 r・角度 th での丘の地面の高さ（稜線 R から内側 16m かけて 0 から立ち上がる） */
export function hillGround(l, r, th) {
  return r >= l.R - 16 ? hillH(l, th) * Math.min(1, (r - (l.R - 16)) / 16) : 0;
}

/* ---------- 法線マップをコードで作る小道具（池の水面・枯山水の砂紋など） ---------- */
/* 周期つきの値ノイズ（端がつながる）。size×size の Float32Array（0..1） */
export function tileNoise(size, cells, octaves, seed) {
  const rng = mulberry32(seed | 0), out = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const f = cells * (1 << o), lat = new Float32Array(f * f);
    for (let i = 0; i < lat.length; i++) lat[i] = rng();
    for (let y = 0; y < size; y++) {
      const fy = y / size * f, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = x / size * f, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
        const a = lat[(y0 % f) * f + (x0 % f)], b = lat[(y0 % f) * f + ((x0 + 1) % f)];
        const c = lat[((y0 + 1) % f) * f + (x0 % f)], d = lat[((y0 + 1) % f) * f + ((x0 + 1) % f)];
        out[y * size + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      }
    }
    total += amp; amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}
/* 高さマップ(w×h, 0..1) → 法線マップ(DataTexture)。wrap=true で端をつなぐ */
export function heightToNormalTexture(hgt, w, h, strength, wrap = true) {
  const data = new Uint8Array(w * h * 4);
  const at = (x, y) => {
    if (wrap) { x = (x + w) % w; y = (y + h) % h; } else { x = Math.min(w - 1, Math.max(0, x)); y = Math.min(h - 1, Math.max(0, y)); }
    return hgt[y * w + x];
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength, dy = (at(x, y + 1) - at(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1), o = (y * w + x) * 4;
    data[o] = Math.round((-dx / l * 0.5 + 0.5) * 255); data[o + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255);
    data[o + 2] = Math.round((1 / l * 0.5 + 0.5) * 255); data[o + 3] = 255;
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.wrapS = t.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/* 取りこぼしても困らない GLB の読み込み（assets/models/ の koi.glb など）。
   置いただけでは読まない: assets/plants/manifest.json の "models" 配列に、使うファイル名（例 "koi.glb"）を書いたときだけ読む
   （無いファイルを探して 404 をコンソールに出さないため）。最初の Mesh の geometry と material を返し、
   geometry は原点中心・最大寸法が 1 になるよう正規化する */
let modelListPromise = null;
function modelList(assets) {
  if (!modelListPromise) {
    modelListPromise = fetch(assets.url('assets/plants/manifest.json'), { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null)).then((m) => (m && Array.isArray(m.models) ? m.models : [])).catch(() => []);
  }
  return modelListPromise;
}
export async function loadOptionalModel(assets, file, isStopped) {
  try {
    if (!(await modelList(assets)).includes(file) || isStopped()) return null;
    const gltf = await assets.loadGLTF('assets/models/' + file);
    if (isStopped()) return null;
    let mesh = null;
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
    if (!mesh) return null;
    const geo = mesh.geometry.clone(); geo.applyMatrix4(mesh.matrixWorld);
    geo.computeBoundingBox();
    const bb = geo.boundingBox, c = bb.getCenter(new THREE.Vector3()), s = 1 / Math.max(1e-6, ...bb.getSize(new THREE.Vector3()).toArray());
    geo.translate(-c.x, -c.y, -c.z); geo.scale(s, s, s);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    // 最初の Mesh 以外（frog の目・喉、lotus_flower の茎など）も、同じ移動・拡大をかけて extras に入れる
    const extras = [];
    gltf.scene.traverse((o) => {
      if (!o.isMesh || o === mesh) return;
      const g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld); g.translate(-c.x, -c.y, -c.z); g.scale(s, s, s);
      if (!g.attributes.normal) g.computeVertexNormals();
      extras.push({ name: o.name, geometry: g, material: o.material });
    });
    return { geometry: geo, material: mesh.material, extras };
  } catch (e) { return null; }
}

/* GLB 由来の材質が持つテクスチャを全部集める（dispose 用） */
export function materialTextures(m) {
  const out = [];
  (Array.isArray(m) ? m : [m]).forEach((mm) => { if (mm) for (const k in mm) { const v = mm[k]; if (v && v.isTexture) out.push(v); } });
  return out;
}
