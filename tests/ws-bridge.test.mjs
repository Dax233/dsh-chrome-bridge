import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createExtensionBridge } from "../ws.js";

const TOKEN = "ws-test-token";
const tempState = () => join(mkdtempSync(join(tmpdir(), "dsh-ws-test-")), "state.json");

function makeBridge(overrides = {}) {
  return createExtensionBridge({
    port: 0,
    token: TOKEN,
    stateFile: tempState(),
    commandTimeoutMs: 2000,
    ...overrides,
  });
}

/** Browser WebSocket client (no Origin header, like a local tool). */
function connect(port) {
  return new WebSocket(`ws://127.0.0.1:${port}/ext`);
}

function waitOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", (event) => reject(new Error(`socket error: ${String(event?.message ?? event)}`)));
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      cleanup();
      resolve(JSON.parse(String(event.data)));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before a message arrived"));
    };
    const onError = (event) => {
      cleanup();
      reject(new Error(`socket error: ${String(event?.message ?? event)}`));
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

async function hello(socket, token = TOKEN) {
  socket.send(JSON.stringify({ type: "hello", name: "fake-extension", version: "0.1.0", token }));
  const ack = await nextMessage(socket);
  assert.equal(ack.type, "hello-ack");
  return ack;
}

/** Raw HTTP upgrade probe for Host/Origin checks (browser clients cannot set them). */
function rawUpgrade(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/ext",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
          ...headers,
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers }));
      },
    );
    request.on("upgrade", (response) => {
      response.on("error", () => {});
      resolve({ status: 101, headers: response.headers, socket: response });
    });
    request.on("error", reject);
    request.end();
  });
}

test("extension bridge: starts, reports status, and closes cleanly", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    assert.ok(port > 0);
    const status = bridge.status();
    assert.equal(status.listening, true);
    assert.equal(status.extension, null);
  } finally {
    bridge.close();
  }
});

test("extension bridge: rejects a hello with a wrong token", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    const socket = connect(port);
    await waitOpen(socket);
    const closed = new Promise((resolve) => socket.addEventListener("close", () => resolve("closed")));
    const error = new Promise((resolve) => socket.addEventListener("error", () => resolve("error")));
    socket.send(JSON.stringify({ type: "hello", name: "fake", version: "0", token: "wrong-token" }));
    const outcome = await Promise.race([closed, error, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000))]);
    assert.notEqual(outcome, "timeout", "a wrong hello token must not be accepted");
    assert.equal(bridge.status().extension, null);
  } finally {
    bridge.close();
  }
});

test("extension bridge: a token in the URL query is ignored (hello token required)", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ext?token=${TOKEN}`);
    await waitOpen(socket);
    const closed = new Promise((resolve) => socket.addEventListener("close", () => resolve("closed")));
    socket.send(JSON.stringify({ type: "hello", name: "fake", version: "0" }));
    const outcome = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000))]);
    assert.notEqual(outcome, "timeout", "query tokens must not authenticate the handshake");
    assert.equal(bridge.status().extension, null);
  } finally {
    bridge.close();
  }
});

test("extension bridge: rejects a foreign Host header", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    const response = await rawUpgrade(port, { host: "evil.example" });
    assert.equal(response.status, 403);
    assert.equal(bridge.sticky.lastRejectedHost, "evil.example");
  } finally {
    bridge.close();
  }
});

test("extension bridge: rejects a web page Origin", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    const response = await rawUpgrade(port, { origin: "https://evil.example" });
    assert.equal(response.status, 403);
    assert.equal(bridge.sticky.lastRejectedOrigin, "https://evil.example");
  } finally {
    bridge.close();
  }
});

test("extension bridge: admits a chrome-extension Origin", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    const response = await rawUpgrade(port, { origin: "chrome-extension://abcdefghijklmnop" });
    assert.equal(response.status, 101);
    response.socket.destroy();
  } finally {
    bridge.close();
  }
});

test("extension bridge: hello handshake then a command round-trip", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    const socket = connect(port);
    await waitOpen(socket);
    await hello(socket);
    assert.equal(bridge.status().extension?.name, "fake-extension");
    const command = bridge.sendCommand({ type: "ping" });
    const delivered = await nextMessage(socket);
    assert.equal(delivered.type, "command");
    assert.deepEqual(delivered.cmd, { type: "ping" });
    socket.send(JSON.stringify({ type: "result", id: delivered.id, result: { ok: true, pong: true } }));
    const outcome = await command;
    assert.equal(outcome.value.pong, true);
    assert.ok(outcome.latencyMs >= 0);
    socket.close();
  } finally {
    bridge.close();
  }
});

test("extension bridge: sends a payload large enough for a 64-bit frame length", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    const socket = connect(port);
    await waitOpen(socket);
    await hello(socket);
    const payload = "x".repeat(200_000);
    const command = bridge.sendCommand({ type: "echo", payload });
    const delivered = await nextMessage(socket);
    assert.equal(delivered.cmd.type, "echo");
    assert.equal(delivered.cmd.payload.length, payload.length);
    socket.send(JSON.stringify({ type: "result", id: delivered.id, result: { ok: true, bytes: payload.length } }));
    const outcome = await command;
    assert.equal(outcome.value.bytes, payload.length);
    socket.close();
  } finally {
    bridge.close();
  }
});

test("extension bridge: sendCommand fails fast when no extension is connected", async () => {
  const bridge = makeBridge();
  await bridge.start();
  try {
    await assert.rejects(() => bridge.sendCommand({ type: "ping" }), /no extension connected/i);
  } finally {
    bridge.close();
  }
});

test("extension bridge: a new connection replaces the previous extension instance", async () => {
  const bridge = makeBridge();
  const port = await bridge.start();
  try {
    const first = connect(port);
    await waitOpen(first);
    await hello(first);
    const firstClosed = new Promise((resolve) => first.addEventListener("close", () => resolve()));
    const second = connect(port);
    await waitOpen(second);
    await hello(second);
    await firstClosed;
    assert.equal(bridge.status().extension?.name, "fake-extension");
    second.close();
  } finally {
    bridge.close();
  }
});

test("extension bridge: heartbeat pings and drops a stale extension", async () => {
  const bridge = makeBridge({ heartbeatMs: 40, staleTimeoutMs: 250 });
  const port = await bridge.start();
  try {
    const socket = connect(port);
    await waitOpen(socket);
    await hello(socket);
    const ping = await nextMessage(socket);
    assert.equal(ping.type, "ping");
    socket.send(JSON.stringify({ type: "pong" }));
    // Stop answering: the bridge must drop the stale extension instead of
    // reporting a connected-but-dead socket forever.
    const closed = new Promise((resolve) => socket.addEventListener("close", () => resolve(true)));
    const outcome = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(false), 2000))]);
    assert.equal(outcome, true);
    assert.equal(bridge.status().extension, null);
  } finally {
    bridge.close();
  }
});
