// 遠景の木（FABOTANIC の「遠景」素材: 4方向の画像を交差させた8三角形の板）。森・ログハウス・川の対岸・洞窟の入口の外で共通に使う。
//   assets/plants/vd-fir-…（針葉樹A）, vd-maple-…（もみじ）, vd-cherry-…（桜）, vd-tree-…（緑の広葉樹A）
// 4種を1回だけ読み込み（モジュール内に保持）、シーンごとに種類ごとの InstancedMesh を1つずつ作る。
// 季節の切り替えは、読み込み直さずに instance の行列・色を入れ替えるだけ。
// 素材は昼の照明が画像に焼き込まれた「照明なし」の材質なので、夜に浮かないよう、焚火からの距離で暗くし、
// 月光の青みと焚火側の暖かさを instance の色で乗せる。透明部分は alphaTest（並べ替えなし）で抜く。
// BackgroundForest.js（付属の多数配置コード）は使わない: 季節ごとの入れ替えと夜の色づけを自前の材質で行うため。
import * as THREE from 'three';

const DIR = 'assets/plants/';
const FILES = {
  fir: 'vd-fir-e3b00cf3837bdca21dac/models/asset.glb',
  maple: 'vd-maple-5bf2800efe7ccce2dddf/models/asset.glb',
  cherry: 'vd-cherry-1b8cdf5499d07b2aa6ce/models/asset.glb',
  tree: 'vd-tree-0853f86b3d7090b19e26/models/asset.glb'
};
const KINDS = Object.keys(FILES);

/* 季節ごとの木の構成（割合。合計 1） */
const MIX = {
  spring: { cherry: 0.42, tree: 0.28, fir: 0.30 },
  summer: { tree: 0.66, fir: 0.34 },
  autumn: { maple: 0.62, fir: 0.38 },
  winter: { fir: 0.90, tree: 0.05, maple: 0.05 }
};

/* 季節 × 種類の見た目。color: 材質の色（夜の色に掛ける）、sat: 彩度（1 = そのまま）、snow: 雪をのせる強さ（針葉樹の葉の部分を白っぽく） */
const LOOK = {
  spring: { fir: { color: [0.85, 1.0, 0.95], sat: 0.95, snow: 0 }, tree: { color: [1.05, 1.18, 0.9], sat: 1.0, snow: 0 }, maple: { color: [1, 1, 1], sat: 1, snow: 0 }, cherry: { color: [1.35, 1.12, 1.25], sat: 1.0, snow: 0 } },
  summer: { fir: { color: [0.8, 0.95, 0.9], sat: 0.9, snow: 0 }, tree: { color: [0.85, 1.0, 0.9], sat: 1.0, snow: 0 }, maple: { color: [1, 1, 1], sat: 1, snow: 0 }, cherry: { color: [1, 1, 1], sat: 1, snow: 0 } },
  autumn: { fir: { color: [0.95, 0.95, 0.85], sat: 0.85, snow: 0 }, tree: { color: [1, 1, 1], sat: 1, snow: 0 }, maple: { color: [1.3, 1.0, 0.8], sat: 1.05, snow: 0 }, cherry: { color: [1, 1, 1], sat: 1, snow: 0 } },
  winter: { fir: { color: [0.95, 1.05, 1.2], sat: 0.7, snow: 0.7 }, tree: { color: [0.55, 0.6, 0.7], sat: 0.25, snow: 0 }, maple: { color: [0.55, 0.55, 0.62], sat: 0.25, snow: 0 }, cherry: { color: [1, 1, 1], sat: 1, snow: 0 } }
};

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function rng32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 4種の GLB を1回だけ読む（失敗したら null。次の機会に読み直す） */
let speciesPromise = null;
function loadSpecies(assets) {
  if (!speciesPromise) {
    speciesPromise = Promise.all(KINDS.map(async (k) => {
      const gltf = await assets.loadGLTF(DIR + FILES[k]);
      let mesh = null;
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
      if (!mesh || !mesh.material || !mesh.material.map) throw new Error('far tree: no mesh ' + k);
      const geo = mesh.geometry.clone(); geo.applyMatrix4(mesh.matrixWorld);
      geo.deleteAttribute('normal'); geo.deleteAttribute('color');
      geo.computeBoundingBox();
      const tex = mesh.material.map;
      return [k, { geo, tex, h: geo.boundingBox.max.y, cut: mesh.material.alphaTest || 0.3 }];
    })).then((l) => Object.fromEntries(l)).catch((err) => { speciesPromise = null; console.warn('[takibi] far trees:', err); return null; });
  }
  return speciesPromise;
}

