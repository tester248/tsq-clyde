// Singleton Discord gateway connection. One instance (id "gateway") owns a
// single outbound WebSocket: identify/resume, heartbeats, reconnect with
// backoff, and a 60s alarm watchdog. Mention/reply events are dispatched to
// the existing per-channel ConversationDO pipeline via waitUntil — never
// blocking heartbeats — and serialized per channel.
//
// NOTE: outbound client sockets from `new WebSocket(url)` are automatically
// accepted by the runtime; do NOT call accept() on them (that is only for
// server-side WebSocketPair sockets).

import {
  GATEWAY_URL,
  identifyPayload,
  resumePayload,
  heartbeatPayload,
  classifyClose,
  reconnectDelay,
  shouldHandleMessage,
} from "./gateway.js";
import { processMessage } from "./processor.js";

const WATCHDOG_MS = 60_000;

export class GatewayDO {
  constructor(ctx, env, deps = {}) {
    this.ctx = ctx;
    this.env = env;
    this.deps = {
      createSocket: (url) => new WebSocket(url),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id),
      schedule: (fn, ms) => setTimeout(fn, ms),
      ...deps,
    };
    this.socket = null;
    this.connecting = false; // synchronous guard: closes the concurrent-wake race
    this.session = null; // { sessionId, resumeUrl, seq, botId } — persisted as gw:session
    this.seq = null;
    this.heartbeatTimer = null;
    this.heartbeatIntervalMs = null;
    this.heartbeatAcked = true;
    this.reconnectAttempt = 0;
    this.fatal = false;
    this.alarmSet = false;
    this.inflight = new Map(); // channel_id -> promise chain (per-channel serialization)
    this.events = []; // in-memory lifecycle ring buffer, surfaced via /status
    this.status = {
      state: "idle",
      guilds: 0,
      reconnectAttempt: 0,
      updatedAt: Date.now(),
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json({
        ...this.status,
        socketOpen: !!this.socket,
        recent: this.events.slice(-10),
      });
    }
    if (request.method === "POST" && url.pathname === "/wake") {
      await this.#ensureAlarm();
      if (!this.fatal && !this.socket) await this.#connect(true);
      return new Response("ok");
    }
    if (request.method === "POST" && url.pathname === "/connect") {
      // Manual (re)connect, e.g. after a deploy or after fixing the token.
      this.fatal = false;
      this.reconnectAttempt = 0;
      await this.#ensureAlarm();
      if (!this.socket) await this.#connect(true);
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  }

  // Watchdog: re-arms itself every minute and heals a missing socket
  // (eviction, missed close event, dropped backoff timer).
  async alarm() {
    try {
      if (!this.fatal && !this.socket) await this.#connect(true);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
      this.alarmSet = true;
    }
  }

