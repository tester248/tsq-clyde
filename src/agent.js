// Bounded, failure-tolerant agent tool loop. Calls the LLM with tool
// definitions; if the model returns tool_calls, executes them and feeds the
// results back as tool messages, looping until the model answers or the
// budget is exhausted.

import { callLLM, REFUSAL_SENTINEL } from "./ai.js";
import { AGENT_TOOLS, executeTool as defaultExecuteTool } from "./tools.js";

const AGENT_SYSTEM_HINT = {
  role: "system",
  content:
    "You may use the provided tools to retrieve current information. " +
    "Only call a tool when your knowledge may be outdated or incomplete. " +
    "If you already know the answer, reply directly without calling any tool. " +
    "Replies are sent to a Discord channel with a 2000-character limit: keep " +
    "your answer concise, under ~1800 characters, and prefer tight bullet " +
    "points or a short paragraph over exhaustive detail. " +
    `IMPORTANT: if you are unable or unwilling to answer, reply with exactly ` +
    `${REFUSAL_SENTINEL} and nothing else — no explanation, no apology. ` +
    `Never use that token for any other reason.`,
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
  budgetMs = 90_000,
  llm = callLLM,
  onTool,
  onPhase,
}) {
  const started = Date.now();
  let current = [...messages];
  // Inject the "only search when needed" nudge as the first system message.
  const hasSystem = current.some((m) => m.role === "system");
  if (!hasSystem) current.unshift(AGENT_SYSTEM_HINT);
  let totalTokens = 0;
  let usedTools = false;

  const emitPhase = (p) => {
    if (onPhase) {
      try {
        onPhase(p);
      } catch {
        // best-effort
      }
    }
  };

  for (let i = 0; i < maxIterations; i++) {
    if (Date.now() - started > budgetMs) break;

    const { message, provider, tokens } = await llm(current, env, { tools });
    totalTokens += tokens;
    current.push(message);

    const calls = message?.tool_calls || [];
    // A message WITH tool_calls is narration/planning, not a final answer.
    // Only a message with no pending tool calls is a genuine reply.
    if (calls.length === 0) {
      if (usedTools) emitPhase("compose");
      return {
        text: message?.content || "",
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
      usedTools = true;
      emitPhase(name === "fetch_url" ? "fetch" : "search");
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

  // Loop exhausted without a genuine (tool-free) answer. Return an honest
  // fallback — never intermediate narration text.
  return {
    text: "I couldn't finish researching in time. Try asking again.",
    provider: "inception",
    iterations: maxIterations,
    truncated: true,
    totalTokens,
  };
}
