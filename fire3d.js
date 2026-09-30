// 焚火 3D の炎・火花・煙・熾火・火の光（three.js）。scene3d.js から createFire() で作り、
// 毎フレーム update()、描画は render()、終了時に dispose() を呼ぶ。外部の画像は使わず、模様はすべてシェーダー内のノイズで作る。
import * as THREE from 'three';

const MAX_SPARK = 400;
const SPARKS_PER_FRAME = 40;   // 1フレームで新しく出す火花の上限
const SPARKS_PER_FRAME_ACCENT = 80;   // アクセントのフレームだけ緩める
const STALE_MS = 300;          // これより古い火花イベントは捨てる
const BLOOM_LEVELS = { many: true, normal: true, few: false, none: false };   // 草の量が「少ない」「なし」ではブルームを切る

const rnd = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { x = clamp((x - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };

/* ---------- GLSL 共通: ハッシュ・値ノイズ・fBm・ボロノイ ---------- */
const NOISE = /* glsl */`
float tkHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float tkNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tkHash(i), tkHash(i + vec2(1.0, 0.0)), u.x), mix(tkHash(i + vec2(0.0, 1.0)), tkHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float tkFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++) { s += a * tkNoise(p); p = m * p + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}
vec2 tkWorley2(vec2 p) {
  vec2 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = vec2(tkHash(i + g), tkHash(i + g + 17.3));
    vec2 r = g + o - f; float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return vec2(sqrt(d1), sqrt(d2));
}
vec3 tkHash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453);
}
vec2 tkWorley3(vec3 p) {
  vec3 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 r = g + tkHash3(i + g) - f; float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return vec2(sqrt(d1), sqrt(d2));
}
// 黒体っぽい温度の色（0=冷えた暗い赤 → 1=白）。値は線形・HDR 前
vec3 tkHeat(float T) {
  vec3 c = vec3(0.22, 0.015, 0.0);
  c = mix(c, vec3(0.85, 0.12, 0.01), smoothstep(0.04, 0.3, T));
  c = mix(c, vec3(1.0, 0.42, 0.05), smoothstep(0.28, 0.55, T));
  c = mix(c, vec3(1.0, 0.78, 0.32), smoothstep(0.52, 0.8, T));
  c = mix(c, vec3(1.0, 0.95, 0.82), smoothstep(0.8, 1.0, T));
  return c;
}
`;

/* ---------- 炎: 縦軸まわりにカメラを向く板。スクロールする fBm で形を削る ---------- */
const FLAME_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FLAME_FRAG = /* glsl */`
uniform vec2 uSize;        // 板の幅・高さ（ワールド単位）
uniform float uScroll;     // 上昇のスクロール量（CPU で積算。強さで速さが変わっても跳ばない）
uniform float uSeed, uInt, uCool;
varying vec2 vUv;
${NOISE}
void main() {
  float y = vUv.y, x = vUv.x * 2.0 - 1.0;
  vec2 W = vec2(x * uSize.x * 0.5, y * uSize.y);     // ワールド単位の座標（背の高い炎ほど舌が多くなる）
  float s = uScroll;
  // 全体のうねり（上ほど大きく曲がる）
  float bend = (tkFbm(vec2(uSeed * 3.1, W.y * 0.9 - s * 0.35)) - 0.5) * 1.3 * y * y;
  float n1 = tkFbm(vec2(W.x * 2.4 + uSeed, W.y * 1.9 - s * 1.2));
  x += bend + (n1 - 0.5) * 0.8 * y;
  // しずく形の輪郭: 根元は丸く広く、上へ細る
  float w = 0.9 * pow(max(0.0, 1.0 - y), 0.65) * (0.55 + 0.45 * smoothstep(0.0, 0.3, y));
  float body = 1.0 - smoothstep(w * 0.2, w, abs(x));
  // 細かい乱れで削る。縦に引き伸ばしたノイズなので縦長の「舌」に割れ、上ほど削れてちぎれた舌が上へ流れる
  float n2 = tkFbm(vec2(W.x * 6.5 + uSeed * 2.3 + n1 * 0.8, W.y * 2.3 - s * 2.3));
  float d = body * (0.2 + 1.1 * n2) - y * 0.55;
  float a = smoothstep(0.0, 0.18, d) * smoothstep(0.0, 0.28, y);   // 根元は薪の間から柔らかく立ち上がる
  if (a < 0.004) discard;
  // 温度: 芯（d が大きい所）と根元ほど熱く、上へ行くほど冷えて赤く暗くなる
  float T = clamp(d * 1.4, 0.0, 1.0) * (1.0 - 0.55 * y) + 0.06 * (1.0 - y) - uCool;
  T = clamp(T, 0.0, 1.0) * mix(0.75, 1.0, smoothstep(0.0, 0.2, y));
  vec3 c = tkHeat(T);
  // 根元の縁のわずかな青（芯ではなく、根元の外側）
  float blue = (1.0 - smoothstep(0.03, 0.22, y)) * (1.0 - smoothstep(0.25, 0.7, T));
  c = mix(c, vec3(0.2, 0.32, 1.0) * 0.6, blue * 0.6);
  // 炎の中のゆらぎ（明るさのむら）
  float inner = 0.7 + 0.6 * tkNoise(W * vec2(9.0, 5.0) - vec2(0.0, s * 3.2));
  gl_FragColor = vec4(c * uInt * (0.25 + 1.1 * T * T) * inner, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ---------- 火花: 速度方向に伸ばした光の筋。位置は GPU で解析的に求める ---------- */
const SPARK_VERT = /* glsl */`
attribute vec3 iOrigin;
attribute vec3 iVel;
attribute vec4 iA;     // 誕生時刻, 寿命, 乱数, 種類(0=上昇 1=弾道)
attribute vec4 iB;     // 太さ, 初期温度, 着地時刻(弾道), 上昇の終端速度 or 重力
uniform float uTime, uStreak, uPx;
uniform vec2 uRes;
varying vec2 vQ;
varying vec3 vCol;
varying float vA;
${NOISE}
float gImpact;   // 最後に地面に当たってからの時間（当たっていなければ負）
vec3 posAt(float age, float time) {
  vec3 p;
  if (iA.w < 0.5) {
    // 上昇: 抗力で初速が抜け、浮力の終端速度に近づく。乱流で横に揺れる
    float tau = 0.42, e = 1.0 - exp(-age / tau), vt = iB.w;
    p = iOrigin + vec3(iVel.x * tau * e, vt * age + (iVel.y - vt) * tau * e, iVel.z * tau * e);
    float h = max(0.0, p.y - 0.3), s = iA.z * 6.2831;
    vec3 tb = vec3(sin(h * 2.3 + time * 1.1 + s) + 0.6 * sin(h * 5.3 - time * 2.4 + s * 1.7), 0.0,
                   cos(h * 1.9 - time * 0.9 + s * 1.3) + 0.6 * cos(h * 4.9 + time * 2.1 + s * 2.9));
    p += tb * 0.13 * min(age * 1.6, 1.0) * (0.35 + 0.4 * h);
    p.x += 0.045 * h * h;
    gImpact = -1.0;
  } else {
    // 弾道: 重力で弧を描き、地面で2回小さく跳ねてから止まる（反発係数は乱数から。CPU 側と同じ式）
    float g = iB.w, tH = iB.z;
    if (age <= tH) { gImpact = -1.0; return iOrigin + iVel * age - vec3(0.0, 0.5 * g * age * age, 0.0); }
    p = iOrigin + iVel * tH - vec3(0.0, 0.5 * g * tH * tH, 0.0);
    p.y = 0.03;
    float e = 0.22 + 0.25 * fract(iA.z * 13.7);
    float vy1 = e * max(0.0, g * tH - iVel.y), t1 = 2.0 * vy1 / g;
    vec2 vh = iVel.xz * 0.45;
    float a = age - tH;
    gImpact = a;
    if (a <= t1) return p + vec3(vh.x * a, vy1 * a - 0.5 * g * a * a, vh.y * a);
    p += vec3(vh.x * t1, 0.0, vh.y * t1);
    a -= t1; vh *= 0.5;
    float vy2 = e * vy1, t2 = 2.0 * vy2 / g;
    gImpact = a;
    float aa = min(a, t2);
    p += vec3(vh.x * aa, vy2 * aa - 0.5 * g * aa * aa, vh.y * aa);
  }
  return p;
}
void main() {
  float age = uTime - iA.x, life = iA.y;
  if (age < 0.0 || age > life) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); vA = 0.0; vQ = vec2(0.0); vCol = vec3(0.0); return; }
  float ta = max(0.0, age - uStreak);
  vec3 pt = posAt(ta, uTime - (age - ta));
  vec3 ph = posAt(age, uTime);   // 後に呼ぶ（gImpact は先頭側の値を使う）
  mat4 vp = projectionMatrix * viewMatrix;
  vec4 ch = vp * vec4(ph, 1.0), ct = vp * vec4(pt, 1.0);
  if (ch.w < 0.05 || ct.w < 0.05) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); vA = 0.0; vQ = vec2(0.0); vCol = vec3(0.0); return; }
  vec2 sh = ch.xy / ch.w * 0.5 * uRes, st = ct.xy / ct.w * 0.5 * uRes;
  vec2 dv = sh - st; float len = length(dv);
  vec2 dir = vec2(0.0, 1.0);
  if (len > 0.001) dir = dv / len;
  vec2 nrm = vec2(dir.y, -dir.x);   // 反時計回りの面になる向き
  float wpx = clamp(iB.x * uPx / ch.w, 0.5, 1.0);   // 半幅。画面上の太さは 1〜2px
  float side = position.x, along = position.y;
  vec2 sp = mix(st, sh, along) + nrm * side * wpx + dir * (along * 2.0 - 1.0) * wpx * 0.8;
  float w = mix(ct.w, ch.w, along), z = mix(ct.z / ct.w, ch.z / ch.w, along);
  gl_Position = vec4(sp / (0.5 * uRes) * w, z * w, w);
  // 色: 生まれた一瞬だけ白に近い黄 → すぐ明るい橙 → 冷えて赤く暗くなる。弾道は着地の瞬間に一度光る
  // （トーンマップを通さないので、明るくても白く飛ばず暖色のまま光る）
  float k = age / life;
  float flash = exp(-age / 0.06);
  float cool = smoothstep(0.25, 1.0, k);
  if (gImpact >= 0.0) { flash = max(flash, 0.7 * exp(-gImpact * 14.0)); cool = min(cool, 0.45); }   // 地面に当たるたびに一瞬光る
  // 値は線形。sRGB に直すと明るく出るので、橙は G を低めに置く
  vec3 orange = vec3(1.0, 0.14, 0.015) * mix(1.0, 0.85, iB.y);
  vec3 red = vec3(0.4, 0.025, 0.003);
  vec3 c = mix(orange, red, cool);
  c = mix(c, vec3(1.0, 0.72, 0.28), flash);
  vCol = c * mix(1.6, 0.7, cool);
  float fade = (1.0 - smoothstep(0.85, 1.0, k)) * smoothstep(0.0, 0.02, age);
  float tw = 0.8 + 0.2 * sin(age * 37.0 + iA.z * 50.0);
  vA = fade * tw * clamp(3.0 * wpx / (len + 2.0 * wpx), 0.7, 1.0);
  vQ = vec2(side, along);
}`;
const SPARK_FRAG = /* glsl */`
varying vec2 vQ;
varying vec3 vCol;
varying float vA;
void main() {
  float across = 1.0 - 0.6 * vQ.x * vQ.x;
  float a = vA * across * mix(0.6, 1.0, vQ.y);
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol, min(1.0, a * 1.8));   // 細い線でも暗い背景ではっきり光るよう強めに
  #include <colorspace_fragment>
}`;

/* ---------- 煙: 薄い灰色の板をゆっくり昇らせる ---------- */
const SMOKE_VERT = /* glsl */`
attribute vec4 iS;     // 乱数, 位相, 大きさ, 寿命倍率
uniform float uTime, uBase;
varying vec2 vUv;
varying float vK, vSeed;
void main() {
  float life = 8.0 * iS.w, age = mod(uTime + iS.y * life, life), k = age / life;
  vec3 c = vec3((iS.x - 0.5) * 0.25, uBase + age * 0.34, (fract(iS.x * 7.3) - 0.5) * 0.25);
  c.x += sin(age * 0.55 + iS.x * 6.28) * 0.3 * k + 0.035 * age * age;
  c.z += cos(age * 0.45 + iS.x * 9.0) * 0.3 * k;
  float size = (0.3 + 1.5 * k) * iS.z;
  float an = iS.x * 6.28 + age * 0.12 * (iS.x - 0.5);
  vec2 cr = mat2(cos(an), -sin(an), sin(an), cos(an)) * position.xy;
  vec4 mv = viewMatrix * vec4(c, 1.0);
  mv.xy += cr * size;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy * 0.5 + 0.5; vK = k; vSeed = iS.x;
}`;
const SMOKE_FRAG = /* glsl */`
uniform float uTime, uAmt;
varying vec2 vUv;
varying float vK, vSeed;
${NOISE}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float n = tkFbm(vUv * 2.2 + vSeed * 13.0 + vec2(0.0, -uTime * 0.04));
  float a = (1.0 - smoothstep(0.15, 1.0, r)) * smoothstep(0.25, 0.75, n);
  a *= smoothstep(0.0, 0.18, vK) * (1.0 - vK) * uAmt;
  if (a < 0.002) discard;
  vec3 col = mix(vec3(0.45, 0.36, 0.3), vec3(0.3, 0.31, 0.33), smoothstep(0.0, 0.5, vK));
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ---------- 焚火の底の熾火（地面に敷く発光） ---------- */
const BED_VERT = /* glsl */`
varying vec2 vP;
void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vP = wp.xz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
const BED_FRAG = /* glsl */`
uniform float uTime, uGlow;
varying vec2 vP;
${NOISE}
void main() {
  float r = length(vP);
  vec2 q = vP * 5.0;
  q += 1.4 * vec2(tkFbm(q * 0.6 + 3.1), tkFbm(q * 0.6 + 7.7));      // ゆがめて自然な斑に
  float coal = smoothstep(0.36, 0.72, tkFbm(q));                   // 赤く焼けた炭の斑
  vec2 w = tkWorley2(q * 1.3);
  float gap = 1.0 - smoothstep(0.0, 0.12, w.y - w.x);              // 炭の割れ目は暗い
  float h = tkNoise(vP * 2.6 + vec2(uTime * 0.05, 0.0));
  float breathe = 0.5 + 0.5 * sin(uTime * (0.6 + 0.7 * h) + h * 6.28);   // ゆっくり脈打つ
  float I = coal * (1.0 - 0.7 * gap) * (0.4 + 0.6 * breathe);
  I *= 1.0 - smoothstep(0.2, 0.82, r);
  float T = clamp(I * uGlow * 1.35, 0.0, 1.0);
  vec3 c = tkHeat(T * 0.8) * (0.3 + 2.2 * T);
  gl_FragColor = vec4(c, clamp(I * 2.2, 0.0, 1.0) * min(1.0, uGlow * 2.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ---------- 軽量ブルーム用の全画面パス ---------- */
const POST_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
// 1/4 に縮めながら明るい所だけ取り出す（4タップの双線形で 4x4 を平均）
const BRIGHT_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThr;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  gl_FragColor = vec4(c * smoothstep(uThr, uThr * 1.8, l), 1.0);
}`;
// 9タップ相当のガウスぼかし（双線形で5回の読み出し）
const BLUR_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.227027;
  c += (texture2D(tSrc, vUv + uDir * 1.384615).rgb + texture2D(tSrc, vUv - uDir * 1.384615).rgb) * 0.316216;
  c += (texture2D(tSrc, vUv + uDir * 3.230769).rgb + texture2D(tSrc, vUv - uDir * 3.230769).rgb) * 0.070270;
  gl_FragColor = vec4(c, 1.0);
}`;
// ぼかした光を画面に加算する（画面はトーンマップ済みなので、1 - exp で柔らかく頭打ちにしてから足す）
const COMP_FRAG = /* glsl */`
uniform sampler2D tBloom;
uniform float uStrength;
varying vec2 vUv;
void main() {
  vec3 b = 1.0 - exp(-texture2D(tBloom, vUv).rgb * uStrength);
  gl_FragColor = vec4(b, 1.0);
  #include <colorspace_fragment>
}`;

/* ---------- 薪・炭の表面: ひび割れに沿って光る（MeshStandardMaterial を差し替え） ---------- */
function patchCharcoal(mat, u, instanced) {
  mat.emissive.setRGB(0, 0, 0); mat.emissiveIntensity = 1;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uCkTime = u.time; sh.uniforms.uCkHeat = u.heat; sh.uniforms.uCkEmber = u.ember;
    sh.uniforms.uCkSeed = u.seed; sh.uniforms.uCkLog = u.log;
    sh.vertexShader = 'varying vec3 vCk;\nvarying vec3 vCkO;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      `#include <begin_vertex>
  vCk = position;
  vCkO = ${instanced ? 'instanceMatrix[3].xyz * 5.0' : 'vec3(0.0)'};`);
    sh.fragmentShader = `varying vec3 vCk;
varying vec3 vCkO;
uniform float uCkTime, uCkHeat, uCkEmber, uCkSeed, uCkLog;
${NOISE}
` + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
  // 軸方向の位置（薪は上端=火の中ほど熱い）。炭は一様
  float ckProf = mix(1.0, smoothstep(-0.5, 0.3, vCk.y), uCkLog);
  vec3 ckP = uCkLog > 0.5 ? vec3(vCk.x * 13.0, vCk.y * 6.0, vCk.z * 13.0) : vCk * 14.0;
  ckP += vCkO + uCkSeed * 7.13;
  vec2 ckW = tkWorley3(ckP);
  float ckCrack = 1.0 - smoothstep(0.0, 0.1, ckW.y - ckW.x);
  ckCrack *= smoothstep(0.3, 0.62, tkNoise(ckP.xy * 0.45 + ckP.z * 0.31 + 11.0));   // 割れ目が光るのは所々だけ
  float ckChar = clamp((0.45 + 0.55 * ckProf) * (0.6 + 0.8 * uCkHeat + 0.6 * uCkEmber), 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.005, 0.004, 0.0035), ckChar * 0.95);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.047, 0.045), ckChar * uCkEmber * smoothstep(0.25, 0.6, ckW.x) * 0.4);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    float n = tkNoise(ckP.xy * 0.35 + ckP.z * 0.2 + vec2(uCkTime * 0.07, 0.0));
    float pulse = 0.5 + 0.5 * sin(uCkTime * (0.8 + 0.9 * n) + n * 6.2831);
    float hot = ckProf * (uCkHeat * 0.9 + uCkEmber * 1.2);
    // 薪: 割れ目に沿った光。炭: 表面がまだらに赤く焼ける
    float patchG = smoothstep(0.35, 0.8, tkNoise(ckP.xy * 0.9 + ckP.z * 0.7 - vec2(0.0, uCkTime * 0.05)));
    float glow = mix(patchG * 0.25 + ckCrack * 0.9, ckCrack, uCkLog) * (0.3 + 0.7 * pulse);
    float T = clamp(hot * glow, 0.0, 1.0);
    totalEmissiveRadiance += tkHeat(T * mix(0.55, 0.8, uCkLog)) * (0.25 + mix(1.2, 2.0, uCkLog) * T) * T;
  }`);
  };
  mat.customProgramCacheKey = () => 'tkchar' + (instanced ? 'I' : 'L');
  mat.needsUpdate = true;
}

