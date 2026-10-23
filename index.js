/**
 * Chrome extension bridge — Host half.
 *
 * Pairs with `extensions/chrome-extension/`: the extension holds a WebSocket to
 * this plugin's loopback server and executes CDP actions through
 * `chrome.debugger`. The model drives it with the `chrome` tool.
 */
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createExtensionBridge } from "./ws.js";

export const name = "chrome-extension-bridge";
export const inject = ["tools"];

const PORT = Number(process.env.DSH_CHROME_BRIDGE_PORT ?? 47835);
const TOKEN = process.env.DSH_CHROME_BRIDGE_TOKEN ?? "dsh-chrome-bridge-local";
const STATE_FILE = process.env.DSH_CHROME_BRIDGE_STATE ?? join(tmpdir(), "dsh-chrome-bridge-state.json");
const COMMAND_TIMEOUT_MS = Number(process.env.DSH_CHROME_BRIDGE_COMMAND_TIMEOUT_MS ?? 20_000);
const SHOT_DIR = process.env.DSH_CHROME_BRIDGE_SHOT_DIR ?? join(tmpdir(), "dsh-chrome-shots");

const ACTIONS = ["status", "tabs", "newTab", "closeTab", "attach", "detach", "navigate", "snapshot", "click", "type", "key", "scroll", "screenshot", "logs", "upload", "evaluate", "wait"];

/** Directory of this plugin file, so the companion extension is found next to it. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/** Extension directory in a repository checkout (`<repo>/extensions/chrome-extension`). */
const EXTENSION_DIR = join(PLUGIN_DIR, "extensions", "chrome-extension");

/**
 * The "Load unpacked" directory to name on this machine.
 *
 * A repository checkout keeps the extension next to this plugin; a package
 * install has no `extensions/` sibling, so name it repository-relative instead
 * of printing a path that does not exist here.
 *
 * @returns the absolute directory, or a repository-relative description.
 */
function extensionDirectory() {
  return existsSync(EXTENSION_DIR) ? EXTENSION_DIR : "extensions/chrome-extension from the dsh-plugins repository";
}

/** Connection instructions shown while no extension is attached. */
function connectHint() {
  return (
    "no chrome extension connected. In Chrome open chrome://extensions, enable Developer mode, " +
    "choose Load unpacked and select " +
    extensionDirectory() +
    ", then open the extension's options page once and confirm the pairing token (default: dsh-chrome-bridge-local)"
  );
}

const DESCRIPTION =
  "Control the user's real Chrome through the companion extension (chrome.debugger). " +
  "Only tabs inside the DSH Agent group can be driven: newTab groups automatically, and attach moves an existing tab into the group (the explicit opt-in). " +
    "Use action=tabs to list tabs; prefer action=newTab {url} to open a fresh tab in the background, then " +
  "action=attach with its tabId before other tab actions. " +
  "Actions: newTab {url, active?}, closeTab {tabId}, navigate {tabId,url}, snapshot {tabId}, click {tabId,ref|x,y}, " +
  "type {tabId,text,ref?}, key {tabId,key}, scroll {tabId,deltaY}, screenshot {tabId}, logs {tabId,limit?}, upload {tabId,ref,paths}, detach {tabId}. " +
  "Background tabs stay controllable: chrome.debugger attaches per tab and does not need focus. " +
  "Refs are only valid for the most recent snapshot of that tab.";

function requireTabId(args) {
  const tabId = Number(args.tabId);
  if (!Number.isFinite(tabId) || tabId <= 0) throw new Error("chrome: tabId is required (see action=tabs)");
  return tabId;
}

function requireHttpUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("chrome: url is required");
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("chrome: url is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`chrome: only http:// and https:// are allowed, got ${url.protocol}//`);
  }
  return url.href;
}

