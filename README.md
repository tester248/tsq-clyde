# tsq-klyde

A **Discord + Minecraft agent bot** running on Cloudflare Workers and Durable
Objects. One brain powers two fronts:

- **Discord** — a gateway bot answering `@Klyde` mentions with a tool-using
  agent loop.
- **Minecraft** — a Fabric mod lets players summon the same agent in-game via
  chat (`klyde …`), with live server awareness.

Live worker: `tsq-klyde` (`https://tsq-klyde.deezgames.workers.dev`).

---

## Table of contents

- [Features](#features)
- [Architecture](#architecture)
- [Agent pipeline](#agent-pipeline)
- [Discord integration](#discord-integration)
- [Minecraft bridge](#minecraft-bridge)
- [Configuration](#configuration)
- [Development](#development)
- [Deployment & operations](#deployment--operations)
- [Releases](#releases)

---

## Features

- **Provider fallback chain** — Mercury 3 → Groq → WUS router → Workers AI
  granite-micro, with refusal escalation to the next tier.
- **Tool-using agent loop** — web search, page fetch, bounded memory, skills,
  and session recall.
- **Bounded memory** — per-channel notes and per-user profiles with hard caps,
  injected into the prompt each turn.
- **Skills library** — progressive-disclosure `SKILL.md` documents managed by
  the agent itself.
- **Session search** — append-only FTS5 index; past messages stay findable
  even after compaction/clear.
- **Minecraft awareness** — live server status, player list, recent chat, and
  player locations via the bridge.
- **In-game invocation** — players trigger the agent from chat; replies
  broadcast in-game with per-player visibility preferences.

---

## Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │            Worker (src/index.js)            │
                    │  router  ·  bridge routes  ·  scheduled()   │
                    └──────┬──────────────────┬───────────────────┘
                           │                  │
               ┌───────────▼──────┐   ┌───────▼──────────────┐
               │   GatewayDO      │   │  MinecraftBridgeDO   │
               │  (Discord WS)    │   │ (mod poll/outbox)    │
               └───────────┬──────┘   └───────┬──────────────┘
                           │                  │
               ┌───────────▼──────┐   ┌───────▼──────────────┐
               │ ConversationDO xN │   │  ConversationDO     │
               │ (per-channel)     │   │ (key "minecraft")   │
               └───────────────────┘   └─────────────────────┘
```

| Component | File | Role |
|---|---|---|
| `Worker` | `src/index.js` | HTTP router (Discord interactions, bridge routes, probes), wake-on-fetch, `scheduled()` fallback poller |
| `GatewayDO` | `src/gateway_do.js` | Singleton Durable Object owning the outbound Discord WebSocket; dispatches mention/reply events to the per-channel pipeline |
| `MinecraftBridgeDO` | `src/minecraft_bridge_do.js` | Server side of the Fabric mod's bridge: query queue, outbox for in-game messages, roster store, invocation routing |
| `ConversationDO` | `src/conversation_do.js` | One per Discord channel (keyed `channel_id || guild_id || "global"`) plus one for Minecraft; holds history, memory, FTS5 search index |
| `processor.js` | `src/processor.js` | Ties history + memory into prompts; runs the agent loop; posts replies (`processMessage`, `processMinecraftInvocation`, `formatGameChat`) |
| `agent.js` | `src/agent.js` | Bounded, failure-tolerant tool loop (`runAgentLoop`) |
| `tools.js` | `src/tools.js` | Agent tools: `search`, `fetch_url`, `memory`, skills trio, `session_search`, `minecraft` |
| `ai.js` | `src/ai.js` | `callLLM` / `generateReply`: provider fallback chain |

---

## Agent pipeline

### Provider chain (`src/ai.js`)

Tried left-to-right; a failure *or refusal* falls through to the next tier:

1. **Mercury 3** (`mercury-3`) — `INCEPTION_API_KEY` (Inception API)
2. **Groq** (`openai/gpt-oss-120b`) — `GROQ_API_KEY`
3. **WUS router** (`uncensored/deepseek-v4.1-flash:free`) — `WUS_API_KEY`
4. **Workers AI** granite-micro (`@cf/ibm-granite/granite-4.0-h-micro`) — `AI` binding

**Uncensored answers:** when WUS answers, the reply is prefixed
`[uncensored answer]`, and the stored history entry is a neutral placeholder
(`[provided a direct answer]`) — raw uncensored text never enters the shared
conversation that Mercury/Groq later read.

### Tool loop

- The model may call tools; results feed back until it answers.
- **Bounded:** 6 iterations / 90s. Only a tool-free message counts as the
  final answer; narration alongside a tool call is never returned.
- **Fast path:** greetings/trivial pings skip the loop entirely.

### Search

`SEARCH_PROVIDER` env (default `"tavily,exa"`) sets order; first success wins.
`fetch_url` reads pages as text (64 KB cap, per-tool timeout).

### Bounded memory

- `memory` tool → `target: "memory"` = channel notes (2200-char cap),
  `target: "user"` = asker profile (1375-char cap).
- Entries are §-delimited; `add` appends (duplicates skipped), `patch` replaces
  a unique substring, `remove` deletes; over-capacity writes return a
  consolidation error; invisible/control characters are rejected.
- Both stores are injected each turn with capacity fractions
  (`MEMORY (channel notes) [n/2200 chars]`, `USER PROFILE [n/1375 chars]`).
- `/clear_context` (admins: `ADMIN_IDS`) or saying "clear context" wipes
  history + channel memory but keeps user profiles.

### Skills

Progressive disclosure over a global library in `SKILLS_KV`:

- `skills_list` — compact metadata (name/description/category)
- `skill_view` — one full `SKILL.md`, loaded only when relevant
- `skill_manage` — create/patch/delete

Slugs are lowercase kebab-case; content capped at 8000 chars; library capped at
200 skills. Probe: `GET /ai/skillprobe`.

### Session search

Every channel message is indexed into an append-only FTS5 table
(`messages_fts`) inside the channel's `ConversationDO`. `session_search`
queries it (all terms required; FTS5 metacharacters stripped) and returns
ranked excerpts (`bm25` + `snippet()`). The index **survives compaction and
`/clear`**; old specifics stay findable without occupying prompt space.
Probe: `GET /ai/searchstatus?channel=<id>`.

---

## Discord integration

- **Reply threading** — the final answer is a reply under the prompt
  (`message_reference`); long replies are chunked (≤1900 chars), first chunk
  threaded.
- **Ping default off** — `allowed_mentions.replied_user` defaults `false`;
  set `PING_AUTHOR=true` to ping the author.
- **Author attribution** — history records who said what; user messages are
  prefixed with the author's name in the prompt.
- **Status cleanup** — interim status messages (`searching…`, `reading…`,
  `composing…`) are deleted after the final answer posts (best-effort).
- **Slash `/ask`** — uses the interaction reply flow; not threaded.
- **Gateway** — singleton `GatewayDO` (id `"gateway"`), intents **513**
  (`GUILDS | GUILD_MESSAGES`), presence `online`, heartbeat per `HELLO`,
  resume across reconnects. No privileged intents; DMs out of scope.
  Liveness: wake-on-fetch plus a self-rearming 60s alarm.
  Ops: `GET /gateway/status`, `POST /gateway/connect`.
- **Polling fallback (dormant)** — `scheduled()` + `pollChannel()` exist but
  no cron trigger is attached; zero-cost manual fallback.

---

## Minecraft bridge

### Transport

The Fabric mod dials **out to Cloudflare over plain HTTPS long-poll** (host
egress proxies terminate WS upgrades). The mod polls `GET /minecraft/bridge/poll`
every ~1s; the worker returns instantly (no long-poll holds — free-tier DO
duration budget), so the mod's outbox is drained promptly.

> **Free-tier DO budget:** Durable Objects on the free plan cap daily duration
> (resets at UTC 00:00). The bridge therefore degrades gracefully while over
> budget — polls return `200 {}`, invoke returns `202` — so the mod stays quiet
> and recovers automatically. Gateway wake is skipped for bridge routes.

### Routes (Bearer `MC_BRIDGE_TOKEN`)

| Route | Purpose |
|---|---|
| `GET /minecraft/bridge/poll` | dequeue a query frame or in-game message (`{}` when idle) |
| `POST /minecraft/bridge/result` | mod replies to a tool query |
| `POST /minecraft/bridge/invoke` | mod submits a chat invocation `{player, text}` |
| `POST /minecraft/bridge/roster` | mod pushes installed-mods list |
| `POST /minecraft/bridge/clear` | op `/klyde clear` wipes the in-game conversation |
| `GET /minecraft/bridge/ping` | plain-HTTPS reachability probe |

### In-game invocation

- `klyde …` anywhere in chat triggers an invocation (word-boundary; system
  messages never invoke; banned players skipped but their chat still recorded).
- The headless brain (`processMinecraftInvocation`) reuses the Discord pipeline;
  progress + colored replies broadcast in-game via tellraw (SDL
  `relayTellRaw`).

### `/klyde` command tree (mod side)

| Command | Access | Effect |
|---|---|---|
| `/klyde` | everyone | help |
| `/klyde privacy <on\|off>` | everyone | opt out/in of sharing location + chat data |
| `/klyde progress <on\|off>` | everyone | hide/show Klyde's progress lines |
| `/klyde messages <on\|off>` | everyone | hide/show all Klyde messages |
| `/klyde ban <player>` | op | bar a player from invoking |
| `/klyde unban <player>` | op | lift a ban |
| `/klyde clear` | op | wipe the in-game conversation |

Per-player prefs live in `config/klyde-preferences.json` (share-by-default;
`privacy` / `showProgress` / `showMessages` / `banned`). Bot config in
`config/klyde-bridge.json` (URL, token, color, SDL relay flags).

### Minecraft tools

The `minecraft` agent tool exposes awareness actions: `status`, `players`,
`recent_chat`, `player_location`, plus `mods` (roster). `/mc status` and
`/mc players` slash commands show read-only info directly.
Probe: `GET /ai/mcprobe`.

---

## Configuration

`wrangler.jsonc`:

- **Bindings** — `CONVERSATION_DO`, `GATEWAY_DO`, `MINECRAFT_BRIDGE_DO`
  (SQLite-backed), `AI` binding, `LAST_MESSAGE_KV` + `SKILLS_KV` KV namespaces.
- **`vars`** (deploy-time):
  - `PING_AUTHOR` — `"false"` default; `"true"` pings the replied-to author.
  - `SEARCH_PROVIDER` — `"tavily,exa"` default.
- **Secrets** (`wrangler secret put <NAME>` — never committed):
  `DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_ID`, `GROQ_API_KEY`,
  `INCEPTION_API_KEY`, `WUS_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`,
  `ADMIN_IDS` (comma-separated Discord user IDs allowed to run `/clear_context`),
  `MC_BRIDGE_TOKEN` (shared with the Minecraft mod).

> **Note:** conversation state persists via the KV storage API and is **not**
> visible in Data Studio; use the DO's endpoints or a debug route to inspect.

---

## Development

```sh
npm install
npm test          # unit suite (node --test test/, no network)
npm run dev       # wrangler dev (local)
npm run dry-run   # wrangler deploy --dry-run
npm run deploy    # wrangler deploy
```

**Mod build** (Minecraft leg) — at `minecraft/klyde-bridge/`:

```sh
$env:JAVA_HOME = "C:\Users\Ashwin\Documents\Programs\jdk-25.0.4"
& "C:\Users\Ashwin\Documents\Projects\gradle-9.8.0\bin\gradle.bat" build
# jar: minecraft/klyde-bridge/build/libs/klyde-bridge-0.1.0.jar
```

---

## Deployment & operations

1. **Worker** — `npx wrangler deploy`; set secrets first.
2. **Minecraft mod** — build the jar, copy to the server's `mods/`, restart.
   The mod self-connects via the configured bridge URL.
3. **Probes:**
   - `GET /ai/selfcheck`, `/ai/agentcheck`
   - `GET /ai/skillprobe`, `/ai/searchstatus?channel=<id>`
   - `GET /ai/mcprobe`, `/minecraft/bridge/ping`
   - `GET /gateway/status` (then `POST /gateway/connect` once after the first
     deploy carrying the GatewayDO migration)

---

## Releases

- `v0.2.0` — Mercury 3 primary; provider fallback chain.
- `v0.3.0` — agent tool loop (`search` + `fetch_url`).
- `v0.3.1` — multi-provider search (Tavily + Exa).
- `v0.3.2` — agent UX batch: progressive status phases, per-tool timeout,
  chunked replies, truncation-narration fix.
- `v0.4.0` — reply attribution: threading, `PING_AUTHOR`, author attribution,
  status cleanup.
- `v0.5.0` — bounded memory: `memory` tool with 2200/1375 caps, per-channel
  notes + per-user profiles, prompt injection.
- `v0.5.1` — clear-context feedback: `/clear_context` confirms in-channel.
- `v0.6.0` — skills: `skills_list`/`skill_view`/`skill_manage` +
  `/ai/skillprobe`.
- `v0.7.0` — session search: FTS5 index + `session_search` + `/ai/searchstatus`.
- `v0.8.0` — Minecraft leg (worker side): `MinecraftBridgeDO`, `minecraft`
  awareness tool, read-only `/mc status|players`, `/ai/mcprobe`.
- `v0.8.1` — Minecraft leg live: long-poll transport over plain HTTPS,
  `/poll` + `/result`, mod poll client, `pollConnected` probe. Live-verified:
  `/mc status` returns real server data.
- `v0.9.0` — in-game invocation: `klyde` chat trigger, headless invocation,
  tellraw broadcast, roster awareness, `/klyde`
  privacy/progress/messages commands, JSON config + per-player prefs.
- `v0.9.1` — free-tier DO budget fix: instant polls, gateway wake skipped on
  bridge routes, graceful degradation (`200 {}`/`202`) while the DO is over
  budget; `/klyde ban/unban` (ops).
