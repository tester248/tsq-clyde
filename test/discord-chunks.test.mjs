import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { splitIntoChunks, sendChannelMessage } from "../src/discord.js";

describe("splitIntoChunks", () => {
  it("returns the input unchanged when under the limit", () => {
    const out = splitIntoChunks("short");
    assert.deepEqual(out, ["short"]);
  });

  it("splits long text into chunks each within the limit", () => {
    const long = "A".repeat(5000);
    const out = splitIntoChunks(long, 1900);
    for (const c of out) {
      assert.ok(c.length <= 1900, `chunk too long: ${c.length}`);
    }
    // total content preserved
    assert.equal(out.join("").length, 5000);
  });

  it("preserves total content across chunks", () => {
    const text = "The quick brown fox. ".repeat(200); // ~3800 chars
    const out = splitIntoChunks(text, 1900);
    assert.equal(out.join("").replace(/\s+/g, " ").trim(), text.replace(/\s+/g, " ").trim());
  });

  it("tries to break on paragraph/word boundaries, not mid-word", () => {
    const text = "word ".repeat(1000); // 5000 chars, spaces every 5
    const out = splitIntoChunks(text, 1900);
    for (const c of out) {
      // each chunk except the last should end on a space boundary
      if (c !== out[out.length - 1]) {
        assert.ok(c.endsWith(" "), `chunk does not end on a boundary: ${c.slice(-5)}`);
      }
    }
  });

  it("handles empty and non-string input", () => {
    assert.deepEqual(splitIntoChunks(""), []);
    assert.deepEqual(splitIntoChunks(undefined), []);
    assert.deepEqual(splitIntoChunks(null), []);
  });
});

describe("sendChannelMessage chunking", () => {
  it("posts one request per chunk in order", async () => {
    const realFetch = globalThis.fetch;
    const posts = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("discord.com/api")) {
        posts.push(JSON.parse(init.body).content);
        return new Response(JSON.stringify({ id: "m" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    try {
      const long = "B".repeat(5000);
      await sendChannelMessage("C1", long, { DISCORD_TOKEN: "t" });
      assert.ok(posts.length > 1, "expected multiple messages");
      for (const p of posts) assert.ok(p.length <= 1900);
      assert.equal(posts.join("").length, 5000);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
