// Agent tools: search + fetch_url. Each returns a plain value or { error },
// never throws, so the loop can feed failures back to the model.

const FETCH_MAX_BYTES = 64 * 1024;
const TOOL_TIMEOUT_MS = 15_000;

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

export const AGENT_TOOLS = [searchTool, fetchUrlTool];

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
};

export async function executeTool(name, args, env) {
  const impl = TOOL_IMPLS[name];
  if (!impl) return { error: `unknown tool: ${name}` };
  try {
    return await impl(args || {}, env);
  } catch (err) {
    return { error: `tool ${name} error: ${err?.message || err}` };
  }
}
