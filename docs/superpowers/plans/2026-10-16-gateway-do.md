# Gateway Durable Object Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give tsq-klyde a persistent Discord gateway connection via a singleton Gateway Durable Object, so the bot shows online status and replies to @mentions in real time with no polling.

**Architecture:** One `GatewayDO` instance (`idFromName("gateway")`) owns a single outbound WebSocket to Discord: identify/resume, heartbeats, reconnect with backoff, and a 60s alarm watchdog. `MESSAGE_CREATE` events mentioning the bot are dispatched to the existing per-channel `ConversationDO` pipeline via `ctx.waitUntil` (never blocking heartbeats), serialized per channel. The Worker keeps serving slash commands over HTTP and wakes the gateway on every fetch. The Guild-DO tier is explicitly deferred — no guild-scoped features exist yet.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite storage, alarms), Discord Gateway API v10 JSON, itty-router v4, node:test.

**Spec:** Agreed design thread (2026-10-16): Gateway DO singleton → existing ConversationDO pipeline; Guild DOs deferred; poll-cron stays out; cold start heals via wake-on-fetch + alarm loop. Prior review constraints incorporated: never await the LLM in the socket handler; per-channel concurrency limit; resume-first reconnects.

## Global Constraints

- `compatibility_date` stays `2025-01-01` — use no runtime API newer than it.
- No secrets in the repo, ever. Token only read from `env.DISCORD_TOKEN` at runtime.
- No `wrangler deploy` in this plan — validation is `wrangler deploy --dry-run` only.
- Live worker name is `tsq-klyde` (K). Branch work must not rename it.
- Behavior of slash commands (`/ask`, `/clear_context`) and `ConversationDO` is unchanged.

## Review Focus

- Zombie socket (heartbeat sent, no ACK within interval) → socket is closed and a resume is attempted, not left half-open. Pinned in Task 3 tests.
- Op 9 Invalid Session with `d:false` → session cleared and fresh identify sent (a resume retry would loop). Pinned in Task 3 tests.
- Two mentions arriving back-to-back in the same channel → replies serialize in order, never overlapping Groq calls. Pinned in Task 3 tests.
- Close 4004 (bad token) → fatal status, zero reconnect attempts (no tight auth-failure loop). Pinned in Task 3 tests.
- Cold start (fresh deploy, no alarm set) → first `POST /wake` (or any worker fetch) creates the socket. Pinned in Task 4 tests.

---

### Task 1: Branch and repo setup

**Files:**
- Create: `.gitattributes`
- (git only): branch `feat/gateway-do` from `main`

**Interfaces:**
- Consumes: clean tree at `c16f954`
- Produces: branch ready for Tasks 2–4

- [ ] **Step 1: Create the branch and attributes file**

```bash
git checkout -b feat/gateway-do
```

`.gitattributes` content: `* text=auto` (silences the LF/CRLF warnings seen on Windows checkouts, normalizes line endings going forward).

- [ ] **Step 2: Commit**

```bash
git add .gitattributes
git commit -m "chore: normalize line endings and start gateway-do branch"
```

- [ ] **Step 3: Verify** — Run: `git status --short && git branch --show-current`. Expected: empty status, `feat/gateway-do`.

### Task 2: Gateway protocol helpers (pure, fully tested)

**Files:**
- Create: `src/gateway.js`
- Create: `test/gateway.test.mjs`

**Interfaces:**
- Consumes: nothing (pure module, no bindings)
- Produces (exact names Task 3 imports): `GATEWAY_URL`, `INTENTS`, `identifyPayload(token)`, `resumePayload(token, sessionId, seq)`, `heartbeatPayload(seq)`, `classifyClose(code)`, `reconnectDelay(attempt)`, `stripMention(content, botId)`, `shouldHandleMessage(msg, botId)`

