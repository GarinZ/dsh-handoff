import test from "node:test";
import assert from "node:assert/strict";
import { appendBrief } from "../lib/brief-append.js";

/** A Session stand-in that records appends and serves a fixed prior log. */
const fakeSession = (events = []) => {
  const appended = [];
  return {
    appended,
    snapshotEvents: () => events,
    append: (type, data, opts) => {
      appended.push({ type, data, opts });
      return { type, data, seq: appended.length - 1 };
    }
  };
};

test("a fresh session gets a closed turn so the list stops hiding it", () => {
  const session = fakeSession();
  const result = appendBrief(session, "brief", { ensureVisible: true });
  assert.equal(result.openedTurn, true);
  assert.deepEqual(
    session.appended.map((event) => event.type),
    ["turn/start", "user/message", "turn/end"]
  );
  assert.deepEqual(session.appended[0].data, { turn: 1 });
  assert.deepEqual(session.appended[2].data, { turn: 1, reason: { kind: "completed" } });
  assert.deepEqual(session.appended[1].opts, { surfaceOp: "append" });
  assert.equal(session.appended[1].data.content[0].text, "brief");
});

test("a forked session that already has turns is not wrapped again", () => {
  const session = fakeSession([{ type: "turn/start", data: { turn: 1 } }]);
  const result = appendBrief(session, "brief", { ensureVisible: true });
  assert.equal(result.openedTurn, false);
  assert.deepEqual(
    session.appended.map((event) => event.type),
    ["user/message"]
  );
});

test("without ensureVisible the brief stays a bare message", () => {
  const session = fakeSession();
  appendBrief(session, "brief");
  assert.deepEqual(
    session.appended.map((event) => event.type),
    ["user/message"]
  );
});

test("the brief keeps a caller-supplied message id", () => {
  const session = fakeSession();
  appendBrief(session, "brief", { messageId: "msg-1" });
  assert.equal(session.appended[0].data.id, "msg-1");
});
