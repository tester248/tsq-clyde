import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MODELS, selectModel } from "../src/groq.js";

// Models that Groq serves on /v1/chat/completions. Whisper models are
// speech-to-text only (no context window, no text output) and must never
// be selected for a chat reply.
const CHAT_MODELS = new Set([
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile",
]);

describe("selectModel", () => {
  it("every selectable model is a text chat model", () => {
    for (const m of MODELS) {
      assert.ok(CHAT_MODELS.has(m), `${m} is not a known chat model`);
      assert.ok(!m.startsWith("whisper"), `${m} is a speech model`);
    }
  });

  it("uses the primary chat model while quota remains", () => {
    assert.equal(selectModel({}), MODELS[0]);
    assert.equal(selectModel({ a: 99000 }), MODELS[0]);
  });

  it("falls back to another chat model, never a speech model, when exhausted", () => {
    const fallback = selectModel({ a: 99001 });
    assert.notEqual(fallback, MODELS[0]);
    assert.ok(CHAT_MODELS.has(fallback), `fallback ${fallback} is not a chat model`);
    assert.ok(!fallback.startsWith("whisper"));
  });

  it("stays a chat model across all usage levels", () => {
    for (const used of [0, 50000, 99000, 99001, 150000, 1e9]) {
      const m = selectModel({ a: used });
      assert.ok(CHAT_MODELS.has(m), `usage ${used} selected ${m}`);
    }
  });
});