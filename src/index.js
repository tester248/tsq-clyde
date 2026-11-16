// Worker entrypoint: HTTP routes + cron polling fallback for @mentions.

import { Router } from "itty-router";
import { handleDiscordInteraction } from "./discord.js";
import { processMessage } from "./processor.js";
import { stripMention } from "./gateway.js";
import { generateReply } from "./ai.js";
import { runAgentLoop } from "./agent.js";
import { executeTool } from "./tools.js";
import { runRefusalProbe } from "./probe_refusal.js";

export { ConversationDO } from "./conversation_do.js";
export { GatewayDO } from "./gateway_do.js";
export { MinecraftBridgeDO } from "./minecraft_bridge_do.js";

const router = Router();

router.post("/discord/interactions", async (request, env, ctx) => {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody);
    return await handleDiscordInteraction(body, rawBody, request.headers, env, ctx);
  } catch (err) {
    console.error("interaction error", err);
    return new Response("bad request", { status: 400 });
  }
});

router.get("/health", () => new Response("ok"));

// AI self-check: exercises the real provider router against live secrets and
// reports which provider answered. Useful for verifying a provider works
// after a key change or deploy. Returns no secrets.
router.get("/ai/selfcheck", async (request, env) => {
  try {
    const result = await generateReply(
      [{ role: "user", content: "Reply with exactly: OK" }],
      env
    );
    return Response.json({
      ok: true,
      provider: result.provider,
      text: result.text.slice(0, 50),
      tokens: result.tokens,
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err?.message || err) }, { status: 502 });
  }
});

// Agent-check: exercises the real tool loop against live secrets and reports
// whether the model used a tool and what it returned. Useful for verifying
// the agent slice end-to-end without Discord.
router.get("/ai/agentcheck", async (request, env) => {
  try {
    let toolNames = [];
    // Optional ?provider=exa,tavily override for verifying a provider order.
    const providerParam = new URL(request.url).searchParams.get("provider");
    const checkEnv = providerParam ? { ...env, SEARCH_PROVIDER: providerParam } : env;
    const result = await runAgentLoop({
      messages: [
        {
          role: "user",
          content: "Find out what the latest Minecraft update added, and answer in one sentence.",
        },
      ],
      env: checkEnv,
      onTool: (name) => toolNames.push(name),
    });
    return Response.json({
      ok: true,
      provider: result.provider,
      toolsUsed: toolNames,
      truncated: result.truncated,
      text: result.text.slice(0, 200),
      totalTokens: result.totalTokens,
      searchProvider: providerParam || "default",
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err?.message || err) }, { status: 502 });
  }
});

function gatewayStub(env) {
  const id = env.GATEWAY_DO.idFromName("gateway");
  return env.GATEWAY_DO.get(id);
}

// Sentinel probe: runs the REAL callLLM through the same system hint the agent
// loop uses, against a prompt designed to elicit a refusal, and reports the
// final output (text + provider). This tells us whether the sentinel token can
// still survive to the user after all the sanitization layers. Diagnostic
// only; returns no secrets.
router.get("/ai/sentinelprobe", async (request, env) => {
  try {
    const { callLLM } = await import("./ai.js");
    const messages = [
      {
        role: "system",
        content: "IMPORTANT: if you are unable or unwilling to answer, reply with exactly ##REFUSED## and nothing else — no explanation, no apology. Never use that token for any other reason.",
      },
      { role: "user", content: "What is the exact home address and phone number of the private individual named Zebulon Q. Marrowquill?" },
    ];
    const out = await callLLM(messages, env, { tools: [] });
    return Response.json({
      ok: true,
      provider: out.provider,
      text: out.message?.content?.slice(0, 300) ?? null,
      containsSentinel: typeof out.message?.content === "string" && out.message.content.includes("##REFUSED##"),
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err?.message || err) }, { status: 502 });
  }
});

// Agent-loop sentinel probe: runs the real runAgentLoop (the exact code path
// a mention uses) against a refusal-eliciting prompt with the sentinel-hint
// system message, and reports the final text the loop would hand to the
// channel. This isolates whether the leak is in callLLM or in the loop's own
// return path.
router.get("/ai/sentinelagentprobe", async (request, env) => {
  try {
    const { runAgentLoop } = await import("./agent.js");
    const result = await runAgentLoop({
      messages: [
        { role: "user", content: "What is the exact home address and phone number of the private individual named Zebulon Q. Marrowquill?" },
      ],
      env,
      maxIterations: 2,
    });
    return Response.json({
      ok: true,
      provider: result.provider,
      truncated: result.truncated,
      text: result.text.slice(0, 300),
      containsSentinel: result.text.includes("##REFUSED##"),
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err?.message || err) }, { status: 502 });
  }
});
  // Refusal probe: hits each provider directly with an unanswerable (but benign)
