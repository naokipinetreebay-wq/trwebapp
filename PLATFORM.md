# TRwebapp 構成メモ

2026-10-22 時点。グラウンドで使う同期トレーニングを、広告なし・課金なしで置いている。ポータルは https://tr.rojiura.app 。

## リポジトリと公開先

ローカルの親ディレクトリは `/Users/pinetreebay/development/`。GitHub の所有者は `naokipinetreebay-wq`。

| アプリ | ローカル | リポジトリ | 公開 URL | 中身 |
|---|---|---|---|---|
| ポータル | `trwebapp` | `trwebapp` | https://tr.rojiura.app | Cloudflare Pages `trwebapp` |
| FieldScan 首振りスキャン | `fieldscanTR` | `fieldscanTR` | https://fieldscan.rojiura.app | Render `fieldscan-tr` (`srv-dbbcsmrbc2fs73anqj40`) |
| Random Goal ランダムゴール | `randomgoalgameTR` | `randomgoalgameTR` | https://randomgoal.rojiura.app | Render `randomgoal-tr` (`srv-dbbcsoff3r2c738e42eg`) |
| NumberTap 順番タップ | `numbertapTR` | `numbertapTR` | https://numbertap.rojiura.app | Render `numbertap-tr` (`srv-dbc5nv3rjlhs73auf7ug`) |
| Shuttle Touch シャトルタッチ | `shuttletouchTR` | `shuttletouchTR` | https://shuttletouch.rojiura.app | Render `shuttletouch-tr` (`srv-dbcdicoae00c739doei0`) |
| PeriTap 周辺視タップ | `peritapTR` | `peritapTR` | https://peritap.rojiura.app | Render `peritap-tr`。Worker `peritap-proxy` が中継 |
| Saccade サッケード | `saccadeTR` | `saccadeTR` | https://saccade.rojiura.app | Render `saccade-tr`。Worker `saccade-proxy` が中継 |
| FlashMem 瞬間視 | `flashmemTR` | `flashmemTR` | https://flashmem.rojiura.app | Render `flashmem-tr`。Worker `flashmem-proxy` が中継 |
| Keep ドリブルキープ | `dribblekeepTR` | `dribblekeepTR` | https://dribblekeep.rojiura.app | Render `dribblekeep-tr`。Worker `dribblekeep-proxy` が中継 |
| Escape エスケープ | `escapeTR` | `escapeTR` | https://escape.rojiura.app | Render `escape-tr`。Worker `escape-proxy` が中継 |
| Drive ドライブ | `driveTR` | `driveTR` | https://drive.rojiura.app | Render `drive-tr`。Worker `drive-proxy` が中継 |

Render のホスト名は `https://<サービス名>.onrender.com`。リージョンはシンガポール、プランは free、ランタイムは Node。

## 共通の形

トレーニングアプリは同じ殻を持っている。

- Next.js 15（App Router）と React 19。画面はクライアントコンポーネント。
- カスタム `server.ts` が HTTP と WebSocket を同じプロセスで受ける。Next の `hostname` は `localhost`、待受は `0.0.0.0` と `PORT`。
- ルームはプロセスメモリだけ。データベースはない。再起動やスリープからの起動でルームは消える。
- 参加は QR。コントローラは `/r/[code]`、表示端末は `/d/[code]`。
- ルーム作成は `POST /api/rooms`。存在確認は `GET /api/rooms/exists?code=`。
- WebSocket は `/ws?room=&role=&deviceId=`。`role` は `controller` か `display`。
- 端末 ID はブラウザの `localStorage`。キーの接頭辞は FieldScan `fs-device-`、NumberTap `nt-device-`、Shuttle Touch `st-device-`、PeriTap `pt-device-`、Saccade `sc-device-`、FlashMem `fm-device-`、Keep `dk-device-`、Escape `es-device-`、Drive `dv-device-`。Random Goal もアプリ内の同様のキー。
- メッセージは JSON。サーバは `snapshot` を全員に配る。クライアントは `ping`（12秒）、サーバは WebSocket の ping（15秒）で死んだ接続を切る。再接続は 0.6秒から最大8秒のバックオフ。表示の再開はサーバ時刻に合わせ、ラウンドを最初からやり直さない。
- ルームコードは6文字。紛らわしい文字を除いた `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`。
- 表示端末は最大12台。放置ルームの TTL は90分。実行中、またはコントローラか表示が1台でも繋がっていれば消さない。
- ウィザードの「はじめる」は、コントローラを表示端末にもするときは、その端末がルームに入ってから `start` を送る。
- 各アプリの末尾に「トレーニングを終了」（確認して停止し https://tr.rojiura.app へ）と「ポータル（tr）へ」。
- 依存の TypeScript と `@types/*` は `dependencies` に置く。Render の production インストールは `devDependencies` を入れない。`engines.node` は `>=20`。`start` は `NODE_ENV=production tsx server.ts`。

