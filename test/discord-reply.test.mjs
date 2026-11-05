import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sendChannelMessage, deleteChannelMessage } from "../src/discord.js";

describe("sendChannelMessage reply threading", () => {
  it("sends message_reference + no ping by default when replyTo set", async () => {
    const realFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("discord.com/api")) {
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: "m123", content: "x" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    try {
      await sendChannelMessage("C1", "hello", { DISCORD_TOKEN: "t" }, { replyTo: "p42", pingAuthor: false });
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].message_reference.message_id, "p42");
      assert.equal(bodies[0].allowed_mentions.replied_user, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("pings the replied author when pingAuthor true", async () => {
    const realFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("discord.com/api")) {
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    try {
      await sendChannelMessage("C1", "hello", { DISCORD_TOKEN: "t" }, { replyTo: "p42", pingAuthor: true });
      assert.equal(bodies[0].allowed_mentions.replied_user, true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not thread when no replyTo is given", async () => {
    const realFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("discord.com/api")) {
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    try {
      await sendChannelMessage("C1", "hello", { DISCORD_TOKEN: "t" });
      assert.equal(bodies[0].message_reference, undefined);
      assert.equal(bodies[0].allowed_mentions, undefined);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("returns the created message id", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ id: "m999" }), { status: 200 });
    try {
      const out = await sendChannelMessage("C1", "hi", { DISCORD_TOKEN: "t" });
      assert.equal(out.id, "m999");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("threads only the first chunk of a long reply", async () => {
    const realFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("discord.com/api")) {
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: "m" + bodies.length }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    try {
      await sendChannelMessage("C1", "B".repeat(5000), { DISCORD_TOKEN: "t" }, { replyTo: "p42" });
      assert.ok(bodies.length > 1, "expected multiple messages");
      assert.equal(bodies[0].message_reference.message_id, "p42");
      for (let i = 1; i < bodies.length; i++) {
        assert.equal(bodies[i].message_reference, undefined, `chunk ${i} should not be threaded`);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("deleteChannelMessage", () => {
  it("issues a DELETE to the message endpoint", async () => {
    const realFetch = globalThis.fetch;
    let sawMethod = null;
    let sawUrl = null;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("discord.com/api")) {
        sawMethod = init.method;
        sawUrl = String(url);
        return new Response("", { status: 204 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    try {
      await deleteChannelMessage("C1", "m999", { DISCORD_TOKEN: "t" });
      assert.equal(sawMethod, "DELETE");
      assert.ok(sawUrl.endsWith("/messages/m999"), `unexpected url: ${sawUrl}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("swallows deletion errors", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("gone", { status: 404 });
    try {
      await deleteChannelMessage("C1", "m999", { DISCORD_TOKEN: "t" }); // must not throw
      assert.ok(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
