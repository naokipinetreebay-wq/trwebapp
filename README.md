# TRwebapp ポータル

- Cloudflare Pages: https://trwebapp.pages.dev  
- 本番: https://tr.rojiura.app （DNS 設定後）

| アプリ | URL |
|--------|-----|
| 首振り | https://fieldscan.rojiura.app |
| ゴール | https://randomgoal.rojiura.app |
| 順番タップ | https://numbertap.rojiura.app |
| シャトルタッチ | https://shuttletouch.rojiura.app |

## DNS（Cloudflare）

| タイプ | 名前 | ターゲット | プロキシ |
|--------|------|------------|----------|
| CNAME | `tr` | `trwebapp.pages.dev` | オレンジ雲（Proxied）でOK |
| CNAME | `numbertap` | Worker `numbertap-proxy` が自動作成 | オレンジ雲。中身は `numbertap-tr.onrender.com` |
| CNAME | `shuttletouch` | Worker `shuttletouch-proxy` が自動作成 | オレンジ雲。中身は `shuttletouch-tr.onrender.com` |

Pages プロジェクト側にも `tr.rojiura.app` カスタムドメインを追加済み。DNS の CNAME があれば有効化されます。

## デプロイ

```bash
npx wrangler pages deploy . --project-name trwebapp --branch main
```
