import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { processMinecraftInvocation, formatGameChat } from "../src/processor.js";
import { ConversationDO } from "../src/conversation_do.js";

function makeConvo() {
  const mem = new Map();
  return new ConversationDO(
    { storage: { get: async (k) => mem.get(k) ?? null, put: async (k, v) => void mem.set(k, v) } },
    {}
  );
}

// Same shape as processor.test.mjs makeEnv, plus a fake MINECRAFT_BRIDGE_DO
// binding with a canned roster.
function makeEnv({ roster = [] } = {}) {
  const convo = makeConvo();
  const bridgeStub = {
    fetch: async (url) => {
      if (String(url).includes("/rosterGet")) return Response.json({ mods: roster });
      return new Response("not found", { status: 404 });
    },
  };
  return {
    env: {
      INCEPTION_API_KEY: "test-inception-key",
      GROQ_API_KEY: "test-groq-key",
      WUS_API_KEY: "test-wus-key",
      CONVERSATION_DO: {
        idFromName: (n) => n,
        get: () => ({ fetch: (url, init) => convo.fetch(new Request(url, init)) }),
      },
      MINECRAFT_BRIDGE_DO: {
        idFromName: () => "minecraft",
        get: () => bridgeStub,
      },
    },
    convo,
  };
}

describe("formatGameChat", () => {
  it("strips markdown artifacts and collapses whitespace", () => {
    const out = formatGameChat("# Heading\n- bullet one\n- bullet two\nplain text");
    assert.equal(out.length, 1);
    assert.ok(out[0].includes("Heading"));
    assert.ok(out[0].includes("bullet one"));
    assert.ok(out[0].includes("plain"));
    assert.ok(!out[0].includes("#"));
    assert.ok(!out[0].includes("- bullet"));
  });

  it("chunks long replies at sentence boundaries, capped by maxChars", () => {
    const long = Array.from({ length: 15 }, (_, i) => `Sentence number ${i} has a bit of length to it.`).join(" ");
    const out = formatGameChat(long, { maxChars: 120, maxMessages: 10 });
    assert.ok(out.length > 1, "expected multiple chunks");
    for (const chunk of out) {
      assert.ok(chunk.length <= 120, `chunk too long: ${chunk.length}`);
    }
    assert.ok(out.length <= 10);
  });

  it("returns [] for empty text", () => {
    assert.deepEqual(formatGameChat("   "), []);
  });
});

describe("processMinecraftInvocation", () => {
  it("injects the mod roster summary into the prompt", async () => {
    const { env, convo } = makeEnv({
      roster: [
        { id: "aether", name: "The Aether", version: "1.0" },
        { id: "mythicmetals", name: "Mythic Metals", version: "2.0" },
      ],
    });
    let seenSystem = null;
    const fakeLoop = async ({ messages }) => {
      seenSystem = messages.find((m) => m.role === "system" && m.content.startsWith("Server mods"));
      return { text: "ok", provider: "inception", totalTokens: 3 };
    };
    const delivered = [];
    await processMinecraftInvocation({
      player: "Alice",
      text: "what mods add new mobs",
      deliver: (f) => delivered.push(f),
      env,
      runAgentLoop: fakeLoop,
    });
    assert.ok(seenSystem, "expected the roster system message");
    assert.ok(seenSystem.content.includes("The Aether"));
    assert.ok(seenSystem.content.includes("Mythic Metals"));
    const state = await (await convo.fetch(new Request("https://example.com/get"))).json();
    assert.equal(state.history.length, 2, "user + assistant appended");
  });

  it("delivers progress phases then reply chunks in order", async () => {
    const { env } = makeEnv();
    const fakeLoop = async ({ onPhase }) => {
      onPhase("search");
      onPhase("compose");
      return { text: "TPS is 20. Server is healthy. All good.", provider: "inception", totalTokens: 5 };
    };
    const delivered = [];
    await processMinecraftInvocation({
      player: "Bob",
      text: "klyde what is tps",
      deliver: (f) => delivered.push(f),
      env,
      runAgentLoop: fakeLoop,
    });
    const kinds = delivered.map((d) => d.kind);
    assert.deepEqual(kinds, ["phase", "phase", "reply"]);
    assert.match(delivered[0].text, /searching/);
    assert.match(delivered[1].text, /composing/);
    assert.match(delivered[2].text, /TPS is 20/);
  });

  it("does not deliver phases on the fast path (no tools)", async () => {
    const { env } = makeEnv();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes("api.inceptionlabs.ai")) {
        return Response.json({
          choices: [{ message: { role: "assistant", content: "hi" } }],
          usage: { total_tokens: 2 },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    try {
      const fakeLoop = async () => ({ text: "hi", provider: "inception", totalTokens: 2 });
      const delivered = [];
      await processMinecraftInvocation({
        player: "Bob",
        text: "hello",
        deliver: (f) => delivered.push(f),
        env,
        runAgentLoop: fakeLoop,
      });
      assert.deepEqual(delivered.map((d) => d.kind), ["reply"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("swaps a leaked sentinel for the friendly refusal", async () => {
    const { env } = makeEnv();
    const fakeLoop = async () => ({ text: "##REFUSED##", provider: "inception", totalTokens: 2 });
    const delivered = [];
    await processMinecraftInvocation({
      player: "Bob",
      text: "klyde how do i cheat",
      deliver: (f) => delivered.push(f),
      env,
      runAgentLoop: fakeLoop,
    });
    const replies = delivered.filter((d) => d.kind === "reply");
    assert.ok(replies.length >= 1);
    assert.ok(replies[0].text.includes("can't answer"));
    assert.ok(!replies.some((r) => r.text.includes("##REFUSED##")));
  });
});
