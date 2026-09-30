// シーンの一覧。新しいシーンは scenes/<id>.js を作り、ここに import して SCENES に足す。
//
// シーンの形式（各ファイルは default export で次のオブジェクトを返す）:
//   {
//     id: 'forest',                 // 設定 S.scene に保存される
//     label: '季節の木',              // 設定パネルの表示名
//     audio: {
//       autoOn: ['brook'],          // このシーンを選んだとき自動でオンにする環境音の id（index.html の ENV）。離れると元に戻る
//       reverb: null                // または { seconds: 2.4, decay: 3, wet: 0.35 }。ConvolverNode の残響（IR はコードで生成）
//     },
//     build(ctx) -> { update(dt, t, state), setSeason(season), dispose() }
//   }
// ctx: { THREE, scene, root, renderer, camera, api, util, assets, uScale, fireCenter, isStopped }
//   root      : シーン専用の Group（scene に追加済み）。置くものはここに add する。切替時にホスト側でも破棄する
//   uScale    : ポイントスプライトの大きさ係数 { value }（util.makePoints に渡す）
//   assets    : { url(path), loadTexture(path, {srgb}), loadGLTF(path) }。path はサイトルートからの相対
//   fireCenter: 焚火の位置 {x, z}（今は原点）
// 注意: ライトは root に入れず scene 直下に add し、dispose で外す（fire3d の発光パスが root 全体を一時的に隠すため）。
import forest from './forest.js';

export const SCENES = [forest];
