// Multi-provider AI router: Mercury 3 (Inception) primary, Groq fallback,
// Workers AI granite-micro as a last resort. Providers are tried left-to-right
// and advance ONLY on a real failure (HTTP error / thrown error) — never on a
// guessed quota/token counter.

export const PROVIDERS = ["inception", "groq", "workers-ai"];

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
  "workers-ai": workersAiReply,
};

export async function callLLM(messages, env, opts = {}) {
  const failures = [];
  for (const name of PROVIDERS) {
    try {
      const out = await PROVIDER_FNS[name](messages, env, opts.tools ? { tools: opts.tools } : {});
      return { message: out.message, provider: name, tokens: out.tokens };
    } catch (err) {
      failures.push(`${name}: ${err?.message || err}`);
    }
  }
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
