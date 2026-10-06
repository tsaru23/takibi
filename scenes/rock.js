// 岩・石の共通部品（洞窟・川が使う）: 3次元の値ノイズ、岩の法線マップ（コード生成）、頂点ノイズで崩した丸い石。
import * as THREE from 'three';
import { tileNoise, heightToNormalTexture } from './util.js';

export function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
export function vnoise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), u), l(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), u), v),
    l(l(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), u), l(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), u), v), w);
}
/* 0..1 に正規化した fbm */
export function fbm3(x, y, z, oct = 4) {
  let a = 0.5, s = 0, f = 1, tot = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise3(x * f, y * f, z * f); tot += a; a *= 0.5; f *= 2.03; }
  return s / tot;
}

/* 岩肌の法線マップ（端がつながる）。尾根状のノイズ（割れ目・段）に細かい粒を足した高さマップから作る */
export function rockNormalMap(size = 256, seed = 5, strength = 6) {
  const a = tileNoise(size, 5, 4, seed), b = tileNoise(size, 14, 3, seed + 7), c = tileNoise(size, 3, 2, seed + 13);
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) {
    const ridge = 1 - Math.abs(a[i] * 2 - 1);
    h[i] = 0.55 * ridge * ridge + 0.3 * b[i] + 0.15 * c[i];
  }
  return heightToNormalTexture(h, size, size, strength, true);
}

/* 頂点ノイズで崩した球（岩・石）。法線は元の球の向きにして、なめらかに見せる。
   座標だけから変位を決めるので、同じ位置の頂点は同じに動き、割れない */
export function noisedRockGeometry(detail, seed, rough = 0.3, flat = false) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position, n = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    n[i * 3] = x; n[i * 3 + 1] = y; n[i * 3 + 2] = z;
    const k = 1 + rough * (fbm3(x * 1.7 + seed, y * 1.7 + seed * 0.7, z * 1.7 - seed, 3) - 0.5) * 2;
    p.setXYZ(i, x * k, y * k, z * k);
  }
  if (flat) g.computeVertexNormals();
  else g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  return g;
}
