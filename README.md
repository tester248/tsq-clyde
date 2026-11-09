# tsq-clyde

Discord + Minecraft agent bot on Cloudflare Workers + Durable Objects. The
live worker is `tsq-klyde`. Currently the Discord leg is active: a gateway
bot that answers `@Klyde` mentions with a tool-using agent loop.

## Architecture

- **`GatewayDO`** (`src/gateway_do.js`) — singleton Durable Object that owns
  the outbound Discord WebSocket. Dispatches mention/reply events to the
  per-channel conversation pipeline, serialized per channel.
- **`ConversationDO`** (`src/conversation_do.js`) — one Durable Object per
  Discord channel (keyed by `channel_id || guild_id || "global"`), holding a
  rolling conversation history plus bounded memory (channel notes + per-user
  profiles).
- **`processor.js`** — `processMessage` ties it together: loads history,
  formats the LLM prompt (with author attribution + memory blocks), runs the
  agent loop, and posts the reply.
- **`agent.js`** — `runAgentLoop`: a bounded, failure-tolerant tool loop.
- **`tools.js`** — the agent's tools: `search` (multi-provider), `fetch_url`,
  and `memory` (bounded memory add/patch/remove).
- **`ai.js`** — `callLLM`/`generateReply`: the provider fallback chain.

## Agent & AI pipeline

**Provider chain** (`src/ai.js`), tried left-to-right:

1. **Mercury 3** (`mercury-3`) via `INCEPTION_API_KEY` (Inception API)
2. **Groq** (`openai/gpt-oss-120b`) via `GROQ_API_KEY`
3. **WUS router** (`uncensored/deepseek-v4.1-flash:free`) via `WUS_API_KEY`
4. **Workers AI** granite-micro (`@cf/ibm-granite/granite-4.0-h-micro`) via
   the `AI` binding

**Refusal escalation:** a provider that *declines* to answer (a refusal, or
empty output) is skipped like a failed one, so the question falls through to
the next tier — in practice, a Mercury/Groq refusal reaches WUS. Detection is
a conservative phrase heuristic (`isRefusal`). If every provider fails or
declines, the last non-empty response is returned rather than a generic error.

**Uncensored answers:** when WUS answers, the channel reply is prefixed
`[uncensored answer]`, and the persisted history entry is a neutral placeholder
(`[provided a direct answer]`) — raw uncensored text never enters the shared
conversation that Mercury/Groq read. Normal replies are untagged and stored
verbatim.

**Tool loop** (`src/agent.js`): the model may call `search`/`fetch_url`.
Tool results feed back as tool messages until the model answers. Bounded to
6 iterations / 90s. Only a **tool-free message** counts as the final answer —
narration emitted alongside a tool call is never returned; on true truncation
the bot replies honestly instead of promising a follow-up it won't make.

**Search** (`src/tools.js`): `SEARCH_PROVIDER` env (default `"tavily,exa"`)
selects the order; first provider to succeed wins (`TAVILY_API_KEY`, then
`EXA_API_KEY`). `fetch_url` reads a page as text (64 KB cap, per-tool
timeout).

**Fast path:** greetings/trivial pings skip the tool loop entirely and answer
instantly.

**Bounded memory** (Hermes-inspired): the agent can persist durable facts via
a `memory` tool — `target: "memory"` is this channel's shared notes (2200-
char cap), `target: "user"` is the current asker's profile (1375-char cap).
Entries are §-delimited; `add` appends (exact duplicates skipped), `patch`
replaces a unique substring, `remove` deletes an entry. Over-capacity writes
return a consolidation error listing current entries so the model can free
space in one batch; content with invisible/control characters is rejected.
Both stores live in the per-channel `ConversationDO` and are injected into the
prompt each turn as system blocks with capacity fractions (`MEMORY (channel
notes) [n/2200 chars]`, `USER PROFILE [n/1375 chars]`) — a few hundred tokens
of durable context, always visible. `/clear` wipes history + channel memory
but keeps user profiles (identity facts). Roadmap: skills (Phase 2) and
cross-session search (Phase 3) build on this store.

## Reply attribution & status cleanup

