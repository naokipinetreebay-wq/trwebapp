/**
 * Peritap 用ルーム Durable Object。
 * ローカル化: 出題パッケージ・採点はコントローラが hostPush する。
 * DO は参加管理と薄い中継（tap → clientEvent）。旧 alarm 進行は localHost 時は使わない。
 */

export const PERI_APP_ID = "peritap";

/** 数字が消えたあとも、見ていたコマへのタップを受け付ける。通信の遅れ分。 */
const TAP_GRACE_MS = 1200;
const COUNTDOWN_FROM = 3;
const COUNTDOWN_MS = 1000;

const QUESTION_TOTAL = 10;
/** 正当が来ない連続は4回まで。5回連続では出さない。 */
const MAX_DRY_SPELL = 4;
const MIN_PERIPHERALS = 2;
const MAX_PERIPHERALS = 6;
const MIN_DURATION = 20;
const MAX_DURATION = 45;
const MIN_INTERVAL = 0.5;
const MAX_INTERVAL = 3;

const DEFAULT_CONFIG = {
  level: "easy",
  intervalSeconds: 1,
  durationSeconds: 30,
  running: false,
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* ---------- frames (lib/frames.ts) ---------- */

function randomDigit(rng, except) {
  if (except == null) return Math.floor(rng() * 10);
  const n = Math.floor(rng() * 9);
  return n >= except ? n + 1 : n;
}

function pickIndexes(count, take, rng) {
  const bag = Array.from({ length: count }, (_, i) => i);
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = bag[i];
    bag[i] = bag[j];
    bag[j] = tmp;
  }
  return bag.slice(0, Math.min(take, bag.length));
}

function assignDigits(ids, center, rng, match) {
  const digits = {};
  const matchAt = match ? ids[Math.floor(rng() * ids.length)] : null;
  for (const id of ids) {
    digits[id] = id === matchAt ? center : randomDigit(rng, center);
  }
  return digits;
}

function validMask(rounds, rng) {
  const total = clamp(rounds, QUESTION_TOTAL, QUESTION_TOTAL * (MAX_DRY_SPELL + 1));
  const buckets = new Array(QUESTION_TOTAL).fill(0);
  let left = total - QUESTION_TOTAL;
  let guard = 0;
  while (left > 0 && guard < 10000) {
    guard += 1;
    const open = [];
    buckets.forEach((count, index) => {
      if (count < MAX_DRY_SPELL) open.push(index);
    });
    if (open.length === 0) break;
    buckets[open[Math.floor(rng() * open.length)]] += 1;
    left -= 1;
  }
  const mask = [];
  for (const duds of buckets) {
    for (let i = 0; i < duds; i++) mask.push(false);
    mask.push(true);
  }
  return mask;
}

/**
 * ハズレを混ぜ、押せる問題（緑で同じ数字が1台ある）はちょうど10。
 * 最後のコマは必ず正当。正当が来ない連続は4回まで。
 */
function buildFrames(ids, rounds, hard, rng = Math.random) {
  const mask = validMask(rounds, rng);
  const dudIndexes = mask.flatMap((scored, index) => (scored ? [] : [index]));
  const emptyCount = hard
    ? Math.min(
        dudIndexes.length,
        Math.max(dudIndexes.length >= 4 ? 2 : 0, Math.floor(dudIndexes.length * 0.4))
      )
    : 0;
  const empty = new Set(
    pickIndexes(dudIndexes.length, emptyCount, rng).map((index) => dudIndexes[index])
  );

  return mask.map((scored, index) => {
    const center = randomDigit(rng);
    const emptyFrame = empty.has(index);
    return {
      cue: scored || emptyFrame ? "green" : "red",
      center,
      digits: assignDigits(ids, center, rng, !emptyFrame),
      scored,
    };
  });
}

function judgeTap(frame, deviceId) {
  if (frame.scored && frame.digits[deviceId] === frame.center) return "correct";
  return "wrong";
}

