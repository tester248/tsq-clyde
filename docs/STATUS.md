# Klyde — Project Status & Resume Guide

> Purpose: if chat context is lost, this file restores orientation. Read this
> first. Keep it updated at every milestone; commit it with releases.

## What Klyde is

A Discord + Minecraft agent bot on Cloudflare Workers + Durable Objects.
Worker: `tsq-klyde`. Repo: `tester248/tsq-clyde`, branch `main`.

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

**Progress:**

- [x] Spec + plan revised to WS-aware slice (commits `…`).
- [x] `MinecraftBridgeDO` + WS accept route + tests.
- [x] `minecraft` tool reworked to route through the bridge (awareness actions).
- [x] `/mc` slash commands reworked to route through the bridge.
- [ ] Deploy + `MC_BRIDGE_TOKEN` secret + `/ai/mcprobe` + README + tag `v0.8.0`.
- [ ] Live hookup: Fabric mod (future slice) — see spec §"Mod slice".

## How to verify / known gaps

- `npm test` green (~190 tests). npm test list includes `test/skills.test.mjs` and `test/discord-mc.test.mjs`.
- Live FTS5 query (`bm25`/`snippet()`) still not exercised against real SQLite — first real `session_search` in Discord is the check (see v0.7.0 spec §8).

## Secrets (wrangler secret put, never in repo)

`DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_ID`, `INCEPTION_API_KEY`,
`GROQ_API_KEY`, `WUS_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`,
`ADMIN_IDS` (809430270897160202), `MC_BRIDGE_TOKEN`.

## Deploy

`npx wrangler deploy`; status: `GET /gateway/status`; probes:
`/ai/selfcheck`, `/ai/agentcheck`, `/ai/skillprobe`, `/ai/searchstatus?channel=`,
`/ai/mcprobe`.
