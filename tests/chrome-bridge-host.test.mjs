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

const EXPECTED_ACTIONS = ["status", "tabs", "newTab", "closeTab", "attach", "detach", "navigate", "snapshot", "click", "type", "key", "scroll", "screenshot", "emulate", "logs", "upload", "evaluate", "wait"];

/** Minimal PNG header: the host only parses the IHDR pixel size. */
function makePngHeader(width, height) {
  const bytes = Buffer.alloc(33);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

/** Minimal JPEG: SOI + APP0 + SOF0 carrying width/height. */
function makeJpegHeader(width, height) {
  const bytes = Buffer.alloc(26);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe0;
  bytes.writeUInt16BE(4, 4);
  bytes[8] = 0xff;
  bytes[9] = 0xc0;
  bytes.writeUInt16BE(17, 10);
  bytes[12] = 8;
  bytes.writeUInt16BE(height, 13);
  bytes.writeUInt16BE(width, 15);
  bytes[17] = 3;
  return bytes;
}

/** Minimal lossless WebP wrapper with a VP8X (extended) header. */
function makeWebpHeader(width, height) {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "latin1");
  bytes.write("VP8X", 12, "latin1");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

const PNG_1X1_BASE64 = makePngHeader(1, 1).toString("base64");
const JPEG_120X90_BASE64 = makeJpegHeader(120, 90).toString("base64");
const WEBP_320X240_BASE64 = makeWebpHeader(320, 240).toString("base64");

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
      case "screenshot": {
        const format = cmd.format === "jpeg" ? "jpeg" : cmd.format === "webp" ? "webp" : "png";
        const data = format === "jpeg" ? JPEG_120X90_BASE64 : format === "webp" ? WEBP_320X240_BASE64 : PNG_1X1_BASE64;
        return {
          ok: true,
          tabId: cmd.tabId,
          data,
          format,
          ...(cmd.quality === undefined ? {} : { quality: cmd.quality }),
          capture: {
            mode: cmd.fullPage === true ? "fullPage" : cmd.clip !== undefined ? "clip" : "viewport",
            ...(cmd.clip === undefined ? {} : { clip: { ...cmd.clip }, width: Math.round(cmd.clip.width), height: Math.round(cmd.clip.height) }),
          },
        };
      }
      case "emulate":
        if (cmd.reset === true) {
          return { ok: true, tabId: cmd.tabId, reset: true, viewport: { width: 1280, height: 800, devicePixelRatio: 1 }, colorScheme: "light" };
        }
        return {
          ok: true,
          tabId: cmd.tabId,
          reset: false,
          emulated: {
            ...(cmd.width === undefined
              ? {}
              : { width: cmd.width, height: cmd.height, deviceScaleFactor: cmd.deviceScaleFactor ?? 0, mobile: cmd.mobile === true }),
            ...(cmd.colorScheme === undefined ? {} : { colorScheme: cmd.colorScheme }),
          },
          viewport: { width: cmd.width ?? 1280, height: cmd.height ?? 800, devicePixelRatio: cmd.deviceScaleFactor ?? 1 },
          colorScheme: cmd.colorScheme ?? "light",
        };
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
        return {
          ok: true,
          tabId: cmd.tabId,
          waitedMs: 12,
          selector: cmd.selector,
          text: cmd.text,
          ...(cmd.networkIdle === true
            ? { networkIdle: { pendingRequests: 0, idleMs: cmd.idleMs ?? 500, idleForMs: 900 } }
            : {}),
        };
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

test("QA screenshot and emulate parameters are declared in the tool schema", () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  try {
    const properties = harness.tools[0].parameters.properties;
    assert.ok(properties.action.enum.includes("emulate"), "emulate must be a top-level action");
    assert.deepEqual(properties.format.enum, ["png", "jpeg", "webp"]);
    assert.equal(properties.fullPage.type, "boolean");
    assert.equal(properties.clip.type, "object");
    for (const key of ["x", "y", "width", "height", "scale"]) {
      assert.equal(properties.clip.properties[key].type, "number", `clip.${key} must be a number`);
    }
    assert.equal(properties.quality.type, "number");
    assert.equal(properties.width.type, "number");
    assert.equal(properties.height.type, "number");
    assert.equal(properties.deviceScaleFactor.type, "number");
    assert.equal(properties.mobile.type, "boolean");
    assert.deepEqual(properties.colorScheme.enum, ["light", "dark"]);
    assert.equal(properties.reset.type, "boolean");
    assert.equal(properties.networkIdle.type, "boolean");
    assert.equal(properties.idleMs.type, "number");
    for (const [name, property] of Object.entries(properties)) {
      assert.notEqual(property.required, true, `parameter "${name}" must not carry the dialect required flag`);
    }
  } finally {
    harness.disposeAll();
  }
});

