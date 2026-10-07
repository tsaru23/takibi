// 雪の粒の描画。画面上の大きさに上限（最大 6px）があるので、カメラに近い雪も大きくぼやけた玉にならない（firefly.js と同じ考え方）。
// util.makePoints と同じ属性（aSize / aColor / aAlpha）で使える。aSize は「ワールド上の見かけの大きさ」の目安で、遠い粒ほど小さい（最小 1.5px）。
import * as THREE from 'three';
import { makePoints } from './util.js';

export const SNOW_MAX_PX = 6;

const VERT = `
attribute float aSize; attribute vec3 aColor; attribute float aAlpha;
uniform float uScale;
varying vec3 vColor; varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float s = aSize * uScale / max(0.1, -mv.z);       // 画面上の大きさ(px)の目安
  gl_PointSize = clamp(s, 1.5, ${SNOW_MAX_PX.toFixed(1)});
  vColor = aColor; vAlpha = aAlpha;
}`;
const FRAG = `
varying vec3 vColor; varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = vAlpha * (1.0 - smoothstep(0.45, 1.0, d));
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor, a);
}`;

export function makeSnowPoints(max, uScale) {
  const P = makePoints(max, THREE.NormalBlending, 0.3, uScale);
  const old = P.mat;
  P.mat = new THREE.ShaderMaterial({
    uniforms: { uScale }, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, blending: THREE.NormalBlending
  });
  P.points.material = P.mat;
  old.dispose();
  return P;
}
