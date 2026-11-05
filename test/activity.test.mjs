import { test } from "node:test";
import assert from "node:assert/strict";
import { createActivityRoute, createActivityStore } from "../lib/activity.js";

const response = () => ({
  status: 0,
  headers: {},
  body: "",
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers ?? {};
  },
  end(body) {
    this.body = body ?? "";
  }
});

const readJson = (res) => JSON.parse(res.body);

test("the activity slot streams text and settles once", () => {
  let clock = 1000;
  const store = createActivityStore({ now: () => clock });
  const entry = store.begin("session-a", { kind: "btw", title: "旁问", question: "现在做什么？" });
  assert.equal(entry.status, "running");
  assert.equal(entry.question, "现在做什么？");

  clock = 1500;
  store.update("session-a", entry.id, { text: "正在" });
  clock = 2000;
  store.update("session-a", entry.id, { text: "正在写测试" });
  assert.equal(store.get("session-a").text, "正在写测试");
  assert.equal(store.get("session-a").status, "running");

  clock = 3000;
  const settled = store.finish("session-a", entry.id, "done", { text: "正在写测试。" });
  assert.equal(settled.status, "done");
  assert.equal(settled.endedAt, 3000);
  assert.equal(settled.startedAt, 1000);
});

test("a stale callback cannot overwrite a newer slot", () => {
  const store = createActivityStore({ now: () => 1 });
  const first = store.begin("session-a", { kind: "btw", title: "旁问" });
  const second = store.begin("session-a", { kind: "handoff", title: "交接" });
  store.update("session-a", first.id, { text: "旧答案" });
  assert.equal(store.get("session-a").id, second.id);
  assert.equal(store.get("session-a").text, "");
});

test("the route answers with the slot, idle, and cancellation", async () => {
  const store = createActivityStore({ now: () => 10 });
  const route = createActivityRoute(store);

  const idle = response();
  await route({ url: "/handoff/activity?session=session-a" }, idle);
  assert.equal(idle.status, 200);
  assert.equal(readJson(idle).status, "idle");

  const entry = store.begin("session-a", { kind: "btw", title: "旁问", question: "q" });
  const live = response();
  await route({ url: "/handoff/activity?session=session-a" }, live);
  assert.equal(readJson(live).id, entry.id);

  const controller = new AbortController();
  store.track("session-a", controller);
  const cancelled = response();
  await route({ url: "/handoff/activity?session=session-a&cancel=1" }, cancelled);
  assert.equal(readJson(cancelled).cancelled, true);
  assert.equal(controller.signal.aborted, true);

  const again = response();
  await route({ url: "/handoff/activity?session=session-a&cancel=1" }, again);
  assert.equal(readJson(again).cancelled, false);
});

test("dispose aborts every live request", () => {
  const store = createActivityStore({ now: () => 1 });
  store.begin("session-a", { kind: "btw", title: "旁问" });
  const controller = new AbortController();
  store.track("session-a", controller);
  store.dispose();
  assert.equal(controller.signal.aborted, true);
  assert.equal(store.get("session-a"), undefined);
});
