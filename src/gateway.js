// Pure Discord gateway protocol helpers. No imports, no side effects.

export const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

// GUILDS (1<<0) | GUILD_MESSAGES (1<<9). Mention/reply content is delivered
// without the privileged MESSAGE_CONTENT intent, so 513 is all we need.
export const INTENTS = 513;

const FATAL_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const FRESH_CODES = new Set([4001, 4002, 4003, 4005, 4007]);

export function identifyPayload(token) {
  return {
    op: 2,
    d: {
      token,
      intents: INTENTS,
      shard: [0, 1],
      presence: {
        status: "online",
        activities: [{ name: "@mentions", type: 2 }],
        since: null,
        afk: false,
      },
    },
  };
}

export function resumePayload(token, sessionId, seq) {
  return {
    op: 6,
    d: { token, session_id: sessionId, seq },
  };
}

export function heartbeatPayload(seq) {
  return { op: 1, d: seq };
}

// "resume" (default, incl. abnormal closures like 1006),
// "fatal" (do not retry: bad token, sharding/login errors, disallowed intents),
// "fresh" (reconnect with a new identify, dropping the session).
export function classifyClose(code) {
  if (FATAL_CODES.has(code)) return "fatal";
  if (FRESH_CODES.has(code)) return "fresh";
  return "resume";
}

// Exponential backoff: min(60s, 5s * 2^attempt) + 0-1000ms jitter.
// The 5s base respects Discord's 1-identify-per-5s limit so a reconnect
// can never trip the 4008 rate-limit loop on its own.
export function reconnectDelay(attempt) {
  const base = Math.min(60_000, 5000 * 2 ** attempt);
  return base + Math.random() * 1000;
}

export function stripMention(content, botId) {
  if (!botId) return (content || "").trim();
  const mention = new RegExp(`<@!?${botId}>`, "g");
  return content.replace(mention, "").replace(/\s+/g, " ").trim();
}

export function shouldHandleMessage(msg, botId) {
  const author = msg.author || {};
  if (author.bot) return { handle: false };
  if (botId && author.id === botId) return { handle: false };

  const mentionsBot = botId
    ? (msg.mentions || []).some((m) => m.id === botId)
    : false;
  const isReplyToBot = botId
    ? msg.referenced_message?.author?.id === botId
    : !!msg.referenced_message?.author?.bot;

  if (!mentionsBot && !isReplyToBot) return { handle: false };

  const prompt = stripMention(msg.content || "", botId) || "Please continue.";
  return { handle: true, prompt };
}