function toCommand(action, args) {
  switch (action) {
    case "tabs":
      return { type: "list-tabs" };
    case "newTab":
      return { type: "new-tab", url: requireHttpUrl(args.url), active: args.active === true };
    case "closeTab":
      return { type: "close-tab", tabId: requireTabId(args) };
    case "attach":
      return { type: "attach", tabId: requireTabId(args) };
    case "detach":
      return { type: "detach", tabId: requireTabId(args) };
    case "navigate":
      return { type: "navigate", tabId: requireTabId(args), url: requireHttpUrl(args.url) };
    case "snapshot":
      return { type: "snapshot", tabId: requireTabId(args) };
    case "screenshot":
      return { type: "screenshot", tabId: requireTabId(args) };
    case "click": {
      const command = { type: "click", tabId: requireTabId(args) };
      if (args.ref !== undefined && args.ref !== null) command.ref = String(args.ref);
      else {
        if (!Number.isFinite(Number(args.x)) || !Number.isFinite(Number(args.y))) {
          throw new Error("chrome: click requires a snapshot ref or x and y coordinates");
        }
        command.x = Number(args.x);
        command.y = Number(args.y);
      }
      return command;
    }
    case "type": {
      if (typeof args.text !== "string") throw new Error("chrome: type requires text");
      const command = { type: "type", tabId: requireTabId(args), text: args.text };
      if (args.ref !== undefined && args.ref !== null) command.ref = String(args.ref);
      return command;
    }
    case "key": {
      if (typeof args.key !== "string" || args.key === "") throw new Error("chrome: key requires a key name");
      return { type: "key", tabId: requireTabId(args), key: args.key };
    }
    case "scroll": {
      const deltaY = Number(args.deltaY ?? 400);
      if (!Number.isFinite(deltaY)) throw new Error("chrome: scroll requires a numeric deltaY");
      return { type: "scroll", tabId: requireTabId(args), deltaY };
    }
    case "logs": {
      const command = { type: "logs", tabId: requireTabId(args) };
      if (Number.isFinite(Number(args.limit))) command.limit = Number(args.limit);
      if (typeof args.filter === "string" && args.filter.trim() !== "") command.filter = args.filter.trim();
      if (args.clear === true) command.clear = true;
      return command;
    }
    case "upload": {
      const ref = args.ref !== undefined && args.ref !== null ? String(args.ref) : "";
      if (ref === "") throw new Error("chrome: upload requires the file input ref from a snapshot");
      const paths = Array.isArray(args.paths) ? args.paths.filter((value) => typeof value === "string" && value !== "") : [];
      if (paths.length === 0) throw new Error("chrome: upload requires at least one file path");
      return { type: "upload", tabId: requireTabId(args), ref, paths };
    }
    case "evaluate": {
      if (typeof args.expression !== "string" || args.expression.trim() === "") {
        throw new Error("chrome: evaluate requires an expression");
      }
      return { type: "evaluate", tabId: requireTabId(args), expression: args.expression };
    }
    case "wait": {
      const command = { type: "wait", tabId: requireTabId(args) };
      if (typeof args.selector === "string" && args.selector !== "") command.selector = args.selector;
      if (typeof args.text === "string" && args.text !== "") command.text = args.text;
      if (Number.isFinite(Number(args.ms))) command.ms = Number(args.ms);
      if (command.selector === undefined && command.text === undefined && command.ms === undefined) {
        throw new Error("chrome: wait requires a selector, text or ms");
      }
      return command;
    }
    default:
      throw new Error(`chrome: unknown action "${String(action)}"`);
  }
}

