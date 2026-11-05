import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createStatusSender } from "../src/processor.js";

function fakeChannel(sent) {
  return {
    send: async (text) => {
      sent.push(text);
      return { id: `m${sent.length}` };
    },
  };
}

describe("createStatusSender", () => {
  it("sends the first phase message", async () => {
    const sent = [];
    const { send } = createStatusSender({ channel: fakeChannel(sent), allow: true });
    await send("search");
    assert.deepEqual(sent, ["searching the web… 🔎"]);
  });

  it("sends a message when the phase changes", async () => {
    const sent = [];
    const { send } = createStatusSender({ channel: fakeChannel(sent), allow: true });
    await send("search");
    await send("fetch");
    await send("compose");
    assert.deepEqual(sent, [
      "searching the web… 🔎",
      "reading sources… 📄",
      "composing your answer… ✍️",
    ]);
  });

  it("does not repeat the same phase (throttle)", async () => {
    const sent = [];
    const { send } = createStatusSender({ channel: fakeChannel(sent), allow: true });
    await send("search");
    await send("search");
    await send("fetch");
    await send("search");
    assert.equal(sent.length, 2);
  });

  it("sends nothing when disallowed (interaction/private)", async () => {
    const sent = [];
    const { send } = createStatusSender({ channel: fakeChannel(sent), allow: false });
    await send("search");
    await send("compose");
    assert.equal(sent.length, 0);
  });

  it("cleanup deletes each sent status message", async () => {
    const deleted = [];
    const { send, cleanup } = createStatusSender({
      channel: fakeChannel([]),
      deleteMessage: async (id) => deleted.push(id),
      allow: true,
    });
    await send("search");
    await send("fetch");
    await send("compose");
    await cleanup();
    assert.deepEqual(deleted.sort(), ["m1", "m2", "m3"]);
  });

  it("cleanup swallows deletion errors", async () => {
    const { send, cleanup } = createStatusSender({
      channel: fakeChannel([]),
      deleteMessage: async () => {
        throw new Error("boom");
      },
      allow: true,
    });
    await send("search");
    await cleanup(); // must not throw
    assert.ok(true);
  });

  it("cleanup does nothing when no status messages were sent", async () => {
    let deletes = 0;
    const { cleanup } = createStatusSender({
      channel: fakeChannel([]),
      deleteMessage: async () => deletes++,
      allow: true,
    });
    await cleanup();
    assert.equal(deletes, 0);
  });
});
