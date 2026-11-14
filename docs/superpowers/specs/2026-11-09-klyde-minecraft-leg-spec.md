# Klyde Minecraft Leg — Design Spec

> **Status:** REVISED 2026-11-14 (decisions locked with user). Supersedes the
> original HTTP-based design below for transport and slice scope. The original
> text is retained as "Prior design (superseded)" for history.

> **Prior art:** Consolidates planning already recorded in this repo:
> - `2026-11-05-klyde-agent-slice1-web-spec.md` — "the Minecraft mod's RPC
>   becomes another 'tool' alongside web search" (the loop is deliberately
>   platform-agnostic); "No per-player privacy/opt-out logic yet
>   (Minecraft-specific; planned)".
> - `2026-11-08-klyde-wus-escalation-spec.md` — "the Minecraft path (future)".
> - README intro: "Discord + Minecraft agent bot on Cloudflare Workers."

## 0. Revision summary (2026-11-14) — locked decisions

| Topic | Locked decision |
|---|---|
| Transport | **Outbound WebSocket** — the Fabric mod dials OUT to a Worker-owned `MinecraftBridgeDO` (sibling of `GatewayDO`). Works behind NAT on free hosting; no inbound ports; enables server-pushed events later. |
| First slice | **Awareness slice** — tool actions `status`, `players`, `recent_chat`, `player_location`. All read-only. |
| Slash commands | Keep `/mc status`, `/mc players` (read-only) alongside the agent tool. |
| Admin commands | Deferred — no `command` action in this slice. |
| Privacy | Per-player opt-out is in-scope for the spec (mod-side filtering; optional announcement). |
| Tool gating | Read-only now; admin-gated commands come later. |

## 1. Intent

Give Klyde visibility and control over the user's **Fabric** server (game
versions **26.2 / 26.3**) through a **server-side mod** that exposes a small
RPC surface. The mod is a thin, passive sensor: it holds an outbound
WebSocket to Cloudflare, answers targeted queries on demand, and never
streams bulk state. The Worker is the brain; "the mod's RPC becomes another
tool" exactly as the slice-1 spec reserved.

## 2. Environment & constraints (facts)

- Server: **Fabric** (mod loader), game **26.2 and 26.3**.
- Server runs on **free hosting with limited resources** — the mod must stay
  lightweight (compute + storage), and the server is **behind NAT** (no
  inbound connections). Hence outbound-WS transport.
- Server is **not publicly reachable yet**; live hookup is a follow-up
  verification step. All Worker-side code is built and unit-tested against a
  mock bridge first.

## 3. Goals / Non-goals

**Goals**
- A lightweight Fabric mod (`klyde-bridge`) exposing read-only, on-demand RPC.
- A `MinecraftBridgeDO` Durable Object that owns the outbound WebSocket
  session (accepts the mod's connection, heartbeats, serializes
  query/response, reconnects).
- A `minecraft` agent tool (actions: `status`, `players`, `recent_chat`,
  `player_location`) that routes through the bridge DO — reusing the
  existing tool loop, env plumbing, and error conventions.
- Read-only `/mc status` and `/mc players` slash commands.
- Auth between mod and Worker via a shared bearer token (`MC_BRIDGE_TOKEN`).
- Per-player privacy opt-out: mod-side flag filters personal data before it
  leaves the server; flags synced to KV; optional in-game announcement.
- Tool failures degrade gracefully (plain `{ error }`, loop feeds back to the
  model, never crashes the reply).

**Non-goals (this slice)**
- No in-game autonomous entity / bot player.
- No admin `command` execution yet (deferred slice).
- No chat bridge (Discord ⇄ in-game) yet (separate slice; WS transport makes
  it feasible later).
