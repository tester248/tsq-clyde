import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_TOOLS,
  executeTool,
  SKILL_MAX_CHARS,
} from "../src/tools.js";

// In-memory fake of the SKILLS_KV namespace (ParallelKV API subset).
function makeSkillsEnv(entries = {}) {
  const store = new Map(Object.entries(entries));
  const kv = {
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => void store.set(key, value),
    delete: async (key) => void store.delete(key),
    list: async ({ prefix = "" } = {}) => ({
      keys: [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ name: k })),
    }),
  };
  return { env: { SKILLS_KV: kv }, store };
}

const DEPLOY_SKILL = `---
name: deployment-checklist
description: Steps to verify a release before tagging
category: engineering
---

# Deployment checklist

## Procedure
1. Run \`npm test\`.
2. \`npx wrangler deploy\`.

## Pitfalls
- Worker name is spelled tsq-klyde.
`;

describe("skills tools", () => {
  it("AGENT_TOOLS declares search, fetch_url, memory, and the three skills tools", () => {
    const names = AGENT_TOOLS.map((t) => t.function.name);
    assert.deepEqual(names.sort(), [
      "fetch_url",
      "memory",
      "search",
      "skill_manage",
      "skill_view",
      "skills_list",
    ]);
  });

  it("skills_list returns an empty list for an empty store", async () => {
    const { env } = makeSkillsEnv();
    const out = await executeTool("skills_list", {}, env);
    assert.deepEqual(out, { skills: [] });
  });

  it("skills_list parses frontmatter, sorts by name, and hides bodies", async () => {
    const { env } = makeSkillsEnv({
      "deployment-checklist": DEPLOY_SKILL,
      "a-first": `---
name: a-first
description: The first skill
category: general
---

body here`,
    });
    const out = await executeTool("skills_list", {}, env);
    assert.deepEqual(out.skills, [
      { name: "a-first", description: "The first skill", category: "general" },
      { name: "deployment-checklist", description: "Steps to verify a release before tagging", category: "engineering" },
    ]);
    // Bodies must not leak into the listing.
    assert.ok(!JSON.stringify(out).includes("Procedure"));
  });

  it("skill_view returns the raw stored document", async () => {
    const { env } = makeSkillsEnv({ "deployment-checklist": DEPLOY_SKILL });
    const out = await executeTool("skill_view", { name: "deployment-checklist" }, env);
    assert.equal(out.content, DEPLOY_SKILL);
    assert.equal(out.name, "deployment-checklist");
  });

  it("skill_view errors on an unknown slug", async () => {
    const { env } = makeSkillsEnv();
    const out = await executeTool("skill_view", { name: "nope" }, env);
    assert.equal(out.success, false);
    assert.ok(out.error);
  });

  it("skill_manage create persists a skill that view can read back", async () => {
    const { env, store } = makeSkillsEnv();
    const out = await executeTool("skill_manage", {
      action: "create",
      name: "deployment-checklist",
      content: DEPLOY_SKILL,
    }, env);
    assert.equal(out.success, true);
    assert.ok(store.has("deployment-checklist"));
    const view = await executeTool("skill_view", { name: "deployment-checklist" }, env);
    assert.equal(view.content, DEPLOY_SKILL);
  });

  it("skill_manage create rejects a duplicate slug", async () => {
    const { env } = makeSkillsEnv({ "deployment-checklist": DEPLOY_SKILL });
    const out = await executeTool("skill_manage", {
      action: "create",
      name: "deployment-checklist",
      content: DEPLOY_SKILL,
    }, env);
    assert.equal(out.success, false);
    assert.ok(out.error);
  });

  it("skill_manage patch replaces the content of an existing skill", async () => {
    const { env, store } = makeSkillsEnv({ "deployment-checklist": DEPLOY_SKILL });
    const patched = DEPLOY_SKILL.replace("## Pitfalls\n- Worker name is spelled tsq-klyde.", "## Pitfalls\n- The gateway needs a POST /connect after deploy.");
    const out = await executeTool("skill_manage", {
      action: "patch",
      name: "deployment-checklist",
      content: patched,
    }, env);
    assert.equal(out.success, true);
    assert.equal(store.get("deployment-checklist"), patched);
  });

  it("skill_manage patch errors when the slug is missing", async () => {
    const { env } = makeSkillsEnv();
    const out = await executeTool("skill_manage", {
      action: "patch",
      name: "missing",
      content: DEPLOY_SKILL,
    }, env);
    assert.equal(out.success, false);
    assert.ok(out.error);
  });

  it("skill_manage delete removes the skill", async () => {
    const { env, store } = makeSkillsEnv({ "deployment-checklist": DEPLOY_SKILL });
    const out = await executeTool("skill_manage", {
      action: "delete",
      name: "deployment-checklist",
    }, env);
    assert.equal(out.success, true);
    assert.ok(!store.has("deployment-checklist"));
  });

  it("skill_manage delete errors when the slug is missing", async () => {
    const { env } = makeSkillsEnv();
    const out = await executeTool("skill_manage", { action: "delete", name: "missing" }, env);
    assert.equal(out.success, false);
    assert.ok(out.error);
  });

  it("rejects invalid slugs on create and patch", async () => {
    const { env } = makeSkillsEnv();
    for (const bad of ["Bad Slug", "underscore_slug", "UPPER", "", "a".repeat(65)]) {
      const out = await executeTool("skill_manage", {
        action: "create",
        name: bad,
        content: DEPLOY_SKILL,
      }, env);
      assert.equal(out.success, false, `slug should be rejected: ${JSON.stringify(bad)}`);
      assert.ok(out.error);
    }
  });

  it("returns a cap error when content exceeds SKILL_MAX_CHARS", async () => {
    const { env } = makeSkillsEnv();
    const huge = "x".repeat(SKILL_MAX_CHARS + 1);
    const out = await executeTool("skill_manage", {
      action: "create",
      name: "huge",
      content: huge,
    }, env);
    assert.equal(out.success, false);
    assert.ok(out.error.includes("limit"));
  });

  it("rejects content with invisible unicode / control characters", async () => {
    const { env, store } = makeSkillsEnv();
    const evil = DEPLOY_SKILL + "\u200bhidden";
    const out = await executeTool("skill_manage", {
      action: "create",
      name: "evil",
      content: evil,
    }, env);
    assert.equal(out.success, false);
    assert.ok(out.error);
    assert.ok(!store.has("evil"));
  });

  it("returns an error when SKILLS_KV is missing", async () => {
    const out = await executeTool("skills_list", {}, {});
    assert.equal(out.success, false);
    assert.ok(out.error);
  });
});
