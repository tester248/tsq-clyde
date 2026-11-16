// MinecraftBridgeDO: holds the outbound WebSocket session from the Fabric
// mod (the mod dials OUT to Cloudflare — no inbound ports). The DO is the
// server side of that socket: it authenticates the mod's hello, heartbeats,
// and routes targeted query/response frames between the agent tools and the
// mod. Mirrors GatewayDO's connection-ownership pattern.

const HEARTBEAT_MS = 30_000;
const QUERY_TIMEOUT_MS = 10_000;
const BAD_TOKEN_CLOSE = 4001;

export class MinecraftBridgeDO {
  constructor(ctx, env, deps = {}) {
    this.ctx = ctx;
    this.env = env;
    this.deps = {
      setInterval: (fn) => setInterval(fn, HEARTBEAT_MS),
      clearInterval: (id) => clearInterval(id),
      schedule: (fn) => setTimeout(fn, QUERY_TIMEOUT_MS),
      ...deps,
    };
    this.socket = null;
    this.connected = false;
    this.seq = 0;
    this.pending = new Map(); // query id -> { resolve, timer }
    this.queryQueue = [];     // frames awaiting pickup by the mod's poller
    this.waiters = [];        // poll requests waiting for a queued query
    this.lastPollAt = null;
    this.heartbeatTimer = null;
    this.status = { state: "idle", updatedAt: Date.now() };
    // diagnostics for /status + /ai/mcprobe (never exposes secrets)
    this.debug = { lastFrameType: null, lastFrameAt: null, helloAcceptedAt: null, lastParseError: null };
  }

  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/status":
        return Response.json({
          ...this.status,
          connected: this.connected && !!this.socket,
          socket: !!this.socket,
          pollConnected: this.lastPollAt !== null && Date.now() - this.lastPollAt < 60_000,
          lastPollAt: this.lastPollAt,
          queueLength: this.queryQueue.length,
          debug: this.debug,
        });
      case "/poll": {
        const timeout = Math.min(15_000, Math.max(1_000, parseInt(url.searchParams.get("timeout") ?? "10000", 10) || 10_000));
        const frame = await this.pollWait(timeout);
        if (!frame) return Response.json({});
        return Response.json({ query: frame });
      }
      case "/result": {
        const body = await request.json();
        this.resolveResult(body);
        return new Response("ok");
      }
      case "/query": {
        const body = await request.json();
        return Response.json(await this.query(body));
      }
      case "/connect": {
        // Canonical DO WebSocket pattern: this DO creates the pair, accepts
        // the server side, and returns the 101 with the client side. The
        // Worker forwards the upgrade request here.
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.attachSocket(server);
        return new Response(null, { status: 101, webSocket: client });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }

  // Attach the server-side socket (either from the real /connect route or a
  // fake in tests). Register message/close handlers and accept.
  attachSocket(socket) {
    this.socket = socket;
    if (typeof socket.accept === "function") socket.accept();
    socket.addEventListener?.("message", (event) => this.#onMessage(event));
    socket.addEventListener?.("close", (event) => this.#onClose(event));
  }

  #send(obj) {
    try {
      this.socket?.send(JSON.stringify(obj));
    } catch (err) {
      console.error("bridge send failed", err);
    }
  }

  #onMessage(event) {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch (err) {
      this.debug.lastFrameType = "<nonjson>";
      this.debug.lastFrameAt = Date.now();
      this.debug.lastParseError = String(err?.message || err).slice(0, 120);
      return;
    }
    this.debug.lastFrameType = frame.type;
    this.debug.lastFrameAt = Date.now();
    if (frame.type === "hello") {
      if (frame.token === this.env.MC_BRIDGE_TOKEN) {
        this.connected = true;
        this.debug.helloAcceptedAt = Date.now();
        this.status = { state: "connected", updatedAt: Date.now() };
        this.#send({ type: "hello", ok: true });
        if (this.heartbeatTimer === null) {
          this.heartbeatTimer = this.deps.setInterval(() => this.#send({ type: "ping" }));
        }
      } else {
        this.#send({ type: "hello", ok: false });
        try {
          this.socket?.close(BAD_TOKEN_CLOSE);
        } catch {
          // best-effort
        }
      }
      return;
    }
    if (frame.type === "result") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      pending.resolve(frame.ok ? { ok: true, data: frame.data } : { ok: false, error: frame.error || "mod error" });
      return;
    }
    if (frame.type === "pong") {
      // heartbeat alive
      return;
    }
  }

  #onClose() {
    this.socket = null;
    this.connected = false;
    this.status = { state: "disconnected", updatedAt: Date.now() };
    this.debug.lastFrameType = "close";
    this.debug.lastFrameAt = Date.now();
    if (this.heartbeatTimer !== null) {
      this.deps.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // Reject any in-flight queries.
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "bridge disconnected" });
    }
    this.pending.clear();
  }

  // Send a targeted query over the socket, awaiting the matching result.
  // If the WS is not available, the query is queued for the mod's poller
  // and resolved when the mod POSTs its result.
  query({ action, player }) {
    const id = ++this.seq;
    const frame = { type: "query", id, action };
    if (player) frame.player = player;

    if (this.socket && this.connected) {
      return new Promise((resolve) => {
        const timer = this.deps.schedule(() => {
          this.pending.delete(id);
          resolve({ ok: false, error: "query timeout" });
        });
        this.pending.set(id, { resolve, timer });
        this.#send(frame);
      });
    }

    // No live socket: go through the long-poll queue.
    return new Promise((resolve) => {
      const timer = this.deps.schedule(() => {
        this.pending.delete(id);
        const idx = this.queryQueue.findIndex((q) => q.id === id);
        if (idx >= 0) this.queryQueue.splice(idx, 1);
        resolve({ ok: false, error: "query timeout" });
      });
      this.pending.set(id, { resolve, timer });
      this.queryQueue.push(frame);
      // Wake the earliest waiter, if any, with this frame.
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
    });
  }

  // Wait up to `timeout` ms for a queued query (long-poll). Returns the frame
  // or null on timeout.
  async pollWait(timeout) {
    this.lastPollAt = Date.now();
    if (this.queryQueue.length > 0) {
      return this.queryQueue.shift();
    }
    return new Promise((resolve) => {
      const timer = this.deps.schedule(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      });
      this.waiters.push({ resolve, timer });
    });
  }

  // Resolve a pending query from the mod's POSTed result.
  resolveResult(body) {
    const id = body?.id;
    if (typeof id !== "number") return;
    // If the frame is still queued (never picked up), remove it.
    const qIdx = this.queryQueue.findIndex((q) => q.id === id);
    if (qIdx >= 0) this.queryQueue.splice(qIdx, 1);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(
      body.ok ? { ok: true, data: body.data } : { ok: false, error: body.error || "mod error" }
    );
  }
}