test("toCommand validates and builds QA screenshot commands", () => {
  const { toCommand } = plugin.__test;
  assert.deepEqual(toCommand("screenshot", { tabId: 7 }), { type: "screenshot", tabId: 7 });
  assert.deepEqual(toCommand("screenshot", { tabId: 7, format: "JPEG", quality: 80.4, ref: "n12" }), {
    type: "screenshot",
    tabId: 7,
    format: "jpeg",
    quality: 80,
    ref: "n12",
  });
  assert.deepEqual(toCommand("screenshot", { tabId: 7, fullPage: true, format: "png" }), {
    type: "screenshot",
    tabId: 7,
    format: "png",
    fullPage: true,
  });
  assert.deepEqual(toCommand("screenshot", { tabId: 7, clip: { x: 1, y: 2, width: 30, height: 40, scale: 2 } }), {
    type: "screenshot",
    tabId: 7,
    clip: { x: 1, y: 2, width: 30, height: 40, scale: 2 },
  });
  assert.deepEqual(toCommand("screenshot", { tabId: 7, selector: "  #hero  " }), { type: "screenshot", tabId: 7, selector: "#hero" });
  assert.throws(() => toCommand("screenshot", { tabId: 7, format: "gif" }), /format/);
  assert.throws(() => toCommand("screenshot", { tabId: 7, quality: 50 }), /quality only applies/);
  assert.throws(() => toCommand("screenshot", { tabId: 7, format: "jpeg", quality: 120 }), /between 0 and 100/);
  assert.throws(() => toCommand("screenshot", { tabId: 7, clip: { x: 0, y: 0, width: 0, height: 10 } }), /positive/);
  assert.throws(() => toCommand("screenshot", { tabId: 7, clip: { x: 0, y: 0, width: 10, height: 10 }, ref: "n1" }), /only one of/);
  assert.throws(() => toCommand("screenshot", { tabId: 7, clip: { x: 0, y: 0, width: 10 } }), /clip.height/);
});

test("toCommand validates and builds QA emulation commands", () => {
  const { toCommand } = plugin.__test;
  assert.deepEqual(toCommand("emulate", { tabId: 7, width: 390, height: 844 }), { type: "emulate", tabId: 7, width: 390, height: 844 });
  assert.deepEqual(
    toCommand("emulate", { tabId: 7, width: 390.4, height: 844, deviceScaleFactor: 2, mobile: true, colorScheme: "Dark" }),
    { type: "emulate", tabId: 7, width: 390, height: 844, deviceScaleFactor: 2, mobile: true, colorScheme: "dark" },
  );
  assert.deepEqual(toCommand("emulate", { tabId: 7, colorScheme: "light" }), { type: "emulate", tabId: 7, colorScheme: "light" });
  assert.deepEqual(toCommand("emulate", { tabId: 7, reset: true }), { type: "emulate", tabId: 7, reset: true });
  assert.throws(() => toCommand("emulate", { tabId: 7, width: 390 }), /both width and height/);
  assert.throws(() => toCommand("emulate", { tabId: 7, deviceScaleFactor: 2 }), /requires width and height/);
  assert.throws(() => toCommand("emulate", { tabId: 7, width: 0, height: 844 }), /positive/);
  assert.throws(() => toCommand("emulate", { tabId: 7, colorScheme: "sepia" }), /light.*dark/);
  assert.throws(() => toCommand("emulate", { tabId: 7 }), /requires width\/height/);
});

