// シーン「洞窟」。洞窟の中で焚火をする。岩壁と天井（頂点ノイズで崩した低ポリゴン＋コード生成の法線マップ）が周りを囲み、
// 奥の一方向だけ入口が開いて、そこからだけ夜空と月が見える。入口の外は木のシルエットと月光、季節の舞うもの。
// 天井から水滴が落ちて地面の水たまりに波紋を作る（音は映像の着水に合わせて playSfx('drip')）。
// 形式は scenes/index.js のコメントを参照。草地（FABOTANIC）は洞窟の中に置かない（草の量の設定は効かない）。
import * as THREE from 'three';
import { mulberry32, rnd, clamp, makePoints, radialTexture, disposeTree } from './util.js';
import { fbm3, rockNormalMap, noisedRockGeometry } from './rock.js';
import { buildTrees, leafTexture } from './trees.js';
import { loadFarTrees } from './farTrees.js';
import { makeFireflyPoints } from './firefly.js';
import { makeSnowPoints } from './snow.js';

/* ---------- 洞窟の形（焚火が原点。φ は奥(-Z)が 0、右が正） ---------- */
const H = 3.5;                                            // 天井の高さ（中央）
const R0 = (a) => 6.3 + 0.9 * Math.cos(a) + 0.35 * Math.sin(2 * a + 1.0) + 0.25 * Math.sin(3 * a + 2.3);   // 床の広がり（焚火から壁まで）。手前（カメラ側）で約5.5m
const PHE = 0.42;                                         // 入口の向き
const HW = 1.45, SPR = 1.7, CRN = 3.0;                    // 入口の半幅・アーチの起点の高さ・頂点の高さ
const E0 = new THREE.Vector3(R0(PHE) * Math.sin(PHE), 0, -R0(PHE) * Math.cos(PHE));   // 入口の床の中心
const NOUT = new THREE.Vector2(Math.sin(PHE), -Math.cos(PHE));                        // 外向き（xz）
const TLAT = new THREE.Vector2(Math.cos(PHE), Math.sin(PHE));                         // 入口の横方向（xz）
const FIRE_GAIN = 1.8, FIRE_DECAY = 1.4;                  // 焚火の光の強さの倍率と減衰（洞窟の壁の奥まで届かせるため、距離で落ちにくくする）
const MOON_AZ = 0.28;                                     // カメラ（0, 1.5, 3.6）から入口の中心が見える方位。ここに月を置く

const SEASON = {
  spring: { crown: 0x3a2433, crownE: 0x8a3f68, coniE: 0x163226, drift: 'petal', moonEl: 0.085, snow: false },
  summer: { crown: 0x0e1c14, crownE: 0x1f6a44, coniE: 0x163a28, drift: 'fireflies', moonEl: 0.07, snow: false },
  autumn: { crown: 0x2a160a, crownE: 0x9a4c18, coniE: 0x1a2a18, drift: 'leaf', moonEl: 0.09, snow: false },
  winter: { crown: 0x1c2634, crownE: 0x5a84b0, coniE: 0x2a4258, drift: 'snow', moonEl: 0.1, snow: true }
};

/* 壁面の点: 方位 a、高さの媒介 s（0=床の下 .. 1=天井の頂点）。座標だけから決まるノイズでごつごつさせる */
function wallPoint(a, s, out) {
  const t = 1 - (1 - s) * (1 - s);                        // 頂点に近いほど段を細かく
  const y0 = -0.25 + (H + 0.25) * t;
  const rr0 = R0(a) * Math.cbrt(Math.max(0, 1 - t * t * t));   // 上端が丸い箱形（壁はほぼ垂直 → 天井へ弧）
  const x0 = Math.sin(a) * rr0, z0 = -Math.cos(a) * rr0;
  const n1 = (fbm3(x0 * 0.32 + 3, y0 * 0.42, z0 * 0.32, 4) - 0.5) * 2;
  const n2 = (fbm3(x0 * 1.1 + 9, y0 * 1.3, z0 * 1.1, 3) - 0.5) * 2;
  const n3 = (fbm3(x0 * 0.5 + 21, y0 * 0.2, z0 * 0.5, 2) - 0.5) * 2;
  const fade = clamp(rr0 / 2, 0, 1);
  const rr = rr0 - (n1 * 0.85 + n2 * 0.3) * fade;
  const y = y0 + n3 * 0.45 * t * t * fade;
  return out.set(Math.sin(a) * rr, y, -Math.cos(a) * rr);
}

