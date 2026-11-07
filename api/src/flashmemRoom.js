/**
 * FlashMem 用ルーム Durable Object。
 * Hibernation WebSocket + alarm で flash → answer（openAnswers）へ進める。状態は storage に保存。
 * flash → answer → review。flash の窓は playPackage として端末へ配る。
 * flashmemTR/src/server/room.ts と src/lib/{types,deal}.ts の移植。
 */

export const FLASHMEM_APP_ID = "flashmem";

const TAP_GAP_MS = 120;
const MIN_PERIPHERALS = 2;
const MAX_PERIPHERALS = 6;
const MIN_FLASH = 0.1;
const MAX_FLASH = 1;

const DEFAULT_CONFIG = {
  level: "easy",
  flashSeconds: 0.5,
  centerNumber: false,
  split: false,
  running: false,
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* ---------- deal (lib/deal.ts) ---------- */

function shuffle(items, rng) {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = next[i];
    next[i] = next[j];
    next[j] = swap;
  }
  return next;
}

/** コントローラー（"center"）を含めるか、左右2分割かで、数字を置く枠を作る。 */
function buildSlots(ids, centerNumber, split) {
  const owners = [...(centerNumber ? ["center"] : []), ...ids];
  const halves = split ? ["left", "right"] : [null];
  return owners.flatMap((id) => halves.map((half) => ({ id, half })));
}

/**
 * 簡単は 1 からの連番をばらまく。
 * 難しいは 0〜99 の重複なし。1桁だけに偏ったときは2桁を1つ入れる。
 */
function dealValues(count, level, rng) {
  if (count <= 0) return [];
  if (level === "easy") {
    return shuffle(
      Array.from({ length: count }, (_, index) => index + 1),
      rng
    );
  }
  const picked = shuffle(
    Array.from({ length: 100 }, (_, index) => index),
    rng
  ).slice(0, count);
  if (picked.every((value) => value < 10)) {
    let two = 10 + Math.floor(rng() * 90);
    while (picked.includes(two)) two = 10 + ((two - 10 + 1) % 90);
    picked[0] = two;
  }
  return picked;
}

function deal(ids, centerNumber, split, level, rng) {
  const seeds = buildSlots(ids, centerNumber, split);
  const values = dealValues(seeds.length, level, rng);
  return seeds.map((seed, index) => ({
    ...seed,
    value: values[index] ?? index + 1,
    correct: null,
  }));
}

function samePlace(slot, id, half) {
  return slot.id === id && (slot.half ?? null) === (half ?? null);
}

/* ---------- room state ---------- */

function emptyState(code, app = FLASHMEM_APP_ID) {
  return {
    code,
    app,
    config: { ...DEFAULT_CONFIG },
    displays: {},
    phase: "idle",
    prompt: null,
    asked: 0,
    correct: 0,
    flashStartedAt: null,
    flashEndsAt: null,
    playPackage: null,
    finishedAt: null,
    slots: [],
    order: [],
    promptIndex: 0,
    lastTapAt: 0,
    lastActivity: Date.now(),
  };
}

