// 焚火まわりの小物（Blender 製 GLB: assets/models/ の campfire_rocks / log / stump）の読み込みと、石囲い・薪・切り株の部品づくり。
// scene3d.js が起動時に1回だけ loadProps() を呼ぶ。読み込みに失敗したものは null（呼び出し側が従来のコード製の形に戻す）。
// 複製（石囲いの石・薪・予備の薪）はジオメトリとテクスチャを共有する。薪だけは、熾火の発光（fire3d.js）が1本ごとに
// 材質へ uniform を持たせるため、燃えている薪に限り材質を clone する（テクスチャは共有のまま）。
import * as THREE from 'three';
import { mulberry32 } from './util.js';

const nameNo = (o) => parseInt((o.name.match(/(\d+)\s*$/) || [0, 0])[1], 10);

/* glTF 材質を、このプロジェクトの規約に揃える: Base Color = sRGB、Normal / ORM = NoColorSpace、
   ORM（R=AO, G=Roughness, B=Metallic）の1枚を aoMap / roughnessMap / metalnessMap で共有、背面カリング有効 */
function prepMaterial(mat, aniso) {
  const orm = mat.roughnessMap || mat.metalnessMap || mat.aoMap;
  if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
  if (mat.normalMap) mat.normalMap.colorSpace = THREE.NoColorSpace;
  if (orm) {
    orm.colorSpace = THREE.NoColorSpace;
    mat.aoMap = mat.roughnessMap = mat.metalnessMap = orm;
    orm.channel = 1;     // aoMap は uv1 を読む（下の geometry で uv を uv1 に複製している。roughness / metalness も同じ UV なので同じ値になる）
  }
  for (const t of [mat.map, mat.normalMap, orm]) if (t) { t.anisotropy = aniso; t.needsUpdate = true; }
  mat.side = THREE.FrontSide;
  return mat;
}

/* シーン内の Mesh を、ワールド変換を焼き込んだジオメトリとして取り出す（uv を uv1 に複製） */
function bakedGeometry(mesh) {
  const g = mesh.geometry.clone();
  g.applyMatrix4(mesh.matrixWorld);
  if (g.attributes.uv && !g.attributes.uv1) g.setAttribute('uv1', g.attributes.uv.clone());
  if (!g.attributes.normal) g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

/* 薪: 軸を +Y・長さ 1・軸の中央が原点に揃える（fire3d.js の薪の発光は「長さ1の Y 軸の円柱」を前提にした座標で模様を作る）。
   軸（長手）は X のままの GLB を回して使う: 元の +Y（半割の丸い側）は、ここでは -X になる */
function normalizeLog(src) {
  const g = src.clone();
  g.computeBoundingBox();
  const bb = g.boundingBox, len = Math.max(1e-6, bb.max.x - bb.min.x);
  g.translate(-(bb.max.x + bb.min.x) / 2, 0, 0);     // y, z は動かさない（半割の割り面 y=0 を保つ）
  g.scale(1 / len, 1 / len, 1 / len);
  g.rotateZ(Math.PI / 2);
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

async function loadModel(assets, file) {
  try {
    const gltf = await assets.loadGLTF('assets/models/' + file);
    gltf.scene.updateMatrixWorld(true);
    return gltf;
  } catch (err) {
    console.warn('[takibi] model ' + file + ':', err && err.message ? err.message : err);
    return null;
  }
}

function firstMaterial(meshes) {
  const m = meshes[0] && meshes[0].material;
  return Array.isArray(m) ? m[0] : m;
}

export async function loadProps(assets, aniso) {
  const [gRock, gLog, gStump] = await Promise.all(['campfire_rocks.glb', 'log.glb', 'stump.glb'].map((f) => loadModel(assets, f)));
  const meshesOf = (gltf, re) => {
    const out = [];
    if (gltf) gltf.scene.traverse((o) => { if (o.isMesh && re.test(o.name)) out.push(o); });
    return out.sort((a, b) => nameNo(a) - nameNo(b));
  };
  const rockMeshes = meshesOf(gRock, /^rock_/i), logMeshes = meshesOf(gLog, /^log_/i);
  let stumpMesh = meshesOf(gStump, /^stump/i)[0];
  if (!stumpMesh && gStump) gStump.scene.traverse((o) => { if (!stumpMesh && o.isMesh) stumpMesh = o; });

  const P = { rocks: null, logs: null, stump: null, disposables: [] };
  const own = (x) => { P.disposables.push(x); return x; };

  if (rockMeshes.length) {
    P.rockMat = own(prepMaterial(firstMaterial(rockMeshes), aniso));
    P.rocks = rockMeshes.map((m) => {
      const geo = own(bakedGeometry(m)), bb = geo.boundingBox;
      return { geo, hx: Math.max(-bb.min.x, bb.max.x), hz: Math.max(-bb.min.z, bb.max.z), h: bb.max.y };
    });
    patchSoot(P.rockMat);
  }
  if (logMeshes.length) {
    P.logMat = own(prepMaterial(firstMaterial(logMeshes), aniso));
    P.logs = logMeshes.map((m) => {
      const g = own(normalizeLog(bakedGeometry(m)));
      const bb = g.boundingBox;
      // 半割（割り面が y=0）は、元の y が全部 0 以上 = ここでは x が全部 0 以下
      // thick は fire3d / 焚火の薪の置き方が使う従来の値（軸 Y の長さを含む）。dia は断面の直径（x, z）で、積んだ薪の高さに使う
      return { geo: g, half: bb.max.x < 1e-4, thick: Math.max(bb.max.y - bb.min.y, bb.max.z - bb.min.z), dia: Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) };
    });
  }
  if (stumpMesh) {
    P.stumpMat = own(prepMaterial(stumpMesh.material, aniso));
    P.stump = own(bakedGeometry(stumpMesh));
  }
  P.dispose = () => {
    for (const x of P.disposables) {
      if (x.isMaterial) { for (const k in x) { const v = x[k]; if (v && v.isTexture) v.dispose(); } }
      x.dispose();
    }
    P.disposables.length = 0;
  };
  if (!P.rocks && !P.logs && !P.stump) return null;
  return P;
}

/* ---------- 石: 焚火側の面を煤で黒くする（ワールド座標の、焚火の中心からの距離で暗くする） ---------- */
function patchSoot(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = 'varying vec3 vTkW;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
  {
    vec4 tkp = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      tkp = instanceMatrix * tkp;
    #endif
    vTkW = (modelMatrix * tkp).xyz;
  }`);
    sh.fragmentShader = `varying vec3 vTkW;
float tkSh(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float tkSn(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(tkSh(i), tkSh(i + vec3(1,0,0)), f.x), mix(tkSh(i + vec3(0,1,0)), tkSh(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(tkSh(i + vec3(0,0,1)), tkSh(i + vec3(1,0,1)), f.x), mix(tkSh(i + vec3(0,1,1)), tkSh(i + vec3(1,1,1)), f.x), f.y), f.z);
}
` + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
  {
    float d = length(vTkW.xz);
    float n = tkSn(vTkW * 22.0);
    // 焚火に近い面ほど、また低い所ほど煤で黒い（まだらに）
    float soot = (1.0 - smoothstep(0.34, 0.52, d + (n - 0.5) * 0.056)) * (1.0 - 0.4 * smoothstep(0.05, 0.14, vTkW.y));
    diffuseColor.rgb *= (0.85 + 0.3 * n) * (1.0 - 0.92 * soot);
  }`);
  };
  mat.customProgramCacheKey = () => 'tkrocksoot';
  mat.needsUpdate = true;
}

