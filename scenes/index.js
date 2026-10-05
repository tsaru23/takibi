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
//     build(ctx) -> { update(dt, t, state), setSeason(season), dispose() }
//   }
// ctx: { THREE, scene, root, renderer, camera, api, util, assets, uScale, fireCenter, isStopped }
//   root      : シーン専用の Group（scene に追加済み）。置くものはここに add する。切替時にホスト側でも破棄する
//   uScale    : ポイントスプライトの大きさ係数 { value }（util.makePoints に渡す）
//   assets    : { url(path), loadTexture(path, {srgb}), loadGLTF(path) }。path はサイトルートからの相対
//   fireCenter: 焚火の位置 {x, z}（今は原点）
//   ground    : 地面のメッシュ。形（池の穴など）や material.color を変えてよいが、dispose で必ず元に戻す
//   fireflies : { value } ホタルの数の倍率（1 = 22匹、最大 2 = 44匹）。シーンを離れると 1 に戻る
// api（window.TAKIBI）にシーン向けの窓口:
//   api.playSfx(name, {delay, vol, pan, dur}) -> {stop()}|null : 効果音（plop splash plip lap kakon pour drip trickle）。delay は「映像でその瞬間が来るまでの秒数」で、音は出力遅延ぶん早めに予約される
//   api.onEnvEvent(cb) -> 解除関数 : 環境音の予約時刻に同期したイベント {kind:'frog', voice, t, dur, call, syl:[[開始秒,長さ秒]..]}（蛙の喉の動き用）
// GLB: assets/models/ に置いたファイル名を assets/plants/manifest.json の "models" 配列に書くと、util.loadOptionalModel で読める
// 注意: ライトは root に入れず scene 直下に add し、dispose で外す（fire3d の発光パスが root 全体を一時的に隠すため）。
import forest from './forest.js';
import pond from './pond.js';
import garden from './garden.js';

export const SCENES = [forest, pond, garden];
