// Per-channel conversation state. One Durable Object instance per channel/guild key.

export class ConversationDO {
  constructor(stateObj, env) {
    this.stateObj = stateObj;
    this.state = {
      history: [],
      tokenCount: 0,
      modelUsage: {},
      memory: "",
      userProfiles: {}
    };
  }

  // rough token estimation based on character count
  static estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }

  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/initialize":
        await this.initialize();
        return new Response("ok");
      case "/append":
        return this.append(await request.json());
      case "/get":
        return new Response(JSON.stringify(this.state));
      case "/clear":
        this.state = {
          history: [],
          tokenCount: 0,
          modelUsage: {},
          memory: "",
          // User profiles are identity facts, not conversation state — they
          // survive a clear.
          userProfiles: this.state.userProfiles || {}
        };
        await this.stateObj.storage.put("state", this.state);
        return new Response("cleared");
      case "/setSummary": {
        const body = await request.json();
        await this.setSummary(body.summary);
        return new Response("ok");
      }
      case "/memoryGet":
        return new Response(JSON.stringify({ memory: this.state.memory || "" }));
      case "/setMemory": {
        const body = await request.json();
        this.state.memory = body.memory || "";
        await this.stateObj.storage.put("state", this.state);
        return new Response("ok");
      }
      case "/getUserProfile": {
        const userId = url.searchParams.get("userId");
        return new Response(
          JSON.stringify({ profile: this.state.userProfiles?.[userId] || "" })
        );
      }
      case "/setUserProfile": {
        const body = await request.json();
        this.state.userProfiles = this.state.userProfiles || {};
        this.state.userProfiles[body.userId] = body.profile;
        await this.stateObj.storage.put("state", this.state);
        return new Response("ok");
      }
      case "/recordUsage": {
        const body = await request.json();
        await this.recordUsage(body.model, body.tokens);
        return new Response("ok");
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }

  async initialize() {
    const stored = await this.stateObj.storage.get("state");
    if (stored) {
      this.state = stored;
    }
  }

  async append(entry) {
    this.state.history.push(entry);
    this.state.tokenCount += ConversationDO.estimateTokens(entry.content);
    await this.stateObj.storage.put("state", this.state);
    return new Response("ok");
  }

  async getState() {
    return this.state;
  }

  async setSummary(summary) {
    this.state.summary = summary;
    this.state.history = [];
    this.state.tokenCount = ConversationDO.estimateTokens(summary);
    await this.stateObj.storage.put("state", this.state);
  }

  async recordUsage(model, tokens) {
    const prev = this.state.modelUsage[model] || 0;
    this.state.modelUsage[model] = prev + tokens;
    await this.stateObj.storage.put("state", this.state);
  }
}
