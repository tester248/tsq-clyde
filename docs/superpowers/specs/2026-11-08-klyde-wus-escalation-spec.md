# Klyde Escalation to WUS + Sanitized History — Design Spec

> **Status:** Design spec for review. No code until approved.

## 1. Intent

Add a refusal-based escalation tier to the AI router: when Mercury or Groq
**chooses not to answer** (returns a refusal), Klyde retries the question on
the WUS router (`uncensored/deepseek-v4.1-flash:free`). There an uncensored
answer is shown in the channel, it is **never persisted verbatim** into the
shared conversation history — so the main providers never ingest it.

## 2. Why

- Users may ask questions the safety-aligned providers refuse. The fallback
  chain today only advances on *technical* failures (HTTP/throw); a refusal is
  a successful completion, so WUS never gets a turn.
- A raw uncensored answer persisted verbatim pollutes the shared, per-channel
  history that Mercury/Groq read on later turns. That could cause follow-up
  refusals or normalize the uncensored boundary — unacceptable.
- Sanitizing the *stored* entry (Option 1) keeps history coherent while
  removing the raw payload.

## 3. Goals / Non-goals

**Goals**
- Detect when a provider's answer is a refusal.
- On refusal, advance to the next provider (Mercury → Groq → WUS → Workers AI).
- When WUS answers, show a visible `[uncensored answer]` tag in the channel
  reply, and persist a neutral placeholder in history.
- Keep the agent loop and tools unchanged.

**Non-goals**
- No guarantee of correctness — refusal detection is a heuristic.
- No per-user separation; history stays shared per channel.
- Normal (non-WUS) replies get **no** provider tag of any kind.
- No change to `/ask` flow or the Minecraft path (future).

## 4. Architecture

### 4.1 Refusal detection (heuristic)

New `isRefusal(message)` in `src/ai.js`. Examines the assistant message:

- If `message.tool_calls` exists → **not** a refusal (it's a tool round).
- If `message.content` is empty/null → treat as refusal (nothing to say).
- Else, regex-match content against a refusal-phrase list, e.g.:
  - `i can't help`, `i cannot help`, `cannot assist`, `can't assist`
  - `i'm unable`, `i am unable`, `not able to provide`, `cannot provide`
  - `i won't`, `won't help`, `i refuse`, `cannot discuss`, `can't discuss`
  - `as an ai language model`, `as an ai assistant`, `i'm an ai`

Matches are case-insensitive, substring-anchored. This is deliberately a
conservative list to limit false positives (a normal answer being mistaken for
a refusal).

### 4.2 Escalation in `callLLM`

`callLLM` already iterates `PROVIDERS` and advances on a thrown error. Add:

- After a provider returns a non-throwing `{ message }`, run `isRefusal`.
- If it is a refusal, **treat it like a failure for that provider**: record it
  in `failures` and continue to the next provider.
- If a provider returns a non-refusal (or tool_calls), return it as today.

Result: escalation happens entirely inside `callLLM`; callers (`agent.js`,
`generateReply`, summarize) are unchanged.

### 4.3 All providers refuse (D2)

If all providers refuse (or fail), return the **last non-empty response**
(the most recent real answer) instead of throwing. This surfaces a real
refusal rather than a generic error. If nothing non-empty exists, throw as
today.

### 4.4 Sanitized history (Option 1)

In `src/processor.js`, when building `assistantEntry`:

- If `aiRes.provider === "wus"`, store content as a neutral placeholder:
  `"[provided a direct answer]"`.
- Else store `aiRes.text` verbatim (unchanged behavior).

A `WUS_SANITIZED_PLACEHOLDER` constant documents the text.

### 4.5 Visible tag on WUS replies (channel only)

When `aiRes.provider === "wus"`, the **channel reply** is prefixed with a
visible tag (e.g. `[uncensored answer] `). This applies to what users see in
Discord only — the persisted history entry still uses the sanitized
placeholder (4.4). Normal (non-WUS) replies carry **no** tag.

## 5. Where each piece lives

| Change | File | Detail |
|---|---|---|
| Refusal detection | `src/ai.js` | `isRefusal(message)` exported; phrase list |
| Escalation | `src/ai.js` | `callLLM` checks `isRefusal`, advances on refusal |
| All-refused fallback | `src/ai.js` | return last non-empty response |
| Sanitized history | `src/processor.js` | `assistantEntry.content` = placeholder when provider is `wus` |
| Visible tag | `src/processor.js` | channel reply prefixed `[uncensored answer] ` when provider is `wus` |

## 6. Review Focus (failure modes tests must pin)

1. `isRefusal` returns true for a phrase-matched refusal, false for a normal
   answer, false for a tool-call message.
2. `callLLM`: Mercury refuses → Groq answers (no WUS call).
3. `callLLM`: Mercury refuses, Groq refuses → WUS answers.
4. `callLLM`: all refuse → returns the last non-empty response (does not
   throw).
5. `processor.js`: when provider is `wus`, history entry content is the
   placeholder, not the raw text; otherwise verbatim.
6. Non-WUS replies carry no tag; WUS channel replies carry `[uncensored answer]`.
7. Normal (non-refusal) path unchanged: Mercury answers, no escalation.

## 7. Open items (locked)

- Refusal heuristic starts conservative; can be tuned later.
- Escalation only triggers the WUS *provider tier*, not a change to the agent
  loop's tool budget.
- `isRefusal` applies to final text answers only (tool_calls exempt).

## 8. Definition of done

- 100+ tests green (new `isRefusal`, escalation, sanitized-history tests).
- Live: a question Mercury/Groq refuse gets answered by WUS; the reply shows
  in the channel, and the conversation history stores the placeholder.
- `/ask` and agent-loop tool behavior unchanged.
