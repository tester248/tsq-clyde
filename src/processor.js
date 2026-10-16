// Message processing: conversation state (per-channel Durable Object) + Groq replies.

import { selectModel, callGroqModel, summarizeConversation } from "./groq.js";
import { sendChannelMessage } from "./discord.js";

const MAX_HISTORY_TOKENS = 2000;

export async function processMessage(context, env) {
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