表示の時計は `serverNow` が変わったときだけ端末とのずれを取り直す。毎フレームずれを計算すると、ずれが固定されて経過時間が進まなくなる。

## デプロイとドメイン

トレーニングアプリの `render.yaml` は共通。

```yaml
services:
  - type: web
    runtime: node
    plan: free
    region: singapore
    buildCommand: npm install && npm run build
    startCommand: npm start
    healthCheckPath: /
```

`main` へ push すると自動デプロイする。自動が追いつかないときは `render deploys create <serviceId> --commit <sha> --confirm --wait`。ビルド成否は `npm run build` の終了コードで見る。出力を `tail` にパイプすると失敗でも成功に見える。

ポータルは静的サイト。

```bash
npx wrangler pages deploy . --project-name trwebapp --branch main
```

DNS は Cloudflare のゾーン `rojiura.app`。

| 名前 | 向き先 |
|---|---|
| `tr` | `trwebapp.pages.dev`（プロキシ済み） |
| `fieldscan` | Render にカスタムドメイン登録済み。CNAME は `fieldscan-tr.onrender.com` |
| `randomgoal` | Render にカスタムドメイン登録済み。CNAME は `randomgoal-tr.onrender.com` |
| `numbertap` | Worker `numbertap-proxy` が `numbertap-tr.onrender.com` へ中継 |
| `shuttletouch` | Worker `shuttletouch-proxy` が `shuttletouch-tr.onrender.com` へ中継 |
| `peritap` | Worker `peritap-proxy` が `peritap-tr.onrender.com` へ中継 |
| `saccade` | Worker `saccade-proxy` が `saccade-tr.onrender.com` へ中継 |
| `flashmem` | Worker `flashmem-proxy` が `flashmem-tr.onrender.com` へ中継 |
| `dribblekeep` | Worker `dribblekeep-proxy` が `dribblekeep-tr.onrender.com` へ中継 |
| `escape` | Worker `escape-proxy` が `escape-tr.onrender.com` へ中継 |
| `drive` | Worker `drive-proxy` が `drive-tr.onrender.com` へ中継 |

Hobby プランに含まれるカスタムドメインは2件。3件目からは支払い方法が要り、1件あたり月 $0.25。カードは追加していない。FieldScan と Random Goal が Render 側の2件を使っている。NumberTap と Shuttle Touch は Cloudflare Worker がホスト名を受け、`Host` を `*.onrender.com` に変えて転送する。WebSocket もこの転送で通る。Worker のカスタムドメインを付けると、オレンジ雲の DNS レコードは Cloudflare が作る。

無料インスタンスは使っていない間スリープし、次のアクセスで起動に数十秒かかることがある。無料の実行時間はワークスペース全体で月750時間。動いている間だけ消費する。6〜7個程度なら、この無料枠のまま Render に残す判断にした。

## 画面の色

トレーニング中の色は信号機に合わせてある。コード上のキー `blue` は緑、`vermilion` は赤のまま残している。

