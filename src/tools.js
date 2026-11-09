// Agent tools: search + fetch_url. Each returns a plain value or { error },
// never throws, so the loop can feed failures back to the model.

const FETCH_MAX_BYTES = 64 * 1024;
const TOOL_TIMEOUT_MS = 15_000;

// Bounded memory (Hermes-inspired): channel notes + per-user profiles, with
// hard character caps and §-delimited entries. The agent manages these via the
// `memory` tool.
export const MEMORY_CHANNEL_LIMIT = 2200;
export const MEMORY_USER_LIMIT = 1375;
const MEMORY_DELIMITER = "§";
// Reject content with invisible unicode or control characters (injection
// hygiene) — these are injected into the system prompt.
const UNSAFE_MEMORY_PATTERN = /[\u0000-\u001f\u200b-\u200f\u202a-\u202e\ufeff]/;

async function fetchWithToolTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const searchTool = {
  type: "function",
  function: {
    name: "search",
    description:
      "Search the web for current information. Returns ranked results with title, URL, and snippet.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        num_results: { type: "number", description: "Optional number of results (default 5)" },
      },
      required: ["query"],
    },
  },
};

const fetchUrlTool = {
  type: "function",
  function: {
    name: "fetch_url",
    description: "Fetch a URL and return its content as plain text.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http(s) URL to fetch" },
      },
      required: ["url"],
    },
  },
};

const memoryTool = {
  type: "function",
  function: {
    name: "memory",
    description:
      "Read/write bounded memory. target 'memory' is this channel's shared notes; " +
      "target 'user' is the current user's profile. Operations: add (append an " +
      "entry), patch (replace a unique substring in one entry via old_text + content), " +
      "remove (delete the entry containing a unique substring via old_text). Memory " +
      "has hard character caps: if a write would overflow, the tool returns an error " +
      "listing current entries and the chars needed — consolidate (patch/remove) then " +
      "retry in one batch.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["memory", "user"] },
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add", "patch", "remove"] },
              content: { type: "string" },
              old_text: { type: "string" },
            },
          },
        },
      },
      required: ["target", "operations"],
    },
  },
};

export const AGENT_TOOLS = [searchTool, fetchUrlTool, memoryTool];

async function tavilySearch(query, numResults, env) {
  const key = env.TAVILY_API_KEY;
  if (!key) return { error: "TAVILY_API_KEY not configured" };
  const res = await fetchWithToolTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query, max_results: numResults ?? 5 }),
  });
  if (!res.ok) {
    return { error: `tavily search failed: ${res.status}` };
  }
  const data = await res.json();
  const results = (data.results || []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
  return { results };
}

async function exaSearch(query, numResults, env) {
  const key = env.EXA_API_KEY;
  if (!key) return { error: "EXA_API_KEY not configured" };
  const res = await fetchWithToolTimeout("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      query,
      numResults: numResults ?? 5,
      contents: { highlights: true },
    }),
  });
  if (!res.ok) {
    return { error: `exa search failed: ${res.status}` };
  }
  const data = await res.json();
  const results = (data.results || []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: (r.highlights && r.highlights[0]) || "",
  }));
  return { results };
}

const SEARCH_PROVIDERS = {
  tavily: tavilySearch,
  exa: exaSearch,
};

function searchOrder(env) {
  const raw = env.SEARCH_PROVIDER || "tavily,exa";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => SEARCH_PROVIDERS[s]);
}

async function runSearch(query, numResults, env) {
  const order = searchOrder(env);
  if (order.length === 0) return { error: "no search provider configured" };
  const failures = [];
  for (const name of order) {
    const out = await SEARCH_PROVIDERS[name](query, numResults, env);
    if (out.results) return out;
    failures.push(out.error || name);
  }
  return { error: `search failed on all providers: ${failures.join(" | ")}` };
}

// Minimal HTML -> text: drop script/style, strip tags, decode common entities.
function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/gi, " ");
  s = s.replace(/&amp;/gi, "&");
  s = s.replace(/&lt;/gi, "<");
  s = s.replace(/&gt;/gi, ">");
  s = s.replace(/&quot;/gi, '"');
  s = s.replace(/&#39;/g, "'");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

async function fetchUrl(url, env) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "invalid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `unsupported protocol: ${parsed.protocol}` };
  }
  try {
    const res = await fetchWithToolTimeout(parsed.toString(), { redirect: "follow" });
    if (!res.ok) return { error: `fetch failed: ${res.status}` };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > FETCH_MAX_BYTES) return { error: "response too large" };
    const text = new TextDecoder().decode(buf);
    return { text: htmlToText(text).slice(0, FETCH_MAX_BYTES) };
  } catch (err) {
    return { error: `fetch error: ${err?.message || err}` };
  }
}

