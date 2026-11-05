import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shouldUseAgentTools, runAgentLoop } from "../src/agent.js";

// Minimal controllable LLM: scripted responses.
function scriptedLlm(script) {
  let i = 0;
  return async (messages, env, opts) => {
    const step = script[Math.min(i, script.length - 1)];
    i++;
    if (step.tool) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: `c${i}`, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } },
          ],
        },
        provider: "inception",
        tokens: 1,
      };
    }
    return { message: { role: "assistant", content: step.content }, provider: "inception", tokens: 1 };
  };
}

const okTool = {
  search: async () => ({ results: [{ title: "x", url: "u", snippet: "s" }] }),
  fetch_url: async () => ({ text: "body" }),
};
const executeOk = (name, args) => (okTool[name] ? okTool[name](args) : { error: "unknown" });

describe("runAgentLoop phase events", () => {
  it("emits search and compose phases in order for a single tool run", async () => {
    const llm = scriptedLlm([
      { tool: { name: "search", args: { query: "q" } } },
      { content: "answer" },
    ]);
    const phases = [];
    await runAgentLoop({
      messages: [{ role: "user", content: "q?" }],
      env: {},
      llm,
      executeTool: executeOk,
      onPhase: (p) => phases.push(p),
    });
    assert.ok(phases.includes("search"), `expected search phase, got ${phases}`);
    assert.ok(phases.includes("compose"), `expected compose phase, got ${phases}`);
    assert.ok(phases.indexOf("search") < phases.indexOf("compose"));
  });

  it("emits fetch phase when fetch_url runs", async () => {
    const llm = scriptedLlm([
      { tool: { name: "fetch_url", args: { url: "https://x" } } },
      { content: "answer" },
    ]);
    const phases = [];
    await runAgentLoop({
      messages: [{ role: "user", content: "q?" }],
      env: {},
      llm,
      executeTool: executeOk,
      onPhase: (p) => phases.push(p),
    });
    assert.ok(phases.includes("fetch"));
  });

  it("does not emit compose when no tool is used", async () => {
    const llm = scriptedLlm([{ content: "plain" }]);
    const phases = [];
    await runAgentLoop({
      messages: [{ role: "user", content: "q?" }],
      env: {},
      llm,
      executeTool: executeOk,
      onPhase: (p) => phases.push(p),
    });
    assert.ok(!phases.includes("compose"));
  });
});