/* 壁面の岩肌: 入口のアーチをフラグメントで抜く（縁はノイズでぎざぎざ）。入口の近くの壁はうっすら月の青 */
function patchWall(mat, U) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uE0 = U.uE0; sh.uniforms.uT = U.uT; sh.uniforms.uN = U.uN;
    sh.vertexShader = 'varying vec3 vTkW;\n' + sh.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\n  vTkW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = `varying vec3 vTkW;
uniform vec3 uE0; uniform vec2 uT; uniform vec2 uN;
float tkSh(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float tkSn(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(tkSh(i), tkSh(i + vec3(1,0,0)), f.x), mix(tkSh(i + vec3(0,1,0)), tkSh(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(tkSh(i + vec3(0,0,1)), tkSh(i + vec3(1,0,1)), f.x), mix(tkSh(i + vec3(0,1,1)), tkSh(i + vec3(1,1,1)), f.x), f.y), f.z);
}
` + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
  vec3 tkd = vTkW - uE0;
  float tkLat = dot(tkd.xz, uT), tkAl = dot(tkd.xz, uN);
  float tkIn = -1.0;
  {
    float x = clamp(tkLat / ${HW.toFixed(3)}, -1.0, 1.0);
    float top = ${SPR.toFixed(3)} + (${CRN.toFixed(3)} - ${SPR.toFixed(3)}) * sqrt(max(0.0, 1.0 - x * x));
    float nz = (tkSn(vTkW * 2.6) - 0.5) * 0.4 + (tkSn(vTkW * 8.0) - 0.5) * 0.14;
    tkIn = min(${HW.toFixed(3)} - abs(tkLat), top - vTkW.y) + nz;
    if (abs(tkAl) < 3.2 && tkIn > 0.0 && vTkW.y > -0.1) discard;
    diffuseColor.rgb *= mix(1.0, 0.5, smoothstep(-0.55, 0.0, tkIn) * step(abs(tkAl), 3.2));
  }`).replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    float mo = exp(-length(tkd.xz - uN * 0.5) * 0.3) * (0.5 + 0.5 * tkSn(vTkW * 1.7));
    totalEmissiveRadiance += vec3(0.018, 0.032, 0.07) * mo;
  }`);
  };
  mat.customProgramCacheKey = () => 'tkcavewall';
}

function dropTexture() { return radialTexture(64, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]); }

