# Klyde Reply Attribution — Design Spec

> **Status:** Design spec for review. No code until approved.

## 1. Intent

Make Klyde's replies visibly tied to the person who asked, in a shared Discord channel, without annoying pings. Replace the earlier "ping coalescing" idea with the standard Discord pattern: each response **threads under its own prompt** via reply-to-message, and the model knows **who said what** because conversation history records authors.

## 2. Why (decisions already made)

- **Reply-to-message threading** is the mechanism. It solves the "which answer goes with which prompt" problem visually, so coalescing is unnecessary — pings are answered independently and the thread disambiguates.
- **No ping by default.** Replies use `allowed_mentions: { replied_user: false }`. Pinging the author is optional and opt-in.
- **Author attribution in memory** makes multi-user channels structured: the model sees who asked each thing, enabling natural follow-up references.

## 3. Goals / Non-goals

**Goals**
- Reply-to-message on every non-interaction channel reply (mentions).
- A `PING_AUTHOR` config flag (env `vars`, default `false`) controlling whether the replied-to author is pinged.
- Conversation history records the author of each message; the prompt includes author names so the model can reference them.
- Purely additive — existing agent loop and tools unchanged.

**Status cleanup addition (user decision):** interim status messages are deleted after the final answer posts, keeping the channel clean. Best-effort. This is part of the same slice.

**Non-goals**
- No coalescing/merging of simultaneous pings.
- No per-user memory separation (history stays shared per channel — only attribution is added).
- No change to slash-command `/ask` flow (interactions already have their own ACK/reply mechanism; they don't use reply-to-message).

## 4. Architecture

### 4.1 Data flow (mention path)

```
GatewayDO.#answerMention(msg)
  → processMessage({ channel_id, guild_id, user_id, username, message_id, content }, env)
      → ConversationDO history gains an author field
      → prompt includes author attribution
      → sendChannelMessage(channel_id, text, env, { replyTo: message_id, pingAuthor })
```

### 4.2 Where each piece lives

| Change | File | Detail |
|---|---|---|
| Capture author + message id | `src/gateway_do.js` | `#answerMention` passes `username: msg.author?.username` and `message_id: msg.id` into the `processMessage` context. |
| Store author in history | `src/processor.js` | `userEntry` gains `author: { id: context.user_id, name: context.username }`. |
| Surface author to the model | `src/processor.js` | When building `messages`, prefix each user history entry with its author name (e.g. `"[Uncle Lester] how do I revive my horse?"`). The current asker's name is included too. |
| Reply-to-message + ping flag | `src/discord.js` | `sendChannelMessage(channel_id, content, env, opts)` accepts `opts.replyTo` (message id) and `opts.pingAuthor` (bool). Sets `message_reference` and `allowed_mentions.replied_user`. |
| Flag plumbing | `wrangler.jsonc` | Add `"vars": { "PING_AUTHOR": "false" }`. Read as `env.PING_AUTHOR === "true"`. |
| Gateway passes the flag | `src/gateway_do.js` | `sendChannelMessage` call gets `replyTo: msg.id, pingAuthor: env.PING_AUTHOR === "true"`. |

### 4.3 Discord API specifics

- **Reply-to-message:** body includes `message_reference: { message_id }`. Discord then renders the reply thread under the original message.
- **Suppress ping:** `allowed_mentions: { replied_user: false }` — REQUIRED for the "no ping" default. Without it, Discord pings the replied-to user by default.
- **Ping on:** `allowed_mentions: { replied_user: true }`.

### 4.4 Status updates and cleanup

The interim status messages ("searching the web…") are sent separately and are **not** threaded — they stay as plain channel messages. Only the final answer is reply-threaded.

**Status cleanup:** each status message's id is captured when sent. After the final answer is posted, those status messages are deleted (`DELETE /channels/{id}/messages/{status_id}`) — best-effort, errors swallowed. If a status message is already gone or the bot lacks permission, deletion is skipped. This keeps the channel clean after a multi-phase research reply.

Status-message flow:

```
searching… (posted, id captured)
reading…    (posted, id captured)
composing…  (posted, id captured)
→ final answer (threaded reply, posted)
→ delete the captured status messages (best-effort)
```

## 5. Review Focus (failure modes tests must pin)

1. **No ping by default** — a reply with `pingAuthor=false` sends `allowed_mentions.replied_user=false`; the request body is correct.
2. **Flag flips behavior** — `PING_AUTHOR=true` sends `replied_user=true`.
3. **Threading** — `message_reference.message_id` equals the original ping's id.
4. **Author attribution in history** — history entries carry the author; the prompt context includes the name.
5. **Only mentions are threaded** — slash `/ask` path is untouched (no reply reference).
6. **Status cleanup** — after the final answer posts, the captured status message ids are deleted (DELETE request per id), best-effort with errors swallowed.

## 6. Open items (locked)

- `PING_AUTHOR` default `false`, read as `env.PING_AUTHOR === "true"` from `vars`.
- Username source: `msg.author.username` from the gateway event (no extra API call).
- If no username is available (edge), fall back to the user id in attribution.

## 7. Definition of done

- 80+ tests green (new tests for threading flag, author attribution, prompt formatting).
- Live: `@Klyde <question>` replies threaded under the prompt with no ping; flipping the env flag to `true` pings.
- `/ask` slash command unchanged.