- **Reply-to-message threading** — the final answer is sent as a **reply
  under the prompt** (`message_reference`), so everyone sees which answer
  goes with which question. Long replies are chunked (≤1900 chars); only the
  first chunk is threaded.
- **No ping by default** — `allowed_mentions.replied_user` defaults to
  `false`. Set `PING_AUTHOR=true` (a `vars` env, not a secret) to ping the
  author instead.
- **Author attribution** — conversation history records who said what; user
  messages are prefixed with the author's name in the LLM prompt, so the
  model can reference speakers in a shared channel.
- **Status cleanup** — the interim status messages (`searching…`,
  `reading…`, `composing…`) are deleted after the final answer posts
  (best-effort; deletion errors are swallowed).
- Slash `/ask` uses the interaction reply flow and is **not** threaded.

## Gateway (real-time mentions, online status)

A singleton `GatewayDO` (`src/gateway_do.js`, id `"gateway"`) holds one
persistent WebSocket to the Discord gateway. It identifies with intents
**513** (`GUILDS | GUILD_MESSAGES`) and presence `online`, heartbeats per
`HELLO`, and resumes across reconnects from persisted session state. No
privileged intents are needed: @mention and reply content is delivered
without `MESSAGE_CONTENT`. DMs are out of scope.

Liveness without polling:

- Every Worker `fetch` fires `POST /wake` at the gateway (fire-and-forget,
  never breaks slash commands).
- A self-rearming 60s alarm reconnects when the socket is missing.

Ops:

- `GET /gateway/status` — `{"state":"connected"|"connecting"|"disconnected"|"fatal", ...}`
- `POST /gateway/connect` — manual (re)connect. Call once after the first
  deploy carrying the `GatewayDO` migration, and after fixing config when
  status is `fatal` (e.g. bad token, close 4004 — never auto-retried).

## Polling fallback (dormant)

`scheduled()` + `pollChannel()` in `src/index.js` poll watched channels for
@mentions. No cron trigger is attached (`wrangler.jsonc` has no `triggers`),
so this path never runs — it stays as a zero-cost manual fallback.

## Configuration

`wrangler.jsonc`:

- **Bindings** — `CONVERSATION_DO`, `GATEWAY_DO` (both SQLite-backed), an
  `AI` binding, and `LAST_MESSAGE_KV` KV namespace.
- **`vars`** (plain env, deploy-time):
  - `PING_AUTHOR` — `"false"` default; `"true"` pings the replied-to author.
  - `SEARCH_PROVIDER` — `"tavily,exa"` default.
- **Secrets** (`wrangler secret put <NAME>` — never in the repo):
  `DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_ID`, `GROQ_API_KEY`,
  `INCEPTION_API_KEY`, `WUS_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`,
  `ADMIN_IDS` (comma-separated Discord user IDs allowed to run `/clear_context`).

> Note: Data Studio on the dashboard can only read SQL-API data. This
> project persists via the KV storage API, so conversation state is **not**
> viewable there; use the DO's `/get` endpoint (or a debug route) to inspect
> it.

## Dev

- `npm test` — unit suite (`node --test test/`, no network)
- `npm run dev` — `wrangler dev` (local)
- `npm run dry-run` — `wrangler deploy --dry-run` (validates bundle + bindings)
- `npm run deploy` — `wrangler deploy`

## Releases

- `v0.2.0` — Mercury 3 primary; provider fallback chain (Mercury → Groq →
  Workers AI granite-micro).
- `v0.3.0` — agent tool loop (`search` + `fetch_url`).
- `v0.3.1` — multi-provider search (Tavily + Exa).
- `v0.3.2` — agent UX batch: progressive status phases, per-tool timeout,
  chunked Discord replies, truncation-narration fix.
- `v0.4.0` — reply attribution: reply-to-message threading, `PING_AUTHOR`
  flag, author attribution in memory, and status-message cleanup.
- `v0.5.0` — bounded memory: `memory` tool (add/patch/remove, 2200/1375
  char caps), per-channel notes + per-user profiles in `ConversationDO`, and
  prompt injection of both stores each turn.
