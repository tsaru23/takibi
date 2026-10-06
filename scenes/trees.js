// 遠景の木のシルエット（洞窟の入口の外・川の対岸）。針葉樹（円錐3段）と広葉樹（丸い樹冠）の2種を InstancedMesh で置く。
// 夜なので、ほとんど黒い影。季節で樹冠の色（わずかな自己発光）だけ変える。
import * as THREE from 'three';
import { mulberry32, mergeGeoms } from './util.js';

/* points: [{x, z, s, y?}]。広葉樹の割合 broadleaf（0..1）。root に追加する Group を返す */
export function buildTrees(points, seed, broadleaf = 0.5) {
  const rng = mulberry32(seed), group = new THREE.Group();
  const trunkGeo = new THREE.CylinderGeometry(0.1, 0.16, 1.4, 5); trunkGeo.translate(0, 0.7, 0);
  const cone = (r, h, y) => ({ geo: new THREE.ConeGeometry(r, h, 7), matrix: new THREE.Matrix4().makeTranslation(0, y, 0) });
  const coniGeo = mergeGeoms([cone(1.0, 2.0, 2.0), cone(0.78, 1.8, 3.0), cone(0.5, 1.5, 3.9)]);
  const blob = (r, x, y, z) => ({ geo: new THREE.IcosahedronGeometry(r, 1), matrix: new THREE.Matrix4().makeTranslation(x, y, z) });
  const crownGeo = mergeGeoms([blob(1.15, 0, 2.7, 0), blob(0.85, 0.7, 2.2, 0.2), blob(0.8, -0.7, 2.3, -0.2), blob(0.7, 0.1, 3.4, 0.4)]);
  const A = [], B = [];
  points.forEach((p) => (rng() < broadleaf ? B : A).push(p));
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x0c0a0a });
  const coniMat = new THREE.MeshLambertMaterial({ color: 0x0b1410, emissive: 0x050a08 });
  const crownMat = new THREE.MeshLambertMaterial({ color: 0x0d1812, emissive: 0x0a1810 });
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
  const mk = (geo, mat, list, withTrunk) => {
    if (!list.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, list.length), tr = withTrunk ? new THREE.InstancedMesh(trunkGeo, trunkMat, list.length) : null;
    list.forEach((p, i) => {
      const s = p.s * (0.85 + rng() * 0.3);
      q.setFromEuler(e.set(0, rng() * 6.28, 0)); v.set(p.x, p.y || 0, p.z); sc.set(s * (0.9 + rng() * 0.2), s * (0.9 + rng() * 0.3), s * (0.9 + rng() * 0.2));
      m4.compose(v, q, sc); im.setMatrixAt(i, m4); if (tr) tr.setMatrixAt(i, m4);
      im.setColorAt(i, col.setScalar(0.7 + rng() * 0.6));
    });
    im.frustumCulled = false; group.add(im);
    if (tr) { tr.frustumCulled = false; group.add(tr); }
    return im;
  };
  const coni = mk(coniGeo, coniMat, A, true), crown = mk(crownGeo, crownMat, B, true);
  return {
    group,
    /* 樹冠の色: 広葉樹は season 色（自己発光で、暗くても色味が分かる）、針葉樹は暗い緑のまま（冬は青みを足す） */
    setColors(crownColor, crownEmissive, coniEmissive) {
      crownMat.color.setHex(crownColor); crownMat.emissive.setHex(crownEmissive);
      coniMat.emissive.setHex(coniEmissive);
    },
    dispose() {
      [trunkGeo, coniGeo, crownGeo].forEach((g) => g.dispose());
      [trunkMat, coniMat, crownMat].forEach((m) => m.dispose());
      group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    }
  };
}

/* 葉・花びらの形（コードで生成した白いシルエット。色は instance 色で付ける）。kind: 'petal' | 'maple' */
export function leafTexture(kind) {
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
