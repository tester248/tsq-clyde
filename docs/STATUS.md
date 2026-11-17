# Klyde — Project Status & Resume Guide

> Purpose: if chat context is lost, this file restores orientation. Read this
> first. Keep it updated at every milestone; commit it with releases.

## What Klyde is

A Discord + Minecraft agent bot on Cloudflare Workers + Durable Objects.
Worker: `tsq-klyde`. Repo: `tester248/tsq-klyde`, branch `main`.

Architecture: a "thin client, fat brain" agent. Cloudflare is the brain
(agent loop, memory, skills, session search, web access). Each leg is a thin
client: the Discord gateway (live) and a Fabric mod (planned, outbound
WebSocket — see Minecraft leg).

## Milestones (tags)

- `v0.2.0` — Mercury 3 primary + provider fallback chain.
- `v0.3.x` — agent tool loop (search/fetch_url), multi-provider search, UX batch.
- `v0.4.0` — reply attribution: threading, PING_AUTHOR, author labels, status cleanup.
- `v0.5.x` — bounded memory (Hermes-inspired): memory tool, channel/user stores, prompt injection. `v0.5.1` fixed clear-context feedback.
- `v0.6.0` — skills: skills_list/skill_view/skill_manage (progressive disclosure) in `SKILLS_KV`.
- `v0.7.0` — session search: FTS5 index in ConversationDO + session_search tool + /ai/searchstatus.
- `v0.8.0` — Minecraft leg (in progress): outbound-WS bridge + awareness tool + read-only /mc commands.

## Current work: Minecraft leg (v0.8.0)

**Decisions (locked 2026-11-14):**
- Transport: outbound WebSocket — mod dials OUT to a Worker-owned `MinecraftBridgeDO` (sibling of `GatewayDO`). No inbound ports; works behind NAT.
- First slice = awareness: tool actions `status`, `players`, `recent_chat`, `player_location`. All read-only.
- `/mc status` + `/mc players` read-only slash commands.
- Admin-gated `command` execution: deferred to a later slice.
- Privacy: per-player opt-out is spec'd now (mod-side filtering before data leaves server; flags synced to KV; optional in-game announcement).

**Progress (v0.8.0):**

- [x] Spec + plan revised to WS-aware slice (`ab7b1da`).
- [x] `MinecraftBridgeDO` + WS accept route (`ccd2594`) — authenticated hello, heartbeat, query/response round-trip with timeout.
- [x] `minecraft` tool reworked to route through the bridge — awareness actions (`2e0cdad`).
- [x] `/mc` slash commands test rework through the bridge (`301a8f0`).
- [x] Deployed (`8b5ca6f1`); `MC_BRIDGE_TOKEN` secret set; `/ai/mcprobe` returns configured=true/connected=false (waiting for the mod).
- [x] Fabric mod scaffold (`4e44d80`): `minecraft/klyde-bridge/` — outbound WS client, hello auth, query handling (status/players/recent_chat/player_location), opt-out filtering, announce; build matrix 26.3/26.2 (loom 1.19-SNAPSHOT, loader 0.20.1).
- [x] **Mod builds verified (`7364352`)**: 26.3 (fabric-api 0.166.2+26.3) and 26.2 (0.161.0+26.2) with Gradle 9.8.0 + JDK 25. 26.x = unobfuscated era → no mappings, `net.fabricmc.fabric-loom` plugin, Java 25. Artifact: `klyde-bridge-0.1.0.jar`.
- [x] `/mc` slash-command handler committed (`afcbda0`) — was riding uncommitted from the earlier slice.
- [x] **Live hookup DONE (2026-11-16)**: host proxy kills WebSocket upgrades → switched to **long-poll transport** over plain HTTPS (`5cc33a1`). Mod connects via poll loop; `/ai/mcprobe` shows `pollConnected:true`; `/mc status` returns live data (`🟢 26.3 — TPS 20 …`). `/mc` slash commands registered globally (POST /discord/register-commands).
- [x] **In-game invocation slice (`v0.9.0`) built**: reverse channel (invoke/roster/outbox) + headless brain (`processMinecraftInvocation`) + mod side (JSON config, per-player prefs, `/klyde` command tree, trigger detection, colored broadcast). Worker deployed `55d20e33`; live smoke verified 202 + phase/reply frames through the real agent loop. Mod jar built for 26.3 — deploy to server to enable.
- [x] `/klyde ban/unban` (ops) blocks invocation (`7b7d385`); banned players' chat still recorded for awareness; prefs gains `banned` flag.
- [x] **Free-tier DO budget incident + fix (v0.9.1)**: long-poll `/poll` holds (up to 15s each, ~1/s) exhausted the free-tier Durable Object **daily duration budget** → 500s + `1101` on every poll. Fixed: instant poll (no waiter/setTimeout in DO), mod polls 1s with no timeout param, gateway wake skipped on bridge routes, and bridge routes degrade gracefully to `200 {}`/`202` while the DO is over budget (resets at UTC 00:00) so the mod never spams. Worker deployed (version `140369f1`); jar rebuilt `~26.3` — deploy to server.
- [ ] In-game live verification (after deploying the new jar): trigger, progress, reply format/color, roster-aware answers, `/klyde` commands + privacy/visibility effects + ban/unban enforcement.

**Next (future slices):** Fabric mod (`klyde-bridge`, outbound WS — scaffold in `minecraft/klyde-bridge/`), admin command execution (ADMIN_IDS-gated), in-game invocation + "working on it" feedback. Chat bridge is intentionally OUT of scope — the server already uses the "Simple Discord Link" mod.

## How to verify / known gaps

- `npm test` green (230 tests). npm test list includes `test/skills.test.mjs` and `test/discord-mc.test.mjs`.
- Live FTS5 query (`bm25`/`snippet()`) still not exercised against real SQLite — first real `session_search` in Discord is the check (see v0.7.0 spec §8).

## Secrets (wrangler secret put, never in repo)

`DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_ID`, `INCEPTION_API_KEY`,
`GROQ_API_KEY`, `WUS_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`,
`ADMIN_IDS` (809430270897160202), `MC_BRIDGE_TOKEN`.

## Deploy

`npx wrangler deploy`; status: `GET /gateway/status`; probes:
`/ai/selfcheck`, `/ai/agentcheck`, `/ai/skillprobe`, `/ai/searchstatus?channel=`,
`/ai/mcprobe`.
