/**
 * ShuttleTouch 用ルーム Durable Object。
 * Hibernation WebSocket。タイマーなしの純タップ進行（alarm 不要）。状態は storage に保存。
 * solo: 緑の Display をタップして targetCount 回で終了。
 * battle: 緑/赤の 2 点を別々に追い、先に targetCount 回に達した色の勝ち。
 * 設定・開始・停止はコントローラのみ。タップは Display から。
 */

const APP_ID = "shuttletouch";
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_DISPLAYS = 12;
const LABEL_MAX = 24;
const TAP_LOCK_MS = 450;
const MIN_TARGET = 5;
const MAX_TARGET = 50;

const DEFAULT_CONFIG = {
  mode: "solo",
  targetCount: 10,
  running: false,
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function pickId(ids, exclude) {
  const pool = ids.filter((id) => !exclude.has(id));
  if (pool.length === 0) return null;
  return pool[Math.min(pool.length - 1, Math.floor(Math.random() * pool.length))];
}

function emptyState(code) {
  return {
    code,
    app: APP_ID,
    config: { ...DEFAULT_CONFIG },
    displays: {},
    hits: 0,
    greenHits: 0,
    redHits: 0,
    greenId: null,
    redId: null,
    winner: null,
    startedAt: null,
    finishedAt: null,
    lastElapsedMs: null,
    /** deviceId → 最終タップ時刻（連打ロック用） */
    lastTapAt: {},
    lastActivity: Date.now(),
  };
}

export class ShuttleRoom {
  constructor(state, env) {
    this.ctx = state;
    this.env = env;
    this.data = emptyState("");
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get("state");
      if (saved && typeof saved === "object") this.data = saved;
    });
  }

  async persist() {
    this.data.lastActivity = Date.now();
    await this.ctx.storage.put("state", this.data);
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/init") {
      const body = await request.json().catch(() => ({}));
      const code = String(body.code || "").toUpperCase();
      const app = String(body.app || APP_ID);
      if (!code) return Response.json({ error: "code_required" }, { status: 400 });
      if (app !== APP_ID) {
        return Response.json({ error: "unsupported_app" }, { status: 400 });
      }
      if (!this.data.code) {
        this.data = emptyState(code);
        await this.persist();
      }
      return Response.json({ ok: true, code: this.data.code, app: this.data.app });
    }

    if (request.method === "GET" && url.pathname === "/exists") {
      return Response.json({ exists: Boolean(this.data.code), code: this.data.code || null });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const role = url.searchParams.get("role");
      const deviceId = url.searchParams.get("deviceId") || "";
      const label = url.searchParams.get("label") || "";
      if (role !== "controller" && role !== "display") {
        return new Response("bad role", { status: 400 });
      }
      if (!deviceId) return new Response("deviceId required", { status: 400 });
      if (!this.data.code) return new Response("room not found", { status: 404 });

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ role, deviceId, label });

      if (role === "display") {
        const result = this.addDisplay(deviceId, label);
        if (!result.ok) {
          this.sendTo(server, { type: "error", message: result.error });
          server.close(1008, "display_limit");
          return new Response(null, { status: 101, webSocket: client });
        }
        await this.persist();
        this.sendTo(server, { type: "snapshot", snapshot: this.snapshot() });
        this.broadcast();
      } else {
        await this.persist();
        this.sendTo(server, { type: "snapshot", snapshot: this.snapshot() });
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws, message) {
    await this.ready;
    let msg;
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    const meta = ws.deserializeAttachment() || {};

    if (msg.type === "ping") {
      this.sendTo(ws, { type: "pong" });
      return;
    }
    if (msg.type === "hello") {
      if (msg.role === "display" && msg.deviceId) {
        const result = this.addDisplay(msg.deviceId, msg.label);
        if (!result.ok) {
          this.sendTo(ws, { type: "error", message: result.error });
          return;
        }
        ws.serializeAttachment({
          role: "display",
          deviceId: msg.deviceId,
          label: msg.label || "",
        });
        await this.persist();
        this.broadcast();
      } else {
        this.sendTo(ws, { type: "snapshot", snapshot: this.snapshot() });
      }
      return;
    }

    // タップは Display のみ（deviceId は接続時のものを信頼する）
    if (msg.type === "tap") {
      if (meta.role !== "display" || !meta.deviceId) return;
      await this.tap(meta.deviceId);
      return;
    }

    if (meta.role !== "controller") {
      this.sendTo(ws, { type: "error", message: "コントローラのみ操作できます" });
      return;
    }

    if (msg.type === "updateConfig") {
      await this.updateConfig(msg.config || {});
      return;
    }
    if (msg.type === "setLabel" && msg.deviceId) {
      const d = this.data.displays[msg.deviceId];
      if (d) {
        d.label = String(msg.label || "").slice(0, LABEL_MAX);
        await this.persist();
        this.broadcast();
      }
      return;
    }
    if (msg.type === "start") {
      await this.start();
      return;
    }
    if (msg.type === "stop") {
      await this.stop();
      return;
    }
  }

  async webSocketClose(ws) {
    await this.ready;
    const meta = ws.deserializeAttachment() || {};
    if (meta.role !== "display" || !meta.deviceId) return;
    const d = this.data.displays[meta.deviceId];
    if (!d) return;
    // 同じ deviceId で再接続済みならそのまま
    const stillOpen = this.ctx.getWebSockets().some((other) => {
      if (other === ws || other.readyState !== 1) return false;
      const m = other.deserializeAttachment() || {};
      return m.role === "display" && m.deviceId === meta.deviceId;
    });
    if (stillOpen) return;
    d.connected = false;
    if (this.isActive()) this.ensureLights();
    await this.persist();
    this.broadcast();
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  addDisplay(deviceId, label) {
    const existing = this.data.displays[deviceId];
    const cleanLabel = label ? String(label).slice(0, LABEL_MAX) : "";
    if (existing) {
      existing.connected = true;
      if (cleanLabel) existing.label = cleanLabel;
      if (this.isActive()) this.ensureLights();
      return { ok: true };
    }
    const count = Object.keys(this.data.displays).length;
    if (count >= MAX_DISPLAYS) {
      return { ok: false, error: "Display上限（12台）に達しています" };
    }
    this.data.displays[deviceId] = {
      id: deviceId,
      label: cleanLabel || `T${count + 1}`,
      connected: true,
    };
    if (this.isActive()) this.ensureLights();
    return { ok: true };
  }

  isActive() {
    return this.data.config.running && !this.data.winner && this.data.finishedAt == null;
  }

  connectedIds() {
    return Object.values(this.data.displays)
      .filter((d) => d.connected)
      .map((d) => d.id);
  }

  async updateConfig(partial) {
    const cur = this.data.config;
    const next = { ...cur, ...partial, running: cur.running };
    next.mode = next.mode === "battle" ? "battle" : "solo";
    const target = Math.round(Number(next.targetCount));
    next.targetCount = clamp(Number.isFinite(target) ? target : cur.targetCount, MIN_TARGET, MAX_TARGET);
    const modeChanged = next.mode !== cur.mode;
    this.data.config = next;
    if (modeChanged && next.running) {
      await this.stop();
      return;
    }
    await this.persist();
    this.broadcast();
  }

  async start() {
    const ids = this.connectedIds();
    if (ids.length === 0 || (this.data.config.mode === "battle" && ids.length < 2)) {
      this.broadcast();
      return;
    }
    this.data.hits = 0;
    this.data.greenHits = 0;
    this.data.redHits = 0;
    this.data.winner = null;
    this.data.finishedAt = null;
    this.data.lastElapsedMs = null;
    this.data.lastTapAt = {};
    this.data.greenId = null;
    this.data.redId = null;
    this.data.config.running = true;
    this.ensureLights();
    this.data.startedAt = Date.now();
    await this.persist();
    this.broadcast();
  }

  async stop() {
    this.data.config.running = false;
    this.data.greenId = null;
    this.data.redId = null;
    await this.persist();
    this.broadcast();
  }

  async tap(deviceId) {
    if (!this.isActive()) return;
    const now = Date.now();
    const prev = this.data.lastTapAt[deviceId] ?? 0;
    if (now - prev < TAP_LOCK_MS) return;
    const d = this.data;

    if (d.config.mode === "solo") {
      if (deviceId !== d.greenId) return;
      d.lastTapAt[deviceId] = now;
      d.hits += 1;
      if (d.hits >= d.config.targetCount) {
        await this.finishSolo(now);
        return;
      }
      d.greenId = pickId(this.connectedIds(), new Set([deviceId])) ?? deviceId;
      await this.persist();
      this.broadcast();
      return;
    }

    if (deviceId !== d.greenId && deviceId !== d.redId) return;
    d.lastTapAt[deviceId] = now;
    if (deviceId === d.greenId) {
      d.greenHits += 1;
      if (d.greenHits >= d.config.targetCount) {
        await this.finishBattle("green", now);
        return;
      }
      this.moveLight("green");
    } else {
      d.redHits += 1;
      if (d.redHits >= d.config.targetCount) {
        await this.finishBattle("red", now);
        return;
      }
      this.moveLight("red");
    }
    await this.persist();
    this.broadcast();
  }

  async finishSolo(now) {
    this.data.finishedAt = now;
    this.data.lastElapsedMs = now - (this.data.startedAt ?? now);
    this.data.config.running = false;
    this.data.greenId = null;
    await this.persist();
    this.broadcast();
  }

  async finishBattle(winner, now) {
    this.data.winner = winner;
    this.data.finishedAt = now;
    this.data.config.running = false;
    this.data.greenId = null;
    this.data.redId = null;
    await this.persist();
    this.broadcast();
  }

  /** 接続中の Display に緑/赤を割り当て直す（切断・追加時も使用）。 */
  ensureLights() {
    const d = this.data;
    const ids = this.connectedIds();
    const live = new Set(ids);
    if (d.greenId && !live.has(d.greenId)) d.greenId = null;
    if (d.redId && !live.has(d.redId)) d.redId = null;

    if (d.config.mode === "solo") {
      if (!d.greenId) d.greenId = pickId(ids, new Set());
      d.redId = null;
      return;
    }
    if (ids.length < 2) return;
    if (d.greenId && d.greenId === d.redId) d.greenId = null;
    if (!d.greenId) d.greenId = pickId(ids, new Set(d.redId ? [d.redId] : []));
    if (!d.redId) d.redId = pickId(ids, new Set(d.greenId ? [d.greenId] : []));
  }

  moveLight(which) {
    const d = this.data;
    const ids = this.connectedIds();
    const from = which === "green" ? d.greenId : d.redId;
    const other = which === "green" ? d.redId : d.greenId;
    const next = pickId(ids, new Set([from, other].filter(Boolean)));
    if (next) {
      if (which === "green") d.greenId = next;
      else d.redId = next;
      return;
    }
    // 空きがなければ（2 台のみ）緑と赤を入れ替える
    if (from && other) {
      if (which === "green") {
        d.greenId = other;
        d.redId = from;
      } else {
        d.redId = other;
        d.greenId = from;
      }
    }
  }

  lightOf(id) {
    if (this.data.finishedAt != null || this.data.winner) return "off";
    if (id === this.data.greenId) return "green";
    if (id === this.data.redId) return "red";
    return "off";
  }

  snapshot() {
    const displays = Object.values(this.data.displays).map((d) => ({
      id: d.id,
      label: d.label,
      light: this.lightOf(d.id),
      connected: !!d.connected,
    }));
    return {
      code: this.data.code,
      config: this.data.config,
      displays,
      hits: this.data.hits,
      greenHits: this.data.greenHits,
      redHits: this.data.redHits,
      winner: this.data.winner,
      startedAt: this.data.startedAt,
      finishedAt: this.data.finishedAt,
      lastElapsedMs: this.data.lastElapsedMs,
      serverNow: Date.now(),
    };
  }

  sendTo(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }

  broadcast() {
    const payload = JSON.stringify({ type: "snapshot", snapshot: this.snapshot() });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }
}

export function randomRoomCode(length = 6) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

export const SHUTTLE_APP_ID = APP_ID;
