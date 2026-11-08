import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runAgentLoop } from "../src/agent.js";

// A controllable fake LLM. The driver decides the scripted sequence of
// responses. Each entry is either { content } (final answer) or a tool call.
function makeFakeLlm(script) {
  let calls = 0;
  const seenMessages = [];
  const llm = async (messages, env, opts) => {
    seenMessages.push({ messages, opts });
    const step = script[Math.min(calls, script.length - 1)];
    calls++;
    if (step.tool) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: `call_${calls}`, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } },
          ],
        },
        provider: "inception",
        tokens: 1,
      };
    }
    return {
      message: { role: "assistant", content: step.content },
      provider: "inception",
      tokens: 1,
    };
  };
  return { llm, seenMessages, getCalls: () => calls };
}

const fakeTools = {
  search: async (args) => ({ results: [{ title: "X", url: "u", snippet: "s" }] }),
  fetch_url: async (args) => ({ text: "page text" }),
};
const executeFake = (name, args) => (fakeTools[name] ? fakeTools[name](args) : { error: "unknown" });

const env = {};

describe("runAgentLoop", () => {
  it("returns immediately when the model makes no tool call", async () => {
    const { llm, seenMessages, getCalls } = makeFakeLlm([{ content: "hi" }]);
    const out = await runAgentLoop({ messages: [{ role: "user", content: "hi" }], env, llm, executeTool: executeFake });
    assert.equal(out.text, "hi");
    assert.equal(out.truncated, false);
    assert.equal(getCalls(), 1);
    assert.equal(seenMessages.length, 1);
  });

  it("executes a tool, feeds the result back, then returns the final answer", async () => {
    const { llm, seenMessages } = makeFakeLlm([
      { tool: { name: "search", args: { query: "mc update" } } },
      { content: "Based on search: update" },
    ]);
    const onToolCalls = [];
    const out = await runAgentLoop({
      messages: [{ role: "user", content: "what's new?" }],
      env,
      llm,
      executeTool: executeFake,
      onTool: (name, args) => onToolCalls.push({ name, args }),
    });
    assert.equal(out.text, "Based on search: update");
    assert.equal(onToolCalls.length, 1);
    assert.equal(onToolCalls[0].name, "search");
    // The second LLM call must have seen the tool result message.
    const second = seenMessages[1].messages;
    const toolMsg = second.find((m) => m.role === "tool");
    assert.ok(toolMsg, "expected a tool message in the follow-up LLM call");
    assert.ok(toolMsg.content.includes("results"));
  });

  it("recovers when a tool errors and still returns a final answer", async () => {
    const { llm } = makeFakeLlm([
      { tool: { name: "search", args: { query: "x" } } },
      { content: "could not search" },
    ]);
    const failingExecute = async () => ({ error: "search failed: 429" });
    const out = await runAgentLoop({
      messages: [{ role: "user", content: "q" }],
      env,
      llm,
      executeTool: failingExecute,
    });
    assert.equal(out.text, "could not search");
    assert.equal(out.truncated, false);
  });

  it("truncates when the model keeps calling tools past maxIterations", async () => {
    const { llm } = makeFakeLlm([{ tool: { name: "search", args: { query: "again" } } }]);
    const out = await runAgentLoop({
      messages: [{ role: "user", content: "q" }],
      env,
      llm,
      executeTool: executeFake,
      maxIterations: 2,
    });
    assert.equal(out.truncated, true);
  });

  it("instructs the model to emit the refusal sentinel when declining", async () => {
    let seen = null;
    const llm = async (messages) => {
      seen = messages;
      return { message: { role: "assistant", content: "ok" }, provider: "inception", tokens: 1 };
    };
    await runAgentLoop({ messages: [{ role: "user", content: "q" }], env, llm });
    const system = seen.find((m) => m.role === "system");
    assert.ok(system, "expected an injected system message");
    assert.ok(
      system.content.includes("##REFUSED##"),
      `system prompt must mention the sentinel, got: ${system.content}`
    );
  });
});
