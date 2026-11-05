# Klyde Agent — Slice 1: Web Tool Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Klyde a bounded, failure-tolerant web tool loop (`search` + `fetch_url`) so it answers post-cutoff questions with fresh, cited information rather than from memory.

**Architecture:** A tool loop runs inside the existing reply path. The LLM is called with tool definitions; if it returns `tool_calls`, the worker executes them and feeds results back as `tool` messages, looping until the model answers or the budget is spent. Mercury 3 stays primary, with the existing Groq/Workers-AI fallback chain intact. Search uses Tavily's REST API (a single secret), not MCP.

**Tech Stack:** Cloudflare Worker `fetch`, Mercury 3 (Inception) + Groq + Workers AI via the existing `src/ai.js` provider chain, node:test.

**Spec:** `docs/superpowers/specs/2026-11-05-klyde-agent-slice1-web-spec.md`

## Global Constraints

- Loop bounds (from spec): **max 6 iterations**, **~45s total budget**, per-LLM-call timeout 25s, per-tool timeout 15s.
- `fetch_url` only `http:`/`https:`, follow ≤3 redirects, cap response at ~64KB text.
- Search provider is a **single secret** (`TAVILY_API_KEY`), read from `env` at runtime — never committed.
- The normal no-tool message path must not add latency or extra LLM calls.
- `summarizeConversation` stays single-shot (no tools).

## Review Focus

- Model asks to search → tool runs → result fed back → final answer uses it (proves the loop is real).
- Model calls no tool → returns immediately, no extra LLM calls, no latency regression.
- Tool throws (429/network) → the model is told the tool failed and a final answer still comes back; no crash/hang.
- Loop hits iteration/time budget → terminates with the best answer so far plus a "couldn't finish" note.
- `fetch_url` rejects non-HTTP or oversized pages gracefully.

---

### Task 1: Refactor `src/ai.js` to expose `callLLM` (full assistant message + tool_calls)

**Files:**
- Modify: `src/ai.js`
- Modify: `test/ai.test.mjs`

**Interfaces:**
- Consumes: nothing new (uses existing `env` providers)
- Produces: `export async function callLLM(messages, env, opts = {}) → { message, provider, tokens }` where `message` is the raw assistant message object (`{ role: "assistant", content: string|null, tool_calls?: [...] }`); `generateReply(messages, env)` is reimplemented as a thin wrapper returning `{ text: message.content ?? "", tokens, provider }` so all existing callers/tests stay valid.

- [ ] **Step 1: Write the failing test** — add to `test/ai.test.mjs`:
  - `callLLM` returns the raw assistant `message` including `tool_calls` when the provider returns them (mock a completion with `choices[0].message.tool_calls`).
  - `generateReply` still returns `{ text, tokens, provider }` for a normal text completion (unchanged behavior).
- [ ] **Step 2: Run test to verify it fails** — Run: `node --test test/ai.test.mjs`. Expected: FAIL (no `callLLM` export).
- [ ] **Step 3: Implement** — change `openAiCompletion` (and the per-provider functions) to return a full `{ message, tokens }` (keep accounting `usage.total_tokens`). Add `callLLM` that loops `PROVIDERS` (same fallback semantics); on success returns `{ message, provider, tokens }`. Reimplement `generateReply` via `callLLM`. Workers-AI provider returns `{ message: { role: "assistant", content: result.response }, tokens: 0 }` (no tool support — acceptable for a last-resort fallback).
- [ ] **Step 4: Run test to verify it passes** — Run: `node --test test/ai.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add src/ai.js test/ai.test.mjs && git commit -m "refactor(ai): expose callLLM returning full assistant message for tool support"`

### Task 2: Implement the tool registry — `src/tools.js`

**Files:**
- Create: `src/tools.js`
- Create: `test/tools.test.mjs`

**Interfaces:**
- Consumes: `env.TAVILY_API_KEY`, `env.SEARCH_PROVIDER` (default `"tavily"`)
- Produces: `export const AGENT_TOOLS` (array of OpenAI-format tool definitions for `search` and `fetch_url`); `export async function executeTool(name, args, env) → Promise<object>` returning a plain value or `{ error: string }` (never throws).

Pinned shapes:
- `search` input `{ query: string, num_results?: number }` → Tavily `POST https://api.tavily.com/search` body `{ query, max_results: num_results ?? 5 }`, header `Authorization: Bearer <env.TAVILY_API_KEY>`; response `results[]` mapped to `{ title, url, snippet: content }`.
- `fetch_url` input `{ url: string }` → validate scheme `http:`/`https:`; `fetch(url, { redirect: "follow" })`; read text, cap at 64KB; strip HTML to text; return `{ text }` or `{ error }`.

- [ ] **Step 1: Write the failing test** — `test/tools.test.mjs` with mocked global `fetch`:
  - `search` returns mapped results with the Tavily URL + key header.
  - `search` on 429/network returns `{ error }` (does not throw).
  - `fetch_url` returns stripped text for a normal page, `{ error }` for a `javascript:` URL, and `{ error }` for an oversized body.
  - `executeTool("unknown", …)` → `{ error }`.
