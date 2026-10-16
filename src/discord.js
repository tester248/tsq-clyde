// Discord REST helpers + slash-command interaction handler.

import { processMessage } from "./processor.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

function hexToBytes(hex) {
  if (hex.length % 2 !== 0) {
    throw new Error("invalid hex input");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function verifyDiscordRequest(headers, rawBody, publicKeyHex) {
  if (!publicKeyHex) {
    console.error("DISCORD_PUBLIC_KEY is not configured");
    return false;
  }
  const signature = headers.get("x-signature-ed25519");
  const timestamp = headers.get("x-signature-timestamp");
  if (!signature || !timestamp) {
    return false;
  }
  try {
    const publicKey = hexToBytes(publicKeyHex.trim());
    const sig = hexToBytes(signature.trim());
    const message = new TextEncoder().encode(`${timestamp}${rawBody}`);
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, message);
  } catch (err) {
    console.error("signature verify error", err);
    return false;
  }
}

export async function sendChannelMessage(channel_id, content, env) {
  const url = `${DISCORD_API_BASE}/channels/${channel_id}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bot ${env.DISCORD_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ content })
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error("discord send error", res.status, txt);
  }
  return res;
}

export async function sendInteractionFollowup(applicationId, interactionToken, content) {
  const safeContent = content.length > 1900 ? `${content.slice(0, 1900)}...` : content;
  const url = `${DISCORD_API_BASE}/webhooks/${applicationId}/${interactionToken}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: safeContent })
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error("discord followup error", res.status, txt);
  }
}

export async function handleDiscordInteraction(body, rawBody, headers, env, execCtx) {
  const verified = await verifyDiscordRequest(headers, rawBody, env.DISCORD_PUBLIC_KEY);
  if (!verified) {
    return new Response("invalid request signature", { status: 401 });
  }

  const { type, data } = body;
  if (type === 2) {
    console.log("discord interaction command", data?.name, "channel", body?.channel_id);
  } else {
    console.log("discord interaction type", type);
  }

  if (type === 1) {
    return new Response(JSON.stringify({ type: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (type === 2) {
    const commandName = data.name;
    switch (commandName) {
      case "ask":
        const deferred = new Response(JSON.stringify({ type: 5 }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
        const run = async () => {
          try {
            const ctx = {
              channel_id: body.channel_id,
              guild_id: body.guild_id,
              user_id: body.member?.user?.id || body.user?.id,
              content: data.options && data.options[0] ? data.options[0].value : "",
              interaction: body
            };
            const result = await processMessage(ctx, env);
            await sendInteractionFollowup(body.application_id, body.token, result.reply || "...");
          } catch (err) {
            console.error("ask command failed", err);
            await sendInteractionFollowup(body.application_id, body.token, "I hit an error while generating a reply. Please try again.");
          }
        };
        if (execCtx) {
          execCtx.waitUntil(run());
        } else {
          run();
        }
        return deferred;
      case "clear_context":
        return await processCommand(body, env);
      default:
        return new Response("not implemented", { status: 501 });
    }
  }

  return new Response("ok");
}

async function processCommand(data, env) {
  const ctx = {
    channel_id: data.channel_id,
    guild_id: data.guild_id,
    user_id: data.member?.user?.id || data.user?.id,
    content: data.data?.options && data.data.options[0] ? data.data.options[0].value : "",
    interaction: data
  };
  const result = await processMessage(ctx, env);
  const respBody = {
    type: 4, // channel message with source
    data: { content: result.reply || "..." }
  };
  return new Response(JSON.stringify(respBody), { status: 200 });
}
