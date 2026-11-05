import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { processMessage } from "../src/processor.js";
import { ConversationDO } from "../src/conversation_do.js";

function makeConvo() {
  const mem = new Map();
  return new ConversationDO(
    {
      storage: {
        get: async (k) => mem.get(k) ?? null,
        put: async (k, v) => void mem.set(k, v),
      },
    },
    {}
  );
}

function makeEnv(overrides = {}) {
  const convo = makeConvo();
  const kv = new Map();
  return {
    env: {
      INCEPTION_API_KEY: "test-inception-key",
      GROQ_API_KEY: "test-groq-key",
      TAVILY_API_KEY: "test-tavily-key",
      CONVERSATION_DO: {
        idFromName: (n) => n,
        get: () => ({ fetch: (url, init) => convo.fetch(new Request(url, init)) }),
      },
      LAST_MESSAGE_KV: {
        get: async (k) => kv.get(k) ?? null,
        put: async (k, v) => void kv.set(k, v),
      },
      ...overrides,
    },
    kv,
    convo,
  };
}

describe("processMessage agent path", () => {
  it("returns reply + provider for a normal (no-tool) message", async () => {
    const realFetch = globalThis.fetch;
    const discordPosts = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("api.inceptionlabs.ai")) {
        // Mercury returns a plain text answer.
        return Response.json({
          choices: [{ message: { role: "assistant", content: "plain answer" } }],
          usage: { total_tokens: 5 },
        });
      }
      if (u.includes("discord.com/api")) {
        discordPosts.push(u);
        return Response.json({ id: "mid" });
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    try {
      const { env } = makeEnv();
      const out = await processMessage(
        { channel_id: "C1", guild_id: "G1", user_id: "U1", content: "hello" },
        env
      );
      assert.equal(out.reply, "plain answer");
      assert.equal(out.provider, "inception");
      assert.equal(discordPosts.length, 1); // non-interaction posts to channel
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("processMessage author attribution", () => {
  it("records the author in history entries", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("api.inceptionlabs.ai")) {
        return Response.json({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { total_tokens: 3 },
        });
      }
      if (u.includes("discord.com/api")) return Response.json({ id: "mid" });
      throw new Error(`unexpected fetch: ${u}`);
    };
    try {
      const { env, convo } = makeEnv();
      await processMessage(
        { channel_id: "C1", guild_id: "G1", user_id: "U1", username: "Alice", content: "hi" },
        env
      );
      const resp = await convo.fetch(new Request("https://example.com/get"));
      const state = await resp.json();
      const userEntry = state.history.find((h) => h.role === "user");
      assert.equal(userEntry.author.name, "Alice");
      assert.equal(userEntry.author.id, "U1");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("prefixes the author name in the LLM prompt", async () => {
    const realFetch = globalThis.fetch;
    let llmMessages = null;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("api.inceptionlabs.ai")) {
        llmMessages = JSON.parse(init.body).messages;
        return Response.json({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { total_tokens: 3 },
        });
      }
      if (u.includes("discord.com/api")) return Response.json({ id: "mid" });
      throw new Error(`unexpected fetch: ${u}`);
    };
    try {
      const { env } = makeEnv();
      await processMessage(
        { channel_id: "C1", guild_id: "G1", user_id: "U1", username: "Alice", content: "how many subs?" },
        env
      );
      const lastUser = llmMessages.filter((m) => m.role === "user").pop();
      assert.ok(lastUser.content.startsWith("[Alice]"), `got: ${lastUser.content}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("processMessage reply threading", () => {
  function mockFetch(discordBodies) {
    return async (url, init) => {
      const u = String(url);
      if (u.includes("api.inceptionlabs.ai")) {
        return Response.json({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { total_tokens: 3 },
        });
      }
      if (u.includes("discord.com/api")) {
        discordBodies.push(JSON.parse(init.body));
        return Response.json({ id: "mid" });
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
  }

  it("threads under the mention when message_id is present, no ping by default", async () => {
    const realFetch = globalThis.fetch;
    const discordBodies = [];
    globalThis.fetch = mockFetch(discordBodies);
    try {
      const { env } = makeEnv();
      await processMessage(
        { channel_id: "C1", guild_id: "G1", user_id: "U1", username: "Alice", message_id: "M1", content: "hi" },
        env
      );
      assert.equal(discordBodies[0].message_reference.message_id, "M1");
      assert.equal(discordBodies[0].allowed_mentions.replied_user, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("pings the author when PING_AUTHOR is true", async () => {
    const realFetch = globalThis.fetch;
    const discordBodies = [];
    globalThis.fetch = mockFetch(discordBodies);
    try {
      const { env } = makeEnv({ PING_AUTHOR: "true" });
      await processMessage(
        { channel_id: "C1", guild_id: "G1", user_id: "U1", username: "Alice", message_id: "M1", content: "hi" },
        env
      );
      assert.equal(discordBodies[0].allowed_mentions.replied_user, true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not thread when message_id absent", async () => {
    const realFetch = globalThis.fetch;
    const discordBodies = [];
    globalThis.fetch = mockFetch(discordBodies);
    try {
      const { env } = makeEnv();
      await processMessage(
        { channel_id: "C1", guild_id: "G1", user_id: "U1", content: "hi" },
        env
      );
      assert.equal(discordBodies[0].message_reference, undefined);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
