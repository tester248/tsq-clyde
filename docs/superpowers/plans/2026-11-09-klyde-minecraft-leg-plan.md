# Klyde Minecraft Leg (Revised: Outbound-WS Awareness Slice) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Minecraft leg around an outbound-WebSocket bridge: a `MinecraftBridgeDO` holding the mod's session, a `minecraft` agent tool (awareness actions) routing through it, and read-only `/mc` slash commands. No admin commands in this slice.

**Architecture:** New `MinecraftBridgeDO` Durable Object (+ wrangler binding + migration); WS-accept route in `index.js`; `minecraft` tool in `src/tools.js` routes via the bridge stub; `/mc` handler in `src/discord.js`.

**Spec:** `docs/superpowers/specs/2026-11-09-klyde-minecraft-leg-spec.md` (revised)

## Global Constraints

- Outbound WS from the mod; auth via `MC_BRIDGE_TOKEN` hello frame.
- Tool actions: `status`, `players`, `recent_chat`, `player_location` — read-only, routed through the bridge DO.
- Query timeout (10s) → `{ error }`; bridge disconnected → `{ error }`.
- No command execution path in this slice.
- `AGENT_TOOLS` = 8 tools.
- New binding `MINECRAFT_BRIDGE_DO` (class `MinecraftBridgeDO`), migration `v9`.

## Review Focus

- Bridge accepts + authenticates hello; rejects bad token.
- Query/response round-trip; timeout.
- Tool: action mapping, bridge error/disconnected → `{ error }`, missing config → error, unknown action → error.
- Slash commands route through tool; friendly error on mod failure.
- Worker tests include `test/discord-mc.test.mjs`.

---

### Task 1: MinecraftBridgeDO + WS accept route

**Files:** New `src/minecraft_bridge_do.js`; modify `wrangler.jsonc` (binding + migration `v9`), `src/index.js` (route); Test new `test/minecraft_bridge_do.test.mjs`

**Interfaces:**
- Produces: `MinecraftBridgeDO` class (fetch `/status`, `/query`, `/connect`); WS-accept route `POST /minecraft/bridge/connect` (token-gated).

- [ ] **Step 1: Write failing tests** — fake socket (deps): connect+hello ok; bad token rejected; query round-trip; query timeout; status reports connected/disconnected.
- [ ] **Step 2: Run tests, confirm FAIL.**
- [ ] **Step 3: Implement** — DO class (socket accept, heartbeat, query router); index.js route; wrangler binding/migration.
- [ ] **Step 4: Run tests, confirm PASS.**
- [ ] **Step 5: Commit** — `feat(bridge): MinecraftBridgeDO + WS accept`.

### Task 2: minecraft tool (awareness) via bridge

**Files:** Modify `src/tools.js`; Test `test/tools.test.mjs` (rework minecraft block)

**Interfaces:**
- Produces: `minecraft` tool def (4 actions, no command) + impl routing via `env.MINECRAFT_BRIDGE_DO.get(idFromName("minecraft"))` `/query`.

- [ ] **Step 1: Write failing tests** — fake bridge stub: status/players/recent_chat/player_location mapping; bridge error → `{ error }`; disconnected → `{ error }`; missing token/bridge → error; unknown action → error; declaration count 8.
- [ ] **Step 2: Run tests, confirm FAIL.**
- [ ] **Step 3: Implement** — def + impl.
- [ ] **Step 4: Run tests, confirm PASS.**
- [ ] **Step 5: Commit** — `feat(tools): minecraft awareness tool via bridge`.

### Task 3: /mc slash commands via bridge

**Files:** Modify `src/discord.js`; Test `test/discord-mc.test.mjs` (rework mock)

**Interfaces:**
- Produces: `/mc status|players` follows the tool through the bridge; friendly error on failure.

- [ ] **Step 1: Write failing tests** — fake bridge env: status/players followup; mod failure → friendly error.
- [ ] **Step 2: Run tests, confirm FAIL.**
- [ ] **Step 3: Implement** — handler wiring to bridge-based tool.
- [ ] **Step 4: Run full suite.**
- [ ] **Step 5: Commit** — `feat(discord): /mc commands via bridge`.

### Task 4: Deploy + probe + README + STATUS + tag

- [ ] **Step 1:** `npx wrangler deploy`; confirm `/gateway/status` connected; set `MC_BRIDGE_TOKEN` secret.
- [ ] **Step 2:** Add `/ai/mcprobe` (bridge configured + connected state) — boolean only.
- [ ] **Step 3:** README Minecraft leg section; STATUS.md progress checkboxes.
- [ ] **Step 4:** Commit (`docs: document minecraft leg v0.8.0`).
- [ ] **Step 5:** Tag `v0.8.0` and push.

## Self-Review

1. Spec coverage: bridge (T1), tool (T2), slash (T3), deploy/docs/tag (T4).
2. Each step is one checkable action.
3. Type consistency: env/binding names match spec; stub keys match tool/bridge.
4. Review Focus all mapped to T1–T3 tests.