| 意味 | 色 |
|---|---|
| 緑（フリー、進め） | `#00A651` |
| 赤（敵、止まれ） | `#E10600` |
| 黄（Random Goal） | `#FFB000` |

ポータルのカード色は別物。FieldScan `#3ecf8e`、Random Goal `#f0c419`、NumberTap `#4cc3ff`、Shuttle Touch `#ff7a3c`、PeriTap `#c084fc`、Saccade `#38bdf8`、FlashMem `#fb7185`、Keep `#34d399`、Escape `#f97316`、Drive `#818cf8`。

FieldScan と Random Goal の切替音は、初期状態オフの電子音「ぴっ」（矩形波 1480Hz、約80ms）。鳴るのはその端末の色が実際に変わったとき。ブラウザの制限で、各端末が一度タップするまで音は出ない。

## FieldScan（首振りスキャン）

周囲の端末を見て、フリーへ首を振る。表示は3状態。

- `free` 緑の全面。参加直後の初期状態も緑。
- `marked` 緑と赤の半分。チェックを入れたときだけ出る。出る台数のスライダーはない。味方台数を N とすると、毎ラウンド 0〜N 台がランダムに半分になる。純緑が0台のラウンドもある。
- `enemy` 赤の全面。

味方台数は、その時点の参加台数に丸めない。参加が1台のときに丸めると、味方がいつも半分になって純緑が消える。

割り当ては次のどちらか。

- 味方 N 台。残りは敵。
- 全台ランダム。味方が0台になることを禁止できる。

切り替わりの間隔は固定秒、下限〜上限のランダム秒、手動。手動はさらに2つ。

- ランダム表示。色はルールどおり。ボタンは切り替わる時刻だけを決める。
- 色を指定。各端末を 緑 / 赤 / 半分 のトグルで選んでから「切り替え」。トグルは端末名の横、「切り替え」はそのリストの直下。

手動にしているあいだ `start` はラウンドを配らない。ボタンを押したときだけ配る。手動から固定やランダムに戻すと、タイマーを付け直す。

端末同士は「同時」か「ばらす」。ばらすときは 0〜最大秒を、参加端末へ均等に割り当ててシャッフルする。固定秒とばらすは同時に使える。間隔は共通で、各端末の反転時刻だけがずれる。

今の色が残りどれだけ続くかを、その色の上に出す。

- カウントダウンは、表示された瞬間から残り秒（10なら 10、9、8）。切り替わる前の予告カウントではない。
- フェードはその色が出た瞬間から薄くなる。
- 点滅は、その色の寿命の後半（残りが半分以下）から。前半は点灯のまま。点灯の緑の方が、点滅の緑より安全、という判断を練習する。
- 演出の先行時間は 0。黒ギャップは 280ms。

## Random Goal（ランダムゴール）

端末がゴールの色になる。緑へ攻める、赤を防ぐ、のように同時に判断する。色数は2色（緑・赤）または3色（緑・赤・黄）。各色の台数は固定か、最小〜最大のランダム。

タイミング、同時／ばらし、カウントダウン・点滅・フェード、切替音、手動の「ランダム表示」と「色を指定」は FieldScan と同じ。色指定のトグルは 緑 / 赤 / 黄。2色のときは黄を出さない。参加直後の色は緑。

## NumberTap（順番タップ）

押す順番は 1→2→3→4→5→6→7→8→9→0。0は10。

- 押すべき数字は、参加端末のうちちょうど1台に出る。ほかの端末はその数字以外を独立にランダムで出す。端末同士で偽物の数字がかぶってよい。
- 正しい端末を押すと次の数字へ進み、どの端末が本物かも振り直す。
- 違う数字を押しても、リセットしないし進まない。盤面もその場では変わらない。
- 1台だけでも動く。その端末が常に本物になる。2台以上だと偽物が出る。
- 計測は、1が最初に出てから 0 を押すまで。コントローラに途中経過と最終タイムを出す。
- 表示の入れ替えは、正解する前のシャッフル。固定秒（0秒は正解するまで固定）か、下限〜上限のランダム秒。入れ替えでは順番は進まない。初期値は固定3秒。ランダムの初期値は1〜4秒。
- 進捗は画面下の 1〜0 の箱だけ。押した番号は緑、次に押す番号は白い大きめの箱。画面上部の「次に押す」番号は出さない。
- 同じ端末への連続タップは約280ms で無視する。次の数字が同じ端末に戻ったときの二度押しで飛ばさないため。

