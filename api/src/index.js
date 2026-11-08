/**
 * TRwebapp API（Cloudflare Worker）
 * - bootstrap / stats
 * - 全作成済みアプリのルーム Durable Objects
 */

import { DriveRoom } from "./driveRoom.js";
import { FieldScanRoom } from "./fieldscanRoom.js";
import { FlashMemRoom } from "./flashmemRoom.js";
import { GoalRoom } from "./goalRoom.js";
import { KeepRoom, LONE_APPS, randomRoomCode } from "./keepRoom.js";
import { NumberTapRoom } from "./numbertapRoom.js";
import { PeriRoom } from "./periRoom.js";
import { SaccadeRoom } from "./saccadeRoom.js";
import { ShuttleRoom } from "./shuttleRoom.js";

export {
  KeepRoom,
  DriveRoom,
  FieldScanRoom,
  GoalRoom,
  PeriRoom,
  SaccadeRoom,
  FlashMemRoom,
  NumberTapRoom,
  ShuttleRoom,
};

const HOUR_MS = 60 * 60 * 1000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ROOM_APPS = new Set([
  ...LONE_APPS,
  "drive",
  "fieldscan",
  "randomgoal",
  "peritap",
  "saccade",
  "flashmem",
  "numbertap",
  "shuttletouch",
]);

const DO_BINDING = {
  dribblekeep: "KEEP_ROOM",
  escape: "KEEP_ROOM",
  drive: "DRIVE_ROOM",
  fieldscan: "FIELDSCAN_ROOM",
  randomgoal: "GOAL_ROOM",
  peritap: "PERI_ROOM",
  saccade: "SACCADE_ROOM",
  flashmem: "FLASHMEM_ROOM",
  numbertap: "NUMBERTAP_ROOM",
  shuttletouch: "SHUTTLE_ROOM",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return json({
          ok: true,
          service: "tr-api",
          now: Date.now(),
          rooms: [...ROOM_APPS],
        });
      }
      if (url.pathname.startsWith("/ads/") && (request.method === "GET" || request.method === "HEAD")) {
        return handleAds(request, env, url);
      }
      if (url.pathname === "/v1/bootstrap" && request.method === "POST") {
        return handleBootstrap(request, env);
      }
      if (url.pathname === "/v1/stats" && request.method === "POST") {
        return handleStats(request, env);
      }
      if (url.pathname === "/v1/rooms" && request.method === "POST") {
        return handleCreateRoom(request, env);
      }
      if (url.pathname.startsWith("/v1/rooms/") && request.method === "GET") {
        return handleRoomExists(url, env);
      }
      if (url.pathname === "/ws") {
        return handleWs(request, env, url);
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      return json({ error: "server_error", message: String(error?.message || error) }, 500);
    }
  },
};

function roomStub(env, app, code) {
  const binding = DO_BINDING[app];
  if (!binding || !env[binding]) return null;
  const id = env[binding].idFromName(`${app}:${code}`);
  return env[binding].get(id);
}

async function handleCreateRoom(request, env) {
  const body = await readJson(request);
  const app = String(body.app || "").slice(0, 64);
  if (!ROOM_APPS.has(app)) {
    return json(
      { error: "unsupported_app", message: `対応アプリ: ${[...ROOM_APPS].join(", ")}` },
      400
    );
  }
  let code = randomRoomCode();
  for (let i = 0; i < 8; i++) {
    const stub = roomStub(env, app, code);
    const exists = await stub.fetch("https://room/exists");
    const data = await exists.json();
    if (!data.exists) {
      await stub.fetch("https://room/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, app }),
      });
      return json({
        code,
        app,
        host: urlHost(request),
        wsPath: "/ws",
      });
    }
    code = randomRoomCode();
  }
  return json({ error: "room_create_failed" }, 503);
}

async function handleRoomExists(url, env) {
  const code = url.pathname.split("/").pop()?.toUpperCase() || "";
  const app = url.searchParams.get("app") || "dribblekeep";
  if (!code || !ROOM_APPS.has(app)) return json({ exists: false });
  const stub = roomStub(env, app, code);
  const res = await stub.fetch("https://room/exists");
  const data = await res.json();
  return json({ exists: Boolean(data.exists && data.code === code), code });
}

async function handleWs(request, env, url) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "expected_websocket" }, 426);
  }
  const app = url.searchParams.get("app") || "dribblekeep";
  const room = (url.searchParams.get("room") || "").toUpperCase();
  if (!ROOM_APPS.has(app) || !room) {
    return new Response("bad room", { status: 400 });
  }
  const stub = roomStub(env, app, room);
  return stub.fetch(request);
}

function urlHost(request) {
  return new URL(request.url).host;
}

async function handleBootstrap(request, env) {
  const body = await readJson(request);
  const profile = normalizeProfile(body.profile);
  const client = normalizeClient(body.client);
  const firstVisit = Boolean(body.firstVisit);
  const lastAdAt = numberOrNull(body.lastAdAt);
  const skipDebt = Math.max(0, Math.floor(Number(body.skipDebt) || 0));
  const now = Date.now();

  // 識別子は保存しない。属性は回数カウンタのみ。初回端末リクエストは別カウンタ。
  if (firstVisit) {
    await bumpUsageCounters(env, {
      at: now,
      kind: "first_visit",
      app: client.app,
      profile: null,
      cross: false,
    });
  }
  await bumpUsageCounters(env, { at: now, kind: "use", app: client.app, profile });

  const ad = decideAd({ now, lastAdAt, skipDebt, profile });
  return json({
    serverNow: now,
    profileAccepted: Boolean(profile),
    ad,
    package: {
      version: "0.0.0",
      note: "local runtime packages not uploaded yet",
    },
  });
}

