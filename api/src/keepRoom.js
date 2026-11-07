/**
 * Keep（ドリブルキープ）用ルーム Durable Object。
 * Hibernation WebSocket + alarm でフレーム進行。状態は storage に保存。
 */

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CONTROLLER_ID = "controller";
const LONE_SIGNAL = "red";
const MIN_TOTAL = 2;
const MAX_PERIPHERALS = 7;
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 5;
const MIN_DURATION = 10;
const MAX_DURATION = 60;

const DEFAULT_CONFIG = {
  intervalSeconds: 2,
  durationSeconds: 30,
  sound: true,
  running: false,
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function otherSignal(signal) {
  return signal === "red" ? "green" : "red";
}

function pickLone(ids, previous, rng) {
  const pool = previous ? ids.filter((id) => id !== previous) : ids;
  const choices = pool.length > 0 ? pool : ids;
  const index = Math.min(choices.length - 1, Math.floor(rng() * choices.length));
  return choices[Math.max(0, index)];
}

function emptyState(code) {
  return {
    code,
    app: "dribblekeep",
    config: { ...DEFAULT_CONFIG },
    displays: {},
    controllerSignal: null,
    loneId: null,
    frameStartedAt: null,
    startedAt: null,
    endsAt: null,
    finishedAt: null,
    playPackage: null,
    packageIndex: 0,
    signals: {},
    lastActivity: Date.now(),
  };
}

export class KeepRoom {
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
      if (!code) return Response.json({ error: "code_required" }, { status: 400 });
      if (!this.data.code) {
        this.data = emptyState(code);
        await this.persist();
      }
      return Response.json({ ok: true, code: this.data.code });
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

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ role, deviceId, label });

      if (role === "display") {
        this.addDisplay(deviceId, label);
      }
      await this.persist();
      this.sendTo(server, { type: "snapshot", snapshot: this.snapshot() });
      if (role === "display") this.broadcast();
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
        this.addDisplay(msg.deviceId, msg.label);
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
    if (meta.role !== "controller") {
      this.sendTo(ws, { type: "error", message: "コントローラのみ操作できます" });
      return;
    }

    if (msg.type === "updateConfig") {
      this.updateConfig(msg.config || {});
      await this.persist();
      this.broadcast();
      return;
    }
    if (msg.type === "setLabel" && msg.deviceId) {
      const d = this.data.displays[msg.deviceId];
      if (d) d.label = String(msg.label || "").slice(0, 24);
      await this.persist();
      this.broadcast();
      return;
    }
    if (msg.type === "start") {
      this.start();
      await this.persist();
      this.broadcast();
      return;
    }
    if (msg.type === "stop") {
      await this.stop();
      this.broadcast();
      return;
    }
  }

  async webSocketClose(ws) {
    await this.ready;
    const meta = ws.deserializeAttachment() || {};
    if (meta.role === "display" && meta.deviceId && this.data.displays[meta.deviceId]) {
      this.data.displays[meta.deviceId].connected = false;
      await this.persist();
      this.broadcast();
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    await this.ready;
    if (!this.data.config.running || !this.data.playPackage) return;
    const nextIndex = this.data.packageIndex + 1;
    if (nextIndex >= this.data.playPackage.frames.length) {
      await this.finish();
      this.broadcast();
      return;
    }
    this.data.packageIndex = nextIndex;
    this.applyFrame(this.data.playPackage.frames[nextIndex]);
    await this.armPackage();
    await this.persist();
    this.broadcast();
  }

  addDisplay(deviceId, label) {
    const existing = this.data.displays[deviceId];
    if (existing) {
      existing.connected = true;
      if (label) existing.label = String(label).slice(0, 24);
      return;
    }
    const count = Object.keys(this.data.displays).length;
    if (count >= MAX_PERIPHERALS) return;
    const place = count + 2;
    this.data.displays[deviceId] = {
      id: deviceId,
      label: label ? String(label).slice(0, 24) : `No.${place}`,
      place,
      connected: true,
    };
  }

  updateConfig(partial) {
    if (this.data.config.running) return;
    const next = { ...this.data.config, ...partial, running: false };
    next.intervalSeconds = clamp(Math.round(next.intervalSeconds), MIN_INTERVAL, MAX_INTERVAL);
    next.durationSeconds = clamp(Math.round(next.durationSeconds), MIN_DURATION, MAX_DURATION);
    next.sound = !!next.sound;
    this.data.config = next;
  }

  controllersOpen() {
    return this.ctx.getWebSockets().filter((ws) => {
      const meta = ws.deserializeAttachment() || {};
      return meta.role === "controller";
    });
  }

  liveIds() {
    const ids = Object.values(this.data.displays)
      .filter((d) => d.connected)
      .map((d) => d.id);
    if (this.controllersOpen().length > 0) ids.unshift(CONTROLLER_ID);
    return ids;
  }

  start() {
    const ids = this.liveIds();
    const peripherals = ids.filter((id) => id !== CONTROLLER_ID);
    if (
      this.controllersOpen().length < 1 ||
      peripherals.length < 1 ||
      ids.length < MIN_TOTAL ||
      Object.keys(this.data.displays).length > MAX_PERIPHERALS
    ) {
      return;
    }
    if (peripherals.length !== Object.keys(this.data.displays).length) return;

    const now = Date.now();
    this.data.config.running = true;
    this.data.startedAt = now;
    this.data.endsAt = now + this.data.config.durationSeconds * 1000;
    this.data.finishedAt = null;
    this.data.loneId = null;
    this.data.playPackage = this.buildPlayPackage(ids, now, this.data.endsAt);
    this.data.packageIndex = 0;
    const first = this.data.playPackage.frames[0];
    if (!first) {
      void this.finish();
      return;
    }
    this.applyFrame(first);
    void this.armPackage();
  }

  async stop() {
    await this.ctx.storage.deleteAlarm();
    this.data.config.running = false;
    this.data.controllerSignal = null;
    this.data.loneId = null;
    this.data.signals = {};
    this.data.frameStartedAt = null;
    this.data.finishedAt = null;
    this.data.playPackage = null;
    this.data.packageIndex = 0;
    await this.persist();
  }

  buildPlayPackage(ids, startAt, endsAt) {
    const intervalMs = this.data.config.intervalSeconds * 1000;
    const rest = otherSignal(LONE_SIGNAL);
    const frames = [];
    let at = startAt;
    let prevLone = null;
    while (true) {
      const lone = pickLone(ids, prevLone, Math.random);
      prevLone = lone;
      const signals = {};
      for (const id of ids) signals[id] = id === lone ? LONE_SIGNAL : rest;
      frames.push({ frameStartedAt: at, loneId: lone, signals });
      const frameEnd = at + intervalMs;
      if (frameEnd >= endsAt) break;
      at = frameEnd;
    }
    return { intervalMs, endsAt, frames };
  }

  applyFrame(frame) {
    this.data.loneId = frame.loneId;
    this.data.signals = { ...frame.signals };
    this.data.controllerSignal = frame.signals[CONTROLLER_ID] ?? null;
    this.data.frameStartedAt = frame.frameStartedAt;
  }

  async armPackage() {
    await this.ctx.storage.deleteAlarm();
    if (!this.data.playPackage || this.data.endsAt == null) return;
    const nextIndex = this.data.packageIndex + 1;
    if (nextIndex >= this.data.playPackage.frames.length) {
      await this.ctx.storage.setAlarm(this.data.endsAt);
      return;
    }
    const next = this.data.playPackage.frames[nextIndex];
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next.frameStartedAt));
  }

  async finish() {
    await this.ctx.storage.deleteAlarm();
    this.data.config.running = false;
    this.data.controllerSignal = null;
    this.data.loneId = null;
    this.data.signals = {};
    this.data.frameStartedAt = null;
    this.data.finishedAt = Date.now();
    this.data.playPackage = null;
    this.data.packageIndex = 0;
    await this.persist();
  }

  snapshot() {
    const running = this.data.config.running;
    const displays = Object.values(this.data.displays).map((d) => ({
      id: d.id,
      label: d.label,
      place: d.place,
      connected: !!d.connected,
      signal: running ? this.data.signals[d.id] ?? null : null,
    }));
    return {
      code: this.data.code,
      config: this.data.config,
      displays,
      controllerSignal: running ? this.data.controllerSignal : null,
      loneId: running ? this.data.loneId : null,
      frameStartedAt: running ? this.data.frameStartedAt : null,
      startedAt: this.data.startedAt,
      endsAt: this.data.endsAt,
      finishedAt: this.data.finishedAt,
      playPackage: running ? this.data.playPackage : null,
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
