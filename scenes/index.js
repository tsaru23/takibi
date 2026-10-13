// シーンの一覧。新しいシーンは scenes/<id>.js を作り、ここに import して SCENES に足す。
//
// シーンの形式（各ファイルは default export で次のオブジェクトを返す）:
//   {
//     id: 'forest',                 // 設定 S.scene に保存される
//     label: '季節の木',              // 設定パネルの表示名
//     audio: {
//       autoOn: ['insect', { id: 'wind', vol: 0.35 }, { id: 'fw', season: 'summer' }],
//                                   // このシーンを選んだとき自動でオンにする環境音（index.html の ENV の id。frog, scenesfx なども）。離れると元に戻る。
//                                   //   要素は 'id' か { id, season?, vol? }。season（'spring'|'summer'|'autumn'|'winter'）を書くと、その季節のときだけオン（季節を替えると出入りする）。
//                                   //   vol（0..1）は自動オンの間の既定の音量で、スライダーを動かしたら動かした値を優先する。
//                                   //   手でオン／オフした音は、シーンを替えても勝手に変えない。自動オンの分は保存しない。竹のささやき（bamboo）は自動でオンにしない方針
//       reverb: null,               // または { seconds: 2.4, decay: 3, wet: 0.35 }。ConvolverNode の残響（IR はコードで生成）
//       sources: {                  // 省略可。音の鳴る場所（立体音響。1 unit = 1 m、焚火が原点、y は高さ。省略した y は既定の高さ）。
//         river: [{x, z}, ...],     //   川の流れ: 川の帯に沿った点（3点に間引いて使う）。 wave: 波打ち際に沿った点（3点）
//         brook: [..], cavewind: [..],  // せせらぎ（1点）、洞窟の風（2点）
//         frog: [..], chime: [..],  //   蛙（個体ごと3点）、風鈴（1点）。 owl: [..] はフクロウの候補（無ければ 18〜32m 先のランダム）
//       }                           //   指定の無い音は、聞き手のまわりに包まれる音として鳴る（風鈴・蛙はシーンごとのランダムな固定位置）
//     },
//     props: {                      // 省略可。共通の小物（scene3d.js が置く）の置き場所。未指定の項目は既定の位置、null は非表示
//       logPile: { x, z, rotY } | null,   // 手前の予備の薪の束（既定 x -2.0, z 0.1, rotY 0.35）
//       stump:   { x, z, rotY } | null,   // 切り株の腰掛け（既定 x 2.05, z 0.55, rotY 0.5）
//       pebbles: false                    // 焚火まわりの共通の小石を出さない（既定は出す。水の中に出る川など）
//     },                                  //   y は常に地面（0）。水際・波の届く所・床のくぼみ・庭の飾りには置かない
//     build(ctx) -> { update(dt, t, state), setSeason(season), dispose() }
//   }
// 縮尺: 1 unit = 1 m。焚火（石囲い 外径 約1.2m・薪 長さ 約0.45m・炎 約0.5〜1.1m・火の粉 高さ 約2〜3m）、切り株（直径・高さ 約0.4m）、
//   カメラ（目の高さ 約1.03m・焚火の中心から水平に約2.5m。座った人の目線）を基準に、シーンの物も実物の大きさで置く
//   （ログハウス 床 約4.4×4.6m・棟 約4.6m、鹿威し 約1.2m、石灯籠 約1.5m、鯉 約0.6m、蓮の葉 約0.3〜0.5m、川幅 約5.8m など）
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
//   camBlockers: カメラが入ってはいけない円の配列。シーンが push する {x, z, r}（鹿威し・縁台のような、目の高さにある置物用。シーンを離れると空になる）
// 視点: カメラは焚火を中心に全周（方位 無制限）・上下は見下ろしから +35°・距離 1.6〜4.0m（初期 2.5m）で動く。シーンの景色は
//   「初期の視点（-Z 向き）」だけでなく全周を前提に作る: 地面と遠景の丘は全周（util.HILLS）、背後（+Z）や左右にも木・壁・土手などを置く。
//   遠景の木は farTrees.surroundPoints で全周に置ける（正面の月と星の側だけ低く・まばらにして、初期の視点の夜空を守る）。焚火から 24m 以上に置く（交差した板だと分からない距離）。
//   カメラが焚火のまわり 1.6〜4m を回るので、その輪の中の物は低く（0.5m 以下）、目の高さの置物は camBlockers で避ける。
//   草（FABOTANIC のフィールド）の間引く扇形は、カメラの方向について回る（forest.js の patchFieldMaterial）。
//   描く量: 視錐台の外の物は描かれないが、InstancedMesh は frustumCulled=false だと全部を処理する。大きな物（竹の株など）は方位ごとに InstancedMesh を分ける（garden.js）。
// api（window.TAKIBI）にシーン向けの窓口:
//   api.playSfx(name, {delay, vol, pos:{x,y,z}, dur}) -> {stop()}|null : 効果音（pos は鳴る場所。無ければ聞き手のまわり。旧 pan も使える）（plop splash plip lap kakon pour drip trickle creak）。delay は「映像でその瞬間が来るまでの秒数」で、音は出力遅延ぶん早めに予約される
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
