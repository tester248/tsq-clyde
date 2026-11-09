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

// Skills (Hermes-inspired): global, agent-managed SKILL.md documents in KV,
// exposed with progressive disclosure (list → view → manage).
export const SKILL_MAX_CHARS = 8000;
export const SKILL_MAX_COUNT = 200;
export const SKILL_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Skills are multi-line documents, so unlike memory entries (single §-delimited
// lines) tabs/newlines are allowed — but real control chars and zero-width
// invisible unicode are still rejected (injection hygiene).
const UNSAFE_SKILL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b-\u200f\u202a-\u202e\ufeff]/;

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

const skillsListTool = {
  type: "function",
  function: {
    name: "skills_list",
    description:
      "List all skills as compact metadata (name, description, category). " +
      "Skills are reusable how-to documents. Start here to discover what exists; " +
      "view a skill (skill_view) only when it is relevant to the task.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

const skillViewTool = {
  type: "function",
  function: {
    name: "skill_view",
    description: "Read the full content of one skill by slug (see skills_list).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill slug, e.g. deployment-checklist" },
      },
      required: ["name"],
    },
  },
};

const skillManageTool = {
  type: "function",
  function: {
    name: "skill_manage",
    description:
      "Create, patch (replace), or delete a skill by slug. content is a full " +
      "SKILL.md document with frontmatter (name, description, category) plus a " +
      "markdown body (Procedure / Pitfalls). Create a skill to codify a reusable " +
      "procedure so future turns can consult it.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "patch", "delete"] },
        name: { type: "string", description: "Skill slug (lowercase, hyphens)" },
        content: { type: "string", description: "Full SKILL.md content (create/patch)" },
      },
      required: ["action", "name"],
    },
  },
};

const sessionSearchTool = {
  type: "function",
  function: {
    name: "session_search",
    description:
      "Search this channel's past conversations by keyword. Returns matching " +
      "messages with author, time, and an excerpt. Use when the current context " +
      "lacks detail you discussed before (e.g. decisions, numbers, or prior " +
      "answers that have been compacted out of view).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search for (all must appear)" },
        limit: { type: "number", description: "Optional max results (1-10, default 5)" },
      },
      required: ["query"],
    },
  },
};

export const AGENT_TOOLS = [searchTool, fetchUrlTool, memoryTool, skillsListTool, skillViewTool, skillManageTool, sessionSearchTool];

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
  skills_list: async (args, env) => skillsListImpl(env),
  skill_view: async (args, env) => skillViewImpl(args, env),
  skill_manage: async (args, env) => skillManageImpl(args, env),
  session_search: async (args, env) => sessionSearchImpl(args, env),
};

// ---- session_search tool implementation (Phase 3) ----

// Queries the per-channel ConversationDO's FTS5 index via the same stub the
// memory tool uses (CONVERSATION_STUB, attached by processMessage).

async function sessionSearchImpl(args, env) {
  const stub = env.CONVERSATION_STUB;
  if (!stub) return { success: false, error: "conversation store unavailable" };
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { success: false, error: "query is required" };

  let limit = parseInt(args.limit ?? "", 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = null;

  let url = `https://example.com/searchMessages?q=${encodeURIComponent(query)}`;
  if (limit !== null) url += `&limit=${limit}`;

  try {
    const res = await stub.fetch(url);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { success: false, error: data.error || `search failed: ${res.status}` };
    }
    const data = await res.json();
    const matches = (data.results || []).map((r) => ({
      author: r.author || "",
      ts: r.ts ?? null,
      snippet: r.snippet || "",
    }));
    return { success: true, matches };
  } catch (err) {
    return { success: false, error: `search error: ${err?.message || err}` };
  }
}

// ---- skills tool implementation (Phase 2, Hermes-inspired) ----

// Skills are global SKILL.md documents in a dedicated KV namespace. The front
// matter (name, description, category) is parsed on read so the store itself
// is the single source of truth (no separate index to drift).

function parseSkillFrontmatter(content) {
  const m = String(content || "").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split("\n")) {
    const eq = line.indexOf(":");
    if (eq > 0) {
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^"|"$/g, "");
      if (key) meta[key] = val;
    }
  }
  return { meta, body: m[2].trim() };
}

