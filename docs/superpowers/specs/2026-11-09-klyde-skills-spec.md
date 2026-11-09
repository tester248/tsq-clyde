# Klyde Skills (Phase 2) — Design Spec

> **Status:** Design spec for review. No code until approved.
> **Source inspiration:** Nous Research's Hermes Agent (MIT) — its progressive-
> disclosure skills system (list → view → manage) and SKILL.md format. We port
> the *ideas*, not the Python.

## 1. Intent

Give Klyde a **skill system**: a library of durable, agent-managed "how-to"
documents (SKILL.md) the model can consult on demand and grow over time. This
is Phase 2 of the Hermes-inspired roadmap (memory → skills → session search).

Three agent tools, mirroring Hermes's levels of disclosure:

| Tool | Hermes equivalent | Cost |
|---|---|---|
| `skills_list` | Level 0 `skills_list()` | small (~1-3k tokens) |
| `skill_view` | Level 1 `skill_view()` | one full skill, on demand |
| `skill_manage` | `skill_manage` (create/patch/delete) | writes only |

The key trait is **progressive disclosure**: the model sees only names +
descriptions at first; full bodies load only when a skill is actually relevant.
Skills live in a dedicated KV namespace, shared across all channels (a skill is
a *global* capability, unlike per-channel memory).

## 2. Why

- Klyde repeatedly re-derives procedures (deploy checklist, how to build a
  tool, conventions) inside the same conversation and across channels. Skills
  make them durable and reusable.
- Phase 1 proved the pattern: bounded, agent-managed stores + tools + prompt
  hygiene. Skills are the natural next Hermes port — and they *compose* with
  memory (e.g. a skill may be created to codify a repeated channel workflow).
- Hermes's insight: don't stuff a knowledge base into the prompt — expose it
  behind tools with cheap discovery and pay-as-you-go reads. That fits
  Workers' context pressure exactly like bounded memory did.

## 3. Goals / Non-goals

**Goals**
- `skills_list` → `[{name, description, category}]` (sorted, capped).
- `skill_view` → full SKILL.md content for one skill.
- `skill_manage` with `create` / `patch` / `delete` actions.
- Skills stored in a dedicated KV namespace (`SKILLS_KV`), global across
  channels.
- SKILL.md format with minimal frontmatter (`name`, `description`, `category`)
  plus a markdown body; hand-rolled parsing (no YAML dependency).
- Validation: slug format, content size cap, unsafe-characters rejection
  (same pattern as memory).
- All tools return plain values / `{ error }` — never throw.

**Non-goals**
- No prompt injection of skill bodies (that's the point of progressive
  disclosure — tools expose them).
- No per-channel or per-user skill scoping (skills are global).
- No skill search (FTS) — that's Phase 3.
- No automatic "learn from experience" background review — Phase 4.
- No terminal backends / local execution (serverless).

## 4. Architecture

### 4.1 Storage — `SKILLS_KV` (KV namespace)

- Key: skill **slug**, e.g. `deployment-checklist`.
- Value: SKILL.md document:

  ```markdown
  ---
  name: deployment-checklist
  description: Steps to verify a release before tagging
  category: engineering
  ---

  # Deployment checklist

  ## Procedure
  1. Run `npm test`.
  2. `npx wrangler deploy`.
  3. Confirm `/gateway/status` shows connected.

  ## Pitfalls
  - The worker name is spelled `tsq-klyde`.
  ```

- Listing: `env.SKILLS_KV.list({ prefix: "" })` → keys (slugs), then read
  each value and parse frontmatter for `{name, description, category}`.
  `_index` is intentionally **not** maintained — the files are the single
  source of truth; N reads for small N (< 100) is fine.
- Cap: max **200 skill files**; per-skill content cap **8000 chars**.
- Slug: `^[a-z0-9]+(-[a-z0-9]+)*$`, max 64 chars.

### 4.2 Files

| Change | File | Detail |
|---|---|---|
| KV binding | `wrangler.jsonc` | add `SKILLS_KV` (id `517b7b54995a4b5091d8266fa15aa8a4`) |
| Skills tools | `src/tools.js` | defs (3) + impls + frontmatter parse/validate |
| Tests | `test/skills.test.mjs` | new suite (fake `SKILLS_KV` via Map) |
| README | `README.md` | Skills section + release entry |

No changes to `processor.js`, `agent.js`, or the DO — tools flow through the
existing `executeTool(name, args, env)` path.

### 4.3 Tool definitions

```jsonc
{ "name": "skills_list", "parameters": { "properties": {} } }

{ "name": "skill_view", "parameters": {
    "name": { "type": "string", "description": "Skill slug" }
} }

{ "name": "skill_manage", "parameters": {
    "action": { "type": "string", "enum": ["create", "patch", "delete"] },
    "name":   { "type": "string", "description": "Skill slug" },
    "content":{ "type": "string", "description": "Full SKILL.md (create/patch)" }
} }
```

Descriptions teach the pattern: *"list first to discover; view a skill only
when relevant; create to record a reusable procedure."*

### 4.4 Semantics

- `skills_list` — returns `{ skills: [{name, description, category}] }`,
  sorted by name. Empty store → `{ skills: [] }`.
- `skill_view` — returns `{ name, content }` (raw stored file). Unknown slug →
  `{ error }`.
- `skill_manage create` — errors if slug exists; validates slug + content;
  writes file.
- `skill_manage patch` — errors if slug missing; replaces content.
- `skill_manage delete` — deletes file (missing → `{ success: true }`? No —
  error: "no such skill").
- Cap errors name the cap and current size (consistent with memory tool).
- Unsafe content (control / invisible unicode) rejected on create/patch.

## 5. Review Focus (failure modes tests must pin)

1. `skills_list` returns parsed frontmatter for all stored skills; empty list
   when store is empty; sorted.
2. `skill_view` returns raw content; unknown slug → error.
3. `create` writes; duplicate create → error; `patch` replaces; missing patch →
   error; `delete` removes; missing delete → error.
4. Slug validation rejects bad slugs (`Bad Slug`, `underscore_slug`, empty,
   >64 chars).
5. Content cap (8000) → error naming cap + current size.
6. Unsafe characters rejected on create/patch.
7. All tools never throw — return `{ error }` on missing `SKILLS_KV` binding
   and on storage failures.
8. `AGENT_TOOLS` now declares 5 tools (`search`, `fetch_url`, `memory`,
   `skills_list`, `skill_view`, `skill_manage`).

## 6. Open items (locked)

- Skills are global (shared across all channels). Per-channel skill
  scoping could come later if needed.
- No write-approval gate; the agent writes freely (Hermes default).
- `skills_list` reads all values to build the catalog; acceptable while N is
  small. Phase 3's FTS could revisit this.

## 7. Definition of done

- Tests green (new skills suite + updated tools suite).
- Live: `skills_list` returns an empty store; creating a skill via the agent
  (or test) persists and `skill_view` reads it back.
- README updated; conventional commits; tagged at slice end (`v0.6.0`).
