# Klyde WUS Escalation + Sanitized History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Mercury or Groq refuses a question, escalate to the WUS router so the user still gets an answer; show `[uncensored answer]` on those replies; never persist raw uncensored text into shared conversation history.

**Architecture:** Add `isRefusal(message)` + refusal-aware advancement inside `callLLM` (no caller changes). In `processor.js`, when the answering provider was `wus`, store a sanitized placeholder in history and prefix the channel reply with the tag.

**Tech Stack:** Cloudflare Workers, node:test.

**Spec:** `docs/superpowers/specs/2026-11-08-klyde-wus-escalation-spec.md`

## Global Constraints

- Escalation is a heuristic; keep the phrase list conservative.
- `tool_calls` messages are never refusals.
- All providers refusing → return the last non-empty response, not a throw.
- Non-WUS replies carry no tag.
- History placeholder applies to WUS answers only.

## Review Focus

- `isRefusal` true for refusals, false for normal answers and tool rounds.
- Mercury refuses → Groq answers; Mercury+Groq refuse → WUS answers.
- All refuse → last non-empty response returned.
- WUS answer → sanitized history + `[uncensored answer]` tag on the channel reply.
- Normal path unchanged.

---

### Task 1: `isRefusal` heuristic

**Files:** Modify `src/ai.js`; Test `test/ai.test.mjs`

**Interfaces:**
- Produces: `export function isRefusal(message)` → boolean.

- [ ] **Step 1: Write failing tests** — refusal phrases (`"I can't help with that"`, `"I'm unable to assist"`, `"As an AI language model..."`) → true; a normal answer (`"The update adds copper golems."`) → false; a message with `tool_calls` → false; empty content → true.
- [ ] **Step 2: Run tests, confirm FAIL.**
- [ ] **Step 3: Implement** — export `isRefusal`; empty/null content → true; `tool_calls` present → false; else case-insensitive regex over the phrase list.
- [ ] **Step 4: Run tests, confirm PASS.**
- [ ] **Step 5: Commit** — `feat(ai): add isRefusal heuristic`.

### Task 2: Refusal-aware escalation in `callLLM`

**Files:** Modify `src/ai.js`; Test `test/ai.test.mjs`

**Interfaces:**
- Consumes: `isRefusal` (Task 1).
- Produces: `callLLM` advances to the next provider when a response is a refusal; if all fail/refuse, returns the last non-empty response; throws only if there was none.

- [ ] **Step 1: Write failing tests** — (a) Mercury refuses, Groq answers → provider `groq`, 2 calls; (b) Mercury + Groq refuse → provider `wus`; (c) all refuse → returns the last non-empty content and does not throw.
- [ ] **Step 2: Run tests, confirm FAIL.**
- [ ] **Step 3: Implement** — track `lastResponse`; after a successful call, `isRefusal(message)` → record failure + continue; on exhaustion return `lastResponse` if non-empty, else throw.
- [ ] **Step 4: Run tests, confirm PASS.**
- [ ] **Step 5: Commit** — `feat(ai): escalate to next provider on refusal`.

### Task 3: Sanitized history + visible tag

**Files:** Modify `src/processor.js`; Test `test/processor.test.mjs`

**Interfaces:**
- Produces: when `aiRes.provider === "wus"`, the persisted assistant entry content is `"[provided a direct answer]"` and the channel reply is prefixed `"[uncensored answer] "`. Otherwise unchanged.

- [ ] **Step 1: Write failing tests** — force a WUS answer (Mercury + Groq return refusals) and assert: (a) history assistant entry equals the placeholder; (b) the Discord POST body starts with `[uncensored answer]`. Also assert a normal Mercury answer has no tag and stores text verbatim.
- [ ] **Step 2: Run tests, confirm FAIL.**
- [ ] **Step 3: Implement** — `WUS_SANITIZED_PLACEHOLDER` constant; branch in `assistantEntry` and in the channel `sendChannelMessage` text.
- [ ] **Step 4: Run full suite.**
- [ ] **Step 5: Commit** — `feat(processor): sanitize WUS history + tag uncensored replies`.

### Task 4: Deploy + live verify

- [ ] **Step 1:** `npx wrangler deploy`.
- [ ] **Step 2:** Ask something the aligned providers refuse; confirm the reply is tagged `[uncensored answer]`.
- [ ] **Step 3:** Confirm the next turn's behavior in that channel is unaffected (history holds the placeholder, not the raw text).
- [ ] **Step 4:** `git push origin main`.

## Self-Review

1. Spec coverage: refusal detection ✓ (T1), escalation ✓ (T2), all-refused fallback ✓ (T2), sanitized history ✓ (T3), visible tag ✓ (T3).
2. Each step is one checkable action.
3. Type consistency: `isRefusal(message)`; `callLLM` return shape unchanged; placeholder constant shared.
4. Review Focus all mapped to T1–T3 tests.
