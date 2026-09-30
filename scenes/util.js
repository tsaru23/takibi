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
