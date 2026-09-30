/* FABOTANIC integration helper
 * Generator credit: AMIX｜トミナガハルキ
 * SPDX-License-Identifier: MIT
 * Policy 1.0.0 / publisher-approved
 * Scope: SDK-SCOPE.json. Third-party notices remain separate.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
/** Static glTF stays portable. Optional runtime bend moves connected organs together. */
export async function loadVerdantAsset(baseURL='./',options={}){
 const base=new URL(baseURL,document.baseURI);
 async function json(name){const response=await fetch(new URL(name,base));if(!response.ok)throw new Error(name+': HTTP '+response.status);return response.json();}
 const manifestFile=options.manifestFile??'manifest.json';
 if(typeof manifestFile!=='string'||!(/^[a-zA-Z0-9_-]+[.]json$/).test(manifestFile))throw new Error('Invalid manifest filename.');
 const manifest=await json(manifestFile),environment=await json('environment.json');
 if(manifest.format!=='verdant-three-package')throw new Error('Not a VERDANT Three.js asset package.');
 if(manifest.runtime&&manifest.runtime.apiVersion!=='1.0')throw new Error('Unsupported runtime API: '+manifest.runtime.apiVersion);
 const model=manifest.model;
 if(typeof model!=='string'||model.startsWith('/')||model.includes('..')||model.includes(':')||model.includes(String.fromCharCode(92)))throw new Error('Invalid relative model path.');
 const enableWind=options.windEnabled!==false&&manifest.features?.wind!=='none'&&manifest.representation?.kind!=='background-tree-crosscards-v1';
 if(enableWind&&String(THREE.REVISION)!=='185')throw new Error('Wind shader requires Three.js r185. Use {windEnabled:false} for static loading or a tested adapter.');
 const config=options.distanceWind??manifest.windDistance??{enabled:false},distanceWind={enabled:typeof config==='boolean'?config:config.enabled===true,near:Number(config.near??12),far:Number(config.far??30)};
 if(!Number.isFinite(distanceWind.near)||!Number.isFinite(distanceWind.far)||distanceWind.near<0||distanceWind.far<=distanceWind.near)throw new RangeError('Wind distances: 0 <= near < far.');
 Object.freeze(distanceWind);
 const warnings=[];
 if(manifest.selection?.style==='toon'){const message='Legacy toon asset loaded as lowpoly PBR. Use its original runtime package to keep the former rendering.';warnings.push(message);console.warn(message);}
 const loader=new GLTFLoader(),gltf=await loader.loadAsync(new URL(manifest.model,base).href),root=gltf.scene;
 const wind={strength:options.windStrength??1,speed:options.windSpeed??environment.windSpeed??2.5,gust:options.gust??environment.windGust??.25,direction:new THREE.Vector2(environment.windDirection?.[0]??1,environment.windDirection?.[2]??0).normalize()};
 const profile=manifest.windProfile||{flex:1,freq:1,lag:.9},programs=[],originals=new Set(),customMaterials=new Set(),records=[],groups=new Map();
 let elapsed=0,last=performance.now(),disposed=false;
 const distanceStatus={cameraMissing:false,nearGroups:0,fadingGroups:0,staticGroups:0};
 const cameraPoint=distanceWind.enabled?new THREE.Vector3():null;
 function distanceWeight(d){const t=Math.max(0,Math.min(1,(d-distanceWind.near)/(distanceWind.far-distanceWind.near)));return 1-t*t*(3-2*t);}
 function groupFor(o){
  if(!distanceWind.enabled)return {weight:1};
  const node=o.parent||root;if(groups.has(node))return groups.get(node);
  node.updateWorldMatrix(true,true);const local=new THREE.Box3().setFromObject(node).applyMatrix4(new THREE.Matrix4().copy(node.matrixWorld).invert());
  const group={node,local,world:new THREE.Box3(),weight:1};groups.set(node,group);return group;
 }
 function switchRecord(rec,active){
  if(rec.active===active)return;rec.active=active;
  rec.object.material=active?rec.dynamic:rec.static;
  rec.object.customDepthMaterial=active?rec.depth:undefined;rec.object.customDistanceMaterial=active?rec.distance:undefined;
  rec.object.frustumCulled=active?false:rec.originalCull;
 }

 const declarations=[
 'uniform float vdTime,vdSpeed,vdGust,vdHeight,vdFlex,vdFreq,vdLag;',
 'uniform vec2 vdDirection;',
 'vec3 verdantBend(vec3 p,vec3 root,vec2 direction,out float slope){',
 'float H=max(.001,vdHeight),h=clamp(p.y/H,0.,1.),phase=dot(root.xz,vec2(.91,1.31));',
 'float a=vdTime*vdFreq*(1.+vdSpeed*.075)+phase-vdLag*h;',
 'float b=vdTime*vdFreq*2.07+phase*1.7-vdLag*h*.55;',
 'float w=sin(a)+sin(b)*vdGust*.42,dh=-vdLag*cos(a)-vdLag*.55*cos(b)*vdGust*.42;',
 'float strength=.012*vdSpeed*vdFlex,d=H*strength*h*h*w;',
 'slope=(p.y>0.&&p.y<H)?strength*(2.*h*w+h*h*dh):0.;p.xz+=direction*d;return p;}',
 'vec2 verdantDirection(){',
 'mat3 m=mat3(modelMatrix);',
 '#ifdef USE_INSTANCING',
 'm=m*mat3(instanceMatrix);',
 '#endif',
 'vec3 d=inverse(m)*vec3(vdDirection.x,0.,vdDirection.y);',
 'float len=length(d.xz);return len>1.e-8?d.xz/len:vec2(1.,0.);}',
 'vec3 verdantRoot(){',
 '#ifdef USE_INSTANCING',
 'return (modelMatrix*instanceMatrix*vec4(0.,0.,0.,1.)).xyz;',
 '#else',
 'return modelMatrix[3].xyz;',
 '#endif',
 '}'
 ].join('\n');
 function patch(material,height,localProfile=profile,group={weight:1},owned=true){
  material.addEventListener('dispose',()=>{for(let i=programs.length-1;i>=0;i--)if(programs[i].verdantOwner===material)programs.splice(i,1);});
  if(owned)material.userData.botanicWindMask=mask=>patch(mask,height,localProfile,group,false);
  material.onBeforeCompile=shader=>{
   Object.assign(shader.uniforms,{vdTime:{value:elapsed},vdSpeed:{value:wind.speed},vdGust:{value:wind.gust},vdHeight:{value:height},vdFlex:{value:localProfile.flex*wind.strength*group.weight},vdFreq:{value:localProfile.freq},vdLag:{value:localProfile.lag},vdDirection:{value:wind.direction}});
   shader.vertexShader=declarations+'\n'+shader.vertexShader;
   if(!shader.vertexShader.includes('#include <begin_vertex>'))throw new Error('Unsupported Three.js vertex shader: r185 is required.');
   shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nfloat vdSlope;transformed=verdantBend(transformed,verdantRoot(),verdantDirection(),vdSlope);');
   shader.vertexShader=shader.vertexShader.replace('#include <beginnormal_vertex>','#include <beginnormal_vertex>\nfloat vdNormalSlope;vec3 vdIgnore=verdantBend(position,verdantRoot(),verdantDirection(),vdNormalSlope);objectNormal.y-=vdNormalSlope*dot(objectNormal.xz,verdantDirection());');
   shader.verdantOwner=material;shader.verdantFlex=localProfile.flex;shader.verdantGroup=group;programs.push(shader);
  };
  material.customProgramCacheKey=()=> 'verdant-world-heading-bend-v3-distance-v1';if(owned)customMaterials.add(material);return material;
 }
 const bounds=new THREE.Box3().setFromObject(root),defaultHeight=Math.max(.001,bounds.max.y);
 root.traverse(o=>{
  if(!o.isMesh)return;o.castShadow=true;o.receiveShadow=true;
  const mats=Array.isArray(o.material)?o.material:[o.material],key=mats[0]?.userData?.verdantMaterial||o.userData.verdantMaterial||'';
  if(key==='impostor'){o.castShadow=false;o.receiveShadow=false;return;}
  if(['soil','stone','moss','litter','succulent','hardLeaf','lowpolyGround'].includes(key)){o.castShadow=key==='stone'||key==='succulent'||key==='hardLeaf';return;}
  if(!enableWind)return; // Static vegetation still casts shadows; only skip wind shader patches.
  // Each prototype supplies a common height for its foliage, flowers and stems.
  const height=o.userData.verdantWindHeight||defaultHeight,localProfile=manifest.windProfiles?.[o.userData.verdantSourceSpecies]||profile;
  if(localProfile.flex===0)return;
  const group=groupFor(o),staticMaterials=o.material,next=mats.map(m=>{originals.add(m);return patch(m.clone(),height,localProfile,group);});
  const rec={object:o,group,static:staticMaterials,dynamic:Array.isArray(o.material)?next:next[0],depth:patch(new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,side:THREE.DoubleSide}),height,localProfile,group),distance:patch(new THREE.MeshDistanceMaterial({side:THREE.DoubleSide}),height,localProfile,group),originalCull:o.frustumCulled,active:null};records.push(rec);switchRecord(rec,true);
 });
 // Static originals are retained for the far path; disposed exactly once by this asset.
 function update(deltaSeconds,sharedElapsedSeconds,camera){
  if(disposed)return;const now=performance.now(),dt=deltaSeconds===undefined?(now-last)/1000:deltaSeconds;last=now;elapsed=Number.isFinite(sharedElapsedSeconds)?Math.max(0,sharedElapsedSeconds):elapsed+Math.max(0,Math.min(.1,Number.isFinite(dt)?dt:0));
  if(distanceWind.enabled){
   distanceStatus.cameraMissing=!camera;distanceStatus.nearGroups=0;distanceStatus.fadingGroups=0;distanceStatus.staticGroups=0;
   if(camera)camera.getWorldPosition(cameraPoint);
   for(const group of groups.values()){
    group.node.updateWorldMatrix(true,false);const d=camera?group.world.copy(group.local).applyMatrix4(group.node.matrixWorld).distanceToPoint(cameraPoint):0;
    group.weight=distanceWeight(d);if(group.weight===0)distanceStatus.staticGroups++;else if(group.weight===1)distanceStatus.nearGroups++;else distanceStatus.fadingGroups++;
   }
  }
  const motionActive=Number.isFinite(wind.strength)&&wind.strength>0&&Number.isFinite(wind.speed)&&wind.speed>0;
  for(const rec of records)switchRecord(rec,motionActive&&rec.group.weight>0);
  for(const p of programs){if(!motionActive||p.verdantGroup.weight===0)continue;p.uniforms.vdTime.value=elapsed;p.uniforms.vdSpeed.value=Math.max(0,Math.min(12,wind.speed));p.uniforms.vdGust.value=Math.max(0,Math.min(1,wind.gust));p.uniforms.vdFlex.value=p.verdantFlex*Math.max(0,wind.strength)*p.verdantGroup.weight;}
 }
 function dispose(){if(disposed)return;disposed=true;const geometries=new Set(),materials=new Set([...customMaterials,...originals]),textures=new Set();root.traverse(o=>{if(o.geometry)geometries.add(o.geometry);for(const m of (Array.isArray(o.material)?o.material:[o.material]).filter(Boolean))materials.add(m);if(o.isInstancedMesh)o.dispose();});for(const m of materials){for(const value of Object.values(m))if(value?.isTexture)textures.add(value);m.dispose();}for(const g of geometries)g.dispose();for(const t of textures)t.dispose();root.removeFromParent();programs.length=0;records.length=0;groups.clear();}
 root.userData.verdantAssetId=manifest.assetId||null;
 return {root,manifest,environment,wind,update,dispose,warnings,staticMode:!enableWind,distanceWind,distanceStatus};
}
