// Agent tools: search + fetch_url. Each returns a plain value or { error },
// never throws, so the loop can feed failures back to the model.

const FETCH_MAX_BYTES = 64 * 1024;

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
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query, max_results: numResults ?? 5 }),
  });
  if (!res.ok) {
    return { error: `search failed: ${res.status}` };
  }
  const data = await res.json();
  const results = (data.results || []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
  return { results };
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
    const res = await fetch(parsed.toString(), { redirect: "follow" });
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
  search: async (args, env) => tavilySearch(args.query, args.num_results, env),
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
