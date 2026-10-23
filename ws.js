/**
 * Loopback WebSocket bridge between the DSH Host and the Chrome extension.
 *
 * MV3 service workers must not be driven by a long-poll that can be suspended,
 * so the extension keeps a WebSocket to this server instead. The server speaks
 * RFC 6455 with no dependencies: one handshake, text frames (including 64-bit
 * lengths), fragmentation, ping/pong and close. Only one extension instance is
 * active at a time; a new connection replaces the previous one.
 *
 * Protocol (JSON text frames):
 *   client → { type: "hello", name, version }      server → { type: "hello-ack", ... }
 *   server → { type: "command", id, cmd }          client → { type: "result", id, result }
 *                                                  client → { type: "error", id, message }
 */
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { writeFileSync } from "node:fs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function hostAllowed(host, port) {
  const value = String(host ?? "").toLowerCase();
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

function tokenEquals(provided, expected) {
  const left = Buffer.from(String(provided));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The extension connects with an `Origin: chrome-extension://…` header; web
 * pages must not be able to drive the bridge, so only that scheme is admitted. */
function originAllowed(origin) {
  if (origin === undefined || origin === "") return true;
  return String(origin).startsWith("chrome-extension://");
}

function acceptKey(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Pull complete frames out of a connection's buffer. */
function drainFrames(state) {
  const frames = [];
  for (;;) {
    const buffer = state.buffer;
    if (buffer.length < 2) return frames;
    const first = buffer[0];
    const second = buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length < 4) return frames;
      length = buffer.readUInt16BE(2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return frames;
      const big = buffer.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME_BYTES)) throw new Error("frame too large");
      length = Number(big);
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const total = headerLength + maskLength + length;
    if (buffer.length < total) return frames;
    const mask = masked ? buffer.subarray(headerLength, headerLength + 4) : undefined;
    const payload = Buffer.from(buffer.subarray(headerLength + maskLength, total));
    if (mask !== undefined) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    frames.push({ fin, opcode, payload });
    state.buffer = buffer.subarray(total);
  }
}

/**
 * @param {object} options
 * @param {number} options.port 0 asks the OS for a free port.
 * @param {string} options.token required as the `token` query parameter.
 * @param {string} options.stateFile diagnostics JSON file.
 * @param {number} [options.commandTimeoutMs]
 * @param {number} [options.heartbeatMs]
 * @param {(message: string) => void} [options.log]
 */
