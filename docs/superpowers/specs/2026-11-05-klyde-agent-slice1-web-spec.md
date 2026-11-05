# Klyde Agent — Slice 1: Web Access Tool Loop

> **Status:** Design spec for review. No code until approved.
> **Companion:** Implements the "agent, not API wrapper" goal. Architecture discussion in session (2026-11-05).

## 1. Intent

Turn Klyde from a single-shot LLM wrapper into an **agent that can pull fresh information on demand**. This slice delivers one concrete capability: when asked something that needs current or external knowledge (news, a recipe, a spec, a fact past the model's cutoff), Klyde searches the web, reads a page, and answers using that fetched material — with the LLM deciding *when* to fetch and *what* to fetch.

This is the first step of the broader Discord + Minecraft agent. It is deliberately **platform-agnostic** and the same loop will later serve Minecraft context (the Minecraft mod's RPC becomes another "tool" alongside web search).

## 2. Goals / Non-goals

**Goals**
- A `search` tool and a `fetch_url` tool callable by the LLM.
- A tool-loop that runs inside the existing Cloudflare worker/DO (no new infra).
- The user's *first-ping experience* is unchanged (fast, same pipeline); the agent loop happens *inside* the reply path.
- Keep using Mercury 3 as primary, with the existing Groq/Workers-AI fallback chain intact.
- Fail gracefully: if search/fetch fails, still answer from model knowledge (or say it couldn't fetch), never crash.

**Non-goals (explicitly out for this slice)**
- No Minecraft integration yet (that's later, and will reuse the same loop).
- No vector/RAG memory yet (Durable Objects + Vectorize come after web access).
- No per-player privacy/opt-out logic yet (Minecraft-specific; planned).
- No long-running async agent jobs; this is synchronous within a single reply.
- No autonomous background actions / persistent agent state beyond the existing conversation history.

## 3. Architecture

### 3.1 The tool loop (the core)

Current `processMessage` → `generateReply(messages, env)` does exactly one LLM call. The agent version becomes:

```
processMessage
  → build messages (existing history + prompt)
  → runAgentLoop(messages, env)
        loop (max N iterations):
          call LLM with messages + tool_definitions
          if response has no tool_calls: return it as the final answer
          else: for each tool_call:
                  execute tool (search / fetch_url)
                  append result as a "tool" message
                append the assistant's tool_calls message
                continue loop
```

The loop must be **bounded** (max iterations, total time budget) so a chatty model can't spin.

### 3.2 Tool definitions (OpenAI/OpenCode-compatible)

Passed to Mercury 3 in the request `tools` array:

| Tool | Input | Output |
|---|---|---|
| `search` | `{ query: string, num_results?: number }` | ranked results: `[{ title, url, snippet }]` |
| `fetch_url` | `{ url: string }` | page content as clean markdown/text, capped in size |

These mirror OpenCode's `websearch` + `webfetch` split exactly.

### 3.3 Provider selection — what I learned from OpenCode's source

From `sst/opencode` (verified via opensrc):
- OpenCode ships **five provider plugins** (exa, tavily, parallel, firecrawl, tinyfish).
- Each calls the **provider's hosted MCP endpoint** over HTTP JSON-RPC (`tools/call`), key passed as a query param.
- Provider selection is `"random"` or explicit; 429 triggers **cooldown** + retry with another provider.
- The key resolves from a stored credential or an env var.

**My recommendation for Klyde (differs from OpenCode deliberately):**
- Use a **plain REST API** for the search provider, not MCP-over-HTTP. Rationale: the worker already does `fetch`; REST is simpler, has first-class docs, and avoids re-implementing JSON-RPC/SSE decoding that OpenCode's `mcp.ts` has to do. The *loop pattern* is what we copy, not the transport.
- **Tavily** as the first provider: simple `POST /search`, returns `results[].{title,url,content}`, has a free tier, key is a single secret. (Exa is the fallback if you prefer a key you already hold — but Tavily's output shape fits the tool schema most directly.)
- Keep a **search-provider abstraction** so swapping provider = one config value + one function, exactly like OpenCode's plugin registry.

### 3.4 Code structure (within existing repo)

- `src/tools.js` — tool registry + implementations (`search`, `fetch_url`). Each returns a plain object; errors wrapped so the loop can decide (fail tool → tell model, don't abort).
- `src/agent.js` — `runAgentLoop(messages, env, tools)`: the bounded loop. Uses `generateReply` internally for the LLM call but richer (passes `tools`, reads `tool_calls`, traces).
- `src/ai.js` — unchanged for the provider fallback chain; expose `tools` support in `openAiCompletion` (pass through `tools` field).
- `src/processor.js` — call `runAgentLoop` instead of `generateReply` in the normal reply path. **Summarization stays single-shot** (no tools).

### 3.5 Config & secrets

- `wrangler.jsonc`: add `SEARCH_PROVIDER` var (default `"tavily"`), and reference the secret.
- New secret: `TAVILY_API_KEY` (or `EXA_API_KEY`) via `wrangler secret put` — never committed.

### 3.6 Timeouts & safety

- Per-LLM-call timeout: reuse existing 25s.
- Tool execution timeout: ~15s each.
- **Loop budget:** max 6 iterations AND max ~45s total, whichever first.
- `fetch_url`: cap response at ~64KB text; only http/https; follow up to 3 redirects; strip HTML to text (or use `text` mode).

## 4. Review Focus (failure modes the tests must pin)

1. Model asks to search → tool executes → result is fed back → final answer uses it. (The happy path proves the loop is real, not a wrapper.)
2. Model calls no tool → loop returns immediately (no extra LLM calls, no latency hit for normal messages).
3. Tool throws (provider 429 / network) → the loop tells the model the tool failed and *still returns a final answer* from available knowledge, rather than crashing or hanging.
4. Loop hits its iteration/time budget → terminates with the best answer so far plus a note.
5. `fetch_url` on a non-HTTP URL or oversized page → rejected gracefully.

## 5. Open questions for you (before I write the plan)

1. **Provider:** Tavily (recommended, cleanest REST shape) or Exa (you hold a key already)? I lean Tavily.
2. **Tool budget:** is `max 6 iterations / ~45s` acceptable, or do you want tighter/looser?
3. **Feedback in chat:** for a slow multi-tool run, do you want an interim "searching…" message in the channel before the final answer (recommended, matches your earlier "working on it" idea)? This touches the gateway's `waitUntil` flow.

## 6. Definition of done (acceptance)

- `npm test` green (unit tests for the loop + tools).
- Live test: ping Klyde with a post-cutoff question (e.g. *"what did Minecraft's latest update add?"*), and it returns a **cited, current** answer — proof the loop retrieved real info rather than answering from memory.
- Normal messages still respond immediately with no tool call (no regression in latency).
