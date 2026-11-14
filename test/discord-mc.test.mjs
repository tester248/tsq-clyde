import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { handleDiscordInteraction } from "../src/discord.js";

let keyPair;

before(async () => {
  keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
});

async function publicKeyHex() {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  return [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Simulate Discord: POST an interaction signed with the app key.
async function postInteraction(body, env, execCtx) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const data = new TextEncoder().encode(`${timestamp}${rawBody}`);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, data));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  const req = new Request("https://example.com/discord/interactions", {
    method: "POST",
    headers: {
      "x-signature-ed25519": hex,
      "x-signature-timestamp": timestamp,
    },
    body: rawBody,
  });
  return handleDiscordInteraction(await req.json(), rawBody, req.headers, env, execCtx);
}

function makeExecCtx() {
  const background = [];
  return {
    background,
    waitUntil: (p) => background.push(p),
    drain: () => Promise.allSettled(background),
  };
}

function mcInteraction(subcommand, userId = "809430270897160202") {
  return {
    type: 2,
    id: "i1",
    application_id: "app1",
    channel_id: "C1",
    guild_id: "G1",
    token: "tok",
    member: { user: { id: userId } },
    data: { name: "mc", options: [{ name: subcommand, type: 1 }] },
  };
}

// Fake MINECRAFT_BRIDGE_DO binding: get(idFromName(...)) returns a stub whose
// /query returns a canned result.
function bridgeEnv(result) {
  const calls = [];
  const stub = {
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return Response.json(result);
    },
  };
  const binding = {
    idFromName: () => "minecraft",
    get: () => stub,
  };
  return {
    env: { MINECRAFT_BRIDGE_DO: binding },
    calls,
  };
}

describe("minecraft slash commands", () => {
  it("/mc status resolves the subcommand and followups with server status", async () => {
    const realFetch = globalThis.fetch;
    const followups = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("discord.com/api") && u.includes("/webhooks/")) {
        followups.push(JSON.parse(init.body));
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    try {
      const ctx = makeExecCtx();
      const { env, calls } = bridgeEnv({
        ok: true,
        data: { version: "26.3", tps: 20, uptime: 3600, playersNow: 2, playersMax: 20 },
      });
      const fullEnv = { DISCORD_PUBLIC_KEY: await publicKeyHex(), ...env };
      const res = await postInteraction(mcInteraction("status"), fullEnv, ctx);
      assert.equal(res.status, 200);
      await ctx.drain();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.action, "status");
      assert.equal(followups.length, 1);
      assert.ok(followups[0].content.includes("26.3"));
      assert.ok(followups[0].content.includes("2/20"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("/mc players followups with the online player list", async () => {
    const realFetch = globalThis.fetch;
    const followups = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("discord.com/api") && u.includes("/webhooks/")) {
        followups.push(JSON.parse(init.body));
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    try {
      const ctx = makeExecCtx();
      const { env, calls } = bridgeEnv({ ok: true, data: { players: ["Alice", "Bob"] } });
      const fullEnv = { DISCORD_PUBLIC_KEY: await publicKeyHex(), ...env };
      const res = await postInteraction(mcInteraction("players"), fullEnv, ctx);
      assert.equal(res.status, 200);
      await ctx.drain();
      assert.equal(calls[0].body.action, "players");
      assert.equal(followups.length, 1);
      assert.ok(followups[0].content.includes("Alice"));
      assert.ok(followups[0].content.includes("Bob"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a bridge failure yields a friendly error followup", async () => {
    const realFetch = globalThis.fetch;
    const followups = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes("discord.com/api") && u.includes("/webhooks/")) {
        followups.push(JSON.parse(init.body));
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    try {
      const ctx = makeExecCtx();
      const { env } = bridgeEnv({ ok: false, error: "bridge disconnected" });
      const fullEnv = { DISCORD_PUBLIC_KEY: await publicKeyHex(), ...env };
      const res = await postInteraction(mcInteraction("status"), fullEnv, ctx);
      assert.equal(res.status, 200);
      await ctx.drain();
      assert.equal(followups.length, 1);
      assert.ok(followups[0].content.includes("Minecraft"));
      assert.ok(followups[0].content.includes("error"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