test("wait networkIdle is validated and formatted", () => {
  const { toCommand, formatResult } = plugin.__test;
  assert.deepEqual(toCommand("wait", { tabId: 7, networkIdle: true, idleMs: 750, ms: 5000 }), {
    type: "wait",
    tabId: 7,
    networkIdle: true,
    idleMs: 750,
    ms: 5000,
  });
  assert.deepEqual(toCommand("wait", { tabId: 7, networkIdle: true }), { type: "wait", tabId: 7, networkIdle: true });
  assert.throws(() => toCommand("wait", { tabId: 7, idleMs: 200 }), /networkIdle/);
  assert.throws(() => toCommand("wait", { tabId: 7 }), /requires/);
  const text = formatResult("wait", { tabId: 7, waitedMs: 900, selector: "#ready", networkIdle: { pendingRequests: 0, idleMs: 500 } });
  assert.match(text, /waited 900ms .*#ready/);
  assert.match(text, /network idle \(500ms, 0 pending\)/);
});

test("wait best-effort networkIdle is formatted with the long-lived-requests note", () => {
  const { formatResult } = plugin.__test;
  const text = formatResult("wait", {
    tabId: 7,
    waitedMs: 2000,
    networkIdle: { pendingRequests: 3, idleMs: 500, idleForMs: 120, timedOut: true, ignoredTypes: { WebSocket: 2 } },
    warning: "networkIdle not reached within 2000ms: best-effort continuation (3 pending...)",
  });
  assert.match(text, /waited 2000ms/);
  assert.match(text, /best-effort: still 3 pending \(long-lived requests such as beacons may never reach idle\)/);
  assert.match(text, /\[.*best-effort.*\]/);
});

test("screenshot image headers yield real pixel dimensions", () => {
  const { imageSize } = plugin.__test;
  assert.deepEqual(imageSize(makePngHeader(640, 480), "png"), { width: 640, height: 480 });
  assert.deepEqual(imageSize(makeJpegHeader(1200, 900), "jpeg"), { width: 1200, height: 900 });
  assert.deepEqual(imageSize(makeWebpHeader(320, 240), "webp"), { width: 320, height: 240 });
  assert.equal(imageSize(Buffer.from("not-an-image"), "png"), undefined);
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff]), "jpeg"), undefined);
});

test("saveScreenshot writes the format extension and reports parsed pixels", () => {
  const { saveScreenshot } = plugin.__test;
  const png = saveScreenshot(makePngHeader(8, 6).toString("base64"), "png");
  assert.match(png.file, /\.png$/);
  assert.equal(existsSync(png.file), true);
  assert.equal(png.format, "png");
  assert.deepEqual(png.image, { width: 8, height: 6 });
  const jpeg = saveScreenshot(makeJpegHeader(64, 32).toString("base64"), "jpeg");
  assert.match(jpeg.file, /\.jpg$/);
  assert.equal(existsSync(jpeg.file), true);
  assert.deepEqual(jpeg.image, { width: 64, height: 32 });
  const webp = saveScreenshot(makeWebpHeader(16, 16).toString("base64"), "webp");
  assert.match(webp.file, /\.webp$/);
  assert.deepEqual(webp.image, { width: 16, height: 16 });
  assert.throws(() => saveScreenshot("AAAA", "gif"), /unknown format/);
  assert.throws(() => saveScreenshot("", "png"), /no image data/);
});

