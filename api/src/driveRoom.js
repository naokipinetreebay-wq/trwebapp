/**
 * Drive 用ルーム Durable Object。
 * ローカル化: プレー進行・パッケージはコントローラが hostPush する。
 * DO は参加管理と薄い中継。旧 alarm 自動進行は localHost 時は使わない。
 */

const CONTROLLER_ID = "controller";
const MAX_PERIPHERALS = 11;
const MIN_INTERVAL = 2;
const MAX_INTERVAL = 10;
/** 互換用。localHost 時はコントローラが長いパッケージを配る */
const PACKAGE_LAPS = 12;

const DEFAULT_CONFIG = {
  lines: 3,
  counts: [2, 2, 2],
  intervalSeconds: 4,
  running: false,
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function activeCounts(config) {
  const lines = clamp(Math.round(config.lines), 1, 3);
  return config.counts.slice(0, lines).map((count) => clamp(Math.round(count), 2, 4));
}

function neededPhones(config) {
  return activeCounts(config).reduce((sum, count) => sum + count, 0);
}

function slotsFor(counts) {
  const slots = [];
  let no = 1;
  counts.forEach((count, row) => {
    for (let index = 0; index < count; index++) {
      slots.push({ no, row: row + 1, index, controller: no === 1 });
      no += 1;
    }
  });
  return slots;
}

function adjacentIndexes(prevCount, prevIndex, nextCount) {
  const a0 = prevIndex / prevCount;
  const a1 = (prevIndex + 1) / prevCount;
  const allowed = [];
  for (let j = 0; j < nextCount; j++) {
    const b0 = j / nextCount;
    const b1 = (j + 1) / nextCount;
    const touches = b0 <= a1 + 1e-9 && b1 >= a0 - 1e-9;
    if (!touches) continue;
    if (prevCount === nextCount && j === prevIndex) continue;
    allowed.push(j);
  }
  return allowed;
}

function buildPass(counts, rng) {
  const greens = [];
  for (let i = 0; i < counts.length; i++) {
    const options =
      i === 0
        ? Array.from({ length: counts[i] }, (_, index) => index)
        : adjacentIndexes(counts[i - 1], greens[i - 1] ?? 0, counts[i]);
    if (options.length === 0) {
      greens.push(0);
      continue;
    }
    const pick = Math.min(options.length - 1, Math.floor(rng() * options.length));
    greens.push(options[Math.max(0, pick)]);
  }
  return greens;
}

function emptyState(code) {
  return {
    code,
    app: "drive",
    config: {
      ...DEFAULT_CONFIG,
      counts: [...DEFAULT_CONFIG.counts],
    },
    displays: {},
    controllerSignal: null,
    activeLine: null,
    greens: [],
    frameStartedAt: null,
    playPackage: null,
    packageIndex: 0,
    localHost: true,
    hostOverlay: null,
    signals: {},
    counts: [],
    lastActivity: Date.now(),
  };
}

export class DriveRoom {
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
      return Response.json({ ok: true, code: this.data.code, app: "drive" });
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

      if (role === "display") this.addDisplay(deviceId, label);
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
      await this.start(msg.local !== false);
      await this.persist();
      this.broadcast();
      return;
    }
    if (msg.type === "stop") {
      await this.stop();
      this.broadcast();
      return;
    }
    if (msg.type === "signal" && msg.to && msg.from) {
      const payload = JSON.stringify({
        type: "signal",
        from: msg.from,
        to: msg.to,
        payload: msg.payload,
      });
      for (const peer of this.ctx.getWebSockets()) {
        const meta = peer.deserializeAttachment() || {};
        if (meta.deviceId === msg.to) {
          try { peer.send(payload); } catch { /* ignore */ }
        }
      }
      return;
    }
    if (msg.type === "hostPush") {
      this.data.hostOverlay = {
        ...(this.data.hostOverlay || {}),
        ...(msg.overlay || {}),
      };
      if (msg.overlay?.playPackage !== undefined) {
        this.data.playPackage = msg.overlay.playPackage;
      }
      if (msg.overlay?.signals) {
        this.data.signals = { ...msg.overlay.signals };
        this.data.controllerSignal = msg.overlay.signals[CONTROLLER_ID] ?? null;
      }
      if (msg.overlay?.activeLine !== undefined) {
        this.data.activeLine = msg.overlay.activeLine;
      }
      if (msg.overlay?.greens) this.data.greens = [...msg.overlay.greens];
      if (msg.overlay?.frameStartedAt !== undefined) {
        this.data.frameStartedAt = msg.overlay.frameStartedAt;
      }
      this.data.lastActivity = Date.now();
      await this.persist();
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
    // ローカル化: 進行はコントローラ側。DO alarm では進めない。
    if (this.data.localHost) return;
    if (!this.data.config.running || !this.data.playPackage) return;
    let nextIndex = this.data.packageIndex + 1;
    if (nextIndex >= this.data.playPackage.frames.length) {
      const last = this.data.playPackage.frames[this.data.playPackage.frames.length - 1];
      const more = this.buildFrames(
        last.frameStartedAt + this.data.playPackage.intervalMs,
        PACKAGE_LAPS
      );
      const kept = this.data.playPackage.frames.slice(-Math.max(1, this.data.counts.length));
      this.data.playPackage = {
        intervalMs: this.data.playPackage.intervalMs,
        frames: [...kept, ...more],
      };
      this.data.packageIndex = Math.max(0, kept.length - 1);
      nextIndex = this.data.packageIndex + 1;
    }
    const frame = this.data.playPackage.frames[nextIndex];
    if (!frame) return;
    this.data.packageIndex = nextIndex;
    this.applyFrame(frame);
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
    const counts = partial.counts ? [...partial.counts] : [...this.data.config.counts];
    while (counts.length < 3) counts.push(2);
    this.data.config = {
      ...this.data.config,
      ...partial,
      running: false,
      lines: clamp(Math.round(partial.lines ?? this.data.config.lines), 1, 3),
      counts: [
        clamp(Math.round(counts[0] ?? 2), 2, 4),
        clamp(Math.round(counts[1] ?? 2), 2, 4),
        clamp(Math.round(counts[2] ?? 2), 2, 4),
      ],
      intervalSeconds: clamp(
        Math.round(partial.intervalSeconds ?? this.data.config.intervalSeconds),
        MIN_INTERVAL,
        MAX_INTERVAL
      ),
    };
  }

  controllersOpen() {
    return this.ctx.getWebSockets().filter((ws) => {
      const meta = ws.deserializeAttachment() || {};
      return meta.role === "controller";
    });
  }

  connectedCount() {
    return Object.values(this.data.displays).filter((d) => d.connected).length;
  }

  async start(local = true) {
    const needed = neededPhones(this.data.config);
    if (
      this.controllersOpen().length < 1 ||
      this.connectedCount() !== needed - 1 ||
      Object.keys(this.data.displays).length !== needed - 1
    ) {
      return;
    }
    await this.ctx.storage.deleteAlarm();
    this.data.counts = activeCounts(this.data.config);
    this.data.config.running = true;
    this.data.localHost = local !== false;
    this.data.packageIndex = 0;
    this.data.playPackage = null;
    this.data.hostOverlay = null;
    this.data.controllerSignal = null;
    this.data.activeLine = null;
    this.data.greens = [];
    this.data.signals = {};
    this.data.frameStartedAt = null;
    // パッケージはコントローラが hostPush する
    if (!this.data.localHost) {
      this.data.playPackage = {
        intervalMs: this.data.config.intervalSeconds * 1000,
        frames: this.buildFrames(Date.now(), PACKAGE_LAPS),
      };
      const first = this.data.playPackage.frames[0];
      if (!first) {
        await this.stop();
        return;
      }
      this.applyFrame(first);
      await this.armPackage();
    }
  }

  async stop() {
    await this.ctx.storage.deleteAlarm();
    this.data.config.running = false;
    this.data.controllerSignal = null;
    this.data.activeLine = null;
    this.data.greens = [];
    this.data.signals = {};
    this.data.frameStartedAt = null;
    this.data.playPackage = null;
    this.data.packageIndex = 0;
    this.data.hostOverlay = null;
    await this.persist();
  }

  /** 全体セット同時表示。各列に緑1・ほか赤 */
  computeSignals(greens) {
    const signals = {};
    for (const slot of slotsFor(this.data.counts)) {
      const greenAt = greens[slot.row - 1] ?? 0;
      const signal = slot.index === greenAt ? "green" : "red";
      if (slot.controller) {
        signals[CONTROLLER_ID] = signal;
        continue;
      }
      const display = Object.values(this.data.displays).find((d) => d.place === slot.no);
      if (display) signals[display.id] = signal;
    }
    return signals;
  }

  buildFrames(startAt, laps) {
    const intervalMs = this.data.config.intervalSeconds * 1000;
    const frames = [];
    let at = startAt;
    for (let lap = 0; lap < laps; lap++) {
      const greens = buildPass(this.data.counts, Math.random);
      frames.push({
        frameStartedAt: at,
        activeLine: 0,
        greens: [...greens],
        signals: this.computeSignals(greens),
      });
      at += intervalMs;
    }
    return frames;
  }

  applyFrame(frame) {
    this.data.activeLine = frame.activeLine;
    this.data.greens = [...frame.greens];
    this.data.frameStartedAt = frame.frameStartedAt;
    this.data.signals = { ...frame.signals };
    this.data.controllerSignal = frame.signals[CONTROLLER_ID] ?? null;
  }

  async armPackage() {
    await this.ctx.storage.deleteAlarm();
    if (!this.data.config.running || !this.data.playPackage) return;
    const next = this.data.playPackage.frames[this.data.packageIndex + 1];
    if (!next) {
      const last = this.data.playPackage.frames[this.data.playPackage.frames.length - 1];
      if (!last) return;
      await this.ctx.storage.setAlarm(last.frameStartedAt + this.data.playPackage.intervalMs);
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next.frameStartedAt));
  }

  snapshot() {
    const data = this.data;
    const host = data.hostOverlay || null;
    const running = data.config.running;
    const signals = host?.signals
      ? { ...data.signals, ...host.signals }
      : data.signals;
    const displays = Object.values(data.displays).map((d) => ({
      id: d.id,
      label: d.label,
      place: d.place,
      connected: !!d.connected,
      signal: running ? signals[d.id] ?? null : null,
    }));
    return {
      code: data.code,
      config: data.config,
      displays,
      controllerSignal: running
        ? host?.controllerSignal !== undefined
          ? host.controllerSignal
          : data.controllerSignal
        : null,
      activeLine: running ? (host?.activeLine ?? data.activeLine) : null,
      frameStartedAt: running ? (host?.frameStartedAt ?? data.frameStartedAt) : null,
      playPackage: running
        ? host?.playPackage !== undefined
          ? host.playPackage
          : data.playPackage
        : null,
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
