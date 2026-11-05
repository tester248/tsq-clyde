#!/usr/bin/env node
// Lists Workers AI text-generation models with input/output token pricing.
//
// Usage: node scripts/list-models.mjs [--json] [--all]
// Auth: reads CLOUDFLARE_API_TOKEN (or run `wrangler auth token`), plus
// CLOUDFLARE_ACCOUNT_ID from the active wrangler profile.

const acct =
  process.env.CLOUDFLARE_ACCOUNT_ID ||
  (await import("node:child_process"))
    .execSync("npx wrangler whoami 2>&1")
    .toString()
    .match(/([0-9a-f]{32})/)?.[1];

import { readFileSync } from "node:fs";

function wranglerToken() {
  const home = process.env.USERPROFILE || process.env.HOME;
  const toml = readFileSync(`${home}/.wrangler/config/default.toml`, "utf8");
  return toml.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
}

const token = process.env.CLOUDFLARE_API_TOKEN || wranglerToken();

if (!acct || !token) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
  process.exit(1);
}

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/models/search?per_page=500`,
  { headers: { Authorization: `Bearer ${token}` } }
);
if (!res.ok) {
  console.error(`models/search failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const { result: models } = await res.json();

const priceOf = (m, needle) => {
  const p = (m.properties || []).find((x) => x.property_id === "price")?.value || [];
  return p.find((x) => x.unit.includes(needle))?.price;
};
const prop = (m, id) => (m.properties || []).find((x) => x.property_id === id)?.value;

// Chat-capable: priced per M output tokens, has a context window.
const chat = models
  .filter((m) => priceOf(m, "output tokens") != null && prop(m, "context_window"))
  .map((m) => ({
    name: m.name,
    context: Number(prop(m, "context_window")),
    input: priceOf(m, "input tokens"),
    output: priceOf(m, "output tokens"),
    // Neurons per M output tokens ~= output $ * 1e6 / $0.011 / 1000
    neurons: Math.round((priceOf(m, "output tokens") * 1e6) / 11),
    reasoning: prop(m, "reasoning") === "true",
    tools: prop(m, "function_calling") === "true",
  }))
  .sort((a, b) => a.output - b.output);

// 10,000 free neurons/day -> rough short-reply budget (300 output tokens).
const FREE_NEURONS = 10_000;

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(chat, null, 2));
} else {
  console.log(
    `${chat.length} text-generation models. Free pool: ${FREE_NEURONS.toLocaleString()} neurons/day.\n`
  );
  console.log(
    "output $/Mtok  neurons/Mtok  ~replies/day  ctx      model"
  );
  for (const m of chat) {
    const perReply = (m.neurons * 300) / 1e6;
    const replies = Math.floor(FREE_NEURONS / perReply);
    console.log(
      `${String(m.output).padStart(9)}  ${String(m.neurons).padStart(11)}  ${String(
        replies
      ).padStart(12)}  ${String(m.context).padStart(7)}  ${m.name}`
    );
  }
}