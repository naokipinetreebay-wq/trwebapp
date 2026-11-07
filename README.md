# TRwebapp ポータル

本番: https://tr.rojiura.app

- ポータル＋各トレーニング UI: Cloudflare Pages（このリポジトリ）
- 部屋作成・WebSocket: https://tr-api.rojiura.app（Durable Objects）

| パス | アプリ |
|------|--------|
| `/peritap/` | 周辺視タップ |
| `/saccade/` | サッケード |
| `/flashmem/` | 瞬間視 |
| `/numbertap/` | 順番タップ |
| `/shuttletouch/` | シャトルタッチ |
| `/keep/` | ドリブルキープ |
| `/escape/` | エスケープ |
| `/drive/` | ドライブ |
| `/fieldscan/` | 首振りスキャン |
| `/randomgoal/` | ランダムゴール |

部屋 URL 例: `/keep/r/?code=ABCDEF`（表示は `/keep/d/?code=ABCDEF`）

## ビルド・デプロイ

```bash
# 各アプリを static export → このリポジトリ配下へ
node scripts/build-apps.mjs

# Pages へ（api/ は含めない）
STAGE=$(mktemp -d)
cp index.html styles.css _redirects "$STAGE/"
for d in keep escape drive fieldscan randomgoal peritap saccade flashmem numbertap shuttletouch; do
  cp -R "$d" "$STAGE/"
done
npx wrangler pages deploy "$STAGE" --project-name trwebapp --branch main
rm -rf "$STAGE"
```

API（ルーム DO）は `api/` を参照。

```bash
cd api && npx wrangler deploy
```
