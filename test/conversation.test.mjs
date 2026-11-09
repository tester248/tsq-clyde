import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ConversationDO } from "../src/conversation_do.js";

function makeConvo() {
  const mem = new Map();
  return new ConversationDO({
    storage: {
      get: async (k) => mem.get(k) ?? null,
      put: async (k, v) => void mem.set(k, v),
    },
  }, {});
}

const call = (convo, path, opts) => convo.fetch(new Request(`https://example.com${path}`, opts));

describe("ConversationDO", () => {
  it("appends entries and tracks token estimates", async () => {
    const convo = makeConvo();
    await call(convo, "/initialize");
    await call(convo, "/append", {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "hello world" }),
    });
    const state = await (await call(convo, "/get")).json();
    assert.equal(state.history.length, 1);
    assert.equal(state.tokenCount, Math.ceil("hello world".length / 4));
  });

  it("records per-model token usage", async () => {
    const convo = makeConvo();
    await call(convo, "/recordUsage", {
      method: "POST",
      body: JSON.stringify({ model: "m", tokens: 10 }),
    });
    const state = await (await call(convo, "/get")).json();
    assert.equal(state.modelUsage.m, 10);
  });

  it("setSummary replaces history with the summary", async () => {
    const convo = makeConvo();
    await call(convo, "/append", {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "some chatter" }),
    });
    await call(convo, "/setSummary", {
      method: "POST",
      body: JSON.stringify({ summary: "greeted" }),
    });
    const state = await (await call(convo, "/get")).json();
    assert.equal(state.history.length, 0);
    assert.equal(state.summary, "greeted");
  });

  it("clear resets history, memory, and usage but keeps user profiles", async () => {
    const convo = makeConvo();
    await call(convo, "/append", {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "x" }),
    });
    await call(convo, "/setMemory", {
      method: "POST",
      body: JSON.stringify({ memory: "channel notes" }),
    });
    await call(convo, "/setUserProfile", {
      method: "POST",
      body: JSON.stringify({ userId: "U1", profile: "prefers terse" }),
    });
    assert.equal(await (await call(convo, "/clear")).text(), "cleared");
    const state = await (await call(convo, "/get")).json();
    assert.deepEqual(state, {
      history: [],
      tokenCount: 0,
      modelUsage: {},
      memory: "",
      userProfiles: { U1: "prefers terse" },
    });
  });

  it("stores and persists channel memory across initialize", async () => {
    const convo = makeConvo();
    await call(convo, "/setMemory", {
      method: "POST",
      body: JSON.stringify({ memory: "this server runs on ports 3000-3005" }),
    });
    const state = await (await call(convo, "/get")).json();
    assert.equal(state.memory, "this server runs on ports 3000-3005");

    // eviction round-trip: fresh instance, same storage
    await call(convo, "/initialize"); // reloads from storage
    const reloaded = await (await call(convo, "/get")).json();
    assert.equal(reloaded.memory, "this server runs on ports 3000-3005");
  });

  it("stores and persists user profiles across initialize", async () => {
    const convo = makeConvo();
    await call(convo, "/setUserProfile", {
      method: "POST",
      body: JSON.stringify({ userId: "U1", profile: "likes short answers" }),
    });
    await call(convo, "/setUserProfile", {
      method: "POST",
      body: JSON.stringify({ userId: "U2", profile: "wants detail" }),
    });
    await call(convo, "/initialize");
    const state = await (await call(convo, "/get")).json();
    assert.equal(state.userProfiles.U1, "likes short answers");
    assert.equal(state.userProfiles.U2, "wants detail");
  });

  it("memoryGet and getUserProfile return the stored values", async () => {
    const convo = makeConvo();
    await call(convo, "/setMemory", {
      method: "POST",
      body: JSON.stringify({ memory: "notes" }),
    });
    await call(convo, "/setUserProfile", {
      method: "POST",
      body: JSON.stringify({ userId: "U1", profile: "p" }),
    });
    const mem = await (await call(convo, "/memoryGet")).json();
    assert.equal(mem.memory, "notes");
    const prof = await (await call(convo, "/getUserProfile?userId=U1")).json();
    assert.equal(prof.profile, "p");
    const missing = await (await call(convo, "/getUserProfile?userId=U9")).json();
    assert.equal(missing.profile, "");
  });

  it("unknown routes 404", async () => {
    const convo = makeConvo();
    assert.equal((await call(convo, "/nope")).status, 404);
  });
});