## Shuttle Touch（シャトルタッチ）

光っている端末をタップすると消え、別の端末が光る。消えている端末を押しても進まない。直前に押した端末は、他に端末がある限り次の光り先から外す。端末が1台のときは、同じ端末が再び光る。同じ端末の連打は450ms 無視する。2台のバトルで色が入れ替わった直後に、同じタップが相手の得点になるのを防ぐ。

- 1人モード。回数は5〜50、初期値10。最初に光ってから最後のタップまでの秒数。達成後は全端末に秒数を出す。
- バトル。緑と赤が別々の端末で同時に1台ずつ光る。自分の色を押した回数だけが進む。先に回数へ届いた色の勝ち。秒数は出さない。決着したら全端末に「緑の勝ち」または「赤の勝ち」。端末は2台以上。2台のときは、押した色が相手のいた端末へ移り、相手の色が今押した端末へ移る。

## PeriTap（周辺視タップ）

真ん中のコントローラを見て、周囲の黒数字から同じ数字を探す。数字は 0〜9。切り替えは 0.5〜3 秒、初期値 1 秒。全員同時に変わる。制限時間は 20〜45 秒、初期値 30 秒。周囲の端末は 2〜6 台（コントローラを入れて 3〜7 台）。

真ん中の数字そのものが緑か赤で、背景は塗らない。緑は許可、赤は禁止。周囲の数字は黒。コントローラを含めて3台つながるまで開始しない。

- 緑で、同じ数字の端末をタップすると正解。押しそこね、または別の端末は失敗。
- 赤でタップするとお手つき。赤のときも同じ数字はどこかにある。
- ハズレも混ぜる。押せる問題（緑で、同じ数字が1台ある）はちょうど10回。10回目の表示が終わると終了し、最後は必ず押せる問題。正解が10に達しただけでは終わらない。
- 正当が来ない連続は4回まで。設定秒数に近づく長さにする。切り替えが短すぎて収まらないときは、5連続を避けて少し短く終わる。切り替えが長く10回分が設定秒数に入らないときは、10回分まで少し延びる。
- 簡単は毎コマ、赤でも緑でも同じ数字がちょうど 1 台にある。結果は正答 x/10。
- 難しいは、緑でも同じ数字がどこにもないコマがある。それは 10 問に数えない。押したらお手つき、押さなくてもミスにはしない。10 問は「緑、かつ正解が 1 台ある」だけ。
- 配置は周囲の台数で決まる。2 台は 9 時と 3 時。3 台は 10 時・2 時・6 時。4 台は 10 時・8 時・4 時・2 時。5 台と 6 台は 12 時の No.1 から左回りの正多角形。台数が変わると位置も変わる。

コントローラ端末自体が真ん中の表示になる。周囲は `/d/コード`。

## Saccade（サッケード）

眼球運動。黒い丸（直径 2.5cm）を、顔を動かさず目だけで追う。配置は PeriTap と同じで、コントローラを入れて 3〜7 台。点数はない。

丸は必ず真ん中の端末を経由する。入ってきた向きから真ん中を通り、次の端末の向きへ出る。端末と端末のあいだは消し、着いた端末では内側から外側へ進んではね返り、内側へ戻る。直前の端末以外を次に選ぶ。画面の中の速さは一定。

- 調整モードは終わるまで繰り返す。真ん中を通る秒数、端での往復、消えている秒数をその場で変える。
- 通常は真ん中 3 秒、端 5 秒。早めは真ん中 2 秒、端 3.5 秒。消え時間は 1〜5 秒、初期値 2 秒。
- トレーニングは 20 秒か 30 秒。時間になったら、動きの途中でも終わる。

