#!/usr/bin/env node
// Re-probe with adequate max_tokens. Reasoning models (gpt-oss, qwq,
// deepseek-r1, nemotron) emit reasoning tokens BEFORE content, so a tiny
// max_tokens yields empty content and looks like a failure when it isn't.
//
// Usage: node scripts/probe-models2.mjs [max_tokens] [--all]
// Default: only re-tests models the first probe marked no-text.

import { readFileSync } from "node:fs";

const acct =
  process.env.CLOUDFLARE_ACCOUNT_ID || "68e5a68c1be8e33aeaa5df3e7d45115f";
let token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  const home = process.env.USERPROFILE || process.env.HOME;
  token = readFileSync(`${home}/.wrangler/config/default.toml`, "utf8").match(
    /oauth_token\s*=\s*"([^"]+)"/
  )?.[1];
}
const auth = { Authorization: `Bearer ${token}` };
const maxTokens = Number(process.argv.find((a) => /^\d+$/.test(a))) || 200;
const testAll = process.argv.includes("--all");

const cat = await (
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/models/search?per_page=500`, {
    headers: auth,
  })
).json();
const prop = (m, id) => (m.properties || []).find((x) => x.property_id === id)?.value;
const priceOf = (m, n) => (prop(m, "price") || []).find((x) => x.unit.includes(n))?.price;

let candidates = (cat.result || []).filter(
  (m) => priceOf(m, "output tokens") != null && prop(m, "context_window")
);

const results = [];
for (const m of candidates) {
  const name = m.name;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90_000);
  let status = "ok";
  let text = "";
  let reasoning = "";
  let neurons = null;
  let detail = null;
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${name}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: name,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: maxTokens,
      }),
      signal: ctl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      status = res.status === 403 ? "needs-paid" : `http-${res.status}`;
      detail = body?.errors?.[0]?.message?.slice(0, 70) || null;
    } else {
      const msg = body?.result?.choices?.[0]?.message;
      text = msg?.content ?? "";
      reasoning = msg?.reasoning_content ?? msg?.reasoning ?? "";
      neurons = body?.usage?.neurons ?? null;
      if (!text && !reasoning) {
        status = "no-text";
        detail = Object.keys(msg || {}).join(",");
      }
    }
  } catch (e) {
    status = e.name === "AbortError" ? "timeout" : "error";
  } finally {
    clearTimeout(timer);
  }
  results.push({
    name,
    status,
    ok: status === "ok",
    sample: text.slice(0, 60) || (reasoning ? "(reasoning only)" : ""),
    reasoningOnly: !text && !!reasoning,
    neurons,
    ctx: Number(prop(m, "context_window")),
    out$: priceOf(m, "output tokens"),
  });
  process.stderr.write(
    `${status.padEnd(10)} ${text ? "TEXT " : reasoning ? "REASN" : "-----"} ${name}\n`
  );
}

const ok = results.filter((r) => r.ok).sort((a, b) => a.out$ - b.out$);
console.log(`\nmax_tokens=${maxTokens} | answered: ${ok.length}/${results.length}\n`);
console.log("out$/Mtok   neurons(probe)  reasoning?  ctx      model");
for (const r of ok) {
  console.log(
    `${String(r.out$).padStart(9)}  ${String(r.neurons?.toFixed(4) ?? "?").padStart(13)}  ${String(
      r.reasoningOnly ? "yes(reply needs 2x tokens)"
      : "no"
    ).padStart(10)}  ${String(r.ctx).padStart(7)}  ${r.name}`
  );
  console.log(`${"".padStart(9)}  reply: "${r.sample}"`);
}
const bad = results.filter((r) => !r.ok);
if (bad.length) {
  console.log(`\nUNUSABLE (${bad.length}):`);
  for (const r of bad) console.log(`  ${r.status.padEnd(10)} ${r.name}${r.detail ? ` -- ${r.detail}` : ""}`);
}