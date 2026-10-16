import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { GatewayDO } from "../src/gateway_do.js";
import { ConversationDO } from "../src/conversation_do.js";

const BOT_ID = "BOTID";

function makeFakeState() {
  const store = new Map();
  const alarms = [];
  const background = [];
  return {
    storage: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => void store.set(k, v),
      setAlarm: async (t) => void alarms.push(t),
    },
    waitUntil: (p) => void background.push(p),
    _store: store,
    _alarms: alarms,
    _background: background,
  };
}

async function flush(state) {
  // One macrotask tick first: socket handlers await storage writes before
  // they reach waitUntil, so drain only after those chains have landed.
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 20 && state._background.length > 0; i++) {
    const batch = state._background.splice(0);
    await Promise.allSettled(batch);
  }
}

const tick = () => new Promise((r) => setImmediate(r));

function makeSocketFactory(sockets) {
  return (url) => {
    const handlers = {};
    const sock = {
      url,
      sent: [],
      closed: null,
      send: (data) => void sock.sent.push(JSON.parse(data)),
      close: (code) => {
        sock.closed = code ?? 1000;
      },
      addEventListener: (type, fn) => void ((handlers[type] ??= []).push(fn)),
      triggerMessage: (obj) =>
        (handlers.message || []).forEach((fn) => fn({ data: JSON.stringify(obj) })),
      triggerClose: (code = 1006) => (handlers.close || []).forEach((fn) => fn({ code })),
    };
    sockets.push(sock);
    return sock;
  };
}

function makeDeps(sockets, timers) {
  return {
    createSocket: makeSocketFactory(sockets),
    setInterval: (fn) => {
      timers.intervals.push(fn);
      return timers.intervals.length;
    },
    clearInterval: () => {},
    schedule: (fn) => void timers.schedules.push(fn),
  };
}

function makeEnv() {
  const convoStore = new Map();
  const kv = new Map();
  const convo = new ConversationDO(
    {
      storage: {
        get: async (k) => convoStore.get(k) ?? null,
        put: async (k, v) => void convoStore.set(k, v),
      },
    },
    {}
  );
  return {
    env: {
      DISCORD_TOKEN: "test-token",
      DISCORD_BOT_ID: BOT_ID,
      CONVERSATION_DO: {
        idFromName: (n) => n,
        get: () => ({
          fetch: (url, init) => convo.fetch(new Request(url, init)),
        }),
      },
      LAST_MESSAGE_KV: {
        get: async (k) => kv.get(k) ?? null,
        put: async (k, v) => void kv.set(k, v),
      },
    },
    kv,
  };
}

const HELLO = { op: 10, d: { heartbeat_interval: 30000 } };
const READY = {
  op: 0,
  s: 1,
  t: "READY",
  d: {
    session_id: "S1",
    resume_gateway_url: "wss://resume.example/?v=10&encoding=json",
    user: { id: BOT_ID },
    guilds: [{}, {}],
  },
};

function mention(id, content = `<@${BOT_ID}> hello there`) {
  return {
    op: 0,
    s: 2,
    t: "MESSAGE_CREATE",
    d: {
      id,
      channel_id: "C1",
      guild_id: "G1",
      author: { id: "U1", bot: false },
      content,
      mentions: [{ id: BOT_ID }],
    },
  };
}

