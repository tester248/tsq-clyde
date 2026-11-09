# Klyde Skills (Phase 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three skills tools (`skills_list`, `skill_view`, `skill_manage`) backed by a dedicated `SKILLS_KV` namespace, with SKILL.md frontmatter parsing and validation — Hermes-style progressive disclosure.

**Architecture:** New KV binding; tool defs + impls in `src/tools.js`; tests in a new `test/skills.test.mjs`. No changes to `processor.js`/`agent.js`/DOs.

**Spec:** `docs/superpowers/specs/2026-11-09-klyde-skills-spec.md`

## Global Constraints

- Slug `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤64 chars.
- Per-skill content ≤ `8000` chars; total ≤ `200` skills.
- Reject control/invisible unicode (same `UNSAFE_MEMORY_PATTERN`).
- Tools never throw; missing binding → `{ error }`.

## Review Focus

- skills_list parses frontmatter, sorts, handles empty store.
- skill_view round-trips raw content; unknown slug → error.
- skill_manage create/patch/delete semantics + duplicate/missing errors.
- Slug + size + unsafe-char validation.
- AGENT_TOOLS has all 5 tools.

---

### Task 1: KV binding

**Files:** Modify `wrangler.jsonc`

- [ ] **Step 1:** Add `SKILLS_KV` to `kv_namespaces` (id `517b7b54995a4b5091d8266fa15aa8a4`).
- [ ] **Step 2:** Commit — `chore(wrangler): add SKILLS_KV binding`.

### Task 2: Skills tools

**Files:** Modify `src/tools.js`; Test `test/skills.test.mjs` (new)

**Interfaces:**
- Produces: `skills_list`, `skill_view`, `skill_manage` in `AGENT_TOOLS` and `TOOL_IMPLS`; exports `SKILL_MAX_CHARS`, `SKILL_MAX_COUNT`, `SKILL_SLUG_PATTERN` for tests.

- [ ] **Step 1: Write failing tests** — fake `SKILLS_KV` (Map-backed): list sorted/empty; view round-trip + unknown; create/duplicate/patch/missing/delete/missing; slug rejects; cap error; unsafe chars; missing binding; AGENT_TOOLS count.
- [ ] **Step 2: Run tests, confirm FAIL.**
- [ ] **Step 3: Implement** — frontmatter parse/validate helpers; three tool defs + impls using `env.SKILLS_KV`.
- [ ] **Step 4: Run tests, confirm PASS.**
- [ ] **Step 5: Run full suite.**
- [ ] **Step 6: Commit** — `feat(tools): add skills tools (list/view/manage)`.

### Task 3: Deploy + live verify + README + tag

- [ ] **Step 1:** `npx wrangler deploy`; confirm `/gateway/status` connected.
- [ ] **Step 2:** Live — `skills_list` returns `[]`; `skill_manage create` persists; `skill_view` reads it back.
- [ ] **Step 3:** README — add "Skills" section under Agent & AI pipeline; note roadmap phases.
- [ ] **Step 4:** Commit README (`docs: document skills`).
- [ ] **Step 5:** Tag `v0.6.0` and push.

## Self-Review

1. Spec coverage: binding (T1), tools (T2), deploy/README/tag (T3).
2. Each step is one checkable action.
3. Type consistency: slug/cap constants shared between defs and validation; KV keys match between list/view/manage.
4. Review Focus all mapped to T2 tests.
