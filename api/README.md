# tr-api（TRwebapp）

Cloudflare Worker。広告ブートストラップと、CF移行第一弾のルーム（Keep）を担う。

本番: https://tr-api.rojiura.app

## エンドポイント

| 方法 | パス | 内容 |
|------|------|------|
| GET | `/health` | 生存確認 |
| POST | `/v1/bootstrap` | 属性・広告判定・サーバ時刻 |
| POST | `/v1/stats` | 統計イベント |
| POST | `/v1/rooms` | ルーム作成（いま `dribblekeep` のみ） |
| GET | `/v1/rooms/:code?app=` | 存在確認 |
| GET | `/ws?room=&role=&deviceId=&app=` | WebSocket（Durable Object） |

## Keep ルーム（Durable Object）

`KeepRoom` が部屋ごとに状態と WS を持つ。出題は playPackage、進行は alarm。  
UI（`dribblekeep.rojiura.app`）は当面 Render、ルーム／同期だけ CF。

```bash
cd api
npm install
npx wrangler deploy
```

## ローカル

```bash
npx wrangler dev
curl -s http://127.0.0.1:8787/health
curl -s -X POST http://127.0.0.1:8787/v1/rooms \
  -H 'content-type: application/json' \
  -d '{"app":"dribblekeep"}'
```