function formatSnapshot(snapshot) {
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  const lines = [];
  lines.push(`tab ${String(snapshot?.tabId ?? "")}`.trim());
  lines.push(`title: ${String(snapshot?.title ?? "")}`);
  lines.push(`url: ${String(snapshot?.url ?? "")}`);
  if (snapshot?.viewport) {
    lines.push(`viewport: ${snapshot.viewport.w}x${snapshot.viewport.h} scrollY=${snapshot.viewport.scrollY ?? 0}`);
  }
  const skipped = Number(snapshot?.skipped ?? 0);
  const omitted = Number(snapshot?.omitted ?? 0);
  const details = [];
  if (skipped > 0) details.push(`${skipped} hidden skipped`);
  if (omitted > 0) details.push(`${omitted} over limit`);
  lines.push(`elements (${elements.length}${details.length > 0 ? `, ${details.join(", ")}` : ""}):`);
  const isAx = snapshot?.backend === "ax" || elements.some((element) => element.role !== undefined);
  if (isAx) {
    const MAX_LINES = 150;
    let previousDepth = -1;
    for (const element of elements.slice(0, MAX_LINES)) {
      const rawDepth = Math.max(0, Math.min(Number(element.depth ?? 0), 8));
      // AX parent chains do not follow document order, so a filtered tree can
      // jump two levels; clamp each step to one level for readable output.
      const depth = previousDepth < 0 ? rawDepth : Math.min(rawDepth, previousDepth + 1);
      previousDepth = depth;
      const ref = element.ref !== undefined && element.ref !== null ? `[${element.ref}] ` : "— ";
      const role = String(element.role ?? "?");
      const text = String(element.text ?? "").replace(/\s+/g, " ").slice(0, 90);
      const value = element.value === undefined ? "" : ` = ${JSON.stringify(String(element.value))}`;
      const checked = element.checked === true ? " [checked]" : "";
      const frame = element.frame !== undefined ? " (iframe)" : "";
      lines.push(`${"  ".repeat(1 + depth)}${ref}${role} "${text}"${value}${checked}${frame}`);
    }
    if (elements.length > MAX_LINES) {
      lines.push(`  ... ${elements.length - MAX_LINES} more in this snapshot; scroll or narrow the page`);
    }
    if (omitted > 0) {
      lines.push(`  ... ${omitted} more elements not shown (limit reached); action=scroll then snapshot again`);
    }
  } else {
    for (const element of elements.slice(0, 60)) {
      const text = String(element.text ?? "").replace(/\s+/g, " ").slice(0, 80);
      const href = element.href ? ` -> ${element.href}` : "";
      lines.push(`  ref=${element.ref} <${element.tag}> "${text}" @${element.x},${element.y}${href}`);
    }
    if (elements.length > 60) lines.push(`  ... ${elements.length - 60} more elements omitted`);
  }
  lines.push("Refs are valid only for this snapshot; take another after the page changes.");
  return lines.join("\n");
}

/** Persist a base64 PNG from CDP Page.captureScreenshot and return its path. */
function saveScreenshot(base64) {
  if (typeof base64 !== "string" || base64 === "") throw new Error("chrome: screenshot returned no image data");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) throw new Error("chrome: screenshot image is empty");
  mkdirSync(SHOT_DIR, { recursive: true });
  const file = join(SHOT_DIR, `chrome-${Date.now()}.png`);
  writeFileSync(file, bytes);
  return { file, bytes: bytes.length };
}

