// Message processing: conversation state (per-channel Durable Object) + AI replies.

import { generateReply, summarizeConversation } from "./ai.js";
import { runAgentLoop, shouldUseAgentTools } from "./agent.js";
import { sendChannelMessage, deleteChannelMessage } from "./discord.js";

const MAX_HISTORY_TOKENS = 2000;

// Shown to users when an answer came from the uncensored WUS tier.
const WUS_REPLY_TAG = "[uncensored answer]";
// Persisted in shared history instead of the raw uncensored text, so the
// main providers never ingest it.
const WUS_SANITIZED_PLACEHOLDER = "[provided a direct answer]";

// Phase -> human status message for progressive feedback (Gemini-style).
const PHASE_MESSAGES = {
  search: "searching the web… 🔎",
  fetch: "reading sources… 📄",
  compose: "composing your answer… ✍️",
};

// Returns a throttled status sender: sends a message at most once per phase,
// and only if `allow` is true (i.e. a non-interaction channel). Each sent
// message's id is captured; `cleanup()` deletes them (e.g. after the final
// answer posts) — best-effort, errors swallowed.
export function createStatusSender({ channel, allow, deleteMessage }) {
  const emitted = new Set();
  const sentIds = [];
  const send = (phase) => {
    if (!allow || !channel) return;
    if (emitted.has(phase)) return;
    emitted.add(phase);
    const text = PHASE_MESSAGES[phase] || "working on it… ⏳";
    // fire-and-forget; never block the loop on a status message
    return channel
      .send(text)
      .then((created) => {
        if (created && created.id) sentIds.push(created.id);
      })
      .catch(() => {});
  };
  const cleanup = async () => {
    for (const id of sentIds.splice(0)) {
      try {
        if (deleteMessage) await deleteMessage(id);
      } catch {
        // best-effort
      }
    }
  };
  return { send, cleanup };
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
  if (context.username || context.user_id) {
    userEntry.author = { id: context.user_id, name: context.username };
  }
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
  const authorLabel = (a) => (a && (a.name || a.id)) ? `[${a.name || a.id}] ` : "";
  if (updatedState.summary) {
    messages.push({ role: "system", content: `Summary of previous conversation: ${updatedState.summary}` });
  }
  updatedState.history.forEach((h) =>
    messages.push({ role: h.role, content: `${authorLabel(h.author)}${h.content}` })
  );
  messages.push({ role: "user", content: `${authorLabel({ name: context.username, id: context.user_id })}${context.content}` });

  // Fast path: for greetings/trivial pings, answer directly without the tool
  // loop so they stay instant and never trigger a search.
  let aiRes;
  let sendStatus = null;
  if (!shouldUseAgentTools(context.content)) {
    aiRes = await generateReply(messages, env);
    aiRes = { ...aiRes, totalTokens: aiRes.tokens };
  } else {
    // Progressive feedback: surface search -> fetch -> compose as staged
    // status messages, throttled per phase. Non-interaction channels only.
    sendStatus = createStatusSender({
      channel: {
        send: (text) => sendChannelMessage(context.channel_id, text, env),
      },
      deleteMessage: (id) => deleteChannelMessage(context.channel_id, id, env),
      allow: !context.interaction && !!context.channel_id,
    });
    aiRes = await runAgentLoop({ messages, env, onPhase: sendStatus.send });
  }

  const fromWus = aiRes.provider === "wus";
  const assistantEntry = {
    role: "assistant",
    content: fromWus ? WUS_SANITIZED_PLACEHOLDER : aiRes.text,
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
    const sendOpts = {};
    if (context.message_id) {
      sendOpts.replyTo = context.message_id;
      sendOpts.pingAuthor = env.PING_AUTHOR === "true";
    }
    await sendChannelMessage(
      context.channel_id,
      fromWus ? `${WUS_REPLY_TAG} ${aiRes.text}` : aiRes.text,
      env,
      sendOpts
    );
  }

  // Best-effort: remove the interim status messages now that the final
  // answer is up. Errors are swallowed inside cleanup.
  if (sendStatus) {
    await sendStatus.cleanup().catch(() => {});
  }

  return { reply: aiRes.text, provider: aiRes.provider };
}