const TOOL_IMPLS = {
  search: async (args, env) => runSearch(args.query, args.num_results, env),
  fetch_url: async (args, env) => fetchUrl(args.url, env),
  memory: async (args, env) => memoryImpl(args, env),
};

// ---- memory tool implementation ----

// The memory tool reads and writes through the per-channel ConversationDO
// stub, which processMessage attaches to env as CONVERSATION_STUB. The `user`
// target resolves to the current asker via env.CURRENT_USER_ID.

async function memoryRead(env, target) {
  const stub = env.CONVERSATION_STUB;
  if (!stub) return { error: "memory store unavailable" };
  if (target === "memory") {
    const res = await stub.fetch("https://example.com/memoryGet");
    const data = await res.json();
    return { value: data.memory || "" };
  }
  const res = await stub.fetch(
    `https://example.com/getUserProfile?userId=${encodeURIComponent(env.CURRENT_USER_ID || "")}`
  );
  const data = await res.json();
  return { value: data.profile || "" };
}

async function memoryWrite(env, target, value) {
  const stub = env.CONVERSATION_STUB;
  if (target === "memory") {
    await stub.fetch("https://example.com/setMemory", {
      method: "POST",
      body: JSON.stringify({ memory: value }),
    });
    return;
  }
  await stub.fetch("https://example.com/setUserProfile", {
    method: "POST",
    body: JSON.stringify({ userId: env.CURRENT_USER_ID, profile: value }),
  });
}

function parseEntries(text) {
  return text
    .split(MEMORY_DELIMITER)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isUnsafeMemoryContent(content) {
  return UNSAFE_MEMORY_PATTERN.test(content);
}

async function memoryImpl(args, env) {
  const target = args.target;
  if (target !== "memory" && target !== "user") {
    return { success: false, error: `unknown memory target: ${target}` };
  }
  const ops = Array.isArray(args.operations) ? args.operations : [];
  if (ops.length === 0) {
    return { success: false, error: "no operations provided" };
  }

  const read = await memoryRead(env, target);
  if (read.error) return { success: false, error: read.error };
  const limit = target === "memory" ? MEMORY_CHANNEL_LIMIT : MEMORY_USER_LIMIT;

  let entries = parseEntries(read.value);

  for (const op of ops) {
    if (!op || typeof op.action !== "string") {
      return { success: false, error: "operation missing action" };
    }
    if (op.action === "add") {
      const content = typeof op.content === "string" ? op.content.trim() : "";
      if (!content) return { success: false, error: "add requires content" };
      if (isUnsafeMemoryContent(content)) {
        return { success: false, error: "content rejected: contains invisible or control characters" };
      }
      if (entries.includes(content)) {
        return { success: true, note: "no duplicate added" };
      }
      entries.push(content);
    } else if (op.action === "patch" || op.action === "remove") {
      const oldText = typeof op.old_text === "string" ? op.old_text.trim() : "";
      if (!oldText) {
        return { success: false, error: `${op.action} requires old_text` };
      }
      const matches = entries.filter((e) => e.includes(oldText));
      if (matches.length !== 1) {
        return {
          success: false,
          error: `${op.action} old_text matched ${matches.length} entries (need exactly 1)`,
          current_entries: entries,
          closest_entries: matches,
        };
      }
      if (op.action === "remove") {
        entries = entries.filter((e) => e !== matches[0]);
      } else {
        const content = typeof op.content === "string" ? op.content : "";
        if (isUnsafeMemoryContent(content)) {
          return { success: false, error: "content rejected: contains invisible or control characters" };
        }
        entries = entries.map((e) => (e === matches[0] ? e.replace(oldText, content) : e));
      }
    } else {
      return { success: false, error: `unknown action: ${op.action}` };
    }
  }

  const joined = entries.join(` ${MEMORY_DELIMITER} `);
  const size = joined.length;
  if (size > limit) {
    return {
      success: false,
      error: `memory at ${size}/${limit} chars — exceeds the ${limit}-char limit; free at least ${size - limit} chars (patch/remove) then retry`,
      current_entries: entries,
      current_size: size,
    };
  }

  await memoryWrite(env, target, joined);
  return { success: true, entries, size };
}

export async function executeTool(name, args, env) {
  const impl = TOOL_IMPLS[name];
  if (!impl) return { error: `unknown tool: ${name}` };
  try {
    return await impl(args || {}, env);
  } catch (err) {
    return { error: `tool ${name} error: ${err?.message || err}` };
  }
}