function formatResult(action, value) {
  switch (action) {
    case "tabs": {
      const tabs = Array.isArray(value.tabs) ? value.tabs : [];
      if (tabs.length === 0) return "no visible tabs";
      return tabs
        .map((tab) => `id=${tab.id} "${String(tab.title ?? "").slice(0, 60)}" ${String(tab.url ?? "")}${tab.active ? " (active)" : ""}`)
        .join("\n");
    }
    case "newTab":
      return `created tab ${value.tabId}${value.url ? ` (${value.url})` : ""}${value.active ? " in the foreground" : " in the background"}${
        value.grouped ? " [tab group: DSH Agent]" : ""
      }`;
    case "closeTab":
      return `closed tab ${value.tabId}`;
    case "attach":
      return `attached to tab ${value.tabId}${value.grouped ? " [tab group: DSH Agent]" : ""}${value.groupingError ? ` [grouping failed: ${String(value.groupingError)}]` : ""}`;
    case "detach":
      return `detached from tab ${value.tabId}`;
    case "navigate":
      return `navigated tab ${value.tabId} to ${String(value.url ?? "")}${value.title ? ` (${value.title})` : ""}`;
    case "snapshot":
      return formatSnapshot(value.snapshot);
    case "click":
      if (value.method === "iframe-script" || value.method === "ax-script") {
        return `clicked tab ${value.tabId} ${value.label ? `"${String(value.label).slice(0, 60)}" ` : ""}(iframe script click)${
          value.navigated ? ` — page changed to ${String(value.url ?? "")}` : ""
        }${
          value.navigated !== true && value.changed === false && value.settle?.settled !== false
            ? " — no observable change inside the frame"
            : ""
        }`;
      }
      return `clicked tab ${value.tabId} ${value.label ? `"${String(value.label).slice(0, 60)}" ` : ""}at (${value.x},${value.y})${
        value.navigated ? ` — page changed to ${String(value.url ?? "")}` : ""
      }${value.method === "input+script" ? " [script fallback]" : ""}${
        value.navigated !== true && value.changed === false && value.settle?.settled !== false
          ? " — no observable change; the target may be covered or inert (check the snapshot, or try a coordinate click)"
          : ""
      }`;
    case "type":
      return `typed into tab ${value.tabId}: ${JSON.stringify(String(value.typed ?? ""))}${
        typeof value.value === "string" && value.value !== "" ? ` (focused value: ${JSON.stringify(value.value.slice(0, 120))})` : ""
      }`;
    case "key":
      return `pressed ${String(value.key ?? "")} in tab ${value.tabId}`;
    case "scroll":
      return `scrolled tab ${value.tabId} ${String(value.deltaY ?? "")}${
        typeof value.scrollY === "number" ? ` → scrollY ${value.scrollY}` : ""
      }`;
    case "logs": {
      if (value.cleared === true) return `cleared ${Number(value.clearedCount ?? 0)} console/network entr(y/ies) for tab ${value.tabId}`;
      const entries = Array.isArray(value.entries) ? value.entries : [];
      if (entries.length === 0) {
        return `no console/network entries for tab ${value.tabId} (${Number(value.total ?? 0)} total${value.filter ? `, filter ${JSON.stringify(String(value.filter))}` : ""})`;
      }
      return entries
        .map((entry) => {
          if (entry.type === "network-failed") return `network-failed ${String(entry.errorText ?? "")} ${String(entry.url ?? "")}`.trim();
          if (entry.type === "network") return `network ${entry.status} ${String(entry.url ?? "")}`.trim();
          return `${String(entry.type ?? "log")} ${String(entry.level ?? "")} ${String(entry.text ?? "")}`.trim();
        })
        .join("\n");
    }
    case "upload":
      return `uploaded ${(Array.isArray(value.paths) ? value.paths : []).length} file(s) into tab ${value.tabId} (ref ${String(value.ref ?? "")})`;
    case "evaluate":
      return `evaluated in tab ${value.tabId}: ${JSON.stringify(value.value).slice(0, 800)}`;
    case "wait":
      return `waited ${String(value.waitedMs ?? 0)}ms in tab ${value.tabId}${value.selector ? ` for selector ${value.selector}` : ""}${value.text ? ` for text ${JSON.stringify(value.text)}` : ""}`;
    default:
      return `${action}: ok`;
  }
}

