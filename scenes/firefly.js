// ホタルの光の描画。小さく鋭い芯（2〜4px）と、ごく弱いにじみだけの点。
// 画面上の大きさに上限があるので、カメラに近いホタルも大きな玉にならない。util.makePoints と同じ属性（aSize / aColor / aAlpha）で使える。
// aSize は「ワールド上の見かけの大きさ」の目安で、遠くのホタルほど芯が小さくなる（最小 2px、最大 4px）。
import * as THREE from 'three';
import { makePoints } from './util.js';

const VERT = `
attribute float aSize; attribute vec3 aColor; attribute float aAlpha;
uniform float uScale;
varying vec3 vColor; varying float vAlpha; varying float vCore; varying float vPx;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float s = aSize * uScale / max(0.1, -mv.z);   // 画面上の大きさ(px)の目安
  float core = clamp(s * 0.1, 2.0, 4.0);        // 芯の直径 2〜4px
  vCore = core; vPx = core * 4.0;
  gl_PointSize = vPx;                           // にじみまで含めて芯の4倍
  vColor = aColor; vAlpha = aAlpha;
}`;
const FRAG = `
varying vec3 vColor; varying float vAlpha; varying float vCore; varying float vPx;
void main() {
  float r = length(gl_PointCoord - 0.5) * vPx;  // 点の中心からの距離(px)
  float c = vCore * 0.5;                        // 芯の半径
  float core = 1.0 - smoothstep(c * 0.8, c * 1.25, r);
  float halo = 0.2 * exp(-r * r / (c * c * 4.0)) * (1.0 - smoothstep(c * 2.2, c * 3.9, r));
  float a = vAlpha * (core + halo);
  if (a < 0.002) discard;
  gl_FragColor = vec4(mix(vColor, vec3(1.0), core * 0.45), a);
}`;

export function makeFireflyPoints(max, uScale) {
  const P = makePoints(max, THREE.AdditiveBlending, 1, uScale);
  const old = P.mat;
  P.mat = new THREE.ShaderMaterial({
    uniforms: { uScale }, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  });
  P.points.material = P.mat;
  old.dispose();
  return P;
}