- No RCON-based design.
- No UUIDs/IPs in tool output (minimal surface until privacy work lands — but
  opt-out is spec'd now).

## 4. Architecture

### 4.1 Transport — outbound WebSocket

```
Fabric mod (klyde-bridge)          MinecraftBridgeDO (Worker)
   │  dials OUT over WebSocket          │  accepts connection
   │  (auth: Bearer token)              │  heartbeats
   │  answers queries on demand          │  serializes query/response
   └─────────────────────────────────────┘  per server
```

- The mod is **stateless and passive**: it connects out (no inbound ports),
  listens for query frames, and responds. No polling, no bulk streaming.
- `MinecraftBridgeDO` (id `"minecraft"`) mirrors the `GatewayDO` muscle:
  holds the live socket, heartbeat watchdog, and a request/response router.
- Server-pushed events (chat, join/leave) are a natural extension later; the
  protocol reserves an `event` frame type.

### 4.2 Protocol (JSON frames over the WS)

| Direction | Frame | Purpose |
|---|---|---|
| mod → Worker | `{"type":"hello","token":"…"}` | first frame; auth |
| Worker → mod | `{"type":"hello","ok":true}` | accepted (else close) |
| Worker → mod | `{"type":"query","id":1,"action":"status"}` | request |
| mod → Worker | `{"type":"result","id":1,"ok":true,"data":{…}}` | success |
| mod → Worker | `{"type":"result","id":1,"ok":false,"error":"…"}` | failure |
| Worker → mod | `{"type":"ping"}` | heartbeat (30s) |
| mod → Worker | `{"type":"pong"}` | heartbeat reply |
| mod → Worker | `{"type":"event","event":"chat","data":{…}}` | (reserved, later) |

- Queries are bounded (per-action cap) and **targeted** — the mod answers
  only what's asked.
- Each query has a timeout (default 10s); timeout → `{ error }` to the tool.

### 4.3 The mod's RPC surface (awareness slice)

| Action | Returns | Cap |
|---|---|---|
| `status` | `{version, tps, uptime, playersNow, playersMax}` | — |
| `players` | `{players:["Alice",…]}` | names only, ≤100 |
| `recent_chat` | `{messages:[{player, text, ts}]}` | last 20 |
| `player_location` | `{player, x, y, z, dimension}` | one player |

- Implemented with Fabric API event hooks (cheap, on-demand reads).
- Player data is filtered by the opt-out flag **before** response (see §4.5).

### 4.4 Worker side — `minecraft` tool

```jsonc
{ "name": "minecraft", "parameters": {
    "action": { "type": "string", "enum": ["status","players","recent_chat","player_location"] },
    "player": { "type": "string", "description": "player name (player_location only)" }
} }
```

- Env: `MC_BRIDGE_TOKEN` (secret). The bridge DO binding is
  `MINECRAFT_BRIDGE_DO`.
- The tool routes through `env.MINECRAFT_BRIDGE_DO.get(idFromName("minecraft"))`
  → `stub.fetch("https://bridge/query", …)`.
- Reads: no admin gate needed (read-only slice).
- Errors: bridge disconnected / query timeout / non-ok result → `{ error }`,
  same shape as other tools.
- `/mc status` and `/mc players` slash commands call the tool and followup.

### 4.5 Privacy opt-out (spec'd, implemented with the mod slice)

- Per-player flag in the mod's config (`klyde-bridge.properties`):
  `optout.<playername>=true`.
- The mod filters personal data (location, recent chat) before it leaves the
  server; opt-out players appear in `/players` as `[redacted]` or are
  omitted (config choice).
- Flags are synced to KV by the mod or via a config-side sync endpoint.
- Optional announcement to players (config bool) when Klyde is active.

## 5. Review Focus (failure modes tests must pin)

1. `MinecraftBridgeDO` accepts a connection, authenticates the hello token,
   and rejects bad tokens.
2. Query→response round-trip over a fake socket; timeout yields `{ error }`.
3. Tool: each action maps the data correctly; bridge disconnected → error;
   bridge error → error; missing token/bridge → error; unknown action → error.
4. Slash commands route through the tool and followup; mod failure → friendly
   error.
5. `AGENT_TOOLS` has 8 tools (minecraft included).
6. Read-only: no command execution path exists in this slice.

## 6. Open items (future slices)

- Admin command execution (`command` action + `ADMIN_IDS` gate).
- In-game invocation (`@Klyde` in chat) and "working on it" in-game feedback.
- ~~Chat bridge~~ — **not Klyde's scope**: the server already runs the
  "Simple Discord Link" mod for Discord ⇄ in-game chat. Klyde therefore does
  NOT implement chat bridging; the reserved `event` frame type is not needed
  for chat.
- Mod slice: Fabric mod implementation, deployment, reachability (outbound
  WS needs the host to allow outbound connections — generally allowed).

### Mod slice build matrix (locked 2026-11-14)

Two supported game versions, one codebase (build per version by swapping
`gradle.properties` values or `-P` flags):

| Minecraft | Loader | Loom | Fabric API |
|---|---|---|---|
| **26.3** | 0.20.1 | 1.19-SNAPSHOT | `0.166.2+26.3` |
| **26.2** | 0.20.1 | 1.19-SNAPSHOT | `0.161.0+26.2` |

Toolchain: JDK 21+ required (Minecraft 26.x; the repo machine currently has
JDK 17 — upgrade before building). Gradle wrapper 8.x (loom 1.19-SNAPSHOT).

## 7. Definition of done

- Tests green (bridge DO + tool + slash commands).
- Live (Worker side): `/ai/mcprobe` reports bridge configured; slash commands
  respond with friendly errors until a mod connects.
- README section + release tag (`v0.8.0`).

---

## Prior design (superseded 2026-11-14)

The original spec (HTTP-based, inbound reachability, `command` action) is
archived in git history. Key deltas: transport (inbound HTTP → outbound WS),
slice (status/players/command → awareness), and privacy (absent → spec'd).


## 1. Intent

Give Klyde visibility and control over the user's **Fabric** server (game
versions **26.2 / 26.3**) through a **server-side mod** that exposes a small
HTTP RPC. The Worker calls that RPC from the existing agent loop — the mod is
just another *tool*, exactly as the slice-1 spec reserved.

## 2. Environment & constraints (facts)

- Server: **Fabric** (mod loader), game **26.2 and 26.3**.
- The server is **not publicly reachable yet** ("will open later"). Until it
  is, the RPC tool is built and fully unit-tested against a mock RPC; the
  live hookup is a follow-up verification step, not a blocker.
- Trasport: the mod hosts an HTTP endpoint (one port). Reachability is the
  operator's job: port-forward, or a tunnel (e.g. `cloudflared`), later.
- The Worker cannot initiate connections to the server until reachability
  exists — so live verification is deferred; code is not.

## 3. Goals / Non-goals

**Goals**
- A Fabric mod (`klyde-bridge`) exposing read-only + command RPC endpoints.
- A `minecraft` agent tool (actions: `status`, `players`, `command`) that
  calls the mod's RPC, reusing the existing tool loop, env plumbing, and
  error conventions.
- Auth between Worker and mod via a shared secret (header), never baked into
  either codebase.
- Read-only actions available to any channel member; **mutating actions gated
  behind ADMIN_IDS** (same gate as `/clear_context` — RPC `command` is as
  powerful as a console command).
- Tool failures degrade gracefully (uniform with existing tools: plain
  `{ error }`, loop feeds back to the model, never crashes the reply).

**Non-goals**
- No in-game autonomous entity / bot player (requires a server-side agent
  process; out of scope).
- No RCON-based design (the docs already chose mod RPC; RCON would also
  expose the console password over the network).
- No chat bridge (Discord ⇄ in-game) yet — this is a separate slice.
- No per-player privacy/opt-out yet (already noted as planned in slice-1 —
  the `/players` tool returns only player names, not UUIDs or IPs, to keep
  the surface minimal until that privacy work lands).

## 4. Architecture

### 4.1 The mod (`klyde-bridge`, Fabric, Java)

Runs inside the server process; binds one HTTP port (configurable). Reads a
shared secret from its config (`klyde-bridge.properties` → token). Endpoints:

| Method | Path | Action | Returns |
|---|---|---|---|
| GET | `/health` | liveness | `{ok:true}` |
| GET | `/status` | server state | `{version, tps, uptime, playersNow, playersMax}` |
| GET | `/players` | online players | `{players:["Alice","Bob"]}` |
| POST | `/command` | run a server command (whitelist, broadcast, say, list, etc.) — with the shared-secret header | `{ok, output}` |

Auth: every request must carry `Authorization: Bearer <token>` matching the
mod's configured secret; otherwise `401`. The mod **never logs** command
output for commands that could contain private data; it returns output to
the caller only.

Any command that changes operator state (`op`, `deop`, `stop`, `save-all` is
fine, but `op` is a privilege escalation) is **denied by default** in the mod
with a fixed deny-list in config (documented, overridable only by editing the
mod config — not through the API). This is defense-in-depth behind the Worker
admin gate.

### 4.2 Worker side — `minecraft` tool

```jsonc
{ "name": "minecraft", "parameters": {
    "action": { "type": "string", "enum": ["status", "players", "command"] },
    "command": { "type": "string", "description": "server command (action=command only)" }
} }
```

- Env (secrets): `MC_BRIDGE_URL` (base URL, e.g. `http://host:25590`),
  `MC_BRIDGE_TOKEN`.
- `status` / `players` → GET; `command` → POST with body `{"command": ...}`.
- Mutating gate: `command` is refused **inside the tool** when
  `env.ADMIN_IDS` does not contain the current asker
  (`env.CURRENT_USER_ID`), mirroring the clear-context gate.
- Errors: non-2xx → `{ error }` with status; network/timeout → `{ error }`;
  same shape as `search`/`fetch_url`.
- The tool is just another entry in `AGENT_TOOLS`; **no `processor.js`
  changes** (redis the `CONVERSATION_STUB`/`CURRENT_USER_ID` plumbing).

### 4.3 Wiring

| Env/secret | In | Used by |
|---|---|---|
| `MC_BRIDGE_URL`, `MC_BRIDGE_TOKEN` | wrangler secrets | the `minecraft` tool |
| `ADMIN_IDS` | existing secret | tool's mutating gate |

No new Durable Objects, KV, or migrations.

### 4.4 Testing strategy (before reachability)

- Unit tests with a mock RPC (stub fetch) + a fake admin gate: actions,
  auth header, gate behavior, error mapping.
- The mod itself is out of this repo (Java) — validated in a separate step
  when the server is reachable; for now, the Worker side is fully
  testable in isolation.

## 5. Review Focus (failure modes tests must pin)

1. `status`/`players` pass the bearer token and map the response.
2. `command` with a non-admin asker → `{ error }`, no fetch to the mod.
3. `command` with an admin → POST, returns `{ok, output}`.
4. Non-2xx (401 from the mod, 500) → `{ error }` with status.
5. Network failure / timeout → `{ error }`, never throws.
6. Missing `MC_BRIDGE_URL`/`MC_BRIDGE_TOKEN` → clean `{ error }`.
7. `AGENT_TOOLS` now has **8** entries (search, fetch_url, memory,
   skills_list, skill_view, skill_manage, session_search, minecraft).
8. Tool description tells the model when to use it and that commands are
   admin-gated.

## 6. Open items (for confirmation — not blockers)

1. **Mod repo location:** sibling folder vs. separate repo? (Recommend a
   sibling folder `minecraft/klyde-bridge/` in this repo for now; the mod is
   small.)
2. **Command allow-list:** default deny-list in the mod (`op`, `deop`,
   `stop`, ...) — confirm scope.
3. **Fixed Discord UI:** should the read-only status/players also be exposed
   as fixed slash commands (`/mc status`, `/mc players`) for non-agent use,
   or agent-tool-only for now?
4. **Reachability plan:** tunnel (cloudflared) vs port-forward when opened —
   affects later docs (README), not code.

## 7. Definition of done

- Tests green (tool suite + declaration update; no processor/DO changes).
- Live (when server reachable): `minecraft` tool status/players/command all
  work against the real mod; non-admin `command` refused.
- README section + release tag (`v0.8.0`).
