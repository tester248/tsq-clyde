import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { MinecraftBridgeDO } from "../src/minecraft_bridge_do.js";
import { ConversationDO } from "../src/conversation_do.js";

function makeFakeState() {
  const store = new Map();
  return {
    storage: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => void store.set(k, v),
    },
    _store: store,
  };
}

const TOKEN = "mc-token";

// Fake server-side socket (what the DO attaches). Mirrors the gateway test
// socket's shape: addEventListener/send/close + helpers to trigger events.
function makeFakeSocket(sockets = []) {
  const handlers = {};
  const sock = {
    sent: [],
    closed: null,
    accepted: false,
    accept: () => void (sock.accepted = true),
    send: (data) => void sock.sent.push(typeof data === "string" ? JSON.parse(data) : data),
    close: (code) => void (sock.closed = code ?? 1000),
    addEventListener: (type, fn) => void ((handlers[type] ??= []).push(fn)),
    triggerMessage: (obj) =>
      void (handlers.message || []).forEach((fn) => fn({ data: JSON.stringify(obj) })),
    triggerClose: (code = 1006) => void (handlers.close || []).forEach((fn) => fn({ code })),
  };
  sockets.push(sock);
  return sock;
}

function makeBridge(deps = {}) {
  const state = makeFakeState();
  const timers = { intervals: [], schedules: [] };
  const bridge = new MinecraftBridgeDO(state, { MC_BRIDGE_TOKEN: TOKEN }, {
    setInterval: (fn) => {
      timers.intervals.push(fn);
      return timers.intervals.length;
    },
    clearInterval: () => {},
    schedule: (fn, ms) => {
      timers.schedules.push({ fn, ms });
      return timers.schedules.length;
    },
    ...deps,
  });
  return { bridge, state, timers };
}

