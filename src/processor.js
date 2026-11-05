// Message processing: conversation state (per-channel Durable Object) + AI replies.

import { generateReply, summarizeConversation } from "./ai.js";
import { runAgentLoop, shouldUseAgentTools } from "./agent.js";
import { sendChannelMessage } from "./discord.js";

const MAX_HISTORY_TOKENS = 2000;

// Phase -> human status message for progressive feedback (Gemini-style).
const PHASE_MESSAGES = {
  search: "searching the web… 🔎",
  fetch: "reading sources… 📄",
  compose: "composing your answer… ✍️",
};

// Returns a throttled status sender: sends a message at most once per phase,
// and only if `allow` is true (i.e. a non-interaction channel).
export function createStatusSender({ channel, allow }) {
  const emitted = new Set();
  return (phase) => {
    if (!allow || !channel) return;
    if (emitted.has(phase)) return;
    emitted.add(phase);
    const text = PHASE_MESSAGES[phase] || "working on it… ⏳";
    // fire-and-forget; never block the loop on a status message
    channel.send(text).catch(() => {});
  };
}

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
    const summaryRes = await summarizeConversation(histMessages, env);
    await stub.fetch("https://example.com/setSummary", {
      method: "POST",
      body: JSON.stringify({ summary: summaryRes.text })
    });
    await stub.fetch("https://example.com/recordUsage", {
      method: "POST",
      body: JSON.stringify({ model: summaryRes.provider, tokens: summaryRes.tokens })
    });
  }

  const updatedResp = await stub.fetch("https://example.com/get");
  const updatedState = await updatedResp.json();

  const messages = [];
  if (updatedState.summary) {
    messages.push({ role: "system", content: `Summary of previous conversation: ${updatedState.summary}` });
  }
  updatedState.history.forEach((h) => messages.push({ role: h.role, content: h.content }));
  messages.push({ role: "user", content: context.content });

  // Fast path: for greetings/trivial pings, answer directly without the tool
  // loop so they stay instant and never trigger a search.
  let aiRes;
  if (!shouldUseAgentTools(context.content)) {
    aiRes = await generateReply(messages, env);
    aiRes = { ...aiRes, totalTokens: aiRes.tokens };
  } else {
    // Progressive feedback: surface search -> fetch -> compose as staged
    // status messages, throttled per phase. Non-interaction channels only.
    const sendStatus = createStatusSender({
      channel: {
        send: (text) => sendChannelMessage(context.channel_id, text, env),
      },
      allow: !context.interaction && !!context.channel_id,
    });
    aiRes = await runAgentLoop({ messages, env, onPhase: sendStatus });
  }

  const assistantEntry = {
    role: "assistant",
    content: aiRes.text,
    timestamp: Date.now()
  };
  await stub.fetch("https://example.com/append", {
    method: "POST",
    body: JSON.stringify(assistantEntry)
  });
  await stub.fetch("https://example.com/recordUsage", {
    method: "POST",
    body: JSON.stringify({ model: aiRes.provider, tokens: aiRes.totalTokens })
  });

  if (!context.interaction && context.channel_id) {
    await sendChannelMessage(context.channel_id, aiRes.text, env);
  }

  return { reply: aiRes.text, provider: aiRes.provider };
}
