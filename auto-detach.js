/**
 * Turn-end auto-detach coordination for the Chrome bridge.
 *
 * The bridge WebSocket intentionally stays connected across turns (the Host is
 * a long-lived control plane), but a `chrome.debugger` session — and the Chrome
 * infobar "…is debugging this browser" it shows — should not outlive the agent
 * work that needed it. DSH emits a durable `turn/end` session event for every
 * turn (including cancellation), so the Host detaches every tab once the last
 * running turn (subagent turns included) ends.
 *
 * Pure logic with an injected `detach`, so the lifecycle rules are unit-tested
 * without a live Host or browser.
 */

/**
 * @param {object} options
 * @param {(reason: string) => Promise<{detached?: number, skipped?: boolean, error?: string}>} options.detach
 * @param {boolean} [options.enabled] false disables the whole coordinator
 * @param {(message: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {number} [options.minIntervalMs] coalesce rapid subagent turn ends
 */
export function createAutoDetach(options) {
  const enabled = options?.enabled !== false;
  const detach = options?.detach;
  const log = options?.log ?? (() => {});
  const now = options?.now ?? (() => Date.now());
  const minIntervalMs = Number.isFinite(Number(options?.minIntervalMs)) ? Math.max(0, Number(options.minIntervalMs)) : 200;

  /** sessionId -> { turn, startedAt }. Turn/start and turn/end are durable events. */
  const activeTurns = new Map();
  let lastRunAt = -Infinity;
  let lastResult = null;

  async function run(reason) {
    if (!enabled || typeof detach !== "function") return null;
    const at = now();
    if (at - lastRunAt < minIntervalMs) return lastResult;
    lastRunAt = at;
    try {
      const result = (await detach(reason)) ?? {};
      lastResult = { at: new Date(at).toISOString(), reason, detached: Number(result.detached ?? 0), ...(result.error === undefined ? {} : { error: String(result.error) }) };
      if (lastResult.detached > 0) log(`auto-detach after ${reason}: ${lastResult.detached} tab(s)`);
      return lastResult;
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      lastResult = { at: new Date(at).toISOString(), reason, detached: 0, error: message };
      log(`auto-detach after ${reason} failed: ${message}`);
      return lastResult;
    }
  }

  return {
    /** Feed durable session events; only turn/start and turn/end matter here. */
    handleSessionEvent(sessionId, event) {
      if (!enabled || typeof sessionId !== "string" || event === null || typeof event !== "object") return;
      if (event.type === "turn/start") {
        activeTurns.set(sessionId, { turn: event.data?.turn, startedAt: now() });
        return;
      }
      if (event.type !== "turn/end") return;
      activeTurns.delete(sessionId);
      // Another session (parent/child subagent) is still inside its turn; keep
      // the debugger sessions until the last one finishes.
      if (activeTurns.size === 0) void run("turn-end");
    },
    /** A session left the live registry (archived/closed). */
    handleSessionDisposed(sessionId) {
      if (!enabled) return;
      if (typeof sessionId === "string") activeTurns.delete(sessionId);
      if (activeTurns.size === 0) void run("session-disposed");
    },
    /** Diagnostics for tests and the Host status payload. */
    get activeTurnCount() {
      return activeTurns.size;
    },
    get last() {
      return lastResult;
    },
  };
}