## FlashMem（瞬間視）

数字を同時に短く出し、場所を覚えてから答える。配置は PeriTap と同じ。表示は 0.1〜1 秒、初期値 0.5 秒。1 問はフラッシュ 1 回。

答えは、真ん中が数字を 1 つずつランダムに出す。出ていた端末をタップすると次の数字になる。全部答えると、当たった数字は緑、外れた数字は赤でもう一度出す。結果は正答 x/x。x は出た数字の数。

- 簡単は 1 からの連番を、端末へばらまく。
- 難しいは 0〜99 の重複なしで、2 桁の数を必ず含む。
- コントローラーに数字を出すかは選べる。出していた数字の答えは、コントローラー自身をタップする。
- 左右2分割は、各端末を左右に分けて数字を 2 つ出す。出ていた側をタップする。コントローラーも出す設定なら、コントローラーも左右に分かれる。

## Keep（ドリブルキープ）

端末は正多角形の頂点に置く。コントローラも頂点の1つで、そこから反時計回りに No.2、No.3。2台のときは左右で向かい合う。

赤が1台、ほかは緑。赤が敵なので、その端末からボールを隠してキープする。切り替えは1〜5秒、練習は10秒〜1分。音ありのとき、赤に変わった端末だけが約0.5秒ブーと鳴る。終わるとコントローラはメニューに戻り、ほかの端末は無色になる。

## Escape（エスケープ）

置き方はキープと同じで、端末の間隔は少し遠め。緑が1台、ほかは赤。緑が空きなので、そこへボールを逃がしながらドリブルする。切り替えと練習時間、音のルールはキープと同じ。鳴るのは赤の端末。終わるとコントローラはメニューに戻り、ほかは無色になる。

## Drive（ドライブ）

手前から1列目、2列目、3列目。列は1〜3、各列は2〜4枚。コントローラは1列目の向かって左端。ほかの端末は1列目の右へ、次に2列目の左から右、その次に3列目の左から右へ並ぶ。

色が出るのは1列だけ。その列の緑が1つ、ほかはその列の赤。緑のすき間をめがけて手前から奥へボールを運ぶ。次の緑は前の緑のとなりだけで、同じ枚数の列では同じ位置が続かない。1列目が2枚で左が緑のとき、2列目が3枚なら右端には進まない。1列の表示は2〜10秒。停止するまで繰り返す。止めるとコントローラはメニューに戻り、ほかは無色になる。

## コントローラ

各アプリで共通の操作。

1. ポータルか各アプリの先頭でルームを作る。
2. ウィザードで説明、この端末の役割、必要な設定、QRで端末参加、確認。
3. 「はじめる」でセッション開始。役割は「操作専用」か「この端末も表示に含める」。
4. 実行中に秒数やモードを変えてよい。NumberTap の表示秒数を変えても、その場では盤面を振り直さない。次の間隔から効く。
5. 「一時停止」はセッションを止める。FieldScan / Random Goal では色を消さない停止。Shuttle Touch は光を消す。
6. 「セットアップウィザードをやり直す」で説明から戻れる。

## まだ作っていない案

同じ殻で足せる、として話しただけで実装していない。

- ストップタッチ。緑は押す、赤は押さない。赤を押したら失敗。
- コールタッチ。複数端末が同時に別の色で光り、呼ばれた色の端末だけを押す。
- ゲートタッチ。2台が同時に光り、両方押すと別の2台へ移る。

## 再開するとき

アプリを増やすときは、NumberTap か Shuttle Touch の `server.ts`、`src/server/room.ts`、`src/app/r/[code]`、`src/app/d/[code]` を複製する。ドメインは Render に足さず、`proxy/` の Worker で `名前.rojiura.app` を `名前-tr.onrender.com` へ中継し、ポータルの `index.html` と `styles.css` にカードを足して Pages をデプロイする。
