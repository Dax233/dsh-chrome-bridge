import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_TOKEN = "chrome-bridge-test-token";
process.env.DSH_CHROME_BRIDGE_PORT = "0";
process.env.DSH_CHROME_BRIDGE_TOKEN = TEST_TOKEN;
process.env.DSH_CHROME_BRIDGE_COMMAND_TIMEOUT_MS = "3000";
process.env.DSH_CHROME_BRIDGE_STATE = join(mkdtempSync(join(tmpdir(), "dsh-chrome-host-")), "state.json");
process.env.DSH_CHROME_BRIDGE_SHOT_DIR = join(mkdtempSync(join(tmpdir(), "dsh-chrome-shots-")), "shots");

const plugin = await import("../index.js");

const EXPECTED_ACTIONS = ["status", "tabs", "newTab", "closeTab", "attach", "detach", "navigate", "snapshot", "click", "type", "key", "scroll", "screenshot", "logs", "upload", "evaluate", "wait"];

function makeContext() {
  const tools = [];
  const disposers = [];
  const ctx = {
    effect(execute) {
      const dispose = execute();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
  };
  return {
    ctx,
    tools,
    disposeAll() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
    },
  };
}

function waitOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", (event) => reject(new Error(String(event?.message ?? event))));
  });
}

/** Fake Chrome extension: answers CDP-style commands with canned results. */
function startFakeExtension(port, received) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ext`);
  const answer = (cmd) => {
    switch (cmd.type) {
      case "list-tabs":
        return { ok: true, tabs: [{ id: 1, title: "Example Domain", url: "https://example.com/", active: true }] };
      case "new-tab":
        return { ok: true, tabId: 77, url: cmd.url, active: cmd.active === true };
      case "close-tab":
        return { ok: true, tabId: cmd.tabId };
      case "screenshot":
        return { ok: true, tabId: cmd.tabId, data: Buffer.from("fake-chrome-png").toString("base64") };
      case "attach":
        return { ok: true, tabId: cmd.tabId };
      case "detach":
        return { ok: true, tabId: cmd.tabId };
      case "navigate":
        return { ok: true, tabId: cmd.tabId, url: cmd.url, title: "Example Domain" };
      case "snapshot":
        return {
          ok: true,
          snapshot: {
            title: "Example Domain",
            url: "https://example.com/",
            elements: [{ ref: 0, tag: "a", text: "Learn more", x: 10, y: 20, href: "https://iana.org/help/example-domains" }],
          },
        };
      case "click":
        return { ok: true, x: 10, y: 20, label: "Learn more", navigated: true, url: "https://www.iana.org/help/example-domains" };
      case "type":
        return { ok: true, typed: cmd.text, value: cmd.text };
      case "key":
        return { ok: true, key: cmd.key };
      case "scroll":
        return { ok: true, deltaY: cmd.deltaY, scrollY: 123 };
      case "wait":
        return { ok: true, tabId: cmd.tabId, waitedMs: 12, selector: cmd.selector, text: cmd.text };
      default:
        return { ok: false, error: `unknown ${cmd.type}` };
    }
  };
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "hello-ack") return;
    if (message.type !== "command") return;
    received.push(message.cmd);
    socket.send(JSON.stringify({ type: "result", id: message.id, result: answer(message.cmd) }));
  });
  const ready = waitOpen(socket).then(() => {
    socket.send(JSON.stringify({ type: "hello", name: "fake-extension", version: "0.1.0", token: TEST_TOKEN }));
    return new Promise((resolve) => {
      const onMessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type !== "hello-ack") return;
        socket.removeEventListener("message", onMessage);
        resolve();
      };
      socket.addEventListener("message", onMessage);
    });
  });
  return { socket, ready };
}

async function waitForPort(tool) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = JSON.parse((await tool.execute({ action: "status" })).text);
    if (status.listening && status.port > 0) return status.port;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("chrome bridge did not start");
}

test("host apply() is synchronous and registers the chrome tool", () => {
  const harness = makeContext();
  assert.equal(plugin.apply(harness.ctx), undefined);
  assert.equal(harness.tools.length, 1);
  assert.equal(harness.tools[0].name, "chrome");
  harness.disposeAll();
});

test("DS COMPAT: chrome tool parameters are an object-rooted JSON Schema", () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  const tool = harness.tools[0];
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(tool.parameters.required, ["action"]);
  assert.deepEqual([...tool.parameters.properties.action.enum].sort(), [...EXPECTED_ACTIONS].sort());
  for (const [name, property] of Object.entries(tool.parameters.properties)) {
    assert.notEqual(property.required, true, `parameter "${name}" must not carry the dialect required flag`);
  }
  assert.equal(tool.output.schema.type, "object");
  harness.disposeAll();
});

test("status without an extension explains how to connect", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  try {
    const result = await harness.tools[0].execute({ action: "status" });
    const payload = JSON.parse(result.text);
    assert.match(payload.hint, /no chrome extension connected/i);
    assert.match(payload.hint, /chrome:\/\/extensions/);
    // The extension path is derived from this plugin's location, so a checkout
    // on any drive or directory names its own extension directory. The positive
    // check below is what matters; a checkout may legitimately live under
    // F:\github, so forbidding a specific root would be wrong.
    const expectedDir = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "chrome-extension");
    assert.equal(existsSync(expectedDir), true, "this repository ships the companion extension");
    assert.ok(payload.hint.includes(expectedDir), `expected the hint to name ${expectedDir}: ${payload.hint}`);
  } finally {
    harness.disposeAll();
  }
});

test("unknown actions are rejected", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  try {
    await assert.rejects(() => harness.tools[0].execute({ action: "dance" }));
  } finally {
    harness.disposeAll();
  }
});

test("fake extension drives tabs/attach/navigate/snapshot/click/type/key/scroll", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  const received = [];
  let extension;
  try {
    const port = await waitForPort(harness.tools[0]);
    extension = startFakeExtension(port, received);
    await extension.ready;
    const tool = harness.tools[0];

    const tabs = await tool.execute({ action: "tabs" });
    assert.match(tabs.text, /id=1/);
    assert.match(tabs.text, /Example Domain/);

    const attach = await tool.execute({ action: "attach", tabId: 1 });
    assert.match(attach.text, /tab 1/);

    const navigate = await tool.execute({ action: "navigate", tabId: 1, url: "https://example.com/" });
    assert.match(navigate.text, /navigated/i);

    const snapshot = await tool.execute({ action: "snapshot", tabId: 1 });
    assert.match(snapshot.text, /ref=0/);
    assert.match(snapshot.text, /Learn more/);

    const click = await tool.execute({ action: "click", tabId: 1, ref: 0 });
    assert.match(click.text, /click/i);

    const typed = await tool.execute({ action: "type", tabId: 1, text: "hi" });
    assert.match(typed.text, /typed/i);

    const key = await tool.execute({ action: "key", tabId: 1, key: "Enter" });
    assert.match(key.text, /Enter/);

    const scroll = await tool.execute({ action: "scroll", tabId: 1, deltaY: 300 });
    assert.match(scroll.text, /scrolled/i);

    assert.deepEqual(
      received.map((command) => command.type),
      ["list-tabs", "attach", "navigate", "snapshot", "click", "type", "key", "scroll"],
    );

    const detach = await tool.execute({ action: "detach", tabId: 1 });
    assert.match(detach.text, /tab 1/);

    const created = await tool.execute({ action: "newTab", url: "https://example.com/new" });
    assert.match(created.text, /created tab 77/);
    assert.match(created.text, /background/);

    const shot = await tool.execute({ action: "screenshot", tabId: 1 });
    assert.match(shot.text, /screenshot saved/);
    const shotPath = /screenshot saved: (.+?) \(/u.exec(shot.text)?.[1];
    assert.ok(shotPath, "screenshot text must contain a path");
    assert.equal(existsSync(shotPath), true, "the screenshot file must exist");

    const closed = await tool.execute({ action: "closeTab", tabId: 77 });
    assert.match(closed.text, /closed tab 77/);
    assert.deepEqual(
      received.slice(8).map((command) => command.type),
      ["detach", "new-tab", "screenshot", "close-tab"],
    );
  } finally {
    extension?.socket.close();
    harness.disposeAll();
  }
});

test("wait is a local delay that does not need the extension", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  try {
    const result = await harness.tools[0].execute({ action: "wait", ms: 10 });
    assert.match(result.text, /waited 10ms/);
  } finally {
    harness.disposeAll();
  }
});

test("attach without tabId is rejected", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  try {
    await assert.rejects(() => harness.tools[0].execute({ action: "attach" }));
  } finally {
    harness.disposeAll();
  }
});

test("host dispatch maps logs/upload/evaluate to extension commands", () => {
  const { toCommand, formatResult } = plugin.__test;
  assert.deepEqual(toCommand("logs", { tabId: 7, limit: 5 }), { type: "logs", tabId: 7, limit: 5 });
  assert.deepEqual(toCommand("logs", { tabId: 7, filter: "boom", clear: true }), { type: "logs", tabId: 7, filter: "boom", clear: true });
  assert.deepEqual(toCommand("upload", { tabId: 7, ref: "n12", paths: ["C:\\tmp\\a.txt"] }), {
    type: "upload",
    tabId: 7,
    ref: "n12",
    paths: ["C:\\tmp\\a.txt"],
  });
  assert.deepEqual(toCommand("evaluate", { tabId: 7, expression: "1+1" }), { type: "evaluate", tabId: 7, expression: "1+1" });
  assert.match(formatResult("evaluate", { tabId: 7, value: 2 }), /evaluated in tab 7: 2/);
  assert.match(formatResult("logs", { tabId: 7, entries: [{ type: "console", level: "error", text: "boom" }], total: 1 }), /console error boom/);
  assert.match(formatResult("upload", { tabId: 7, ref: "n12", paths: ["C:\\tmp\\a.txt"] }), /uploaded 1 file/);
  assert.deepEqual(toCommand("wait", { tabId: 7, selector: "#ready", ms: 3000 }), { type: "wait", tabId: 7, selector: "#ready", ms: 3000 });
  assert.match(formatResult("wait", { tabId: 7, waitedMs: 42, selector: "#ready" }), /waited 42ms .*#ready/);
});

test("selector/text waits are dispatched to the extension instead of sleeping locally", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  const received = [];
  let extension;
  try {
    const port = await waitForPort(harness.tools[0]);
    extension = startFakeExtension(port, received);
    await extension.ready;
    const result = await harness.tools[0].execute({ action: "wait", tabId: 1, selector: "#ready", ms: 2000 });
    assert.match(result.text, /waited 12ms .*#ready/);
    assert.deepEqual(received.at(-1), { type: "wait", tabId: 1, selector: "#ready", ms: 2000 });
  } finally {
    try {
      extension?.socket?.close?.();
    } catch {}
    harness.disposeAll();
  }
});

test("snapshot format marks child-frame elements as (iframe)", () => {
  const { formatSnapshot } = plugin.__test;
  const text = formatSnapshot({
    tabId: 1,
    title: "Frames",
    url: "https://example.com/",
    backend: "ax",
    elements: [
      { ref: "n1", role: "link", text: "Outside", depth: 0 },
      { ref: "n2", role: "link", text: "Inside", depth: 0, frame: "frame-2" },
    ],
  });
  const inside = text.split("\n").find((line) => line.includes("Inside"));
  assert.match(inside, /\(iframe\)/);
  const outside = text.split("\n").find((line) => line.includes("Outside"));
  assert.doesNotMatch(outside, /\(iframe\)/);
});

test("formatResult marks iframe script clicks", () => {
  const { formatResult } = plugin.__test;
  const text = formatResult("click", { tabId: 7, label: "link", method: "iframe-script", url: "https://example.com/", changed: true });
  assert.match(text, /\(iframe script click\)/);
  assert.match(text, /\(iframe script click\)/);
});