/* ---------- 石囲い: 隣り合う石が同じにならないよう並べ、幅の合計から半径を決めて隙間なく一周させる ---------- */
export function buildRockRing(P, { radius = 0.45, seed = 77 } = {}) {
  // 石 1 個の幅は 約 20〜35cm（輪の長さ 2πr ÷ 約 0.28m）。個数は半径から決める
  const rng = mulberry32(seed), V = P.rocks.length, N = Math.max(8, Math.round(2 * Math.PI * radius / 0.28));
  const seq = [];
  for (let i = 0; i < N; i++) {
    let v, tries = 0;
    // 直前の3つ（輪の端どうしも）と同じ石は避ける
    do { v = Math.floor(rng() * V); } while (tries++ < 40 && (seq.slice(-3).includes(v) || (i >= N - 2 && seq.slice(0, 2).includes(v))));
    seq.push(v);
  }
  const items = seq.map((v) => {
    const r = P.rocks[v], s = 0.95 + rng() * 0.4;
    return { v, s, sx: s * (0.95 + rng() * 0.15), sy: s * (0.78 + rng() * 0.22), sz: s * (0.95 + rng() * 0.15), w: 2 * r.hx * s };
  });
  // 輪の長さ = 石の幅の合計（少し重ねる）。目標の半径になるよう全体の大きさをそろえる
  const total = items.reduce((a, it) => a + it.w, 0) * 0.93, k = (2 * Math.PI * radius) / total;
  items.forEach((it) => { it.sx *= k; it.sy *= k; it.sz *= k; it.w *= k * 0.93; });
  const group = new THREE.Group();
  const per = P.rocks.map(() => []);
  let a = 0;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
  items.forEach((it, i) => {
    const next = items[(i + 1) % items.length];
    const rr = radius + (rng() - 0.5) * 0.025;
    const yaw = a - Math.PI / 2 + (rng() - 0.5) * 0.35 + (rng() < 0.5 ? Math.PI : 0);   // 長手が輪に沿う
    q.setFromEuler(e.set((rng() - 0.5) * 0.12, yaw, (rng() - 0.5) * 0.12, 'YXZ'));
    pos.set(Math.cos(a) * rr, -0.005 - rng() * 0.01, Math.sin(a) * rr);
    m4.compose(pos, q, sc.set(it.sx, it.sy, it.sz));
    per[it.v].push(m4.clone());
    a += (it.w / 2 + next.w / 2) / radius;
  });
  per.forEach((list, v) => {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(P.rocks[v].geo, P.rockMat, list.length);
    list.forEach((m, i) => im.setMatrixAt(i, m));
    im.frustumCulled = false;
    group.add(im);
  });
  return group;
}
