import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GATEWAY_URL,
  INTENTS,
  identifyPayload,
  resumePayload,
  heartbeatPayload,
  classifyClose,
  reconnectDelay,
  stripMention,
  shouldHandleMessage,
} from "../src/gateway.js";

describe("gateway protocol helpers", () => {
  it("pins the gateway URL and intents (no privileged intents)", () => {
    assert.equal(GATEWAY_URL, "wss://gateway.discord.gg/?v=10&encoding=json");
    // GUILDS (1<<0) | GUILD_MESSAGES (1<<9)
    assert.equal(INTENTS, 513);
  });

  it("classifyClose routes codes to resume/fatal/fresh", () => {
    assert.equal(classifyClose(4000), "resume");
    assert.equal(classifyClose(4004), "fatal");
    assert.equal(classifyClose(4014), "fatal");
    assert.equal(classifyClose(4007), "fresh");
    assert.equal(classifyClose(4009), "resume");
    assert.equal(classifyClose(1006), "resume");
  });

  it("reconnectDelay backs off with jitter and caps at 60s + jitter", () => {
    const d0 = reconnectDelay(0);
    assert.ok(d0 >= 1000 && d0 < 2000, `attempt 0 out of range: ${d0}`);
    const d10 = reconnectDelay(10);
    assert.ok(d10 >= 60000 && d10 <= 61000, `attempt 10 out of range: ${d10}`);
  });

  it("identifyPayload carries intents, shard and online presence", () => {
    const p = identifyPayload("tok123");
    assert.equal(p.op, 2);
    assert.equal(p.d.token, "tok123");
    assert.equal(p.d.intents, 513);
    assert.deepEqual(p.d.shard, [0, 1]);
    assert.equal(p.d.presence.status, "online");
  });

  it("resumePayload and heartbeatPayload carry session/seq through", () => {
    assert.deepEqual(resumePayload("tok", "sess", 42), {
      op: 6,
      d: { token: "tok", session_id: "sess", seq: 42 },
    });
    assert.deepEqual(heartbeatPayload(7), { op: 1, d: 7 });
    assert.deepEqual(heartbeatPayload(null), { op: 1, d: null });
  });

  it("stripMention removes bot mentions and collapses whitespace", () => {
    assert.equal(stripMention("<@BOTID> hello", "BOTID"), "hello");
    assert.equal(stripMention("hey <@!BOTID>  there", "BOTID"), "hey there");
    assert.equal(stripMention("  spaced  ", "BOTID"), "spaced");
  });

  it("shouldHandleMessage handles mentions with stripped prompt", () => {
    const msg = {
      author: { id: "U1", bot: false },
      content: "<@BOTID> what is up?",
      mentions: [{ id: "BOTID" }],
    };
    assert.deepEqual(shouldHandleMessage(msg, "BOTID"), {
      handle: true,
      prompt: "what is up?",
    });
  });

  it("shouldHandleMessage falls back when content is only the mention", () => {
    const msg = {
      author: { id: "U1" },
      content: "<@BOTID>",
      mentions: [{ id: "BOTID" }],
    };
    const out = shouldHandleMessage(msg, "BOTID");
    assert.equal(out.handle, true);
    assert.equal(out.prompt, "Please continue.");
  });

  it("shouldHandleMessage ignores bots and the bot itself", () => {
    assert.deepEqual(
      shouldHandleMessage(
        { author: { id: "U9", bot: true }, content: "<@BOTID> hi", mentions: [{ id: "BOTID" }] },
        "BOTID"
      ),
      { handle: false }
    );
    assert.deepEqual(
      shouldHandleMessage(
        { author: { id: "BOTID" }, content: "self talk", mentions: [] },
        "BOTID"
      ),
      { handle: false }
    );
  });

  it("shouldHandleMessage ignores messages without mention or reply", () => {
    assert.deepEqual(
      shouldHandleMessage({ author: { id: "U1" }, content: "hello all", mentions: [] }, "BOTID"),
      { handle: false }
    );
  });

  it("shouldHandleMessage handles replies to the bot", () => {
    const msg = {
      author: { id: "U2" },
      content: "and then?",
      mentions: [],
      referenced_message: { author: { id: "BOTID" } },
    };
    const out = shouldHandleMessage(msg, "BOTID");
    assert.equal(out.handle, true);
    assert.equal(out.prompt, "and then?");
  });
});
