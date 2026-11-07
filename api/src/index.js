/**
 * TRwebapp ブートストラップ API（Cloudflare Worker）
 * 部屋作成時だけオンラインで叩く。プレー中は使わない。
 *
 * POST /v1/bootstrap  … 属性つき統計の受付 + 広告判定 + サーバ時刻
 * POST /v1/stats      … 統計イベントのみ
 * GET  /health
 */

const HOUR_MS = 60 * 60 * 1000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ ok: true, service: "tr-api", now: Date.now() });
      }
      if (url.pathname === "/v1/bootstrap" && request.method === "POST") {
        return handleBootstrap(request, env);
      }
      if (url.pathname === "/v1/stats" && request.method === "POST") {
        return handleStats(request, env);
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      return json({ error: "server_error", message: String(error?.message || error) }, 500);
    }
  },
};

async function handleBootstrap(request, env) {
  const body = await readJson(request);
  const profile = normalizeProfile(body.profile);
  const client = normalizeClient(body.client);
  const lastAdAt = numberOrNull(body.lastAdAt);
  const skipDebt = Math.max(0, Math.floor(Number(body.skipDebt) || 0));
  const now = Date.now();

  await recordEvent(env, {
    type: "bootstrap",
    at: now,
    profile,
    client,
    lastAdAt,
    skipDebt,
  });

  const ad = decideAd({ now, lastAdAt, skipDebt });
  return json({
    serverNow: now,
    profileAccepted: Boolean(profile),
    ad,
    // 実行パッケージは後で R2 に置く。今は版だけ返す。
    package: {
      version: "0.0.0",
      note: "local runtime packages not uploaded yet",
    },
  });
}

async function handleStats(request, env) {
  const body = await readJson(request);
  const now = Date.now();
  await recordEvent(env, {
    type: body.type || "event",
    at: now,
    profile: normalizeProfile(body.profile),
    client: normalizeClient(body.client),
    payload: body.payload && typeof body.payload === "object" ? body.payload : {},
  });
  return json({ ok: true, serverNow: now });
}

function decideAd({ now, lastAdAt, skipDebt }) {
  // 初期: 自社 GameChop 宣伝。1時間に1回。スキップ負債はクライアントが保持し、返済本数だけ返す。
  const due = lastAdAt == null || now - lastAdAt >= HOUR_MS;
  if (!due) {
    return { show: false, reason: "within_hour", count: 0, creatives: [] };
  }
  const count = skipDebt >= 5 ? 2 : 1;
  const creative = {
    id: "gamechop-self-promo",
    kind: "self",
    title: "GameChop",
    // 実ファイルは後で tr-ads に置く。当面はサイト誘導でも可。
    url: "https://gamechop.rojiura.app/",
    durationSeconds: 30,
    skippable: true,
  };
  return {
    show: true,
    reason: skipDebt >= 5 ? "skip_debt_repay" : "hourly",
    count,
    creatives: Array.from({ length: count }, () => creative),
  };
}

async function recordEvent(env, event) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        at INTEGER NOT NULL,
        json TEXT NOT NULL
      )`
    ).run();
    await env.DB.prepare(`INSERT INTO events (type, at, json) VALUES (?, ?, ?)`).bind(
      event.type,
      event.at,
      JSON.stringify(event)
    ).run();
  } catch {
    // 初期は失敗しても bootstrap は通す
  }
}

function normalizeProfile(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    userAgeBand: str(raw.userAgeBand, 32),
    usageType: str(raw.usageType, 32),
    groupSizeBand: str(raw.groupSizeBand, 32),
    prefecture: str(raw.prefecture, 32),
    traineeAgeBand: str(raw.traineeAgeBand, 32),
  };
}

function normalizeClient(raw) {
  if (!raw || typeof raw !== "object") return {};
  return {
    app: str(raw.app, 64),
    roomCode: str(raw.roomCode, 16),
    controllerId: str(raw.controllerId, 80),
  };
}

function str(value, max) {
  if (value == null) return "";
  return String(value).slice(0, max);
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}
