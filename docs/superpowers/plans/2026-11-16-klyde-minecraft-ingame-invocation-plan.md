# Klyde In-Game Invocation (v0.9.0) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let players invoke Klyde in Minecraft chat by typing "klyde" anywhere in a message; Klyde replies in-game with color-coded, chunked messages, progress feedback, a mod-roster-aware brain, and per-player privacy/visibility controls via `/klyde`.

**Spec:** `docs/superpowers/specs/2026-11-16-klyde-minecraft-ingame-invocation-spec.md`

## Architecture summary

- Reverse channel: `POST /minecraft/bridge/invoke` (`{player,text}`) and `POST /minecraft/bridge/roster` (`{mods}`) on the worker, both forwarded to the bridge DO.
- Bridge DO: outbox queue (chat frames), roster storage, `/poll` returns query | message | empty.
- `processMinecraftInvocation` in `src/processor.js`: reuses agent loop/tools/provider chain; `deliver(phase|final)` callback pushes frames; formatting/stripping/chunking applied.
- Tools: `minecraft` gains `mods` action (returns stored roster).
- Mod: trigger detection, outbox processing + colored broadcast with per-player prefs filtering, config JSON migration, `/klyde` command tree, roster push.

## Tasks

### Task 1: Bridge DO — outbox + roster + invoke

**Files:** `src/minecraft_bridge_do.js`; `src/index.js` (routes); tests in `test/minecraft_bridge_do.test.mjs`, `test/worker.test.mjs`

**Interfaces:**
- DO state: `outbox` array; `roster` (storage-backed).
- DO routes: `/invoke` (store invocation, respond 202), `/roster` (PUT roster), `/poll` extended to pop outbox messages; `/status` extended (`outboxLength`, `rosterCount`).
- Worker routes: `POST /minecraft/bridge/invoke`, `POST /minecraft/bridge/roster` (Bearer-gated, forward).

- [ ] **Step 1: Write failing tests** — outbox push/pop ordering; poll returns message frames; roster put/get; invoke route auth and forwarding; status fields.
- [ ] **Step 2: Run tests, confirm FAIL.**
- [ ] **Step 3: Implement** — DO state/routes; worker routes.
- [ ] **Step 4: Run tests, confirm PASS.**
- [ ] **Step 5: Commit** — `feat(bridge): outbox + roster + invoke plumbing`.

### Task 2: Headless invocation in processor

**Files:** `src/processor.js` (new `processMinecraftInvocation`); tests `test/processor-mc-invocation.test.mjs`

**Interfaces:**
- `processMinecraftInvocation({ player, text, deliver, env })` — builds messages (author label, memory, profile, roster line), runs agent loop, calls `deliver({type:"phase", phase})` and `deliver({type:"reply", text})`; sentinel/refusal handling; formatting + chunking helpers (exported for tests).

- [ ] **Step 1: Write failing tests** — roster line injected; phase delivery; reply chunking (sentence boundaries, caps); sentinel fallback; refuse-safe.
- [ ] **Step 2: Run tests, confirm FAIL.**
- [ ] **Step 3: Implement** — function + helpers.
- [ ] **Step 4: Run full suite.**
- [ ] **Step 5: Commit** — `feat(processor): headless invocation for in-game queries`.

### Task 3: Mod — config JSON + prefs + commands + trigger + outbox

**Files:** `minecraft/klyde-bridge/src/main/java/dev/klyde/bridge/` (BridgeConfig, Preferences, KlydeCommands, BridgeClient, QueryHandler, KlydeBridgeMod); no Java test framework — compile + manual.

**Interfaces:**
- `BridgeConfig` JSON (Gson) with migration from `.properties`.
- `Preferences` (per-player: privacy, showProgress, showMessages) JSON store.
- `/klyde` command tree (privacy/progress/messages/help), permissionless.
- Trigger detection in `KlydeBridgeMod` chat handler (word boundary, case-insensitive, skip system), POST `/invoke`.
- Poll loop handles `message` frames: broadcast with config color to players filtered by prefs.
- Roster enumeration at startup, POST `/roster`.
- `QueryHandler` uses prefs for privacy (replacing optout properties).

- [ ] **Step 1: Implement Config/Preferences/commands/trigger/outbox/roster.**
- [ ] **Step 2: Build for 26.3, confirm jar ~26.3.**
- [ ] **Step 3: Commit** — `feat(minecraft): in-game invocation mod side`.

### Task 4: Deploy + verify + docs + tag

- [ ] **Step 1:** Deploy worker; `npm test` green.
- [ ] **Step 2:** Live — in-game trigger, progress, reply color/format, roster-aware answer, `/klyde` commands, privacy/visibility effects.
- [ ] **Step 3:** README + STATUS updates.
- [ ] **Step 4:** Commit docs; tag `v0.9.0`; push.

## Self-Review

1. Spec coverage: bridge (T1), invocation (T2), mod (T3), deploy/docs/tag (T4).
2. Each step is one checkable action.
3. Type consistency: frame shapes match between DO/tool/mod.
4. Review Focus all mapped to tests.
