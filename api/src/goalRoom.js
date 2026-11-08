/**
 * Goal（randomgoalgame）用ルーム Durable Object。
 * Hibernation WebSocket + alarm で playPackage（自動モード）を進める。状態は storage に保存。
 * randomgoalgameTR/src/server/room.ts と src/lib/types.ts の移植。
 */

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_DISPLAYS = 12;
const PACKAGE_ROUNDS = 40;
const BLACK_GAP_MS = 280;

/** Must match DisplayScreen local timings */
const TRANSITION_LEAD_MS = {
  instant: 0,
  countdown: 0,
  blink: 0,
  fade: 0,
};
const TRANSITIONS = ["instant", "countdown", "blink", "fade"];
/** 信号機: 緑(blue) / 赤(vermilion) / 黄(yellow) */
const GOAL_COLORS = ["blue", "vermilion", "yellow"];

function defaultColorConfig() {
  return { mode: "random", fixed: 1, min: 0, max: 4 };
}

const DEFAULT_CONFIG = {
  colorCount: 3,
  blue: defaultColorConfig(),
  vermilion: defaultColorConfig(),
  yellow: defaultColorConfig(),
  timingMode: "random",
  fixedSeconds: 3,
  randomMinSeconds: 2,
  randomMaxSeconds: 5,
  syncMode: "simultaneous",
  staggerMaxSeconds: 2,
  transition: "countdown",
  sound: "off",
  manualAssign: "random",
  manualPreCountdown: false,
  running: false,
};

function defaultConfig() {
  return {
    ...DEFAULT_CONFIG,
    blue: defaultColorConfig(),
    vermilion: defaultColorConfig(),
    yellow: defaultColorConfig(),
  };
}

