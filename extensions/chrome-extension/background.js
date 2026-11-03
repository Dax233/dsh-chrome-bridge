/**
 * DSH Chrome Bridge service worker.
 *
 * Keeps a WebSocket to the DSH Host plugin (`chrome-bridge`) and executes the
 * commands it receives through `chrome.debugger` (controller.js). WebSocket
 * activity keeps the MV3 service worker alive (Chrome 116+); a one-minute alarm
 * reconnects if the worker was suspended anyway.
 */
import { createChromeController } from "./controller.js";

const DEFAULT_PORT = 47835;
const DEFAULT_TOKEN = "dsh-chrome-bridge-local";

let socket = null;
let reconnectTimer = null;
let attempt = 0;
let stopped = false;
let lastNormalWindows;

const controller = createChromeController(chrome, {
  // Window/tab-group changes invalidate the Host's picture of the browser, so
  // push it proactively instead of waiting for the next heartbeat.
  onStateChange: (state) => {
    const windows = typeof state?.normalWindows === "number" ? state.normalWindows : undefined;
    if (windows !== undefined && windows !== lastNormalWindows) {
      const groups = Array.isArray(state?.agentGroups) ? state.agentGroups.length : 0;
      if (windows === 0) {
        console.warn(`[dsh-chrome-bridge] no normal Chrome window (groups=${groups}); newTab will create one`);
      } else {
        console.info(`[dsh-chrome-bridge] browser windows=${windows} tabs=${state?.tabs ?? "?"} agentGroups=${groups}`);
      }
      lastNormalWindows = windows;
    }
    try {
      socket?.send(JSON.stringify({ type: "state", at: Date.now(), state }));
    } catch {
      // The close handler reconnects.
    }
  },
});

async function getConfig() {
  const stored = await chrome.storage.local.get({ port: DEFAULT_PORT, token: DEFAULT_TOKEN });
  return { port: Number(stored.port) || DEFAULT_PORT, token: String(stored.token || DEFAULT_TOKEN) };
}

function scheduleReconnect() {
  if (stopped || reconnectTimer !== null) return;
  const delay = Math.min(1000 * 2 ** Math.min(attempt, 4), 15000);
  attempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

async function connect() {
  if (stopped) return;
  if (socket !== null && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const { port, token } = await getConfig();
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.addEventListener("open", () => {
    attempt = 0;
    lastNormalWindows = undefined;
    console.info(`[dsh-chrome-bridge] connected to Host (ws://127.0.0.1:${port}/ext)`);
    try {
      // The token is a handshake field, not a URL query: URLs leak into logs.
      ws.send(JSON.stringify({ type: "hello", name: "dsh-chrome-bridge", version: "0.1.33", token }));
    } catch {
      // The close handler will reconnect.
    }
  });
  // Commands must run one at a time: two concurrent chrome.debugger commands on
  // the same tab can deadlock (observed: a selector screenshot hung forever while
  // a parallel clip screenshot succeeded). The Host may issue overlapping tool
  // calls, so serialize here instead of relying on the caller.
  let commandQueue = Promise.resolve();
  ws.addEventListener("message", (event) => {
    void (async () => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message === null || typeof message !== "object") return;
      if (message.type === "ping") {
        // Answer the Host heartbeat: this JS message activity keeps the MV3
        // service worker alive between agent commands. The reply also carries a
        // browser-state snapshot so `chrome status` can tell "connected" from
        // "connected but there is no open Chrome window".
        let state;
        try {
          state = await controller.snapshotState();
        } catch {
          state = undefined;
        }
        try {
          ws.send(JSON.stringify(state === undefined ? { type: "pong", at: Date.now() } : { type: "pong", at: Date.now(), state }));
        } catch {
          // The close handler reconnects.
        }
        return;
      }
      if (message.type !== "command" || typeof message.id !== "string") return;
      const socket = ws;
      commandQueue = commandQueue
        .then(async () => {
          const result = await controller.execute(message.cmd);
          try {
            socket.send(JSON.stringify({ type: "result", id: message.id, result }));
          } catch {
            // Connection died mid-command; the Host times out and the next connect resumes.
          }
        })
        .catch(() => {
          // A failed command is reported through its own result; keep the queue alive.
        });
    })();
  });
  ws.addEventListener("close", (event) => {
    if (socket === ws) socket = null;
    const code = typeof event?.code === "number" ? event.code : "?";
    console.warn(`[dsh-chrome-bridge] host connection closed (code ${code}); retrying`);
    // No Host means no more commands can arrive: release chrome.debugger
    // sessions so Chrome's "…is debugging this browser" infobar does not
    // outlive the connection (the next CDP action re-attaches).
    void controller
      .detachAll()
      .then((result) => {
        if (result.detached > 0) console.info(`[dsh-chrome-bridge] detached ${result.detached} tab(s) after Host disconnect`);
      })
      .catch(() => {
        // Best-effort only; never block reconnection.
      });
    scheduleReconnect();
  });
  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {
      // ignore
    }
  });
}

chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || (!changes.port && !changes.token)) return;
  try {
    socket?.close();
  } catch {
    // ignore
  }
  socket = null;
  attempt = 0;
  void connect();
});
chrome.alarms.create("dsh-reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dsh-reconnect") void connect();
});
void connect();
