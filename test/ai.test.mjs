import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { generateReply, summarizeConversation, callLLM, isRefusal } from "../src/ai.js";

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
    WUS_API_KEY: "wus-key",
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

  it("falls back to Workers AI when Mercury, Groq and WUS fail", async () => {
    const { realFetch, calls } = mockFetch([
      ["api.inceptionlabs.ai", () => new Response("boom", { status: 500 })],
      ["api.groq.com", () => new Response("boom", { status: 500 })],
      ["wusrouter.com", () => new Response("boom", { status: 500 })],
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
      assert.equal(calls.length, 3);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("falls back to WUS router when Mercury and Groq fail", async () => {
    const { realFetch, calls } = mockFetch([
      ["api.inceptionlabs.ai", () => new Response("boom", { status: 500 })],
      ["api.groq.com", () => new Response("boom", { status: 500 })],
      ["wusrouter.com", () => json(completion("wus hello"))],
    ]);
    try {
      const out = await generateReply([{ role: "user", content: "hi" }], makeEnv());
      assert.equal(out.text, "wus hello");
      assert.equal(out.provider, "wus");
      assert.equal(calls.length, 3);
      assert.ok(calls[2].url.includes("wusrouter.com/v1/chat/completions"));
      const body = JSON.parse(calls[2].init.body);
      assert.equal(body.model, "uncensored/deepseek-v4.1-flash:free");
      assert.equal(calls[2].init.headers.Authorization, "Bearer wus-key");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("continues to Workers AI when WUS router fails too", async () => {
    const { realFetch, calls } = mockFetch([
      ["api.inceptionlabs.ai", () => new Response("boom", { status: 500 })],
      ["api.groq.com", () => new Response("boom", { status: 500 })],
      ["wusrouter.com", () => new Response("boom", { status: 500 })],
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
      assert.equal(calls.length, 3);
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

describe("callLLM refusal escalation", () => {
  const refuse = () => json(completion("I can't help with that request."));

  it("escalates from Mercury to Groq on a refusal", async () => {
    const { realFetch, calls } = mockFetch([
      ["api.inceptionlabs.ai", refuse],
      ["api.groq.com", () => json(completion("groq answered"))],
    ]);
    try {
      const out = await callLLM([{ role: "user", content: "q" }], makeEnv());
      assert.equal(out.provider, "groq");
      assert.equal(out.message.content, "groq answered");
      assert.equal(calls.length, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("escalates to WUS when Mercury and Groq both refuse", async () => {
    const { realFetch, calls } = mockFetch([
      ["api.inceptionlabs.ai", refuse],
      ["api.groq.com", refuse],
      ["wusrouter.com", () => json(completion("wus answered"))],
    ]);
    try {
      const out = await callLLM([{ role: "user", content: "q" }], makeEnv());
      assert.equal(out.provider, "wus");
      assert.equal(out.message.content, "wus answered");
      assert.equal(calls.length, 3);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("returns the last non-empty response when every provider refuses", async () => {
    const { realFetch } = mockFetch([
      ["api.inceptionlabs.ai", refuse],
      ["api.groq.com", refuse],
      ["wusrouter.com", () => json(completion("wus refusal too"))],
    ]);
    const env = makeEnv({ AI: { run: async () => ({ response: "" }) } });
    try {
      const out = await callLLM([{ role: "user", content: "q" }], env);
      assert.equal(out.message.content, "wus refusal too");
      assert.equal(out.provider, "wus");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("never leaks the raw sentinel when every provider refuses via sentinel", async () => {
    const { realFetch } = mockFetch([
      ["api.inceptionlabs.ai", () => json(completion("##REFUSED##"))],
      ["api.groq.com", () => json(completion("##REFUSED##"))],
      ["wusrouter.com", () => json(completion("##REFUSED##"))],
    ]);
    const env = makeEnv({ AI: { run: async () => ({ response: "" }) } });
    try {
      const out = await callLLM([{ role: "user", content: "q" }], env);
      assert.ok(out.message.content, "expected a non-empty final message");
      assert.ok(
        !out.message.content.includes("##REFUSED##"),
        `sentinel leaked to user: ${out.message.content}`
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("escalates through sentinel refusals to a real answer", async () => {
    const { realFetch, calls } = mockFetch([
      ["api.inceptionlabs.ai", () => json(completion("##REFUSED##"))],
      ["api.groq.com", () => json(completion("groq answered"))],
    ]);
    try {
      const out = await callLLM([{ role: "user", content: "q" }], makeEnv());
      assert.equal(out.provider, "groq");
      assert.equal(out.message.content, "groq answered");
      assert.equal(calls.length, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("preserves the last prose refusal when later tiers decline via sentinel", async () => {
    const { realFetch } = mockFetch([
      ["api.inceptionlabs.ai", () => json(completion("I can't help with that."))],
      ["api.groq.com", () => json(completion("##REFUSED##"))],
      ["wusrouter.com", () => json(completion("##REFUSED##"))],
    ]);
    const env = makeEnv({ AI: { run: async () => ({ response: "" }) } });
    try {
      const out = await callLLM([{ role: "user", content: "q" }], env);
      assert.equal(out.message.content, "I can't help with that.");
      assert.equal(out.provider, "inception");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not escalate a normal Mercury answer", async () => {
    const { realFetch, calls } = mockFetch([
      ["api.inceptionlabs.ai", () => json(completion("a real answer"))],
    ]);
    try {
      const out = await callLLM([{ role: "user", content: "q" }], makeEnv());
      assert.equal(out.provider, "inception");
      assert.equal(out.message.content, "a real answer");
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not treat a tool-call round as a refusal", async () => {
    const { realFetch, calls } = mockFetch([
      ["api.inceptionlabs.ai", () => json(toolCompletion("search", { query: "x" }))],
    ]);
    try {
      const out = await callLLM([{ role: "user", content: "q" }], makeEnv());
      assert.equal(out.provider, "inception");
      assert.ok(Array.isArray(out.message.tool_calls));
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("isRefusal", () => {
  it("detects common refusal phrasings", () => {
    assert.equal(isRefusal({ role: "assistant", content: "I can't help with that." }), true);
    assert.equal(isRefusal({ role: "assistant", content: "I'm unable to assist with this request." }), true);
    assert.equal(isRefusal({ role: "assistant", content: "As an AI language model, I cannot provide that." }), true);
    assert.equal(isRefusal({ role: "assistant", content: "I won't help with that." }), true);
    assert.equal(isRefusal({ role: "assistant", content: "I cannot discuss this topic." }), true);
  });

  it("detects the sentinel token", () => {
    assert.equal(isRefusal({ role: "assistant", content: "##REFUSED##" }), true);
    assert.equal(isRefusal({ role: "assistant", content: "  ##REFUSED##  " }), true);
    assert.equal(isRefusal({ role: "assistant", content: "##REFUSED##\n" }), true);
  });

  it("detects broader refusal verb forms seen in the wild", () => {
    assert.equal(isRefusal({ role: "assistant", content: "I'm sorry, but I can't write that." }), true);
    assert.equal(isRefusal({ role: "assistant", content: "I'm not able to create explicit content." }), true);
    assert.equal(isRefusal({ role: "assistant", content: "I won't write that for you." }), true);
    assert.equal(isRefusal({ role: "assistant", content: "I can't generate that." }), true);
    assert.equal(isRefusal({ role: "assistant", content: "I cannot provide the home address of a private individual." }), true);
    assert.equal(isRefusal({ role: "assistant", content: "I'd rather not go into that." }), true);
  });

  it("detects refusals behind smart quotes and unicode punctuation", () => {
    // Mojibake / smart apostrophes must normalize before matching.
    assert.equal(isRefusal({ role: "assistant", content: "I\u2019m sorry, but I can\u2019t help with that." }), true);
    assert.equal(isRefusal({ role: "assistant", content: "I\u2019m unable to assist." }), true);
    assert.equal(isRefusal({ role: "assistant", content: "I can\u2019t write that." }), true);
  });

  it("does not flag a normal answer", () => {
    assert.equal(
      isRefusal({ role: "assistant", content: "The 26.2 update adds copper golems and new biomes." }),
      false
    );
  });

  it("does not flag an answer that merely mentions inability in passing", () => {
    assert.equal(
      isRefusal({
        role: "assistant",
        content: "I can't read your mind, but here's how the copper golem works: it presses buttons.",
      }),
      false
    );
  });

  it("does not flag a tool-call message", () => {
    const msg = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "search", arguments: "{}" } }],
    };
    assert.equal(isRefusal(msg), false);
  });

  it("treats empty content as a refusal", () => {
    assert.equal(isRefusal({ role: "assistant", content: "" }), true);
    assert.equal(isRefusal({ role: "assistant", content: null }), true);
    assert.equal(isRefusal(null), true);
  });
});