function zeroCounts() {
  return { blue: 0, vermilion: 0, yellow: 0 };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickTransition(config) {
  if (config.transition !== "random") return config.transition;
  return TRANSITIONS[Math.floor(Math.random() * TRANSITIONS.length)];
}

function nextIntervalMs(config) {
  if (config.timingMode === "fixed") {
    return Math.max(0.5, config.fixedSeconds) * 1000;
  }
  if (config.timingMode === "random") {
    const min = Math.min(config.randomMinSeconds, config.randomMaxSeconds);
    const max = Math.max(config.randomMinSeconds, config.randomMaxSeconds);
    return (min + Math.random() * (max - min)) * 1000;
  }
  return 0;
}

function activeColors(config) {
  return config.colorCount === 2 ? ["blue", "vermilion"] : ["blue", "vermilion", "yellow"];
}

function sampleCount(cfg, n) {
  if (cfg.mode === "fixed") return clamp(cfg.fixed, 0, n);
  const min = clamp(Math.min(cfg.min, cfg.max), 0, n);
  const max = clamp(Math.max(cfg.min, cfg.max), 0, n);
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Partition N slots across colors so totals equal N. */
function partitionCounts(config, n) {
  const colors = activeColors(config);
  const raw = zeroCounts();
  for (const c of colors) {
    raw[c] = sampleCount(config[c], n);
  }

  let sum = colors.reduce((s, c) => s + raw[c], 0);

  if (sum === 0 && n > 0) {
    raw[colors[Math.floor(Math.random() * colors.length)]] = n;
    sum = n;
  }

  if (sum > n) {
    let overflow = sum - n;
    const order = shuffle(colors);
    while (overflow > 0) {
      for (const c of order) {
        if (overflow <= 0) break;
        if (raw[c] > 0) {
          raw[c] -= 1;
          overflow -= 1;
        }
      }
      if (order.every((c) => raw[c] === 0) && overflow > 0) break;
    }
  } else if (sum < n) {
    let need = n - sum;
    const order = shuffle(colors);
    let i = 0;
    while (need > 0) {
      raw[order[i % order.length]] += 1;
      need -= 1;
      i += 1;
    }
  }

  return raw;
}

function emptyState(code) {
  return {
    code,
    config: defaultConfig(),
    displays: {},
    roundId: 0,
    nextChangeAt: null,
    transition: "instant",
    transitionEndsAt: null,
    blackEndsAt: null,
    previousColors: {},
    deviceOffsets: {},
    roundStartedAt: null,
    playPackage: null,
    lastCounts: zeroCounts(),
    packageIndex: 0,
    pendingReveal: null,
    manualCueEndsAt: null,
    lastActivity: Date.now(),
  };
}

export class GoalRoom {
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
      return Response.json({ ok: true, code: this.data.code, app: "randomgoal" });
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
    if (!msg || typeof msg !== "object") return;
    const meta = ws.deserializeAttachment() || {};

    if (msg.type === "ping") {
      this.sendTo(ws, { type: "pong" });
      return;
    }
    if (msg.type === "hello") {
      if (msg.role === "display" && msg.deviceId) {
        const result = this.addDisplay(String(msg.deviceId), msg.label);
        if (!result.ok) {
          this.sendTo(ws, { type: "error", message: result.error });
          return;
        }
        ws.serializeAttachment({
          role: "display",
          deviceId: String(msg.deviceId),
          label: msg.label ? String(msg.label) : "",
        });
        await this.persist();
        this.broadcast();
      } else {
        if (msg.role === "controller" && msg.deviceId) {
          ws.serializeAttachment({
            role: "controller",
            deviceId: String(msg.deviceId),
            label: msg.label ? String(msg.label) : "",
          });
        }
        this.sendTo(ws, { type: "snapshot", snapshot: this.snapshot() });
      }
      return;
    }
    if (meta.role !== "controller") {
      this.sendTo(ws, { type: "error", message: "コントローラのみ操作できます" });
      return;
    }

    if (msg.type === "updateConfig") {
      await this.updateConfig(msg.config || {});
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
      await this.start();
      await this.persist();
      this.broadcast();
      return;
    }
    if (msg.type === "stop") {
      await this.stop();
      await this.persist();
      this.broadcast();
      return;
    }
    if (msg.type === "next") {
      await this.next(msg.colors);
      await this.persist();
      this.broadcast();
      return;
    }
  }

  async webSocketClose(ws) {
    await this.ready;
    const meta = ws.deserializeAttachment() || {};
    if (meta.role === "display") {
      await this.persist();
      this.broadcast(ws);
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    await this.ready;
    if (this.data.pendingReveal && this.data.manualCueEndsAt) {
      await this.revealManualRound();
      await this.persist();
      this.broadcast();
      return;
    }
    const { config } = this.data;
    if (!config.running || config.timingMode === "manual" || !this.data.playPackage) return;
    this.data.packageIndex += 1;
    const round = this.data.playPackage.rounds[this.data.packageIndex];
    if (!round) return;
    this.applyPlayRound(round);
    await this.armPackage();
    await this.persist();
    this.broadcast();
  }

  /* ---------- displays ---------- */

  addDisplay(deviceId, label) {
    const clean = label ? String(label).slice(0, 24) : "";
    const existing = this.data.displays[deviceId];
    if (existing) {
      if (clean) existing.label = clean;
      return { ok: true };
    }
    const count = Object.keys(this.data.displays).length;
    if (count >= MAX_DISPLAYS) {
      return { ok: false, error: "Display上限（12台）に達しています" };
    }
    this.data.displays[deviceId] = {
      id: deviceId,
      label: clean || `G${count + 1}`,
      // Mid-session join waits for the next natural round (do not reset everyone)
      color: "blue",
    };
    return { ok: true };
  }

  /** 開いている display ソケットの deviceId（exclude は閉じ中のソケット） */
  connectedDisplayIds(exclude) {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const meta = ws.deserializeAttachment() || {};
      if (meta.role === "display" && meta.deviceId) ids.add(meta.deviceId);
    }
    return ids;
  }

  /* ---------- config / control ---------- */

  async updateConfig(partial) {
    const cfg = this.data.config;
    const prevTiming = cfg.timingMode;
    const next = { ...cfg };
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (key === "running" || GOAL_COLORS.includes(key)) continue;
      if (partial[key] !== undefined) next[key] = partial[key];
    }

    const limit = Math.max(Object.keys(this.data.displays).length, 12);
    for (const key of GOAL_COLORS) {
      const incoming = partial[key] && typeof partial[key] === "object" ? partial[key] : {};
      const merged = { ...cfg[key], ...incoming };
      const c = {
        mode: merged.mode === "fixed" ? "fixed" : "random",
        fixed: clamp(Math.round(num(merged.fixed, 1)), 0, limit),
        min: clamp(Math.round(num(merged.min, 0)), 0, limit),
        max: clamp(Math.round(num(merged.max, 4)), 0, limit),
      };
      if (c.min > c.max) [c.min, c.max] = [c.max, c.min];
      next[key] = c;
    }

    if (next.timingMode !== "fixed" && next.timingMode !== "manual") next.timingMode = "random";
    next.fixedSeconds = clamp(num(next.fixedSeconds, DEFAULT_CONFIG.fixedSeconds), 0.5, 60);
    next.randomMinSeconds = clamp(num(next.randomMinSeconds, DEFAULT_CONFIG.randomMinSeconds), 0.5, 60);
    next.randomMaxSeconds = clamp(num(next.randomMaxSeconds, DEFAULT_CONFIG.randomMaxSeconds), 0.5, 60);
    next.staggerMaxSeconds = clamp(num(next.staggerMaxSeconds, 2), 0, 10);
    if (next.syncMode !== "staggered") next.syncMode = "simultaneous";
    if (next.transition !== "random" && !TRANSITIONS.includes(next.transition)) {
      next.transition = DEFAULT_CONFIG.transition;
    }
    if (next.sound !== "on") next.sound = "off";
    if (next.manualAssign !== "pick") next.manualAssign = "random";
    next.manualPreCountdown = !!next.manualPreCountdown;
    next.colorCount = Number(next.colorCount) === 2 ? 2 : 3;

    this.data.config = next;
    // Timing mode changes while running must not leave a dead alarm / no alarm
    await this.applyTimingModeChange(prevTiming);
  }

  async start() {
    this.data.config.running = true;
    if (this.data.config.timingMode === "manual") {
      await this.ctx.storage.deleteAlarm();
      this.data.playPackage = null;
      this.data.packageIndex = 0;
      this.data.nextChangeAt = null;
      return;
    }
    await this.beginAutoPackage();
  }

  async stop() {
    await this.ctx.storage.deleteAlarm();
    this.data.config.running = false;
    this.data.playPackage = null;
    this.data.packageIndex = 0;
    this.data.nextChangeAt = null;
    this.data.transitionEndsAt = null;
    this.data.blackEndsAt = null;
  }

  async next(colors) {
    if (!this.data.config.running) this.data.config.running = true;
    const { timingMode, manualAssign } = this.data.config;
    const pending = timingMode === "manual" && manualAssign === "pick" ? colors || null : null;
    if (timingMode === "manual") {
      this.data.playPackage = null;
      this.data.packageIndex = 0;
      await this.assignRound(pending);
      return;
    }
    await this.beginAutoPackage();
  }

  maxStaggerMs() {
    return this.data.config.syncMode === "staggered"
      ? Math.max(0, (this.data.config.staggerMaxSeconds ?? 2) * 1000)
      : 0;
  }

  async applyTimingModeChange(prevTiming) {
    if (!this.data.config.running) return;
    if (this.data.config.timingMode === "manual") {
      await this.ctx.storage.deleteAlarm();
      this.data.playPackage = null;
      this.data.packageIndex = 0;
      this.data.nextChangeAt = null;
      return;
    }
    if (prevTiming === "manual" || !this.data.playPackage) {
      await this.beginAutoPackage();
    }
  }

  /* ---------- auto mode (playPackage + alarm) ---------- */

  async beginAutoPackage() {
    await this.ctx.storage.deleteAlarm();
    this.data.playPackage = this.buildPlayPackage(PACKAGE_ROUNDS);
    this.data.packageIndex = 0;
    const first = this.data.playPackage.rounds[0];
    if (first) this.applyPlayRound(first);
    await this.armPackage();
  }

  planOffsets(ids) {
    const maxStaggerMs = this.maxStaggerMs();
    const offsets = {};
    if (maxStaggerMs > 0 && ids.length > 1) {
      const order = shuffle(ids);
      for (let i = 0; i < order.length; i++) {
        offsets[order[i]] = Math.round((i / (order.length - 1)) * maxStaggerMs);
      }
    } else {
      for (const id of ids) offsets[id] = 0;
    }
    return offsets;
  }

  buildPlayPackage(count, opts = {}) {
    const ids = Object.keys(this.data.displays);
    let previous = { ...(opts.previous || {}) };
    if (!opts.previous) {
      for (const d of Object.values(this.data.displays)) previous[d.id] = d.color;
    }

    let t = opts.startAt ?? Date.now();
    let nextRoundId = opts.fromRoundId ?? this.data.roundId + 1;
    const rounds = [];

    for (let i = 0; i < count; i++) {
      const colors = this.assignColors(null);
      for (const id of ids) {
        if (!(id in colors)) colors[id] = previous[id] ?? "blue";
      }
      const transition = pickTransition(this.data.config);
      const offsets = this.planOffsets(ids);
      const lead = TRANSITION_LEAD_MS[transition] ?? 0;
      const interval = nextIntervalMs(this.data.config);
      const nextChangeAt = t + interval + this.maxStaggerMs() + lead + BLACK_GAP_MS + 200;
      rounds.push({
        roundId: nextRoundId++,
        colors,
        previousColors: { ...previous },
        deviceOffsets: offsets,
        colorCounts: { ...this.data.lastCounts },
        transition,
        roundStartedAt: t,
        nextChangeAt,
      });
      previous = colors;
      t = nextChangeAt;
    }
    return { rounds };
  }

  applyPlayRound(round) {
    const data = this.data;
    data.roundId = round.roundId;
    data.previousColors = { ...round.previousColors };
    data.deviceOffsets = { ...round.deviceOffsets };
    data.lastCounts = { ...round.colorCounts };
    data.transition = round.transition;
    data.roundStartedAt = round.roundStartedAt;
    const lead = TRANSITION_LEAD_MS[round.transition] ?? 0;
    data.transitionEndsAt = round.roundStartedAt + lead;
    data.blackEndsAt = round.roundStartedAt + lead + BLACK_GAP_MS;
    data.nextChangeAt = round.nextChangeAt;
    for (const [id, color] of Object.entries(round.colors)) {
      const d = data.displays[id];
      if (d) d.color = color;
    }
  }

  async armPackage() {
    await this.ctx.storage.deleteAlarm();
    const data = this.data;
    if (!data.config.running || data.config.timingMode === "manual" || !data.playPackage) {
      data.nextChangeAt = null;
      return;
    }
    const nextIndex = data.packageIndex + 1;
    if (nextIndex >= data.playPackage.rounds.length) {
      const last = data.playPackage.rounds[data.playPackage.rounds.length - 1];
      const more = this.buildPlayPackage(PACKAGE_ROUNDS, {
        fromRoundId: last.roundId + 1,
        startAt: last.nextChangeAt,
        previous: last.colors,
      });
      const kept = data.playPackage.rounds.slice(-2);
      data.playPackage = { rounds: [...kept, ...more.rounds] };
      data.packageIndex = Math.max(0, kept.length - 1);
    }
    const next = data.playPackage.rounds[data.packageIndex + 1];
    if (!next) return;
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next.roundStartedAt));
  }

  /* ---------- assignment ---------- */

  assignColors(pending) {
    const { config } = this.data;
    const ids = Object.keys(this.data.displays);

    if (config.timingMode === "manual" && config.manualAssign === "pick") {
      const allowed = new Set(activeColors(config));
      const result = {};
      const counts = zeroCounts();
      for (const id of ids) {
        const chosen = pending?.[id];
        const current = this.data.displays[id]?.color ?? "blue";
        const color = chosen && allowed.has(chosen) ? chosen : current;
        result[id] = color;
        counts[color] += 1;
      }
      this.data.lastCounts = counts;
      return result;
    }

    const shuffled = shuffle(ids);
    const n = ids.length;
    const counts = partitionCounts(config, n);
    this.data.lastCounts = counts;
    const result = {};
    let idx = 0;
    for (const color of activeColors(config)) {
      for (let i = 0; i < counts[color]; i++) {
        const id = shuffled[idx++];
        if (id) result[id] = color;
      }
    }
    return result;
  }

  /** Manual mode: package なしで 1 ラウンドだけ配る */
  async assignRound(pending) {
    await this.ctx.storage.deleteAlarm();
    const data = this.data;
    const previous = {};
    for (const d of Object.values(data.displays)) previous[d.id] = d.color;
    const colors = this.assignColors(pending);
    data.previousColors = previous;
    data.pendingReveal = null;
    data.manualCueEndsAt = null;

    if (data.config.manualPreCountdown) {
      // いまの色のまま 3→2→1 を出してから、新しい色へ切り替える
      data.transition = "countdown";
      data.pendingReveal = colors;
      const now = Date.now();
      data.roundStartedAt = now;
      data.manualCueEndsAt = now + 3000;
      data.nextChangeAt = data.manualCueEndsAt;
      data.transitionEndsAt = null;
      data.blackEndsAt = null;
      const offsets = {};
      for (const id of Object.keys(data.displays)) offsets[id] = 0;
      data.deviceOffsets = offsets;
      await this.ctx.storage.setAlarm(data.manualCueEndsAt);
      return;
    }

    this.applyRevealColors(colors, previous);
  }

  async revealManualRound() {
    const data = this.data;
    if (!data.pendingReveal) return;
    const colors = data.pendingReveal;
    const previous = { ...data.previousColors };
    data.pendingReveal = null;
    data.manualCueEndsAt = null;
    await this.ctx.storage.deleteAlarm();
    this.applyRevealColors(colors, previous);
  }

  applyRevealColors(colors, previous) {
    const data = this.data;
    data.roundId += 1;
    data.transition = pickTransition(data.config);
    data.previousColors = previous;

    for (const [id, color] of Object.entries(colors)) {
      const d = data.displays[id];
      if (d) d.color = color;
    }

    data.deviceOffsets = this.planOffsets(Object.keys(data.displays));

    const lead = TRANSITION_LEAD_MS[data.transition] ?? 0;
    const now = Date.now();
    data.roundStartedAt = now;
    data.transitionEndsAt = now + lead;
    data.blackEndsAt = now + lead + BLACK_GAP_MS;
    data.nextChangeAt = null;
    data.manualCueEndsAt = null;
  }

  /* ---------- snapshot / io ---------- */

  snapshot(exclude) {
    const data = this.data;
    const connected = this.connectedDisplayIds(exclude);
    const primaryColors = {};
    const displays = Object.values(data.displays).map((d) => {
      primaryColors[d.id] = d.color;
      return {
        id: d.id,
        label: d.label,
        color: d.color,
        connected: connected.has(d.id),
      };
    });
    return {
      code: data.code,
      config: data.config,
      displays,
      roundId: data.roundId,
      primaryColors,
      previousColors: { ...data.previousColors },
      deviceOffsets: { ...data.deviceOffsets },
      colorCounts: { ...data.lastCounts },
      roundStartedAt: data.roundStartedAt,
      nextChangeAt: data.nextChangeAt,
      transition: data.transition,
      transitionEndsAt: data.transitionEndsAt,
      blackEndsAt: data.blackEndsAt,
      playPackage:
        data.config.running && data.config.timingMode !== "manual" ? data.playPackage : null,
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

  broadcast(exclude) {
    const payload = JSON.stringify({ type: "snapshot", snapshot: this.snapshot(exclude) });
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
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
