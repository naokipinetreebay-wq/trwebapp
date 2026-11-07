# TRwebapp ポータル

構成、技術要素、各アプリの仕様は [PLATFORM.md](./PLATFORM.md)。

- Cloudflare Pages: https://trwebapp.pages.dev  
- 本番: https://tr.rojiura.app （DNS 設定後）
- ブートストラップ API（部屋作成時のみ）: [`api/`](./api/)（Worker `tr-api`）

| アプリ | URL |
|--------|-----|
| 首振り | https://fieldscan.rojiura.app |
| ゴール | https://randomgoal.rojiura.app |
| 順番タップ | https://numbertap.rojiura.app |
| シャトルタッチ | https://shuttletouch.rojiura.app |
| 周辺視タップ | https://peritap.rojiura.app |
| サッケード | https://saccade.rojiura.app |
| 瞬間視 | https://flashmem.rojiura.app |
| ドリブルキープ | https://dribblekeep.rojiura.app |
| エスケープ | https://escape.rojiura.app |
| ドライブ | https://drive.rojiura.app |

## DNS（Cloudflare）

| タイプ | 名前 | ターゲット | プロキシ |
|--------|------|------------|----------|
| CNAME | `tr` | `trwebapp.pages.dev` | オレンジ雲（Proxied）でOK |
| CNAME | `numbertap` | Worker `numbertap-proxy` が自動作成 | オレンジ雲。中身は `numbertap-tr.onrender.com` |
| CNAME | `shuttletouch` | Worker `shuttletouch-proxy` が自動作成 | オレンジ雲。中身は `shuttletouch-tr.onrender.com` |
| CNAME | `peritap` | Worker `peritap-proxy` が自動作成 | オレンジ雲。中身は `peritap-tr.onrender.com` |
| CNAME | `saccade` | Worker `saccade-proxy` が自動作成 | オレンジ雲。中身は `saccade-tr.onrender.com` |
| CNAME | `flashmem` | Worker `flashmem-proxy` が自動作成 | オレンジ雲。中身は `flashmem-tr.onrender.com` |
| CNAME | `dribblekeep` | Worker `dribblekeep-proxy` が自動作成 | オレンジ雲。中身は `dribblekeep-tr.onrender.com` |
| CNAME | `escape` | Worker `escape-proxy` が自動作成 | オレンジ雲。中身は `escape-tr.onrender.com` |
| CNAME | `drive` | Worker `drive-proxy` が自動作成 | オレンジ雲。中身は `drive-tr.onrender.com` |

Pages プロジェクト側にも `tr.rojiura.app` カスタムドメインを追加済み。DNS の CNAME があれば有効化されます。

## デプロイ

```bash
npx wrangler pages deploy . --project-name trwebapp --branch main
```
