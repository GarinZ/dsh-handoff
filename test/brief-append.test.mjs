import test from "node:test";
import assert from "node:assert/strict";
import { appendBrief } from "../lib/brief-append.js";

/** A Session stand-in that records appends. */
const fakeSession = () => {
  const appended = [];
  return {
    appended,
    append: (type, data, opts) => {
      appended.push({ type, data, opts });
      return { type, data, seq: appended.length - 1 };
    }
  };
};

test("the brief is one surface user message", () => {
  const session = fakeSession();
  const result = appendBrief(session, "brief", { messageId: "msg-1" });
  assert.equal(result.appended, true);
  assert.deepEqual(
    session.appended.map((event) => event.type),
    ["user/message"]
  );
  assert.equal(session.appended[0].data.id, "msg-1");
  assert.equal(session.appended[0].data.content[0].text, "brief");
  assert.deepEqual(session.appended[0].opts, { surfaceOp: "append" });
});

test("the brief carries an id when the caller supplies none", () => {
  const session = fakeSession();
  appendBrief(session, "brief");
  assert.equal(typeof session.appended[0].data.id, "string");
  assert.ok(session.appended[0].data.id.length > 0);
});

test("no turn is fabricated around the brief", () => {
  // A fabricated turn/start would disagree with the agent loop's cached turn
  // number and a surface brief would precede the loop's system message; both
  // corrupt the stored log.
  const session = fakeSession();
  appendBrief(session, "brief");
  assert.ok(!session.appended.some((event) => event.type === "turn/start"));
});
