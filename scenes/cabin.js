// シーン「ログハウス」。森の中の小さなログハウス（丸太の壁・三角屋根・煙突・ポーチと手すり）の前で焚火。
// 窓の暖かい光が地面に落ち、ポーチにランタン、横に薪棚、手前に斧の刺さった切り株。周りは森と FABOTANIC の草地。
// 形式は scenes/index.js のコメントを参照。家は低ポリゴンの丸太の積み重ね（InstancedMesh）。
// Blender 製に差し替えるとき: assets/models/cabin.glb を置き、assets/plants/manifest.json の "models" に "cabin.glb" を書く（util.loadOptionalModel）。
//   最初の Mesh の形と材質を、壁・屋根・煙突・ポーチの代わりに使う（窓の光・ドア・ランタン・薪棚はコードのまま）。
//   玄関（ポーチ側）が +Z、棟の向きが Z、いちばん長い辺が 7m になるよう正規化して、原点（家の中心）に置く。窓は家の前面 x=±1.4, y=1.3 の位置に重ねている。
import * as THREE from 'three';
import { mulberry32, rnd, clamp, radialTexture, mergeGeoms, makePoints, HILLS, hillGround, loadOptionalModel } from './util.js';
import { collectFieldEntries, loadField, applyFieldLevel, applyFieldTint } from './forest.js';
import { makeSnowPoints } from './snow.js';
import { loadFarTrees, inSkyClearing } from './farTrees.js';

/* 家の位置（焚火の奥・やや左）と向き（焚火の方へ少し振る）。寸法は家のローカル座標（+Z が玄関側）*/
const CAB = { x: -3.1, z: -8.6, ry: 0.32 };
const W = 4.4, D = 4.6, R = 0.135, S = 0.245, NC = 9;        // 幅・奥行き・丸太の半径・段の間隔・壁の段数
const Y0 = 0.14, Y_TOP = Y0 + (NC - 1) * S + R;               // 最下段の中心の高さ / 壁の上面
const HALF = W / 2 + 0.35, RISE = 1.6, ALPHA = Math.atan2(RISE, HALF), SLANT = Math.hypot(HALF, RISE);
const Y_RIDGE = Y_TOP + (W / 2) * (RISE / HALF) + 0.06;
const ROOF_Z0 = -D / 2 - 0.35, ROOF_Z1 = D / 2 + 1.5, ROOF_ZC = (ROOF_Z0 + ROOF_Z1) / 2, ROOF_L = ROOF_Z1 - ROOF_Z0;
const PORCH_Z = D / 2 + 1.5;                                  // ポーチの先端
const WIN_X = [-1.45, 1.45], WIN_Y = 1.3;

const SEASON = {
  spring: { trees: [0x9ccf86, 0x88c078, 0xb5d99a], win: 1.0, snow: 0, leaves: 0, petals: true, ff: 1, owlish: 1 },
  summer: { trees: [0x1f5a2a, 0x276b32, 0x184a22], win: 1.0, snow: 0, leaves: 0, petals: false, ff: 1.4 },
  autumn: { trees: [0xc0431b, 0xe07a24, 0xa02a14, 0xd9a12e], win: 1.0, snow: 0, leaves: 1, petals: false, ff: 1 },
  winter: { trees: [0x1a3324, 0x12281c, 0x203c2b], win: 1.3, snow: 1, leaves: 0, petals: false, ff: 1 }
};
/* 草地（FABOTANIC）の量。家・丸太の壁・森で三角形を使うので、森（manifest の levels）より絞る。
   ふつうで全体 30 万三角形以下。カメラ手前の扇形には元から置かない。使う複製は焚火の背後の弧（slots 1〜3）のままで、1 つあたりの密度を下げる */
const FIELD_LEVELS = {
  many: { slots: [0, 1, 2, 3, 4], density: 0.3 },
  normal: { slots: [1, 2, 3], density: 0.38 },
  few: { slots: [1, 2, 3], density: 0.17 }
};
const GROUND_TINT = { spring: [1, 1, 1], summer: [1, 1, 1], autumn: [1, 0.96, 0.9], winter: [2.1, 2.3, 2.7] };
const LEAF_COLORS = [0xc8471c, 0xe0842a, 0xa02c14, 0xd9a12e];

function leafTex(kind) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.strokeStyle = '#fff'; x.lineCap = 'round';
  if (kind === 'petal') {
    x.beginPath(); x.moveTo(32, 58); x.bezierCurveTo(4, 42, 8, 10, 26, 6); x.lineTo(32, 15); x.lineTo(38, 6); x.bezierCurveTo(56, 10, 60, 42, 32, 58); x.fill();
  } else {
    x.beginPath();
    for (let i = 0; i <= 90; i++) { const th = i / 90 * Math.PI * 2, r = 29 * (0.34 + 0.66 * Math.pow(Math.abs(Math.cos(2.5 * (th - Math.PI / 2))), 1.6)); const px = 32 + Math.cos(th) * r, py = 30 - Math.sin(th) * r; if (i) x.lineTo(px, py); else x.moveTo(px, py); }
    x.closePath(); x.fill(); x.lineWidth = 3; x.beginPath(); x.moveTo(32, 30); x.lineTo(32, 62); x.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function barkTex() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const x = c.getContext('2d'), r = mulberry32(3);
  x.fillStyle = '#7a5434'; x.fillRect(0, 0, 128, 64);
  for (let i = 0; i < 150; i++) { x.fillStyle = r() < 0.6 ? 'rgba(30,18,10,' + (0.15 + r() * 0.3) + ')' : 'rgba(180,130,80,' + (0.1 + r() * 0.2) + ')'; x.fillRect(r() * 128, 0, 0.6 + r() * 2.4, 64); }
  for (let i = 0; i < 40; i++) { x.fillStyle = 'rgba(25,15,8,' + (0.2 + r() * 0.3) + ')'; x.fillRect(r() * 128, r() * 64, 2 + r() * 5, 0.6 + r() * 1.2); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; return t;
}
function shingleTex() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d'), r = mulberry32(9);
  for (let row = 0; row < 4; row++) for (let tab = 0; tab < 6; tab++) {
    const v = 0.78 + r() * 0.4; x.fillStyle = `rgb(${Math.round(70 * v)},${Math.round(54 * v)},${Math.round(46 * v)})`;
    x.fillRect(row * 32, tab * 21.33 + (row % 2) * 10, 32, 21.4);
    x.fillStyle = 'rgba(0,0,0,0.5)'; x.fillRect(row * 32, tab * 21.33 + (row % 2) * 10, 32, 1.2); x.fillRect(row * 32 + 30, tab * 21.33 + (row % 2) * 10, 2, 21);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; return t;
}
/* log.glb の最初の丸太を、長い軸を +Y・長さ 1・原点中心に正規化して返す（薪棚用） */
function normalizedLog(gltf) {
  let mesh = null; gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { if (!mesh && o.isMesh && /^log_/i.test(o.name)) { const g = o.geometry; g.computeBoundingBox(); const b = g.boundingBox; if (b.max.y - b.min.y > 0.02 || true) mesh = o; } });
  if (!mesh) gltf.scene.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
  if (!mesh) return null;
  const g = mesh.geometry.clone(); g.applyMatrix4(mesh.matrixWorld); g.computeBoundingBox();
  const sz = g.boundingBox.getSize(new THREE.Vector3()), c = g.boundingBox.getCenter(new THREE.Vector3());
  g.translate(-c.x, -c.y, -c.z);
  const len = Math.max(sz.x, sz.y, sz.z);
  if (sz.x === len) g.rotateZ(Math.PI / 2); else if (sz.z === len) g.rotateX(Math.PI / 2);
  g.scale(1 / len, 1 / len, 1 / len); g.computeBoundingBox();
  const b = g.boundingBox;
  return { geo: g, mat: Array.isArray(mesh.material) ? mesh.material[0] : mesh.material, thick: Math.max(b.max.x - b.min.x, b.max.z - b.min.z) };
}