// ---- session search ----

// Minimal fake of the DO SQLite API subset we use: prepare().bind().all()
// with a crude FTS-ish token matcher. Good enough to pin our routing,
// sanitization, and lifecycle logic; real FTS5 is exercised at deploy time.
function makeSearchConvo(seedState = null) {
  const mem = new Map();
  if (seedState) mem.set("state", seedState);
  const rows = []; // { rowid, role, author, ts, content }
  let nextRowid = 1;

  function sanitize(query) {
    return String(query || "")
      .split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter(Boolean);
  }

  const sql = {
    exec() {}, // CREATE VIRTUAL TABLE — fake treats table as always present
    prepare(statement) {
      return {
        bind(...args) {
          return {
            all: async () => {
              if (statement.includes("COUNT(*)")) {
                return { results: [{ n: rows.length }] };
              }
              if (statement.includes("INSERT INTO")) {
                const [content, role, author, ts] = args;
                rows.push({ rowid: nextRowid++, role, author, ts, content });
                return { results: [] };
              }
              const query = args[0];
              const limit = args[1] ?? 5;
              // Production passes a pre-built FTS5 match expression like
              // `"auth" AND "rotate"` — parse the quoted terms.
              const quoted = [...String(query).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
              const tokens = quoted.length > 0 ? quoted : sanitize(query);
              const scored = rows
                .map((r) => {
                  const hits = tokens.filter((t) => r.content.toLowerCase().includes(t.toLowerCase()));
                  return { r, hits };
                })
                .filter((x) => x.hits.length === tokens.length)
                .sort((a, b) => b.r.rowid - a.r.rowid)
                .slice(0, limit);
              return {
                results: scored.map(({ r, hits }) => {
                  const t0 = hits[0].toLowerCase();
                  const idx = r.content.toLowerCase().indexOf(t0);
                  const start = Math.max(0, idx - 40);
                  const before = start > 0 ? "…" : "";
                  const after = start + 80 < r.content.length ? "…" : "";
                  const snip = `${before}${r.content.slice(start, start + 80)}${after}`;
                  return { rowid: r.rowid, role: r.role, author: r.author, ts: r.ts, snip };
                }),
              };
            },
          };
        },
      };
    },
  };

  const storage = {
    get: async (k) => mem.get(k) ?? null,
    put: async (k, v) => void mem.set(k, v),
    sql,
  };

  const convo = new ConversationDO({ storage }, {});
  // expose the fake row store for assertions
  convo._rows = rows;
  convo._appendRow = (entry) => {
    rows.push({
      rowid: nextRowid++,
      role: entry.role,
      author: entry.author?.name || entry.author?.id || "",
      ts: entry.timestamp ?? 0,
      content: entry.content,
    });
  };
  return { convo, rows, mem };
}

describe("ConversationDO session search", () => {
  it("indexes appends and finds them via /searchMessages", async () => {
    const { convo, rows } = makeSearchConvo();
    await call(convo, "/initialize");
    await call(convo, "/append", {
      method: "POST",
      body: JSON.stringify({
        role: "user",
        content: "we discussed deploy windows on fridays",
        author: { name: "Alice", id: "U1" },
        timestamp: 1000,
      }),
    });
    await call(convo, "/append", {
      method: "POST",
      body: JSON.stringify({ role: "assistant", content: "ok, noted", timestamp: 2000 }),
    });
    assert.equal(rows.length, 2);

    const res = await call(convo, "/searchMessages?q=deploy");
    const body = await res.json();
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].author, "Alice");
    assert.equal(body.results[0].ts, 1000);
    assert.ok(body.results[0].snippet.includes("deploy"));
  });

  it("sanitizes FTS5 metacharacters and matches all terms (AND)", async () => {
    const { convo } = makeSearchConvo();
    await call(convo, "/initialize");
    await call(convo, "/append", {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "auth token *() must rotate", timestamp: 1 }),
    });
    await call(convo, "/append", {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "token rotation is monthly", timestamp: 2 }),
    });

    const evil = await (await call(convo, "/searchMessages?q=token%20*%22%28")).json();
    assert.equal(evil.results.length, 2);

    const both = await (await call(convo, "/searchMessages?q=auth%20rotate")).json();
    assert.equal(both.results.length, 1);

    const missing = await (await call(convo, "/searchMessages?q=auth%20neverever")).json();
    assert.equal(missing.results.length, 0);
  });

  it("rejects empty queries", async () => {
    const { convo } = makeSearchConvo();
    const res = await call(convo, "/searchMessages?q=%20%20%21%21");
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });

  it("clamps limit to 1..10 with default 5", async () => {
    const { convo } = makeSearchConvo();
    await call(convo, "/initialize");
    for (let i = 0; i < 12; i++) {
      await call(convo, "/append", {
        method: "POST",
        body: JSON.stringify({ role: "user", content: `shared term entry ${i}`, timestamp: i }),
      });
    }
    const capped = await (await call(convo, "/searchMessages?q=shared&limit=99")).json();
    assert.equal(capped.results.length, 10);
    const deflt = await (await call(convo, "/searchMessages?q=shared")).json();
    assert.equal(deflt.results.length, 5);
    const one = await (await call(convo, "/searchMessages?q=shared&limit=1")).json();
    assert.equal(one.results.length, 1);
  });

  it("backfills pre-existing history exactly once on initialize", async () => {
    const seed = {
      history: [
        { role: "user", content: "old fact about tunnels", timestamp: 1 },
        { role: "assistant", content: "tunnels need maintenance", timestamp: 2 },
      ],
      tokenCount: 10,
      modelUsage: {},
      memory: "",
      userProfiles: {},
    };
    const { convo, rows } = makeSearchConvo(seed);
    await call(convo, "/initialize");
    assert.equal(rows.length, 2);

    // a second initialize (eviction round-trip) must not duplicate
    await call(convo, "/initialize");
    assert.equal(rows.length, 2);

    const res = await (await call(convo, "/searchMessages?q=tunnels")).json();
    assert.equal(res.results.length, 2);
  });

  it("keeps the index across compaction (setSummary)", async () => {
    const { convo } = makeSearchConvo();
    await call(convo, "/initialize");
    await call(convo, "/append", {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "the deploy checklist lives in skills", timestamp: 1 }),
    });
    await call(convo, "/setSummary", {
      method: "POST",
      body: JSON.stringify({ summary: "deploy checklist" }),
    });
    const res = await (await call(convo, "/searchMessages?q=checklist")).json();
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].content, undefined); // snippet only, no raw content
  });

  it("keeps the index across /clear (archive semantics)", async () => {
    const { convo } = makeSearchConvo();
    await call(convo, "/initialize");
    await call(convo, "/append", {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "discussed the kafka migration", timestamp: 1 }),
    });
    await call(convo, "/clear");
    const state = await (await call(convo, "/get")).json();
    assert.equal(state.history.length, 0);
    const res = await (await call(convo, "/searchMessages?q=kafka")).json();
    assert.equal(res.results.length, 1);
  });

  it("returns a clean error when SQL is unavailable, and appends still work", async () => {
    const convo = makeConvo(); // no sql
    await call(convo, "/initialize");
    await call(convo, "/append", {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "hello" }),
    });
    const res = await call(convo, "/searchMessages?q=hello");
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.ok(body.error);
    const state = await (await call(convo, "/get")).json();
    assert.equal(state.history.length, 1);
  });
});
