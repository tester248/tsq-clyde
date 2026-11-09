# Klyde Session Search (Phase 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an FTS5 full-text index of every channel message inside `ConversationDO` (append + backfill, archive semantics) and a `session_search` agent tool that queries it.

**Architecture:** FTS5 virtual table via `stateObj.storage.sql` (guarded); new `/searchMessages` DO route; `session_search` tool in `src/tools.js` reusing the existing `CONVERSATION_STUB` plumbing. No `processor.js` changes.

**Spec:** `docs/superpowers/specs/2026-11-09-klyde-session-search-spec.md`

## Global Constraints

- Index is append-only; survives compaction and `/clear`.
- Query sanitization: unicode letters/digits only, all-terms AND, FTS5 metacharacters stripped.
- `limit` clamped 1–10 (default 5).
- If `storage.sql` is unavailable: search returns a clean error; appends still work (indexing best-effort).
- Tools never throw.

## Review Focus

- Append indexes; search finds terms with snippet + rank.
- Backfill seeds pre-existing history exactly once.
- `setSummary` and `/clear` leave the index intact.
- Sanitization (metacharacters, multi-word AND, empty query).
- limit clamping.
- Missing sql guard.
- `AGENT_TOOLS` at 7 tools.

---

### Task 1: ConversationDO FTS5 table + routes

**Files:** Modify `src/conversation_do.js`; Test `test/conversation.test.mjs`

**Interfaces:**
- Produces: `messages_fts` table (guarded), append indexing, initialize backfill, `/searchMessages?q=&limit=`.

- [ ] **Step 1: Write failing tests** — SQL fake (row store + token matching): append then search finds; backfill on initialize exactly once; setSummary keeps index; clear keeps index; sanitization cases; limit clamp; missing-sql guard; unknown-route 404 unchanged.
- [ ] **Step 2: Run tests, confirm FAIL.**
- [ ] **Step 3: Implement** — constructor guard + table creation; append insert; initialize backfill; `/searchMessages` route + sanitizer + result shape.
- [ ] **Step 4: Run tests, confirm PASS.**
- [ ] **Step 5: Commit** — `feat(conversation): FTS5 session search state + route`.

### Task 2: session_search tool

**Files:** Modify `src/tools.js`; Test `test/tools.test.mjs` (+ tool-count assertions in `test/skills.test.mjs`)

**Interfaces:**
- Produces: `session_search` entry in `AGENT_TOOLS`/`TOOL_IMPLS`; uses `env.CONVERSATION_STUB`; returns `{ matches: [{ author, ts, snippet }] }`.

- [ ] **Step 1: Write failing tests** — stub returns results → formatted matches; missing stub → error; limit passthrough; AGENT_TOOLS has 7.
- [ ] **Step 2: Run tests, confirm FAIL.**
- [ ] **Step 3: Implement** — def + impl.
- [ ] **Step 4: Run full suite.**
- [ ] **Step 5: Commit** — `feat(tools): add session_search tool`.

### Task 3: Deploy + live verify + README + tag

- [ ] **Step 1:** `npx wrangler deploy`; confirm `/gateway/status` connected.
- [ ] **Step 2:** Live (Discord) — after a conversation, ask Klyde to recall an older detail; verify it works even after the live history has compacted/cleared.
- [ ] **Step 3:** README — "Session search" section; update tool list; roadmap note; release entry.
- [ ] **Step 4:** Commit README (`docs: document session search`).
- [ ] **Step 5:** Tag `v0.7.0` and push.

## Self-Review

1. Spec coverage: storage (T1), tool (T2), deploy/README/tag (T3).
2. Each step is one checkable action.
3. Type consistency: sanitizer shared by route and tests; stub key matches memory tool's.
4. Review Focus all mapped to T1/T2 tests.
