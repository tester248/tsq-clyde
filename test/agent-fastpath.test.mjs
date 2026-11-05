import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shouldUseAgentTools } from "../src/agent.js";

describe("shouldUseAgentTools (fast-path heuristic)", () => {
  it("skips tools for greetings and trivial pings", () => {
    assert.equal(shouldUseAgentTools("whats up"), false);
    assert.equal(shouldUseAgentTools("what's up"), false);
    assert.equal(shouldUseAgentTools("hey"), false);
    assert.equal(shouldUseAgentTools("hello"), false);
    assert.equal(shouldUseAgentTools("hmm"), false);
  });

  it("uses tools for information-seeking questions", () => {
    assert.equal(shouldUseAgentTools("what did the latest Minecraft update add?"), true);
    assert.equal(shouldUseAgentTools("how do I revive my horse in icy's mod?"), true);
    assert.equal(shouldUseAgentTools("tell me about the 26.3 update"), true);
  });

  it("uses tools for multi-word informational prompts", () => {
    assert.equal(shouldUseAgentTools("what's new in minecraft lately"), true);
    assert.equal(shouldUseAgentTools("find the midterm results"), true);
  });

  it("handles empty input safely", () => {
    assert.equal(shouldUseAgentTools(""), false);
    assert.equal(shouldUseAgentTools("   "), false);
  });
});
