// Bounded, failure-tolerant agent tool loop. Calls the LLM with tool
// definitions; if the model returns tool_calls, executes them and feeds the
// results back as tool messages, looping until the model answers or the
// budget is exhausted.

import { callLLM } from "./ai.js";
import { AGENT_TOOLS, executeTool as defaultExecuteTool } from "./tools.js";

export async function runAgentLoop({
  messages,
  env,
  tools = AGENT_TOOLS,
  executeTool = defaultExecuteTool,
  maxIterations = 6,
  budgetMs = 45_000,
  llm = callLLM,
  onTool,
}) {
  const started = Date.now();
  let current = [...messages];
  let totalTokens = 0;
  let lastAssistantText = "";

  for (let i = 0; i < maxIterations; i++) {
    if (Date.now() - started > budgetMs) break;

    const { message, provider, tokens } = await llm(current, env, { tools });
    totalTokens += tokens;
    current.push(message);
    if (message?.content) lastAssistantText = message.content;

    const calls = message?.tool_calls || [];
    if (calls.length === 0) {
      return {
        text: lastAssistantText,
        provider,
        iterations: i + 1,
        truncated: false,
        totalTokens,
      };
    }

    for (const call of calls) {
      let name = "";
      let args = {};
      try {
        name = call.function?.name || "";
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        args = {};
      }
      if (onTool) {
        try {
          onTool(name, args);
        } catch {
          // feedback is best-effort
        }
      }
      const result = await executeTool(name, args, env);
      current.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return {
    text: lastAssistantText || "I couldn't finish researching in time.",
    provider: "inception",
    iterations: maxIterations,
    truncated: true,
    totalTokens,
  };
}