describe("MinecraftBridgeDO", () => {
  it("status reports idle/disconnected before any socket", async () => {
    const { bridge } = makeBridge();
    const res = await bridge.fetch(new Request("https://bridge/status"));
    const body = await res.json();
    assert.equal(body.connected, false);
    assert.equal(body.state, "idle");
  });

  it("accepts hello with the correct token and reports connected", async () => {
    const { bridge } = makeBridge();
    const sock = makeFakeSocket();
    bridge.attachSocket(sock);

    sock.triggerMessage({ type: "hello", token: TOKEN });
    assert.equal(sock.accepted, true);
    assert.equal(bridge.connected, true);
    // Must have replied hello ok.
    assert.deepEqual(sock.sent[0], { type: "hello", ok: true });
    // Status now connected.
    const res = await bridge.fetch(new Request("https://bridge/status"));
    const body = await res.json();
    assert.equal(body.connected, true);
    assert.equal(body.state, "connected");
  });

  it("rejects a bad token and closes the socket", async () => {
    const { bridge } = makeBridge();
    const sock = makeFakeSocket();
    bridge.attachSocket(sock);

    sock.triggerMessage({ type: "hello", token: "wrong" });
    assert.equal(bridge.connected, false);
    assert.deepEqual(sock.sent[0], { type: "hello", ok: false });
    assert.equal(sock.closed, 4001);
  });

  it("round-trips a query over the socket", async () => {
    const { bridge } = makeBridge();
    const sock = makeFakeSocket();
    bridge.attachSocket(sock);
    sock.triggerMessage({ type: "hello", token: TOKEN });

    const promise = bridge.query({ action: "status" });
    assert.equal(sock.sent.length, 2); // hello reply + query frame
    const queryFrame = sock.sent[1];
    assert.equal(queryFrame.type, "query");
    assert.equal(queryFrame.action, "status");
    assert.equal(typeof queryFrame.id, "number");

    // Mod replies.
    sock.triggerMessage({ type: "result", id: queryFrame.id, ok: true, data: { version: "26.3" } });
    const result = await promise;
    assert.equal(result.ok, true);
    assert.equal(result.data.version, "26.3");
  });

  it("queues queries without a socket for the poller (no immediate error)", async () => {
    const { bridge } = makeBridge();
    const promise = bridge.query({ action: "status" });
    assert.equal(bridge.queryQueue.length, 1);

    const polled = await bridge.fetch(new Request("https://bridge/poll?timeout=1000"));
    const body = await polled.json();
    assert.ok(body.query, "expected a queued query frame");
    assert.equal(body.query.action, "status");
    assert.equal(bridge.queryQueue.length, 0);

    await bridge.fetch(new Request("https://bridge/result", {
      method: "POST",
      body: JSON.stringify({ id: body.query.id, ok: true, data: { version: "26.3" } }),
    }));
    const result = await promise;
    assert.equal(result.ok, true);
    assert.equal(result.data.version, "26.3");
  });

  it("times out a query when no result arrives", async () => {
    const { bridge, timers } = makeBridge();
    const sock = makeFakeSocket();
    bridge.attachSocket(sock);
    sock.triggerMessage({ type: "hello", token: TOKEN });

    const promise = bridge.query({ action: "players" });
    assert.equal(timers.schedules.length, 1);
    // Fire the timeout scheduler.
    timers.schedules[0].fn();
    const result = await promise;
    assert.equal(result.ok, false);
    assert.match(result.error, /timeout/i);
  });

  it("resolves failures from the mod as error results", async () => {
    const { bridge } = makeBridge();
    const sock = makeFakeSocket();
    bridge.attachSocket(sock);
    sock.triggerMessage({ type: "hello", token: TOKEN });

    const promise = bridge.query({ action: "player_location", player: "Alice" });
    const queryFrame = sock.sent[1];
    assert.equal(queryFrame.player, "Alice");
    sock.triggerMessage({ type: "result", id: queryFrame.id, ok: false, error: "unknown player" });
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(result.error, "unknown player");
  });

  it("queues queries without a socket and resolves them via POST /result", async () => {
    const { bridge } = makeBridge();
    const promise = bridge.query({ action: "status" });

    const polled = await bridge.fetch(new Request("https://bridge/poll?timeout=1000"));
    const body = await polled.json();
    assert.ok(body.query, "expected a queued query frame");
    assert.equal(body.query.action, "status");

    const res = await bridge.fetch(new Request("https://bridge/result", {
      method: "POST",
      body: JSON.stringify({ id: body.query.id, ok: true, data: { version: "26.3" } }),
    }));
    assert.equal(res.status, 200);

    const result = await promise;
    assert.equal(result.ok, true);
    assert.equal(result.data.version, "26.3");
  });

  it("long-poll waits and returns empty on timeout", async () => {
    const { bridge, timers } = makeBridge();
    const promise = bridge.fetch(new Request("https://bridge/poll?timeout=1000"));
    timers.schedules[timers.schedules.length - 1].fn(); // fire the poll timeout
    const body = await (await promise).json();
    assert.deepEqual(body, {});
    assert.equal(typeof bridge.lastPollAt, "number", "lastPollAt should be set on poll");
    assert.equal(bridge.queryQueue.length, 0);
  });

  it("reports pollConnected after a poll", async () => {
    const { bridge, timers } = makeBridge();
    const pollPromise = bridge.fetch(new Request("https://bridge/poll?timeout=1000"));
    timers.schedules[timers.schedules.length - 1].fn(); // release the waiter
    await pollPromise;
    const status = await (await bridge.fetch(new Request("https://bridge/status"))).json();
    assert.equal(status.pollConnected, true);
    assert.equal(status.queueLength, 0);
  });

  it("invoke routes through the configured processor into the outbox", async () => {
    const { bridge, timers } = makeBridge({
      runInvocation: async ({ player, text }, push) => {
        assert.equal(player, "Alice");
        assert.equal(text, "klyde hi");
        push({ kind: "phase", text: "Klyde is searching…" });
        push({ kind: "reply", text: "hello Alice" });
      },
    });
    const res = await bridge.fetch(new Request("https://bridge/invoke", {
      method: "POST",
      body: JSON.stringify({ player: "Alice", text: "klyde hi" }),
    }));
    assert.equal(res.status, 202);

    const poll1 = await (await bridge.fetch(new Request("https://bridge/poll?timeout=1000"))).json();
    assert.ok(poll1.message, "expected a message frame from the outbox");
    assert.equal(poll1.message.kind, "phase");
    const poll2 = await (await bridge.fetch(new Request("https://bridge/poll?timeout=1000"))).json();
    assert.equal(poll2.message.kind, "reply");

    const poll3Promise = bridge.fetch(new Request("https://bridge/poll?timeout=1000"));
    timers.schedules[timers.schedules.length - 1].fn();
    assert.deepEqual(await (await poll3Promise).json(), {});
  });

  it("invoke without a processor still accepts and returns 202", async () => {
    const { bridge } = makeBridge();
    const res = await bridge.fetch(new Request("https://bridge/invoke", {
      method: "POST",
      body: JSON.stringify({ player: "Bob", text: "klyde yo" }),
    }));
    assert.equal(res.status, 202);
  });

  it("rosters are stored, returned, and counted in status", async () => {
    const { bridge } = makeBridge();
    const mods = [
      { id: "aether", name: "The Aether", version: "1.0" },
      { id: "mythicmetals", name: "Mythic Metals", version: "2.0" },
    ];
    const put = await bridge.fetch(new Request("https://bridge/roster", {
      method: "POST",
      body: JSON.stringify({ mods }),
    }));
    assert.equal(put.status, 200);

    const got = await (await bridge.fetch(new Request("https://bridge/rosterGet"))).json();
    assert.deepEqual(got.mods, mods);

    const status = await (await bridge.fetch(new Request("https://bridge/status"))).json();
    assert.equal(status.rosterCount, 2);
  });

  it("poll returns queued queries before outbox messages", async () => {
    const { bridge, timers } = makeBridge({
      runInvocation: async (_inv, push) => push({ kind: "reply", text: "later" }),
    });
    const queryPromise = bridge.query({ action: "status" });
    await bridge.fetch(new Request("https://bridge/invoke", {
      method: "POST",
      body: JSON.stringify({ player: "A", text: "klyde hi" }),
    }));

    const poll1 = await (await bridge.fetch(new Request("https://bridge/poll?timeout=1000"))).json();
    assert.ok(poll1.query, "query should come first");
    assert.equal(poll1.query.action, "status");

    const poll2 = await (await bridge.fetch(new Request("https://bridge/poll?timeout=1000"))).json();
    assert.ok(poll2.message, "then the outbox message");
    assert.equal(poll2.message.kind, "reply");

    // resolve the query so its promise settles
    await bridge.fetch(new Request("https://bridge/result", {
      method: "POST",
      body: JSON.stringify({ id: poll1.query.id, ok: true, data: { version: "26.3" } }),
    }));
    assert.equal((await queryPromise).ok, true);
  });

  it("status reports outbox length", async () => {
    const { bridge } = makeBridge({
      runInvocation: async (_inv, push) => push({ kind: "reply", text: "x" }),
    });
    await bridge.fetch(new Request("https://bridge/invoke", {
      method: "POST",
      body: JSON.stringify({ player: "A", text: "klyde hi" }),
    }));
    const status = await (await bridge.fetch(new Request("https://bridge/status"))).json();
    assert.equal(status.outboxLength, 1);
  });

  it("invoke without a custom processor runs the real headless invocation", async () => {
    // Real processor path: needs a conversation DO + provider fetch mocks.
    const realFetch = globalThis.fetch;
    const mem = new Map();
    const convo = new ConversationDO(
      { storage: { get: async (k) => mem.get(k) ?? null, put: async (k, v) => void mem.set(k, v) } },
      {}
    );
    const store = new Map();
    const bridge = new MinecraftBridgeDO(
      { storage: { get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v) } },
      {
        CONVERSATION_DO: {
          idFromName: () => "minecraft",
          get: () => ({ fetch: (url, init) => convo.fetch(new Request(url, init)) }),
        },
        MINECRAFT_BRIDGE_DO: { idFromName: () => "minecraft", get: () => ({ fetch: async () => Response.json({ mods: [] }) }) },
        INCEPTION_API_KEY: "k",
        GROQ_API_KEY: "g",
        WUS_API_KEY: "w",
      },
      {}
    );
    globalThis.fetch = async (url) => {
      if (String(url).includes("api.inceptionlabs.ai")) {
        return Response.json({
          choices: [{ message: { role: "assistant", content: "yes" } }],
          usage: { total_tokens: 2 },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    try {
      await bridge.fetch(new Request("https://bridge/invoke", {
        method: "POST",
        body: JSON.stringify({ player: "Alice", text: "hello" }),
      }));
      const poll = await (await bridge.fetch(new Request("https://bridge/poll?timeout=1000"))).json();
      assert.ok(poll.message, "expected a reply frame from the real invocation");
      assert.equal(poll.message.kind, "reply");
      assert.equal(poll.message.text, "yes");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
