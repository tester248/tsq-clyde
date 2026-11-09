# Klyde Session Search (Phase 3) — Design Spec

> **Status:** Design spec for review. No code until approved.
> **Source inspiration:** Nous Research's Hermes Agent (MIT) — its FTS5
> `session_search` over past conversations (unlimited, on-demand, no token
> cost until used). We port the *idea* to Klyde's SQLite-backed
> `ConversationDO`.

## 1. Intent

Give Klyde **full-text recall over past conversations**: a `session_search`
agent tool that searches every message this channel has ever seen — including
messages long since compacted away from the live `history` window.

Today, history rolls off and is summarized+discarded at the token cap; the
summaries keep context but destroy detail. Session search fixes that: the
search index is **append-only and survives compaction**, so old specifics stay
findable on demand without ever occupying prompt space.

## 2. Why

- Phase 1 gave durable *facts* (memory); Phase 2 gave reusable *procedures*
  (skills). Neither can answer "what did we discuss about X two weeks ago?" —
  that's the third Hermes pillar.
- The DOs are SQLite-backed, and FTS5 ships inside SQLite: the same storage
  Hermes uses, already on our platform. No new infra.
- The tools plumbing already exists: `session_search` rides the same
  `CONVERSATION_STUB` env the memory tool uses — **no processor.js changes**.

## 3. Goals / Non-goals

**Goals**
- FTS5 virtual table per DO (`messages_fts`), created idempotently.
- Every `append` also indexes the message (role, author, content, timestamp).
- One-time backfill of pre-existing `history` when the index is empty.
- `/searchMessages` DO route: sanitized FTS5 match, `bm25` ranking, `snippet()`
  excerpts.
- `session_search` agent tool (query + optional limit), results compactly
  formatted for the model.
- Index survives history compaction AND `/clear` (archive semantics).

**Non-goals**
- No cross-channel search (a DO is per-channel; that's fine).
- No semantic/embedding search — plain FTS5 keyword match (Hermes parity).
- No changes to compaction, history, or the prompt pipeline.
- No public probe endpoint (search results are conversation content — exposing
  them unauthenticated would leak private channel history; live verification
  happens in Discord instead).

## 4. Architecture

### 4.1 Storage — FTS5 table in the DO

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  role UNINDEXED,
  author UNINDEXED,
  ts UNINDEXED
);
```

- Created in the `ConversationDO` constructor (idempotent, cheap).
- **Guard:** if `stateObj.storage.sql` is unavailable (fake/legacy storage),
  skip table creation; `/searchMessages` returns a clean "search unavailable"
  error. Append still works (indexing is best-effort).
- Append-only: no deletes/updates ever.

### 4.2 Write paths

- `append(entry)` — after `state.history.push`, also:
  `INSERT INTO messages_fts(content, role, author, ts) VALUES (?,?,?,?)`
  with `entry.content`, `entry.role`, `entry.author?.name || entry.author?.id || ""`,
  `entry.timestamp ?? Date.now()`.
- `initialize()` — backfill: if `COUNT(*) FROM messages_fts` is 0 **and**
  `state.history` is non-empty, insert all history rows. (Runs at most once
  per channel; afterwards the index is non-empty. If the channel is genuinely
  empty, the count stays 0 and the backfill remains a no-op.)
- `setSummary` (compaction) and `/clear` do **not** touch `messages_fts`.

### 4.3 Read path — `/searchMessages?q=...&limit=n`

```sql
SELECT rowid, role, author, ts,
       snippet(messages_fts, 0, '[', ']', '…', 12) AS snip
FROM messages_fts
WHERE messages_fts MATCH ?
ORDER BY bm25(messages_fts)
LIMIT ?
```

- **Query sanitization:** split `q` on whitespace, keep only unicode letters /
  digits (`/[\p{L}\p{N}]/gu`), drop empties; join tokens as
  `"t1" AND "t2" ...` (all-terms match). Single token → `"t1"`. Empty result
  → error ("query must contain at least one word").
- `limit` clamped to `1..10` (default 5).
- Response: `{ results: [{ rowid, role, author, ts, snippet }] }`.

### 4.4 Tool — `session_search`

```jsonc
{ "name": "session_search", "parameters": {
    "query": { "type": "string" },
    "limit": { "type": "number" }
} }
```

- Implementation uses `env.CONVERSATION_STUB.fetch("/searchMessages?...")` —
  same plumbing as the memory tool (already shipped in Phase 1).
- Returns `{ matches: [{ author, ts, snippet }] }`; missing stub → error.
- Description teaches usage: *"search this channel's past conversations by
  keyword; use when the current context lacks detail you remember discussing
  before."*

### 4.5 Where each piece lives

| Change | File | Detail |
|---|---|---|
| FTS5 table + write paths + route | `src/conversation_do.js` | constructor guard, append insert, initialize backfill, `/searchMessages` |
| `session_search` tool | `src/tools.js` | def + impl via `CONVERSATION_STUB` |
| Tool count assertions | `test/tools.test.mjs`, `test/skills.test.mjs` | 7 tools |
| DO tests | `test/conversation.test.mjs` | SQL fake + route behavior |
| Tool tests | `test/tools.test.mjs` (or new `test/session-search.test.mjs`) | stub-based |
| README | `README.md` | Session search section + release entry |

## 5. Review Focus (failure modes tests must pin)

1. Append indexes; search finds the term; ranking/snippet present.
2. Backfill: pre-existing history becomes searchable (and only once).
3. Compaction (`setSummary`) does not erase the index; old messages still
   searchable after.
4. `/clear` keeps the index (archive semantics) while wiping history/memory.
5. Query sanitization: FTS5 metacharacters (`"`, `*`, `(`, `-` …) stripped;
   multi-word → all-terms; empty query → error.
6. `limit` clamping.
7. Missing `storage.sql` → search returns clean error, appends still work.
8. Tool: `session_search` returns formatted matches; missing stub → error;
   `AGENT_TOOLS` now has 7 entries.

## 6. Open items (locked)

- **`/clear` keeps the index** — cleared live context is gone from the prompt,
  but the archive remains searchable (Hermes parity). If a "hard forget" is
  wanted later, a `/wipeArchive` admin route can be added.
- All-terms AND matching (not phrase adjacency) — predictable and robust;
  revisit only if users need phrase search.
- Indexing is best-effort (a failed INSERT is logged, never fails the append).

## 7. Definition of done

- Tests green (DO routes + tool + updated declarations).
- Live: after a conversation, `session_search` (via the bot) finds an older
  detail even after the context has been cleared/compacted.
- README updated; conventional commits; tagged at slice end (`v0.7.0`).
