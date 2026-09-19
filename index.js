var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// node_modules/itty-router/dist/itty-router.min.mjs
function e({ base: t = "", routes: n = [] } = {}) {
  return { __proto__: new Proxy({}, { get: /* @__PURE__ */ __name((e2, a, o) => (e3, ...r) => n.push([a.toUpperCase(), RegExp(`^${(t + e3).replace(/(\/?)\*/g, "($1.*)?").replace(/(\/$)|((?<=\/)\/)/, "").replace(/:(\w+)(\?)?(\.)?/g, "$2(?<$1>[^/]+)$2$3").replace(/\.(?=[\w(])/, "\\.").replace(/\)\.\?\(([^\[]+)\[\^/g, "?)\\.?($1(?<=\\.)[^\\.")}/*$`), r]) && o, "get") }), routes: n, async handle(e2, ...r) {
    let a, o, t2 = new URL(e2.url);
    e2.query = Object.fromEntries(t2.searchParams);
    for (var [p, s, u] of n) if ((p === e2.method || "ALL" === p) && (o = t2.pathname.match(s))) {
      e2.params = o.groups;
      for (var c of u) if (void 0 !== (a = await c(e2.proxy || e2, ...r))) return a;
    }
  } };
}
__name(e, "e");

// dist/groq.js
var MODELS = ["whisper-large-v3-turbo", "openai/gpt-oss-120b"];
var FREE_TOKEN_QUOTA = 1e5;
function selectModel(modelUsage) {
  const used = Object.values(modelUsage).reduce((a, b) => a + b, 0);
  const remaining = FREE_TOKEN_QUOTA - used;
  if (remaining < 1e3) {
    return MODELS[0];
  }
  return MODELS[1];
}
__name(selectModel, "selectModel");
async function callGroqModel(model, messages, apiKey) {
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const payload = {
    model,
    messages,
    max_tokens: 700,
    temperature: 0.7
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Groq request failed: ${res.status} ${txt}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  const tokens = data.usage?.total_tokens || 0;
  return { text, tokens };
}
__name(callGroqModel, "callGroqModel");
async function summarizeConversation(history, apiKey) {
  const prompt = [{ role: "system", content: "Please provide a concise summary of the conversation so far." }];
  const messages = prompt.concat(history);
  const model = "llama-3.1-8b-instant";
  return await callGroqModel(model, messages, apiKey);
}
__name(summarizeConversation, "summarizeConversation");

// dist/processor.js
var MAX_HISTORY_TOKENS = 2e3;
async function processMessage(context, env) {
  const key = context.channel_id || context.guild_id || "global";
  const id = env.CONVERSATION_DO.idFromName(key);
  if (context.channel_id) {
    const raw = await env.LAST_MESSAGE_KV.get("channels");
    const channels = raw ? JSON.parse(raw) : [];
    if (!channels.includes(context.channel_id)) {
      channels.push(context.channel_id);
      await env.LAST_MESSAGE_KV.put("channels", JSON.stringify(channels));
    }
  }
  const stub = env.CONVERSATION_DO.get(id);
  await stub.fetch("https://example.com/initialize");
  const lower = context.content.trim().toLowerCase();
  if (lower === "/clear_context" || lower === "clear context" || lower === "forget") {
    await stub.fetch("https://example.com/clear");
    return { reply: "context cleared" };
  }
  const userEntry = {
    role: "user",
    content: context.content,
    timestamp: Date.now()
  };
  await stub.fetch("https://example.com/append", {
    method: "POST",
    body: JSON.stringify(userEntry)
  });
  const stateResp = await stub.fetch("https://example.com/get");
  const state = await stateResp.json();
  if (state.tokenCount > MAX_HISTORY_TOKENS) {
    const histMessages = state.history.map((h) => ({ role: h.role, content: h.content }));
    const summaryRes = await summarizeConversation(histMessages, env.GROQ_API_KEY);
    await stub.fetch("https://example.com/setSummary", {
      method: "POST",
      body: JSON.stringify({ summary: summaryRes.text })
    });
    const summaryModel = "llama-3.1-8b-instant";
    await stub.fetch("https://example.com/recordUsage", {
      method: "POST",
      body: JSON.stringify({ model: summaryModel, tokens: summaryRes.tokens })
    });
  }
  const updatedResp = await stub.fetch("https://example.com/get");
  const updatedState = await updatedResp.json();
  const model = env.GROQ_MODEL || selectModel(updatedState.modelUsage);
  const messages = [];
  if (updatedState.summary) {
    messages.push({ role: "system", content: `Summary of previous conversation: ${updatedState.summary}` });
  }
  updatedState.history.forEach((h) => messages.push({ role: h.role, content: h.content }));
  messages.push({ role: "user", content: context.content });
  const groqRes = await callGroqModel(model, messages, env.GROQ_API_KEY);
  const assistantEntry = {
    role: "assistant",
    content: groqRes.text,
    timestamp: Date.now()
  };
  await stub.fetch("https://example.com/append", {
    method: "POST",
    body: JSON.stringify(assistantEntry)
  });
  await stub.fetch("https://example.com/recordUsage", {
    method: "POST",
    body: JSON.stringify({ model, tokens: groqRes.tokens })
  });
  if (!context.interaction && context.channel_id) {
    await sendChannelMessage(context.channel_id, groqRes.text, env);
  }
  return { reply: groqRes.text };
}
__name(processMessage, "processMessage");

// dist/discord.js
var DISCORD_API_BASE = "https://discord.com/api/v10";
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
__name(hexToBytes, "hexToBytes");
async function verifyDiscordRequest(headers, rawBody, publicKeyHex) {
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
__name(verifyDiscordRequest, "verifyDiscordRequest");
async function sendChannelMessage(channel_id, content, env) {
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
__name(sendChannelMessage, "sendChannelMessage");
async function sendInteractionFollowup(applicationId, interactionToken, content) {
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
__name(sendInteractionFollowup, "sendInteractionFollowup");
async function handleDiscordInteraction(body, rawBody, headers, env, execCtx) {
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
        const run = /* @__PURE__ */ __name(async () => {
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
        }, "run");
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
__name(handleDiscordInteraction, "handleDiscordInteraction");
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
    type: 4,
    // channel message with source
    data: { content: result.reply || "..." }
  };
  return new Response(JSON.stringify(respBody), { status: 200 });
}
__name(processCommand, "processCommand");

// dist/conversation_do.js
var ConversationDO = class _ConversationDO {
  static {
    __name(this, "ConversationDO");
  }
  constructor(stateObj, env) {
    this.stateObj = stateObj;
    this.state = {
      history: [],
      tokenCount: 0,
      modelUsage: {}
    };
  }
  // rough token estimation based on character count
  static estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }
  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/initialize":
        await this.initialize();
        return new Response("ok");
      case "/append":
        return this.append(await request.json());
      case "/get":
        return new Response(JSON.stringify(this.state));
      case "/clear":
        this.state = { history: [], tokenCount: 0, modelUsage: {} };
        await this.stateObj.storage.put("state", this.state);
        return new Response("cleared");
      case "/setSummary": {
        const body = await request.json();
        await this.setSummary(body.summary);
        return new Response("ok");
      }
      case "/recordUsage": {
        const body = await request.json();
        await this.recordUsage(body.model, body.tokens);
        return new Response("ok");
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }
  async initialize() {
    const stored = await this.stateObj.storage.get("state");
    if (stored) {
      this.state = stored;
    }
  }
  async append(entry) {
    this.state.history.push(entry);
    this.state.tokenCount += _ConversationDO.estimateTokens(entry.content);
    await this.stateObj.storage.put("state", this.state);
    return new Response("ok");
  }
  async getState() {
    return this.state;
  }
  async setSummary(summary) {
    this.state.summary = summary;
    this.state.history = [];
    this.state.tokenCount = _ConversationDO.estimateTokens(summary);
    await this.stateObj.storage.put("state", this.state);
  }
  async recordUsage(model, tokens) {
    const prev = this.state.modelUsage[model] || 0;
    this.state.modelUsage[model] = prev + tokens;
    await this.stateObj.storage.put("state", this.state);
  }
};

// dist/index.js
var router = e();
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
var index_default = {
  async fetch(request, env, ctx) {
    const response = await router.handle(request, env, ctx);
    return response ?? new Response("not found", { status: 404 });
  },
  async scheduled(event, env, ctx) {
    console.log("cron event");
    try {
      const raw = await env.LAST_MESSAGE_KV.get("channels");
      if (!raw)
        return;
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
  if (env.DISCORD_BOT_ID)
    return env.DISCORD_BOT_ID;
  const cached = await env.LAST_MESSAGE_KV.get("discord_bot_id");
  if (cached)
    return cached;
  const meRes = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` }
  });
  if (!meRes.ok) {
    console.error("failed to resolve bot id", meRes.status);
    return void 0;
  }
  const me = await meRes.json();
  const botId = me?.id;
  if (botId) {
    await env.LAST_MESSAGE_KV.put("discord_bot_id", botId);
  }
  return botId;
}
__name(resolveBotId, "resolveBotId");
function stripBotMention(content, botId) {
  if (!botId)
    return content.trim();
  const mention = new RegExp(`<@!?${botId}>`, "g");
  return content.replace(mention, "").replace(/\s+/g, " ").trim();
}
__name(stripBotMention, "stripBotMention");
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
    if (msg.author?.bot || botId && msg.author?.id === botId) {
      await env.LAST_MESSAGE_KV.put(lastKey, msg.id);
      continue;
    }
    const mentionsBot = botId ? msg.mentions?.some((m) => m.id === botId) : false;
    const isReplyToBot = botId ? msg.referenced_message?.author?.id === botId : !!msg.referenced_message?.author?.bot;
    if (mentionsBot || isReplyToBot) {
      const content = stripBotMention(msg.content || "", botId);
      const prompt = content || "Please continue.";
      await processMessage({ channel_id, guild_id: msg.guild_id, user_id: msg.author.id, content: prompt }, env);
    }
    await env.LAST_MESSAGE_KV.put(lastKey, msg.id);
  }
}
__name(pollChannel, "pollChannel");
export {
  ConversationDO,
  index_default as default
};
//# sourceMappingURL=index.js.map
