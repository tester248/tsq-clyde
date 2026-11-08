import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

function makeGatewayStub(calls) {
  return {
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || "GET" });
      if (String(url).endsWith("/status")) {
        return Response.json({ state: "connected", guilds: 1 });
      }
      return new Response("ok");
    },
  };
}

function makeEnv(calls) {
  return {
    GATEWAY_DO: {
      idFromName: (n) => n,
      get: () => makeGatewayStub(calls),
    },
  };
}

function makeCtx() {
  const background = [];
  return { ctx: { waitUntil: (p) => void background.push(p) }, background };
}

describe("worker wiring", () => {
  it("/health returns ok", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(new Request("https://x/health"), {}, ctx);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  });

  it("unknown routes 404", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(new Request("https://x/unknown"), {}, ctx);
    assert.equal(res.status, 404);
  });

  it("malformed interaction body 400s", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(
      new Request("https://x/discord/interactions", { method: "POST", body: "not-json{" }),
      {},
      ctx
    );
    assert.equal(res.status, 400);
  });

  it("bogus signature 401s", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(
      new Request("https://x/discord/interactions", {
        method: "POST",
        headers: { "x-signature-ed25519": "00", "x-signature-timestamp": "1" },
        body: JSON.stringify({ type: 1 }),
      }),
      { DISCORD_PUBLIC_KEY: "ab".repeat(32) },
      ctx
    );
    assert.equal(res.status, 401);
  });

  it("every fetch wakes the gateway exactly once, without breaking the response", async () => {
    const calls = [];
    const { ctx, background } = makeCtx();
    const res = await worker.fetch(new Request("https://x/health"), makeEnv(calls), ctx);
    assert.equal(res.status, 200);
    await Promise.allSettled(background);
    const wakes = calls.filter((c) => c.url.endsWith("/wake") && c.method === "POST");
    assert.equal(wakes.length, 1);
  });

  it("GET /gateway/status proxies the gateway stub", async () => {
    const calls = [];
    const { ctx, background } = makeCtx();
    const res = await worker.fetch(new Request("https://x/gateway/status"), makeEnv(calls), ctx);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { state: "connected", guilds: 1 });
    await Promise.allSettled(background);
  });

  it("POST /gateway/connect proxies the gateway stub", async () => {
    const calls = [];
    const { ctx, background } = makeCtx();
    const res = await worker.fetch(
      new Request("https://x/gateway/connect", { method: "POST" }),
      makeEnv(calls),
      ctx
    );
    assert.equal(res.status, 200);
    assert.ok(calls.some((c) => c.url.endsWith("/connect") && c.method === "POST"));
    await Promise.allSettled(background);
  });
});

describe("slash command registration", () => {
  it("PUTs the global command set to Discord and reports names", async () => {
    const realFetch = globalThis.fetch;
    const { ctx } = makeCtx();
    let putUrl = null;
    let putBody = null;
    let putAuth = null;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith("/users/@me")) return Response.json({ id: "APPID" });
      if (u.includes("/applications/APPID/commands") && init.method === "PUT") {
        putUrl = u;
        putBody = JSON.parse(init.body);
        putAuth = init.headers.Authorization;
        return Response.json([{ name: "ask" }, { name: "clear_context" }]);
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    try {
      const env = {
        DISCORD_TOKEN: "bot-token",
        LAST_MESSAGE_KV: { get: async () => null, put: async () => {} },
      };
      const res = await worker.fetch(
        new Request("https://x/discord/register-commands", { method: "POST" }),
        env,
        ctx
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.registered, ["ask", "clear_context"]);
      assert.ok(putUrl.endsWith("/applications/APPID/commands"));
      assert.equal(putAuth, "Bot bot-token");
      assert.deepEqual(
        putBody.map((c) => c.name),
        ["ask", "clear_context"]
      );
      const ask = putBody.find((c) => c.name === "ask");
      assert.equal(ask.options[0].name, "prompt");
      assert.equal(ask.options[0].required, true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("surfaces Discord's error detail when registration fails", async () => {
    const realFetch = globalThis.fetch;
    const { ctx } = makeCtx();
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.endsWith("/users/@me")) return Response.json({ id: "APPID" });
      return new Response('{"message":"Missing Access","code":50001}', { status: 403 });
    };
    try {
      const env = {
        DISCORD_TOKEN: "bot-token",
        LAST_MESSAGE_KV: { get: async () => null, put: async () => {} },
      };
      const res = await worker.fetch(
        new Request("https://x/discord/register-commands", { method: "POST" }),
        env,
        ctx
      );
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.ok(body.error.includes("Missing Access"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
