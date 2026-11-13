# Klyde Minecraft Leg (Worker Side) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `minecraft` agent tool that talks to the Fabric mod's HTTP RPC (`status` / `players` / `command`), with mutating commands gated behind `ADMIN_IDS`, plus read-only `/mc status` and `/mc players` slash commands.

**Architecture:** Tool def + impl in `src/tools.js` (reuses `CONVERSATION_STUB`/`CURRENT_USER_ID` plumbing); command registration + interaction handler in `src/index.js`/`src/discord.js`. New secrets: `MC_BRIDGE_URL`, `MC_BRIDGE_TOKEN`. No new DOs/KV/migrations.

**Spec:** `docs/superpowers/specs/2026-11-09-klyde-minecraft-leg-spec.md`

## Locked decisions (from spec §6, recommended defaults)

- Mod repo location: sibling folder `minecraft/klyde-bridge/` (future slice).
- Deny-list in mod: conservative (`op`, `deop`, `stop`, `ban`, `pardon`, server-wide) — mod-side, future slice.
- Discord UI: **agent tool + read-only slash commands** (`/mc status`, `/mc players`).
- Reachability: cloudflared tunnel when opened (later).

## Global Constraints

- Tool actions: `status`, `players` (GET, read-only, any member) and `command` (POST, admin-only via `ADMIN_IDS`).
- `Authorization: Bearer <MC_BRIDGE_TOKEN>` header on every RPC call.
- Non-2xx / network / missing-config → `{ error }` (never throws).
- Tool is part of the agent loop; no `processor.js` changes.
- `AGENT_TOOLS` grows to 8.

## Review Focus

- status/players map response + send bearer header.
- command refused for non-admin (no fetch); allowed for admin (POST).
- 401/500/network → `{ error }` with status.
- Missing secrets → clean `{ error }`.
- Slash commands registered (COMMANDS) and handled as read-only.

---

### Task 1: minecraft tool

**Files:** Modify `src/tools.js`; Test `test/tools.test.mjs`

**Interfaces:**
- Produces: `minecraft` entry in `AGENT_TOOLS`/`TOOL_IMPLS`; uses `env.MC_BRIDGE_URL`, `env.MC_BRIDGE_TOKEN`, `env.ADMIN_IDS`, `env.CURRENT_USER_ID`.

- [ ] **Step 1: Write failing tests** — mock fetch + admin env: status GET with header; players GET; command POST as admin; command refused as non-admin (no fetch); 401 → error; 500 → error; network throw → error; missing URL/token → error; declaration count 8.
- [ ] **Step 2: Run tests, confirm FAIL.**
- [ ] **Step 3: Implement** — def + impl (bearer header, gate, error mapping).
- [ ] **Step 4: Run tests, confirm PASS.**
- [ ] **Step 5: Commit** — `feat(tools): add minecraft RPC tool`.

### Task 2: read-only slash commands

**Files:** Modify `src/index.js` (COMMANDS), `src/discord.js` (interaction handler); Test `test/worker.test.mjs` + `test/discord-reply.test.mjs`

**Interfaces:**
- Produces: `/mc status` + `/mc players` in COMMANDS; `mc` subcommand routing in `handleDiscordInteraction` that runs the tool's read-only actions and followups the result.

- [ ] **Step 1: Write failing tests** — registration PUT includes `mc` with options; interaction "mc status" → followup with players/status output; non-2xx from the mod → friendly error followup.
- [ ] **Step 2: Run tests, confirm FAIL.**
- [ ] **Step 3: Implement** — command defs + handler wiring.
- [ ] **Step 4: Run full suite.**
- [ ] **Step 5: Commit** — `feat(discord): add read-only /mc slash commands`.

### Task 3: Deploy + README + tag

- [ ] **Step 1:** `npx wrangler deploy`; confirm `/gateway/status` connected.
- [ ] **Step 2:** Set secrets `MC_BRIDGE_URL`, `MC_BRIDGE_TOKEN` (placeholder values now; real ones when reachable).
- [ ] **Step 3:** README — "Minecraft leg" section (tool, gating, secrets, roadmap incl. mod slice).
- [ ] **Step 4:** Commit README (`docs: document minecraft leg`).
- [ ] **Step 5:** Tag `v0.8.0` and push. Note: live RPC verification deferred until server reachable (spec §7).

## Self-Review

1. Spec coverage: tool (T1), slash commands (T2), deploy/README/tag (T3).
2. Each step is one checkable action.
3. Type consistency: env names match spec; gate logic mirrors clear-context.
4. Review Focus all mapped to T1/T2 tests.
