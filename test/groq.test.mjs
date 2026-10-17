import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MODELS, selectModel } from "../src/groq.js";

// General-purpose chat models usable for replies. Deliberately excludes:
//   - whisper-*                speech-to-text (no context window, no text output)
//   - meta-llama/llama-prompt-guard-*  classifiers: text in, "safe"/"unsafe"
//                               verdict out. Text-out but not a chat model.
//   - openai/gpt-oss-safeguard-20b    safety classifier, same reason
const CHAT_MODELS = new Set([
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b",
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile",
]);

// Model families that must never be selected for a reply, whatever their
// input/output modalities say.
const NON_CHAT_PREFIXES = ["whisper", "meta-llama/llama-prompt-guard", "openai/gpt-oss-safeguard"];

describe("selectModel", () => {
  it("every selectable model is a general-purpose chat model", () => {
    for (const m of MODELS) {
      assert.ok(CHAT_MODELS.has(m), `${m} is not a known chat model`);
      for (const p of NON_CHAT_PREFIXES) {
        assert.ok(!m.startsWith(p), `${m} is a non-chat model (${p})`);
      }
    }
  });

  it("uses the primary chat model while quota remains", () => {
    assert.equal(selectModel({}), MODELS[0]);
    assert.equal(selectModel({ a: 99000 }), MODELS[0]);
  });

  it("falls back to qwen, never a speech model, when exhausted", () => {
    const fallback = selectModel({ a: 99001 });
    assert.equal(fallback, "qwen/qwen3.8-27b");
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

  it("switches exactly at the quota threshold", () => {
    assert.equal(selectModel({ a: 98999 }), "openai/gpt-oss-120b");
    assert.equal(selectModel({ a: 99000 }), "openai/gpt-oss-120b");
    assert.equal(selectModel({ a: 99001 }), "qwen/qwen3.8-27b");
  });

  it("never selects a classifier or speech model at any usage level", () => {
    for (const used of [0, 50000, 99000, 99001, 150000, 1e9]) {
      const m = selectModel({ a: used });
      for (const p of NON_CHAT_PREFIXES) {
        assert.ok(!m.startsWith(p), `usage ${used} selected ${m}`);
      }
    }
  });

  it("prompt-guard models are excluded even though they take and return text", () => {
    // Regression guard: these are classifiers, not chat models.
    assert.ok(!CHAT_MODELS.has("meta-llama/llama-prompt-guard-2-86m"));
    assert.ok(!CHAT_MODELS.has("meta-llama/llama-prompt-guard-2-22m"));
    assert.ok(!CHAT_MODELS.has("openai/gpt-oss-safeguard-20b"));
  });
});