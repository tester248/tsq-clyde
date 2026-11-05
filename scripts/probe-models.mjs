#!/usr/bin/env node
// Empirically tests every Workers AI model on THIS account and reports which
// actually answer. Advertised pricing is not access: a model can show full
// pricing and still 403 on a Free plan.
//
// Usage:
//   node scripts/probe-models.mjs            # all chat-ish models
//   node scripts/probe-models.mjs --json
//   node scripts/probe-models.mjs --only @cf/openai/gpt-oss-20b
//
// Auth: reads the local wrangler OAuth token (or CLOUDFLARE_API_TOKEN).
// Never commit a token; never pass one on the command line.

import { readFileSync } from "node:fs";

function creds() {
  const acct =
    process.env.CLOUDFLARE_ACCOUNT_ID ||
    "68e5a68c1be8e33aeaa5df3e7d45115f";
  let token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    const home = process.env.USERPROFILE || process.env.HOME;
    token = readFileSync(`${home}/.wrangler/config/default.toml`, "utf8").match(
      /oauth_token\s*=\s*"([^"]+)"/
    )?.[1];
  }
  return { acct, token };
}

const { acct, token } = creds();
if (!token) {
  console.error("No credential found.");
  process.exit(1);
}

const auth = { Authorization: `Bearer ${token}` };

// Text in / text out models that are NOT chat assistants. Serving these as a
// bot reply is the whisper / llama-guard class of bug.
const NON_CHAT = [
  "whisper", // speech-to-text
  "llama-guard", // safety classifier
  "prompt-guard", // safety classifier
  "gpt-oss-safeguard", // safety classifier
  "embedding", // vectors, not text
  "bge-", // embeddings
  "plamo", // embeddings
  "flux", // image
  "stable-diffusion", // image
  "dreamshaper", // image
  "leonardo", // image
  "phoenix", // image
  "resnet", // image classification
  "distilbert-sst", // sentiment
  "clef", // decision model
  "melotts", // speech
  "aura-", // tts
  "nova-", // stt
  "smart-turn", // audio turn detection
  "m2m100", // translation
  "indictrans", // translation
  "moondream", // vision-only
  "llava", // vision-only
  "resnet",
];
const isNonChat = (n) => NON_CHAT.some((p) => n.toLowerCase().includes(p.toLowerCase()));

const prop = (m, id) => (m.properties || []).find((x) => x.property_id === id)?.value;
const priceOf = (m, needle) =>
  (prop(m, "price") || []).find((x) => x.unit.includes(needle))?.price;

const cat = await (
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/models/search?per_page=500`,
    { headers: auth }
  )
).json();
const models = cat.result || [];

// Candidate set: anything priced per output token with a context window.
let candidates = models.filter(
  (m) => priceOf(m, "output tokens") != null && prop(m, "context_window")
);

const only = process.argv.indexOf("--only");
if (only !== -1) {
  const want = process.argv[only + 1];
  candidates = candidates.filter((m) => m.name === want);
}

const rows = [];
for (const m of candidates) {
  const name = m.name;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let status = "ok";
  let neurons = null;
  let detail = null;
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${name}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: name,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 12,
      }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      status = res.status === 403 ? "needs-paid" : res.status === 402 ? "no-balance" : `http-${res.status}`;
      detail = body?.errors?.[0]?.message?.slice(0, 80) || null;
    } else {
      neurons = body?.usage?.neurons ?? null;
      const text = body?.result?.choices?.[0]?.message?.content ?? "";
      if (!text) {
        status = "no-text";
        detail = "responded with no text content";
      }
    }
  } catch (err) {
    status = err.name === "AbortError" ? "timeout" : "error";
  } finally {
    clearTimeout(timer);
  }
  rows.push({
    name,
    ok: status === "ok" && !isNonChat(name),
    status,
    detail,
    neurons,
    ctx: Number(prop(m, "context_window")),
    in$: priceOf(m, "input tokens"),
    out$: priceOf(m, "output tokens"),
    nonChat: isNonChat(name),
  });
  process.stderr.write(`${status.padEnd(10)} ${name}\n`);
}

const usable = rows
  .filter((r) => r.ok)
  .sort((a, b) => (a.out$ ?? 9e9) - (b.out$ ?? 9e9));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ usable, all: rows }, null, 2));
} else {
  const FREE = 10_000;
  console.log(`\nProbed ${rows.length} models. USABLE: ${usable.length}\n`);
  console.log("out$/Mtok  neurons/1k*  ~replies/day  ctx      model");
  for (const r of usable) {
    // Measured neurons for a ~12-token reply, scaled to 300-token replies.
    const per300 = r.neurons ? (r.neurons / 300) * 10_000 : null;
    const replies = per300 ? Math.floor(FREE / per300) : null;
    console.log(
      `${String(r.out$).padStart(9)}  ${String(per300?.toFixed(2) ?? "?").padStart(11)}  ${String(
        replies ?? "?"
      ).padStart(12)}  ${String(r.ctx).padStart(7)}  ${r.name}`
    );
  }
  const blocked = rows.filter((r) => !r.ok);
  if (blocked.length) {
    console.log(`\nNOT USABLE (${blocked.length}):`);
    for (const r of blocked) {
      console.log(`  ${r.status.padEnd(10)} ${r.name}${r.detail ? ` -- ${r.detail}` : ""}`);
    }
  }
  const warned = usable.filter((r) => r.nonChat);
  if (warned.length) {
    console.log(`\nWARNING - chat-shaped but classified non-chat:`);
    for (const r of warned) console.log(`  ${r.name}`);
  }
}