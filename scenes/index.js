// シーンの一覧。新しいシーンは scenes/<id>.js を作り、ここに import して SCENES に足す。
//
// シーンの形式（各ファイルは default export で次のオブジェクトを返す）:
//   {
//     id: 'forest',                 // 設定 S.scene に保存される
//     label: '季節の木',              // 設定パネルの表示名
//     audio: {
//       autoOn: ['brook'],          // このシーンを選んだとき自動でオンにする環境音の id（index.html の ENV。frog, bamboo, scenesfx なども）。離れると元に戻る
//       reverb: null                // または { seconds: 2.4, decay: 3, wet: 0.35 }。ConvolverNode の残響（IR はコードで生成）
//     },
//     props: {                      // 省略可。共通の小物（scene3d.js が置く）の置き場所。未指定の項目は既定の位置、null は非表示
//       logPile: { x, z, rotY } | null,   // 手前の予備の薪の束（既定 x -2.0, z 0.1, rotY 0.35）
//       stump:   { x, z, rotY } | null,   // 切り株の腰掛け（既定 x 2.05, z 0.55, rotY 0.5）
//       pebbles: false                    // 焚火まわりの共通の小石を出さない（既定は出す。水の中に出る川など）
//     },                                  //   y は常に地面（0）。水際・波の届く所・床のくぼみ・庭の飾りには置かない
//     build(ctx) -> { update(dt, t, state), setSeason(season), dispose() }
//   }
// ctx: { THREE, scene, root, renderer, camera, api, util, assets, uScale, fireCenter, isStopped }
//   root      : シーン専用の Group（scene に追加済み）。置くものはここに add する。切替時にホスト側でも破棄する
//   uScale    : ポイントスプライトの大きさ係数 { value }（util.makePoints に渡す）
//   assets    : { url(path), loadTexture(path, {srgb}), loadGLTF(path) }。path はサイトルートからの相対
//   fireCenter: 焚火の位置 {x, z}（今は原点）
//   ground    : 地面のメッシュ。形（池の穴など）や material.color を変えてよいが、dispose で必ず元に戻す
//   fireflies : { value } ホタルの数の倍率（1 = 22匹、最大 2 = 44匹）。シーンを離れると 1 に戻る
//   fireLights: 焚火の2つの点光源の配列。distance / decay を変えて届く範囲を調整してよい（dispose で元に戻す）。強さは fire3d が毎フレーム入れ直すので、変えるなら update() の中で掛ける
//   lights    : { hemi, moon } 環境光と月の光。強さを変えてよい（シーンを離れると元に戻る）
//   sky       : sky.setMoon(az, el) 月の位置の上書き（シーンを離れると元に戻る）
//               sky.setMoonColor(color, intensity = 1, lightColor = color) 月の見た目（円盤とにじみ）の色 = color、月光の色 = lightColor、
//                 月光の強さ = 季節の既定 × intensity の上書き。color に null を渡すと解除。シーンを離れると季節の既定に戻る（季節が変わっても上書きが効く）
//   hills     : hills.setVisible(bool) 遠景の丘（水平線を隠す2枚の影）の表示・非表示。hills.visible で今の状態を読める。シーンを離れると表示に戻る
//   scene3d.js はシーンを離れるとき、dispose のあとに ground（形・色・表示）、hills、ライト・月・ホタル・小物を共通の状態へ戻し、
//   scene 直下に残った物（共通部分と落下中の薪以外）を外す（外したときは console.warn）。それでも、シーン側の dispose で自分の物は戻す・外すこと
//   scenes/snow.js : makeSnowPoints(max, uScale) 雪の粒（画面上の大きさが最大 6px。util.makePoints と同じ属性）。カメラに近い雪が大きな玉にならないよう、雪はこれで描く
// api（window.TAKIBI）にシーン向けの窓口:
//   api.playSfx(name, {delay, vol, pan, dur}) -> {stop()}|null : 効果音（plop splash plip lap kakon pour drip trickle creak）。delay は「映像でその瞬間が来るまでの秒数」で、音は出力遅延ぶん早めに予約される
//   api.onEnvEvent(cb) -> 解除関数 : 環境音の予約時刻に同期したイベント {kind:'frog', voice, t, dur, call, syl:[[開始秒,長さ秒]..]}（蛙の喉の動き用）
//                                   他に {kind:'wave', t, rise, fall, peak}（さざ波の寄せ始め・寄せる秒・引く秒・強さ 0.6〜1）と {kind:'fw', t}（遠くの花火。音の1秒前）
// GLB: assets/models/ に置いたファイル名を assets/plants/manifest.json の "models" 配列に書くと、util.loadOptionalModel で読める
//   loadOptionalModel は最初の Mesh を長さ（最大寸法）1・原点中心に正規化して返す。2つ目以降の Mesh は同じ変換をかけて extras に入る（frog の目・喉など）。util.materialTextures(mat) は GLB の材質のテクスチャ一覧（dispose 用）
//   複数オブジェクトの GLB（garden の shishiodoshi.glb / stone_lantern.glb）は assets.loadGLTF で直接読み、getObjectByName で使う（manifest には書かない）
// 注意: ライトは root に入れず scene 直下に add し、dispose で外す（fire3d の発光パスが root 全体を一時的に隠すため）。
import forest from './forest.js';
import pond from './pond.js';
import garden from './garden.js';
import cave from './cave.js';
import river from './river.js';
import sea from './sea.js';
import cabin from './cabin.js';

export const SCENES = [forest, pond, garden, sea, cave, river, cabin];
