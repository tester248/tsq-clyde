// Worker entrypoint: HTTP routes + cron polling fallback for @mentions.

import { Router } from "itty-router";
import { handleDiscordInteraction } from "./discord.js";
import { processMessage } from "./processor.js";
import { stripMention } from "./gateway.js";
import { generateReply } from "./ai.js";
import { runAgentLoop } from "./agent.js";

export { ConversationDO } from "./conversation_do.js";
export { GatewayDO } from "./gateway_do.js";

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

router.get("/gateway/status", async (request, env) => {
  const stub = gatewayStub(env);
  return await stub.fetch("https://gateway/status");
});

router.post("/gateway/connect", async (request, env) => {
  const stub = gatewayStub(env);
  return await stub.fetch("https://gateway/connect", { method: "POST" });
});

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