/* ---------- 本体 ---------- */
export function createFire(opts) {
  const { scene, renderer, camera, api } = opts;
  const logs = opts.logs || [];
  const group = new THREE.Group();
  scene.add(group);
  const disposables = [];
  const own = (x) => { disposables.push(x); return x; };
  let time = 0;

  /* 光: 2つの点光源をずらして置き、別々の周期でちらつかせる */
  const lightA = new THREE.PointLight(0xff8a3c, 0, 16, 2);
  const lightB = new THREE.PointLight(0xff7428, 0, 14, 2);
  group.add(lightA, lightB);

  /* 炎の板（中心1枚＋周り） */
  const flameGeo = own(new THREE.PlaneGeometry(1, 1)); flameGeo.translate(0, 0.5, 0);
  const FLAME_DEF = [
    { x: 0.0, z: 0.0, w: 1.15, h: 1.0, i: 1.0 },
    { x: 0.18, z: 0.1, w: 0.7, h: 0.75, i: 0.75 },
    { x: -0.18, z: 0.08, w: 0.7, h: 0.8, i: 0.75 },
    { x: 0.05, z: -0.18, w: 0.75, h: 0.9, i: 0.7 },
    { x: -0.06, z: -0.12, w: 0.5, h: 1.05, i: 0.55 }
  ];
  const flames = FLAME_DEF.map((d, k) => {
    const mat = own(new THREE.ShaderMaterial({
      uniforms: { uSize: { value: new THREE.Vector2(1, 1) }, uScroll: { value: Math.random() * 50 }, uSeed: { value: k * 7.31 + 1.3 }, uInt: { value: 0 }, uCool: { value: 0 } },
      vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    }));
    const m = new THREE.Mesh(flameGeo, mat);
    m.position.set(d.x, 0.02, d.z); m.renderOrder = 3; m.frustumCulled = false;
    group.add(m);
    return { m, mat, d, ph: Math.random() * 10 };
  });

  /* 熾火の敷物 */
  const bedMat = own(new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uGlow: { value: 0 } },
    vertexShader: BED_VERT, fragmentShader: BED_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  }));
  const bedGeo = own(new THREE.CircleGeometry(0.85, 40)); bedGeo.rotateX(-Math.PI / 2);
  const bed = new THREE.Mesh(bedGeo, bedMat); bed.position.y = 0.03; bed.renderOrder = 2;
  group.add(bed);

  /* 薪と炭のひび割れ発光 */
  const ckTime = { value: 0 }, ckEmber = { value: 0 };
  const logU = logs.map((m, i) => {
    const u = { time: ckTime, heat: { value: 0 }, ember: ckEmber, seed: { value: i * 1.37 }, log: { value: 1 } };
    patchCharcoal(m.material, u, false);
    return u;
  });
  const coalGeo = own(new THREE.DodecahedronGeometry(0.07, 0));
  const coalMat = own(new THREE.MeshLambertMaterial({ color: 0x0c0907, flatShading: true }));
  const coalU = { time: ckTime, heat: { value: 0 }, ember: ckEmber, seed: { value: 3.1 }, log: { value: 0 } };
  patchCharcoal(coalMat, coalU, true);
  const NCOAL = 16;
  const coals = new THREE.InstancedMesh(coalGeo, coalMat, NCOAL);
  {
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
    for (let i = 0; i < NCOAL; i++) {
      const a = i * 2.39996 + Math.random() * 0.4, r = 0.12 + Math.sqrt(i / NCOAL) * 0.48;
      const k = rnd(0.6, 1.4);
      p.set(Math.cos(a) * r, 0.02, Math.sin(a) * r);
      q.setFromEuler(e.set(rnd(0, 3), rnd(0, 6), rnd(0, 3)));
      s.set(k * rnd(0.9, 1.6), k * rnd(0.45, 0.7), k * rnd(0.8, 1.2));
      coals.setMatrixAt(i, m4.compose(p, q, s));
    }
  }
  group.add(coals);

  /* 火花（GPU で動かす。CPU は生まれた瞬間の値を書くだけ） */
  const sparkGeo = own(new THREE.InstancedBufferGeometry());
  sparkGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
  sparkGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const aOrigin = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPARK * 3), 3);
  const aVel = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPARK * 3), 3);
  const aA = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPARK * 4).fill(-1e4), 4);
  const aB = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPARK * 4), 4);
  for (const a of [aOrigin, aVel, aA, aB]) a.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < MAX_SPARK; i++) aA.array[i * 4 + 1] = 0;   // 寿命0＝非表示
  sparkGeo.setAttribute('iOrigin', aOrigin); sparkGeo.setAttribute('iVel', aVel);
  sparkGeo.setAttribute('iA', aA); sparkGeo.setAttribute('iB', aB);
  sparkGeo.instanceCount = MAX_SPARK;
  const sparkMat = own(new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uStreak: { value: 0.035 }, uPx: { value: 900 }, uRes: { value: new THREE.Vector2(1, 1) } },
    vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false
  }));
  const sparkMesh = new THREE.Mesh(sparkGeo, sparkMat);
  sparkMesh.frustumCulled = false; sparkMesh.renderOrder = 4;
  group.add(sparkMesh);
  let ring = 0, sparkDirty = false, frameBudget = SPARKS_PER_FRAME;
  function spark(ox, oy, oz, vx, vy, vz, kind, life, size, heat, c, d, seed = Math.random()) {
    if (frameBudget <= 0) return;   // 1フレームで出す数の上限
    frameBudget--;
    const i = ring; ring = (ring + 1) % MAX_SPARK;
    aOrigin.array.set([ox, oy, oz], i * 3); aVel.array.set([vx, vy, vz], i * 3);
    aA.array.set([time, life, seed, kind], i * 4); aB.array.set([size, heat, c, d], i * 4);
    sparkDirty = true;
  }
  // 常時立ち上る火の粉（ゆらゆら昇る）
  function riseSpark(f, x0 = 0, spread = 0.2, boost = 1) {
    let life = rnd(0.9, 2.8);
    if (Math.random() < 0.22) life *= rnd(0.2, 0.55);          // 途中でふっと消える
    spark(x0 + gauss() * spread, rnd(0.3, 0.5 + 0.35 * f), gauss() * spread,
      gauss() * 0.35 * boost, rnd(0.4, 1.4) * boost, gauss() * 0.35 * boost,
      0, life, rnd(0.008, 0.016), rnd(0.55, 0.8), 0, rnd(0.6, 1.4) * (0.7 + 0.4 * Math.min(1.2, f)));
  }
  // 弾道の火花: 地面(0.03)に着く時刻と、2回跳ねて止まるまでの時間を求めて出す（反発係数はシェーダーと同じ式）
  function ballistic(ox, oy, oz, vx, vy, vz, g, size, heat) {
    const seed = Math.random();
    const tHit = (vy + Math.sqrt(vy * vy + 2 * g * Math.max(0, oy - 0.03))) / g;
    const e = 0.22 + 0.25 * ((seed * 13.7) % 1);
    const vy1 = e * Math.max(0, g * tHit - vy);
    let life = tHit + 2 * vy1 / g * (1 + e) + rnd(0.12, 0.25);
    if (Math.random() < 0.2) life = tHit * rnd(0.4, 0.9);        // 落ちきる前に冷えて消える
    spark(ox, oy, oz, vx, vy, vz, 1, life, size, heat, tHit, g, seed);
  }
  // はじける火の粉。毎回、主な向きを1〜2本決めてそのまわりにばらつかせる（全方位に均一な「ウニ」にしない）
  // kind: 'crackle'（パチッ） / 'pop'（大きめ） / 'accent'（いちばん派手な「バチッ」）
  function burst(count, kind, x0 = 0) {
    const P = { crackle: { sp: [1.8, 4.6], up: 0.25 }, pop: { sp: [2.4, 5.4], up: 0.3 }, accent: { sp: [3.0, 6.4], up: 0.35 } }[kind];
    const jets = [Math.random() * Math.PI * 2];
    if (Math.random() < 0.55) jets.push(jets[0] + rnd(1.2, 3.6));
    const tilt0 = rnd(0.35, 0.8);                                   // この回の傾き（鉛直からの角度）
    for (let k = 0; k < count; k++) {
      const phi = Math.random() < 0.2 ? Math.random() * Math.PI * 2 : jets[k % jets.length] + gauss() * 0.7;
      const upward = Math.random() < P.up;                           // 一部はほぼ真上へ（そのまま上昇気流に乗る）
      const th = upward ? rnd(0.0, 0.35) : clamp(tilt0 + gauss() * 0.35, 0.15, 1.2);
      const u = Math.random(), sp = P.sp[0] + (P.sp[1] - P.sp[0]) * u * u;   // 速さのばらつき（速いものは少なめ）
      const hs = Math.sin(th) * sp, vy = Math.cos(th) * sp;
      const ox = x0 + gauss() * 0.12, oy = rnd(0.35, 0.7), oz = gauss() * 0.12;
      const vx = Math.cos(phi) * hs, vz = Math.sin(phi) * hs;
      if (upward && Math.random() < 0.7) {
        let life = rnd(0.8, 2.2);
        if (Math.random() < 0.2) life *= rnd(0.25, 0.6);
        spark(ox, oy, oz, vx * 0.6, vy * 0.8, vz * 0.6, 0, life, rnd(0.009, 0.017), rnd(0.65, 0.88), 0, rnd(1.0, 2.2));
      } else {
        ballistic(ox, oy, oz, vx, vy, vz, rnd(5.5, 8.0), rnd(0.01, kind === 'accent' ? 0.022 : 0.018), rnd(0.7, 0.9));
      }
    }
  }
  // イベントはいったん貯め、update で出す。描画が止まっていた間（タブが裏・ペイン非表示）にたまった分は捨てる
  const pending = [];
  const unsubs = [
    api.onCrackle((ev) => {
      pending.push({ type: 'crackle', n: ev.n | 0, accent: ev.accent, t: ev.t, at: performance.now() });
      if (pending.length > 64) pending.shift();
    }),
    api.onLogAdded((ev) => { if (ev.type === 'land') pending.push({ type: 'land', dx: ev.dx, at: performance.now() }); })
  ];
  let lastUpdateAt = 0, accentPulse = 0;
  function flushPending() {
    const now = performance.now();
    const stalled = !lastUpdateAt || now - lastUpdateAt > STALE_MS;   // 前のフレームから時間が空いた = 止まっていた   // 前のフレームから時間が空いた = 止まっていた
    let newestT = -Infinity;
    for (const e of pending) if (e.type === 'crackle' && Number.isFinite(e.t)) newestT = Math.max(newestT, e.t);
    for (const e of pending) {
      if (now - e.at > STALE_MS) continue;                                                        // 届いてから時間が経ったもの
      if (e.type === 'crackle') {
        if (stalled || (Number.isFinite(e.t) && e.t < newestT - STALE_MS / 1000)) continue;     // 予約時刻が 0.3 秒以上前のもの
        if (e.accent === true) {                                                                 // アクセントの「バチッ」
          frameBudget = Math.max(frameBudget, SPARKS_PER_FRAME_ACCENT - (SPARKS_PER_FRAME - frameBudget));
          burst(Math.round(rnd(34, 46)), 'accent');
          accentPulse = 1;
        } else if (e.n >= 10) burst(Math.round(rnd(12, 18)), 'pop');                            // 大きな「パン」
        else burst(2 + Math.round(e.n * rnd(0.5, 1.0)), 'crackle');                             // パチッ（3〜7個）
      } else {
        const x0 = e.dx * 1.6;
        burst(8, 'crackle', x0);
        for (let k = 0; k < 8; k++) riseSpark(1, x0, 0.22, 1.3);
      }
    }
    pending.length = 0;
    lastUpdateAt = now;
  }

  /* 煙 */
  const NSMOKE = 18;
  const smokeGeo = own(new THREE.InstancedBufferGeometry());
  smokeGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  smokeGeo.setIndex([0, 1, 2, 0, 2, 3]);
  {
    const s = new Float32Array(NSMOKE * 4);
    for (let i = 0; i < NSMOKE; i++) s.set([Math.random(), i / NSMOKE, rnd(0.7, 1.3), rnd(0.8, 1.2)], i * 4);
    smokeGeo.setAttribute('iS', new THREE.InstancedBufferAttribute(s, 4));
  }
  smokeGeo.instanceCount = NSMOKE;
  const smokeMat = own(new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uBase: { value: 1.1 }, uAmt: { value: 0 } },
    vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG,
    transparent: true, depthWrite: false
  }));
  const smoke = new THREE.Mesh(smokeGeo, smokeMat);
  smoke.frustumCulled = false; smoke.renderOrder = 5;
  group.add(smoke);

  /* ブルーム（草の量が「多い」「普通」のときだけ）。
     UnrealBloomPass は Iris Xe・1024x768 で GPU +7ms、シーン全体を HDR の RT に描く自前版でも +3.7ms かかった。
     そこで光るもの（炎・火花・熾火・薪）だけを 1/4 解像度で描いてぼかし、通常描画の上に加算する方式にした。
     全解像度で増えるのは最後の加算1回だけ */
  const size = { w: 1, h: 1 };
  let bloom = null, bloomWanted = false;
  const postGeo = own(new THREE.BufferGeometry());
  postGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const postMat = (frag, uniforms, extra) => own(new THREE.ShaderMaterial(Object.assign({
    uniforms, vertexShader: POST_VERT, fragmentShader: frag, depthTest: false, depthWrite: false, toneMapped: false
  }, extra)));
  const brightMat = postMat(BRIGHT_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThr: { value: 0.35 } });
  const blurMat = postMat(BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
  const compMat = postMat(COMP_FRAG, { tBloom: { value: null }, uStrength: { value: 0.55 } }, { transparent: true, blending: THREE.AdditiveBlending });
  const postQuad = new THREE.Mesh(postGeo, brightMat); postQuad.frustumCulled = false;
  const postScene = new THREE.Scene(); postScene.add(postQuad);
  const postCam = new THREE.Camera();
  const clearCol = new THREE.Color();
  function bloomSizes() {
    const pr = renderer.getPixelRatio();
    const W = Math.max(1, Math.round(size.w * pr)), H = Math.max(1, Math.round(size.h * pr));
    return { qw: Math.max(1, Math.round(W / 4)), qh: Math.max(1, Math.round(H / 4)) };
  }
  function ensureBloom() {
    if (bloom) return;
    const { qw, qh } = bloomSizes();
    const opt = { type: THREE.HalfFloatType, depthBuffer: false };
    bloom = {
      g: new THREE.WebGLRenderTarget(qw, qh, { type: THREE.HalfFloatType }),   // 光るものだけ（深度あり: 薪の陰の炎は隠れる）
      a: new THREE.WebGLRenderTarget(qw, qh, opt), b: new THREE.WebGLRenderTarget(qw, qh, opt)
    };
  }
  function resizeBloom() {
    if (!bloom) return;
    const { qw, qh } = bloomSizes();
    bloom.g.setSize(qw, qh); bloom.a.setSize(qw, qh); bloom.b.setSize(qw, qh);
  }
  function dropBloom() {
    if (!bloom) return;
    bloom.g.dispose(); bloom.a.dispose(); bloom.b.dispose();
    bloom = null;
  }
  function post(mat, target) {
    postQuad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(postScene, postCam);
  }
  const hiddenTmp = [];
  function renderGlowSource(target) {
    // 光源の数は変えない（変えるとシェーダーの切り替えが起きる）。光らない物だけ一時的に隠す
    for (const c of scene.children) {
      if (c.visible && c !== group && !c.isLight && logs.indexOf(c) < 0) { c.visible = false; hiddenTmp.push(c); }
    }
    const hv = halo.visible, sv = smoke.visible, bg = scene.background, ca = renderer.getClearAlpha();
    halo.visible = false; smoke.visible = false; scene.background = null;
    renderer.getClearColor(clearCol); renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setClearColor(clearCol, ca);
    scene.background = bg; halo.visible = hv; smoke.visible = sv;
    for (const c of hiddenTmp) c.visible = true;
    hiddenTmp.length = 0;
  }
  function renderBloom() {
    const { g, a, b } = bloom;
    renderGlowSource(g);
    brightMat.uniforms.tSrc.value = g.texture;
    brightMat.uniforms.uTexel.value.set(0.5 / g.width, 0.5 / g.height);
    post(brightMat, a);
    const u = blurMat.uniforms, ix = 1 / a.width, iy = 1 / a.height;
    u.tSrc.value = a.texture; u.uDir.value.set(ix, 0); post(blurMat, b);
    u.tSrc.value = b.texture; u.uDir.value.set(0, iy); post(blurMat, a);
    u.tSrc.value = a.texture; u.uDir.value.set(ix * 2.5, 0); post(blurMat, b);
    u.tSrc.value = b.texture; u.uDir.value.set(0, iy * 2.5); post(blurMat, a);
    // 通常どおり画面に描いてから、ぼかした光を加算
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    compMat.uniforms.tBloom.value = a.texture;
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    post(compMat, null);
    renderer.autoClear = ac;
  }

  /* 光の芯（淡いハロー） */
  const haloTex = own((() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d'), g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,170,90,1)'); g.addColorStop(0.3, 'rgba(255,120,40,0.4)'); g.addColorStop(1, 'rgba(255,80,20,0)');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })());
  const haloMat = own(new THREE.SpriteMaterial({ map: haloTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, opacity: 0 }));
  const halo = new THREE.Sprite(haloMat); halo.renderOrder = 1;
  group.add(halo);

  let riseAcc = 0, disposed = false;

  function update(dt, t, st) {
    time = t;
    const f = st.started ? Math.min(1.25, st.flame) : 0, em = st.started ? st.ember : 0, f1 = Math.min(1, f);
    const on = smooth(0.015, 0.22, f);
    accentPulse *= Math.exp(-dt / 0.35);   // アクセントの「バチッ」で炎と光が一瞬ふくらむ
    const ap = accentPulse;

    // ブルームの要否
    bloomWanted = opts.bloom !== false && !!BLOOM_LEVELS[st.grass || 'normal'];
    if (bloomWanted) ensureBloom(); else dropBloom();

    // 炎
    const cam = camera.position;
    const speed = 0.9 + 0.7 * f1;
    for (let k = 0; k < flames.length; k++) {
      const F = flames[k], d = F.d;
      F.ph += dt * (0.8 + 0.3 * k);
      const gust = 0.86 + 0.1 * Math.sin(t * 1.7 + k * 2.1) + 0.07 * Math.sin(t * 3.3 + k) + 0.05 * Math.sin(F.ph * 2.3);
      const H = d.h * (0.28 + 1.35 * f) * gust * (1 + 0.35 * ap), W = d.w * (0.42 + 0.5 * f1) * (1 + 0.15 * ap);
      F.m.visible = on > 0.001 && H > 0.03;
      F.m.scale.set(W, H, 1);
      F.m.rotation.set(0, Math.atan2(cam.x - F.m.position.x, cam.z - F.m.position.z), 0);
      F.mat.uniforms.uSize.value.set(W, H);
      F.mat.uniforms.uScroll.value = (F.mat.uniforms.uScroll.value + dt * speed) % 400;
      F.mat.uniforms.uInt.value = d.i * on * (0.8 + 0.25 * f1) * (1 + 0.4 * ap);
      F.mat.uniforms.uCool.value = 0.2 * (1 - f1);
    }

    // 光（2灯を別周期で。強さは flame に連動）
    const fa = 0.9 + 0.06 * Math.sin(t * 8.7) * Math.sin(t * 2.9 + 1) + 0.04 * Math.sin(t * 21.3) + 0.03 * (Math.random() - 0.5);
    const fb = 0.9 + 0.07 * Math.sin(t * 6.1 + 2) * Math.sin(t * 1.7) + 0.035 * Math.sin(t * 17.9 + 0.5) + 0.03 * (Math.random() - 0.5);
    lightA.intensity = (18 * f + 2 * em) * fa * (1 + 0.9 * ap);
    lightB.intensity = (13 * f + 5 * em) * fb * (1 + 0.9 * ap);
    lightA.position.set(0.07 + 0.05 * Math.sin(t * 5.3), 0.8 + 0.12 * f + 0.05 * Math.sin(t * 7.1), 0.03 + 0.04 * Math.cos(t * 4.1));
    lightB.position.set(-0.06 + 0.04 * Math.sin(t * 3.7 + 1), 0.62 + 0.15 * f + 0.04 * Math.sin(t * 9.3), -0.05 + 0.05 * Math.cos(t * 2.9));
    lightA.color.setRGB(1, 0.5 + 0.1 * f1 * (0.5 + 0.5 * Math.sin(t * 3)), 0.2);
    lightB.color.setRGB(1, 0.36 + 0.14 * f1, 0.12);   // 熾火寄りの赤み

    // 光の芯
    haloMat.opacity = ((bloom ? 0.14 : 0.24) * f1 * fa + 0.04 * em) * (1 + 0.8 * ap);
    halo.scale.setScalar(1.3 + 1.5 * Math.min(1.2, f));
    halo.position.set(0, 0.45 + 0.35 * f, 0);

    // 熾火（燃料が少ないほど主役）
    ckTime.value = t; ckEmber.value = em;
    const heat = Math.min(1, f * 0.85);
    for (let i = 0; i < logU.length; i++) logU[i].heat.value = heat * (0.6 + 0.4 * ((i * 37) % 10) / 10);
    coalU.heat.value = 0.15 + 0.4 * heat;
    bedMat.uniforms.uTime.value = t;
    bedMat.uniforms.uGlow.value = st.started ? 0.3 + 0.3 * f1 + 0.9 * em : 0;
    bed.visible = st.started;

    // 火の粉（たまったイベント → 常時の火の粉。1フレームの上限は SPARKS_PER_FRAME）
    frameBudget = SPARKS_PER_FRAME;
    flushPending();
    if (f > 0.05) {
      riseAcc += (1.0 + 3.0 * f) * dt;
      while (riseAcc >= 1) { riseAcc -= 1; riseSpark(f); }
    } else if (em > 0.3 && Math.random() < dt * 0.5) riseSpark(0.1, 0, 0.3);
    sparkMat.uniforms.uTime.value = t;
    if (sparkDirty) { aOrigin.needsUpdate = aVel.needsUpdate = aA.needsUpdate = aB.needsUpdate = true; sparkDirty = false; }

    // 煙（ごく薄く。薪を足した直後は少し増える）
    smokeMat.uniforms.uTime.value = t;
    smokeMat.uniforms.uBase.value = 0.95;
    smokeMat.uniforms.uAmt.value = st.started ? (0.06 + 0.03 * f1 + 0.05 * (st.boost || 0) + 0.03 * em) : 0;
    smoke.visible = st.started;
  }

  function render() {
    if (bloom && bloomWanted) renderBloom();
    else renderer.render(scene, camera);
  }

  function setSize(w, h) {
    size.w = w; size.h = h;
    const pr = renderer.getPixelRatio();
    sparkMat.uniforms.uRes.value.set(w * pr, h * pr);
    sparkMat.uniforms.uPx.value = (h * pr) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    resizeBloom();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    unsubs.forEach((u) => { try { u(); } catch (err) {} });
    dropBloom();
    scene.remove(group);
    coals.dispose();
    disposables.forEach((x) => x.dispose());
    disposables.length = 0;
  }

  return { update, render, setSize, dispose, get bloomActive() { return !!(bloom && bloomWanted); } };
}
