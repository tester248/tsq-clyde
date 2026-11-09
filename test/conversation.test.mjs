import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ConversationDO } from "../src/conversation_do.js";

function makeConvo() {
  const mem = new Map();
  return new ConversationDO({
    storage: {
      get: async (k) => mem.get(k) ?? null,
      put: async (k, v) => void mem.set(k, v),
    },
  }, {});
}

const call = (convo, path, opts) => convo.fetch(new Request(`https://example.com${path}`, opts));

describe("ConversationDO", () => {
  it("appends entries and tracks token estimates", async () => {
    const convo = makeConvo();
    await call(convo, "/initialize");
    await call(convo, "/append", {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "hello world" }),
    });
    const state = await (await call(convo, "/get")).json();
    assert.equal(state.history.length, 1);
    assert.equal(state.tokenCount, Math.ceil("hello world".length / 4));
  });

  it("records per-model token usage", async () => {
    const convo = makeConvo();
    await call(convo, "/recordUsage", {
      method: "POST",
      body: JSON.stringify({ model: "m", tokens: 10 }),
    });
    const state = await (await call(convo, "/get")).json();
    assert.equal(state.modelUsage.m, 10);
  });

  it("setSummary replaces history with the summary", async () => {
    const convo = makeConvo();
    await call(convo, "/append", {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "some chatter" }),
    });
    await call(convo, "/setSummary", {
      method: "POST",
      body: JSON.stringify({ summary: "greeted" }),
    });
    const state = await (await call(convo, "/get")).json();
    assert.equal(state.history.length, 0);
    assert.equal(state.summary, "greeted");
  });

  it("clear resets history, memory, and usage but keeps user profiles", async () => {
    const convo = makeConvo();
    await call(convo, "/append", {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "x" }),
    });
    await call(convo, "/setMemory", {
      method: "POST",
      body: JSON.stringify({ memory: "channel notes" }),
    });
    await call(convo, "/setUserProfile", {
      method: "POST",
      body: JSON.stringify({ userId: "U1", profile: "prefers terse" }),
    });
    assert.equal(await (await call(convo, "/clear")).text(), "cleared");
    const state = await (await call(convo, "/get")).json();
    assert.deepEqual(state, {
      history: [],
      tokenCount: 0,
      modelUsage: {},
      memory: "",
      userProfiles: { U1: "prefers terse" },
    });
  });

  it("stores and persists channel memory across initialize", async () => {
    const convo = makeConvo();
    await call(convo, "/setMemory", {
      method: "POST",
      body: JSON.stringify({ memory: "this server runs on ports 3000-3005" }),
    });
    const state = await (await call(convo, "/get")).json();
    assert.equal(state.memory, "this server runs on ports 3000-3005");

    // eviction round-trip: fresh instance, same storage
    await call(convo, "/initialize"); // reloads from storage
    const reloaded = await (await call(convo, "/get")).json();
    assert.equal(reloaded.memory, "this server runs on ports 3000-3005");
  });

  it("stores and persists user profiles across initialize", async () => {
    const convo = makeConvo();
    await call(convo, "/setUserProfile", {
      method: "POST",
      body: JSON.stringify({ userId: "U1", profile: "likes short answers" }),
    });
    await call(convo, "/setUserProfile", {
      method: "POST",
      body: JSON.stringify({ userId: "U2", profile: "wants detail" }),
    });
    await call(convo, "/initialize");
    const state = await (await call(convo, "/get")).json();
    assert.equal(state.userProfiles.U1, "likes short answers");
    assert.equal(state.userProfiles.U2, "wants detail");
  });

  it("memoryGet and getUserProfile return the stored values", async () => {
    const convo = makeConvo();
    await call(convo, "/setMemory", {
      method: "POST",
      body: JSON.stringify({ memory: "notes" }),
    });
    await call(convo, "/setUserProfile", {
      method: "POST",
      body: JSON.stringify({ userId: "U1", profile: "p" }),
    });
    const mem = await (await call(convo, "/memoryGet")).json();
    assert.equal(mem.memory, "notes");
    const prof = await (await call(convo, "/getUserProfile?userId=U1")).json();
    assert.equal(prof.profile, "p");
    const missing = await (await call(convo, "/getUserProfile?userId=U9")).json();
    assert.equal(missing.profile, "");
  });

  it("unknown routes 404", async () => {
    const convo = makeConvo();
    assert.equal((await call(convo, "/nope")).status, 404);
  });
});
