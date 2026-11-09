import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AGENT_TOOLS, executeTool, MEMORY_CHANNEL_LIMIT, MEMORY_USER_LIMIT } from "../src/tools.js";

function mockFetch(routes) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    for (const [match, handler] of routes) {
      if (u.includes(match)) {
        return handler(calls.length - 1);
      }
    }
    return new Response("unexpected fetch", { status: 500 });
  };
  return { realFetch, calls };
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

const makeEnv = (overrides = {}) => ({
  TAVILY_API_KEY: "tavily-key",
  SEARCH_PROVIDER: "tavily,exa",
  ...overrides,
});

describe("agent tools", () => {
  it("AGENT_TOOLS declares search, fetch_url, and memory", () => {
    const names = AGENT_TOOLS.map((t) => t.function.name);
    assert.deepEqual(names.sort(), ["fetch_url", "memory", "search"]);
  });

  it("search calls Tavily with the key header and maps results", async () => {
    const { realFetch, calls } = mockFetch([
      [
        "api.tavily.com/search",
        () =>
          json({
            results: [
              { title: "T", url: "https://x", content: "snippet" },
              { title: "T2", url: "https://y", content: "snippet2" },
            ],
          }),
      ],
    ]);
    try {
      const out = await executeTool("search", { query: "mc", num_results: 2 }, makeEnv());
      assert.ok(Array.isArray(out.results));
      assert.equal(out.results.length, 2);
      assert.deepEqual(out.results[0], { title: "T", url: "https://x", snippet: "snippet" });
      const req = calls[0];
      assert.ok(req.url.includes("api.tavily.com/search"));
      assert.equal(req.init.headers.Authorization, "Bearer tavily-key");
      const body = JSON.parse(req.init.body);
      assert.equal(body.query, "mc");
      assert.equal(body.max_results, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("search returns { error } on 429 rather than throwing", async () => {
    const { realFetch } = mockFetch([
      ["api.tavily.com/search", () => new Response("rate limited", { status: 429 })],
    ]);
    try {
      const out = await executeTool("search", { query: "mc" }, makeEnv());
      assert.ok(out.error);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("fetch_url returns stripped text for a normal page", async () => {
    const { realFetch } = mockFetch([
      ["https://example.com", () => new Response("<html><script>x</script><body><h1>Hello</h1><p>World</p></body></html>")],
    ]);
    try {
      const out = await executeTool("fetch_url", { url: "https://example.com" }, makeEnv());
      assert.ok(out.text.includes("Hello"));
      assert.ok(!out.text.includes("<h1>"));
      assert.ok(!out.text.includes("x</script>"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("fetch_url rejects non-http(s) URLs", async () => {
    const out = await executeTool("fetch_url", { url: "javascript:alert(1)" }, makeEnv());
    assert.ok(out.error);
  });

  it("fetch_url returns { error } for an oversized body", async () => {
    const big = "a".repeat(70 * 1024);
    const { realFetch } = mockFetch([
      ["https://big.example", () => new Response(big)],
    ]);
    try {
      const out = await executeTool("fetch_url", { url: "https://big.example" }, makeEnv());
      assert.ok(out.error);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("search falls back to Exa when Tavily fails", async () => {
    const { realFetch, calls } = mockFetch([
      ["api.tavily.com/search", () => new Response("rate limited", { status: 429 })],
      [
        "api.exa.ai/search",
        () =>
          json({
            results: [
              { title: "E", url: "https://e", highlights: ["exa snippet"] },
              { title: "E2", url: "https://e2", highlights: ["exa snippet2"] },
            ],
          }),
      ],
    ]);
    try {
      const out = await executeTool("search", { query: "mc", num_results: 2 }, makeEnv({ EXA_API_KEY: "exa-key" }));
      assert.ok(Array.isArray(out.results));
      assert.equal(out.results.length, 2);
      assert.equal(out.results[0].snippet, "exa snippet");
      const exaReq = calls.find((c) => c.url.includes("api.exa.ai/search"));
      assert.ok(exaReq, "expected an Exa search call");
      assert.equal(exaReq.init.headers.Authorization, "Bearer exa-key");
      const body = JSON.parse(exaReq.init.body);
      assert.equal(body.query, "mc");
      assert.equal(body.numResults, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("search uses Ena first when SEARCH_PROVIDER order is exa,tavily", async () => {
    const { realFetch, calls } = mockFetch([
      ["api.exa.ai/search", () => json({ results: [{ title: "E", url: "https://e", highlights: ["x"] }] })],
    ]);
    try {
      const env = makeEnv({ EXA_API_KEY: "exa-key", SEARCH_PROVIDER: "exa,tavily" });
      const out = await executeTool("search", { query: "mc" }, env);
      assert.equal(out.results.length, 1);
      const exaReq = calls.find((c) => c.url.includes("api.exa.ai/search"));
      assert.ok(exaReq, "expected Exa to be tried first");
      const tavilyReq = calls.find((c) => c.url.includes("api.tavily.com"));
      assert.equal(tavilyReq, undefined, "Tavily should not have been called when Exa succeeded");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("search returns an error when all providers fail", async () => {
    const { realFetch } = mockFetch([
      ["api.tavily.com/search", () => new Response("rate limited", { status: 429 })],
      ["api.exa.ai/search", () => new Response("boom", { status: 500 })],
    ]);
    try {
      const out = await executeTool("search", { query: "mc" }, makeEnv({ EXA_API_KEY: "exa-key" }));
      assert.ok(out.error, "expected an error when all providers fail");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("search skips Exa when EXA_API_KEY is missing", async () => {
    const { realFetch, calls } = mockFetch([
      ["api.tavily.com/search", () => json({ results: [{ title: "T", url: "https://t", content: "s" }] })],
    ]);
    try {
      const env = makeEnv(); // no EXA_API_KEY
      const out = await executeTool("search", { query: "mc" }, env);
      assert.equal(out.results.length, 1);
      const exaReq = calls.find((c) => c.url.includes("api.exa.ai"));
      assert.equal(exaReq, undefined, "Exa should be skipped without a key");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// In-memory fake of the ConversationDO memory/profile routes, so the memory
// tool can be tested without a real DO.
function makeMemoryEnv({ memory = "", profiles = {}, currentUser = "U1" } = {}) {
  const state = { memory, userProfiles: { ...profiles } };
  const stub = {
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      if (u.pathname === "/memoryGet") return Response.json({ memory: state.memory });
      if (u.pathname === "/setMemory") {
        state.memory = JSON.parse(init.body).memory;
        return new Response("ok");
      }
      if (u.pathname === "/getUserProfile") {
        return Response.json({ profile: state.userProfiles[u.searchParams.get("userId")] || "" });
      }
      if (u.pathname === "/setUserProfile") {
        const body = JSON.parse(init.body);
        state.userProfiles[body.userId] = body.profile;
        return new Response("ok");
      }
      return new Response("not found", { status: 404 });
    },
  };
  return { env: { CONVERSATION_STUB: stub, CURRENT_USER_ID: currentUser }, state };
}

describe("memory tool", () => {
  it("add appends a channel memory entry", async () => {
    const { env, state } = makeMemoryEnv();
    const out = await executeTool("memory", { target: "memory", operations: [{ action: "add", content: "the server uses ports 3000-3005" }] }, env);
    assert.equal(out.success, true);
    assert.ok(state.memory.includes("the server uses ports 3000-3005"));
  });

  it("skips an exact duplicate add", async () => {
    const { env, state } = makeMemoryEnv({ memory: "fact one § fact two" });
    const out = await executeTool("memory", { target: "memory", operations: [{ action: "add", content: "fact one" }] }, env);
    assert.equal(out.success, true);
    assert.match(out.note, /no duplicate/i);
    assert.equal(state.memory, "fact one § fact two");
  });

  it("patch replaces a unique substring within an entry", async () => {
    const { env, state } = makeMemoryEnv({ memory: "user prefers terse replies § uses linux" });
    const out = await executeTool("memory", {
      target: "memory",
      operations: [{ action: "patch", old_text: "terse replies", content: "terse dot-points" }],
    }, env);
    assert.equal(out.success, true);
    assert.ok(state.memory.includes("user prefers terse dot-points"));
    assert.ok(state.memory.includes("uses linux"));
  });

  it("patch with ambiguous old_text returns an error listing candidates", async () => {
    const { env, state } = makeMemoryEnv({ memory: "fact one § fact one again" });
    const out = await executeTool("memory", {
      target: "memory",
      operations: [{ action: "patch", old_text: "fact", content: "fact" }],
    }, env);
    assert.equal(out.success, false);
    assert.ok(out.error);
    assert.ok(out.current_entries || out.closest_entries);
    assert.equal(state.memory, "fact one § fact one again", "no change on ambiguity");
  });

  it("remove deletes the entry containing the unique substring", async () => {
    const { env, state } = makeMemoryEnv({ memory: "fact one § fact two § fact three" });
    const out = await executeTool("memory", { target: "memory", operations: [{ action: "remove", old_text: "fact two" }] }, env);
    assert.equal(out.success, true);
    assert.ok(!state.memory.includes("fact two"));
    assert.ok(state.memory.includes("fact one"));
    assert.ok(state.memory.includes("fact three"));
  });

  it("returns a consolidation error when an add would exceed the channel cap", async () => {
    const { env, state } = makeMemoryEnv();
    const huge = "x".repeat(MEMORY_CHANNEL_LIMIT); // exactly at cap
    state.memory = huge;
    const out = await executeTool("memory", {
      target: "memory",
      operations: [{ action: "add", content: "new fact" }],
    }, env);
    assert.equal(out.success, false);
    assert.ok(out.error.includes("limit"));
    assert.ok(out.current_entries);
    assert.ok(out.current_size > 0);
  });

  it("rejects content containing invisible unicode / control characters", async () => {
    const { env, state } = makeMemoryEnv();
    const out = await executeTool("memory", {
      target: "memory",
      operations: [{ action: "add", content: "evil \u200b fact" }],
    }, env);
    assert.equal(out.success, false);
    assert.ok(out.error);
    assert.equal(state.memory, "");
  });

  it("rejects unknown actions", async () => {
    const { env } = makeMemoryEnv();
    const out = await executeTool("memory", { target: "memory", operations: [{ action: "nuke", content: "x" }] }, env);
    assert.equal(out.success, false);
    assert.ok(out.error);
  });

  it("target user writes to the current asker's profile", async () => {
    const { env, state } = makeMemoryEnv({ currentUser: "U42" });
    const out = await executeTool("memory", {
      target: "user",
      operations: [{ action: "add", content: "prefers metric units" }],
    }, env);
    assert.equal(out.success, true);
    assert.equal(state.userProfiles.U42, "prefers metric units");
    assert.equal(state.userProfiles.U1, undefined);
  });

  it("respects the user profile cap", async () => {
    const { env } = makeMemoryEnv({ currentUser: "U1" });
    const huge = "y".repeat(MEMORY_USER_LIMIT + 1); // overflow by 1
    const out = await executeTool("memory", {
      target: "user",
      operations: [{ action: "add", content: huge }],
    }, env);
    assert.equal(out.success, false);
    assert.ok(out.error.includes("limit"));
  });
});
