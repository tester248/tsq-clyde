// Per-channel conversation state. One Durable Object instance per channel/guild key.

export class ConversationDO {
  constructor(stateObj, env) {
    this.stateObj = stateObj;
    this.state = {
      history: [],
      tokenCount: 0,
      modelUsage: {},
      memory: "",
      userProfiles: {}
    };
    // FTS5 session-search index (Phase 3). Best-effort: if SQL is
    // unavailable (fake/legacy storage), search reports a clean error but
    // appends still work.
    this.searchEnabled = false;
    const sql = stateObj.storage?.sql;
    if (sql && typeof sql.exec === "function") {
      try {
        sql.exec(
          "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(" +
            "content, role UNINDEXED, author UNINDEXED, ts UNINDEXED)"
        );
        this.searchEnabled = true;
      } catch (err) {
        console.error("fts init failed", err);
      }
    }
  }

  // rough token estimation based on character count
  static estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }

  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/initialize":
        await this.initialize();
        return new Response("ok");
      case "/append":
        return this.append(await request.json());
      case "/get":
        return new Response(JSON.stringify(this.state));
      case "/clear":
        this.state = {
          history: [],
          tokenCount: 0,
          modelUsage: {},
          memory: "",
          // User profiles are identity facts, not conversation state — they
          // survive a clear.
          userProfiles: this.state.userProfiles || {}
        };
        await this.stateObj.storage.put("state", this.state);
        return new Response("cleared");
      case "/setSummary": {
        const body = await request.json();
        await this.setSummary(body.summary);
        return new Response("ok");
      }
      case "/memoryGet":
        return new Response(JSON.stringify({ memory: this.state.memory || "" }));
      case "/setMemory": {
        const body = await request.json();
        this.state.memory = body.memory || "";
        await this.stateObj.storage.put("state", this.state);
        return new Response("ok");
      }
      case "/getUserProfile": {
        const userId = url.searchParams.get("userId");
        return new Response(
          JSON.stringify({ profile: this.state.userProfiles?.[userId] || "" })
        );
      }
      case "/setUserProfile": {
        const body = await request.json();
        this.state.userProfiles = this.state.userProfiles || {};
        this.state.userProfiles[body.userId] = body.profile;
        await this.stateObj.storage.put("state", this.state);
        return new Response("ok");
      }
      case "/recordUsage": {
        const body = await request.json();
        await this.recordUsage(body.model, body.tokens);
        return new Response("ok");
      }
      case "/searchMessages":
        return this.searchMessages(url);
      case "/searchEnabled":
        return new Response(JSON.stringify({ enabled: this.searchEnabled }));
      default:
        return new Response("not found", { status: 404 });
    }
  }

  async initialize() {
    const stored = await this.stateObj.storage.get("state");
    if (stored) {
      this.state = stored;
    }
    await this.backfillIndex();
  }

  async append(entry) {
    this.state.history.push(entry);
    this.state.tokenCount += ConversationDO.estimateTokens(entry.content);
    await this.stateObj.storage.put("state", this.state);
    await this.indexMessage(entry);
    return new Response("ok");
  }

  // Append-only FTS5 indexing. Best-effort: a failed index never fails the
  // message append.
  async indexMessage(entry) {
    if (!this.searchEnabled) return;
    const content = entry?.content;
    if (typeof content !== "string" || !content.trim()) return;
    try {
      await this.stateObj.storage.sql
        .prepare("INSERT INTO messages_fts(content, role, author, ts) VALUES (?, ?, ?, ?)")
        .bind(
          content,
          entry.role ?? "",
          entry.author?.name || entry.author?.id || "",
          entry.timestamp ?? Date.now()
        )
        .all();
    } catch (err) {
      console.error("fts index failed", err);
    }
  }

  // Seed the index from pre-existing history once. The raw history window is
  // rolling and compacted, so this makes older messages searchable retro-
  // actively without a migration.
  async backfillIndex() {
    if (!this.searchEnabled) return;
    if (!this.state.history?.length) return;
    try {
      const { results } = await this.stateObj.storage.sql
        .prepare("SELECT COUNT(*) AS n FROM messages_fts")
        .bind()
        .all();
      const n = results?.[0]?.n ?? 0;
      if (n > 0) return; // already seeded
      for (const h of this.state.history) {
        await this.indexMessage(h);
      }
    } catch (err) {
      console.error("fts backfill failed", err);
    }
  }

  async searchMessages(url) {
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (!this.searchEnabled) {
      return json({ error: "search unavailable" }, 503);
    }
    const rawQuery = url.searchParams.get("q") ?? "";
    const tokens = rawQuery
      .split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter(Boolean);
    if (tokens.length === 0) {
      return json({ error: "query must contain at least one word" }, 400);
    }
    // All-terms AND; tokens are stripped of FTS5 metacharacters so the
    // expression is safe to construct.
    const matchExpr = tokens.map((t) => `"${t}"`).join(" AND ");
    let limit = parseInt(url.searchParams.get("limit") ?? "", 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 5;
    limit = Math.min(10, Math.max(1, limit));
    try {
      const { results } = await this.stateObj.storage.sql
        .prepare(
          "SELECT rowid, role, author, ts, " +
            "snippet(messages_fts, 0, '[', ']', '…', 12) AS snip " +
            "FROM messages_fts WHERE messages_fts MATCH ? " +
            "ORDER BY bm25(messages_fts) LIMIT ?"
        )
        .bind(matchExpr, limit)
        .all();
      const rows = (results || []).map((r) => ({
        rowid: r.rowid,
        role: r.role,
        author: r.author,
        ts: r.ts,
        snippet: r.snip,
      }));
      return json({ results: rows });
    } catch (err) {
      return json({ error: `search failed: ${err?.message || err}` }, 500);
    }
  }

  async getState() {
    return this.state;
  }

  async setSummary(summary) {
    this.state.summary = summary;
    this.state.history = [];
    this.state.tokenCount = ConversationDO.estimateTokens(summary);
    await this.stateObj.storage.put("state", this.state);
  }

  async recordUsage(model, tokens) {
    const prev = this.state.modelUsage[model] || 0;
    this.state.modelUsage[model] = prev + tokens;
    await this.stateObj.storage.put("state", this.state);
  }
}
