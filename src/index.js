// Worker entrypoint: HTTP routes + cron polling fallback for @mentions.

import { Router } from "itty-router";
import { handleDiscordInteraction } from "./discord.js";
import { processMessage } from "./processor.js";

export { ConversationDO } from "./conversation_do.js";

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

export default {
  async fetch(request, env, ctx) {
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

function stripBotMention(content, botId) {
  if (!botId) return content.trim();
  const mention = new RegExp(`<@!?${botId}>`, "g");
  return content.replace(mention, "").replace(/\s+/g, " ").trim();
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
      const content = stripBotMention(msg.content || "", botId);
      const prompt = content || "Please continue.";
      await processMessage(
        { channel_id, guild_id: msg.guild_id, user_id: msg.author.id, content: prompt },
        env
      );
    }
    await env.LAST_MESSAGE_KV.put(lastKey, msg.id);
  }
}