export default {
  id: 'cave',
  label: '洞窟',
  audio: { autoOn: ['cavewind', 'scenesfx'], reverb: { seconds: 4.4, decay: 2.2, wet: 0.55 } },
  props: { logPile: { x: -2.1, z: 0.4, rotY: 0.4 } },   // 洞窟の床（平らな地面）の手前。壁・水たまり・石筍から離れた位置

  build(ctx) {
    const { scene, root, api, ground, uScale, fireLights, lights, sky } = ctx;
    let disposed = false, cfg = SEASON.summer, curT = 0, driftKey = '', curSeasonKey = '';
    const texs = [], geos = [], mats = [];
    const own = (list, x) => { list.push(x); return x; };
    const rng = mulberry32(8123);
    const tmp = new THREE.Vector3();

    /* --- 光: 焚火の光が洞窟の奥まで届くようにする。環境光は落とし、月の光は入口の外の淡い点光源だけにする --- */
    const origRange = fireLights.map((l) => l.distance);
    const origDecay = fireLights.map((l) => l.decay);
    fireLights.forEach((l) => { l.distance = Math.max(l.distance, 30); l.decay = FIRE_DECAY; });
    const origHemi = lights.hemi.intensity;
    lights.hemi.intensity = 0.22;
    const moonSpill = new THREE.PointLight(0x86a6ff, 5.5, 16, 2);
    moonSpill.position.set(E0.x + NOUT.x * 2.4, 2.0, E0.z + NOUT.y * 2.4);
    scene.add(moonSpill);
    // 焚火の真上の弱い補助光: 低い位置の焚火の光は、床に斜めにしか当たらず奥の床が真っ暗になるため
    const fill = new THREE.PointLight(0xff9a5a, 0, 22, 1.3);
    fill.position.set(0, 2.7, -0.4);
    scene.add(fill);

    /* --- 地面: 湿った土（色を落とす。dispose で戻す） --- */
    const origGroundColor = ground ? ground.material.color.clone() : null;
    if (ground) ground.material.color.setRGB(0.72, 0.7, 0.7);

    /* --- 岩壁と天井 --- */
    const U = { uE0: { value: E0.clone() }, uT: { value: TLAT.clone() }, uN: { value: NOUT.clone() } };
    const rockNormal = own(texs, rockNormalMap(256, 17, 6));
    rockNormal.repeat.set(1, 1);
    const wallMat = own(mats, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.62, metalness: 0, normalMap: rockNormal, normalScale: new THREE.Vector2(1.45, 1.45), side: THREE.FrontSide
    }));
    patchWall(wallMat, U);
    {
      const NPH = 168, NS = 44, P = [], C = [], UV = [], I = [], pt = new THREE.Vector3(), col = new THREE.Color();
      const dark = new THREE.Color(0x3a3430), light = new THREE.Color(0x70675c);
      for (let j = 0; j <= NS; j++) for (let i = 0; i <= NPH; i++) {
        const a = i / NPH * Math.PI * 2, s = j / NS;
        wallPoint(a, s, pt);
        P.push(pt.x, pt.y, pt.z);
        UV.push(18 * i / NPH, (pt.y + 0.25) / 2.1);
        const tone = fbm3(pt.x * 0.55 + 5, pt.y * 0.7, pt.z * 0.55, 3), grain = 0.72 + 0.56 * fbm3(pt.x * 2.4, pt.y * 2.4, pt.z * 2.4 + 4, 2);
        col.copy(dark).lerp(light, tone).multiplyScalar(grain);
        if (pt.y < 0.8) { const w = 1 - pt.y / 0.8; col.r *= 1 - 0.28 * w; col.g *= 1 - 0.1 * w; col.b *= 1 - 0.18 * w; }   // 床近くは湿って暗く、わずかに青緑
        if (pt.y > 3.0) col.multiplyScalar(0.85);
        C.push(col.r, col.g, col.b);
      }
      for (let j = 0; j < NS; j++) for (let i = 0; i < NPH; i++) {
        const a = j * (NPH + 1) + i, b = a + 1, c = a + NPH + 1, d = c + 1;
        I.push(a, b, c, b, d, c);
      }
      const g = own(geos, new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
      g.setIndex(I); g.computeVertexNormals();
      // 面が内向きになっているか確かめる（法線が中心を向いていなければ巻き順を反転）
      {
        const k = (NS >> 1) * (NPH + 1) + 5, nrm = g.attributes.normal, pos = g.attributes.position;
        const inward = -(nrm.getX(k) * pos.getX(k) + nrm.getZ(k) * pos.getZ(k));
        if (inward < 0) { for (let q = 0; q < I.length; q += 3) { const t = I[q + 1]; I[q + 1] = I[q + 2]; I[q + 2] = t; } g.setIndex(I); g.computeVertexNormals(); }
      }
      // 方位の継ぎ目の法線をそろえる
      const nrm = g.attributes.normal;
      for (let j = 0; j <= NS; j++) {
        const k0 = j * (NPH + 1), k1 = k0 + NPH;
        const x = nrm.getX(k0) + nrm.getX(k1), y = nrm.getY(k0) + nrm.getY(k1), z = nrm.getZ(k0) + nrm.getZ(k1), l = Math.hypot(x, y, z) || 1;
        nrm.setXYZ(k0, x / l, y / l, z / l); nrm.setXYZ(k1, x / l, y / l, z / l);
      }
      const wall = new THREE.Mesh(g, wallMat); wall.frustumCulled = false; root.add(wall);
    }

    /* 壁面の点（方位 a・水平半径 rr に当たる所）。鍾乳石や岩を壁・天井に埋め込むのに使う */
    const wallAt = (a, rr, out) => {
      let lo = 0, hi = 1;
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2; wallPoint(a, mid, out);
        if (Math.hypot(out.x, out.z) > rr) lo = mid; else hi = mid;
      }
      return wallPoint(a, (lo + hi) / 2, out);
    };

    /* --- 入口のアーチの縁に大きな岩を並べて、縁の厚みと荒さを出す --- */
    {
      const geo = own(geos, noisedRockGeometry(1, 3.3, 0.38));
      const m = own(mats, new THREE.MeshStandardMaterial({ color: 0x4a443d, roughness: 0.65, normalMap: rockNormal, normalScale: new THREE.Vector2(1.5, 1.5) }));
      const pts = [];
      for (let y = 0.15; y < SPR; y += 0.5) { pts.push([-HW - 0.08, y]); pts.push([HW + 0.08, y]); }
      for (let k = 0; k <= 9; k++) { const x = -1 + k / 4.5; pts.push([x * (HW + 0.08), SPR + (CRN - SPR) * Math.sqrt(Math.max(0, 1 - x * x)) + 0.12]); }
      const im = new THREE.InstancedMesh(geo, m, pts.length), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color();
      pts.forEach(([lat, y], i) => {
        const s = 0.26 + rng() * 0.22, off = rng() * 0.5 - 0.05;
        q.setFromEuler(e.set(rng() * 3, rng() * 6, rng() * 3));
        m4.compose(new THREE.Vector3(E0.x + TLAT.x * lat + NOUT.x * off, y, E0.z + TLAT.y * lat + NOUT.y * off), q, new THREE.Vector3(s * (1 + rng() * 0.4), s * (0.8 + rng() * 0.4), s));
        im.setMatrixAt(i, m4); im.setColorAt(i, c.setScalar(0.65 + rng() * 0.6));
      });
      im.frustumCulled = false; root.add(im);
    }

    /* --- 鍾乳石（壁際の天井から）と石筍（床から） --- */
    // 鍾乳石の形: 太さが不規則に変わり（うねり）、ところどころにこぶがあり、先へ向かって細くなって少し曲がる。断面も崩す
    const stalGeo = (() => {
      const pr = [], NK = 18;
      for (let k = 0; k <= NK; k++) {
        const ty = k / NK;
        let r = (0.06 + 0.94 * Math.pow(1 - ty, 1.25)) * (1 + 0.2 * Math.sin(ty * 15 + 1.3) + 0.1 * Math.sin(ty * 37 + 0.4));
        r += 0.2 * Math.exp(-Math.pow((ty - 0.3) / 0.07, 2)) + 0.14 * Math.exp(-Math.pow((ty - 0.62) / 0.06, 2));   // こぶ
        pr.push(new THREE.Vector2(Math.max(0.035, r), -ty));
      }
      const g = new THREE.LatheGeometry(pr, 10), p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = 1 + 0.9 * (fbm3(x * 3 + 2, y * 4, z * 3, 3) - 0.5);
        p.setXYZ(i, x * k + 0.18 * y * y, y, z * k - 0.08 * y * y);
      }
      g.computeVertexNormals();
      return own(geos, g);
    })();
    // 岩壁と同じ系統の、濡れて少し光る茶灰色
    const stalMat = own(mats, new THREE.MeshStandardMaterial({ color: 0x6a5e51, roughness: 0.34, metalness: 0.05, emissive: 0x060504, normalMap: rockNormal, normalScale: new THREE.Vector2(1.2, 1.2) }));
    const dripSpots = [];
    {
      const list = [];
      const add = (a, rr, len, rad, drip) => { wallAt(a, rr, tmp); list.push({ x: tmp.x, y: tmp.y + 0.2, z: tmp.z, len, rad, drip }); };
      // 水滴が落ちる3本（映像の見える範囲に、長めに垂らす）
      [[-0.78, 4.2], [0.3, 4.3], [-1.45, 4.4]].forEach(([a, rr]) => { add(a, rr, 1.15, 0.26, true); });
      let n = 0, guard = 0;
      while (n < 15 && guard++ < 200) {
        const a = (rng() - 0.5) * Math.PI * 2 * 0.95 + 0.0, rr = R0(a) * (0.55 + rng() * 0.38);
        if (Math.abs(a - PHE) < 0.4) continue;
        add(a, rr, 0.35 + rng() * 0.8, 0.15 + rng() * 0.14, false); n++;
      }
      const im = new THREE.InstancedMesh(stalGeo, stalMat, list.length), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color();
      list.forEach((s, i) => {
        q.setFromEuler(e.set(0, rng() * 6, 0));
        m4.compose(tmp.set(s.x, s.y, s.z), q, new THREE.Vector3(s.rad, s.len, s.rad));
        im.setMatrixAt(i, m4); im.setColorAt(i, c.setScalar(0.8 + rng() * 0.4));
        if (s.drip) dripSpots.push({ x: s.x, z: s.z, tipY: s.y - s.len });
      });
      im.frustumCulled = false; root.add(im);
      // 石筍: 床に立つ。同じ形を上下反転
      const N = 6, sm = new THREE.InstancedMesh(stalGeo, stalMat, N);
      for (let i = 0; i < N; i++) {
        let a, rr, g2 = 0;
        do { a = (rng() - 0.5) * Math.PI * 1.9; rr = R0(a) * (0.7 + rng() * 0.2); g2++; } while (Math.abs(a - PHE) < 0.4 && g2 < 20);
        const hgt = 0.3 + rng() * 0.5, rad = 0.09 + rng() * 0.08;
        q.setFromEuler(e.set(Math.PI, rng() * 6, 0));
        m4.compose(tmp.set(Math.sin(a) * rr, hgt - 0.02, -Math.cos(a) * rr), q, new THREE.Vector3(rad, hgt, rad));
        sm.setMatrixAt(i, m4);
      }
      sm.frustumCulled = false; root.add(sm);
    }

    /* --- 地面: 湿った岩（平たい岩）と小石 --- */
    {
      const slabGeo = own(geos, noisedRockGeometry(1, 11.1, 0.22));
      const cobGeo = own(geos, noisedRockGeometry(1, 5.7, 0.28));
      const wetMat = own(mats, new THREE.MeshStandardMaterial({ color: 0x57524c, roughness: 0.5, metalness: 0.02, normalMap: rockNormal, normalScale: new THREE.Vector2(1, 1) }));
      const NSL = 16, NCO = 170;
      const sl = new THREE.InstancedMesh(slabGeo, wetMat, NSL), co = new THREE.InstancedMesh(cobGeo, wetMat, NCO);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color();
      const place = (list, i, x, z, sx, sy, sz, ry, lift) => {
        q.setFromEuler(e.set((rng() - 0.5) * 0.12, ry, (rng() - 0.5) * 0.12));
        m4.compose(tmp.set(x, sy * lift, z), q, new THREE.Vector3(sx, sy, sz)); list.setMatrixAt(i, m4);
        list.setColorAt(i, c.setHex([0x5a544c, 0x4a453f, 0x6a645a, 0x3f3f44][Math.floor(rng() * 4)]).multiplyScalar(0.7 + rng() * 0.5));
      };
      for (let i = 0; i < NSL; i++) {
        const a = rng() * Math.PI * 2, rr = R0(a) * (0.45 + rng() * 0.5);
        const x = Math.sin(a) * rr, z = -Math.cos(a) * rr;
        if (Math.hypot(x, z) < 1.9 || z > 0.2) { place(sl, i, 30, 30, 0.001, 0.001, 0.001, 0, 0); continue; }
        place(sl, i, x, z, 0.5 + rng() * 0.9, 0.1 + rng() * 0.08, 0.4 + rng() * 0.7, rng() * 6, 0.35);
      }
      let n = 0, guard = 0;
      while (n < NCO && guard++ < 2000) {
        const a = rng() * Math.PI * 2, rr = 1.65 + Math.sqrt(rng()) * (R0(a) - 2.0);
        const x = Math.sin(a) * rr, z = -Math.cos(a) * rr;
        const near = z > 1.0 && Math.abs(x) < 3.2;      // カメラ手前は小さく少なく（焚火をふさがない）
        if (near && rng() < 0.8) continue;
        const s = near ? 0.04 + rng() * 0.04 : 0.05 + Math.pow(rng(), 2) * 0.28;
        place(co, n, x, z, s * (1.1 + rng() * 0.5), s * (0.6 + rng() * 0.3), s, rng() * 6, 0.3); n++;
      }
      co.count = n;
      sl.frustumCulled = false; co.frustumCulled = false; root.add(sl, co);
    }

    /* --- 水滴と水たまり --- */
    // 水たまり: 縁が不規則な形（形は1つずつ違う）。縁はすっと透け、焚火の暖かい光と入口の月明かりが、かすかに映る
    const PU = {
      uTime: { value: 0 }, uFlame: { value: 0 }, uFire: { value: new THREE.Vector3(0, 0.55, 0) },
      uMoonP: { value: new THREE.Vector3(E0.x + NOUT.x * 1.2, 1.6, E0.z + NOUT.y * 1.2) }
    };
    const puddleMat = own(mats, new THREE.ShaderMaterial({
      uniforms: PU, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      vertexShader: `varying vec3 vW; varying float vE; attribute float aE;
void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz; vE = aE; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `uniform float uTime, uFlame; uniform vec3 uFire, uMoonP;
varying vec3 vW; varying float vE;
void main() {
  vec3 V = normalize(cameraPosition - vW);
  vec2 q = vW.xz * 9.0;
  vec3 N = normalize(vec3(0.06 * sin(q.x + uTime * 0.7 + sin(q.y * 1.3)), 1.0, 0.06 * sin(q.y * 1.1 - uTime * 0.6 + sin(q.x * 0.9))));
  vec3 R = reflect(-V, N);
  vec3 toF = uFire - vW; float dF = length(toF);
  float fres = 0.15 + 0.85 * pow(1.0 - max(dot(N, V), 0.0), 3.0);
  float sm = pow(max(dot(R, normalize(uMoonP - vW)), 0.0), 7.0);
  float sf = pow(max(dot(R, normalize(toF)), 0.0), 6.0);
  vec3 col = vec3(0.016, 0.026, 0.034)
    + vec3(1.0, 0.46, 0.16) * uFlame * (0.045 / (1.0 + dF * dF * 0.1) * fres + 0.5 * sf)
    + vec3(0.30, 0.45, 0.85) * sm * 0.45 * fres;
  float a = 0.9 * smoothstep(0.0, 0.45, 1.0 - vE);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`
    }));
    const puddleGeos = [0, 1, 2, 3, 4].map((i) => {
      const NP = 32, P = [0, 0, 0], E = [0], I = [], ph = [i * 1.7, i * 2.9 + 1, i * 0.8 + 2];
      for (let k = 0; k < NP; k++) {
        const th = k / NP * Math.PI * 2;
        const r = 1 + 0.2 * Math.sin(2 * th + ph[0]) + 0.14 * Math.sin(3 * th + ph[1]) + 0.1 * Math.sin(5 * th + ph[2]) + 0.05 * Math.sin(9 * th + ph[0] * 2);
        P.push(Math.cos(th) * r, 0, Math.sin(th) * r); E.push(1);
        I.push(0, 1 + (k + 1) % NP, 1 + k);
      }
      const g = own(geos, new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('aE', new THREE.Float32BufferAttribute(E, 1)); g.setIndex(I);
      return g;
    });
    const ringGeo = own(geos, new THREE.RingGeometry(0.88, 1, 32)); ringGeo.rotateX(-Math.PI / 2);
    const beadGeo = own(geos, new THREE.SphereGeometry(1, 8, 6));
    const streakGeo = own(geos, new THREE.CylinderGeometry(1, 1, 1, 5, 1, true)); streakGeo.translate(0, -0.5, 0);
    const beadMat = own(mats, new THREE.MeshBasicMaterial({ color: 0xc8e0ff, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    const streakMat = own(mats, new THREE.MeshBasicMaterial({ color: 0xb4d4ff, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide }));
    const drips = dripSpots.map((d, i) => {
      const pud = new THREE.Mesh(puddleGeos[i % puddleGeos.length], puddleMat); pud.position.set(d.x, 0.012, d.z); pud.rotation.y = i * 1.3; pud.scale.set(0.5 + 0.1 * i, 1, 0.38 + 0.08 * i); root.add(pud);
      const bead = new THREE.Mesh(beadGeo, beadMat); bead.position.set(d.x, d.tipY, d.z); bead.visible = false; root.add(bead);
      const streak = new THREE.Mesh(streakGeo, streakMat); streak.visible = false; streak.renderOrder = 6; root.add(streak);
      const rings = [0, 1, 2].map(() => {
        const m = new THREE.Mesh(ringGeo, own(mats, new THREE.MeshBasicMaterial({ color: 0xaac8e8, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })));
        m.position.set(d.x, 0.02, d.z); m.visible = false; root.add(m); return { m, t0: -99 };
      });
      const h = d.tipY - 0.02;
      return { ...d, bead, streak, rings, h, fall: Math.sqrt(2 * h / 9.8), state: 'wait', t0: 0, until: 1.5 + i * 2.1 + rnd(0, 2), nextRing: 0 };
    });
    const G = 9.8;
    function updateDrips(t) {
      for (const d of drips) {
        if (d.state === 'wait') {
          if (t > d.until) { d.state = 'form'; d.t0 = t; d.bead.visible = true; }
        } else if (d.state === 'form') {
          const p = clamp((t - d.t0) / 1.4, 0, 1);
          d.bead.scale.setScalar(0.004 + 0.016 * p * p); d.bead.position.set(d.x, d.tipY - 0.02 * p * p, d.z);
          if (p >= 1) {
            d.state = 'fall'; d.t0 = t; d.bead.visible = false; d.streak.visible = true;
            api.playSfx && api.playSfx('drip', { delay: d.fall, vol: rnd(0.8, 1.0), pan: clamp(d.x / 5, -0.8, 0.8) });   // 映像の着水の時刻に合わせて予約
          }
        } else if (d.state === 'fall') {
          const tau = t - d.t0;
          if (tau >= d.fall) {
            d.streak.visible = false; d.state = 'wait'; d.until = t + rnd(2.5, 8);
            const r = d.rings[d.nextRing++ % 3]; r.t0 = t;
            d.rings[d.nextRing % 3].t0 = t + 0.35;   // 少し遅れて2つ目の輪
          } else {
            const y = d.tipY - 0.5 * G * tau * tau, v = G * tau, len = clamp(v * 0.045, 0.04, 0.4);
            d.streak.position.set(d.x, Math.max(0.03 + len, y + len * 0.5), d.z); d.streak.scale.set(0.006, len, 0.006);
          }
        }
        for (const r of d.rings) {
          const age = t - r.t0, on = age >= 0 && age < 1.8;
          r.m.visible = on;
          if (on) { r.m.scale.setScalar(0.03 + age * 0.22); r.m.material.opacity = 0.55 * Math.pow(1 - age / 1.8, 1.5); }
        }
      }
    }

    /* --- 入口から射す月明かり（床のにじみ） --- */
    {
      const tex = own(texs, radialTexture(128, [[0, 'rgba(255,255,255,0.9)'], [0.5, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]));
      const g = own(geos, new THREE.PlaneGeometry(1, 1)); g.rotateX(-Math.PI / 2);
      const m = own(mats, new THREE.MeshBasicMaterial({ map: tex, color: 0x3a5488, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
      const spill = new THREE.Mesh(g, m); spill.position.set(E0.x - NOUT.x * 0.6, 0.03, E0.z - NOUT.y * 0.6);
      spill.rotation.y = -Math.atan2(NOUT.y, NOUT.x) + Math.PI / 2; spill.scale.set(4.6, 1, 6.5); root.add(spill);
    }

    /* --- 入口の外の月明かりの地面（木の影が浮かぶよう、うっすら青く光らせる） --- */
    {
      const tex = own(texs, radialTexture(128, [[0, 'rgba(255,255,255,0.8)'], [0.55, 'rgba(255,255,255,0.4)'], [1, 'rgba(255,255,255,0)']]));
      const g = own(geos, new THREE.PlaneGeometry(1, 1)); g.rotateX(-Math.PI / 2);
      const m = own(mats, new THREE.MeshBasicMaterial({ map: tex, color: 0x2b4272, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
      const glow = new THREE.Mesh(g, m); glow.position.set(E0.x + NOUT.x * 13, 0.04, E0.z + NOUT.y * 13);
      glow.rotation.y = Math.PI - PHE; glow.scale.set(34, 1, 40); root.add(glow);
    }

    /* --- 入口の外: 木のシルエット・雪だまり --- */
    const mdx = Math.sin(MOON_AZ), mdz = -Math.cos(MOON_AZ);
    const treePts = (() => {
      const pts = []; let guard = 0;
      while (pts.length < 28 && guard++ < 600) {
        const a = PHE + (rng() - 0.5) * 1.5, d = 12 + rng() * 17, x = Math.sin(a) * d, z = -Math.cos(a) * d;
        const dx = x - E0.x, dz = z - E0.z;
        if (dx * mdx + dz * mdz > 0 && Math.abs(dx * mdz - dz * mdx) < 2.4) continue;   // 月の光の通り道には立てない
        pts.push({ x, z, s: 0.9 + rng() * 1.3, y: -0.05 });
      }
      return pts;
    })();
    const trees = buildTrees(treePts, 77, 0.6);   // 仮の木（遠景の木が読めなかったときの代わり）
    root.add(trees.group);
    // FABOTANIC の遠景の木。読めたら仮の木と入れ替える
    let far = null;
    loadFarTrees(ctx, treePts.map((p) => ({ x: p.x, z: p.z, y: p.y, h: Math.min(14, Math.max(6, p.s * 6.8)) })), { seed: 41, brightness: 1.15 }).then((h) => {
      if (!h || disposed) { if (h) h.dispose(); return; }
      far = h; root.add(h.group); trees.group.visible = false;
      if (curSeasonKey) h.setSeason(curSeasonKey);
    }).catch((e) => console.warn('[takibi] far trees:', e));
    const snowPatchGeo = own(geos, new THREE.CircleGeometry(0.5, 14)); snowPatchGeo.rotateX(-Math.PI / 2);
    const snowTex = own(texs, radialTexture(128, [[0, 'rgba(255,255,255,0.9)'], [0.5, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]));
    const snowMat = own(mats, new THREE.MeshLambertMaterial({ color: 0xcfdcee, emissive: 0x1a2840, map: snowTex, transparent: true, depthWrite: false }));
    const snowPatches = new THREE.InstancedMesh(snowPatchGeo, snowMat, 16); snowPatches.frustumCulled = false; snowPatches.visible = false;
    {
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sr = mulberry32(31);
      for (let i = 0; i < 16; i++) {
        const lat = (sr() - 0.5) * 11, al = 1.6 + sr() * 9, s = 0.9 + sr() * 1.6;
        q.setFromEuler(e.set(0, sr() * 6, 0));
        m4.compose(new THREE.Vector3(E0.x + TLAT.x * lat + NOUT.x * al, 0.02, E0.z + TLAT.y * lat + NOUT.y * al), q, new THREE.Vector3(s * 1.4, 1, s));
        snowPatches.setMatrixAt(i, m4);
      }
      root.add(snowPatches);
    }

    /* --- 入口の外の季節: 春の花びら・秋の落ち葉・冬の雪（外だけ）。夏はホタル --- */
    const NDR = 90;
    const mkDrift = (kind, size, color, emissive) => {
      const m = own(mats, new THREE.MeshLambertMaterial({ map: own(texs, leafTexture(kind)), transparent: true, alphaTest: 0.04, side: THREE.DoubleSide, depthWrite: false, color, emissive }));
      const im = new THREE.InstancedMesh(own(geos, new THREE.PlaneGeometry(size, size)), m, NDR); im.frustumCulled = false; im.visible = false; root.add(im); return im;
    };
    const driftMesh = { petal: mkDrift('petal', 0.12, 0xffffff, 0x4a2a38), leaf: mkDrift('maple', 0.2, 0xffffff, 0x3a1c0a) };
    const snowPts = makeSnowPoints(300, uScale); snowPts.points.visible = false; root.add(snowPts.points);
    const FFN = 22;
    const ffPts = makeFireflyPoints(FFN, uScale); ffPts.points.visible = false; root.add(ffPts.points);
    const toWorld = (lat, al, y, out) => out.set(E0.x + TLAT.x * lat + NOUT.x * al, y, E0.z + TLAT.y * lat + NOUT.y * al);
    let drift = [], ff = [], ffAmt = 0;
    const dm4 = new THREE.Matrix4(), dq = new THREE.Quaternion(), de = new THREE.Euler(), dp = new THREE.Vector3(), ds = new THREE.Vector3(), dc = new THREE.Color();
    function initDrift(kind, on) {
      drift = []; driftKey = kind + on;
      for (const k in driftMesh) driftMesh[k].visible = on && ((kind === 'petal' && k === 'petal') || (kind === 'leaf' && k === 'leaf'));
      snowPts.points.visible = on && kind === 'snow';
      if (!on || kind === 'fireflies') { snowPts.flush(0); return; }
      const N = kind === 'snow' ? 260 : kind === 'petal' ? 80 : 60;
      const cs = kind === 'leaf' ? [0xe0842a, 0xc8471c, 0xd9a12e, 0xa02c14] : [0xffd2e0, 0xffc2d6, 0xffe4ec];
      for (let i = 0; i < N; i++) {
        drift.push({ lat: (Math.random() - 0.5) * 12, al: rnd(1.3, 10), y: rnd(0, 5.5), vy: rnd(0.25, 0.6), ph: rnd(0, 20), sz: rnd(0.75, 1.3), f1: rnd(1.2, 2.6), f2: rnd(1.0, 2.2), spin: rnd(-2.2, 2.2), tilt: rnd(0.5, 1.1) });
        if (kind !== 'snow') driftMesh[kind].setColorAt(i, dc.setHex(cs[i % cs.length]));
      }
      if (kind !== 'snow') { driftMesh[kind].count = N; driftMesh[kind].instanceColor.needsUpdate = true; }
    }
    function updateDrift(kind, dt, t) {
      const n = drift.length;
      for (let i = 0; i < n; i++) {
        const d = drift[i];
        d.y -= d.vy * dt * (kind === 'snow' ? 0.5 : kind === 'leaf' ? 1.0 : 0.7);
        d.lat += (0.25 + Math.sin(t * 1.1 + d.ph) * 0.35) * dt; d.al += Math.cos(t * 0.9 + d.ph) * 0.2 * dt;
        if (d.y < 0.03 || d.lat > 6.5) { d.y = 5.8; d.lat = (Math.random() - 0.5) * 12; d.al = rnd(1.3, 10); }
        if (d.al < 1.3) d.al = 1.3;
        toWorld(d.lat, d.al, d.y, dp);
        if (kind === 'snow') {
          const P = snowPts, o = i * 3;
          P.pos[o] = dp.x; P.pos[o + 1] = dp.y; P.pos[o + 2] = dp.z; P.size[i] = 0.032 * d.sz * d.sz; P.alp[i] = 0.92; P.col[o] = 0.93; P.col[o + 1] = 0.96; P.col[o + 2] = 1;
        } else {
          de.set(Math.sin(t * d.f1 + d.ph) * d.tilt, t * d.spin + d.ph, Math.cos(t * d.f2 + d.ph) * d.tilt); dq.setFromEuler(de);
          dm4.compose(dp, dq, ds.setScalar(d.sz)); driftMesh[kind].setMatrixAt(i, dm4);
        }
      }
      if (kind === 'snow') snowPts.flush(n); else if (driftMesh[kind]) driftMesh[kind].instanceMatrix.needsUpdate = true;
    }
    for (let i = 0; i < FFN; i++) ff.push({ lat: (Math.random() - 0.5) * 11, al: rnd(2, 11), y: rnd(0.3, 2.4), a: rnd(0, 6.28), sp: rnd(0.12, 0.28), per: rnd(2.2, 3.2), ph: Math.random() });
    function updateFireflies(dt, t, on) {
      ffAmt += ((on ? 1 : 0) - ffAmt) * (1 - Math.exp(-dt * 1.5));
      if (ffAmt < 0.01 && !on) { ffPts.points.visible = false; return; }
      ffPts.points.visible = true;
      const P = ffPts;
      for (let i = 0; i < FFN; i++) {
        const d = ff[i], o = i * 3;
        d.a += (Math.random() - 0.5) * 2.2 * dt;
        d.lat += Math.cos(d.a) * d.sp * dt; d.al += Math.sin(d.a) * d.sp * dt; d.y = clamp(d.y + Math.sin(d.a * 1.3 + d.ph * 6) * d.sp * 0.4 * dt, 0.25, 2.5);
        if (Math.abs(d.lat) > 6 || d.al < 2 || d.al > 11.5) d.a += Math.PI;
        const u = (t / d.per + d.ph) % 1, b = u < 0.72 ? Math.pow(Math.sin(Math.PI * u / 0.72), 2) : 0;
        toWorld(d.lat, d.al, d.y, dp);
        P.pos[o] = dp.x; P.pos[o + 1] = dp.y; P.pos[o + 2] = dp.z;
        P.size[i] = 0.26; P.alp[i] = b * 0.95 * ffAmt; P.col[o] = 0.77; P.col[o + 1] = 1; P.col[o + 2] = 0.42;
      }
      P.flush(FFN);
    }

    function applySeason(s) {
      cfg = SEASON[s]; curSeasonKey = s;
      if (far) far.setSeason(s);
      sky.setMoon(MOON_AZ, cfg.moonEl);
      trees.setColors(cfg.crown, cfg.crownE, cfg.coniE);
      snowPatches.visible = cfg.snow;
      driftKey = '';
    }

    return {
      setSeason(s) { applySeason(s); },
      update(dt, t, st) {
        curT = t; PU.uTime.value = t; PU.uFlame.value = (st.started ? clamp(st.flame, 0, 1.3) : 0) * (0.85 + 0.15 * Math.sin(t * 13 + Math.sin(t * 5) * 2)) + 0.12 * (st.ember || 0);
        let sum = 0; fireLights.forEach((l) => { sum += l.intensity; l.intensity *= FIRE_GAIN; });
        fill.intensity = 0.14 * sum;   // fire3d は毎フレーム強さを入れ直す。洞窟では壁が揺らめいて見えるよう、そのあとに掛ける
        lights.moon.intensity = 0.03;             // 月の光は洞窟の中には差さない（外の淡い光は moonSpill）
        const fl = 0.92 + 0.08 * Math.sin(t * 0.9);
        moonSpill.intensity = 5.5 * fl;
        ctx.fireflies.value = 0;                  // 共通のホタルは使わない（入口の外に専用の群れを置く）
        const fx = st.seasonFx;
        if (driftKey !== cfg.drift + (fx ? 1 : 0)) initDrift(cfg.drift, fx);
        if (fx && drift.length && cfg.drift !== 'fireflies') updateDrift(cfg.drift, dt, t);
        updateFireflies(dt, t, !!st.fireflies);
        updateDrips(t);
      },
      dispose() {
        disposed = true;
        fireLights.forEach((l, i) => { l.distance = origRange[i]; l.decay = origDecay[i]; });
        lights.hemi.intensity = origHemi;
        scene.remove(moonSpill, fill);
        if (ground && origGroundColor) ground.material.color.copy(origGroundColor);
        ctx.fireflies.value = 1;
        if (far) { far.dispose(); far = null; }
        trees.dispose();
        texs.forEach((x) => x.dispose()); geos.forEach((x) => x.dispose()); mats.forEach((x) => x.dispose());
        disposeTree(snowPts.points); disposeTree(ffPts.points);
      }
    };
  }
};
