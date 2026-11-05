// Bounded, failure-tolerant agent tool loop. Calls the LLM with tool
// definitions; if the model returns tool_calls, executes them and feeds the
// results back as tool messages, looping until the model answers or the
// budget is exhausted.

import { callLLM } from "./ai.js";
import { AGENT_TOOLS, executeTool as defaultExecuteTool } from "./tools.js";

const AGENT_SYSTEM_HINT = {
  role: "system",
  content:
    "You may use the provided tools to retrieve current information. " +
    "Only call a tool when your knowledge may be outdated or incomplete. " +
    "If you already know the answer, reply directly without calling any tool.",
};

// Fast-path heuristic: skip the tool loop entirely for greetings and trivial
// pings so they answer instantly and never trigger a search.
const GREETINGS = [
  "hi", "hey", "hello", "yo", "sup", "whats up", "what's up", "whats up?",
  "what's up?", "hmm", "hm", "uwu", "ok", "okay", "thanks", "thank you", "ty",
];

export function shouldUseAgentTools(prompt) {
  const s = (prompt || "").trim().toLowerCase();
  if (!s) return false;
  if (GREETINGS.includes(s)) return false;
  if (s.startsWith("whats up") || s.startsWith("what's up")) return false;
  return true;
}

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
  // Inject the "only search when needed" nudge as the first system message.
  const hasSystem = current.some((m) => m.role === "system");
  if (!hasSystem) current.unshift(AGENT_SYSTEM_HINT);
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
