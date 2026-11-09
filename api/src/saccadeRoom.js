/**
 * Saccade 用ルーム Durable Object。
 * ローカル化: プレー進行・パッケージはコントローラが hostPush する。
 * DO は参加管理と薄い中継。旧 alarm 自動進行は localHost 時は使わない。
 * saccadeTR/src/server/room.ts と src/lib/{types,motion,placement}.ts の移植。
 */

export const SACCADE_APP_ID = "saccade";

/** adjust（調整）モードの1パッケージあたりの位相数。足りなくなったら継ぎ足す。 */
const ADJUST_PHASES = 48;
const TRAIN_MAX_PHASES = 500;

const MIN_PERIPHERALS = 2;
const MAX_PERIPHERALS = 6;
const MIN_GAP = 1;
const MAX_GAP = 5;
const MIN_CENTER = 1;
const MAX_CENTER = 6;
const MIN_PERIPHERAL_TRAVEL = 2;
const MAX_PERIPHERAL_TRAVEL = 10;

const SPEED_PRESETS = {
  normal: { centerSeconds: 3, peripheralSeconds: 5 },
  fast: { centerSeconds: 2, peripheralSeconds: 3.5 },
};

const DEFAULT_CONFIG = {
  durationSeconds: 20,
  speed: "normal",
  centerSeconds: 3,
  peripheralSeconds: 5,
  gapSeconds: 2,
  running: false,
  mode: "idle",
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function snapStep(n, min, max, step) {
  const snapped = Math.round(n / step) * step;
  return clamp(Number(snapped.toFixed(2)), min, max);
}

function matchPreset(centerSeconds, peripheralSeconds) {
  if (
    centerSeconds === SPEED_PRESETS.normal.centerSeconds &&
    peripheralSeconds === SPEED_PRESETS.normal.peripheralSeconds
  ) {
    return "normal";
  }
  if (
    centerSeconds === SPEED_PRESETS.fast.centerSeconds &&
    peripheralSeconds === SPEED_PRESETS.fast.peripheralSeconds
  ) {
    return "fast";
  }
  return "custom";
}

/* ---------- motion (lib/motion.ts) ---------- */

function nextBeat(phase, bound) {
  if (phase === "center") return { phase: "gap", bound: "out" };
  if (phase === "gap" && bound === "out") return { phase: "peripheral", bound: "out" };
  if (phase === "peripheral") return { phase: "gap", bound: "back" };
  return { phase: "center", bound: "out" };
}

/** 直前の端末以外から次を選ぶ。1台しかないときは同じ端末でよい。 */
function pickTarget(ids, previous, rng) {
  const pool = previous ? ids.filter((id) => id !== previous) : ids;
  const choices = pool.length > 0 ? pool : ids;
  const index = Math.min(choices.length - 1, Math.floor(rng() * choices.length));
  return choices[Math.max(0, index)];
}

/** 調整モード: place 順（device1 → device2 → …）で外周を一周。 */
function pickSequential(ids, previous) {
  if (!ids.length) return null;
  if (!previous) return ids[0];
  const idx = ids.indexOf(previous);
  return ids[(idx < 0 ? 0 : idx + 1) % ids.length];
}

/* ---------- placement (lib/placement.ts)。12時を0度、時計回り ---------- */

const FIXED_ANGLES = {
  2: [270, 90],
  3: [300, 60, 180],
  4: [300, 240, 120, 60],
};

function polygonAngles(count) {
  return Array.from({ length: count }, (_, i) => {
    const ccw = (360 / count) * i;
    return (360 - ccw) % 360;
  });
}

/** 周囲の台数に対する置き場所。No.1 から順。コントローラは真ん中で含めない。 */
function placementsFor(count) {
  const n = Math.max(0, Math.min(6, count));
  if (n === 0) return [];
  const raw = FIXED_ANGLES[n] ?? polygonAngles(n);
  return raw.slice(0, n).map((angle, i) => ({ no: i + 1, angle }));
}

/* ---------- room state ---------- */

function emptyState(code, app = SACCADE_APP_ID) {
  return {
    code,
    app,
    config: { ...DEFAULT_CONFIG },
    displays: {},
    startedAt: null,
    endsAt: null,
    finishedAt: null,
    playPackage: null,
    packageIndex: 0,
    phase: "center",
    bound: "out",
    phaseStartedAt: null,
    phaseDurationMs: 1000,
    fromAngle: 0,
    toAngle: 0,
    targetId: null,
    localHost: true,
    hostOverlay: null,
    lastActivity: Date.now(),
  };
}

export class SaccadeRoom {
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
      const app = String(body.app || SACCADE_APP_ID);
      if (!code) return Response.json({ error: "code_required" }, { status: 400 });
      if (app !== SACCADE_APP_ID) {
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
      await this.start(msg.mode, msg.local !== false);
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
      if (meta.role !== "controller") return;
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

  /** 次の位相へ進める。次が無ければ（train の終了時刻）終了する。 */
  async alarm() {
    await this.ready;
    // ローカル化: 進行はコントローラ側。DO alarm では進めない。
    if (this.data.localHost) return;
    const d = this.data;
    if (!d.config.running || !d.playPackage) return;
    const frame = d.playPackage.phases[d.packageIndex + 1];
    if (!frame) {
      await this.finish();
      this.broadcast();
      return;
    }
    d.packageIndex += 1;
    this.applyPhase(frame);
    await this.armPackage();
    await this.persist();
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
    // train 中は変更しない（adjust 中は調整のため変更できる）
    if (cur.running && cur.mode === "train") return;

    const next = { ...cur, running: cur.running, mode: cur.mode };
    if (partial.speed === "normal" || partial.speed === "fast") {
      next.centerSeconds = SPEED_PRESETS[partial.speed].centerSeconds;
      next.peripheralSeconds = SPEED_PRESETS[partial.speed].peripheralSeconds;
    }
    if (partial.centerSeconds != null) {
      next.centerSeconds = snapStep(
        num(partial.centerSeconds, cur.centerSeconds),
        MIN_CENTER,
        MAX_CENTER,
        0.5
      );
    }
    if (partial.peripheralSeconds != null) {
      next.peripheralSeconds = snapStep(
        num(partial.peripheralSeconds, cur.peripheralSeconds),
        MIN_PERIPHERAL_TRAVEL,
        MAX_PERIPHERAL_TRAVEL,
        0.5
      );
    }
    if (partial.gapSeconds != null) {
      next.gapSeconds = snapStep(
        num(partial.gapSeconds, cur.gapSeconds),
        MIN_GAP,
        MAX_GAP,
        0.5
      );
    }
    if (partial.durationSeconds != null) {
      next.durationSeconds = num(partial.durationSeconds, cur.durationSeconds) >= 25 ? 30 : 20;
    }
    next.centerSeconds = snapStep(next.centerSeconds, MIN_CENTER, MAX_CENTER, 0.5);
    next.peripheralSeconds = snapStep(
      next.peripheralSeconds,
      MIN_PERIPHERAL_TRAVEL,
      MAX_PERIPHERAL_TRAVEL,
      0.5
    );
    next.gapSeconds = snapStep(next.gapSeconds, MIN_GAP, MAX_GAP, 0.5);
    next.speed = matchPreset(next.centerSeconds, next.peripheralSeconds);
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
      .sort((a, b) => a.place - b.place)
      .map((d) => d.id);
  }

  angleOf(id) {
    const display = this.data.displays[id];
    if (!display) return 0;
    const slots = placementsFor(Object.keys(this.data.displays).length);
    return slots.find((slot) => slot.no === display.place)?.angle ?? 0;
  }

  /* ---------- run control ---------- */

  async start(mode = "train", local = true) {
    const d = this.data;
    const ids = this.liveIds();
    const runMode = mode === "adjust" ? "adjust" : "train";
    if (
      this.controllersOpen().length < 1 ||
      ids.length < MIN_PERIPHERALS ||
      Object.keys(d.displays).length > MAX_PERIPHERALS
    ) {
      return false;
    }
    await this.ctx.storage.deleteAlarm();

    const now = Date.now();
    d.config.running = true;
    d.config.mode = runMode;
    d.localHost = local !== false;
    d.startedAt = now;
    d.endsAt = runMode === "train" ? now + d.config.durationSeconds * 1000 : null;
    d.finishedAt = null;
    d.bound = "out";
    d.packageIndex = 0;
    d.hostOverlay = null;
    d.playPackage = null;
    d.phaseStartedAt = null;
    d.targetId = null;

    // パッケージはコントローラが hostPush する
    if (!d.localHost) {
      d.playPackage = this.buildPlayPackage(ids, now, d.endsAt, runMode);
      const first = d.playPackage.phases[0];
      if (!first) {
        await this.finish();
        return false;
      }
      this.applyPhase(first);
      await this.armPackage();
    }
    await this.persist();
    return true;
  }

  async stop() {
    await this.ctx.storage.deleteAlarm();
    const d = this.data;
    const host = d.hostOverlay;
    if (host?.finishedAt != null) d.finishedAt = host.finishedAt;
    else d.finishedAt = null;
    d.config.running = false;
    d.config.mode = "idle";
    d.phaseStartedAt = null;
    d.targetId = null;
    d.playPackage = null;
    d.packageIndex = 0;
    d.hostOverlay = null;
    await this.persist();
  }

  applyHostPush(overlay) {
    const d = this.data;
    d.hostOverlay = { ...(d.hostOverlay || {}), ...overlay };
    if (overlay.playPackage !== undefined) d.playPackage = overlay.playPackage;
    if (overlay.phase !== undefined) d.phase = overlay.phase;
    if (overlay.phaseStartedAt !== undefined) d.phaseStartedAt = overlay.phaseStartedAt;
    if (overlay.phaseDurationMs != null) d.phaseDurationMs = overlay.phaseDurationMs;
    if (overlay.fromAngle != null) d.fromAngle = overlay.fromAngle;
    if (overlay.toAngle != null) d.toAngle = overlay.toAngle;
    if (overlay.targetId !== undefined) d.targetId = overlay.targetId;
    if (overlay.startedAt !== undefined) d.startedAt = overlay.startedAt;
    if (overlay.endsAt !== undefined) d.endsAt = overlay.endsAt;
    if (overlay.finishedAt != null) {
      d.finishedAt = overlay.finishedAt;
      d.config.running = false;
      d.config.mode = "idle";
      d.playPackage = null;
      d.phaseStartedAt = null;
      d.targetId = null;
    }
    d.lastActivity = Date.now();
  }

  durationFor(phase) {
    const c = this.data.config;
    const seconds =
      phase === "center"
        ? c.centerSeconds
        : phase === "peripheral"
          ? c.peripheralSeconds
          : c.gapSeconds;
    return Math.max(200, Math.round(seconds * 1000));
  }

  buildPlayPackage(ids, startAt, endsAt, runMode = "train") {
    const rng = Math.random;
    const phases = [];
    let phase = "center";
    let bound = "out";
    let at = startAt;
    let targetId =
      runMode === "adjust" ? pickSequential(ids, null) : pickTarget(ids, null, rng);
    let toAngle = this.angleOf(targetId);
    let fromAngle = (toAngle + 180) % 360;
    let previous = null;

    const maxPhases = endsAt != null ? TRAIN_MAX_PHASES : ADJUST_PHASES;
    while (phases.length < maxPhases) {
      if (endsAt != null && at >= endsAt) break;
      const phaseDurationMs = this.durationFor(phase);
      phases.push({
        phase,
        phaseStartedAt: at,
        phaseDurationMs,
        fromAngle,
        toAngle,
        targetId: phase === "peripheral" || phase === "center" ? targetId : null,
      });
      at += phaseDurationMs;
      if (endsAt != null && at >= endsAt) break;
      const next = nextBeat(phase, bound);
      bound = next.bound;
      phase = next.phase;
      if (phase === "center") {
        previous = targetId;
        targetId =
          runMode === "adjust"
            ? pickSequential(ids, previous)
            : pickTarget(ids, previous, rng);
        fromAngle = previous ? this.angleOf(previous) : toAngle;
        toAngle = this.angleOf(targetId);
      }
    }
    return { endsAt, phases };
  }

  applyPhase(frame) {
    const d = this.data;
    d.phase = frame.phase;
    d.phaseStartedAt = frame.phaseStartedAt;
    d.phaseDurationMs = frame.phaseDurationMs;
    d.fromAngle = frame.fromAngle;
    d.toAngle = frame.toAngle;
    d.targetId = frame.targetId;
  }

  /**
   * 次の位相の開始時刻にアラームを置く。
   * 最後の位相のあとは、train なら endsAt、adjust ならパッケージを継ぎ足す。
   */
  async armPackage() {
    const d = this.data;
    await this.ctx.storage.deleteAlarm();
    if (!d.config.running || !d.playPackage) return;

    const nextIndex = d.packageIndex + 1;
    if (nextIndex >= d.playPackage.phases.length) {
      if (d.endsAt != null) {
        await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, d.endsAt));
        return;
      }
      const last = d.playPackage.phases[d.playPackage.phases.length - 1];
      const ids = this.liveIds();
      if (ids.length === 0) {
        await this.finish();
        return;
      }
      const more = this.buildPlayPackage(
        ids,
        last.phaseStartedAt + last.phaseDurationMs,
        null,
        d.config.mode
      );
      const kept = d.playPackage.phases.slice(-4);
      d.playPackage = { endsAt: null, phases: [...kept, ...more.phases] };
      d.packageIndex = Math.max(0, kept.length - 1);
    }

    const next = d.playPackage.phases[d.packageIndex + 1];
    if (!next) {
      if (d.endsAt != null) {
        await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, d.endsAt));
      }
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next.phaseStartedAt));
  }

  async finish() {
    await this.ctx.storage.deleteAlarm();
    const d = this.data;
    d.config.running = false;
    d.config.mode = "idle";
    d.finishedAt = Date.now();
    d.phaseStartedAt = null;
    d.targetId = null;
    d.playPackage = null;
    d.packageIndex = 0;
    await this.persist();
  }

  /* ---------- snapshot / broadcast ---------- */

  snapshot() {
    const d = this.data;
    const host = d.hostOverlay || null;
    const running = d.config.running;
    const displays = Object.values(d.displays).map((disp) => ({
      id: disp.id,
      label: disp.label,
      place: disp.place,
      connected: !!disp.connected,
    }));
    return {
      code: d.code,
      config: d.config,
      displays,
      phase: running ? (host?.phase ?? d.phase) : null,
      phaseStartedAt: running ? (host?.phaseStartedAt ?? d.phaseStartedAt) : null,
      phaseDurationMs: host?.phaseDurationMs ?? d.phaseDurationMs,
      fromAngle: host?.fromAngle ?? d.fromAngle,
      toAngle: host?.toAngle ?? d.toAngle,
      targetId: running ? (host?.targetId ?? d.targetId) : null,
      startedAt: host?.startedAt ?? d.startedAt,
      endsAt: host?.endsAt ?? d.endsAt,
      finishedAt: host?.finishedAt !== undefined ? host.finishedAt : d.finishedAt,
      playPackage: running
        ? host?.playPackage !== undefined
          ? host.playPackage
          : d.playPackage
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
