import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { MinecraftBridgeDO } from "../src/minecraft_bridge_do.js";

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

  it("returns bridge disconnected error for queries without a live socket", async () => {
    const { bridge } = makeBridge();
    const result = await bridge.query({ action: "status" });
    assert.equal(result.ok, false);
    assert.match(result.error, /disconnected/i);
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
});