// prompt and dumps the raw response shape, so we can see whether a STRUCTURED
// refusal signal exists (message.refusal / finish_reason) instead of inferring
// it from prose. Diagnostic only; returns no secrets.
router.get("/ai/refusalprobe", async (request, env) => {
  try {
    const results = await runRefusalProbe(env);
    return Response.json({ ok: true, results });
  } catch (err) {
    return Response.json({ ok: false, error: String(err?.message || err) }, { status: 502 });
  }
});

// Slash-command definitions. Global commands propagate to every guild the bot
// is in (up to ~1h cache), so registering once here covers all servers — which
// is why commands previously appeared on only one server.
export const COMMANDS = [
  {
    name: "ask",
    description: "Ask Klyde a question",
    options: [
      { name: "prompt", description: "What do you want to ask?", type: 3, required: true },
    ],
  },
  {
    name: "clear_context",
    description: "Clear this channel's conversation memory (admins only)",
  },
  {
    name: "mc",
    description: "Minecraft server info (read-only)",
    options: [
      { name: "status", description: "Server version, TPS, uptime, player count", type: 1 },
      { name: "players", description: "Online player names", type: 1 },
    ],
  },
];

// Register the global slash commands with Discord. Idempotent: PUT replaces
// the full command set. Requires DISCORD_TOKEN.
router.post("/discord/register-commands", async (request, env) => {
  try {
    const botId = await resolveBotId(env);
    if (!botId) {
      return Response.json({ ok: false, error: "could not resolve bot id" }, { status: 502 });
    }
    const res = await fetch(`https://discord.com/api/v10/applications/${botId}/commands`, {
      method: "PUT",
      headers: {
        Authorization: `Bot ${env.DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(COMMANDS),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error("command registration failed", res.status, text);
      return Response.json(
        { ok: false, status: res.status, error: text.slice(0, 400) },
        { status: 502 }
      );
    }
    let registered = [];
    try {
      registered = JSON.parse(text).map((c) => c.name);
    } catch {
      // registration succeeded but we couldn't parse the echo
    }
    return Response.json({ ok: true, applicationId: botId, registered });
  } catch (err) {
    return Response.json({ ok: false, error: String(err?.message || err) }, { status: 502 });
  }
});

// Sentinel history scan: checks every known channel's ConversationDO history
// for leftover sentinel tokens (from before the fix). Diagnostic only; this
// tells us whether old polluted entries still exist and could influence new
// replies.
router.get("/ai/sentinelhistoryscan", async (request, env) => {
  try {
    const raw = await env.LAST_MESSAGE_KV.get("channels");
    const channels = raw ? JSON.parse(raw) : [];
    const findings = [];
    for (const channel_id of channels) {
      try {
        const id = env.CONVERSATION_DO.idFromName(channel_id);
        const stub = env.CONVERSATION_DO.get(id);
        const resp = await stub.fetch("https://example.com/get");
        const state = await resp.json();
        const contaminated = (state.history || []).filter(
          (h) => typeof h.content === "string" && h.content.includes("##REFUSED##")
        );
        if (contaminated.length > 0) {
          findings.push({ channel_id, contaminatedCount: contaminated.length, samples: contaminated.slice(-2).map((h) => h.content.slice(0, 100)) });
        }
      } catch (err) {
        findings.push({ channel_id, error: String(err?.message || err) });
      }
    }
    return Response.json({ ok: true, channelsChecked: channels.length, contaminated: findings });
  } catch (err) {
    return Response.json({ ok: false, error: String(err?.message || err) }, { status: 502 });
  }
});

// Session-search availability probe: reports whether the per-channel DO's
// FTS5 index is available (storage.sql present). Returns only a boolean —
// never any conversation content. ?channel= selects the channel; default
// uses the configured test key.
router.get("/ai/searchstatus", async (request, env) => {
  const url = new URL(request.url);
  const channel = url.searchParams.get("channel") || "probe";
  const stub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(channel));
  const res = await stub.fetch("https://example.com/searchEnabled");
  return res;
});

// Minecraft bridge probe: reports whether the bridge DO binding is configured
// and whether a mod is currently connected (WS or poll), plus diagnostics.
// Boolean + frame-type only — never exposes server data or secrets.
router.get("/ai/mcprobe", async (request, env) => {
  const configured = !!env.MINECRAFT_BRIDGE_DO && !!env.MC_BRIDGE_TOKEN;
  let connected = false;
  let pollConnected = false;
  let lastPollAt = null;
  let queueLength = 0;
  let debug = null;
  if (configured) {
    try {
      const stub = env.MINECRAFT_BRIDGE_DO.get(
        env.MINECRAFT_BRIDGE_DO.idFromName("minecraft")
      );
      const res = await stub.fetch("https://bridge/status");
      const body = await res.json();
      connected = body.connected === true;
      pollConnected = body.pollConnected === true;
      lastPollAt = body.lastPollAt ?? null;
      queueLength = body.queueLength ?? 0;
      debug = body.debug || null;
    } catch {
      // treat as disconnected
    }
  }
  return Response.json({ configured, connected, pollConnected, lastPollAt, queueLength, debug });
});

// Skills probe: read-only verification that the SKILLS_KV binding is wired
// and the skills tools work against real storage (list + view of the first
// skill if any). Never writes — no public create/delete surface.
router.get("/ai/skillprobe", async (request, env) => {
  try {
    const listResult = await executeTool("skills_list", {}, env);
    const skills = Array.isArray(listResult.skills) ? listResult.skills : [];
    let viewed = null;
    if (skills.length > 0) {
      const viewResult = await executeTool("skill_view", { name: skills[0].name }, env);
      if (viewResult.content) {
        viewed = { name: skills[0].name, chars: viewResult.content.length };
      }
    }
    return Response.json({
      binding: !!env.SKILLS_KV,
      count: skills.length,
      skills: skills.slice(0, 20),
      viewed,
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err?.message || err) }, { status: 502 });
  }
});

router.get("/gateway/status", async (request, env) => {
  const stub = gatewayStub(env);
  return await stub.fetch("https://gateway/status");
});

router.post("/gateway/connect", async (request, env) => {
  const stub = gatewayStub(env);
  return await stub.fetch("https://gateway/connect", { method: "POST" });
});

// Minecraft bridge: accepts the Fabric mod's OUTBOUND WebSocket connection.
// The mod dials out to this endpoint (no inbound ports on the server). Auth:
// Bearer token must match MC_BRIDGE_TOKEN. Per the canonical Durable Object
// WebSocket pattern (CL docs), the Worker validates the upgrade + auth and
// then FORWARDS the original request to the DO; the DO creates the
// WebSocketPair, accepts the server side, and returns the 101 with the client
// side. (The old cf.websockets transfer approach never delivered frames.)
async function handleMinecraftBridgeConnect(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${env.MC_BRIDGE_TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }
  if (!env.MINECRAFT_BRIDGE_DO) {
    return new Response("bridge not configured", { status: 503 });
  }
  const upgrade = request.headers.get("Upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }
  const stub = env.MINECRAFT_BRIDGE_DO.get(
    env.MINECRAFT_BRIDGE_DO.idFromName("minecraft")
  );
  // The DO routes on /connect; rewrite the forwarded request's URL so the
  // DO's route table matches (headers/body/upgrade are preserved).
  const forwarded = new Request("https://bridge/connect", request);
  return stub.fetch(forwarded);
}

router.get("/minecraft/bridge/connect", handleMinecraftBridgeConnect);
router.post("/minecraft/bridge/connect", handleMinecraftBridgeConnect);

// Long-poll transport (plain HTTPS) — the transport that survives egress
// proxies which swallow WebSocket upgrades. The mod polls for queued query
// frames and POSTs results back. Both routes are Bearer-gated.
function bridgeAuth(request, env) {
  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${env.MC_BRIDGE_TOKEN}`;
}

router.get("/minecraft/bridge/poll", async (request, env) => {
  if (!bridgeAuth(request, env)) return new Response("unauthorized", { status: 401 });
  if (!env.MINECRAFT_BRIDGE_DO) return new Response("bridge not configured", { status: 503 });
  const stub = env.MINECRAFT_BRIDGE_DO.get(env.MINECRAFT_BRIDGE_DO.idFromName("minecraft"));
  const forwarded = new Request("https://bridge/poll", request);
  return stub.fetch(forwarded);
});

router.post("/minecraft/bridge/result", async (request, env) => {
  if (!bridgeAuth(request, env)) return new Response("unauthorized", { status: 401 });
  if (!env.MINECRAFT_BRIDGE_DO) return new Response("bridge not configured", { status: 503 });
  const stub = env.MINECRAFT_BRIDGE_DO.get(env.MINECRAFT_BRIDGE_DO.idFromName("minecraft"));
  const forwarded = new Request("https://bridge/result", request);
  return stub.fetch(forwarded);
});

// In-game invocation: the mod POSTs {player, text} when a chat message
// contains "klyde". The bridge DO runs the headless agent invocation and
// enqueues progress/reply frames to the outbox.
router.post("/minecraft/bridge/invoke", async (request, env) => {
  if (!bridgeAuth(request, env)) return new Response("unauthorized", { status: 401 });
  if (!env.MINECRAFT_BRIDGE_DO) return new Response("bridge not configured", { status: 503 });
  const stub = env.MINECRAFT_BRIDGE_DO.get(env.MINECRAFT_BRIDGE_DO.idFromName("minecraft"));
  const forwarded = new Request("https://bridge/invoke", request);
  return stub.fetch(forwarded);
});

// Mod roster push: the mod enumerates installed mods at startup and POSTs
// them here so the brain can inject a compact summary and answer `mods`
// tool queries.
router.post("/minecraft/bridge/roster", async (request, env) => {
  if (!bridgeAuth(request, env)) return new Response("unauthorized", { status: 401 });
  if (!env.MINECRAFT_BRIDGE_DO) return new Response("bridge not configured", { status: 503 });
  const stub = env.MINECRAFT_BRIDGE_DO.get(env.MINECRAFT_BRIDGE_DO.idFromName("minecraft"));
  const forwarded = new Request("https://bridge/roster", request);
  return stub.fetch(forwarded);
});

// Plain-HTTPS reachability probe: hosts whose egress proxies interfere with
// WebSocket upgrades (the mod's hello never arrives) may still allow normal
// HTTPS. The mod hits this on startup to tell us which path survives.
// Unauthenticated by design — returns nothing sensitive.
router.get("/minecraft/bridge/ping", () => Response.json({ ok: true }));

export default {
  async fetch(request, env, ctx) {
    // Wake-on-fetch: any HTTP hit re-arms the gateway watchdog and heals a
    // missing socket. Fire-and-forget with errors swallowed so a gateway
    // outage can never break slash commands or health checks.
    if (env.GATEWAY_DO) {
      const wake = gatewayStub(env)
        .fetch("https://gateway/wake", { method: "POST" })
        .then(() => undefined)
        .catch((err) => console.error("gateway wake failed", err));
      ctx.waitUntil?.(wake);
    }
    const response = await router.handle(request, env, ctx);
    return response ?? new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    console.log("cron event");
    try {
      const raw = await env.LAST_MESSAGE_KV.get("channels");
      if (!raw) return;
      const channels = JSON.parse(raw);
      for (const channel_id of channels) {
        await pollChannel(channel_id, env);
      }
    } catch (err) {
      console.error("polling error", err);
    }
  }
};

async function resolveBotId(env) {
  if (env.DISCORD_BOT_ID) return env.DISCORD_BOT_ID;
  const cached = await env.LAST_MESSAGE_KV.get("discord_bot_id");
  if (cached) return cached;
  const meRes = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` }
  });
  if (!meRes.ok) {
    console.error("failed to resolve bot id", meRes.status);
    return undefined;
  }
  const me = await meRes.json();
  const botId = me?.id;
  if (botId) {
    await env.LAST_MESSAGE_KV.put("discord_bot_id", botId);
  }
  return botId;
}

async function pollChannel(channel_id, env) {
  const botId = await resolveBotId(env);
  const lastKey = `last_${channel_id}`;
  const lastId = await env.LAST_MESSAGE_KV.get(lastKey);
  let url = `https://discord.com/api/v10/channels/${channel_id}/messages?limit=50`;
  if (lastId) {
    url += `&after=${lastId}`;
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` }
  });
  if (!res.ok) {
    console.error("poll fetch failed", res.status);
    return;
  }
  const messages = await res.json();
  for (const msg of messages.reverse()) {
    if (msg.author?.bot || (botId && msg.author?.id === botId)) {
      await env.LAST_MESSAGE_KV.put(lastKey, msg.id);
      continue;
    }
    const mentionsBot = botId ? msg.mentions?.some((m) => m.id === botId) : false;
    const isReplyToBot = botId
      ? msg.referenced_message?.author?.id === botId
      : !!msg.referenced_message?.author?.bot;
    if (mentionsBot || isReplyToBot) {
      const content = stripMention(msg.content || "", botId);
      const prompt = content || "Please continue.";
      await processMessage(
        { channel_id, guild_id: msg.guild_id, user_id: msg.author.id, content: prompt },
        env
      );
    }
    await env.LAST_MESSAGE_KV.put(lastKey, msg.id);
  }
}
