import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { generateReply, summarizeConversation, callLLM } from "../src/ai.js";

function mockFetch(routes) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    for (const [match, handler] of routes) {
      if (u.includes(match)) {
        return handler(calls.length - 1);
      }
    }
    return new Response("unexpected fetch", { status: 500 });
  };
  return { realFetch, calls };
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// Helper: an OpenAI-compatible completion body.
function completion(text, tokens = 10) {
  return {
    choices: [{ message: { content: text } }],
    usage: { total_tokens: tokens },
  };
}

// Helper: a completion with a tool call and no text content.
function toolCompletion(name, args, tokens = 12) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
    usage: { total_tokens: tokens },
  };
}

function makeEnv(overrides = {}) {
  return {
    INCEPTION_API_KEY: "incep-key",
    GROQ_API_KEY: "groq-key",
    AI: {
      run: async () => ({ response: "granite reply" }),
    },
    ...overrides,
  };
}

describe("generateReply provider router", () => {
  afterEach(() => {
    // restore happens in the specific tests; avoid leaking if not set
  });

  it("uses Mercury 3 first with the right endpoint and model", async () => {
    const { realFetch, calls } = mockFetch([
      ["api.inceptionlabs.ai", () => json(completion("mercury hello"))],
    ]);
    try {
      const out = await generateReply([{ role: "user", content: "hi" }], makeEnv());
      assert.equal(out.text, "mercury hello");
      assert.equal(out.provider, "inception");
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.includes("api.inceptionlabs.ai/v1/chat/completions"));
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.model, "mercury-3");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("falls back to Groq when Mercury fails (500)", async () => {
    const { realFetch, calls } = mockFetch([
      ["api.inceptionlabs.ai", () => new Response("boom", { status: 500 })],
      ["api.groq.com", () => json(completion("groq hello"))],
    ]);
    try {
      const out = await generateReply([{ role: "user", content: "hi" }], makeEnv());
      assert.equal(out.text, "groq hello");
      assert.equal(out.provider, "groq");
      assert.equal(calls.length, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("falls back to Workers AI when Mercury and Groq fail", async () => {
    const { realFetch, calls } = mockFetch([
      ["api.inceptionlabs.ai", () => new Response("boom", { status: 500 })],
      ["api.groq.com", () => new Response("boom", { status: 500 })],
    ]);
    let aiCalls = 0;
    const env = makeEnv({
      AI: { run: async () => (aiCalls++, { response: "granite hello" }) },
    });
    try {
      const out = await generateReply([{ role: "user", content: "hi" }], env);
      assert.equal(out.text, "granite hello");
      assert.equal(out.provider, "workers-ai");
      assert.equal(aiCalls, 1);
      assert.equal(calls.length, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("skips Workers AI when there is no AI binding (does not crash)", async () => {
    const { realFetch } = mockFetch([
      ["api.inceptionlabs.ai", () => new Response("boom", { status: 500 })],
      ["api.groq.com", () => new Response("boom", { status: 500 })],
    ]);
    const env = makeEnv({ AI: undefined });
    try {
      await assert.rejects(
        () => generateReply([{ role: "user", content: "hi" }], env),
        /all providers failed|inception|groq/i
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("throws an aggregate error when every provider fails", async () => {
    const { realFetch } = mockFetch([
      ["api.inceptionlabs.ai", () => new Response("boom", { status: 500 })],
      ["api.groq.com", () => new Response("boom", { status: 500 })],
    ]);
    const env = makeEnv({
      AI: { run: async () => { throw new Error("workers down"); } },
    });
    try {
      await assert.rejects(
        () => generateReply([{ role: "user", content: "hi" }], env),
        /all providers failed/i
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("summarizeConversation routes through the same providers", async () => {
    const { realFetch } = mockFetch([
      ["api.inceptionlabs.ai", () => json(completion("summary text", 5))],
    ]);
    try {
      const out = await summarizeConversation(
        [{ role: "user", content: "long history" }],
        makeEnv()
      );
      assert.equal(out.text, "summary text");
      assert.equal(out.provider, "inception");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("callLLM returns the raw assistant message including tool_calls", async () => {
    const { realFetch, calls } = mockFetch([
      ["api.inceptionlabs.ai", () => json(toolCompletion("search", { query: "mc update" }))],
    ]);
    try {
      const out = await callLLM([{ role: "user", content: "what's new?" }], makeEnv());
      assert.equal(out.provider, "inception");
      assert.equal(out.message.role, "assistant");
      assert.equal(out.message.content, null);
      assert.ok(Array.isArray(out.message.tool_calls));
      assert.equal(out.message.tool_calls[0].function.name, "search");
      const body = JSON.parse(calls[0].init.body);
      assert.ok(body.messages, "messages must be present");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("callLLM passes tools through to the provider when opts.tools set", async () => {
    const { realFetch, calls } = mockFetch([
      ["api.inceptionlabs.ai", () => json(completion("done"))],
    ]);
    try {
      const tools = [{ type: "function", function: { name: "search" } }];
      await callLLM([{ role: "user", content: "hi" }], makeEnv(), { tools });
      const body = JSON.parse(calls[0].init.body);
      assert.deepEqual(body.tools, tools);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
