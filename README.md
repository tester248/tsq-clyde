# tsq-clyde

Discord bot on Cloudflare Workers + Durable Objects (live worker: `tsq-klyde`).

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

Mention/reply events dispatch to the existing per-channel `ConversationDO`
pipeline (`processMessage`, no `interaction` so replies post via REST),
serialized per channel. Guild-scoped Durable Objects are deliberately
deferred — no feature needs guild-shared state yet.

## Polling fallback (dormant)

`scheduled()` + `pollChannel()` in `src/index.js` poll watched channels for
@mentions. No cron trigger is attached (`wrangler.jsonc` has no `triggers`),
so this path never runs — it stays as a zero-cost manual fallback.

## Dev

- `npm test` — unit suite (`node --test test/`, no network)
- `npm run dry-run` — `wrangler deploy --dry-run` (validates bundle + bindings)
- Secrets (`DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_ID`,
  `GROQ_API_KEY`) live in the dashboard / `wrangler secret put` — never in the repo.
