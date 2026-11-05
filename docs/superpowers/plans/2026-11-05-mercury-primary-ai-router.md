# Mercury 3 Primary + Fallback Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mercury 3 (Inception API) the primary model for bot replies, with a configurable fallback chain (Groq then Workers AI granite-micro). Replace the guessed-token-counter `selectModel` with real failure-driven routing.

**Architecture:** A new `src/ai.js` module exposes `generateReply(messages, env)` that tries providers in order: Mercury 3 → Groq → Workers AI. Each provider is a thin, tested function returning `{ text, tokens }`; on any error it throws and the router advances to the next. The per-channel `ConversationDO` history logic is unchanged. `summarizeConversation` also moves to the same router. The old `selectModel`/`MODELS`/`FREE_TOKEN_QUOTA` guessing is deleted.

**Tech Stack:** Fetch (Workers), event/ai/run for Workers AI, existing DO pipeline. Node test runner.

**Spec:** Carried over from the AI-provider work (2026-10/11): Mercury 3 OpenAI-compatible at `https://api.inceptionlabs.ai/v1`, model `mercury-3`, key `INCEPTION_API_KEY` (secret). Fallback: Groq (`GROQ_API_KEY`) then Workers AI `@cf/ibm-granite/granite-4.0-h-micro` via `env.AI.run`. The multi-provider chain is explicit so a provider outage can't silently kill replies. The Workers AI binding (`env.AI`) must be added to `wrangler.jsonc`.

## Global Constraints

- No secrets in the repo. Keys are read only from `env` at runtime.
- Providers are tried left-to-right; a provider only advances on a thrown error/HTTP failure, never on a token-count guess.
- `ConversationDO` and the gateway DO behavior are untouched.
- Model choice must stay explicit (no hidden `MODELS` array to guess from).

## Review Focus

- A hard provider failure (network, 5xx, 401) falls through to the next provider and still returns a reply. Pinned in Task 3 tests.
- If all providers fail, the error propagates so the caller (gateway `#answerMention`) can log it — no silent empty reply. Pinned in Task 3 tests.
- Workers AI provider respects the binding absence (no `env.AI` → skip it, don't crash). Pinned in Task 3 tests.
- The `summarizeConversation` path also uses the router; if summary fails it must not take down the reply. Pinned in Task 3 tests.

---

### Task 1: Write the provider router

**Files:**
- Create: `src/ai.js`
- Modify: `src/processor.js` (import + use `generateReply`)
- Test: `test/ai.test.mjs`

**Interfaces:**
- Consumes: `env` with optional `INCEPTION_API_KEY`, `GROQ_API_KEY`, `AI` binding
- Produces: `export async function generateReply(messages, env)` → `{ text, tokens, provider }`; `export const PROVIDERS = [...]` describing order; `export async function summarizeConversation(history, env)`

Behavior: `PROVIDERS` order = `["inception", "groq", "workers-ai"]`. `generateReply` iterates, calling the matching provider. Each provider function handles its own fetch, timeout (AbortController), and returns `{ text, tokens }`. Any non-2xx or thrown error → skip to next. If none succeed, throw an error listing the failures. Mercury uses `https://api.inceptionlabs.ai/v1/chat/completions` with model `mercury-3`, `reasoning_effort: "low"`, `temperature: 0.7`, `max_completion_tokens: 700`. Groq uses `https://api.groq.com/openai/v1/chat/completions` model `openai/gpt-oss-120b`. Workers AI: `env.AI.run("@cf/ibm-granite/granite-4.0-h-micro", { messages })`.

- [ ] **Step 1: Write the failing test** — `test/ai.test.mjs` using mocked `fetch` and a fake `env.AI`. Cases: Mercury succeeds (returns text + `provider: "inception"`); Mercury 500 → Groq succeeds; both fail → Workers AI succeeds; all fail → throws with aggregate message; no `env.AI` → skips Workers AI without crashing.
- [ ] **Step 2: Run test to verify it fails** — Run: `node --test test/ai.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `src/ai.js`** per interfaces above. Three small provider functions plus the router.
- [ ] **Step 4: Run test to verify it passes** — Run: `node --test test/ai.test.mjs`. Expected: PASS.
- [ ] **Step 5: Wire into `src/processor.js`** — replace the `callGroqModel`/`selectModel` usage with `generateReply(messages, env)`, and `summarizeConversation` with the router version. Keep `ConversationDO` usage identical.
- [ ] **Step 6: Run full suite** — Run: `npm test`. Expected: all PASS.
- [ ] **Step 7: Commit** — `git add src/ai.js src/processor.js test/ai.test.mjs && git commit -m "feat(ai): Mercury/S3 primary with Groq + Workers AI fallback router"`

### Task 2: Add the Workers AI binding and clean config

**Files:**
- Modify: `wrangler.jsonc`

**Interfaces:**
- Consumes: the current file (restore `GATEWAY_DO` binding already present, add `ai` binding)
- Produces: a deployable config including the `v8` `new_sqlite_classes` migration for `GatewayDO`

- [ ] **Step 1: Inspect current `wrangler.jsonc`** — confirm current bindings/migrations state.
- [ ] **Step 2: Add AI binding** — `"ai": { "binding": "AI" }` (top-level).
- [ ] **Step 3: Add the missing migration** — append the `v8` tag with `new_sqlite_classes: ["GatewayDO"]` (the binding was restored earlier but the class was deleted by v7; without v8 the deploy fails).
- [ ] **Step 4: Validate** — Run: `npx wrangler deploy --dry-run`. Expected: bundle succeeds; bindings list `CONVERSATION_DO`, `GATEWAY_DO`, `LAST_MESSAGE_KV`, `AI`.
- [ ] **Step 5: Commit** — `git add wrangler.jsonc && git commit -m "chore(wrangler): add AI binding and restore GatewayDO migration v8"`

### Task 3: Live verification against real APIs

**Files:**
- (none; uses deployed worker + secrets)

**Interfaces:**
- Consumes: deployed worker with `INCEPTION_API_KEY`, `GROQ_API_KEY`, and the AI binding
- Produces: evidence each provider actually answers

- [ ] **Step 1: Deploy** — Run: `npx wrangler deploy`. Expected: upload succeeds, triggers update.
- [ ] **Step 2: Test Mercury primary** — Run `/ask` or an @mention; confirm a reply comes back, and `GET /gateway/status` → `lastMessage.answered: true`.
- [ ] **Step 3: Test Groq fallback** — Temporarily invalidate `INCEPTION_API_KEY` (or test via a direct script with a bad key) and confirm Groq answers.
- [ ] **Step 4: Test Workers AI fallback** — Confirm granite-micro answers when the first two are unavailable.
- [ ] **Step 5: Confirm all-three-fail path** — Expect a logged error, no silent empty reply.
- [ ] **Step 6: Choose backup** — From live evidence, pin either Groq or granite as the documented fallback. Update README if needed.

## Self-Review

1. Spec coverage: Mercury primary ✓ (T1), Groq fallback ✓ (T1), Workers AI fallback ✓ (T1), no silent failures ✓ (T1 test), binding + migration ✓ (T2), live verification ✓ (T3).
2. Step scan: each step is one checkable action; tests named; signatures pinned.
3. Type consistency: `generateReply(messages, env)` returned shape `{ text, tokens, provider }` consistent across Tasks 1 and 2.
4. Review Focus: all four lines have owning tests in Task 1.
5. Proportion: code blocks only where tests don't determine the shape (provider internals).
