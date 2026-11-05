# Klyde Reply Attribution + Status Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Klyde's replies thread under their prompt (reply-to-message, no ping by default), record author attribution in conversation history, and delete interim status messages once the final answer posts.

**Architecture:** Extend `sendChannelMessage` to accept reply/mentions options and return the created message id; add a `deleteChannelMessage` helper. Thread author + message_id from the gateway through `processMessage` into history and the prompt. Refactor `createStatusSender` to capture posted message ids and expose a cleanup step that deletes them after the final answer.

**Tech Stack:** Cloudflare Workers, Discord REST v10, node:test.

**Spec:** `docs/superpowers/specs/2026-11-06-klyde-reply-attribution-spec.md`

## Global Constraints

- `PING_AUTHOR` env `var`, default `false`, read as `env.PING_AUTHOR === "true"`.
- Status messages are never threaded; only the final answer is.
- Slash `/ask` path unchanged.
- Status cleanup is best-effort; deletion errors are swallowed.

## Review Focus

- Default reply sends `allowed_mentions.replied_user=false`; flag `true` flips it.
- `message_reference.message_id` equals the original ping's id.
- History entries carry author; prompt context includes author name.
- Status messages are deleted after the final answer posts.
- `/ask` builds no reply reference.

---

### Task 1: Discord send/delete helpers

**Files:**
- Modify: `src/discord.js`
- Test: `test/discord-chunks.test.mjs` (extend) or new `test/discord-reply.test.mjs`

**Interfaces:**
- Consumes: existing `sendChannelMessage(channel_id, content, env)`
- Produces: `sendChannelMessage(channel_id, content, env, opts)` where `opts = { replyTo?: string, pingAuthor?: boolean }`; returns the parsed created message object `{ id }` (from the POST response). Also `export async function deleteChannelMessage(channel_id, message_id, env)` → best-effort DELETE.

- [ ] **Step 1: Write the failing test** — `sendChannelMessage` with `opts.replyTo` sends body containing `message_reference.message_id`; with `pingAuthor:false` sends `allowed_mentions.replied_user=false`; with `pingAuthor:true` sends `true`; returns `{ id }` parsed from a mock 200.
- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.
- [ ] **Step 3: Implement** — extend `sendChannelMessage` (add opts, parse response JSON, return `{ id }`), add `deleteChannelMessage`.
- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(discord): reply-to-message options + delete helper`

### Task 2: Author attribution in history + prompt

**Files:**
- Modify: `src/processor.js`, `src/conversation_do.js` (if needed)
- Test: extend `test/processor.test.mjs`

**Interfaces:**
- Consumes: `context.username` and `context.user_id` (added in Task 3)
- Produces: `userEntry.author = { id, name }`; when building `messages` for the LLM, user history entries are prefixed `"[<name>] <content>"` (fallback to id if no name). Current asker's name is included in the user message the same way.

- [ ] **Step 1: Write the failing test** — after `processMessage` with a `username`, history entry has `author.name`; the messages sent to the LLM include `"[Alice] ..."` prefix.
- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.
- [ ] **Step 3: Implement** — add author to `userEntry`, add prefix logic when building messages.
- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(processor): author attribution in history and prompt`

### Task 3: Gateway passes username + message_id + reply threading

**Files:**
- Modify: `src/gateway_do.js`
- Test: extend `test/gateway_do.test.mjs`

**Interfaces:**
- Consumes: `msg.author?.username`, `msg.id`
- Produces: `processMessage` context gains `username` and `message_id`; the final `sendChannelMessage` call for the answer uses `{ replyTo: msg.id, pingAuthor: env.PING_AUTHOR === "true" }`.

- [ ] **Step 1: Write the failing test** — in the mention e2e test, assert the answer POST includes `message_reference.message_id` = the mention's id, and `replied_user=false` by default.
- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.
- [ ] **Step 3: Implement** — thread username/message_id into context; pass reply opts to final send.
- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(gateway): thread author + reply-to-message on answers`

### Task 4: Status cleanup + PING_AUTHOR var

**Files:**
- Modify: `src/processor.js` (`createStatusSender`), `wrangler.jsonc`
- Test: extend `test/processor-status.test.mjs`

**Interfaces:**
- Consumes: `deleteChannelMessage` (Task 1)
- Produces: `createStatusSender` accepts a `channel.send` that returns `{ id }`, records sent ids, and returns `{ send, cleanup }`; `cleanup()` calls `deleteChannelMessage` for each recorded id (swallowing errors). In `processMessage`, after the final answer posts, call `cleanup()`.

- [ ] **Step 1: Write the failing test** — `createStatusSender` records ids; `cleanup()` issues a delete per sent status message; deletion errors are swallowed. Add `"vars": { "PING_AUTHOR": "false" }` to wrangler config (verify parse).
- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL.
- [ ] **Step 3: Implement** — rework `createStatusSender`; wire cleanup after final post; add var.
- [ ] **Step 4: Run full suite + dry-run** — `npm test` all pass; `npx wrangler deploy --dry-run` shows the new var.
- [ ] **Step 5: Commit** — `feat(processor): delete status messages after final answer; add PING_AUTHOR var`

### Task 5: Deploy + live verify

- [ ] **Step 1: Deploy** — `npx wrangler deploy`.
- [ ] **Step 2: Live test** — ping the bot; confirm the answer is threaded under the prompt, no ping, status messages disappear after the answer.
- [ ] **Step 3: Flag check** — temporarily set `PING_AUTHOR=true`, confirm the reply pings, then revert.
- [ ] **Step 4: Push** — `git push origin main`.

## Self-Review

1. Spec coverage: threading ✓ (Tasks 1,3), no-ping default ✓ (Task 1), author attribution ✓ (Task 2), status cleanup ✓ (Task 4), flag ✓ (Task 4), /ask untouched ✓ (no change there).
2. Step scan: each step is one checkable action; test names/assertions pinned.
3. Type consistency: `opts.replyTo/pingAuthor`, `{ id }` return, `{ send, cleanup }` agree across tasks.
4. Review Focus: all five lines map to tests in Tasks 1–4.
5. Proportion: code blocks only where signature/test don't determine the body.
