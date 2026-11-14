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
    this.heartbeatTimer = null;
    this.status = { state: "idle", updatedAt: Date.now() };
  }

  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/status":
        return Response.json({
          ...this.status,
          connected: this.connected && !!this.socket,
        });
      case "/query": {
        const body = await request.json();
        return Response.json(await this.query(body));
      }
      case "/connect": {
        const ws = request.cf?.websockets?.[0];
        if (!ws) return new Response("no websocket", { status: 400 });
        this.attachSocket(ws);
        return new Response("ok");
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
    } catch {
      return;
    }
    if (frame.type === "hello") {
      if (frame.token === this.env.MC_BRIDGE_TOKEN) {
        this.connected = true;
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
  query({ action, player }) {
    if (!this.socket || !this.connected) {
      return Promise.resolve({ ok: false, error: "bridge disconnected" });
    }
    const id = ++this.seq;
    const frame = { type: "query", id, action };
    if (player) frame.player = player;

    return new Promise((resolve) => {
      const timer = this.deps.schedule(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: "query timeout" });
      });
      this.pending.set(id, { resolve, timer });
      this.#send(frame);
    });
  }
}
