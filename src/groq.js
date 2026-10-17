// Groq API helpers (reconstructed from the deployed bundle).

// Both entries must be text chat models served on /v1/chat/completions.
// Whisper (whisper-large-v3*) is speech-to-text only: no context window, no
// text output. Selecting it for a chat reply guarantees a 4xx on every call.
export const MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
const FREE_TOKEN_QUOTA = 100000;

// Primary model while quota remains; smaller/cheaper chat model after.
export function selectModel(modelUsage) {
  const used = Object.values(modelUsage).reduce((a, b) => a + b, 0);
  const remaining = FREE_TOKEN_QUOTA - used;
  if (remaining < 1000) {
    return MODELS[1];
  }
  return MODELS[0];
}

export async function callGroqModel(model, messages, apiKey) {
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const payload = {
    model,
    messages,
    max_tokens: 700,
    temperature: 0.7
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Groq request failed: ${res.status} ${txt}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  const tokens = data.usage?.total_tokens || 0;
  return { text, tokens };
}

export async function summarizeConversation(history, apiKey) {
  const prompt = [{ role: "system", content: "Please provide a concise summary of the conversation so far." }];
  const messages = prompt.concat(history);
  // Same chat-model pool as replies: llama-3.1-8b-instant is an Enterprise
  // model and 404s on a free-tier key.
  const model = MODELS[1];
  return await callGroqModel(model, messages, apiKey);
}
