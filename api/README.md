# tr-api（TRwebapp）

Cloudflare Worker + Durable Objects。広告ブートストラップと、全トレーニングのルーム／WebSocket を担う。

本番: https://tr-api.rojiura.app

## エンドポイント

| 方法 | パス | 内容 |
|------|------|------|
| GET | `/health` | 生存確認 |
| POST | `/v1/bootstrap` | 属性・広告判定・サーバ時刻 |
| POST | `/v1/stats` | 統計イベント |
| POST | `/v1/rooms` | ルーム作成（`app` で種別指定） |
| GET | `/v1/rooms/:code?app=` | 存在確認 |
| GET | `/ws?room=&role=&deviceId=&app=` | WebSocket（Durable Object） |

## ルーム（Durable Object）

アプリごとに DO（Keep / Escape / Drive / FieldScan / RandomGoal / PeriTap / Saccade / FlashMem / NumberTap / ShuttleTouch）。  
部屋ごとに状態と WS を持ち、進行は alarm。UI は Pages（https://tr.rojiura.app/…）。

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
