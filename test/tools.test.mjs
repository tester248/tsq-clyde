import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AGENT_TOOLS, executeTool } from "../src/tools.js";

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
  SEARCH_PROVIDER: "tavily",
  ...overrides,
});

describe("agent tools", () => {
  it("AGENT_TOOLS declares search and fetch_url", () => {
    const names = AGENT_TOOLS.map((t) => t.function.name);
    assert.deepEqual(names.sort(), ["fetch_url", "search"]);
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

  it("executeTool returns { error } for an unknown tool", async () => {
    const out = await executeTool("does_not_exist", {}, makeEnv());
    assert.ok(out.error);
  });
});