/** 設定秒数に近づけつつ、正当10回とハズレを収めるコマ数。 */
function plannedRounds(durationSeconds, intervalSeconds) {
  const intervalMs = Math.round(intervalSeconds * 1000);
  const maxRounds = QUESTION_TOTAL * (MAX_DRY_SPELL + 1);
  if (intervalMs <= 0) return QUESTION_TOTAL;
  const wanted = Math.round((durationSeconds * 1000) / intervalMs);
  return clamp(wanted, QUESTION_TOTAL, maxRounds);
}

/* ---------- room state ---------- */

function emptyState(code, app = PERI_APP_ID) {
  return {
    code,
    app,
    config: { ...DEFAULT_CONFIG },
    displays: {},
    cue: null,
    centerDigit: null,
    scored: false,
    correct: 0,
    wrong: 0,
    miss: 0,
    asked: 0,
    frameStartedAt: null,
    startedAt: null,
    endsAt: null,
    finishedAt: null,
    countdown: null,
    playPackage: null,
    frameIndex: -1,
    runIntervalMs: 1000,
    digits: {},
    judged: true,
    tappedFrames: [],
    missedFrames: [],
    localHost: true,
    hostOverlay: null,
    lastActivity: Date.now(),
  };
}

export class PeriRoom {
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
      const app = String(body.app || PERI_APP_ID);
      if (!code) return Response.json({ error: "code_required" }, { status: 400 });
      if (app !== PERI_APP_ID) {
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
      // 端末は自分の deviceId でしか押せない。
      const deviceId = meta.role === "display" ? meta.deviceId : String(msg.deviceId || "");
      if (!deviceId) return;
      if (this.data.localHost) {
        this.relayClientEvent({
          type: "clientEvent",
          event: "tap",
          deviceId,
          frameStartedAt: msg.frameStartedAt ?? null,
        });
        return;
      }
      if (this.tap(deviceId, msg.frameStartedAt ?? null)) {
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
      await this.start(msg.local !== false);
      this.broadcast();
      return;
    }
    if (msg.type === "stop") {
      await this.stop();
      this.broadcast();
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
    // ローカル化: 進行・採点はコントローラ側。DO alarm では進めない。
    if (this.data.localHost) return;
    if (!this.data.config.running || !this.data.playPackage) return;
    if (this.data.countdown != null) {
      await this.countdownTick();
    } else {
      await this.advance();
    }
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
    const next = { ...cur, running: cur.running };
    if (partial.level != null) next.level = partial.level;
    if (partial.intervalSeconds != null) {
      next.intervalSeconds = num(partial.intervalSeconds, cur.intervalSeconds);
    }
    if (partial.durationSeconds != null) {
      next.durationSeconds = num(partial.durationSeconds, cur.durationSeconds);
    }
    next.level = next.level === "hard" ? "hard" : "easy";
    next.intervalSeconds = clamp(
      Math.round(next.intervalSeconds * 10) / 10,
      MIN_INTERVAL,
      MAX_INTERVAL
    );
    next.durationSeconds = clamp(Math.round(next.durationSeconds), MIN_DURATION, MAX_DURATION);
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

  frames() {
    return this.data.playPackage?.frames || [];
  }

  intervalMs() {
    return this.data.runIntervalMs;
  }

  async start(local = true) {
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

    d.localHost = local !== false;
    d.hostOverlay = null;
    d.frameIndex = -1;
    d.correct = 0;
    d.wrong = 0;
    d.miss = 0;
    d.asked = 0;
    d.tappedFrames = [];
    d.missedFrames = [];
    d.endsAt = null;
    d.finishedAt = null;
    d.startedAt = null;
    d.frameStartedAt = null;
    d.cue = null;
    d.centerDigit = null;
    d.scored = false;
    d.digits = {};
    d.judged = true;
    d.config.running = true;
    d.playPackage = null;
    d.countdown = null;
    d.runIntervalMs = Math.round(d.config.intervalSeconds * 1000);

    // パッケージはコントローラが hostPush する
    if (d.localHost) {
      await this.persist();
      return true;
    }

    const rounds = plannedRounds(d.config.durationSeconds, d.config.intervalSeconds);
    const frames = buildFrames(ids, rounds, d.config.level === "hard", Math.random);
    d.countdown = COUNTDOWN_FROM;

    const countdownStartedAt = Date.now();
    d.playPackage = {
      intervalMs: d.runIntervalMs,
      countdownMs: COUNTDOWN_MS,
      countdownFrom: COUNTDOWN_FROM,
      countdownStartedAt,
      playStartedAt: countdownStartedAt + COUNTDOWN_FROM * COUNTDOWN_MS,
      frames: frames.map((frame) => ({
        cue: frame.cue,
        center: frame.center,
        digits: { ...frame.digits },
        scored: frame.scored,
      })),
    };
    await this.armCountdown();
    await this.persist();
    return true;
  }

  async stop() {
    await this.ctx.storage.deleteAlarm();
    const d = this.data;
    // 結果表示用に host の最終スコアを data へ残す
    const host = d.hostOverlay;
    if (host) {
      if (host.correct != null) d.correct = host.correct;
      if (host.wrong != null) d.wrong = host.wrong;
      if (host.miss != null) d.miss = host.miss;
      if (host.asked != null) d.asked = host.asked;
      if (host.finishedAt != null) d.finishedAt = host.finishedAt;
      if (host.startedAt != null) d.startedAt = host.startedAt;
      if (host.endsAt != null) d.endsAt = host.endsAt;
    }
    d.config.running = false;
    d.countdown = null;
    d.playPackage = null;
    d.hostOverlay = null;
    d.cue = null;
    d.centerDigit = null;
    d.scored = false;
    d.digits = {};
    d.frameIndex = -1;
    d.frameStartedAt = null;
    d.tappedFrames = [];
    d.missedFrames = [];
    d.judged = true;
    await this.persist();
  }

  applyHostPush(overlay) {
    const d = this.data;
    d.hostOverlay = { ...(d.hostOverlay || {}), ...overlay };
    if (overlay.playPackage !== undefined) d.playPackage = overlay.playPackage;
    if (overlay.correct != null) d.correct = overlay.correct;
    if (overlay.wrong != null) d.wrong = overlay.wrong;
    if (overlay.miss != null) d.miss = overlay.miss;
    if (overlay.asked != null) d.asked = overlay.asked;
    if (overlay.startedAt !== undefined) d.startedAt = overlay.startedAt;
    if (overlay.endsAt !== undefined) d.endsAt = overlay.endsAt;
    if (overlay.finishedAt != null) {
      d.finishedAt = overlay.finishedAt;
      d.config.running = false;
      d.countdown = null;
      d.playPackage = null;
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

  /** 次のカウントダウン拍（3→2→1→開始）の時刻にアラームを置く。 */
  async armCountdown() {
    const pkg = this.data.playPackage;
    if (!pkg || this.data.countdown == null) return;
    const step = COUNTDOWN_FROM - this.data.countdown + 1;
    const at = pkg.countdownStartedAt + step * pkg.countdownMs;
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, at));
  }

  async countdownTick() {
    const d = this.data;
    if (d.countdown == null) return;
    if (d.countdown <= 1) {
      await this.beginProblems();
      return;
    }
    d.countdown -= 1;
    await this.armCountdown();
    await this.persist();
    this.broadcast();
  }

  async beginProblems() {
    const d = this.data;
    d.countdown = null;
    // パッケージに書いた開始時刻に合わせ、端末側再生とサーバ採点の基準を揃える
    d.startedAt = d.playPackage?.playStartedAt ?? Date.now();
    d.endsAt = d.startedAt + this.frames().length * this.intervalMs();
    await this.showFrame(0);
  }

  async showFrame(index) {
    const d = this.data;
    const frame = this.frames()[index];
    if (!frame || d.startedAt == null) {
      await this.finish();
      this.broadcast();
      return;
    }
    d.frameIndex = index;
    d.judged = false;
    d.cue = frame.cue;
    d.centerDigit = frame.center;
    d.scored = frame.scored;
    d.digits = frame.digits;
    d.frameStartedAt = d.startedAt + index * this.intervalMs();
    await this.ctx.storage.setAlarm(
      Math.max(Date.now() + 1, d.frameStartedAt + this.intervalMs())
    );
    await this.persist();
    this.broadcast();
  }

  async advance() {
    this.resolveOpenFrame();
    if (this.data.frameIndex + 1 >= this.frames().length) {
      await this.finish();
      this.broadcast();
      return;
    }
    await this.showFrame(this.data.frameIndex + 1);
  }

  resolveOpenFrame() {
    const d = this.data;
    if (d.judged || d.tappedFrames.includes(d.frameIndex)) return;
    const frame = this.frames()[d.frameIndex];
    if (frame?.scored) {
      d.miss += 1;
      d.asked += 1;
      if (!d.missedFrames.includes(d.frameIndex)) d.missedFrames.push(d.frameIndex);
    }
    d.judged = true;
  }

  async finish() {
    await this.ctx.storage.deleteAlarm();
    const d = this.data;
    d.config.running = false;
    d.countdown = null;
    d.playPackage = null;
    d.finishedAt = Date.now();
    d.cue = null;
    d.centerDigit = null;
    d.scored = false;
    d.digits = {};
    d.frameStartedAt = null;
    await this.persist();
  }

  /* ---------- tap scoring ---------- */

  /** @returns {boolean} 状態が変わったか */
  tap(deviceId, seenAt, now = Date.now()) {
    const d = this.data;
    if (!deviceId) return false;
    if (!d.config.running || d.countdown != null || d.startedAt == null) return false;
    const index = this.indexForSeen(seenAt);
    if (index == null || d.tappedFrames.includes(index)) return false;
    const frame = this.frames()[index];
    if (!frame || frame.digits[deviceId] == null) return false;
    const start = d.startedAt + index * this.intervalMs();
    if (now > start + this.intervalMs() + TAP_GRACE_MS) return false;

    const missedAt = d.missedFrames.indexOf(index);
    if (missedAt >= 0) {
      d.missedFrames.splice(missedAt, 1);
      d.miss = Math.max(0, d.miss - 1);
      d.asked = Math.max(0, d.asked - 1);
    }
    const judgement = judgeTap(frame, deviceId);
    if (judgement === "correct") d.correct += 1;
    else d.wrong += 1;
    if (frame.scored) d.asked += 1;
    d.tappedFrames.push(index);
    if (index === d.frameIndex) d.judged = true;
    return true;
  }

  indexForSeen(seenAt) {
    const d = this.data;
    if (d.startedAt == null || d.frameIndex < 0) return null;
    if (seenAt == null) return d.judged ? null : d.frameIndex;
    const interval = this.intervalMs();
    if (interval <= 0) return d.judged ? null : d.frameIndex;
    const index = Math.round((seenAt - d.startedAt) / interval);
    const start = d.startedAt + index * interval;
    if (index < 0 || index >= this.frames().length || start !== seenAt) {
      return d.judged ? null : d.frameIndex;
    }
    return index;
  }

  /* ---------- snapshot / broadcast ---------- */

  snapshot() {
    const d = this.data;
    const host = d.hostOverlay || null;
    const running = d.config.running;
    const digits = host?.digits ? { ...d.digits, ...host.digits } : d.digits;
    const displays = Object.values(d.displays).map((disp) => ({
      id: disp.id,
      label: disp.label,
      place: disp.place,
      digit: running ? digits[disp.id] ?? null : null,
      connected: !!disp.connected,
    }));
    const playPackage =
      running
        ? host?.playPackage !== undefined
          ? host.playPackage
          : d.playPackage
        : null;
    return {
      code: d.code,
      config: d.config,
      displays,
      cue: running ? (host?.cue ?? d.cue) : null,
      centerDigit: running ? (host?.centerDigit ?? d.centerDigit) : null,
      scored: running ? (host?.scored ?? d.scored) : false,
      correct: host?.correct ?? d.correct,
      wrong: host?.wrong ?? d.wrong,
      miss: host?.miss ?? d.miss,
      asked: host?.asked ?? d.asked,
      questionTotal: QUESTION_TOTAL,
      endsAt: host?.endsAt ?? d.endsAt,
      frameStartedAt: host?.frameStartedAt ?? d.frameStartedAt,
      startedAt: host?.startedAt ?? d.startedAt,
      finishedAt: host?.finishedAt ?? d.finishedAt,
      countdown: running ? (host?.countdown ?? d.countdown) : null,
      playPackage,
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