/* 夜の色: 焚火 (0,0) からの距離 r で暗く。近いほど焚火の暖かさ、遠いほど月光の青み */
const MOON = [0.66, 0.8, 1.1], WARM = [1.3, 0.85, 0.5];
function nightRGB(r, k, out) {
  const far = smooth(8, 40, r), warm = 0.4 * (1 - smooth(8, 28, r));
  const b = (0.3 - 0.23 * far) * k;
  out.setRGB(b * (MOON[0] + (WARM[0] - MOON[0]) * warm), b * (MOON[1] + (WARM[1] - MOON[1]) * warm), b * (MOON[2] + (WARM[2] - MOON[2]) * warm));
}

function makeMaterial(sp, ctx) {
  const uniforms = { uSat: { value: 1 }, uSnow: { value: 0 } };
  const mat = new THREE.MeshBasicMaterial({ map: sp.tex.clone(), alphaTest: sp.cut, side: THREE.DoubleSide });
  mat.map.needsUpdate = true;
  mat.map.anisotropy = Math.min(4, ctx.renderer.capabilities.getMaxAnisotropy());
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSat = uniforms.uSat; shader.uniforms.uSnow = uniforms.uSnow;
    shader.fragmentShader = 'uniform float uSat; uniform float uSnow;\n' + shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
  {
    vec3 tkC = diffuseColor.rgb;
    float tkL = dot(tkC, vec3(0.3, 0.59, 0.11));
    float tkFol = smoothstep(0.0, 0.10, tkC.g - max(tkC.r, tkC.b) * 0.9);     // 緑の葉の部分（幹は茶色なので対象外）
    tkC = mix(vec3(tkL), tkC, uSat);
    tkC = mix(tkC, vec3(0.86, 0.9, 1.0) * (0.75 + 0.5 * tkL), uSnow * tkFol);   // 雪をのせた葉
    diffuseColor.rgb = tkC;
  }`);
  };
  mat.customProgramCacheKey = () => 'tkfartree';
  mat.userData.uniforms = uniforms;
  return mat;
}

/* points: [{x, z, y?, h?}]。h は木の高さ(m)。省略時は 6〜14m のばらつき。
   opts: { seed, brightness（夜の明るさの倍率。既定 1）, hMin, hMax }
   戻り値: Promise<{group, setSeason(season), triangles(), dispose()}|null>（読めなかったら null） */
export async function loadFarTrees(ctx, points, opts = {}) {
  const species = await loadSpecies(ctx.assets);
  if (!species || ctx.isStopped()) return null;
  const rng = rng32(opts.seed || 1), bright = opts.brightness || 1;
  const hMin = opts.hMin || 6, hMax = opts.hMax || 14;
  const n = points.length;
  const info = points.map((p) => {
    const r = Math.hypot(p.x, p.z);
    return { u: rng(), yaw: rng() * Math.PI * 2, hk: p.h || hMin + rng() * (hMax - hMin), wk: 1 + rng() * 0.25, v: 0.82 + rng() * 0.36, r };
  });
  const group = new THREE.Group(); group.name = 'FarTrees';
  const geos = [], mats = {}, meshes = {};
  for (const k of KINDS) {
    const g = species[k].geo.clone(); geos.push(g);
    mats[k] = makeMaterial(species[k], ctx);
    const im = new THREE.InstancedMesh(g, mats[k], Math.max(1, n));
    im.frustumCulled = false; im.count = 0; im.visible = false;
    meshes[k] = im; group.add(im);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
  let tris = 0;
  return {
    group,
    setSeason(season) {
      const mix = MIX[season] || MIX.summer, look = LOOK[season] || LOOK.summer;
      const used = Object.keys(mix), cnt = {};
      KINDS.forEach((k) => { cnt[k] = 0; });
      tris = 0;
      points.forEach((p, i) => {
        const f = info[i]; let acc = 0, k = used[used.length - 1];
        for (const kk of used) { acc += mix[kk]; if (f.u < acc) { k = kk; break; } }
        const s = f.hk / species[k].h, j = cnt[k]++, im = meshes[k];
        q.setFromEuler(e.set(0, f.yaw, 0)); v.set(p.x, p.y || 0, p.z); sc.set(s * f.wk, s, s * f.wk);
        m4.compose(v, q, sc); im.setMatrixAt(j, m4);
        nightRGB(f.r, bright * f.v, col); im.setColorAt(j, col);
        tris += 8;
      });
      for (const k of KINDS) {
        const im = meshes[k], l = look[k] || look.tree;
        im.count = cnt[k]; im.visible = cnt[k] > 0;
        im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
        mats[k].color.setRGB(l.color[0], l.color[1], l.color[2]);
        mats[k].userData.uniforms.uSat.value = l.sat; mats[k].userData.uniforms.uSnow.value = l.snow;
      }
    },
    triangles() { return tris; },
    dispose() {
      group.removeFromParent();
      for (const k of KINDS) { meshes[k].dispose(); if (mats[k].map) mats[k].map.dispose(); mats[k].dispose(); }
      geos.forEach((g) => g.dispose());
    }
  };
}