export function apply(ctx) {
  const bridge = createExtensionBridge({
    port: PORT,
    token: TOKEN,
    stateFile: STATE_FILE,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
    log: (message) => console.warn(`[chrome-bridge] ${message}`),
  });
  bridge.start().catch((error) => {
    console.error("[chrome-bridge] failed to start", error);
    bridge.writeState({ error: String(error && error.message ? error.message : error) });
  });
  ctx.effect(() => () => bridge.close(), "chrome-bridge.server");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** The MV3 service worker reconnects within a second or two; wait instead of failing. */
  async function waitForExtension(timeoutMs = 2500) {
    const started = Date.now();
    for (;;) {
      if (bridge.status().extension !== null) return true;
      if (Date.now() - started >= timeoutMs) return false;
      await sleep(100);
    }
  }

  async function sendWithRetry(command) {
    await waitForExtension(2500);
    try {
      return await bridge.sendCommand(command);
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (!/no extension connected|disconnected|socket/i.test(message)) throw error;
      // One reconnect window: the service worker can be suspended right before
      // a command and comes back on the next alarm or message.
      await waitForExtension(3000);
      return await bridge.sendCommand(command);
    }
  }
  ctx.effect(
    () =>
      ctx.tools.register({
        name: "chrome",
        description: DESCRIPTION,
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ACTIONS, description: "The Chrome action to perform." },
            tabId: { type: "integer", description: "Chrome tab id from action=tabs, required by every tab action." },
            url: { type: "string", description: "Absolute http(s) URL for navigate." },
            ref: { type: "string", description: "Element ref from the latest snapshot of that tab, e.g. n123 (host-side backendNodeId)." },
            x: { type: "number", description: "Viewport x for a coordinate click." },
            y: { type: "number", description: "Viewport y for a coordinate click." },
            text: { type: "string", description: "Text to type into the focused element." },
            paths: { type: "array", items: { type: "string" }, description: "Absolute file paths for upload (with ref pointing at a file input)." },
            expression: { type: "string", description: "JavaScript expression for action=evaluate (debugging/inspection)." },
            filter: { type: "string", description: "Keyword filter for action=logs (matches text/url, case-insensitive)." },
            clear: { type: "boolean", description: "Clear the per-tab log buffer for action=logs." },
            selector: { type: "string", description: "CSS selector for action=wait." },
            ms: { type: "number", description: "Timeout/duration in milliseconds for action=wait." },
            key: { type: "string", description: "Key name to press, e.g. Enter, Tab, Escape, ArrowDown." },
            deltaY: { type: "number", description: "Wheel delta in pixels (positive = down)." },
          },
          required: ["action"],
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          render: (_args, value) => [{ type: "text", text: value.text }],
        },
        async execute(args) {
          const action = String(args.action ?? "");
          if (!ACTIONS.includes(action)) throw new Error(`chrome: unknown action "${action}"`);
          if (action === "wait" && args.selector === undefined && args.text === undefined) {
            // A pure delay needs no extension; selector/text waits must ask the page.
            const ms = Math.max(0, Math.min(30_000, Number(args.ms ?? 1000)));
            await sleep(ms);
            return { text: `waited ${ms}ms` };
          }
          if (action === "status") {
            const status = bridge.status();
            const text = status.extension === null
              ? JSON.stringify({ ...status, hint: connectHint() }, null, 2)
              : JSON.stringify(status, null, 2);
            return { text };
          }
          const command = toCommand(action, args);
          if (!(await waitForExtension(2500))) {
            return { text: `chrome: ${connectHint()}` };
          }
          const outcome = await sendWithRetry(command);
          const value = outcome.value;
          if (value === undefined || value === null || value.ok !== true) {
            return { text: `chrome ${action} failed: ${String(value?.error ?? "no result from the extension")}` };
          }
          if (action === "screenshot") {
            const saved = saveScreenshot(value.data);
            return { text: `screenshot saved: ${saved.file} (${saved.bytes} bytes) — call read_image with this path to view it.` };
          }
          return { text: formatResult(action, value) };
        },
      }),
    "chrome-bridge.tool",
  );
}

/** Host-side formatting/dispatch helpers exposed for tests. */
export const __test = { toCommand, formatResult, formatSnapshot };
