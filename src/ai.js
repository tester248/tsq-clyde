// Multi-provider AI router: Mercury 3 (Inception) primary, Groq fallback,
// WUS router fallback, Workers AI granite-micro as a last resort. Providers
// are tried left-to-right and advance ONLY on a real failure (HTTP error /
// thrown error) — never on a guessed quota/token counter.

export const PROVIDERS = ["inception", "groq", "wus", "workers-ai"];

const TIMEOUT_MS = 25_000;

async function fetchWithTimeout(url, init, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function openAiCompletion(url, model, messages, apiKey, extra = {}) {
  const payload = {
    model,
    messages,
    temperature: 0.7,
    max_completion_tokens: 700,
    ...extra,
  };
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${model} request failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const message = data.choices?.[0]?.message || null;
  const tokens = data.usage?.total_tokens || 0;
  return { message, tokens };
}

async function inceptionReply(messages, env, extra = {}) {
  if (!env.INCEPTION_API_KEY) throw new Error("INCEPTION_API_KEY not configured");
  return openAiCompletion(
    "https://api.inceptionlabs.ai/v1/chat/completions",
    "mercury-3",
    messages,
    env.INCEPTION_API_KEY,
    { reasoning_effort: "low", ...extra }
  );
}

async function groqReply(messages, env, extra = {}) {
  if (!env.GROQ_API_KEY) throw new Error("GROQ_API_KEY not configured");
  return openAiCompletion(
    "https://api.groq.com/openai/v1/chat/completions",
    "openai/gpt-oss-120b",
    messages,
    env.GROQ_API_KEY,
    extra
  );
}

async function wusReply(messages, env, extra = {}) {
  if (!env.WUS_API_KEY) throw new Error("WUS_API_KEY not configured");
  return openAiCompletion(
    "https://wusrouter.com/v1/chat/completions",
    "uncensored/deepseek-v4.1-flash:free",
    messages,
    env.WUS_API_KEY,
    extra
  );
}

async function workersAiReply(messages, env) {
  if (!env.AI || typeof env.AI.run !== "function") {
    throw new Error("Workers AI binding (env.AI) not configured");
  }
  const model = "@cf/ibm-granite/granite-4.0-h-micro";
  const result = await env.AI.run(model, { messages });
  const text = result?.response ?? "";
  if (!text) throw new Error("Workers AI returned empty response");
  // Workers AI returns usage.neurons, not tokens; report tokens as 0.
  // Workers AI has no tool-call support; return a plain assistant message.
  return { message: { role: "assistant", content: text }, tokens: 0, model };
}

const PROVIDER_FNS = {
  inception: inceptionReply,
  groq: groqReply,
  wus: wusReply,
  "workers-ai": workersAiReply,
};

// Sentinel the model is instructed to emit when it declines to answer. A
// single exact token is far more reliable than guessing at English phrasing.
export const REFUSAL_SENTINEL = "##REFUSED##";

// Refusal phrases that signal a provider declined to answer. Deliberately
// conservative to avoid false positives (a real answer being mistaken for a
// refusal and needlessly escalated). Patterns require a refusal VERB near the
// start of the sentence (i can't/won't + verb), so a normal answer that merely
// mentions inability in passing is not flagged.
const REFUSAL_PATTERNS = [
  // "I can't/cannot/won't <verb> ..." but NOT when the clause is immediately
  // followed by ", but <answer>" — that's an answer that mentions inability in
  // passing, not a refusal.
  /\bi (can'?t|cannot|won'?t|will not|refuse to)\s+\w+(?![^.?!]*,\s*but\b)/i,
  // Inability phrasings.
  /\bi'?m (not able|unable)\b/i,
  /\bi am (not able|unable)\b/i,
  /\b(not able|unable) to (provide|help|assist|create|write|generate|answer)\b/i,
  // Style/role disclaimers.
  /\bas an ai (language model|assistant|model)\b/i,
  /\bi'?m (just )?an ai\b/i,
  // Declining to discuss / preferring not to.
  /\bi'?d rather not\b/i,
  /\b(i'?ll|i will) have to decline\b/i,
];

// Normalize unicode punctuation to ASCII so smart quotes (’ “ ”) and em/en
// dashes match the ASCII patterns below. Also collapses a mojibake apostrophe
// sequence (â€™) seen from some providers.
function normalizeForMatch(text) {
  return text
    .replace(/\u00e2\u20ac\u2122/g, "'") // mojibake ’
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

// A response is a refusal when it has no usable answer: the sentinel token,
// empty content, or text matching a refusal phrase. A tool-call round is never
// a refusal.
export function isRefusal(message) {
  if (!message) return true;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false;
  const raw = typeof message.content === "string" ? message.content : "";
  if (!raw.trim()) return true;
  const content = normalizeForMatch(raw);
  if (content.includes(REFUSAL_SENTINEL)) return true;
  return REFUSAL_PATTERNS.some((re) => re.test(content));
}

export async function callLLM(messages, env, opts = {}) {
  const failures = [];
  let lastResponse = null; // last non-empty answer, used if everyone declines
  for (const name of PROVIDERS) {
    try {
      const out = await PROVIDER_FNS[name](messages, env, opts.tools ? { tools: opts.tools } : {});
      // A refusal is a successful response that declines to answer. Treat it
      // like a failure for this provider and try the next tier (escalation).
      if (isRefusal(out.message)) {
        if (out.message?.content) lastResponse = { message: out.message, provider: name, tokens: out.tokens };
        failures.push(`${name}: refused`);
        continue;
      }
      return { message: out.message, provider: name, tokens: out.tokens };
    } catch (err) {
      failures.push(`${name}: ${err?.message || err}`);
    }
  }
  // Everyone failed or declined. Prefer returning the last real answer (e.g.
  // the most recent refusal) over a generic error.
  if (lastResponse) return lastResponse;
  throw new Error(`all providers failed — ${failures.join(" | ")}`);
}

export async function generateReply(messages, env) {
  const { message, provider, tokens } = await callLLM(messages, env);
  return { text: message?.content ?? "", tokens, provider };
}

export async function summarizeConversation(history, env) {
  const prompt = [
    { role: "system", content: "Please provide a concise summary of the conversation so far." },
  ];
  return generateReply(prompt.concat(history), env);
}
