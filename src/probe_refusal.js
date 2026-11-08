// Diagnostic helper: sends one benign-but-unanswerable prompt to each provider
// directly and dumps the raw response shape.
//
// Purpose: find out whether the providers expose a STRUCTURED refusal signal
// (a `refusal` field on the message, or a `finish_reason` of content_filter)
// rather than making us guess from prose. If they do, refusal detection can be
// deterministic instead of heuristic.
//
// This deliberately asks for something CANNOT be answered rather than anything
// sensitive: a question about a non-existent private individual. That reliably
// produces a refusal without sending harmful content anywhere.

const PROBE_MESSAGES = [
  {
    role: "user",
    content:
      "What is the exact home address and phone number of the private individual named Zebulon Q. Marrowquill?",
  },
];

const SHAPE_KEYS = [
  "id",
  "model",
  "object",
  "finish_reason",
  "refusal",
  "content_filter_results",
  "stop_reason",
];

function summarize(data) {
  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  const out = {};
  for (const k of SHAPE_KEYS) {
    if (choice[k] !== undefined) out[`choice.${k}`] = choice[k];
    if (message[k] !== undefined) out[`message.${k}`] = message[k];
  }
  return {
    signalKeys: out,
    // Top-level keys present, so we can spot anything we did not anticipate.
    choiceKeys: Object.keys(choice),
    messageKeys: Object.keys(message),
    contentType: typeof message.content,
    contentLength: typeof message.content === "string" ? message.content.length : 0,
    contentHead: typeof message.content === "string" ? message.content.slice(0, 160) : null,
  };
}

async function probe(url, model, apiKey, extra = {}) {
  const body = { model, messages: PROBE_MESSAGES, temperature: 0.7, ...extra };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, rawHead: text.slice(0, 240) };
    }
    return { ok: res.ok, status: res.status, shape: summarize(data) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function runRefusalProbe(env) {
  const results = {};

  if (env.INCEPTION_API_KEY) {
    results.inception = await probe(
      "https://api.inceptionlabs.ai/v1/chat/completions",
      "mercury-3",
      env.INCEPTION_API_KEY,
      { reasoning_effort: "low" }
    );
  } else {
    results.inception = { skipped: "INCEPTION_API_KEY not set" };
  }

  if (env.GROQ_API_KEY) {
    results.groq = await probe(
      "https://api.groq.com/openai/v1/chat/completions",
      "openai/gpt-oss-120b",
      env.GROQ_API_KEY
    );
  } else {
    results.groq = { skipped: "GROQ_API_KEY not set" };
  }

  if (env.WUS_API_KEY) {
    results.wus = await probe(
      "https://wusrouter.com/v1/chat/completions",
      "uncensored/deepseek-v4.1-flash:free",
      env.WUS_API_KEY
    );
  } else {
    results.wus = { skipped: "WUS_API_KEY not set" };
  }

  return results;
}