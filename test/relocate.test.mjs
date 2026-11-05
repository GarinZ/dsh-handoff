import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { encodeSegment, firstZstdFrameEnd, projectKey, relocateSession } from "../lib/relocate.js";

const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

test("projectKey folds separators and escapes unsafe units", () => {
  assert.equal(projectKey("/Users/garin/Project/x"), "--Users-garin-Project-x--");
  assert.equal(projectKey("/tmp/a b"), "--tmp-a~0020b--");
  assert.equal(projectKey("C:\\work\\repo"), "--C-work-repo--");
  assert.equal(projectKey("/"), "--root--");
});

test("encodeSegment keeps safe names and escapes the rest", () => {
  assert.equal(encodeSegment("session-abc_1.0"), "session-abc_1.0");
  assert.equal(encodeSegment("a:b"), "a~003Ab");
  assert.equal(encodeSegment("."), "~002E");
  assert.equal(encodeSegment(".."), "~002E~002E");
});

/** A session log is a header frame followed by one or more event frames. */
function encodeLog(header, events) {
  const headerFrame = zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, "utf8"), CHECKSUM);
  const bodyFrame = zstdCompressSync(Buffer.from(events.map((event) => `${JSON.stringify(event)}\n`).join(""), "utf8"), CHECKSUM);
  return Buffer.concat([headerFrame, bodyFrame]);
}

function fakeServices(root) {
  const attached = [];
  const detached = [];
  const indexed = [];
  const workspaces = new Map();
  const makeWorkspace = (path) => {
    const workspace = {
      id: `ws-${path}`,
      path,
      title: path.split("/").pop() || path,
      attachSession: async (id) => attached.push([path, id]),
      detachSession: async (id) => detached.push([path, id])
    };
    workspaces.set(path, workspace);
    return workspace;
  };
  return {
    attached,
    detached,
    indexed,
    services: {
      persistence: { config: { root }, tracker: { writers: new Map() }, flush: async () => {} },
      registry: {
        list: () => [...workspaces.values()],
        resolveByPath: async (path) => workspaces.get(path),
        create: async (path) => makeWorkspace(path),
        indexHeader: async (header) => indexed.push({ ...header })
      }
    }
  };
}

test("relocateSession rewrites the header frame, keeps the body, and swaps the ledger", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-handoff-test-")));
  try {
    const sourceDir = join(root, "source-project");
    const targetDir = join(root, "target-project");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await mkdir(join(root, projectKey(targetDir)), { recursive: true });
    const oldDir = join(root, projectKey(sourceDir), encodeSegment("session-demo"));
    await mkdir(oldDir, { recursive: true });
    const header = { type: "session", version: 4, id: "session-demo", createdAt: 1, cwd: sourceDir, isSeeded: false };
    const events = [
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      { type: "user/message", seq: 1, time: 2, data: { role: "user", content: [{ type: "text", text: "hi" }] }, surfaceOp: "append" }
    ];
    const originalBytes = encodeLog(header, events);
    const originalBody = originalBytes.subarray(firstZstdFrameEnd(originalBytes));
    await writeFile(join(oldDir, "session.v4.jsonl.zstd"), originalBytes);

    const { services, attached, indexed } = fakeServices(root);
    const live = { header };
    const result = await relocateSession(services, { id: "session-demo", header, session: live }, targetDir);

    assert.equal(result.changed, true);
    assert.equal(result.cwd, targetDir);
    const newPath = join(root, projectKey(targetDir), encodeSegment("session-demo"), "session.v4.jsonl.zstd");
    const movedBytes = await readFile(newPath);
    const headerFrame = movedBytes.subarray(0, firstZstdFrameEnd(movedBytes));
    const movedHeader = JSON.parse(zstdDecompressSync(headerFrame).toString("utf8").trim());
    assert.equal(movedHeader.cwd, targetDir, "header cwd is rewritten");
    assert.equal(movedHeader.id, "session-demo");
    assert.deepEqual(movedBytes.subarray(firstZstdFrameEnd(movedBytes)), originalBody, "event frames are preserved byte for byte");
    const bodyText = zstdDecompressSync(movedBytes.subarray(firstZstdFrameEnd(movedBytes))).toString("utf8");
    assert.deepEqual(bodyText.trim().split("\n").map((line) => JSON.parse(line)), events);
    assert.equal(live.header.cwd, targetDir, "the live header is re-pinned");
    assert.deepEqual(attached, [[targetDir, "session-demo"]]);
    assert.equal(indexed.at(-1).cwd, targetDir);

    await assert.rejects(readFile(join(oldDir, "session.v4.jsonl.zstd")), "the old directory is dropped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relocateSession refuses a target that already holds the session", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-handoff-test-")));
  try {
    const sourceDir = join(root, "source-project");
    const targetDir = join(root, "target-project");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const header = { type: "session", version: 4, id: "session-demo", createdAt: 1, cwd: sourceDir, isSeeded: false };
    for (const dir of [sourceDir, targetDir]) {
      const sessionDir = join(root, projectKey(dir), encodeSegment("session-demo"));
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, "session.v4.jsonl.zstd"), encodeLog(header, []));
    }
    const { services } = fakeServices(root);
    await assert.rejects(
      relocateSession(services, { id: "session-demo", header, session: { header } }, targetDir),
      /already exists/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relocateSession into the same directory only ensures the workspace", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-handoff-test-")));
  try {
    const dir = join(root, "same-project");
    await mkdir(dir, { recursive: true });
    const header = { type: "session", version: 4, id: "session-demo", createdAt: 1, cwd: dir, isSeeded: false };
    const { services } = fakeServices(root);
    const result = await relocateSession(services, { id: "session-demo", header }, dir);
    assert.equal(result.changed, false);
    assert.equal(result.cwd, dir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