export class FlashMemRoom {
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
      const app = String(body.app || FLASHMEM_APP_ID);
      if (!code) return Response.json({ error: "code_required" }, { status: 400 });
      if (app !== FLASHMEM_APP_ID) {
        return Response.json({ error: "unsupported_app" }, { status: 400 });
      }
      if (!this.data.code) {
        this.data = emptyState(code, app);
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
        const added = this.addDisplay(deviceId, label);
        if (!added.ok) {
          this.sendTo(server, { type: "error", message: added.error });
          server.close(1008, "full");
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
        const added = this.addDisplay(String(msg.deviceId), msg.label);
        if (!added.ok) {
          this.sendTo(ws, { type: "error", message: added.error });
          return;
        }
        ws.serializeAttachment({
          role: "display",
          deviceId: String(msg.deviceId),
          label: msg.label || "",
        });
        await this.persist();
        this.broadcast();
      } else {
        this.sendTo(ws, { type: "snapshot", snapshot: this.snapshot() });
      }
      return;
    }
    if (msg.type === "tap") {
      // 端末は自分の deviceId でしか押せない。コントローラは "center"（中央の数字）として押す。
      const deviceId = meta.role === "display" ? meta.deviceId : String(msg.deviceId || "");
      const half = msg.half === "left" || msg.half === "right" ? msg.half : null;
      if (this.tap(deviceId, half)) {
        await this.persist();
        this.broadcast();
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
      await this.start();
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
      // 同じ端末が再接続していたら、古いソケットの切断では落とさない
      if (!this.hasOpenDisplaySocket(meta.deviceId, ws)) {
        this.data.displays[meta.deviceId].connected = false;
        await this.persist();
        this.broadcast();
      }
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    await this.ready;
    if (this.data.phase !== "flash") return;
    await this.openAnswers();
    this.broadcast();
  }

  /* ---------- displays / config ---------- */

  addDisplay(deviceId, label) {
    const existing = this.data.displays[deviceId];
    if (existing) {
      existing.connected = true;
      if (label) existing.label = String(label).slice(0, 24);
      return { ok: true };
    }
    const count = Object.keys(this.data.displays).length;
    if (count >= MAX_PERIPHERALS) {
      return { ok: false, error: "周囲の端末は6台までです" };
    }
    const place = count + 1;
    this.data.displays[deviceId] = {
      id: deviceId,
      label: label ? String(label).slice(0, 24) : `No.${place}`,
      place,
      connected: true,
    };
    return { ok: true };
  }

  hasOpenDisplaySocket(deviceId, except) {
    return this.ctx.getWebSockets().some((ws) => {
      if (ws === except) return false;
      if (ws.readyState !== undefined && ws.readyState !== 1) return false;
      const meta = ws.deserializeAttachment() || {};
      return meta.role === "display" && meta.deviceId === deviceId;
    });
  }

  updateConfig(partial) {
    const cur = this.data.config;
    if (cur.running) return;
    const next = { ...cur, running: false };
    if (partial.level != null) next.level = partial.level;
    if (partial.flashSeconds != null) {
      next.flashSeconds = num(partial.flashSeconds, cur.flashSeconds);
    }
    if (partial.centerNumber != null) next.centerNumber = partial.centerNumber;
    if (partial.split != null) next.split = partial.split;
    next.level = next.level === "hard" ? "hard" : "easy";
    next.flashSeconds = clamp(Math.round(next.flashSeconds * 10) / 10, MIN_FLASH, MAX_FLASH);
    next.centerNumber = !!next.centerNumber;
    next.split = !!next.split;
    this.data.config = next;
  }

  controllersOpen() {
    return this.ctx.getWebSockets().filter((ws) => {
      const meta = ws.deserializeAttachment() || {};
      return meta.role === "controller";
    });
  }

  liveIds() {
    return Object.values(this.data.displays)
      .filter((d) => d.connected)
      .map((d) => d.id);
  }

  /* ---------- run control ---------- */

  async start() {
    const d = this.data;
    const ids = this.liveIds();
    if (
      this.controllersOpen().length < 1 ||
      ids.length < MIN_PERIPHERALS ||
      Object.keys(d.displays).length > MAX_PERIPHERALS
    ) {
      return false;
    }
    await this.ctx.storage.deleteAlarm();

    d.slots = deal(ids, d.config.centerNumber, d.config.split, d.config.level, Math.random);
    d.order = shuffle(
      d.slots.map((_, index) => index),
      Math.random
    );
    d.promptIndex = 0;
    d.prompt = null;
    d.asked = 0;
    d.correct = 0;
    d.finishedAt = null;
    d.lastTapAt = 0;
    d.phase = "flash";
    d.config.running = true;
    d.flashStartedAt = Date.now();
    d.flashEndsAt = d.flashStartedAt + Math.round(d.config.flashSeconds * 1000);
    d.playPackage = {
      flashStartedAt: d.flashStartedAt,
      flashEndsAt: d.flashEndsAt,
    };
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, d.flashEndsAt));
    await this.persist();
    return true;
  }

  async stop() {
    await this.ctx.storage.deleteAlarm();
    const d = this.data;
    d.config.running = false;
    d.phase = "idle";
    d.slots = [];
    d.order = [];
    d.prompt = null;
    d.promptIndex = 0;
    d.asked = 0;
    d.correct = 0;
    d.flashStartedAt = null;
    d.flashEndsAt = null;
    d.playPackage = null;
    d.finishedAt = null;
    await this.persist();
  }

  /** flash の窓が閉じたら、数字を伏せて問題を出し始める。 */
  async openAnswers() {
    const d = this.data;
    if (d.phase !== "flash") return;
    d.phase = "answer";
    d.prompt = d.slots[d.order[0]]?.value ?? null;
    await this.persist();
  }

  /** @returns {boolean} 状態が変わったか */
  tap(deviceId, half) {
    const d = this.data;
    if (d.phase !== "answer" || !deviceId) return false;
    const now = Date.now();
    if (now - d.lastTapAt < TAP_GAP_MS) return false;
    const slot = d.slots[d.order[d.promptIndex]];
    if (!slot) return false;
    d.lastTapAt = now;
    const hit = samePlace(slot, deviceId, half);
    slot.correct = hit;
    if (hit) d.correct += 1;
    d.asked += 1;
    d.promptIndex += 1;
    if (d.promptIndex >= d.order.length) {
      d.phase = "review";
      d.config.running = false;
      d.finishedAt = Date.now();
      d.prompt = null;
    } else {
      d.prompt = d.slots[d.order[d.promptIndex]]?.value ?? null;
    }
    return true;
  }

  /* ---------- snapshot / broadcast ---------- */

  snapshot() {
    const d = this.data;
    const displays = Object.values(d.displays).map((disp) => ({
      id: disp.id,
      label: disp.label,
      place: disp.place,
      connected: !!disp.connected,
    }));
    // 答える間は、どこに何があったか分からないよう数値を配らない
    const hideValues = d.phase === "answer";
    const slots = d.slots.map((slot) => ({
      id: slot.id,
      half: slot.half,
      value: hideValues ? null : slot.value,
      correct: slot.correct,
    }));
    return {
      code: d.code,
      config: d.config,
      displays,
      phase: d.phase,
      slots,
      prompt: d.prompt,
      asked: d.asked,
      questionTotal: d.slots.length,
      correct: d.correct,
      flashStartedAt: d.flashStartedAt,
      flashEndsAt: d.flashEndsAt,
      finishedAt: d.finishedAt,
      playPackage: d.phase === "flash" ? d.playPackage : null,
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