async function handleStats(request, env) {
  const body = await readJson(request);
  const now = Date.now();
  const profile = normalizeProfile(body.profile);
  const client = normalizeClient(body.client);
  const type = str(body.type || "event", 64) || "event";

  if (type === "ad_impression" || type === "ad_skip") {
    await bumpUsageCounters(env, {
      at: now,
      kind: type === "ad_skip" ? "ad_skip" : "ad_impression",
      app: client.app,
      profile,
    });
  }

  return json({ ok: true, serverNow: now });
}

const GAMECHOP_CREATIVE = {
  id: "gamechop-self-promo",
  kind: "video",
  title: "GameChop",
  url: "https://gamechop.rojiura.app/",
  mediaUrl: "https://tr-api.rojiura.app/ads/gamechop/self-promo-30s.mp4",
  mediaType: "video/mp4",
  durationSeconds: 30,
  skippable: true,
};

function decideAd({ now, lastAdAt, skipDebt, profile: _profile }) {
  const due = lastAdAt == null || now - lastAdAt >= HOUR_MS;
  if (!due) {
    return { show: false, reason: "within_hour", count: 0, creatives: [] };
  }
  const count = skipDebt >= 5 ? 2 : 1;
  // profile は将来の出し分け用。現状クリエイティブは共通。
  return {
    show: true,
    reason: skipDebt >= 5 ? "skip_debt_repay" : "hourly",
    count,
    creatives: Array.from({ length: count }, () => ({ ...GAMECHOP_CREATIVE })),
  };
}

async function handleAds(request, env, url) {
  const key = decodeURIComponent(url.pathname.slice("/ads/".length));
  if (!key || key.includes("..") || key.startsWith("/") || key.includes("\\")) {
    return json({ error: "bad_key" }, 400);
  }
  if (!env.ADS) {
    return json({ error: "ads_unavailable" }, 503);
  }

  const rangeHeader = request.headers.get("Range");
  const object = await env.ADS.get(key, rangeHeader ? { range: request.headers } : undefined);
  if (!object) {
    return new Response("Not found", { status: 404, headers: CORS });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=86400");
  if (!headers.get("Content-Type")) {
    if (key.endsWith(".mp4")) headers.set("Content-Type", "video/mp4");
    else if (key.endsWith(".webm")) headers.set("Content-Type", "video/webm");
    else headers.set("Content-Type", "application/octet-stream");
  }

  // <video> は Content-Length が必要。クライアントが Range を付けたときだけ 206 にする
  const total = object.size;
  const ranged =
    Boolean(rangeHeader) &&
    object.range &&
    !(object.range.offset === 0 && object.range.length === total);
  if (ranged) {
    const { offset, length } = object.range;
    const end = offset + length - 1;
    headers.set("Content-Range", `bytes ${offset}-${end}/${total}`);
    headers.set("Content-Length", String(length));
  } else if (total != null) {
    headers.delete("Content-Range");
    headers.set("Content-Length", String(total));
  }

  const status = ranged ? 206 : 200;
  if (request.method === "HEAD") {
    return new Response(null, { status, headers });
  }
  return new Response(object.body, { status, headers });
}

async function ensureStatsSchema(env) {
  if (!env.DB || ensureStatsSchema.ready) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS counters (
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      dim TEXT NOT NULL,
      value TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, kind, dim, value)
    )`
  ).run();
  ensureStatsSchema.ready = true;
}

function statsDay(at) {
  // JST の日付で日次集計
  const jst = new Date(at + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

async function bumpCounter(env, { day, kind, dim, value, n = 1 }) {
  if (!env.DB) return;
  const v = value || "_";
  await env.DB.prepare(
    `INSERT INTO counters (day, kind, dim, value, count) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(day, kind, dim, value) DO UPDATE SET count = count + excluded.count`
  )
    .bind(day, kind, dim, v, n)
    .run();
}

/**
 * 属性は回数カウンタのみ（個人・端末との紐づけ保存なし）。
 * クロス: 県×練習者年代 / 利用形態×人数 / 県×利用形態
 */
async function bumpUsageCounters(env, { at, kind, app, profile, cross = true }) {
  if (!env.DB) return;
  try {
    await ensureStatsSchema(env);
    const day = statsDay(at);
    await bumpCounter(env, { day, kind, dim: "total", value: "_", n: 1 });
    if (app) await bumpCounter(env, { day, kind, dim: "app", value: app, n: 1 });
    if (!profile) return;
    for (const dim of [
      "userAgeBand",
      "usageType",
      "groupSizeBand",
      "prefecture",
      "traineeAgeBand",
    ]) {
      const value = profile[dim];
      if (value) await bumpCounter(env, { day, kind, dim, value, n: 1 });
    }
    if (!cross) return;
    const pref = profile.prefecture || "";
    const trainee = profile.traineeAgeBand || "";
    const usage = profile.usageType || "";
    const group = profile.groupSizeBand || "";
    if (pref && trainee) {
      await bumpCounter(env, {
        day,
        kind,
        dim: "prefecture_x_traineeAge",
        value: `${pref}|${trainee}`,
        n: 1,
      });
    }
    if (usage && group) {
      await bumpCounter(env, {
        day,
        kind,
        dim: "usageType_x_groupSize",
        value: `${usage}|${group}`,
        n: 1,
      });
    }
    if (pref && usage) {
      await bumpCounter(env, {
        day,
        kind,
        dim: "prefecture_x_usageType",
        value: `${pref}|${usage}`,
        n: 1,
      });
    }
  } catch {
    /* ignore */
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