  async #ensureAlarm() {
    if (this.alarmSet) return;
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    this.alarmSet = true;
  }

  async #loadSession() {
    if (this.session) return;
    const stored = await this.ctx.storage.get("gw:session");
    if (stored) {
      this.session = stored;
      this.seq = stored.seq ?? null;
    }
  }

  #saveSession() {
    return this.ctx.storage.put("gw:session", this.session);
  }

  #setStatus(patch) {
    this.status = { ...this.status, ...patch, updatedAt: Date.now() };
    return this.ctx.storage
      .put("gw:status", this.status)
      .catch((err) => console.error("gateway status persist failed", err));
  }

  #event(type, detail = {}) {
    this.events.push({ at: Date.now(), type, ...detail });
    if (this.events.length > 30) this.events.shift();
  }

  #send(frame) {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch (err) {
      console.error("gateway send failed", err);
    }
  }

  async #connect(resumePreferred) {
    // Guard must be synchronous: two concurrent wakes would otherwise both
    // observe socket===null across the loadSession await and open two
    // sockets, which Discord answers by killing one and storming closes.
    if (this.socket || this.connecting) return;
    this.connecting = true;
    try {
      await this.#loadSession();
      const canResume = resumePreferred && this.session?.sessionId;
      const url = canResume ? this.session.resumeUrl || GATEWAY_URL : GATEWAY_URL;
      console.log(`gateway connecting (resume=${!!canResume})`);
      this.#event("connecting", { resume: !!canResume });
      const ws = this.deps.createSocket(url);
      this.socket = ws;
      ws.addEventListener("message", (event) => void this.#onSocketMessage(event));
      ws.addEventListener("close", (event) => void this.#onSocketClose(event));
      ws.addEventListener("error", (event) =>
        console.error("gateway socket error", event?.message || event)
      );
      this.#setStatus({ state: "connecting" });
    } finally {
      this.connecting = false;
    }
  }

  #disconnect() {
    if (this.heartbeatTimer !== null && this.heartbeatTimer !== undefined) {
      this.deps.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      try {
        ws.close(1000);
      } catch (err) {
        console.error("gateway socket close failed", err);
      }
    }
  }

  #reconnect(resumePreferred) {
    this.#disconnect();
    if (this.fatal) return;
    this.reconnectAttempt += 1;
    const delay = reconnectDelay(this.reconnectAttempt);
    this.#setStatus({ state: "disconnected", reconnectAttempt: this.reconnectAttempt });
    this.deps.schedule(() => {
      if (!this.fatal && !this.socket && !this.connecting) void this.#connect(resumePreferred);
    }, delay);
  }

  async #onSocketMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.s !== undefined && msg.s !== null) {
      this.seq = msg.s;
      if (this.session) {
        this.session.seq = msg.s;
        await this.#saveSession();
      }
    }
    switch (msg.op) {
      case 10:
        return this.#onHello(msg.d);
      case 11:
        this.heartbeatAcked = true;
        return;
      case 7: // RECONNECT requested by Discord — resume.
        console.log("gateway RECONNECT requested by Discord, resuming");
        this.#event("op7");
        return this.#reconnect(true);
      case 9: // INVALID SESSION
        console.log(`gateway INVALID SESSION resumable=${msg.d}`);
        this.#event("op9", { resumable: msg.d });
        return this.#onInvalidSession(msg.d);
      case 0:
        return this.#onDispatch(msg.t, msg.d);
      default:
        return;
    }
  }

  #onHello(d) {
    this.heartbeatIntervalMs = d.heartbeat_interval;
    const resuming = !!this.session?.sessionId;
    console.log(`gateway HELLO, heartbeat=${this.heartbeatIntervalMs}ms, resuming=${resuming}`);
    this.#event("hello", { interval: this.heartbeatIntervalMs, resuming });
    const token = this.env.DISCORD_TOKEN;
    if (this.session?.sessionId) {
      this.#send(resumePayload(token, this.session.sessionId, this.seq));
    } else {
      this.#send(identifyPayload(token));
    }
    // First heartbeat goes out immediately; the timer covers the rest.
    this.heartbeatAcked = false;
    this.#send(heartbeatPayload(this.seq));
    if (this.heartbeatTimer !== null && this.heartbeatTimer !== undefined) {
      this.deps.clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = this.deps.setInterval(() => this.#onHeartbeatTick(), this.heartbeatIntervalMs);
  }

  #onHeartbeatTick() {
    if (!this.heartbeatAcked) {
      // Zombie: a full interval passed with no ACK. Drop it and resume.
      this.#event("zombie");
      this.#reconnect(true);
      return;
    }
    this.heartbeatAcked = false;
    this.#send(heartbeatPayload(this.seq));
  }

  async #onInvalidSession(resumable) {
    if (!resumable) {
      // d:false — resume would loop forever. Drop the session, fresh identify.
      this.session = null;
      this.seq = null;
      await this.ctx.storage.put("gw:session", null);
    }
    this.#reconnect(true);
  }

  #onSocketClose(event) {
    const code = event?.code ?? 1006;
    this.#disconnect();
    const action = classifyClose(code);
    console.log(`gateway socket closed code=${code} action=${action}`);
    this.#event("close", { code, action });
    this.#setStatus({ closeCode: code });
    if (action === "fatal") {
      this.fatal = true;
      this.#setStatus({ state: "fatal", closeCode: code });
      console.error(`gateway closed with fatal code ${code}; fix config and POST /connect`);
      return;
    }
    if (action === "fresh") {
      this.session = null;
      this.seq = null;
      void this.ctx.storage.put("gw:session", null);
    }
    this.#reconnect(true);
  }

  async #onDispatch(type, data) {
    if (type === "READY") {
      this.session = {
        sessionId: data.session_id,
        resumeUrl: data.resume_gateway_url || GATEWAY_URL,
        seq: this.seq,
        botId: data.user?.id,
      };
      await this.#saveSession();
      this.reconnectAttempt = 0;
      console.log(`gateway READY session=${data.session_id} guilds=${data.guilds?.length ?? 0}`);
      this.#event("ready", { guilds: data.guilds?.length ?? 0 });
      if (data.user?.id && this.env.LAST_MESSAGE_KV) {
        try {
          await this.env.LAST_MESSAGE_KV.put("discord_bot_id", data.user.id);
        } catch (err) {
          console.error("bot id cache failed", err);
        }
      }
      await this.#setStatus({
        state: "connected",
        guilds: data.guilds?.length ?? 0,
        reconnectAttempt: 0,
      });
      return;
    }
    if (type === "RESUMED") {
      this.reconnectAttempt = 0;
      await this.#setStatus({ state: "connected", reconnectAttempt: 0 });
      return;
    }
    if (type === "MESSAGE_CREATE") {
      this.#handleGatewayMessage(data);
    }
  }

  #handleGatewayMessage(msg) {
    const botId = this.env.DISCORD_BOT_ID || this.session?.botId;
    const verdict = shouldHandleMessage(msg, botId);
    console.log(
      `gateway MESSAGE_CREATE id=${msg.id} channel=${msg.channel_id} handle=${verdict.handle}` +
        (verdict.handle ? ` prompt="${verdict.prompt.slice(0, 60)}"` : "")
    );
    if (!verdict.handle) return;
    const key = msg.channel_id;
    const prev = this.inflight.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.#answerMention(msg, verdict.prompt));
    this.inflight.set(key, next);
    this.ctx.waitUntil(
      next.finally(() => {
        if (this.inflight.get(key) === next) this.inflight.delete(key);
      })
    );
  }

  async #answerMention(msg, prompt) {
    const started = Date.now();
    console.log(`gateway answering channel=${msg.channel_id} msg=${msg.id}`);
    try {
      // Hard cap so a hung Groq/DO call can never stall the per-channel
      // serialization chain (which would silently kill all later mentions).
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("mention timeout")), 45_000);
      });
      try {
        await Promise.race([
          processMessage(
            {
              channel_id: msg.channel_id,
              guild_id: msg.guild_id,
              user_id: msg.author?.id,
              content: prompt,
            },
            this.env
          ),
          timeoutPromise,
        ]);
      } finally {
        clearTimeout(timer);
      }
      console.log(`gateway answered channel=${msg.channel_id} in ${Date.now() - started}ms`);
    } catch (err) {
      console.error(`gateway mention reply failed (${Date.now() - started}ms)`, err?.message || err);
    }
    try {
      await this.env.LAST_MESSAGE_KV.put(`last_${msg.channel_id}`, msg.id);
    } catch (err) {
      console.error("gateway last-message persist failed", err);
    }
  }
}