export default {
  id: 'cabin',
  label: 'ログハウス',
  audio: { autoOn: ['owl', 'scenesfx'], reverb: { seconds: 2.4, decay: 3.2, wet: 0.26 } },

  build(ctx) {
    const { scene, root, api, assets, ground, uScale, camera } = ctx;
    let disposed = false, season = '', cfg = SEASON.summer, curT = 0;
    const isStopped = () => disposed || ctx.isStopped();
    const texs = [], geos = [], mats = [], lights = [];
    const own = (list, x) => { list.push(x); return x; };
    const rng = mulberry32(8128);
    const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), QS = new THREE.Quaternion(), E = new THREE.Euler(), V = new THREE.Vector3(), SC = new THREE.Vector3(), COL = new THREE.Color();
    const Y_AX = new THREE.Vector3(0, 1, 0);

    const cab = new THREE.Group(); cab.position.set(CAB.x, 0, CAB.z); cab.rotation.y = CAB.ry; root.add(cab);
    const body = new THREE.Group(); cab.add(body);          // GLB に差し替えるとき隠す部分
    const detail = new THREE.Group(); cab.add(detail);
    cab.updateMatrixWorld(true);
    const toWorld = (x, y, z) => cab.localToWorld(new THREE.Vector3(x, y, z));

    const bark = own(texs, barkTex()), shingle = own(texs, shingleTex());
    const woodMat = own(mats, new THREE.MeshStandardMaterial({ color: 0xffffff, map: bark, roughness: 0.95 }));
    const endMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xc09a68 }));
    const darkWood = own(mats, new THREE.MeshStandardMaterial({ color: 0x4a3322, roughness: 0.95 }));
    const plankMat = own(mats, new THREE.MeshStandardMaterial({ color: 0x6a4c34, roughness: 0.95 }));
    const snowMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xeef4ff, emissive: 0x1c2630 }));
    const snowObjs = [];     // 冬だけ見えるもの
    const addSnow = (geo, parent, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, snowMat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.visible = false; parent.add(m); snowObjs.push(m); return m; };

    /* --- 丸太の壁（InstancedMesh）--- */
    const logGeo = own(geos, new THREE.CylinderGeometry(1, 1, 1, 7, 1));
    {
      const items = [];       // {x,y,z, axis:'x'|'z', len}
      for (let i = 0; i < NC; i++) {
        const y = Y0 + i * S;
        for (const sz of [1, -1]) items.push({ x: 0, y, z: sz * D / 2, axis: 'x', len: W + 0.7 });
        for (const sx of [1, -1]) items.push({ x: sx * W / 2, y: y + S / 2 * (i < NC - 1 ? 1 : 0), z: 0, axis: 'z', len: D + 0.7 });
      }
      // 前後の三角（妻面）: 段ごとに短くして屋根の線に合わせる
      for (let k = 1; k <= 6; k++) {
        const y = Y0 + (NC - 1) * S + k * S, wd = W * (1 - (y + R - Y_TOP) / ((W / 2) * (RISE / HALF)));
        if (wd < 0.3) break;
        for (const sz of [1, -1]) items.push({ x: 0, y, z: sz * D / 2, axis: 'x', len: wd + 0.1 });
      }
      const im = new THREE.InstancedMesh(logGeo, [woodMat, endMat, endMat], items.length);
      items.forEach((it, i) => {
        const r = R * (0.93 + rng() * 0.12);
        Q.setFromEuler(E.set(it.axis === 'x' ? 0 : Math.PI / 2, 0, it.axis === 'x' ? Math.PI / 2 : 0)); QS.setFromAxisAngle(Y_AX, rng() * 6.28); Q.multiply(QS);
        M4.compose(V.set(it.x, it.y, it.z), Q, SC.set(r, it.len * (0.98 + rng() * 0.04), r)); im.setMatrixAt(i, M4);
        im.setColorAt(i, COL.setScalar(0.72 + rng() * 0.5));
      });
      im.frustumCulled = false; body.add(im);
      // 土台の石（地面との境目）
      const sg = own(geos, new THREE.BoxGeometry(1, 1, 1)), sm = own(mats, new THREE.MeshStandardMaterial({ color: 0x4b4944, roughness: 1, flatShading: true }));
      const st = new THREE.InstancedMesh(sg, sm, 18);
      for (let i = 0; i < 18; i++) {
        const a = i / 18 * 4, side = Math.floor(i / 4.5) % 4, t = (i % 5) / 4.2 - 0.5;
        const px = side === 0 ? t * W : side === 1 ? W / 2 : side === 2 ? -t * W : -W / 2, pz = side === 0 ? D / 2 : side === 1 ? t * D : side === 2 ? -D / 2 : -t * D;
        Q.setFromEuler(E.set(0, rng() * 0.4, 0)); M4.compose(V.set(px, 0.06, pz), Q, SC.set(0.5 + rng() * 0.3, 0.14 + rng() * 0.06, 0.45)); st.setMatrixAt(i, M4); st.setColorAt(i, COL.setScalar(0.7 + rng() * 0.6)); void a;
      }
      st.frustumCulled = false; body.add(st);
    }

    /* --- 屋根（左右2枚）と棟・煙突 --- */
    const shMat = own(mats, new THREE.MeshStandardMaterial({ color: 0xffffff, map: shingle, roughness: 0.95 }));
    shingle.repeat.set(1, 1);
    const roofMats = [darkWood, darkWood, shMat, own(mats, new THREE.MeshLambertMaterial({ color: 0x2a1e16 })), darkWood, darkWood];
    const roofGeo = own(geos, new THREE.BoxGeometry(SLANT, 0.1, ROOF_L));
    {
      // 箱の上面の UV は面全体に 0..1 なので、瓦の繰り返しは UV を直接スケールする
      const uv = roofGeo.attributes.uv; const top = 4 * 2;      // +Y 面は 3 番目（頂点 8..11）
      for (let i = top; i < top + 4; i++) uv.setXY(i, uv.getX(i) * 7, uv.getY(i) * 5);
    }
    const roofSnowGeo = own(geos, new THREE.BoxGeometry(SLANT + 0.06, 0.13, ROOF_L + 0.06));
    const roofLeafGeo = own(geos, new THREE.PlaneGeometry(0.17, 0.17).rotateX(-Math.PI / 2));
    const leafT = own(texs, leafTex('maple')), petalT = own(texs, leafTex('petal'));
    const leafMat = own(mats, new THREE.MeshLambertMaterial({ map: leafT, alphaTest: 0.5, side: THREE.DoubleSide, emissive: 0x241208 }));
    const roofLeaves = [];
    for (const sd of [1, -1]) {
      const pv = new THREE.Group(); pv.position.set(0, Y_RIDGE, ROOF_ZC); pv.rotation.z = -sd * ALPHA; body.add(pv);
      const m = new THREE.Mesh(roofGeo, roofMats); m.position.set(sd * SLANT / 2, -0.05, 0); pv.add(m);
      const sn = new THREE.Mesh(roofSnowGeo, snowMat); sn.position.set(sd * SLANT / 2, 0.06, 0); sn.visible = false; pv.add(sn); snowObjs.push(sn);
      const lv = new THREE.InstancedMesh(roofLeafGeo, leafMat, 26); lv.visible = false; lv.frustumCulled = false;
      for (let i = 0; i < 26; i++) {
        Q.setFromEuler(E.set((rng() - 0.5) * 0.2, rng() * 6.28, (rng() - 0.5) * 0.2)); M4.compose(V.set(sd * (0.2 + rng() * (SLANT - 0.4)), 0.02 + rng() * 0.01, (rng() - 0.5) * (ROOF_L - 0.4)), Q, SC.setScalar(0.8 + rng() * 0.7));
        lv.setMatrixAt(i, M4); lv.setColorAt(i, COL.setHex(LEAF_COLORS[i % 4]).multiplyScalar(0.7));
      }
      pv.add(lv); roofLeaves.push(lv);
    }
    {
      const rg = own(geos, new THREE.BoxGeometry(0.14, 0.12, ROOF_L + 0.1)); const rm = new THREE.Mesh(rg, darkWood); rm.position.set(0, Y_RIDGE + 0.03, ROOF_ZC); body.add(rm);
      addSnow(own(geos, new THREE.BoxGeometry(0.34, 0.1, ROOF_L + 0.1)), body, 0, Y_RIDGE + 0.12, ROOF_ZC);
      // 煙突（石積み）
      const cx = 1.15, cz = -0.9, topY = 4.45, botY = 2.0;
      const cg = own(geos, new THREE.BoxGeometry(0.56, topY - botY, 0.56));
      const cc = document.createElement('canvas'); cc.width = cc.height = 64; const x = cc.getContext('2d'), cr = mulberry32(5);
      x.fillStyle = '#5a5650'; x.fillRect(0, 0, 64, 64);
      for (let r = 0; r < 8; r++) for (let k = 0; k < 4; k++) { const v = 0.7 + cr() * 0.6; x.fillStyle = `rgb(${Math.round(100 * v)},${Math.round(94 * v)},${Math.round(88 * v)})`; x.fillRect(k * 16 + (r % 2) * 8 - 8, r * 8 + 1, 15, 7); }
      const ct = own(texs, new THREE.CanvasTexture(cc)); ct.colorSpace = THREE.SRGBColorSpace; ct.wrapS = ct.wrapT = THREE.RepeatWrapping; ct.repeat.set(1, 3.5);
      const chim = new THREE.Mesh(cg, own(mats, new THREE.MeshStandardMaterial({ color: 0x9a948c, map: ct, roughness: 1 }))); chim.position.set(cx, (topY + botY) / 2, cz); body.add(chim);
      const cap = new THREE.Mesh(own(geos, new THREE.BoxGeometry(0.7, 0.1, 0.7)), own(mats, new THREE.MeshStandardMaterial({ color: 0x3c3a36, roughness: 1 }))); cap.position.set(cx, topY + 0.05, cz); body.add(cap);
      addSnow(own(geos, new THREE.BoxGeometry(0.66, 0.08, 0.66)), body, cx, topY + 0.14, cz);
    }

    /* --- ポーチ・手すり・階段 --- */
    {
      const bx = (w, h, d, mat, x, y, z, parent = body) => { const m = new THREE.Mesh(own(geos, new THREE.BoxGeometry(w, h, d)), mat); m.position.set(x, y, z); parent.add(m); return m; };
      const pd = PORCH_Z - D / 2, pcz = D / 2 + pd / 2, pw = 3.7;
      bx(pw, 0.1, pd, plankMat, 0, 0.3, pcz);                         // 床
      bx(pw, 0.28, 0.1, darkWood, 0, 0.14, PORCH_Z - 0.05);            // 床の前の板
      for (const sx of [-1, 1]) bx(0.14, Y_TOP - 0.3 + 0.1, 0.14, darkWood, sx * (pw / 2 - 0.1), (Y_TOP + 0.3) / 2 + 0.05, PORCH_Z - 0.12);   // 柱
      bx(pw + 0.1, 0.16, 0.16, darkWood, 0, Y_TOP + 0.05, PORCH_Z - 0.12);                                                                      // 梁
      // 手すりと柵（階段の幅は開ける）
      const rails = [];     // [x, z, 長さ, 軸]
      const gap = 0.55;
      rails.push([-(pw / 2 + gap) / 2 - 0.0, PORCH_Z - 0.12, pw / 2 - gap, 'x', -1], [(pw / 2 + gap) / 2, PORCH_Z - 0.12, pw / 2 - gap, 'x', 1]);
      rails.push([-(pw / 2 - 0.1), (D / 2 + PORCH_Z - 0.12) / 2, PORCH_Z - 0.12 - D / 2, 'z', 0], [pw / 2 - 0.1, (D / 2 + PORCH_Z - 0.12) / 2, PORCH_Z - 0.12 - D / 2, 'z', 0]);
      const bal = []; const railTop = [];
      rails.forEach(([x, z, len, ax]) => {
        const top = ax === 'x' ? bx(len, 0.06, 0.08, darkWood, x, 1.05, z) : bx(0.08, 0.06, len, darkWood, x, 1.05, z);
        const low = ax === 'x' ? bx(len, 0.05, 0.06, darkWood, x, 0.5, z) : bx(0.06, 0.05, len, darkWood, x, 0.5, z);
        void low; railTop.push([top, ax, len]);
        const n = Math.max(2, Math.round(len / 0.2));
        for (let i = 0; i < n; i++) { const f = (i + 0.5) / n - 0.5; bal.push(ax === 'x' ? [x + f * len, z] : [x, z + f * len]); }
      });
      const bg = own(geos, new THREE.BoxGeometry(0.04, 0.52, 0.04)), bi = new THREE.InstancedMesh(bg, darkWood, bal.length);
      bal.forEach(([x, z], i) => { M4.makeTranslation(x, 0.78, z); bi.setMatrixAt(i, M4); }); bi.frustumCulled = false; body.add(bi);
      railTop.forEach(([m, ax, len]) => addSnow(own(geos, new THREE.BoxGeometry(ax === 'x' ? len : 0.1, 0.05, ax === 'x' ? 0.1 : len)), body, m.position.x, 1.1, m.position.z));
      bx(1.0, 0.12, 0.38, plankMat, 0, 0.18, PORCH_Z + 0.2); bx(1.0, 0.1, 0.34, plankMat, 0, 0.06, PORCH_Z + 0.52);   // 階段
    }

    /* --- ドア・窓（窓は暖かく光る面）--- */
    const winTex = own(texs, radialTexture(64, [[0, 'rgba(255,226,160,1)'], [0.6, 'rgba(255,170,80,1)'], [1, 'rgba(235,120,40,1)']]));
    const winMat = own(mats, new THREE.MeshBasicMaterial({ map: winTex, toneMapped: false, color: 0xffffff }));
    const haloTex = own(texs, radialTexture(64, [[0, 'rgba(255,190,110,0.9)'], [0.35, 'rgba(255,150,70,0.3)'], [1, 'rgba(255,120,40,0)']]));
    const spillMats = [];
    {
      const fz = D / 2 + R + 0.01;
      const door = new THREE.Mesh(own(geos, new THREE.BoxGeometry(0.95, 1.9, 0.06)), plankMat); door.position.set(0, 0.3 + 0.95, fz); detail.add(door);
      const knob = new THREE.Mesh(own(geos, new THREE.SphereGeometry(0.035, 6, 5)), own(mats, new THREE.MeshStandardMaterial({ color: 0xb08a40, metalness: 0.6, roughness: 0.4 }))); knob.position.set(0.32, 1.25, fz + 0.05); detail.add(knob);
      const fm = darkWood, fgeoH = own(geos, new THREE.BoxGeometry(1.0, 0.07, 0.07)), fgeoV = own(geos, new THREE.BoxGeometry(0.07, 1.0, 0.07)), pane = own(geos, new THREE.PlaneGeometry(0.84, 0.92));
      WIN_X.forEach((x) => {
        const p = new THREE.Mesh(pane, winMat); p.position.set(x, WIN_Y, fz + 0.01); detail.add(p);
        for (const dy of [-0.48, 0.48]) { const m = new THREE.Mesh(fgeoH, fm); m.position.set(x, WIN_Y + dy, fz + 0.03); detail.add(m); }
        for (const dx of [-0.46, 0.46]) { const m = new THREE.Mesh(fgeoV, fm); m.position.set(x + dx, WIN_Y, fz + 0.03); detail.add(m); }
        const mh = new THREE.Mesh(fgeoH, fm); mh.scale.x = 0.84; mh.position.set(x, WIN_Y, fz + 0.04); detail.add(mh);
        const mv = new THREE.Mesh(fgeoV, fm); mv.scale.y = 0.92; mv.position.set(x, WIN_Y, fz + 0.04); detail.add(mv);
        const sill = new THREE.Mesh(own(geos, new THREE.BoxGeometry(1.1, 0.05, 0.16)), darkWood); sill.position.set(x, WIN_Y - 0.52, fz + 0.07); detail.add(sill);
        // 窓の光がにじむ
        const h = new THREE.Sprite(own(mats, new THREE.SpriteMaterial({ map: haloTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, opacity: 0.55 }))); h.position.set(x, WIN_Y, fz + 0.25); h.scale.setScalar(2.2); detail.add(h); spillMats.push(h.material);
      });
      // 窓の光が落ちる: ポーチの床と、その先の地面に暖色の淡い光だまり（加算）
      const poolTex = own(texs, radialTexture(128, [[0, 'rgba(255,170,80,0.85)'], [0.5, 'rgba(255,140,60,0.4)'], [1, 'rgba(255,120,40,0)']]));
      const poolMat = own(mats, new THREE.MeshBasicMaterial({ map: poolTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, toneMapped: false, opacity: 0.5 }));
      spillMats.push(poolMat);
      const mk = (w, d, x, y, z) => { const g = own(geos, new THREE.PlaneGeometry(w, d)); g.rotateX(-Math.PI / 2); const m = new THREE.Mesh(g, poolMat); m.position.set(x, y, z); m.renderOrder = 2; detail.add(m); return m; };
      WIN_X.forEach((x) => mk(1.6, 1.7, x * 0.9, 0.355, D / 2 + 1.0));
      mk(4.6, 3.4, 0, 0.03, PORCH_Z + 1.5);
    }

    /* --- ランタン（ポーチ。ゆっくり揺らぐ弱い灯り）--- */
    const lantern = { light: new THREE.PointLight(0xffa860, 1.5, 6.5, 2), glow: null, halo: null, grp: new THREE.Group() };
    {
      const g = lantern.grp; g.position.set(-1.55, Y_TOP - 0.25, PORCH_Z - 0.4); detail.add(g);
      const metal = own(mats, new THREE.MeshStandardMaterial({ color: 0x1f1f22, roughness: 0.6, metalness: 0.5 }));
      lantern.glow = own(mats, new THREE.MeshBasicMaterial({ color: 0xffb468, toneMapped: false }));
      const chain = new THREE.Mesh(own(geos, new THREE.CylinderGeometry(0.008, 0.008, 0.3, 4)), metal); chain.position.y = 0.34; g.add(chain);
      const cap = new THREE.Mesh(own(geos, new THREE.ConeGeometry(0.12, 0.09, 4)), metal); cap.position.y = 0.2; cap.rotation.y = Math.PI / 4; g.add(cap);
      const core = new THREE.Mesh(own(geos, new THREE.BoxGeometry(0.1, 0.18, 0.1)), lantern.glow); core.position.y = 0.06; g.add(core);
      for (const [x, z] of [[-0.06, -0.06], [0.06, -0.06], [-0.06, 0.06], [0.06, 0.06]]) { const p = new THREE.Mesh(own(geos, new THREE.BoxGeometry(0.014, 0.2, 0.014)), metal); p.position.set(x, 0.06, z); g.add(p); }
      const base = new THREE.Mesh(own(geos, new THREE.BoxGeometry(0.15, 0.025, 0.15)), metal); base.position.y = -0.05; g.add(base);
      lantern.halo = new THREE.Sprite(own(mats, new THREE.SpriteMaterial({ map: haloTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false })));
      lantern.halo.position.y = 0.06; lantern.halo.scale.setScalar(1.1); g.add(lantern.halo);
      const wp = toWorld(-1.55, Y_TOP - 0.19, PORCH_Z - 0.4); lantern.light.position.copy(wp); scene.add(lantern.light); lights.push(lantern.light);
    }
    const winLight = new THREE.PointLight(0xff9a45, 1.1, 7, 2);
    winLight.position.copy(toWorld(0, 1.3, D / 2 + 1.4)); scene.add(winLight); lights.push(winLight);

    /* --- 薪棚（log.glb の丸太を積む）--- */
    const shed = new THREE.Group(); cab.add(shed);
    let pileMesh = null; const PILE_COLS = 7, PILE_ROWS = 4, PILE_X0 = 2.62, PILE_Z = -0.1, PILE_Y = 0.3;
    {
      const bx = (w, h, d, mat, x, y, z) => { const m = new THREE.Mesh(own(geos, new THREE.BoxGeometry(w, h, d)), mat); m.position.set(x, y, z); shed.add(m); return m; };
      bx(1.9, 0.08, 1.7, plankMat, PILE_X0 + 0.75, PILE_Y - 0.04, PILE_Z); bx(1.7, PILE_Y - 0.08, 1.5, darkWood, PILE_X0 + 0.75, (PILE_Y - 0.08) / 2, PILE_Z);                   // 床板
      for (const dz of [-0.85, 0.85]) bx(0.08, 1.75, 0.08, darkWood, PILE_X0 + 1.62, 0.88, PILE_Z + dz);   // 前の柱
      const sr = new THREE.Mesh(own(geos, new THREE.BoxGeometry(2.1, 0.06, 2.0)), shMat); sr.position.set(PILE_X0 + 0.78, 2.0, PILE_Z); sr.rotation.z = -0.26; shed.add(sr);
      addSnow(own(geos, new THREE.BoxGeometry(2.14, 0.1, 2.04)), shed, PILE_X0 + 0.78, 2.08, PILE_Z, 0, 0, -0.26);
    }
    function buildPile(lg) {
      const n = PILE_COLS * PILE_ROWS, k = 0.18 / lg.thick;             // 丸太の太さ ≒ 0.18m
      const im = new THREE.InstancedMesh(lg.geo, own(mats, lg.mat), n); own(geos, lg.geo); [lg.mat.map, lg.mat.normalMap, lg.mat.roughnessMap, lg.mat.aoMap].forEach((t) => t && texs.push(t));
      for (let i = 0; i < n; i++) {
        const c = i % PILE_COLS, r = Math.floor(i / PILE_COLS);
        Q.setFromEuler(E.set(Math.PI / 2, 0, 0)); QS.setFromAxisAngle(Y_AX, rng() * 6.28); Q.multiply(QS);   // 長い軸を Z に倒す
        const len = Math.min(k, 1.45) * (0.86 + rng() * 0.2);
        M4.compose(V.set(PILE_X0 + 0.1 + c * 0.19 + (rng() - 0.5) * 0.02, PILE_Y + 0.1 + r * 0.17 + (c % 2) * 0.01, PILE_Z + (rng() - 0.5) * 0.1), Q, SC.set(k * (0.92 + rng() * 0.16), len, k * (0.92 + rng() * 0.16)));
        // 回転は軸を Z にした後なので、スケールは「モデルの軸」方向（=長さ）に対して適用する（正規化は長さ 1・軸 Y）
        im.setMatrixAt(i, M4); im.setColorAt(i, COL.setScalar(0.8 + rng() * 0.4));
      }
      im.frustumCulled = false; shed.add(im); pileMesh = im;
      const sn = addSnow(own(geos, new THREE.BoxGeometry(PILE_COLS * 0.19 + 0.1, 0.06, 1.3)), shed, PILE_X0 + 0.1 + (PILE_COLS - 1) * 0.095, PILE_Y + 0.1 + PILE_ROWS * 0.17 - 0.02, PILE_Z); void sn;
    }
    function buildPileFallback() {
      const g = own(geos, new THREE.CylinderGeometry(0.09, 0.09, 1.3, 7)); g.rotateX(Math.PI / 2);
      const im = new THREE.InstancedMesh(g, own(mats, new THREE.MeshStandardMaterial({ color: 0x6a4a30, roughness: 1 })), PILE_COLS * PILE_ROWS);
      for (let i = 0; i < PILE_COLS * PILE_ROWS; i++) { const c = i % PILE_COLS, r = Math.floor(i / PILE_COLS); M4.makeTranslation(PILE_X0 + 0.1 + c * 0.19, PILE_Y + 0.1 + r * 0.17, PILE_Z); im.setMatrixAt(i, M4); im.setColorAt(i, COL.setScalar(0.8 + rng() * 0.4)); }
      im.frustumCulled = false; shed.add(im);
      addSnow(own(geos, new THREE.BoxGeometry(PILE_COLS * 0.19 + 0.1, 0.06, 1.3)), shed, PILE_X0 + 0.1 + (PILE_COLS - 1) * 0.095, PILE_Y + 0.1 + PILE_ROWS * 0.17 - 0.02, PILE_Z);
    }

    /* --- 斧の刺さった切り株（stump.glb の流用。焚火と家のあいだ）--- */
    const STUMP = { x: -2.7, z: -2.4 };
    const stumpGrp = new THREE.Group(); stumpGrp.position.set(STUMP.x, 0, STUMP.z); root.add(stumpGrp);
    const stumpSnow = new THREE.Mesh(own(geos, new THREE.CylinderGeometry(0.22, 0.24, 0.05, 10)), snowMat); stumpSnow.visible = false; snowObjs.push(stumpSnow); stumpGrp.add(stumpSnow);
    let stumpTop = 0.42;
    {
      const metal = own(mats, new THREE.MeshStandardMaterial({ color: 0x8a9098, roughness: 0.45, metalness: 0.15 }));
      const handleMat = own(mats, new THREE.MeshStandardMaterial({ color: 0xa57c4a, roughness: 0.85, emissive: 0x1a1008 }));
      const ax = new THREE.Group(); ax.position.set(0.05, 0, 0.02); ax.rotation.set(-0.12, 0.5, 0.42); stumpGrp.add(ax);
      const handle = new THREE.Mesh(own(geos, new THREE.CylinderGeometry(0.022, 0.028, 0.7, 6)), handleMat); handle.position.y = 0.35; ax.add(handle);
      const head = new THREE.Mesh(own(geos, new THREE.BoxGeometry(0.2, 0.15, 0.035)), metal); head.position.set(0.06, 0.05, 0); ax.add(head);
      const poll = new THREE.Mesh(own(geos, new THREE.BoxGeometry(0.06, 0.07, 0.05)), metal); poll.position.set(-0.07, 0.07, 0); ax.add(poll);
      stumpGrp.userData.axe = ax;
    }
    function buildStump(g, m) {
      g.computeBoundingBox(); const bb = g.boundingBox, h = bb.max.y - bb.min.y, k = 0.45 / h, c = bb.getCenter(new THREE.Vector3());
      const gg = own(geos, g.clone()); gg.translate(-c.x, -bb.min.y, -c.z); gg.scale(k, k, k);
      const mesh = new THREE.Mesh(gg, m); mesh.rotation.y = 0.8; stumpGrp.add(mesh); stumpTop = 0.45;
      stumpGrp.userData.axe.position.y = stumpTop - 0.04; stumpSnow.position.y = stumpTop + 0.01;
      stumpGrp.userData.fallback && (stumpGrp.userData.fallback.visible = false);
    }
    {
      const fb = new THREE.Mesh(own(geos, new THREE.CylinderGeometry(0.25, 0.3, 0.42, 12)), [darkWood, own(mats, new THREE.MeshLambertMaterial({ color: 0x9b7a52 })), darkWood]); fb.position.y = 0.21; stumpGrp.add(fb); stumpGrp.userData.fallback = fb;
      stumpGrp.userData.axe.position.y = 0.38; stumpSnow.position.y = 0.43;
    }

    /* --- 森（仮の木。forest.js と同じ置き方。家のまわりは空ける）--- */
    const treeStyle = [];
    let foli, trunks, snowFoli, treeFallbackOff = false;
    {
      const trunkGeo = own(geos, new THREE.CylinderGeometry(0.08, 0.12, 0.7, 6)); trunkGeo.translate(0, 0.35, 0);
      const cone = (r, h, y) => ({ geo: new THREE.ConeGeometry(r, h, 6), matrix: new THREE.Matrix4().makeTranslation(0, y, 0) });
      const foliGeo = own(geos, mergeGeoms([cone(0.85, 1.6, 1.4), cone(0.62, 1.4, 2.15), cone(0.4, 1.1, 2.8)]));
      const snowGeo = own(geos, mergeGeoms([cone(0.8, 1.0, 1.7), cone(0.58, 0.9, 2.4), cone(0.37, 0.75, 3.05)]));
      const NT = 80, NNEAR = 34;
      const pts = []; let guard = 0;
      while (pts.length < NT && guard++ < 1500) {
        const far = pts.length >= NNEAR;
        const a = rng() * Math.PI * 2, r = far ? 27 + rng() * 7 : Math.sqrt(10 * 10 + rng() * (26 * 26 - 10 * 10));
        const x = Math.sin(a) * r, z = Math.cos(a) * r;
        if (!far && r < 16 && Math.abs(Math.atan2(x, z)) < 1.0) continue;
        if (!far && Math.hypot(x - CAB.x, z - CAB.z) < 6.5) continue;      // 家のまわり
        if (!far && Math.hypot(x, z) < 8 && z > -6.5) continue;
        pts.push({ x, z, far, s: far ? 1.3 + rng() * 1.1 : 0.8 + rng() * 0.8 });
      }
      trunks = new THREE.InstancedMesh(trunkGeo, own(mats, new THREE.MeshLambertMaterial({ color: 0x2c1c10 })), pts.length);
      foli = new THREE.InstancedMesh(foliGeo, own(mats, new THREE.MeshLambertMaterial({ color: 0xffffff })), pts.length);
      snowFoli = new THREE.InstancedMesh(snowGeo, own(mats, new THREE.MeshLambertMaterial({ color: 0xdde8f5, emissive: 0x18222e })), pts.length);
      pts.forEach((p, i) => {
        Q.setFromEuler(E.set(0, rng() * 6.28, 0));
        const y = hillGround(HILLS[0], Math.hypot(p.x, p.z), Math.atan2(p.z, p.x)) - 0.1;
        M4.compose(V.set(p.x, y, p.z), Q, SC.set(p.s * (0.9 + rng() * 0.2), p.s, p.s * (0.9 + rng() * 0.2)));
        trunks.setMatrixAt(i, M4); foli.setMatrixAt(i, M4); snowFoli.setMatrixAt(i, M4); treeStyle.push({ ci: Math.floor(rng() * 4), k: 0.55 * (0.8 + rng() * 0.4) });
      });
      foli.frustumCulled = trunks.frustumCulled = snowFoli.frustumCulled = false; snowFoli.visible = false; root.add(trunks, foli, snowFoli);
    }

    /* --- 遠景の木（FABOTANIC）。読めたら仮の円錐の木と入れ替える。家のまわりとカメラ手前の扇形は空ける --- */
    let far = null;
    {
      const fr = mulberry32(909), fpts = [];
      let guard = 0;
      while (fpts.length < 160 && guard++ < 6000) {
        const ridge = fpts.length >= 90;
        const a = fr() * Math.PI * 2, r = ridge ? 31 + fr() * 5 : 24 + fr() * 6;
        const x = Math.sin(a) * r, z = Math.cos(a) * r;
        if (inSkyClearing(x, z)) continue;                                      // 正面の夜空・家と煙突のうしろは空ける
        if (Math.hypot(x - CAB.x, z - CAB.z) < 7) continue;
        fpts.push({ x, z, y: hillGround(HILLS[0], r, Math.atan2(z, x)) - 0.1, h: ridge ? 9 + fr() * 5 : 9 + fr() * 4 });
      }
      loadFarTrees(ctx, fpts, { seed: 23 }).then((h) => {
        if (!h || isStopped()) { if (h) h.dispose(); return; }
        far = h; root.add(h.group);
        if (season) h.setSeason(season);
        foli.visible = trunks.visible = false; treeFallbackOff = true; snowFoli.visible = false;
      }).catch((e) => console.warn('[takibi] far trees:', e));
    }

    /* --- 季節の舞うもの（花びら・落ち葉・雪）と地面の雪・落ち葉 --- */
    const NDR = 120;
    const mkDrift = (tex, size, emissive) => { const im = new THREE.InstancedMesh(own(geos, new THREE.PlaneGeometry(size, size)), own(mats, new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.04, side: THREE.DoubleSide, depthWrite: false, emissive })), NDR); im.frustumCulled = false; im.visible = false; root.add(im); return im; };
    const petals = mkDrift(petalT, 0.11, 0x2a1520), fallLeaves = mkDrift(leafT, 0.19, 0x241208);
    const snowPts = makeSnowPoints(700, uScale); snowPts.points.visible = false; root.add(snowPts.points);
    const dd = []; for (let i = 0; i < 700; i++) { const a = rng() * 6.28, r = Math.sqrt(rng()) * 11; dd.push({ x: Math.cos(a) * r, z: Math.sin(a) * r - 2, y: rnd(0, 6.5), vy: rnd(0.3, 0.7), ph: rnd(0, 20), sz: rnd(0.75, 1.3), f1: rnd(1.2, 2.6), f2: rnd(1, 2.2), spin: rnd(-2.2, 2.2), tilt: rnd(0.5, 1.1) }); }
    { const cs1 = [0xffc4d6, 0xffd6e2, 0xf7b0c8]; for (let i = 0; i < NDR; i++) { petals.setColorAt(i, COL.setHex(cs1[i % 3])); fallLeaves.setColorAt(i, COL.setHex(LEAF_COLORS[i % 4])); } }
    const gLeaf = new THREE.InstancedMesh(own(geos, new THREE.PlaneGeometry(0.17, 0.17).rotateX(-Math.PI / 2)), leafMat, 110); gLeaf.frustumCulled = false; gLeaf.visible = false; root.add(gLeaf);
    {
      for (let i = 0; i < 110; i++) {
        let x, z, g = 0; do { x = (rng() - 0.5) * 12 + CAB.x * 0.5; z = -9 + rng() * 11; g++; } while (g < 20 && Math.hypot(x, z) < 1.5);
        Q.setFromEuler(E.set((rng() - 0.5) * 0.3, rng() * 6.28, (rng() - 0.5) * 0.3)); M4.compose(V.set(x, 0.02, z), Q, SC.setScalar(0.7 + rng() * 0.8)); gLeaf.setMatrixAt(i, M4); gLeaf.setColorAt(i, COL.setHex(LEAF_COLORS[i % 4]).multiplyScalar(0.7));
      }
    }
    const snowTex = own(texs, radialTexture(128, [[0, 'rgba(255,255,255,0.85)'], [0.5, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]));
    const NSNOW = 120, snowPatch = new THREE.InstancedMesh(own(geos, new THREE.CircleGeometry(0.5, 16).rotateX(-Math.PI / 2)), own(mats, new THREE.MeshLambertMaterial({ color: 0xd6e2f4, map: snowTex, transparent: true, depthWrite: false })), NSNOW);
    snowPatch.frustumCulled = false; snowPatch.visible = false; root.add(snowPatch);
    {
      for (let i = 0; i < NSNOW; i++) {
        let x, z, g = 0; do { x = (rng() - 0.5) * 18 - 1; z = -12 + rng() * 15; g++; } while (g < 20 && (Math.hypot(x, z) < 1.7 || (Math.abs(x - CAB.x) < 2.6 && Math.abs(z - CAB.z) < 3.0)));
        const s = 0.7 + rng() * 1.4; Q.setFromEuler(E.set(0, rng() * 6, 0)); M4.compose(V.set(x, 0.014 + i * 0.00003, z), Q, SC.set(s * 1.4, 1, s)); snowPatch.setMatrixAt(i, M4);
        snowPatch.setColorAt(i, COL.setScalar(clamp(1 - 0.5 * Math.hypot(x, z + 3) / 10, 0.45, 1)));
      }
    }

    /* --- 煙突の煙（薄く、風に流れる）--- */
    const NSM = 48, smoke = makePoints(NSM, THREE.NormalBlending, 0.6, uScale); smoke.points.renderOrder = 3; root.add(smoke.points);
    const smokeP = []; const chimTop = toWorld(1.15, 4.55, -0.9);
    for (let i = 0; i < NSM; i++) smokeP.push({ age: rnd(0, 9), life: rnd(7, 10), ox: rnd(-0.08, 0.08), oz: rnd(-0.08, 0.08), ph: rnd(0, 6.28) });

    /* --- 草地（FABOTANIC）--- */
    let fieldObj = null, fieldLoading = false, grassLevel = '';
    function ensureField(level) {
      if (level === 'none') { if (fieldObj) fieldObj.group.visible = false; return; }
      if (fieldObj) { applyFieldLevel(fieldObj, level, FIELD_LEVELS); fieldObj.group.visible = true; return; }
      if (fieldLoading) return; fieldLoading = true;
      collectFieldEntries().then((list) => (list.length ? loadField(list[0], isStopped) : null)).then((f) => {
        if (!f) return; if (isStopped()) { f.asset.dispose(); return; }
        fieldObj = f; root.add(f.group); applyFieldLevel(f, grassLevel === 'none' ? 'many' : grassLevel, FIELD_LEVELS); f.group.visible = grassLevel !== 'none'; applyFieldTint(f, season);
      }).catch((err) => console.warn('[takibi] field asset:', err));
    }

    /* --- GLB（log.glb → 薪棚、stump.glb → 切り株、cabin.glb → あれば家の本体）--- */
    (async () => {
      let g1 = null, g2 = null;
      try { [g1, g2] = await Promise.all([assets.loadGLTF('assets/models/log.glb').catch(() => null), assets.loadGLTF('assets/models/stump.glb').catch(() => null)]); } catch (e) { /* 取りこぼしても円柱で代用 */ }
      if (isStopped()) return;
      const lg = g1 ? normalizedLog(g1) : null;
      if (lg) buildPile(lg); else buildPileFallback();
      if (g2) {
        let sm = null; g2.scene.updateMatrixWorld(true); g2.scene.traverse((o) => { if (!sm && o.isMesh && /^stump/i.test(o.name)) sm = o; }); if (!sm) g2.scene.traverse((o) => { if (!sm && o.isMesh) sm = o; });
        if (sm) { const g = sm.geometry.clone(); g.applyMatrix4(sm.matrixWorld); buildStump(g, own(mats, Array.isArray(sm.material) ? sm.material[0] : sm.material)); g.dispose(); }
      }
      const cm = await loadOptionalModel(assets, 'cabin.glb', isStopped);
      if (cm && !isStopped()) {
        const g = own(geos, cm.geometry); g.computeBoundingBox(); const bb = g.boundingBox, s = 7, h = (bb.max.y - bb.min.y) * s;
        const mesh = new THREE.Mesh(g, cm.material ? own(mats, cm.material) : woodMat); mesh.scale.setScalar(s); mesh.position.y = h / 2 + Math.max(0, -bb.min.y * 0); cab.add(mesh);
        body.visible = false; shed.visible = true;
      }
    })().catch((e) => console.warn('[takibi] cabin models:', e));

    /* --- 季節 --- */
    const origGroundColor = ground ? ground.material.color.clone() : null;
    function applySeason(s) {
      season = s; cfg = SEASON[s];
      treeStyle.forEach((t, i) => foli.setColorAt(i, COL.setHex(cfg.trees[t.ci % cfg.trees.length]).multiplyScalar(t.k * (cfg.snow ? 1.15 : 1))));
      foli.instanceColor.needsUpdate = true;
      snowFoli.visible = !!cfg.snow && !treeFallbackOff;
      if (far) far.setSeason(s);
      snowObjs.forEach((m) => { m.visible = !!cfg.snow; });
      roofLeaves.forEach((m) => { m.visible = !!cfg.leaves; });
      gLeaf.visible = !!cfg.leaves; snowPatch.visible = !!cfg.snow;
      if (ground) { const t = GROUND_TINT[s]; ground.material.color.setRGB(t[0], t[1], t[2]); }
      ctx.fireflies && (ctx.fireflies.value = cfg.ff);
      applyFieldTint(fieldObj, s);
    }

    /* --- 家のきしみ: まれに「ギシッ」---*/
    let nextCreak = rnd(25, 70);
    let driftKey = '';
    const dm = new THREE.Matrix4(), dq = new THREE.Quaternion(), de = new THREE.Euler(), dp = new THREE.Vector3(), ds = new THREE.Vector3();
    function updateDrift(season, dt, t, on) {
      petals.visible = on && season === 'spring'; fallLeaves.visible = on && season === 'autumn'; snowPts.points.visible = on && season === 'winter';
      if (!on) return;
      if (season === 'winter') {
        const P = snowPts;
        for (let i = 0; i < 700; i++) {
          const d = dd[i], o = i * 3; d.y -= d.vy * dt * 0.5; d.x += Math.sin(t * 1.1 + d.ph) * 0.2 * dt; d.z += Math.cos(t * 0.9 + d.ph) * 0.2 * dt;
          if (d.y < 0) { d.y = 6.5; const a = rng() * 6.28, r = Math.sqrt(rng()) * 11; d.x = Math.cos(a) * r; d.z = Math.sin(a) * r - 2; }
          P.pos[o] = d.x; P.pos[o + 1] = d.y; P.pos[o + 2] = d.z; P.size[i] = 0.032 * d.sz * d.sz; P.alp[i] = 0.9; P.col[o] = 0.93; P.col[o + 1] = 0.96; P.col[o + 2] = 1;
        }
        P.flush(700); return;
      }
      const im = season === 'spring' ? petals : season === 'autumn' ? fallLeaves : null; if (!im) return;
      for (let i = 0; i < NDR; i++) {
        const d = dd[i]; d.y -= d.vy * dt * (season === 'autumn' ? 1.0 : 0.75); const sway = season === 'autumn' ? 0.7 : 0.5;
        d.x += Math.sin(t * 1.1 + d.ph) * sway * dt; d.z += Math.cos(t * 0.9 + d.ph) * sway * dt;
        if (d.y < 0.03) { d.y = 6; const a = rng() * 6.28, r = Math.sqrt(rng()) * 9; d.x = Math.cos(a) * r; d.z = Math.sin(a) * r - 2; }
        de.set(Math.sin(t * d.f1 + d.ph) * d.tilt, t * d.spin + d.ph, Math.cos(t * d.f2 + d.ph) * d.tilt); dq.setFromEuler(de);
        dm.compose(dp.set(d.x, d.y, d.z), dq, ds.setScalar(d.sz)); im.setMatrixAt(i, dm);
      }
      im.instanceMatrix.needsUpdate = true;
    }

    return {
      setSeason(s) { applySeason(s); },
      update(dt, t, st) {
        curT = t;
        const gl = st.grass || 'normal';
        if (gl !== grassLevel) { grassLevel = gl; ensureField(gl); }
        if (fieldObj) fieldObj.asset.update(dt, t, camera);
        // 灯り: ゆっくり揺らぐ
        const fl = 0.9 + 0.06 * Math.sin(t * 1.1) + 0.04 * Math.sin(t * 2.7 + 1) + 0.025 * Math.sin(t * 5.9);
        const fw = 0.97 + 0.03 * Math.sin(t * 0.8 + 2) + 0.012 * Math.sin(t * 3.3);
        lantern.light.intensity = 1.5 * fl; lantern.glow.color.setRGB(fl, 0.64 * fl, 0.3 * fl); lantern.halo.material.opacity = 0.75 * fl;
        lantern.grp.rotation.z = 0.02 * Math.sin(t * 0.7); lantern.grp.rotation.x = 0.015 * Math.sin(t * 0.55 + 1);
        const wk = cfg.win * fw;
        winMat.color.setRGB(Math.min(1.4, 0.92 * wk), Math.min(1.4, 0.88 * wk), Math.min(1.4, 0.82 * wk));
        winLight.intensity = 1.1 * cfg.win * fw; spillMats.forEach((m, i) => { m.opacity = (i === spillMats.length - 1 ? 0.5 : i % 2 ? 0.55 : 0.5) * Math.min(1.3, cfg.win) * fw; });
        // 煙
        for (let i = 0; i < NSM; i++) {
          const p = smokeP[i], o = i * 3; p.age += dt;
          if (p.age > p.life) { p.age = 0; p.life = rnd(7, 10); p.ox = rnd(-0.08, 0.08); p.oz = rnd(-0.08, 0.08); }
          const u = p.age / p.life, wind = 0.28 * (0.8 + 0.4 * Math.sin(t * 0.17));
          smoke.pos[o] = chimTop.x + p.ox + wind * p.age * (0.6 + u) + Math.sin(p.ph + p.age * 0.8) * 0.15 * u;
          smoke.pos[o + 1] = chimTop.y + 0.45 * p.age - 0.012 * p.age * p.age; smoke.pos[o + 2] = chimTop.z + p.oz + 0.05 * p.age;
          smoke.size[i] = 0.3 + 1.7 * u; smoke.alp[i] = 0.11 * Math.sin(Math.PI * Math.min(1, u * 1.05)) * (cfg.snow ? 1.15 : 1);
          smoke.col[o] = 0.34; smoke.col[o + 1] = 0.36; smoke.col[o + 2] = 0.42;
        }
        smoke.flush(NSM);
        updateDrift(season, dt, t, st.seasonFx !== false);
        // 家の木が小さくきしむ
        if (t > nextCreak) { nextCreak = t + rnd(45, 140); api.playSfx && api.playSfx('creak', { vol: rnd(0.5, 0.9), pan: clamp(CAB.x / 5, -0.8, 0.8) }); }
      },
      dispose() {
        disposed = true;
        if (far) { far.dispose(); far = null; }
        lights.forEach((l) => scene.remove(l));
        if (ground && origGroundColor) ground.material.color.copy(origGroundColor);
        ctx.fireflies && (ctx.fireflies.value = 1);
        if (fieldObj) { root.remove(fieldObj.group); fieldObj.group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); }); fieldObj.asset.dispose(); fieldObj = null; }
        [foli, trunks, snowFoli, petals, fallLeaves, gLeaf, snowPatch].forEach((m) => m.dispose && m.dispose());
        root.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
        texs.forEach((x) => x.dispose()); geos.forEach((x) => x.dispose()); mats.forEach((x) => x.dispose());
      }
    };
  }
};
