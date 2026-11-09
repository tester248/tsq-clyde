# Klyde Bounded Memory (Phase 1) — Design Spec

> **Status:** Design spec for review. No code until approved.
> **Source inspiration:** Nous Research's Hermes Agent (MIT) — its bounded
> MEMORY.md / USER.md pattern, memory tool actions (add/patch/remove), and
> capacity management. We port the *ideas*, not the Python.

## 1. Intent

Give Klyde the "remembers across turns" superpower Hermes has, adapted to its
per-channel architecture. Two bounded memory stores, injected into the prompt,
and managed by the agent itself through a `memory` tool:

- **Channel memory** (agent's notes for this channel) — env facts, project
  conventions, lessons learned, workflow preferences expressed in the channel.
- **User profiles** — per-user preferences / communication style, keyed by
  Discord user id.

This is Phase 1 of the Hermes-inspired roadmap: skills and session search come
later. Nothing here touches the existing agent loop's search/fetch_url tools.

## 2. Why

- Klyde currently forgets everything except the rolling `history` window, which
  is also wiped/compacted by the token cap. Users re-explain preferences every
  time.
- Hermes's core insight: keep a *tiny* set of durable facts always in context
  (a few hundred tokens), rather than replaying long history. This maps
  perfectly to Workers' context pressure.
- It composes with what we already built: author attribution (profiles key off
  the same user_id) and the per-channel ConversationDO (memory lives in the
  same DO state).

## 3. Goals / Non-goals

**Goals**
- A `memory` agent tool with `add` / `patch` / `remove` actions and two
  targets: `memory` (channel notes) and `user` (current asker's profile).
- Hard character caps on both stores; over-capacity calls return an error with
  current entries so the agent can consolidate (Hermes pattern).
- Channel memory + current asker's profile injected into the LLM system prompt
  each turn, as labeled, §-delimited blocks.
- Duplicate prevention; light security scan (reject invisible unicode /
  control chars on write).
- Memory persists in the per-channel ConversationDO (survives eviction),
  separate from `history`.

**Non-goals**
- No skills system yet (Phase 2).
- No cross-session FTS search yet (Phase 3).
- No background self-improvement review (Phase 4).
- Memory is per-channel (shared by everyone in the channel), matching the
  existing history model; user profiles are per-user but stored in the channel
  DO (note: a user active in two channels has two separate profile stores —
  acceptable for Phase 1).
- No write-approval gate (agent writes freely, Hermes default).

## 4. Architecture

### 4.1 Storage — `ConversationDO`

Add two fields to the persisted `state`:

```js
state.memory = ""          // channel notes, ≤ 2200 chars
state.userProfiles = {}    // { [userId]: profile }, each ≤ 1375 chars
```

New HTTP routes on the DO: `/memoryGet`, `/setMemory`, `/getUserProfile`,
`/setUserProfile`, `/clear` (updated to reset history + memory, keep
profiles). The single `state` blob keeps persistence unchanged.

Constants:
- `MEMORY_CHANNEL_LIMIT = 2200`
- `MEMORY_USER_LIMIT = 1375`
- Entry delimiter: `§`

### 4.2 Prompt injection — `processor.js`

When building `messages`, after the existing summary:
- If `state.memory` is non-empty → push a system message:
  `"MEMORY (channel notes) [X/2200 chars]\n" + state.memory`
- If `state.userProfiles[context.user_id]` exists → push a system message:
  `"USER PROFILE [X/1375 chars]\n" + profile`

This is a fresh snapshot per mention (each mention is a session), which
mirrors Hermes and keeps prompts cache-friendly.

### 4.3 `memory` tool — `tools.js`

New entry in `AGENT_TOOLS` + `TOOL_IMPLS`. Signature:

```jsonc
{
  "name": "memory",
  "parameters": {
    "target": "memory" | "user",
    "operations": [
      { "action": "add",    "content": "…" },
      { "action": "patch",  "old_text": "…", "content": "…" },
      { "action": "remove", "old_text": "…" }
    ]
  }
}
```

Behavior (mirrors Hermes):
- `add` — append entry; exact-duplicate → `{ success: true, note: "no duplicate added" }`.
- `patch` — replace the unique substring `old_text` inside one entry; ambiguous
  (0 or 2+ matches) → error listing closest entries.
- `remove` — delete the entry containing the unique substring `old_text`.
- Target `user` always resolves to the **current asker** (`env.CURRENT_USER_ID`).
- If a write would exceed the cap → error with current entries + chars needed
  (so the agent can consolidate in the same call's next batch).
- Security scan on write: reject content containing zero-width / control
  characters (prompt-injection hygiene).
- All actions return plain values (never throw), consistent with the other tools.

### 4.4 Plumbing — how the tool reaches the DO

`processMessage` currently calls `runAgentLoop({ messages, env, onPhase })`.
The memory tool needs the channel DO stub + key + current user. `processMessage`
passes an augmented env:

```js
const toolEnv = Object.assign(Object.create(env), {
  CONVERSATION_STUB: stub,
  CONVERSATION_KEY: key,
  CURRENT_USER_ID: context.user_id,
});
await runAgentLoop({ messages, env: toolEnv, onPhase: sendStatus.send });
```

The `memory` tool uses `env.CONVERSATION_STUB.fetch(...)` to read/write. Since
env flows to `executeTool(name, args, env)` unchanged, no signature changes are
needed elsewhere. Tests provide these three props in their env.

## 5. Where each piece lives

| Change | File | Detail |
|---|---|---|
| State fields + DO routes | `src/conversation_do.js` | `memory`, `userProfiles`; new routes; `/clear` semantics |
| Constants | `src/ai.js` or `src/processor.js` | caps + delimiter (exported where tests need them) |
| Prompt injection | `src/processor.js` | memory + profile system blocks |
| `memory` tool | `src/tools.js` | tool def + impl + security scan |
| Env plumbing | `src/processor.js` | toolEnv with `CONVERSATION_STUB`/`KEY`/`CURRENT_USER_ID` |

## 6. Review Focus (failure modes tests must pin)

1. `add` appends; `patch`/`remove` use unique substring matching; ambiguous
   match returns an error listing candidates.
2. Over-capacity write returns an error naming the cap, current size, and chars
   needed (agent can consolidate).
3. Exact duplicate `add` returns success with "no duplicate added".
4. Security scan rejects zero-width/control-chars content.
5. Both stores persist across DO `initialize` (eviction reload).
6. `/clear` resets history + channel memory; user profiles survive.
7. Prompt includes memory block and current asker's profile only when present;
   correct labels + capacity fractions.
8. Target `user` mutates only the current asker's profile.

## 7. Open items (locked)

- Caps: 2200 (channel) / 1375 (user) — same as Hermes; easy to tune later.
- Per-channel profile duplication across channels accepted for Phase 1.
- Memory is shared per channel (matches history model), so any channel member
  can influence the channel's notes. Acceptable; a per-user permission gate can
  come later.

## 8. Definition of done

- Tests green (new ConversationDO routes + tool + processor injection suites).
- Live: after a conversation, the bot retains a fact via the memory tool and
  acts on it in a later turn; a user preference persists across mentions.
- README updated; commits follow conventional style; tagged at slice end.
