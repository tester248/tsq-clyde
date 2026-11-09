# Klyde Bounded Memory (Phase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `memory` agent tool (add/patch/remove, two targets) with hard caps, persist channel notes + user profiles in the per-channel ConversationDO, and inject them into the prompt each turn.

**Architecture:** New DO state fields + routes; a `memory` tool in `tools.js`; prompt injection in `processor.js`; env plumbing (`CONVERSATION_STUB`/`KEY`/`CURRENT_USER_ID`).

**Spec:** `docs/superpowers/specs/2026-11-09-klyde-bounded-memory-spec.md`

## Global Constraints

- Caps: `2200` channel memory, `1375` per-user profile.
- Tool actions never throw; return plain values like the other tools.
- Target `user` = current asker only.
- `/clear` resets history + channel memory, keeps profiles.
- Exact duplicates skipped; over-capacity returns consolidation error; zero-width/control chars rejected.

## Review Focus

- add/patch/remove semantics incl. ambiguous-match error and duplicate skip.
- Over-capacity error message names cap, current size, chars needed.
- Both stores persist across `initialize`.
- `/clear` semantics.
- Prompt injection labels + capacity fractions; only when non-empty.
- Everything above pinned by tests.

---

### Task 1: ConversationDO memory state + routes

**Files:** Modify `src/conversation_do.js`; Test `test/conversation.test.mjs`

**Interfaces:**
- Produces: `state.memory` (string), `state.userProfiles` (map); routes `/memoryGet`, `/setMemory`, `/getUserProfile`, `/setUserProfile`; `/clear` resets memory but keeps profiles.

- [ ] **Step 1: Write failing tests** — initialize/persist; set/get memory; set/get profile; clear keeps profiles but wipes memory+history; unknown route 404.
- [ ] **Step 2: Run tests, confirm FAIL.**
- [ ] **Step 3: Implement** — state fields in constructor; routes in `fetch`; `/clear` updated.
- [ ] **Step 4: Run tests, confirm PASS.**
- [ ] **Step 5: Commit** — `feat(conversation): bounded memory state + routes`.

### Task 2: memory tool

**Files:** Modify `src/tools.js`; Test `test/tools.test.mjs`

**Interfaces:**
- Produces: `memory` entry in `AGENT_TOOLS` and `TOOL_IMPLS`; reads/writes via `env.CONVERSATION_STUB`, `env.CONVERSATION_KEY`, `env.CURRENT_USER_ID`. Exports `MEMORY_CHANNEL_LIMIT`, `MEMORY_USER_LIMIT` (or from a shared module) for tests.

- [ ] **Step 1: Write failing tests** — using a fake stub env: add appends; duplicate returns note; patch replaces unique substring; ambiguous patch returns error with candidates; remove deletes; over-capacity add returns consolidation error; zero-width content rejected; unknown action error; target `user` uses `CURRENT_USER_ID`.
- [ ] **Step 2: Run tests, confirm FAIL.**
- [ ] **Step 3: Implement** — `memoryTool` def + `memoryImpl`, shared with the DO's caps.
- [ ] **Step 4: Run tests, confirm PASS.**
- [ ] **Step 5: Commit** — `feat(tools): add memory tool (add/patch/remove)`.

### Task 3: Prompt injection + env plumbing

**Files:** Modify `src/processor.js`; Test `test/processor.test.mjs`

**Interfaces:**
- Produces: system messages for channel memory + current asker profile; `toolEnv` with `CONVERSATION_STUB`/`KEY`/`CURRENT_USER_ID` passed to `runAgentLoop`.

- [ ] **Step 1: Write failing tests** — memory block appears with label + capacity fraction; profile block appears for current asker; absent when empty; toolEnv plumbing visible to a spy `executeTool`.
- [ ] **Step 2: Run tests, confirm FAIL.**
- [ ] **Step 3: Implement** — inject blocks after summary; build `toolEnv`; pass to `runAgentLoop`.
- [ ] **Step 4: Run full suite.**
- [ ] **Step 5: Commit** — `feat(processor): inject bounded memory + user profile into prompt`.

### Task 4: Deploy + live verify + README + tag

- [ ] **Step 1:** `npx wrangler deploy`; confirm `/gateway/status` connected.
- [ ] **Step 2:** Live — ask Klyde to remember a channel fact; confirm later turn acts on it.
- [ ] **Step 3:** README — add "Memory" section under Agent & AI pipeline; list caps and the memory tool; note Phase 2/3 (skills, session search) as roadmap.
- [ ] **Step 4:** Commit README (`docs: document bounded memory`).
- [ ] **Step 5:** Tag `v0.5.0` and push.

## Self-Review

1. Spec coverage: storage (T1), tool (T2), injection (T3), deploy/README/tag (T4).
2. Each step is one checkable action.
3. Type consistency: caps shared between DO and tool; stub keys match across processor/tool/DO.
4. Review Focus all mapped to T1–T3 tests.
