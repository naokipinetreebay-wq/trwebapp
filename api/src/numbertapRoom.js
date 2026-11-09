/**
 * NumberTap 用ルーム Durable Object。
 * ローカル化: 盤面・進行・採点はコントローラが hostPush する。
 * DO は参加管理と薄い中継（tap → clientEvent）。旧 alarm 再配布は localHost 時は使わない。
 */

const APP_ID = "numbertap";
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_DISPLAYS = 12;
const LABEL_MAX = 24;
const POOL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
/** 1 → 9 → 0。0 は 10 番目。 */
const SEQUENCE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];

const DEFAULT_CONFIG = {
  timingMode: "fixed",
  /** 0 = 正解するまで盤面を固定 */
  fixedSeconds: 3,
  randomMinSeconds: 1,
  randomMaxSeconds: 4,
  running: false,
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickRandom(list) {
  return list[Math.min(list.length - 1, Math.floor(Math.random() * list.length))];
}

function nextWaitMs(config) {
  if (config.timingMode === "random") {
    const min = Math.min(config.randomMinSeconds, config.randomMaxSeconds);
    const max = Math.max(config.randomMinSeconds, config.randomMaxSeconds);
    return (min + Math.random() * (max - min)) * 1000;
  }
  if (config.fixedSeconds <= 0) return 0;
  return config.fixedSeconds * 1000;
}

function emptyState(code) {
  return {
    code,
    app: APP_ID,
    config: { ...DEFAULT_CONFIG },
    displays: {},
    step: 0,
    digits: {},
    targetId: null,
    boardId: 0,
    startedAt: null,
    finishedAt: null,
    lastElapsedMs: null,
    localHost: true,
    hostOverlay: null,
    lastActivity: Date.now(),
  };
}

export class NumberTapRoom {
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
      if (this.data.localHost) {
        this.relayClientEvent({
          type: "clientEvent",
          event: "tap",
          deviceId: meta.deviceId,
        });
        return;
      }
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
      await this.start(msg.local !== false);
      return;
    }
    if (msg.type === "stop") {
      await this.stop();
      return;
    }
    if (msg.type === "hostPush") {
      this.applyHostPush(msg.overlay || {});
      await this.persist();
      this.broadcast();
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
    // 正解の Display が落ちたら盤面を配り直す（ローカル化時はコントローラが担当）
    if (
      !this.data.localHost &&
      this.data.config.running &&
      this.data.targetId === meta.deviceId
    ) {
      this.deal();
    }
    await this.persist();
    this.broadcast();
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  /** タイマー再配布 */
  async alarm() {
    await this.ready;
    if (this.data.localHost) return;
    if (!this.data.config.running || this.data.step >= SEQUENCE.length) return;
    this.deal();
    await this.arm();
    await this.persist();
    this.broadcast();
  }

  addDisplay(deviceId, label) {
    const existing = this.data.displays[deviceId];
    const cleanLabel = label ? String(label).slice(0, LABEL_MAX) : "";
    if (existing) {
      existing.connected = true;
      if (cleanLabel) existing.label = cleanLabel;
      if (!this.data.localHost && this.isActive() && this.data.digits[deviceId] == null) {
        this.deal();
      }
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
    if (!this.data.localHost && this.isActive()) this.deal();
    return { ok: true };
  }

  isActive() {
    return this.data.config.running && this.data.step < SEQUENCE.length;
  }

  connectedIds() {
    return Object.values(this.data.displays)
      .filter((d) => d.connected)
      .map((d) => d.id);
  }

  async updateConfig(partial) {
    const cur = this.data.config;
    const next = { ...cur, ...partial, running: cur.running };
    next.timingMode = next.timingMode === "random" ? "random" : "fixed";
    next.fixedSeconds = clamp(num(next.fixedSeconds, cur.fixedSeconds), 0, 8);
    next.randomMinSeconds = clamp(num(next.randomMinSeconds, cur.randomMinSeconds), 0.5, 8);
    next.randomMaxSeconds = clamp(num(next.randomMaxSeconds, cur.randomMaxSeconds), 0.5, 8);
    this.data.config = next;
    if (!this.data.localHost && next.running) await this.arm();
    await this.persist();
    this.broadcast();
  }

  async start(local = true) {
    if (this.connectedIds().length === 0) {
      this.broadcast();
      return;
    }
    await this.ctx.storage.deleteAlarm();
    this.data.localHost = local !== false;
    this.data.hostOverlay = null;
    this.data.step = 0;
    this.data.config.running = true;
    this.data.finishedAt = null;
    this.data.lastElapsedMs = null;
    this.data.digits = {};
    this.data.targetId = null;
    this.data.startedAt = null;

    if (this.data.localHost) {
      // 盤面はコントローラが hostPush する
      await this.persist();
      this.broadcast();
      return;
    }

    this.deal();
    this.data.startedAt = Date.now();
    await this.arm();
    await this.persist();
    this.broadcast();
  }

  async stop() {
    const host = this.data.hostOverlay;
    if (host) {
      if (host.step != null) this.data.step = host.step;
      if (host.finishedAt != null) this.data.finishedAt = host.finishedAt;
      if (host.lastElapsedMs != null) this.data.lastElapsedMs = host.lastElapsedMs;
      if (host.startedAt != null) this.data.startedAt = host.startedAt;
      if (host.digits) this.data.digits = { ...host.digits };
      if (host.boardId != null) this.data.boardId = host.boardId;
    }
    this.data.config.running = false;
    this.data.hostOverlay = null;
    await this.ctx.storage.deleteAlarm();
    await this.persist();
    this.broadcast();
  }

  applyHostPush(overlay) {
    const d = this.data;
    d.hostOverlay = { ...(d.hostOverlay || {}), ...overlay };
    if (overlay.digits) d.digits = { ...overlay.digits };
    if (overlay.step != null) d.step = overlay.step;
    if (overlay.targetId !== undefined) d.targetId = overlay.targetId;
    if (overlay.boardId != null) d.boardId = overlay.boardId;
    if (overlay.startedAt !== undefined) d.startedAt = overlay.startedAt;
    if (overlay.lastElapsedMs !== undefined) d.lastElapsedMs = overlay.lastElapsedMs;
    if (overlay.finishedAt != null) {
      d.finishedAt = overlay.finishedAt;
      d.config.running = false;
    }
    d.lastActivity = Date.now();
  }

  relayClientEvent(payload) {
    const raw = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(raw);
      } catch {
        /* ignore */
      }
    }
  }

  async tap(deviceId) {
    if (!this.isActive()) return;
    const target = SEQUENCE[this.data.step];
    if (this.data.digits[deviceId] !== target) return;

    if (this.data.step === SEQUENCE.length - 1) {
      const now = Date.now();
      this.data.finishedAt = now;
      this.data.lastElapsedMs = now - (this.data.startedAt ?? now);
      this.data.step = SEQUENCE.length;
      this.data.config.running = false;
      this.data.targetId = null;
      await this.ctx.storage.deleteAlarm();
      await this.persist();
      this.broadcast();
      return;
    }

    this.data.step += 1;
    this.deal();
    await this.arm();
    await this.persist();
    this.broadcast();
  }

  /** 次の再配布アラームをセット（待ち 0 秒＝固定ならアラームなし）。 */
  async arm() {
    await this.ctx.storage.deleteAlarm();
    if (!this.data.config.running) return;
    const wait = nextWaitMs(this.data.config);
    if (wait <= 0) return;
    await this.ctx.storage.setAlarm(Date.now() + wait);
  }

  deal() {
    const ids = this.connectedIds();
    if (ids.length === 0 || this.data.step >= SEQUENCE.length) {
      this.data.targetId = null;
      this.data.digits = {};
      return;
    }
    const targetDigit = SEQUENCE[this.data.step];
    const targetId = pickRandom(ids);
    const decoys = POOL.filter((n) => n !== targetDigit);
    const digits = {};
    for (const id of ids) {
      digits[id] = id === targetId ? targetDigit : pickRandom(decoys);
    }
    this.data.digits = digits;
    this.data.targetId = targetId;
    this.data.boardId += 1;
  }

  snapshot() {
    const host = this.data.hostOverlay || null;
    const digits = host?.digits ? { ...host.digits } : { ...this.data.digits };
    const step = host?.step ?? this.data.step;
    const displays = Object.values(this.data.displays).map((d) => ({
      id: d.id,
      label: d.label,
      digit: digits[d.id] ?? null,
      connected: !!d.connected,
    }));
    return {
      code: this.data.code,
      config: this.data.config,
      displays,
      step,
      target: step < SEQUENCE.length ? SEQUENCE[step] : null,
      digits,
      boardId: host?.boardId ?? this.data.boardId,
      startedAt: host?.startedAt ?? this.data.startedAt,
      finishedAt: host?.finishedAt ?? this.data.finishedAt,
      lastElapsedMs: host?.lastElapsedMs ?? this.data.lastElapsedMs,
      serverNow: host?.hostNow ?? Date.now(),
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

export const NUMBERTAP_APP_ID = APP_ID;
