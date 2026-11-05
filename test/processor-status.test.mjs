import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createStatusSender } from "../src/processor.js";

function fakeChannel(sent) {
  return {
    send: async (text) => sent.push(text),
  };
}

describe("createStatusSender", () => {
  it("sends the first phase message", () => {
    const sent = [];
    const send = createStatusSender({ channel: fakeChannel(sent), allow: true });
    send("search");
    assert.deepEqual(sent, ["searching the web… 🔎"]);
  });

  it("sends a message when the phase changes", () => {
    const sent = [];
    const send = createStatusSender({ channel: fakeChannel(sent), allow: true });
    send("search");
    send("fetch");
    send("compose");
    assert.deepEqual(sent, [
      "searching the web… 🔎",
      "reading sources… 📄",
      "composing your answer… ✍️",
    ]);
  });

  it("does not repeat the same phase (throttle)", () => {
    const sent = [];
    const send = createStatusSender({ channel: fakeChannel(sent), allow: true });
    send("search");
    send("search");
    send("fetch");
    send("search");
    assert.equal(sent.length, 2);
  });

  it("sends nothing when disallowed (interaction/private)", () => {
    const sent = [];
    const send = createStatusSender({ channel: fakeChannel(sent), allow: false });
    send("search");
    send("compose");
    assert.equal(sent.length, 0);
  });
});
