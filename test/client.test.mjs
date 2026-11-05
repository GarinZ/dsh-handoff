import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Loads `client.js` the way the browser shell does — through
 * `window.__ModuleLoader__.load({ id, factory })` — and applies it against a
 * stub Client context. This catches typos and missing services before a page
 * refresh is the only way to find out.
 */

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useEffect: () => {},
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useSyncExternalStore: (_subscribe, get) => get(),
  useMemo: (factory) => factory()
};

const loadClient = async () => {
  let module;
  globalThis.window = { __ModuleLoader__: { load: (value) => { module = value } } };
  await import(`../client.js?t=${Date.now()}`);
  return module;
};

const require_ = (name) => {
  if (name === "react") return react;
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return { MarkdownText: null };
  throw new Error(`unexpected require: ${name}`);
};

test("the client module registers through the shell loader under the package id", async () => {
  const module = await loadClient();
  assert.equal(module.id, "@garinz/dsh-handoff");
  const exports = module.factory(require_);
  assert.deepEqual(exports.inject, ["slots"]);
  assert.equal(typeof exports.apply, "function");
});

test("apply registers the card in the composer overlay slot and listens for our commands", async () => {
  const module = await loadClient();
  const { apply } = module.factory(require_);

  const registered = [];
  const listeners = new Map();
  const effects = [];
  const style = { textContent: "", remove() { this.removed = true } };

  const slots = {
    inject(name, factory) {
      registered.push({ name, factory });
      return () => {};
    },
    register(options, Component) {
      registered.push({ options, Component });
      return () => {};
    }
  };
  const ctx = {
    effect(factory, label) {
      const cleanup = factory();
      effects.push({ label, cleanup });
      return () => cleanup?.();
    },
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    inject(names, callback) {
      assert.deepEqual(names, ["slots"]);
      callback({ effect: (factory) => ctx.effect(factory, "slot"), slots });
    }
  };

  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  globalThis.document = {
    head: { appendChild: (node) => node },
    createElement: () => style
  };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const originalFetch = globalThis.fetch;
  const originalTimer = globalThis.setTimeout;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: "idle" }) });
  // The card polls forever by design; the stub keeps this process from waiting.
  globalThis.setTimeout = () => 0;

  try {
    apply(ctx);
    assert.ok(effects.some((effect) => effect.label === "handoff activity styles"));

    const overlay = registered.find((entry) => entry.options?.name === "conversation.input.overlay");
    assert.equal(overlay?.options.id, "handoff:activity");
    assert.equal(typeof overlay.Component, "function");

    const executed = listeners.get("command/executed");
    assert.equal(typeof executed, "function");
    // Foreign commands must not open the card.
    executed("session-a", "compact", { kind: "success" });
    // Our commands poll the host route.
    executed("session-a", "btw", { kind: "success" });
  } finally {
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalTimer;
  }
});