describe("GatewayDO", () => {
  let discordPosts;
  let groqCalls;
  let realFetch;

  beforeEach(() => {
    discordPosts = [];
    groqCalls = 0;
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("api.groq.com")) {
        groqCalls++;
        return Response.json({
          choices: [{ message: { content: `mock reply ${groqCalls}` } }],
          usage: { total_tokens: 10 },
        });
      }
      if (u.includes("discord.com/api")) {
        discordPosts.push({ url: u, body: JSON.parse(init.body) });
        return Response.json({ id: "mid" });
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function setup() {
    const state = makeFakeState();
    const sockets = [];
    const timers = { intervals: [], schedules: [] };
    const { env, kv } = makeEnv();
    const gw = new GatewayDO(state, env, makeDeps(sockets, timers));
    return { state, sockets, timers, env, kv, gw };
  }

  it("concurrent wakes open only one socket", async () => {
    const { gw, sockets } = setup();
    await Promise.all([
      gw.fetch(new Request("https://gateway/wake", { method: "POST" })),
      gw.fetch(new Request("https://gateway/wake", { method: "POST" })),
    ]);
    await tick();
    assert.equal(sockets.length, 1);
  });

  it("/wake on cold start creates the gateway socket", async () => {
    const { gw, sockets } = setup();
    const res = await gw.fetch(new Request("https://gateway/wake", { method: "POST" }));
    assert.equal(res.status, 200);
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].url, "wss://gateway.discord.gg/?v=10&encoding=json");
  });

  it("HELLO triggers an identify frame", async () => {
    const { gw, sockets } = setup();
    await gw.fetch(new Request("https://gateway/wake", { method: "POST" }));
    sockets[0].triggerMessage(HELLO);
    const identify = sockets[0].sent.find((f) => f.op === 2);
    assert.ok(identify, "expected an identify frame");
    assert.equal(identify.d.token, "test-token");
    assert.equal(identify.d.intents, 513);
  });

  it("READY marks connected and persists the session", async () => {
    const { state, gw, sockets } = setup();
    await gw.fetch(new Request("https://gateway/wake", { method: "POST" }));
    sockets[0].triggerMessage(HELLO);
    sockets[0].triggerMessage(READY);
    await tick();
    const status = await (await gw.fetch(new Request("https://gateway/status"))).json();
    assert.equal(status.state, "connected");
    assert.equal(status.guilds, 2);
    const stored = await state.storage.get("gw:session");
    assert.equal(stored.sessionId, "S1");
  });

  it("mention dispatch works end to end", async () => {
    const { gw, sockets, kv } = setup();
    await gw.fetch(new Request("https://gateway/wake", { method: "POST" }));
    sockets[0].triggerMessage(HELLO);
    sockets[0].triggerMessage(READY);
    sockets[0].triggerMessage(mention("MSG1"));
    const fakeState = gw.ctx;
    await flush(fakeState);
    assert.equal(discordPosts.length, 1);
    assert.ok(discordPosts[0].url.includes("/channels/C1/messages"));
    assert.equal(discordPosts[0].body.content, "mock reply 1");
    assert.equal(await kv.get("last_C1"), "MSG1");
  });

  it("unacked heartbeat closes the socket (zombie path)", async () => {
    const { gw, sockets, timers } = setup();
    await gw.fetch(new Request("https://gateway/wake", { method: "POST" }));
    sockets[0].triggerMessage(HELLO);
    const beats = sockets[0].sent.filter((f) => f.op === 1).length;
    assert.equal(beats, 1, "expected the immediate heartbeat on HELLO");
    assert.equal(timers.intervals.length, 1);
    timers.intervals[0]();
    assert.notEqual(sockets[0].closed, null, "expected the zombie socket to be closed");
    assert.equal(
      sockets[0].sent.filter((f) => f.op === 1).length,
      1,
      "no second heartbeat should go out on a dead socket"
    );
  });

  it("op 9 with d:false clears the session and re-identifies", async () => {
    const { state, gw, sockets, timers } = setup();
    await gw.fetch(new Request("https://gateway/wake", { method: "POST" }));
    sockets[0].triggerMessage(HELLO);
    sockets[0].triggerMessage(READY);
    assert.equal((await state.storage.get("gw:session")).sessionId, "S1");
    sockets[0].triggerMessage({ op: 9, d: false });
    await tick();
    assert.equal(await state.storage.get("gw:session"), null);
    assert.equal(timers.schedules.length, 1);
    timers.schedules[0]();
    await tick();
    assert.equal(sockets.length, 2);
    assert.equal(sockets[1].url, "wss://gateway.discord.gg/?v=10&encoding=json");
    sockets[1].triggerMessage(HELLO);
    const ops = sockets[1].sent.map((f) => f.op);
    assert.ok(ops.includes(2), "expected a fresh identify");
    assert.ok(!ops.includes(6), "must not resume after invalid session");
  });

  it("close 4004 is fatal: no reconnect is scheduled", async () => {
    const { gw, sockets, timers } = setup();
    await gw.fetch(new Request("https://gateway/wake", { method: "POST" }));
    sockets[0].triggerMessage(HELLO);
    sockets[0].triggerMessage(READY);
    assert.equal(timers.schedules.length, 0);
    sockets[0].triggerClose(4004);
    const status = await (await gw.fetch(new Request("https://gateway/status"))).json();
    assert.equal(status.state, "fatal");
    assert.equal(timers.schedules.length, 0);
    await gw.fetch(new Request("https://gateway/wake", { method: "POST" }));
    assert.equal(sockets.length, 1, "fatal socket must not be recreated by /wake");
  });

  it("two rapid mentions in one channel reply in order", async () => {
    const { gw, sockets, kv } = setup();
    await gw.fetch(new Request("https://gateway/wake", { method: "POST" }));
    sockets[0].triggerMessage(HELLO);
    sockets[0].triggerMessage(READY);
    sockets[0].triggerMessage(mention("MSG1", `<@${BOT_ID}> first`));
    sockets[0].triggerMessage(mention("MSG2", `<@${BOT_ID}> second`));
    await flush(gw.ctx);
    const bodies = discordPosts.map((p) => p.body.content);
    assert.deepEqual(bodies, ["mock reply 1", "mock reply 2"]);
    assert.equal(await kv.get("last_C1"), "MSG2");
  });
});