export function createExtensionBridge(options) {
  const commandTimeoutMs = options.commandTimeoutMs ?? 20_000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const staleTimeoutMs = options.staleTimeoutMs ?? 45_000;
  const log = options.log ?? (() => {});

  /** The single active extension connection. */
  let client;
  /** commandId -> { resolve, reject, timer, sentAt }. */
  const pending = new Map();
  const sticky = {};
  let server;
  let listeningPort;
  let heartbeat;

  function writeState(extra = {}) {
    const state = {
      at: new Date().toISOString(),
      listening: server !== undefined,
      port: listeningPort,
      extension: client === undefined ? null : { name: client.name, version: client.version, connectedAt: client.connectedAt },
      pending: pending.size,
      ...sticky,
      ...extra,
    };
    try {
      writeFileSync(options.stateFile, JSON.stringify(state, null, 2));
    } catch {
      // Diagnostics must never break the bridge.
    }
    return state;
  }

  function status() {
    return {
      listening: server !== undefined,
      port: listeningPort,
      extension:
        client === undefined
          ? null
          : { name: client.name, version: client.version, connectedAt: client.connectedAt },
      pending: pending.size,
    };
  }

  function send(socket, object) {
    try {
      socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(object), "utf8")));
    } catch (error) {
      log(`write failed: ${String(error)}`);
    }
  }

  function rejectPending(message) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    pending.clear();
  }

  function detach(socket, reason) {
    if (client !== undefined && client.socket === socket) {
      client = undefined;
      rejectPending(`chrome extension disconnected (${reason})`);
      writeState({ lastDisconnect: reason });
    }
  }

  function closeSocket(socket, reason) {
    if (socket.destroyed === true || socket.writableEnded === true) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      return;
    }
    try {
      socket.write(encodeFrame(0x8, Buffer.from(JSON.stringify({ reason }), "utf8")));
    } catch {
      // The socket may be gone already.
    }
    try {
      socket.end();
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }, 100).unref?.();
  }

  function handleMessage(socket, text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      log("ignoring non-JSON frame");
      return;
    }
    if (message === null || typeof message !== "object") return;
    switch (message.type) {
      case "hello": {
        if (typeof message.token !== "string" || !tokenEquals(message.token, options.token)) {
          sticky.lastRejectedToken = new Date().toISOString();
          writeState();
          closeSocket(socket, "bad token");
          return;
        }
        if (client !== undefined && client.socket !== socket) {
          closeSocket(client.socket, "replaced by a newer connection");
        }
        client = {
          socket,
          name: typeof message.name === "string" ? message.name : "chrome-extension",
          version: typeof message.version === "string" ? message.version : "unknown",
          connectedAt: new Date().toISOString(),
          lastSeen: Date.now(),
        };
        send(socket, { type: "hello-ack", server: "dsh-chrome-bridge", version: 1 });
        writeState();
        return;
      }
      case "pong": {
        if (client !== undefined && client.socket === socket) client.lastSeen = Date.now();
        return;
      }
      case "result": {
        const entry = pending.get(String(message.id));
        if (entry === undefined) return;
        pending.delete(String(message.id));
        clearTimeout(entry.timer);
        sticky.lastResult = {
          id: message.id,
          bytes: text.length,
          at: new Date().toISOString(),
          latencyMs: Date.now() - entry.sentAt,
        };
        entry.resolve({ latencyMs: Date.now() - entry.sentAt, value: message.result });
        writeState();
        return;
      }
      case "error": {
        const entry = pending.get(String(message.id));
        if (entry === undefined) return;
        pending.delete(String(message.id));
        clearTimeout(entry.timer);
        entry.reject(new Error(String(message.message ?? "extension error")));
        writeState({ lastError: message.id });
        return;
      }
      case "pong": {
        if (client !== undefined) client.lastSeen = Date.now();
        return;
      }
      default:
        return;
    }
  }

  function onConnection(socket) {
    const state = { buffer: Buffer.alloc(0), fragments: undefined, fragmentOpcode: undefined };
    socket.on("data", (chunk) => {
      state.buffer = state.buffer.length === 0 ? chunk : Buffer.concat([state.buffer, chunk]);
      let frames;
      try {
        frames = drainFrames(state);
      } catch (error) {
        log(`frame parse failed: ${String(error)}`);
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          closeSocket(socket, "client closed");
          detach(socket, "client closed");
          return;
        }
        if (frame.opcode === 0x9) {
          try {
            socket.write(encodeFrame(0xa, frame.payload));
          } catch {
            // ignore
          }
          continue;
        }
        if (frame.opcode === 0xa) continue;
        if (frame.opcode === 0x1 || frame.opcode === 0x2 || frame.opcode === 0x0) {
          if (frame.opcode !== 0x0) {
            state.fragmentOpcode = frame.opcode;
            state.fragments = frame.fin ? undefined : Buffer.from(frame.payload);
            if (frame.fin) {
              if (frame.opcode === 0x1) handleMessage(socket, frame.payload.toString("utf8"));
            }
            continue;
          }
          if (state.fragments !== undefined) {
            state.fragments = Buffer.concat([state.fragments, frame.payload]);
            if (state.fragments.length > MAX_FRAME_BYTES) {
              socket.destroy();
              return;
            }
            if (frame.fin) {
              const complete = state.fragments;
              state.fragments = undefined;
              if (state.fragmentOpcode === 0x1) handleMessage(socket, complete.toString("utf8"));
            }
          }
        }
      }
    });
    socket.on("error", (error) => {
      log(`socket error: ${String(error)}`);
      detach(socket, "socket error");
    });
    socket.on("close", () => detach(socket, "socket closed"));
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = createServer((req, res) => {
        if (!hostAllowed(req.headers.host, listeningPort)) {
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("bad host");
          return;
        }
        const origin = req.headers.origin;
        if (!originAllowed(origin)) {
          sticky.lastRejectedOrigin = origin;
          log(`rejected origin ${origin}`);
          writeState();
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("bad origin");
          return;
        }
        const headers = {
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "content-type, authorization",
          "Access-Control-Max-Age": "600",
          "Cache-Control": "no-store",
          "Vary": "Origin",
        };
        if (typeof origin === "string" && origin !== "") headers["Access-Control-Allow-Origin"] = origin;
        for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method === "GET" && (req.url ?? "").startsWith("/hello")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, service: "dsh-chrome-bridge", port: listeningPort }));
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      });
      server.on("upgrade", (req, socket) => {
        const reject = (status) => {
          socket.write(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Request"}\r\nConnection: close\r\n\r\n`);
          socket.destroy();
        };
        if (!hostAllowed(req.headers.host, listeningPort)) {
          sticky.lastRejectedHost = String(req.headers.host ?? "");
          writeState();
          reject(403);
          return;
        }
        const origin = req.headers.origin;
        if (!originAllowed(origin)) {
          sticky.lastRejectedOrigin = origin;
          log(`rejected upgrade origin ${origin}`);
          writeState();
          reject(403);
          return;
        }
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${listeningPort ?? 1}`);
        if (url.pathname !== "/ext") {
          reject(400);
          return;
        }
        const key = req.headers["sec-websocket-key"];
        if (typeof key !== "string" || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
          socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
        );
        onConnection(socket);
        writeState({ lastConnection: new Date().toISOString() });
      });
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        listeningPort = server.address().port;
        heartbeat = setInterval(() => {
          if (client === undefined) return;
          // App-level ping/pong is JS activity, which keeps an MV3 service
          // worker alive; protocol-level pings alone do not.
          if (Date.now() - (client.lastSeen ?? 0) > staleTimeoutMs) {
            log("extension heartbeat timed out; dropping the connection");
            const stale = client.socket;
            closeSocket(stale, "heartbeat timeout");
            detach(stale, "heartbeat timeout");
            return;
          }
          send(client.socket, { type: "ping", at: Date.now() });
        }, heartbeatMs);
        heartbeat.unref?.();
        writeState({ listening: true });
        resolve(listeningPort);
      });
    });
  }

  function sendCommand(cmd, timeoutMs = commandTimeoutMs) {
    if (client === undefined) return Promise.reject(new Error("no extension connected"));
    const id = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sticky.lastCommand = { id, type: cmd?.type, at: new Date().toISOString(), timeoutMs };
    writeState();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        sticky.lastTimeout = { id, type: cmd?.type, at: new Date().toISOString(), afterMs: timeoutMs };
        writeState();
        reject(new Error("chrome bridge: no extension result before timeout"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, sentAt: Date.now() });
      send(client.socket, { type: "command", id, cmd });
    });
  }

  function close() {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
    if (client !== undefined) closeSocket(client.socket, "server closing");
    client = undefined;
    rejectPending("chrome bridge disposed");
    server?.closeAllConnections?.();
    server?.close();
    server = undefined;
    writeState({ listening: false });
  }

  return { start, close, sendCommand, status, writeState, sticky };
}