Pinned values: `GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json"`; `INTENTS = 513` (GUILDS `1<<0` | GUILD_MESSAGES `1<<9` — no privileged intents needed since mention/reply content is delivered without `MESSAGE_CONTENT`); identify uses `shard: [0, 1]` and presence `{ status: "online", activities: [{ name: "@mentions", type: 2 }], since: null, afk: false }`; `classifyClose` returns `"fatal"` for 4004/4010/4011/4012/4013/4014, `"fresh"` for 4001/4002/4003/4005/4007, `"resume"` for everything else; `reconnectDelay(attempt) = min(60_000, 1000 * 2**attempt) + jitter(0–1000ms)`; `shouldHandleMessage` returns `{ handle: false }` when `msg.author.bot` or author id equals botId, `{ handle: true, prompt }` when the bot is in `msg.mentions` or `msg.referenced_message.author.id === botId`, with `prompt = stripMention(...) || "Please continue."`, else `{ handle: false }`.

- [ ] **Step 1: Write the failing test** — `test/gateway.test.mjs` (node:test): classify table (4000→resume, 4004→fatal, 4014→fatal, 4007→fresh, 4009→resume, 1006→resume); delay bounds (attempt 0 in [1000,2000), attempt 10 ≤ 61000); identify shape (op 2, intents 513, shard [0,1], presence online); resume/heartbeat shapes (op 6 with token/session/seq; op 1 passes seq through including null); shouldHandle cases (mention→handle+stripped prompt, mention-only content→"Please continue.", author-bot→ignore, no-mention→ignore, reply-to-bot→handle).
- [ ] **Step 2: Run test to verify it fails** — Run: `node --test test/gateway.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `src/gateway.js`** — the nine exports above, no imports, no side effects.
- [ ] **Step 4: Run test to verify it passes** — Run: `node --test test/gateway.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add src/gateway.js test/gateway.test.mjs && git commit -m "feat(gateway): add pure Discord gateway protocol helpers"`

### Task 3: GatewayDO — socket lifecycle and dispatch

**Files:**
- Create: `src/gateway_do.js`
- Create: `test/gateway_do.test.mjs`

**Interfaces:**
- Consumes: Task 2 exports; existing `processMessage(context, env)` from `src/processor.js` (unchanged signature); bindings `CONVERSATION_DO`, `LAST_MESSAGE_KV`; secrets `DISCORD_TOKEN`, optional `DISCORD_BOT_ID`
- Produces: `export class GatewayDO`; HTTP surface consumed by Task 4: `GET /status`, `POST /wake`, `POST /connect`; storage keys `gw:session` (`{ sessionId, resumeUrl, seq }`) and `gw:status`

Behavior contract: constructor is `(state, env, deps = {})` where `deps.createSocket(url)` defaults to opening a real outbound socket (`new WebSocket(url)` + `accept()`); tests inject a fake. Single socket at a time; `#connect(resumePreferred)` uses `resumeUrl || GATEWAY_URL` when resuming. On HELLO: resume if session exists else identify; send first heartbeat immediately, then `setInterval`; each tick with unacked previous heartbeat closes the socket (zombie path). Op 7 → reconnect-with-resume; op 9 → `d ? resume : fresh identify with session cleared`; op 11 → ack. Dispatch updates `seq`, persists `gw:session` per event, handles READY (store session/resumeUrl/bot user id/guild count, reset backoff) and RESUMED (reset backoff). MESSAGE_CREATE → `shouldHandleMessage`; if handled, chain onto per-channel promise in `inflight` map and run the LLM work inside `ctx.waitUntil` (which calls the unchanged `processMessage` with `{ channel_id, guild_id, user_id, content: prompt }` and no `interaction`, so the reply posts via REST), then KV-put `last_<channel_id>`. Close frames route through `classifyClose`: fatal sets flag + status and stops; fresh clears session then reconnects; resume reconnects; reconnects use `reconnectDelay` via `setTimeout`. `alarm()` re-arms itself for +60s in a `finally`, and connects when the socket isn't open and not fatal.

