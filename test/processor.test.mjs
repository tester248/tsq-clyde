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
      WUS_API_KEY: "test-wus-key",
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

describe("processMessage WUS escalation output", () => {
  function mockRefusalThenWus(discordBodies) {
    const refusal = () => Response.json({
      choices: [{ message: { role: "assistant", content: "I can't help with that." } }],
      usage: { total_tokens: 2 },
    });
    return async (url, init) => {
      const u = String(url);
      if (u.includes("api.inceptionlabs.ai")) return refusal();
      if (u.includes("api.groq.com")) return refusal();
      if (u.includes("wusrouter.com")) {
        return Response.json({
          choices: [{ message: { role: "assistant", content: "the uncensored answer" } }],
          usage: { total_tokens: 4 },
        });
      }
      if (u.includes("discord.com/api")) {
        discordBodies.push(JSON.parse(init.body));
        return Response.json({ id: "mid" });
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
  }

  it("stores a sanitized placeholder in history for a WUS answer", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = mockRefusalThenWus([]);
    try {
      const { env, convo } = makeEnv();
      await processMessage({ channel_id: "C1", guild_id: "G1", user_id: "U1", content: "spicy question" }, env);
      const state = await (await convo.fetch(new Request("https://example.com/get"))).json();
      const assistantEntry = state.history.find((h) => h.role === "assistant");
      assert.equal(assistantEntry.content, "[provided a direct answer]");
      assert.ok(!JSON.stringify(state.history).includes("the uncensored answer"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("prefixes the channel reply with [uncensored answer]", async () => {
    const realFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = mockRefusalThenWus(bodies);
    try {
      const { env } = makeEnv();
      await processMessage({ channel_id: "C1", guild_id: "G1", user_id: "U1", content: "spicy question" }, env);
      assert.equal(bodies.length, 1);
      assert.ok(
        bodies[0].content.startsWith("[uncensored answer]"),
        `got: ${bodies[0].content}`
      );
      assert.ok(bodies[0].content.includes("the uncensored answer"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("never sends the raw sentinel to Discord when every provider declines", async () => {
    const realFetch = globalThis.fetch;
    const bodies = [];
    const sentinel = () => Response.json({
      choices: [{ message: { role: "assistant", content: "##REFUSED##" } }],
      usage: { total_tokens: 2 },
    });
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("api.inceptionlabs.ai")) return sentinel();
      if (u.includes("api.groq.com")) return sentinel();
      if (u.includes("wusrouter.com")) return sentinel();
      if (u.includes("discord.com/api")) {
        bodies.push(JSON.parse(init.body));
        return Response.json({ id: "mid" });
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    try {
      const { env, convo } = makeEnv();
      await processMessage({ channel_id: "C1", guild_id: "G1", user_id: "U1", content: "anything" }, env);
      assert.equal(bodies.length, 1);
      assert.ok(
        !bodies[0].content.includes("##REFUSED##"),
        `sentinel leaked to channel: ${bodies[0].content}`
      );
      assert.ok(bodies[0].content.length > 0, "expected a non-empty reply");
      const state = await (await convo.fetch(new Request("https://example.com/get"))).json();
      const assistantEntry = state.history.find((h) => h.role === "assistant");
      assert.ok(
        !assistantEntry.content.includes("##REFUSED##"),
        `sentinel leaked into history: ${assistantEntry.content}`
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("leaves a normal Mercury answer untagged and verbatim in history", async () => {
    const realFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("api.inceptionlabs.ai")) {
        return Response.json({
          choices: [{ message: { role: "assistant", content: "a normal answer" } }],
          usage: { total_tokens: 3 },
        });
      }
      if (u.includes("discord.com/api")) {
        bodies.push(JSON.parse(init.body));
        return Response.json({ id: "mid" });
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    try {
      const { env, convo } = makeEnv();
      await processMessage({ channel_id: "C1", guild_id: "G1", user_id: "U1", content: "normal question" }, env);
      assert.equal(bodies[0].content, "a normal answer");
      const state = await (await convo.fetch(new Request("https://example.com/get"))).json();
      const assistantEntry = state.history.find((h) => h.role === "assistant");
      assert.equal(assistantEntry.content, "a normal answer");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("processMessage clear-context admin gate", () => {
  const ADMIN = "809430270897160202";
  const NON_ADMIN = "111111111111111111";

  function makeEnvWithAdmins(admins) {
    return makeEnv({ ADMIN_IDS: admins });
  }

  async function historyLength(convo) {
    const state = await (await convo.fetch(new Request("https://example.com/get"))).json();
    return (state.history || []).length;
  }

  it("lets an admin clear the channel context", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("no network expected for clear"); };
    try {
      const { env, convo } = makeEnvWithAdmins(ADMIN);
      // seed some history
      await convo.fetch(
        new Request("https://example.com/append", {
          method: "POST",
          body: JSON.stringify({ role: "user", content: "hello", timestamp: Date.now() }),
        })
      );
      assert.ok((await historyLength(convo)) > 0);

      const out = await processMessage(
        { channel_id: "C1", guild_id: "G1", user_id: ADMIN, content: "clear context" },
        env
      );
      assert.match(out.reply, /cleared/i);
      assert.equal(await historyLength(convo), 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses a non-admin clear and leaves history intact", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("no network expected for refused clear"); };
    try {
      const { env, convo } = makeEnvWithAdmins(ADMIN);
      await convo.fetch(
        new Request("https://example.com/append", {
          method: "POST",
          body: JSON.stringify({ role: "user", content: "hello", timestamp: Date.now() }),
        })
      );
      const before = await historyLength(convo);

      const out = await processMessage(
        { channel_id: "C1", guild_id: "G1", user_id: NON_ADMIN, content: "clear context" },
        env
      );
      assert.match(out.reply, /only admins/i);
      assert.equal(await historyLength(convo), before);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("fails closed when ADMIN_IDS is unset", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("no network expected"); };
    try {
      const { env, convo } = makeEnv();
      const out = await processMessage(
        { channel_id: "C1", guild_id: "G1", user_id: ADMIN, content: "clear context" },
        env
      );
      assert.match(out.reply, /only admins/i);
      assert.equal(await historyLength(convo), 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("accepts comma-separated admins with whitespace", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("no network expected"); };
    try {
      const { env } = makeEnvWithAdmins(`  ${NON_ADMIN} , ${ADMIN} `);
      const out = await processMessage(
        { channel_id: "C1", guild_id: "G1", user_id: ADMIN, content: "forget" },
        env
      );
      assert.match(out.reply, /cleared/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("triggers on a clear phrase embedded in a longer message", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("no network expected"); };
    try {
      const { env } = makeEnvWithAdmins(ADMIN);
      const out = await processMessage(
        { channel_id: "C1", guild_id: "G1", user_id: ADMIN, content: "hey klyde please clear context now" },
        env
      );
      assert.match(out.reply, /cleared/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not treat ordinary chat about forgetting as a clear", async () => {
    const realFetch = globalThis.fetch;
    let llmCalled = false;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("api.inceptionlabs.ai")) {
        llmCalled = true;
        return Response.json({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { total_tokens: 2 },
        });
      }
      if (u.includes("discord.com/api")) return Response.json({ id: "mid" });
      throw new Error(`unexpected fetch: ${u}`);
    };
    try {
      const { env } = makeEnvWithAdmins(ADMIN);
      await processMessage(
        { channel_id: "C1", guild_id: "G1", user_id: ADMIN, content: "what if I forget my password" },
        env
      );
      assert.equal(llmCalled, true, "should have answered normally, not cleared");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("processMessage history compaction", () => {
  it("summarizes and resets history when the token cap is exceeded", async () => {
    const realFetch = globalThis.fetch;
    const llmBodies = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("api.inceptionlabs.ai")) {
        llmBodies.push(JSON.parse(init.body));
        const isSummary = JSON.stringify(llmBodies.at(-1).messages).includes(
          "concise summary of the conversation"
        );
        return Response.json({
          choices: [
            { message: { role: "assistant", content: isSummary ? "SUMMARY TEXT" : "answered" } },
          ],
          usage: { total_tokens: 3 },
        });
      }
      if (u.includes("discord.com/api")) return Response.json({ id: "mid" });
      throw new Error(`unexpected fetch: ${u}`);
    };
    try {
      const { env, convo } = makeEnv();
      // Seed history past the 2000-token cap (~4 chars/token).
      for (let i = 0; i < 6; i++) {
        await convo.fetch(
          new Request("https://example.com/append", {
            method: "POST",
            body: JSON.stringify({
              role: "user",
              content: "x".repeat(1600),
              timestamp: Date.now(),
            }),
          })
        );
      }
      await processMessage(
        { channel_id: "C1", guild_id: "G1", user_id: "U1", content: "new question" },
        env
      );

      const state = await (await convo.fetch(new Request("https://example.com/get"))).json();
      // Compaction ran: a summary exists and the raw history was reset.
      assert.equal(state.summary, "SUMMARY TEXT");
      assert.ok(
        state.history.length <= 2,
        `history should be reset after compaction, got ${state.history.length}`
      );
      assert.ok(
        llmBodies.some((b) => JSON.stringify(b.messages).includes("concise summary")),
        "expected a summarize call"
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not clear the channel context on compaction", async () => {
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
      for (let i = 0; i < 6; i++) {
        await convo.fetch(
          new Request("https://example.com/append", {
            method: "POST",
            body: JSON.stringify({ role: "user", content: "x".repeat(1600), timestamp: Date.now() }),
          })
        );
      }
      await processMessage(
        { channel_id: "C1", guild_id: "G1", user_id: "U1", content: "q" },
        env
      );
      const state = await (await convo.fetch(new Request("https://example.com/get"))).json();
      // Compaction keeps a summary — it must not wipe the DO like a clear does.
      assert.ok(state.summary, "summary must survive compaction");
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

describe("processMessage bounded memory prompt injection", () => {
  const llmMessages = (capture) => {
    const realFetch = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("api.inceptionlabs.ai")) {
        captured = JSON.parse(init.body).messages;
        return Response.json({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { total_tokens: 3 },
        });
      }
      if (u.includes("discord.com/api")) return Response.json({ id: "mid" });
      throw new Error(`unexpected fetch: ${u}`);
    };
    return async () => {
      try {
        await capture();
        return captured;
      } finally {
        globalThis.fetch = realFetch;
      }
    };
  };

  const seedMemory = (convo, memory) =>
    convo.fetch(
      new Request("https://example.com/setMemory", {
        method: "POST",
        body: JSON.stringify({ memory }),
      })
    );
  const seedProfile = (convo, userId, profile) =>
    convo.fetch(
      new Request("https://example.com/setUserProfile", {
        method: "POST",
        body: JSON.stringify({ userId, profile }),
      })
    );

  it("injects channel memory and the current asker's profile as labeled system blocks", async () => {
    const { env, convo } = makeEnv();
    await seedMemory(convo, "server runs ports 3000-3005");
    await seedProfile(convo, "U1", "prefers terse dot-points");
    const getMessages = llmMessages(() =>
      processMessage(
        { channel_id: "C1", guild_id: "G1", user_id: "U1", content: "hello" },
        env
      )
    );
    const messages = await getMessages();

    const memBlock = messages.find(
      (m) => m.role === "system" && m.content.startsWith("MEMORY (channel notes)")
    );
    assert.ok(memBlock, "expected a channel memory system block");
    assert.match(memBlock.content, /\[27\/2200 chars\]/);
    assert.ok(memBlock.content.includes("server runs ports 3000-3005"));

    const profileBlock = messages.find(
      (m) => m.role === "system" && m.content.startsWith("USER PROFILE")
    );
    assert.ok(profileBlock, "expected a user profile system block");
    assert.match(profileBlock.content, /\[24\/1375 chars\]/);
    assert.ok(profileBlock.content.includes("prefers terse dot-points"));
  });

  it("omits both blocks when memory and profile are empty", async () => {
    const { env } = makeEnv();
    const getMessages = llmMessages(() =>
      processMessage(
        { channel_id: "C1", guild_id: "G1", user_id: "U1", content: "hello" },
        env
      )
    );
    const messages = await getMessages();
    assert.ok(
      !messages.some(
        (m) =>
          m.role === "system" &&
          (m.content.startsWith("MEMORY (channel notes)") || m.content.startsWith("USER PROFILE"))
      ),
      "no memory/profile blocks expected for empty stores"
    );
  });

  it("only injects the profile of the current asker", async () => {
    const { env, convo } = makeEnv();
    await seedProfile(convo, "U1", "likes short answers");

    const getMessages = (userId) =>
      llmMessages(() =>
        processMessage(
          { channel_id: "C1", guild_id: "G1", user_id: userId, content: "hello" },
          env
        )
      );
    const others = await getMessages("U2")();
    assert.ok(
      !others.some((m) => m.role === "system" && m.content.startsWith("USER PROFILE")),
      "U2 must not see U1's profile"
    );
    const self = await getMessages("U1")();
    assert.ok(
      self.some((m) => m.role === "system" && m.content.startsWith("USER PROFILE")),
      "U1 should see their own profile"
    );
  });
});

describe("processMessage bounded memory tool plumbing", () => {
  it("routes the agent's memory tool call to the real ConversationDO", async () => {
    const realFetch = globalThis.fetch;
    let llmCalls = 0;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("api.inceptionlabs.ai")) {
        llmCalls++;
        if (llmCalls === 1) {
          // Model decides to remember a fact via the memory tool.
          return Response.json({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "memory",
                        arguments: JSON.stringify({
                          target: "memory",
                          operations: [{ action: "add", content: "klyde ships every friday" }],
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { total_tokens: 4 },
          });
        }
        return Response.json({
          choices: [{ message: { role: "assistant", content: "noted! 🌱" } }],
          usage: { total_tokens: 2 },
        });
      }
      if (u.includes("discord.com/api")) return Response.json({ id: "mid" });
      throw new Error(`unexpected fetch: ${u}`);
    };
    try {
      const { env, convo } = makeEnv();
      const out = await processMessage(
        { channel_id: "C1", guild_id: "G1", user_id: "U1", content: "keep this fact in mind" },
        env
      );
      assert.equal(out.reply, "noted! 🌱");
      const state = await (await convo.fetch(new Request("https://example.com/get"))).json();
      assert.ok(
        state.memory.includes("klyde ships every friday"),
        `memory tool result did not reach the DO: ${JSON.stringify(state.memory)}`
      );
      assert.ok(llmCalls >= 2, "expected at least two LLM calls (tool + final)");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
