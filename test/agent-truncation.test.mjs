import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runAgentLoop } from "../src/agent.js";

// An LLM that emits narration text ALONGSIDE a tool call (common when the
// model narrates what it's about to do), then keeps calling tools until the
// iteration budget is exhausted. This reproduces the "hangs on a follow-up
// promise" bug: the narration must NOT be returned as the final answer.
function narrationThenLoopLlm() {
  let i = 0;
  return async (messages, env, opts) => {
    i++;
    return {
      message: {
        role: "assistant",
        content: "Let me try to pull the subscriber count.",
        tool_calls: [
          {
            id: `c${i}`,
            type: "function",
            function: { name: "fetch_url", arguments: JSON.stringify({ url: "https://youtube.com/CyberCraft" }) },
          },
        ],
      },
      provider: "inception",
      tokens: 1,
    };
  };
}

const executeOk = async (name) => ({ text: "channel page" });

describe("tool-loop truncation", () => {
  it("does not return narration text as the final answer when truncated", async () => {
    const llm = narrationThenLoopLlm();
    const out = await runAgentLoop({
      messages: [{ role: "user", content: "how many subscribers?" }],
      env: {},
      llm,
      executeTool: executeOk,
      maxIterations: 3,
    });
    assert.equal(out.truncated, true);
    // Must NOT latch onto the "Let me try..." narration.
    assert.ok(!out.text.includes("Let me try to pull"), `got narration: ${out.text}`);
  });

  it("emits compose only when a real answer is returned, not before further tools", async () => {
    const phases = [];
    // Real script: narration+tool, then a genuine final answer.
    let calls = 0;
    const llm = async (messages, env, opts) => {
      calls++;
      if (calls === 1) {
        return {
          message: {
            role: "assistant",
            content: "Let me look that up.",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "fetch_url", arguments: JSON.stringify({ url: "https://x" }) },
              },
            ],
          },
          provider: "inception",
          tokens: 1,
        };
      }
      return { message: { role: "assistant", content: "42 subscribers." }, provider: "inception", tokens: 1 };
    };
    const out = await runAgentLoop({
      messages: [{ role: "user", content: "q" }],
      env: {},
      llm,
      executeTool: executeOk,
      onPhase: (p) => phases.push(p),
      maxIterations: 3,
    });
    assert.equal(out.text, "42 subscribers.");
    assert.equal(out.truncated, false);
    // compose appears only after the final answer, not before the tool round.
    assert.ok(phases.includes("compose"));
    assert.ok(phases.includes("fetch"));
    assert.ok(phases.indexOf("fetch") < phases.indexOf("compose"));
  });
});