- [ ] **Step 2: Run test to verify it fails** — Run: `node --test test/tools.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `src/tools.js`** per interfaces above. Use a small HTML→text stripper (drop `<script>`/`<style>`, tags, decode common entities).
- [ ] **Step 4: Run test to verify it passes** — Run: `node --test test/tools.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add src/tools.js test/tools.test.mjs && git commit -m "feat(tools): add search (Tavily) and fetch_url tools"`

### Task 3: Implement the bounded agent loop — `src/agent.js`

**Files:**
- Create: `src/agent.js`
- Create: `test/agent.test.mjs`

**Interfaces:**
- Consumes: `callLLM` (Task 1), `executeTool` / `AGENT_TOOLS` (Task 2)
- Produces: `export async function runAgentLoop({ messages, env, tools = AGENT_TOOLS, maxIterations = 6, budgetMs = 45000, llm = callLLM, onTool }) → { text, provider, iterations, truncated, totalTokens }`

Behavior: start `messages`; loop ≤`maxIterations` (and while elapsed < `budgetMs`): call `llm(current, env, { tools })`; push the assistant `message`; if no `message.tool_calls`, return `{ text: message.content ?? "", provider, iterations, truncated: false, totalTokens }`. Otherwise call `onTool(name, args)` if provided (used for interim feedback), execute each call via `executeTool`, push `{ role: "tool", tool_call_id, content: JSON.stringify(result) }`, and continue. On budget/iteration exhaustion, return the last assistant content (or a fallback string) with `truncated: true`.

- [ ] **Step 1: Write the failing test** — `test/agent.test.mjs` injecting a fake `llm` (no network):
  - no tool_calls → returns text immediately, `llm` called once.
  - ask → tool_calls → `onTool` invoked → tool result fed back → final answer uses it (assert the tool message reached `llm`).
  - tool errors (`executeTool` returns `{ error }`) → still returns a final answer, no throw.
  - `maxIterations: 2` with persistent tool_calls → returns with `truncated: true`.
- [ ] **Step 2: Run test to verify it fails** — Run: `node --test test/agent.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `src/agent.js`** per interfaces above.
- [ ] **Step 4: Run test to verify it passes** — Run: `node --test test/agent.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add src/agent.js test/agent.test.mjs && git commit -m "feat(agent): add bounded tool loop with error tolerance"`

### Task 4: Wire the loop into `src/processor.js`, add interim feedback + secret

**Files:**
- Modify: `src/processor.js`
- Modify: `test/worker.test.mjs` (only if a behavior changes — otherwise unchanged)
- Modify: README (ops note for the new secret)

**Interfaces:**
- Consumes: `runAgentLoop` (Task 3), `sendChannelMessage` (existing)
- Produces: `processMessage` uses `runAgentLoop` for the reply path; `onTool` sends one interim `"Searching…"` message to `context.channel_id` (only when a tool first fires and the channel exists, and never for slash-deferred/no-channel paths).

- [ ] **Step 1: Write the failing test** — if not already covered, add an assertion to `test/processor`-style coverage that `processMessage` returns `{ reply, provider }` and that a tool-using run posts the interim message once. (Use a fake `env` with `TAVILY_API_KEY` and mocked `fetch`; keep it small.)
- [ ] **Step 2: Run test to verify it fails** — expected failure only if the assertion is new.
- [ ] **Step 3: Implement** — in `processMessage`, replace `generateReply(messages, env)` with `runAgentLoop({ messages, env, onTool })`; sum `totalTokens` for `recordUsage`; return `{ reply, provider }`. Add the `onTool` interim-message logic.
- [ ] **Step 4: Run full suite** — Run: `npm test`. Expected: all PASS.
- [ ] **Step 5: Validate deployability** — Run: `npx wrangler deploy --dry-run`. Expected: bundle succeeds, bindings unchanged.
- [ ] **Step 6: Add secret + live verify** — Run: `npx wrangler secret put TAVILY_API_KEY` (interactive). Deploy, then exercise `/ai/selfcheck` and a live Discord ping with a post-cutoff question; confirm a cited current answer appears, and that a normal message still responds immediately with no tool call.
- [ ] **Step 7: Commit** — `git add src/processor.js test/... README.md && git commit -m "feat(agent): wire tool loop into reply path with interim feedback"`

## Self-Review

1. Spec coverage: search/fetch tools ✓ (Task 2), bounded loop ✓ (Task 3), wiring ✓ (Task 4), provider-secret ✓ (Task 4), no-regression normal path ✓ (Task 3 test), summarize stays single-shot ✓ (untouched).
2. Step scan: every step is one checkable action; tests named; signatures pinned.
3. Type consistency: `runAgentLoop`, `executeTool`, `AGENT_TOOLS`, `callLLM` names agree across Tasks 1–4.
4. Review Focus: all five lines map to tests in Tasks 2–3.
5. Proportion: code blocks only where the signature/tests don't determine the body (loop internals, HTML stripper).