test("formatResult reports screenshot format/pixels/path and emulation state", () => {
  const { formatResult } = plugin.__test;
  const shot = formatResult("screenshot", {
    tabId: 1,
    file: "C:\\shots\\a.jpg",
    format: "jpeg",
    bytes: 4096,
    image: { width: 120, height: 90 },
    capture: { mode: "ref", clip: { x: 1, y: 2, width: 120, height: 90 } },
  });
  assert.match(shot, /screenshot saved: C:\\shots\\a\.jpg \(jpeg, 120x90 px, 4096 bytes, ref\)/);
  const mismatch = formatResult("screenshot", {
    tabId: 1,
    file: "/tmp/a.png",
    bytes: 10,
    image: { width: 100, height: 50 },
    capture: { mode: "fullPage", width: 120, height: 60 },
  });
  assert.match(mismatch, /controller expected 120x60/);
  const emulated = formatResult("emulate", {
    tabId: 3,
    reset: false,
    emulated: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, colorScheme: "dark" },
    viewport: { width: 390, height: 844, devicePixelRatio: 2 },
    colorScheme: "dark",
  });
  assert.match(emulated, /emulated tab 3: viewport 390x844 @2x \(mobile\), colorScheme dark/);
  assert.match(emulated, /actual viewport 390x844 @2x/);
  const reset = formatResult("emulate", {
    tabId: 3,
    reset: true,
    viewport: { width: 1280, height: 800, devicePixelRatio: 1 },
    colorScheme: "light",
  });
  assert.match(reset, /reset emulation for tab 3/);
  assert.match(reset, /actual viewport 1280x800 @1x, colorScheme light/);
  assert.match(formatResult("detach", { tabId: 3, emulationReset: true }), /emulation restored/);
  assert.match(formatResult("closeTab", { tabId: 3, emulationReset: true }), /emulation restored/);
});

test("invalid QA parameters are rejected before contacting the extension", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  try {
    const tool = harness.tools[0];
    await assert.rejects(() => tool.execute({ action: "emulate", tabId: 1 }), /requires width\/height/);
    await assert.rejects(() => tool.execute({ action: "screenshot", tabId: 1, format: "gif" }), /format/);
    await assert.rejects(() => tool.execute({ action: "wait", tabId: 1, ms: 1, idleMs: 200 }), /networkIdle/);
  } finally {
    harness.disposeAll();
  }
});

test("fake extension round-trips screenshot formats, emulation and networkIdle waits", async () => {
  const harness = makeContext();
  plugin.apply(harness.ctx);
  const received = [];
  let extension;
  try {
    const port = await waitForPort(harness.tools[0]);
    extension = startFakeExtension(port, received);
    await extension.ready;
    const tool = harness.tools[0];

    const png = await tool.execute({ action: "screenshot", tabId: 1 });
    assert.match(png.text, /screenshot saved/);
    assert.match(png.text, /\(png, 1x1 px/);
    const pngPath = /screenshot saved: (.+?) \(/u.exec(png.text)?.[1];
    assert.ok(pngPath?.endsWith(".png"), `expected a .png path, got ${pngPath}`);

    const jpeg = await tool.execute({ action: "screenshot", tabId: 1, format: "jpeg", quality: 70, fullPage: true });
    assert.match(jpeg.text, /\(jpeg, 120x90 px/);
    assert.match(jpeg.text, /fullPage/);
    const jpegPath = /screenshot saved: (.+?) \(/u.exec(jpeg.text)?.[1];
    assert.ok(jpegPath?.endsWith(".jpg"), `expected a .jpg path, got ${jpegPath}`);
    assert.deepEqual(received.at(-1), { type: "screenshot", tabId: 1, format: "jpeg", quality: 70, fullPage: true });

    const emulated = await tool.execute({
      action: "emulate",
      tabId: 1,
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
      colorScheme: "dark",
    });
    assert.deepEqual(received.at(-1), {
      type: "emulate",
      tabId: 1,
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
      colorScheme: "dark",
    });
    assert.match(emulated.text, /emulated tab 1/);
    assert.match(emulated.text, /390x844/);
    assert.match(emulated.text, /colorScheme dark/);

    const reset = await tool.execute({ action: "emulate", tabId: 1, reset: true });
    assert.deepEqual(received.at(-1), { type: "emulate", tabId: 1, reset: true });
    assert.match(reset.text, /reset emulation/);

    const waited = await tool.execute({ action: "wait", tabId: 1, networkIdle: true, idleMs: 750, ms: 3000 });
    assert.deepEqual(received.at(-1), { type: "wait", tabId: 1, networkIdle: true, idleMs: 750, ms: 3000 });
    assert.match(waited.text, /network idle \(750ms, 0 pending\)/);
  } finally {
    extension?.socket.close();
    harness.disposeAll();
  }
});
