# tr-api（TRwebapp ブートストラップ）

部屋作成時だけ叩く Cloudflare Worker。プレー中は使わない。

## エンドポイント

| 方法 | パス | 内容 |
|------|------|------|
| GET | `/health` | 生存確認 |
| POST | `/v1/bootstrap` | 属性・端末情報の受付、広告判定、サーバ時刻 |
| POST | `/v1/stats` | 統計イベントのみ |

## 初回セットアップ（同じ Cloudflare アカウント）

```bash
cd api
npm install

# リソース作成（一度だけ）
npx wrangler d1 create tr-stats
npx wrangler r2 bucket create tr-packages
npx wrangler r2 bucket create tr-ads

# 返ってきた database_id を wrangler.toml に書き、D1/R2 のコメントを外す

npx wrangler deploy
```

本番: https://tr-api.rojiura.app  
（ネストした `api.tr.rojiura.app` は証明書が不安定なため使わない）

## ローカル確認

```bash
npx wrangler dev
curl -s http://127.0.0.1:8787/health
curl -s -X POST http://127.0.0.1:8787/v1/bootstrap \
  -H 'content-type: application/json' \
  -d '{"profile":{"prefecture":"東京","usageType":"group","groupSizeBand":"4-10"},"client":{"app":"peritap"},"lastAdAt":null,"skipDebt":0}'
```
