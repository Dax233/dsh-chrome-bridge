import assert from "node:assert/strict";
import { test } from "node:test";
import { createAutoDetach } from "../auto-detach.js";

function harness(overrides = {}) {
  const calls = [];
  const logs = [];
  let clock = 1_000;
  const coordinator = createAutoDetach({
    detach: async (reason) => {
      calls.push(reason);
      return { detached: 2 };
    },
    log: (message) => logs.push(message),
    now: () => clock,
    minIntervalMs: 200,
    ...overrides,
  });
  return { coordinator, calls, logs, advance: (ms) => (clock += ms) };
}

test("auto-detach fires only when the last running turn ends", async () => {
  const { coordinator, calls, advance } = harness();
  coordinator.handleSessionEvent("session-a", { type: "turn/start", data: { turn: 1 } });
  coordinator.handleSessionEvent("session-b", { type: "turn/start", data: { turn: 1 } });
  assert.equal(coordinator.activeTurnCount, 2);
  coordinator.handleSessionEvent("session-a", { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  assert.equal(calls.length, 0, "another turn is still running");
  advance(500);
  coordinator.handleSessionEvent("session-b", { type: "turn/end", data: { turn: 1, reason: { kind: "cancelled" } } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, ["turn-end"]);
  assert.equal(coordinator.activeTurnCount, 0);
  assert.equal(coordinator.last.reason, "turn-end");
  assert.equal(coordinator.last.detached, 2);
});

test("auto-detach ignores unrelated session events", async () => {
  const { coordinator, calls } = harness();
  coordinator.handleSessionEvent("session-a", { type: "assistant/message", data: {} });
  coordinator.handleSessionEvent("session-a", { type: "turn/end", data: {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // A turn/end without a matching turn/start still means no turn is active.
  assert.deepEqual(calls, ["turn-end"]);
});

test("disposing a session that is mid-turn detaches once it is the last one", async () => {
  const { coordinator, calls } = harness();
  coordinator.handleSessionEvent("session-a", { type: "turn/start", data: { turn: 1 } });
  coordinator.handleSessionEvent("session-b", { type: "turn/start", data: { turn: 1 } });
  coordinator.handleSessionDisposed("session-a");
  assert.equal(coordinator.activeTurnCount, 1);
  assert.equal(calls.length, 0);
  coordinator.handleSessionDisposed("session-b");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, ["session-disposed"]);
});

test("auto-detach is disabled by options.enabled=false", async () => {
  const { coordinator, calls } = harness({ enabled: false });
  coordinator.handleSessionEvent("session-a", { type: "turn/start", data: { turn: 1 } });
  coordinator.handleSessionEvent("session-a", { type: "turn/end", data: { turn: 1 } });
  coordinator.handleSessionDisposed("session-a");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, []);
  assert.equal(coordinator.activeTurnCount, 0);
});

test("rapid turn ends are coalesced and the last result is kept", async () => {
  const { coordinator, calls, advance } = harness();
  coordinator.handleSessionEvent("session-a", { type: "turn/start", data: { turn: 1 } });
  coordinator.handleSessionEvent("session-a", { type: "turn/end", data: { turn: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);
  advance(50);
  coordinator.handleSessionEvent("session-b", { type: "turn/start", data: { turn: 1 } });
  coordinator.handleSessionEvent("session-b", { type: "turn/end", data: { turn: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1, "a second detach within minIntervalMs is skipped");
  assert.equal(coordinator.last.detached, 2);
});

test("detach failures are recorded instead of thrown", async () => {
  const logs = [];
  const coordinator = createAutoDetach({
    detach: async () => {
      throw new Error("extension gone");
    },
    log: (message) => logs.push(message),
    now: () => 1_000,
  });
  coordinator.handleSessionEvent("session-a", { type: "turn/start", data: { turn: 1 } });
  coordinator.handleSessionEvent("session-a", { type: "turn/end", data: { turn: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(coordinator.last.detached, 0);
  assert.equal(coordinator.last.error, "extension gone");
  assert.ok(logs.some((line) => line.includes("auto-detach") && line.includes("extension gone")));
});