- [ ] **Step 1: Write the failing test** — `test/gateway_do.test.mjs` with fake `ctx` (Map-backed `storage.get/put`, `setAlarm` recorder, `waitUntil(fn)` that runs `fn()` inline), fake socket factory (records sent frames; `triggerMessage(obj)` / `triggerClose(code)` helpers), mocked global `fetch` (Groq returns canned reply; Discord POSTs recorded), and minimal fake `CONVERSATION_DO`/`LAST_MESSAGE_KV` env. Cases: `/wake` on cold start creates socket; HELLO → identify frame (op 2); READY → `/status` shows connected + persisted session; MESSAGE_CREATE @mention → Discord channel POST with Groq text; unacked heartbeat → socket closed; op 9 `d:false` → fresh identify + cleared session; close 4004 → fatal status, no new socket; two rapid mentions same channel → two ordered channel POSTs.
- [ ] **Step 2: Run test to verify it fails** — Run: `node --test test/gateway_do.test.mjs`. Expected: FAIL (class missing).
- [ ] **Step 3: Implement `GatewayDO` in `src/gateway_do.js`** per the contract above.
- [ ] **Step 4: Run test to verify it passes** — Run: `node --test test/gateway_do.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add src/gateway_do.js test/gateway_do.test.mjs && git commit -m "feat(gateway): add Gateway Durable Object with resume and watchdog"`

### Task 4: Worker wiring, config, docs, full verification

**Files:**
- Modify: `src/index.js` (gateway stub helper, wake-on-fetch, two routes, import `stripMention` from `./gateway.js` replacing the local copy)
- Modify: `wrangler.jsonc` (add `GATEWAY_DO` binding + `v2` migration; keep `v1` entry)
- Modify: `package.json` (add `"test": "node --test test/"`)
- Modify: `README.md` (gateway ops: intents 513, wake-on-first-fetch, `POST /gateway/connect` after deploy, `GET /gateway/status`, no privileged intent needed for mentions, DMs out of scope)
- Create: `test/worker.test.mjs`, `test/conversation.test.mjs`

**Interfaces:**
- Consumes: Task 3 HTTP surface (`/status`, `/wake`, `/connect` on the `gateway` stub)
- Produces: `GET /gateway/status` and `POST /gateway/connect` passthroughs on the worker; every worker `fetch` fires `POST https://gateway/wake` via `ctx.waitUntil` with errors logged-and-swallowed so interactions can never break

- [ ] **Step 1: Write the failing tests** — `test/worker.test.mjs`: `/health`→200, unknown route→404, malformed interaction body→400, bogus signature→401, and wake-on-fetch (a `/health` fetch causes exactly one `POST` to the gateway stub's `/wake`) using a fake `GATEWAY_DO` binding. `test/conversation.test.mjs`: port the ConversationDO lifecycle assertions (append/get/usage/summary/clear/404).
- [ ] **Step 2: Run tests to verify they fail** — Run: `npm test`. Expected: FAIL (routes/binding missing).
- [ ] **Step 3: Implement wiring + config + README** per interfaces above. Migration entry: `{ "tag": "v2", "new_classes": ["GatewayDO"] }` appended after `v1`.
- [ ] **Step 4: Run full suite** — Run: `npm test`. Expected: all PASS.
- [ ] **Step 5: Validate deployability** — Run: `npx wrangler deploy --dry-run`. Expected: bundle succeeds, three bindings listed (CONVERSATION_DO, LAST_MESSAGE_KV, GATEWAY_DO). Do not deploy.
- [ ] **Step 6: Commit** — `git add src/index.js wrangler.jsonc package.json README.md test/worker.test.mjs test/conversation.test.mjs && git commit -m "feat(gateway): wire worker to GatewayDO and add test suite"`

## Self-Review

1. Spec coverage: singleton socket ✓ (T3), heartbeats/zombie ✓ (T3), resume-first + op9 ✓ (T3), dispatch without blocking ✓ (T3 waitUntil + inflight), watchdog ✓ (T3 alarm), presence ✓ (T2 payload), slash coexistence ✓ (T4 passthrough, unchanged handlers), no-poll ✓ (no cron added), wake-on-fetch ✓ (T4), Guild DOs deferred and documented ✓ (README + architecture line).
2. Step scan: each test step names exact assertions; each code step names file + signatures + pinned values; bodies appear only where tests don't determine them (DO internals).
3. Type consistency: `stripMention` is the single name (T2 defines, T4 imports); stub routes `/status|/wake|/connect` match T3 fetch router and T4 passthroughs; storage keys `gw:session`/`gw:status` used by T3 tests and implementation.
4. Review Focus: all five lines have owning tests in Tasks 3–4.
5. Proportion: signatures, values, and assertions only — no implementation bodies transcribed.
