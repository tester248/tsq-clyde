// Message processing: conversation state (per-channel Durable Object) + AI replies.

import { generateReply, summarizeConversation, REFUSAL_SENTINEL, FRIENDLY_REFUSAL } from "./ai.js";
import { runAgentLoop, shouldUseAgentTools } from "./agent.js";
import { sendChannelMessage, deleteChannelMessage } from "./discord.js";
import { MEMORY_CHANNEL_LIMIT, MEMORY_USER_LIMIT } from "./tools.js";

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

// Parse the ADMIN_IDS secret (comma-separated Discord user IDs) into a set.
// Missing/blank secret yields an empty set, so the gate fails closed.
export function adminIds(env) {
  const raw = typeof env?.ADMIN_IDS === "string" ? env.ADMIN_IDS : "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

export function isAdmin(userId, env) {
  if (!userId) return false;
  return adminIds(env).has(String(userId).trim());
}

// A clear request is an explicit phrase, optionally surrounded by other text
// ("hey klyde please clear context now"). Bare "forget" must be the whole
// message so ordinary chat ("what if I forget my password") is not a clear.
const CLEAR_PHRASES = ["clear context", "/clear_context", "reset context", "clear memory"];
export function isClearContextRequest(lower) {
  const s = (lower || "").trim();
  if (!s) return false;
  if (s === "forget") return true;
  return CLEAR_PHRASES.some((p) => s.includes(p));
}

// Deliver a short reply to the channel for non-interaction contexts (mentions).
// Returns true when posted, false when the caller must deliver it instead
// (interaction followups) or there is no channel. Mirrors the final-answer
// send options: threaded under the prompt, ping gated by PING_AUTHOR.
async function deliverChannelReply(text, context, env) {
  if (context.interaction || !context.channel_id) return false;
  const sendOpts = {};
  if (context.message_id) {
    sendOpts.replyTo = context.message_id;
    sendOpts.pingAuthor = env.PING_AUTHOR === "true";
  }
  await sendChannelMessage(context.channel_id, text, env, sendOpts);
  return true;
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

  const lower = (context.content || "").trim().toLowerCase();
  // forceClear is set by the /clear_context slash command, which carries no
  // user text and would otherwise look like an empty prompt.
  const wantsClear = context.forceClear === true || isClearContextRequest(lower);
  if (wantsClear) {
    if (!isAdmin(context.user_id, env)) {
      const reply = "Sorry — only admins can clear this channel's context.";
      const delivered = await deliverChannelReply(reply, context, env);
      return { reply, provider: null, delivered };
    }
    await stub.fetch("https://example.com/clear");
    const reply = "context cleared";
    const delivered = await deliverChannelReply(reply, context, env);
    return { reply, provider: null, delivered };
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
  // Bounded memory (Hermes-inspired): inject the channel notes and the current
  // asker's profile when present, labeled with their capacity fractions so the
  // model knows the headroom. Both are §-delimited, caps enforced by the
  // memory tool and ConversationDO.
  if (updatedState.memory) {
    messages.push({
      role: "system",
      content: `MEMORY (channel notes) [${updatedState.memory.length}/${MEMORY_CHANNEL_LIMIT} chars]\n${updatedState.memory}`,
    });
  }
  const currentProfile = updatedState.userProfiles?.[context.user_id];
  if (currentProfile) {
    messages.push({
      role: "system",
      content: `USER PROFILE [${currentProfile.length}/${MEMORY_USER_LIMIT} chars]\n${currentProfile}`,
    });
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
    // The memory tool needs the DO stub + key and the current asker. These are
    // attached to a shallow env clone so the provider chain still sees every
    // binding, and tools see the memory plumbing.
    const toolEnv = Object.assign(Object.create(env), {
      CONVERSATION_STUB: stub,
      CONVERSATION_KEY: key,
      CURRENT_USER_ID: context.user_id,
    });
    aiRes = await runAgentLoop({ messages, env: toolEnv, onPhase: sendStatus.send });
  }

  // Defense-in-depth: the sentinel is an internal protocol signal. If it ever
  // appears in an answer (e.g. a provider ignored the system prompt and echoed
  // it as real content), swap it for the friendly refusal so it never reaches
  // history or the channel.
  if (typeof aiRes.text === "string" && aiRes.text.includes(REFUSAL_SENTINEL)) {
    aiRes = { ...aiRes, text: FRIENDLY_REFUSAL };
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

  const finalText = fromWus ? `${WUS_REPLY_TAG} ${aiRes.text}` : aiRes.text;
  const delivered = await deliverChannelReply(finalText, context, env);

  // Best-effort: remove the interim status messages now that the final
  // answer is up. Errors are swallowed inside cleanup.
  if (sendStatus) {
    await sendStatus.cleanup().catch(() => {});
  }

  return { reply: aiRes.text, provider: aiRes.provider, delivered };
}

// ---- Minecraft in-game invocation (v0.9.0) ----

// Progress phases for in-game chat (no emoji — they don't render in-game).
const MC_PHASE_MESSAGES = {
  search: "Klyde is searching…",
  fetch: "Klyde is reading sources…",
  compose: "Klyde is composing…",
};

// Format an LLM answer for game chat: strip markdown/structured artifacts
// (line-leading and inline), remove emoji (they render badly/missing in game
// chat), then split into short chunks at sentence boundaries. Minecraft chat
// is read as short lines, not paragraphs.
export function formatGameChat(text, { maxChars = 200, maxMessages = 5 } = {}) {
  const cleaned = String(text || "")
    // strip emoji + variation selectors
    .replace(/[\p{Extended_Pictographic}\uFE0F\u20E3]/gu, "")
    // strip inline markdown: **bold**, *italics*, __underline__, `code`
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    // leftover lone asterisks from malformed emphasis (e.g. "*quick note:**")
    .replace(/\*/g, "")
    // strip line-leading markdown markers
    .split("\n")
    .map((line) => line.replace(/^(\s*)(#+\s*|\*\s*|-\s*|>\s*)/, "$1").trim())
    .filter(Boolean)
    .join(" ");
  if (!cleaned) return [];

  const chunks = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const sentence of cleaned.split(/(?<=[.!?])\s+/)) {
    let rest = sentence;
    while (rest.length > maxChars) {
      if (current) flush();
      current = rest.slice(0, maxChars);
      flush();
      rest = rest.slice(maxChars);
    }
    if (current && current.length + rest.length + 1 > maxChars) flush();
    current = current ? `${current} ${rest}` : rest;
  }
  flush();
  return chunks.slice(0, maxMessages);
}

async function getRosterLine(env) {
  try {
    const binding = env.MINECRAFT_BRIDGE_DO;
    if (!binding) return null;
    const stub = binding.get(binding.idFromName("minecraft"));
    const res = await stub.fetch("https://bridge/rosterGet");
    if (!res.ok) return null;
    const body = await res.json();
    const mods = Array.isArray(body.mods) ? body.mods : [];
    if (mods.length === 0) return null;
    const names = mods
      .slice(0, 30)
      .map((m) => m.name || m.id)
      .filter(Boolean)
      .join(", ");
    return `Server mods (${mods.length}): ${names}`;
  } catch {
    return null;
  }
}

// Headless invocation for in-game queries. Reuses the same brain as Discord:
// per-server ConversationDO (memory/profile/history), the agent loop, the
// provider chain, and sentinel handling. Output is delivered via `deliver`
// callback frames — {kind:"phase"} or {kind:"reply"} — which the bridge DO
// queues to the mod's poller.
export async function processMinecraftInvocation({
  player,
  text,
  deliver,
  env,
  runAgentLoop: loop = runAgentLoop,
}) {
  const key = "minecraft"; // one conversation per server
  const id = env.CONVERSATION_DO.idFromName(key);
  const stub = env.CONVERSATION_DO.get(id);
  await stub.fetch("https://example.com/initialize");

  const userEntry = {
    role: "user",
    content: text,
    timestamp: Date.now(),
    author: { id: player, name: player },
  };
  await stub.fetch("https://example.com/append", {
    method: "POST",
    body: JSON.stringify(userEntry),
  });

  const stateResp = await stub.fetch("https://example.com/get");
  const state = await stateResp.json();

  if (state.tokenCount > MAX_HISTORY_TOKENS) {
    const histMessages = state.history.map((h) => ({ role: h.role, content: h.content }));
    const summaryRes = await summarizeConversation(histMessages, env);
    await stub.fetch("https://example.com/setSummary", {
      method: "POST",
      body: JSON.stringify({ summary: summaryRes.text }),
    });
    await stub.fetch("https://example.com/recordUsage", {
      method: "POST",
      body: JSON.stringify({ model: summaryRes.provider, tokens: summaryRes.tokens }),
    });
  }

  const updatedResp = await stub.fetch("https://example.com/get");
  const updatedState = await updatedResp.json();

  const messages = [];
  // Game-chat style guidance: the agent hint normally injected by the loop is
  // Discord-oriented and skipped when system messages exist, so state it here.
  messages.push({
    role: "system",
    content:
      "You are answering a player inside Minecraft chat. Reply in short, " +
      "plain sentences — no markdown, no emoji, no bullet lists. Only state " +
      "facts you obtained from the provided tools or context; never invent " +
      "server names, versions, mods, or details.",
  });
  if (updatedState.summary) {
    messages.push({ role: "system", content: `Summary of previous conversation: ${updatedState.summary}` });
  }
  if (updatedState.memory) {
    messages.push({
      role: "system",
      content: `MEMORY (channel notes) [${updatedState.memory.length}/${MEMORY_CHANNEL_LIMIT} chars]\n${updatedState.memory}`,
    });
  }
  const profile = updatedState.userProfiles?.[player];
  if (profile) {
    messages.push({
      role: "system",
      content: `USER PROFILE [${profile.length}/${MEMORY_USER_LIMIT} chars]\n${profile}`,
    });
  }
  const rosterLine = await getRosterLine(env);
  if (rosterLine) {
    messages.push({ role: "system", content: rosterLine });
  }
  updatedState.history.forEach((h) =>
    messages.push({ role: h.role, content: h.author ? `[${h.author.name || h.author.id}] ${h.content}` : h.content })
  );
  messages.push({ role: "user", content: `[${player}] ${text}` });

  const toolEnv = Object.assign(Object.create(env), {
    CONVERSATION_STUB: stub,
    CONVERSATION_KEY: key,
    CURRENT_USER_ID: player,
  });

  let aiRes;
  if (!shouldUseAgentTools(text)) {
    aiRes = await generateReply(messages, env);
    aiRes = { ...aiRes, totalTokens: aiRes.tokens };
  } else {
    aiRes = await loop({
      messages,
      env: toolEnv,
      onPhase: (phase) => {
        const msg = MC_PHASE_MESSAGES[phase];
        if (msg) deliver({ kind: "phase", text: msg });
      },
    });
  }

  if (typeof aiRes.text === "string" && aiRes.text.includes(REFUSAL_SENTINEL)) {
    aiRes = { ...aiRes, text: FRIENDLY_REFUSAL };
  }

  await stub.fetch("https://example.com/append", {
    method: "POST",
    body: JSON.stringify({
      role: "assistant",
      content: aiRes.text,
      timestamp: Date.now(),
    }),
  });
  await stub.fetch("https://example.com/recordUsage", {
    method: "POST",
    body: JSON.stringify({ model: aiRes.provider, tokens: aiRes.totalTokens }),
  });

  for (const chunk of formatGameChat(aiRes.text)) {
    deliver({ kind: "reply", text: chunk });
  }
  return { provider: aiRes.provider, chunks: formatGameChat(aiRes.text).length };
}