function isValidSkillSlug(name) {
  return typeof name === "string" && name.length <= 64 && SKILL_SLUG_PATTERN.test(name);
}

async function skillsListImpl(env) {
  const kv = env.SKILLS_KV;
  if (!kv) return { success: false, error: "SKILLS_KV not configured" };
  let list;
  try {
    list = await kv.list({});
  } catch (err) {
    return { success: false, error: `skills list failed: ${err?.message || err}` };
  }
  const skills = [];
  for (const { name } of list.keys || []) {
    let raw;
    try {
      raw = await kv.get(name);
    } catch {
      continue; // a transient read failure should not kill the whole catalog
    }
    const parsed = parseSkillFrontmatter(raw);
    skills.push({
      name,
      description: parsed?.meta.description || "",
      category: parsed?.meta.category || "general",
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills };
}

async function skillViewImpl(args, env) {
  const kv = env.SKILLS_KV;
  if (!kv) return { success: false, error: "SKILLS_KV not configured" };
  const name = typeof args.name === "string" ? args.name : "";
  if (!isValidSkillSlug(name)) {
    return { success: false, error: `invalid skill slug: ${name}` };
  }
  let raw;
  try {
    raw = await kv.get(name);
  } catch (err) {
    return { success: false, error: `skill read failed: ${err?.message || err}` };
  }
  if (raw === null || raw === undefined) {
    return { success: false, error: `no such skill: ${name}` };
  }
  return { name, content: raw };
}

async function skillManageImpl(args, env) {
  const kv = env.SKILLS_KV;
  if (!kv) return { success: false, error: "SKILLS_KV not configured" };
  const action = args.action;
  const name = typeof args.name === "string" ? args.name : "";
  if (!["create", "patch", "delete"].includes(action)) {
    return { success: false, error: `unknown skill action: ${action}` };
  }
  if (!isValidSkillSlug(name)) {
    return { success: false, error: `invalid skill slug: ${name}` };
  }

  if (action === "delete") {
    let exists;
    try {
      exists = (await kv.get(name)) !== null && (await kv.get(name)) !== undefined;
    } catch (err) {
      return { success: false, error: `skill read failed: ${err?.message || err}` };
    }
    if (!exists) return { success: false, error: `no such skill: ${name}` };
    try {
      await kv.delete(name);
    } catch (err) {
      return { success: false, error: `skill delete failed: ${err?.message || err}` };
    }
    return { success: true };
  }

  const content = typeof args.content === "string" ? args.content : "";
  if (!content) return { success: false, error: "content is required for create/patch" };
  if (content.length > SKILL_MAX_CHARS) {
    return {
      success: false,
      error: `skill content ${content.length} chars exceeds the ${SKILL_MAX_CHARS}-char limit; trim or split into multiple skills`,
    };
  }
  if (UNSAFE_SKILL_PATTERN.test(content)) {
    return { success: false, error: "content rejected: contains invisible or control characters" };
  }
  const parsed = parseSkillFrontmatter(content);
  if (!parsed || !parsed.meta.name || !parsed.meta.description) {
    return { success: false, error: "content must start with frontmatter (name, description)" };
  }
  if (parsed.meta.name !== name) {
    return { success: false, error: `frontmatter name (${parsed.meta.name}) does not match slug (${name})` };
  }

  try {
    const existing = await kv.get(name);
    if (action === "create" && existing !== null && existing !== undefined) {
      return { success: false, error: `skill already exists: ${name} (use patch to replace)` };
    }
    if (action === "patch" && (existing === null || existing === undefined)) {
      return { success: false, error: `no such skill: ${name}` };
    }
    if (action === "create") {
      const list = await kv.list({});
      if ((list.keys || []).length >= SKILL_MAX_COUNT) {
        return { success: false, error: `skill library full (${SKILL_MAX_COUNT} skills); delete one first` };
      }
    }
    await kv.put(name, content);
  } catch (err) {
    return { success: false, error: `skill write failed: ${err?.message || err}` };
  }
  return { success: true };
}

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
