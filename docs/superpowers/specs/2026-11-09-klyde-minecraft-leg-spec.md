# Klyde Minecraft Leg — Design Spec

> **Status:** Design spec for review. No code until approved.
> **Prior art:** Consolidates planning already recorded in this repo:
> - `2026-11-05-klyde-agent-slice1-web-spec.md` — "the Minecraft mod's RPC
>   becomes another 'tool' alongside web search" (the loop is deliberately
>   platform-agnostic); "No per-player privacy/opt-out logic yet
>   (Minecraft-specific; planned)".
> - `2026-11-08-klyde-wus-escalation-spec.md` — "the Minecraft path (future)".
> - README intro: "Discord + Minecraft agent bot on Cloudflare Workers."

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
