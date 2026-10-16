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

  it("clear resets to empty state", async () => {
    const convo = makeConvo();
    await call(convo, "/append", {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "x" }),
    });
    assert.equal(await (await call(convo, "/clear")).text(), "cleared");
    assert.deepEqual(await (await call(convo, "/get")).json(), {
      history: [],
      tokenCount: 0,
      modelUsage: {},
    });
  });

  it("unknown routes 404", async () => {
    const convo = makeConvo();
    assert.equal((await call(convo, "/nope")).status, 404);
  });
});
