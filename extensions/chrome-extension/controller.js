/**
 * Chrome extension controller: CDP actions through `chrome.debugger`.
 *
 * Extracted from the service worker so it can be unit-tested in Node with a
 * mocked `chrome` API (see tests/chrome-extension-controller.test.mjs).
 * The page scripts are the same ones the sidebar browser uses; refs live in the
 * page (`window.__dshAgentRefs`) and are resolved immediately before an action.
 */

const ATTACH_VERSION = "1.3";
const AGENT_GROUP_TITLE = "DSH Agent";
const AGENT_GROUP_COLOR = "orange";

const SNAPSHOT_JS = `(() => {
  // __dshAgentSnapshot
  const selector = 'a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=checkbox], [contenteditable=true]';
  const nodes = [...document.querySelectorAll(selector)].slice(0, 400);
  const refs = new Map();
  const elements = [];
  let skipped = 0;
  for (const el of nodes) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
    if (!visible) { skipped += 1; continue; }
    const ref = elements.length;
    refs.set(ref, el);
    elements.push({
      ref,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 100),
      href: el.getAttribute('href') || undefined,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      w: Math.round(rect.width),
      h: Math.round(rect.height)
    });
  }
  window.__dshAgentRefs = refs;
  return {
    title: document.title,
    url: location.href,
    viewport: { w: innerWidth, h: innerHeight, scrollY: Math.round(scrollY) },
    count: elements.length,
    skipped,
    elements
  };
})()`;

const CLICK_TARGET_JS = (ref) => `(() => {
  // __dshAgentClickTarget
  const refs = window.__dshAgentRefs;
  const el = refs ? refs.get(${Number(ref)}) : undefined;
  if (!el || !el.isConnected) return { ok: false, error: 'element ref not found; take a new snapshot' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = el.getBoundingClientRect();
  const clamp = (value, max) => Math.max(0, Math.min(Math.round(value), Math.max(0, max - 1)));
  const x = clamp(rect.left + rect.width / 2, innerWidth);
  const y = clamp(rect.top + rect.height / 2, innerHeight);
  const hit = document.elementFromPoint(x, y);
  return {
    ok: true, x, y,
    label: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
    hitTrusted: hit === el || el.contains(hit) || (hit !== null && hit.contains(el))
  };
})()`;

const CLICK_FALLBACK_JS = (ref) => `(() => {
  // __dshAgentClickFallback
  const refs = window.__dshAgentRefs;
  const el = refs ? refs.get(${Number(ref)}) : undefined;
  if (!el || !el.isConnected) return { ok: false, error: 'element ref not found; take a new snapshot' };
  el.click();
  return { ok: true, clicked: true };
})()`;

const FOCUS_JS = (ref) => `(() => {
  // __dshAgentFocus
  const refs = window.__dshAgentRefs;
  const el = refs ? refs.get(${Number(ref)}) : undefined;
  if (!el || !el.isConnected) return { ok: false, error: 'element ref not found; take a new snapshot' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();
  if (typeof el.select === 'function') { try { el.select(); } catch (error) {} }
  return { ok: true };
})()`;

const CURSOR_MOVE_JS = (x, y) => `(() => {
  // __dshAgentCursorMove
  const ID = '__dshAgentCursor';
  let host = document.getElementById(ID);
  if (!host) {
    host = document.createElement('div');
    host.id = ID;
    host.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;will-change:transform';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = '.cursor{position:absolute;left:0;top:0;width:20px;height:20px;transform:translate(-6px,-4px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.55));}';
    shadow.appendChild(style);
    const cursor = document.createElement('div');
    cursor.className = 'cursor';
    cursor.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M2 2l8 19 2.5-7.5L20 11 2 2z" fill="#fbbf24" stroke="#111" stroke-width="1.2"/></svg>';
    shadow.appendChild(cursor);
    document.documentElement.appendChild(host);
  }
  host.style.transform = 'translate(' + ${Number(x)} + 'px,' + ${Number(y)} + 'px)';
  return { moved: true, x: ${Number(x)}, y: ${Number(y)} };
})()`;

const SCROLL_STATE_JS = `(() => {
  // __dshAgentScrollState
  const doc = document.scrollingElement || document.documentElement;
  return {
    scrollY: Math.round(window.scrollY || doc.scrollTop || 0),
    scrollHeight: Math.round(doc.scrollHeight || 0),
    innerHeight: Math.round(window.innerHeight || 0)
  };
})()`;

const SCROLL_FALLBACK_JS = (deltaY) => `(() => {
  // __dshAgentScrollFallback
  window.scrollBy(0, ${Number(deltaY)});
  return { scrolled: true };
})()`;

const FOCUSED_VALUE_JS = `(() => {
  // __dshAgentFocusedValue
  const el = document.activeElement;
  if (!el) return { value: '' };
  if ('value' in el && typeof el.value === 'string') return { value: el.value, tag: el.tagName.toLowerCase() };
  return { value: (el.innerText || '').trim().slice(0, 200), tag: el.tagName.toLowerCase() };
})()`;

const PAGE_INFO_JS = `(() => ({ title: document.title, url: location.href }))()`;

/**
 * Page-side viewport readback after an emulation change. One frame lets layout
 * settle, but rAF is throttled/paused in hidden tabs (the bridge drives
 * background tabs too), so a short timer races the frame instead of hanging.
 */
const VIEWPORT_METRICS_JS = `(async () => { // __dshAgentViewportMetrics
  const frame = new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const fallback = new Promise((resolve) => setTimeout(resolve, 250));
  await Promise.race([frame, fallback]);
  return {
    width: innerWidth,
    height: innerHeight,
    devicePixelRatio: devicePixelRatio,
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  };
})()`;

/**
 * Viewport coordinates of a selector match, for Page.captureScreenshot clip.
 * The element is scrolled into view first (with an instant scroll) and the
 * result is a getBoundingClientRect-style viewport rect.
 */
const SELECTOR_RECT_JS = (selector) => `(async () => { // __dshAgentSelectorRect
  const el = document.querySelector(${JSON.stringify(String(selector ?? ""))});
  if (!el) return { found: false };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await Promise.race([nextFrame(), new Promise((resolve) => setTimeout(resolve, 200))]);
  const rect = el.getBoundingClientRect();
  return { found: true, x: rect.left, y: rect.top, width: rect.width, height: rect.height };
})()`;

/** Viewport coordinates of the resolved AX node, for Page.captureScreenshot clip. */
const ELEMENT_RECT_FN = `async function () { // __dshAgentElementRect
  this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await Promise.race([nextFrame(), new Promise((resolve) => setTimeout(resolve, 200))]);
  const rect = this.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}`;

const SCREENSHOT_FORMATS = new Set(["png", "jpeg", "webp"]);
/** Full-page capture cap (CSS px) and the websocket frame budget for base64 data. */
const FULL_PAGE_MAX_CSS_PX = 12000;
const MAX_CAPTURE_BASE64 = 7 * 1024 * 1024;

/**
 * Every override a QA emulation can apply. Chrome drops CDP overrides when the
 * debugger session ends, but an explicit detach/close/reset should restore the
 * real tab immediately rather than waiting for that.
 */
const EMULATION_RESET_CALLS = [
  ["Emulation.clearDeviceMetricsOverride", {}],
  ["Emulation.setEmulatedMedia", { features: [] }],
  ["Emulation.setTouchEmulationEnabled", { enabled: false }],
];

const KEY_CODES = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
};

const SETTLE_JS = `(async () => {  // __dshAgentSettle
  const started = performance.now();
  let lastMutation = Date.now();
  let mutations = 0;
  let observer;
  try {
    observer = new MutationObserver((records) => {
      mutations += records.length;
      lastMutation = Date.now();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch (error) {
    return { settled: false, mutations: 0, waitedMs: 0, quietMs: 0, error: String(error && error.message ? error.message : error) };
  }
  while (true) {
    const elapsed = performance.now() - started;
    const idle = Date.now() - lastMutation;
    if ((mutations > 0 && idle >= 100) || elapsed >= 3000) {
      observer.disconnect();
      return { settled: true, mutations, waitedMs: Math.round(elapsed), quietMs: Math.round(idle) };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
})()`;

const AX_INTERACTIVE_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "option",
]);
const AX_INFO_ROLES = new Set(["heading", "main", "navigation", "search", "article", "region"]);
/** Browser UI that Chrome leaks into the tab accessibility tree (translate/Lens bubbles, context menus). */
const AX_UI_NAME_PATTERNS = [
  /图片翻译/,
  /语音翻译/,
  /添加到收藏夹/,
  /关闭\s*\(\s*Esc\s*\)/i,
  /快捷设置/,
  /image translation/i,
  /voice translation/i,
  /add to favorites/i,
  /close\s*\(\s*esc\s*\)/i,
  /quick settings/i,
];
const AX_VIEWPORT_JS = "(() => ({ w: innerWidth, h: innerHeight, scrollY: Math.round(scrollY) }))()";
const EDITABLE_JS = "(() => { // __dshAgentEditable const el = document.activeElement; const tag = el ? el.tagName.toLowerCase() : ''; const editable = !!el && (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true); return { editable, tag, value: editable ? String(el.value !== undefined ? el.value : el.innerText || '') : '' }; })()";
const WAIT_JS = (selector, text) => {
  // Values must be interpolated into the page expression; referencing host
  // variables inside Runtime.evaluate would throw a page-side ReferenceError.
  // Both conditions are ANDed: wait{selector, networkIdle} must satisfy each.
  const selectorCheck = selector !== undefined
    ? `const selectorFound = document.querySelector(${JSON.stringify(selector)}) !== null;`
    : "const selectorFound = true;";
  const textCheck = text !== undefined
    ? `const textFound = (document.body ? document.body.innerText : "").includes(${JSON.stringify(text)});`
    : "const textFound = true;";
  return `(() => { // __dshAgentWait\n${selectorCheck}\n${textCheck}\nreturn { found: selectorFound && textFound, selectorFound, textFound };\n})()`;
};
const SUBMIT_FORM_JS = `(() => {
  const el = document.activeElement;
  const form = el && el.form;
  if (!form) return { submitted: false, reason: "no form for the focused element" };
  if (typeof form.requestSubmit === "function") { form.requestSubmit(); return { submitted: true, method: "requestSubmit" }; }
  if (typeof form.submit === "function") { form.submit(); return { submitted: true, method: "submit" }; }
  return { submitted: false, reason: "form has no submit method" };
})()`;

function toHttpUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("url is required");
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("url is not valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`only http:// and https:// are allowed, got ${url.protocol}//`);
  }
  return url.href;
}

function tabIdOf(value) {
  const tabId = Number(value);
  if (!Number.isFinite(tabId) || tabId <= 0) throw new Error("tabId is required");
  return tabId;
}

/**
 * @param chrome - the MV3 `chrome` API surface used by the controller.
 * @param options - test hooks: `stalePendingMs` overrides the networkIdle
 *   abandoned-request window.
 */
export function createChromeController(chromeApi, options = {}) {
  const attached = new Set();
  /** tabId -> Map(ref, { backendDOMNodeId, role }); refs are host-side, never in the page. */
  const refsByTab = new Map();
  /** tabId -> Map(frameId, {x,y}) offsets from the main frame viewport. */
  const frameOffsetsByTab = new Map();
  /** tabId -> bounded console/network entries captured from CDP events. */
  const logBuffers = new Map();
  let eventsWired = false;
  let agentGroupId;

  function bufferFor(tabId) {
    let buffer = logBuffers.get(tabId);
    if (buffer === undefined) {
      buffer = [];
      logBuffers.set(tabId, buffer);
    }
    return buffer;
  }

  /** tabId -> { pending: Map<requestId, startedAt>, lastActivity: epoch ms } for networkIdle waits. */
  const networkByTab = new Map();
  /** tabId -> accumulated CDP emulation overrides, so detach/close can restore the tab. */
  const emulationByTab = new Map();
  /**
   * Older than this, an in-flight request is treated as abandoned. Chromium may
   * never emit Network.loadingFinished for a response body the page never
   * consumes (observed with a fire-and-forget `fetch()` on a real tab); clearing
   * it keeps `wait {networkIdle}` from wedging forever. Overridable in tests.
   */
  const stalePendingMs = Number.isFinite(Number(options?.stalePendingMs)) && Number(options.stalePendingMs) > 0 ? Number(options.stalePendingMs) : 120000;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Drop every per-tab record; used by detach, closeTab and Chrome-side tab removal. */
  function releaseTabState(tabId) {
    attached.delete(tabId);
    refsByTab.delete(tabId);
    logBuffers.delete(tabId);
    networkByTab.delete(tabId);
    emulationByTab.delete(tabId);
  }

  function networkStateFor(tabId) {
    let state = networkByTab.get(tabId);
    if (state === undefined) {
      state = { pending: new Map(), lastActivity: Date.now() };
      networkByTab.set(tabId, state);
    }
    return state;
  }

  function markNetworkStarted(tabId, requestId) {
    const state = networkStateFor(tabId);
    if (typeof requestId === "string" && requestId !== "") state.pending.set(requestId, Date.now());
    state.lastActivity = Date.now();
  }

  function markNetworkDone(tabId, requestId) {
    const state = networkStateFor(tabId);
    if (typeof requestId === "string" && requestId !== "") state.pending.delete(requestId);
    state.lastActivity = Date.now();
  }

  /**
   * In-flight requests plus how long the tab has been quiet. A tab with no
   * recorded activity is idle: Network.enable runs at attach, so anything that
   * started earlier is outside this session's window (documented limitation).
   * Pending entries older than `stalePendingMs` are abandoned (Chromium can
   * withhold loadingFinished for an unread response body), so they must not
   * wedge networkIdle forever.
   */
  function networkIdleSnapshot(tabId) {
    const state = networkByTab.get(tabId);
    if (state === undefined) return { pendingRequests: 0, idleForMs: Number.POSITIVE_INFINITY };
    const cutoff = Date.now() - stalePendingMs;
    for (const [requestId, startedAt] of state.pending) {
      if (!(startedAt > cutoff)) state.pending.delete(requestId);
    }
    return { pendingRequests: state.pending.size, idleForMs: Date.now() - state.lastActivity };
  }

  function wireDebuggerEvents() {
    if (eventsWired) return;
    eventsWired = true;
    const onEvent = chromeApi.debugger?.onEvent;
    if (typeof onEvent?.addListener !== "function") return;
    onEvent.addListener((source, method, params) => {
      const tabId = source?.tabId;
      if (typeof tabId !== "number") return;
      const buffer = bufferFor(tabId);
      if (method === "Runtime.consoleAPICalled") {
        buffer.push({ type: "console", level: String(params?.type ?? ""), text: (Array.isArray(params?.args) ? params.args : []).map((arg) => String(arg?.value ?? arg?.description ?? arg?.type ?? "")).join(" ").slice(0, 500) });
      } else if (method === "Log.entryAdded") {
        const entry = params?.entry ?? {};
        buffer.push({ type: "log", level: String(entry.level ?? ""), text: String(entry.text ?? "").slice(0, 500), url: entry.url });
      } else if (method === "Network.requestWillBeSent") {
        markNetworkStarted(tabId, String(params?.requestId ?? ""));
      } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        markNetworkDone(tabId, String(params?.requestId ?? ""));
        if (method === "Network.loadingFailed") {
          buffer.push({ type: "network-failed", url: String(params?.url ?? ""), errorText: String(params?.errorText ?? "") });
        }
      } else if (method === "Network.responseReceived") {
        const status = Number(params?.response?.status ?? 0);
        if (status >= 400) buffer.push({ type: "network", status, url: String(params?.response?.url ?? "").slice(0, 300) });
      } else {
        return;
      }
      if (buffer.length > 120) buffer.splice(0, buffer.length - 120);
    });
  }

  /**
   * Chrome-side lifecycle bookkeeping. A tab closed by the user (or a debugger
   * session Chrome ends itself, e.g. the user dismisses the infobar) must not
   * leave stale refs/emulation records behind. CDP overrides die with the
   * session, so removal here only needs to drop bookkeeping.
   */
  function wireTabEvents() {
    const onRemoved = chromeApi.tabs?.onRemoved;
    if (typeof onRemoved?.addListener === "function") {
      onRemoved.addListener((tabId) => {
        if (typeof tabId === "number") releaseTabState(tabId);
      });
    }
    const onDetach = chromeApi.debugger?.onDetach;
    if (typeof onDetach?.addListener === "function") {
      onDetach.addListener((source) => {
        const tabId = source?.tabId;
        if (typeof tabId === "number") releaseTabState(tabId);
      });
    }
  }

  /**
   * Put one tab into the "DSH Agent" tab group so the user can tell agent work
   * apart from their own tabs. Failures are reported, never fatal: a tab group
   * needs the tabGroups permission and older Chrome builds may lack the API.
   */
  async function agentGroupIdNow() {
    if (agentGroupId !== undefined) return agentGroupId;
    try {
      const groups = await chromeApi.tabGroups.query({ title: AGENT_GROUP_TITLE });
      if (Array.isArray(groups) && groups.length > 0) agentGroupId = groups[0].id;
    } catch {
      agentGroupId = undefined;
    }
    return agentGroupId;
  }

  /**
   * ACL: once a DSH Agent group exists, only tabs inside it may be driven.
   * attach() is the explicit opt-in (it moves the tab into the group); before
   * any agent tab exists there is nothing to guard.
   */
  async function assertAgentTab(tabId) {
    const group = await agentGroupIdNow();
    if (group === undefined) return;
    let tab;
    try {
      tab = await chromeApi.tabs.get(tabId);
    } catch {
      throw new Error(`tab ${tabId} not found`);
    }
    if (tab?.groupId === group) return;
    if (await waitForGroupMembership(tabId, group, 600)) return;
    throw new Error(`tab ${tabId} is not in the DSH Agent group; call attach first to opt it in`);
  }

  async function tabGroupOf(tabId) {
    try {
      const tab = await chromeApi.tabs.get(tabId);
      return tab?.groupId;
    } catch {
      return undefined;
    }
  }

  async function waitForGroupMembership(tabId, groupId, timeoutMs = 600) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await tabGroupOf(tabId)) === groupId) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }

  async function ensureAgentGroup(tabId) {
    try {
      if (agentGroupId === undefined && typeof chromeApi.tabGroups?.query === "function") {
        const existing = await chromeApi.tabGroups.query({ title: AGENT_GROUP_TITLE });
        if (Array.isArray(existing) && existing.length > 0) agentGroupId = existing[0].id;
      }
      let groupId;
      try {
        const options = { tabIds: [tabId] };
        if (agentGroupId !== undefined) options.groupId = agentGroupId;
        groupId = await chromeApi.tabs.group(options);
      } catch (error) {
        // A cached group id can outlive the actual group after Chrome restarts.
        agentGroupId = undefined;
        groupId = await chromeApi.tabs.group({ tabIds: [tabId] });
      }
      agentGroupId = groupId;
      try {
        await chromeApi.tabGroups.update(groupId, {
          title: AGENT_GROUP_TITLE,
          color: AGENT_GROUP_COLOR,
          collapsed: false,
        });
      } catch {
        // A group without a title/colour still separates the tabs visually.
      }
      const applied = await waitForGroupMembership(tabId, groupId);
      if (!applied) {
        return { grouped: false, groupId, groupingError: "Chrome did not apply the tab group membership" };
      }
      return { grouped: true, groupId };
    } catch (error) {
      return { grouped: false, groupingError: String(error && error.message ? error.message : error) };
    }
  }

  async function send(tabId, method, params = {}) {
    return chromeApi.debugger.sendCommand({ tabId }, method, params);
  }

  async function evaluate(tabId, expression) {
    const response = await send(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response?.exceptionDetails) throw new Error(String(response.exceptionDetails.text ?? "page evaluation failed"));
    return response?.result?.value;
  }

  async function pageInfo(tabId) {
    try {
      const info = await evaluate(tabId, PAGE_INFO_JS);
      return { url: typeof info?.url === "string" ? info.url : "", title: typeof info?.title === "string" ? info.title : "" };
    } catch {
      return { url: "", title: "" };
    }
  }

  /** Wait for the page's DOM to quiet down (navigation destroys the context). */
  async function settlePage(tabId) {
    try {
      const result = await evaluate(tabId, SETTLE_JS);
      return result !== null && typeof result === "object" ? result : { settled: false };
    } catch {
      return { settled: false, navigatedAway: true };
    }
  }

  async function ensureAttached(tabId) {
    if (attached.has(tabId)) return;
    await chromeApi.debugger.attach({ tabId }, ATTACH_VERSION);
    attached.add(tabId);
    await send(tabId, "Page.enable");
    await send(tabId, "Runtime.enable");
    wireDebuggerEvents();
    await send(tabId, "Log.enable").catch(() => {});
    await send(tabId, "Network.enable").catch(() => {});
    try {
      // A background tab has no focus; emulating it makes event handlers and
      // hit-testing behave as if the user were watching, which background input
      // dispatch needs.
      await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
    } catch {
      // Older Chrome or restricted targets: continue without focus emulation.
    }
  }

  function axProperty(node, name) {
    const entry = Array.isArray(node?.properties) ? node.properties.find((property) => property?.name === name) : undefined;
    return entry?.value?.value;
  }

  async function axViewport(tabId) {
    try {
      return await evaluate(tabId, AX_VIEWPORT_JS);
    } catch {
      return undefined;
    }
  }

  /** Build frameId -> offset map by walking Page.getFrameTree and iframe boxes. */
  async function buildFrameOffsets(tabId) {
    try {
      await send(tabId, "DOM.enable").catch(() => {});
      await send(tabId, "DOM.getDocument", { depth: 0 }).catch(() => {});
      const tree = await send(tabId, "Page.getFrameTree");
      const frameTree = tree?.frameTree;
      if (frameTree === undefined) return undefined;
      const offsets = new Map();
      const rootId = String(frameTree.frame?.id ?? "");
      offsets.set(rootId, { x: 0, y: 0 });
      const walk = async (node, parentOffset) => {
        for (const child of node.childFrames ?? []) {
          const frameId = String(child.frame?.id ?? "");
          let offset = parentOffset;
          try {
            const owner = await send(tabId, "DOM.getFrameOwner", { frameId });
            const backendNodeId = owner?.backendNodeId;
            if (typeof backendNodeId === "number") {
              const nodeId = await axNodeId(tabId, backendNodeId);
              const model = await send(tabId, "DOM.getBoxModel", { nodeId });
              const quad = model?.model?.content ?? model?.content;
              if (Array.isArray(quad) && quad.length >= 8) {
                const xs = [quad[0], quad[2], quad[4], quad[6]];
                const ys = [quad[1], quad[3], quad[5], quad[7]];
                offset = {
                  x: parentOffset.x + Math.round(Math.min(...xs)),
                  y: parentOffset.y + Math.round(Math.min(...ys)),
                };
              }
            }
          } catch {
            offset = parentOffset;
          }
          offsets.set(frameId, offset);
          await walk(child, offset);
        }
      };
      await walk(frameTree, { x: 0, y: 0 });
      return { mainFrameId: rootId, offsets, frameIds: [...offsets.keys()] };
    } catch {
      return undefined;
    }
  }

  /**
   * Snapshot from Accessibility.getFullAXTree: refs are keyed by
   * backendDOMNodeId, resolved again on the host at action time, so page JS
   * cannot forge or clobber them and they survive re-renders.
   */
  async function axSnapshot(tabId) {
    try {
      const frameData = await buildFrameOffsets(tabId);
      const mainFrameId = frameData?.mainFrameId;
      const frameOffsets = frameData?.offsets;
      await send(tabId, "Accessibility.enable").catch(() => {});
      const trees = [];
      try {
        const mainTree = await send(tabId, "Accessibility.getFullAXTree");
        trees.push({ frameId: mainFrameId, nodes: Array.isArray(mainTree?.nodes) ? mainTree.nodes : [] });
      } catch {
        // No main tree: fall through to an empty snapshot.
      }
      if (frameData !== undefined) {
        for (const frameId of frameData.frameIds) {
          if (frameId === mainFrameId) continue;
          if (!frameOffsets.has(frameId)) continue;
          try {
            const childTree = await send(tabId, "Accessibility.getFullAXTree", { frameId });
            if (Array.isArray(childTree?.nodes) && childTree.nodes.length > 0) {
              trees.push({ frameId, nodes: childTree.nodes });
            }
          } catch {
            // OOPIF or an unsupported target: skip this frame.
          }
        }
      }
      const candidates = [];
      let skipped = 0;
      for (const tree of trees) {
        const byId = new Map(tree.nodes.map((node) => [node.nodeId, node]));
        for (const node of tree.nodes) {
          const role = String(node?.role?.value ?? "");
          if (node.ignored === true || node.backendDOMNodeId === undefined || node.backendDOMNodeId === null) {
            skipped += 1;
            continue;
          }
          if (!AX_INTERACTIVE_ROLES.has(role) && !AX_INFO_ROLES.has(role)) {
            skipped += 1;
            continue;
          }
          const axName = String(node?.name?.value ?? "");
          if (AX_UI_NAME_PATTERNS.some((pattern) => pattern.test(axName))) {
            skipped += 1;
            continue;
          }
          if (role === "button" && axName.trim() === "") {
            skipped += 1;
            continue;
          }
          let depth = 0;
          let parent = byId.get(node.parentId);
          while (parent !== undefined && depth < 8) {
            depth += 1;
            parent = byId.get(parent.parentId);
          }
          const value = axProperty(node, "value");
          const checked = axProperty(node, "checked");
          candidates.push({
            key: `${tree.frameId ?? "main"}:${node.nodeId}`,
            parentKey: `${tree.frameId ?? "main"}:${node.parentId ?? ""}`,
            frameId: tree.frameId,
            backendDOMNodeId: node.backendDOMNodeId,
            role,
            text: axName.slice(0, 100),
            ...(value === undefined ? {} : { value: String(value).slice(0, 80) }),
            ...(checked === true ? { checked: true } : {}),
            depth,
          });
        }
      }
      let resolvable;
      try {
        await send(tabId, "DOM.enable").catch(() => {});
        await send(tabId, "DOM.getDocument", { depth: 0 }).catch(() => {});
        if (candidates.length > 0) {
          const ids = candidates.map((candidate) => candidate.backendDOMNodeId);
          const pushed = await send(tabId, "DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: ids });
          if (Array.isArray(pushed?.nodeIds) && pushed.nodeIds.length === ids.length) {
            const kept = [];
            for (let index = 0; index < ids.length; index += 1) {
              const nodeId = pushed.nodeIds[index];
              if (typeof nodeId !== "number" || nodeId === 0) continue;
              const candidate = candidates[index];
              kept.push({ backendId: candidate.backendDOMNodeId, frameId: candidate.frameId });
            }
            resolvable = new Map(kept.map((entry) => [entry.backendId, entry.frameId]));
          }
        }
      } catch {
        resolvable = undefined;
      }
      const usable = resolvable !== undefined && resolvable.size > 0
        ? candidates.filter((candidate) => resolvable.has(candidate.backendDOMNodeId))
        : candidates;
      const keptKeys = new Set(usable.map((candidate) => candidate.key));
      const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
      const depthOf = (candidate) => {
        let depth = 0;
        let parent = byKey.get(candidate.parentKey);
        while (parent !== undefined && depth < 8) {
          if (keptKeys.has(parent.key)) depth += 1;
          parent = byKey.get(parent.parentKey);
        }
        return depth;
      };
      const mainUsable = usable.filter((candidate) => candidate.frameId === undefined || mainFrameId === undefined || candidate.frameId === mainFrameId);
      const childUsable = usable.filter((candidate) => candidate.frameId !== undefined && mainFrameId !== undefined && candidate.frameId !== mainFrameId);
      const chosen = childUsable.length === 0
        ? mainUsable.slice(0, 150)
        : [...mainUsable.slice(0, 120), ...childUsable.slice(0, 30)].slice(0, 150);
      const elements = chosen.map((candidate) => {
        const inChildFrame = candidate.frameId !== undefined && mainFrameId !== undefined && candidate.frameId !== mainFrameId;
        return {
          ref: `n${candidate.backendDOMNodeId}`,
          role: candidate.role,
          text: candidate.text,
          ...(candidate.value === undefined ? {} : { value: candidate.value }),
          ...(candidate.checked === true ? { checked: true } : {}),
          ...(inChildFrame ? { frame: candidate.frameId } : {}),
          depth: depthOf(candidate),
        };
      });
      if (elements.length === 0) return undefined;
      const viewport = await axViewport(tabId);
      const frames = frameOffsets === undefined ? {} : Object.fromEntries(frameOffsets);
      return {
        backend: "ax",
        elements,
        frames,
        omitted: usable.length - elements.length,
        skipped,
        ...(viewport === undefined ? {} : { viewport }),
      };
    } catch {
      return undefined;
    }
  }
  async function axNodeId(tabId, backendNodeId) {
    // DOM.pushNodesByBackendIdsToFrontend answers "Document needs to be
    // requested first" until this tab target has a current DOM document.
    await send(tabId, "DOM.enable").catch(() => {});
    await send(tabId, "DOM.getDocument", { depth: 0 }).catch(() => {});
    const pushed = await send(tabId, "DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [backendNodeId] });
    const nodeId = pushed?.nodeIds?.[0];
    if (typeof nodeId !== "number") throw new Error("element ref is stale (the page changed); take a new snapshot");
    return nodeId;
  }

  async function axBox(tabId, backendNodeId) {
    const nodeId = await axNodeId(tabId, backendNodeId);
    try {
      await send(tabId, "DOM.scrollIntoViewIfNeeded", { nodeId });
    } catch {
      // Not every node is scrollable; getBoxModel still reports its position.
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    const model = await send(tabId, "DOM.getBoxModel", { nodeId });
    const quad = model?.model?.content ?? model?.content;
    if (!Array.isArray(quad) || quad.length < 8) throw new Error("could not measure the element; take a new snapshot");
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const x = Math.round((Math.min(...xs) + Math.max(...xs)) / 2);
    const y = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
    let hitTrusted;
    try {
      const hit = await send(tabId, "DOM.getNodeForLocation", { x, y });
      hitTrusted = hit?.backendNodeId === backendNodeId;
    } catch {
      hitTrusted = undefined;
    }
    return { x, y, hitTrusted };
  }

  async function axFocus(tabId, backendNodeId) {
    const nodeId = await axNodeId(tabId, backendNodeId);
    const resolved = await send(tabId, "DOM.resolveNode", { nodeId });
    if (typeof resolved?.objectId !== "string") throw new Error("could not resolve the element; take a new snapshot");
    await send(tabId, "Runtime.callFunctionOn", {
      objectId: resolved.objectId,
      functionDeclaration: "function(){ this.focus(); if (typeof this.select === 'function') this.select(); }",
      returnByValue: true,
    });
  }

  async function axScriptClick(tabId, backendNodeId) {
    let objectId;
    try {
      const direct = await send(tabId, "DOM.resolveNode", { backendNodeId });
      if (typeof direct?.objectId === "string") objectId = direct.objectId;
    } catch {
      objectId = undefined;
    }
    if (objectId === undefined) {
      // Same-process frames sometimes only resolve through a pushed nodeId.
      const nodeId = await axNodeId(tabId, backendNodeId);
      const resolved = await send(tabId, "DOM.resolveNode", { nodeId });
      if (typeof resolved?.objectId !== "string") throw new Error("could not resolve the element; take a new snapshot");
      objectId = resolved.objectId;
    }
    await send(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function(){ this.click(); }",
      returnByValue: true,
    });
  }

  async function frameScriptClick(tabId, frameId, text) {
    const world = await send(tabId, "Page.createIsolatedWorld", { frameId, worldName: "dsh-agent-frame" });
    const contextId = world?.executionContextId;
    if (typeof contextId !== "number") throw new Error("could not create an isolated world for the frame");
    const expression = `(() => { // __dshAgentFrameClick
      const wanted = ${JSON.stringify(String(text ?? ""))};
      const norm = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
      const selector = "a[href], button, input, textarea, select, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab]";
      const nodes = [...document.querySelectorAll(selector)];
      let el = nodes.find((node) => norm(node.innerText || node.value || node.getAttribute("aria-label") || node.getAttribute("title") || "") === wanted);
      if (el === undefined && wanted !== "") {
        el = nodes.find((node) => norm(node.innerText || node.value || node.getAttribute("aria-label") || node.getAttribute("title") || "").includes(wanted));
      }
      if (el === undefined) return { clicked: false, reason: "no matching element in frame" };
      el.click();
      return { clicked: true, tag: el.tagName.toLowerCase() };
    })()`;
    const response = await send(tabId, "Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true });
    if (response?.exceptionDetails) throw new Error(String(response.exceptionDetails.text ?? "frame evaluation failed"));
    return response?.result?.value;
  }

  async function listTabs() {
    const tabs = await chromeApi.tabs.query({});
    return {
      ok: true,
      tabs: tabs.map((tab) => ({ id: tab.id, title: tab.title ?? "", url: tab.url ?? "", active: tab.active === true })),
    };
  }

  async function attach(tabId) {
    const id = tabIdOf(tabId);
    await ensureAttached(id);
    const grouping = await ensureAgentGroup(id);
    return { ok: true, tabId: id, ...grouping };
  }

  async function detach(tabId) {
    const id = tabIdOf(tabId);
    let emulationReset = false;
    if (emulationByTab.has(id)) {
      // Restore the user's real tab before the CDP session goes away.
      emulationReset = (await applyEmulationReset(id)).length === 0;
    }
    releaseTabState(id);
    await chromeApi.debugger.detach({ tabId: id });
    return { ok: true, tabId: id, ...(emulationReset ? { emulationReset: true } : {}) };
  }

  async function navigate(tabId, url) {
    const id = tabIdOf(tabId);
    await assertAgentTab(id);
    const target = toHttpUrl(url);
    await ensureAttached(id);
    refsByTab.delete(id);
    await send(id, "Page.navigate", { url: target });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const info = await pageInfo(id);
    return { ok: true, tabId: id, url: info.url || target, title: info.title };
  }

  async function snapshot(tabId) {
    const id = tabIdOf(tabId);
    await assertAgentTab(id);
    await ensureAttached(id);
    const ax = await axSnapshot(id);
    if (ax !== undefined) {
      const refs = new Map();
      const frames = ax.frames ?? {};
      for (const element of ax.elements) {
        if (typeof element.ref !== "string") continue;
        const frameId = typeof element.frame === "string" ? element.frame : undefined;
        refs.set(element.ref, {
          backendDOMNodeId: Number(element.ref.slice(1)),
          role: element.role,
          text: element.text,
          ...(frameId === undefined ? {} : { frameId, offset: frames[frameId] ?? { x: 0, y: 0 } }),
        });
      }
      refsByTab.set(id, refs);
      const info = await pageInfo(id);
      return { ok: true, tabId: id, snapshot: { tabId: id, title: info.title, url: info.url, ...ax } };
    }
    // Older Chrome builds without an accessible tree fall back to page refs.
    const snapshotValue = await evaluate(id, SNAPSHOT_JS);
    if (snapshotValue === undefined || snapshotValue === null) throw new Error("the page returned no snapshot");
    return { ok: true, tabId: id, snapshot: { tabId: id, backend: "dom", ...snapshotValue } };
  }

  async function click(tabId, input) {
    const id = tabIdOf(tabId);
    await assertAgentTab(id);
    await ensureAttached(id);
    const before = await pageInfo(id);
    let x;
    let y;
    let label;
    let hitTrusted;
    let axRef = false;
    if (input.ref !== undefined && input.ref !== null) {
      const ref = String(input.ref);
      const axInfo = refsByTab.get(id)?.get(ref);
      if (axInfo !== undefined) {
        axRef = true;
        label = axInfo.role;
        if (axInfo.frameId !== undefined) {
          // Run inside the frame's isolated world (Playwright-style): resolve
          // the element by its accessibility name and click it there.
          let method;
          let framedClicked = false;
          try {
            const framed = await frameScriptClick(id, axInfo.frameId, axInfo.text);
            if (framed?.clicked === true) {
              method = "iframe-script";
              framedClicked = true;
            }
          } catch {
            method = undefined;
          }
          if (method === undefined) {
            try {
              await axScriptClick(id, axInfo.backendDOMNodeId);
              method = "ax-script";
            } catch {
              method = undefined;
            }
          }
          if (method === undefined) {
            const point = await axBox(id, axInfo.backendDOMNodeId);
            const offset = axInfo.offset ?? { x: 0, y: 0 };
            x = point.x + offset.x;
            y = point.y + offset.y;
            method = "iframe-coordinate";
          }
          const settle = await settlePage(id);
          const info = await pageInfo(id);
          return {
            ok: true,
            tabId: id,
            label,
            ...(x === undefined ? {} : { x, y }),
            method,
            url: info.url,
            title: info.title,
            settle,
            changed: framedClicked || Number(settle?.mutations ?? 0) > 0,
          };
        }
        const point = await axBox(id, axInfo.backendDOMNodeId);
        x = point.x;
        y = point.y;
        hitTrusted = point.hitTrusted;
      } else {
        const target = await evaluate(id, CLICK_TARGET_JS(input.ref));
        if (!target || target.ok !== true) throw new Error(target?.error ?? "element ref not found; take a new snapshot");
        x = target.x;
        y = target.y;
        label = target.label;
        hitTrusted = target.hitTrusted;
      }
    } else {
      x = Number(input.x);
      y = Number(input.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("click requires ref or x/y coordinates");
    }
    await evaluate(id, CURSOR_MOVE_JS(Math.round(x), Math.round(y)));
    await new Promise((resolve) => setTimeout(resolve, 120));
    await send(id, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await send(id, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    let info = await pageInfo(id);
    let navigated = before.url !== "" && info.url !== "" && before.url !== info.url;
    let method = axRef ? "ax" : "input";
    if (!navigated && !axRef && input.ref !== undefined && input.ref !== null) {
      // Background renderers can drop synthetic mouse input; an element click
      // fallback still triggers default navigation and in-page handlers.
      const fallback = await evaluate(id, CLICK_FALLBACK_JS(input.ref));
      if (fallback?.ok === true) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        info = await pageInfo(id);
        navigated = before.url !== "" && info.url !== "" && before.url !== info.url;
        method = "input+script";
      }
    }
    const settle = await settlePage(id);
    const scroll = await evaluate(id, SCROLL_STATE_JS).catch(() => undefined);
    const changed = navigated || method !== "input" || Number(settle?.mutations ?? 0) > 0;
    return {
      ok: true,
      tabId: id,
      x,
      y,
      label,
      hitTrusted,
      url: info.url,
      title: info.title,
      navigated,
      method,
      settle,
      scrollY: typeof scroll?.scrollY === "number" ? scroll.scrollY : undefined,
      changed,
    };
  }

  async function type(tabId, input) {
    const id = tabIdOf(tabId);
    await assertAgentTab(id);
    await ensureAttached(id);
    const text = String(input.text ?? "");
    if (input.ref !== undefined && input.ref !== null) {
      const ref = String(input.ref);
      const axInfo = refsByTab.get(id)?.get(ref);
      if (axInfo !== undefined) {
        await axFocus(id, axInfo.backendDOMNodeId);
      } else {
        const focus = await evaluate(id, FOCUS_JS(input.ref));
        if (!focus || focus.ok !== true) throw new Error(focus?.error ?? "element ref not found; take a new snapshot");
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await send(id, "Input.insertText", { text });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const focus = await evaluate(id, EDITABLE_JS);
    if (focus?.editable !== true) {
      throw new Error("the focused element is not editable; take a snapshot and pass a textbox ref, or click the input first");
    }
    const settle = await settlePage(id);
    const info = await pageInfo(id);
    return {
      ok: true,
      tabId: id,
      typed: text,
      value: typeof focus.value === "string" ? focus.value : "",
      url: info.url,
      title: info.title,
      settle,
      changed: Number(settle?.mutations ?? 0) > 0,
    };
  }

  async function key(tabId, input) {
    const id = tabIdOf(tabId);
    await assertAgentTab(id);
    await ensureAttached(id);
    const name = String(input.key ?? "");
    if (name === "") throw new Error("key is required");
    const definition = KEY_CODES[name] ?? { key: name, code: name, windowsVirtualKeyCode: name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0 };
    const before = await pageInfo(id);
    await send(id, "Input.dispatchKeyEvent", { type: "keyDown", ...definition });
    await send(id, "Input.dispatchKeyEvent", { type: "keyUp", ...definition });
    let submit;
    if (name === "Enter") {
      await new Promise((resolve) => setTimeout(resolve, 160));
      const now = await pageInfo(id);
      const urlChanged = before.url !== "" && now.url !== "" && before.url !== now.url;
      if (!urlChanged) submit = await evaluate(id, SUBMIT_FORM_JS).catch(() => undefined);
    }
    const settle = await settlePage(id);
    const info = await pageInfo(id);
    return {
      ok: true,
      tabId: id,
      key: name,
      url: info.url,
      title: info.title,
      submit,
      settle,
      changed: Number(settle?.mutations ?? 0) > 0 || submit?.submitted === true,
    };
  }

  async function scroll(tabId, input) {
    const id = tabIdOf(tabId);
    await assertAgentTab(id);
    await ensureAttached(id);
    const deltaY = Number(input.deltaY ?? 400);
    if (!Number.isFinite(deltaY)) throw new Error("scroll requires a numeric deltaY");
    const before = await evaluate(id, SCROLL_STATE_JS);
    await send(id, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY });
    await new Promise((resolve) => setTimeout(resolve, 160));
    let state = await evaluate(id, SCROLL_STATE_JS);
    let method = "wheel";
    const beforeY = typeof before?.scrollY === "number" ? before.scrollY : undefined;
    if (deltaY !== 0 && typeof beforeY === "number" && typeof state?.scrollY === "number" && state.scrollY === beforeY) {
      await evaluate(id, SCROLL_FALLBACK_JS(deltaY));
      await new Promise((resolve) => setTimeout(resolve, 120));
      state = await evaluate(id, SCROLL_STATE_JS);
      method = "script";
    }
    const settle = await settlePage(id);
    const finalY = typeof state?.scrollY === "number" ? state.scrollY : undefined;
    return {
      ok: true,
      tabId: id,
      deltaY,
      method,
      scrollY: finalY,
      scrollHeight: typeof state?.scrollHeight === "number" ? state.scrollHeight : undefined,
      innerHeight: typeof state?.innerHeight === "number" ? state.innerHeight : undefined,
      settle,
      changed: Number(settle?.mutations ?? 0) > 0 || (typeof beforeY === "number" && typeof finalY === "number" && finalY !== beforeY),
    };
  }

  async function upload(tabId, input) {
    const id = tabIdOf(tabId);
    await assertAgentTab(id);
    await ensureAttached(id);
    const ref = String(input.ref ?? "");
    const info = refsByTab.get(id)?.get(ref);
    if (info === undefined) throw new Error("element ref " + ref + " is not in the current snapshot; take a new snapshot");
    const paths = Array.isArray(input.paths) ? input.paths.filter((value) => typeof value === "string" && value !== "") : [];
    if (paths.length === 0) throw new Error("upload requires at least one file path");
    const nodeId = await axNodeId(id, info.backendDOMNodeId);
    await send(id, "DOM.setFileInputFiles", { nodeId, files: paths });
    const settle = await settlePage(id);
    const info2 = await pageInfo(id);
    return { ok: true, tabId: id, ref, paths, url: info2.url, title: info2.title, settle, changed: Number(settle?.mutations ?? 0) > 0 };
  }

  async function evaluatePage(tabId, input) {
    const id = tabIdOf(tabId);
    await assertAgentTab(id);
    const expression = typeof input.expression === "string" ? input.expression : "";
    if (expression.trim() === "") throw new Error("evaluate requires an expression");
    await ensureAttached(id);
    const response = await send(id, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response?.exceptionDetails) throw new Error(String(response.exceptionDetails.text ?? "evaluation failed"));
    return { ok: true, tabId: id, value: response?.result?.value ?? null, type: String(response?.result?.type ?? "") };
  }

  /**
   * Wait until every requested condition holds: a selector, body text and/or
   * network idleness. Conditions are ANDed, polled here, and the caller's `ms`
   * is still the overall timeout (not a per-condition budget).
   */
  async function waitFor(tabId, input = {}) {
    const id = tabIdOf(tabId);
    await assertAgentTab(id);
    await ensureAttached(id);
    const options = input ?? {};
    const selector = typeof options.selector === "string" && options.selector !== "" ? options.selector : undefined;
    const text = typeof options.text === "string" && options.text !== "" ? options.text : undefined;
    const wantsNetworkIdle = options.networkIdle === true;
    const idleMs = Math.max(0, Number(options.idleMs ?? 500));
    if (!Number.isFinite(idleMs)) throw new Error("wait idleMs must be a finite number");
    const timeoutMs = Math.max(0, Number(options.ms ?? 8000));
    if (!Number.isFinite(timeoutMs)) throw new Error("wait ms must be a finite number");
    const started = Date.now();
    if (selector === undefined && text === undefined && !wantsNetworkIdle) {
      await delay(Math.max(0, Number(options.ms ?? 500)));
      return { ok: true, tabId: id, waitedMs: Date.now() - started };
    }
    for (;;) {
      let pageFound = true;
      let selectorFound;
      let textFound;
      if (selector !== undefined || text !== undefined) {
        const state = await evaluate(id, WAIT_JS(selector, text));
        pageFound = state?.found === true;
        selectorFound = state?.selectorFound;
        textFound = state?.textFound;
      }
      const network = wantsNetworkIdle ? networkIdleSnapshot(id) : undefined;
      const networkIdleNow = network === undefined || (network.pendingRequests === 0 && network.idleForMs >= idleMs);
      if (pageFound && networkIdleNow) {
        return {
          ok: true,
          tabId: id,
          waitedMs: Date.now() - started,
          ...(selector === undefined ? {} : { selector }),
          ...(text === undefined ? {} : { text }),
          ...(selectorFound === undefined ? {} : { selectorFound }),
          ...(textFound === undefined ? {} : { textFound }),
          ...(network === undefined
            ? {}
            : {
                networkIdle: {
                  pendingRequests: network.pendingRequests,
                  idleMs,
                  idleForMs: Number.isFinite(network.idleForMs) ? Math.round(network.idleForMs) : null,
                },
              }),
        };
      }
      if (Date.now() - started >= timeoutMs) {
        const pending = wantsNetworkIdle ? networkIdleSnapshot(id) : undefined;
        throw new Error(
          `wait timed out after ${timeoutMs}ms${pending === undefined ? "" : ` (network pending ${pending.pendingRequests})`}${
            selector !== undefined && selectorFound === false ? ` (selector ${JSON.stringify(selector)} not found)` : ""
          }${text !== undefined && textFound === false ? ` (text ${JSON.stringify(text)} not found)` : ""}`,
        );
      }
      await delay(150);
    }
  }

  async function logs(tabId, input = {}) {
    const id = tabIdOf(tabId);
    await assertAgentTab(id);
    await ensureAttached(id);
    const buffer = bufferFor(id);
    if (input.clear === true) {
      const clearedCount = buffer.length;
      buffer.length = 0;
      return { ok: true, tabId: id, entries: [], total: 0, bufferTotal: 0, cleared: true, clearedCount };
    }
    const filter = typeof input.filter === "string" && input.filter.trim() !== "" ? input.filter.trim().toLowerCase() : undefined;
    const matched = filter === undefined ? buffer : buffer.filter((entry) => JSON.stringify(entry).toLowerCase().includes(filter));
    const limit = Math.min(Math.max(Number(input.limit ?? 50), 1), 100);
    return {
      ok: true,
      tabId: id,
      entries: matched.slice(-limit),
      total: matched.length,
      bufferTotal: buffer.length,
      ...(filter === undefined ? {} : { filter }),
    };
  }

  function screenshotFormatOf(value) {
    const raw = typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : "png";
    const format = raw === "jpg" ? "jpeg" : raw;
    if (!SCREENSHOT_FORMATS.has(format)) throw new Error(`screenshot format must be png, jpeg or webp, got "${String(value)}"`);
    return format;
  }

  function screenshotQualityOf(value, format) {
    if (value === undefined || value === null) return undefined;
    const quality = Number(value);
    if (!Number.isFinite(quality) || quality < 0 || quality > 100) throw new Error("screenshot quality must be a number between 0 and 100");
    if (format === "png") throw new Error("screenshot quality only applies to format jpeg or webp");
    return Math.round(quality);
  }

  function screenshotClipOf(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("screenshot clip must be an object with x, y, width and height");
    }
    const clip = {};
    for (const key of ["x", "y", "width", "height"]) {
      const number = Number(value[key]);
      if (!Number.isFinite(number)) throw new Error(`screenshot clip.${key} must be a finite number`);
      clip[key] = number;
    }
    if (clip.width <= 0 || clip.height <= 0) throw new Error("screenshot clip width and height must be positive");
    if (value.scale !== undefined && value.scale !== null) {
      const scale = Number(value.scale);
      if (!Number.isFinite(scale) || scale <= 0) throw new Error("screenshot clip.scale must be a positive number");
      clip.scale = scale;
    }
    return clip;
  }

  /** Normalise a DOMRect-like value into a positive viewport clip. */
  function clipFromRect(value) {
    const x = Number(value?.x);
    const y = Number(value?.y);
    const width = Number(value?.width);
    const height = Number(value?.height);
    if (![x, y, width, height].every((number) => Number.isFinite(number))) {
      throw new Error("could not measure the element; take a new snapshot");
    }
    if (width <= 0 || height <= 0) throw new Error("the element has no visible box to capture");
    return { x: Math.max(0, x), y: Math.max(0, y), width, height };
  }

  /** Intersect a clip with the real viewport (CDP only captures the surface here). */
  function clipToViewport(clip, viewport) {
    const left = Math.max(0, Math.round(Number(clip?.x ?? 0)));
    const top = Math.max(0, Math.round(Number(clip?.y ?? 0)));
    const right = Math.min(Math.max(1, Math.round(Number(viewport?.width ?? 0))), Math.round(Number(clip?.x ?? 0) + Number(clip?.width ?? 0)));
    const bottom = Math.min(Math.max(1, Math.round(Number(viewport?.height ?? 0))), Math.round(Number(clip?.y ?? 0) + Number(clip?.height ?? 0)));
    if (right - left < 1 || bottom - top < 1) return undefined;
    const scale = Number(clip?.scale);
    return { x: left, y: top, width: right - left, height: bottom - top, ...(Number.isFinite(scale) && scale > 0 ? { scale } : {}) };
  }

  /** Viewport coordinates of an AX ref: resolve the node, scroll it in, measure. */
  async function refScreenshotClip(tabId, ref, refInfo) {
    let objectId;
    try {
      const resolved = await send(tabId, "DOM.resolveNode", { backendNodeId: refInfo.backendDOMNodeId });
      if (typeof resolved?.objectId === "string") objectId = resolved.objectId;
    } catch {
      objectId = undefined;
    }
    if (objectId === undefined) {
      const nodeId = await axNodeId(tabId, refInfo.backendDOMNodeId);
      const resolved = await send(tabId, "DOM.resolveNode", { nodeId });
      if (typeof resolved?.objectId !== "string") throw new Error(`element ref ${ref} could not be resolved; take a new snapshot`);
      objectId = resolved.objectId;
    }
    const response = await send(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: ELEMENT_RECT_FN,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response?.exceptionDetails) throw new Error(`element ref ${ref} could not be measured; take a new snapshot`);
    const clip = clipFromRect(response?.result?.value);
    // Child-frame refs are measured in their own document; snapshot recorded the
    // frame's offset relative to the main frame viewport.
    const offset = refInfo.offset ?? { x: 0, y: 0 };
    clip.x = Math.max(0, clip.x + Number(offset.x ?? 0));
    clip.y = Math.max(0, clip.y + Number(offset.y ?? 0));
    return clip;
  }

  async function selectorScreenshotClip(tabId, selector) {
    const value = await evaluate(tabId, SELECTOR_RECT_JS(selector));
    if (value?.found !== true) throw new Error(`screenshot selector "${selector}" did not match any element`);
    return clipFromRect(value);
  }

  /** Content size from Page.getLayoutMetrics (cssContentSize wins when larger). */
  async function contentSize(tabId) {
    const metrics = await send(tabId, "Page.getLayoutMetrics");
    const sizes = [metrics?.cssContentSize, metrics?.contentSize].filter((size) => size !== undefined && size !== null);
    if (sizes.length === 0) throw new Error("the page did not report a content size");
    const width = Math.max(...sizes.map((size) => Number(size.width ?? 0)));
    const height = Math.max(...sizes.map((size) => Number(size.height ?? 0)));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error("the page reported an empty content size");
    }
    return { width: Math.ceil(width), height: Math.ceil(height) };
  }

  async function pageViewport(tabId) {
    const value = await evaluate(tabId, VIEWPORT_METRICS_JS);
    if (value === null || typeof value !== "object") throw new Error("the page did not report its viewport");
    return {
      viewport: {
        width: Number(value.width ?? 0),
        height: Number(value.height ?? 0),
        devicePixelRatio: Number(value.devicePixelRatio ?? 0),
      },
      colorScheme: typeof value.colorScheme === "string" ? value.colorScheme : undefined,
    };
  }

  /** Clear every CDP override this plugin may have applied; each call is isolated. */
  async function applyEmulationReset(tabId) {
    const errors = [];
    for (const [method, params] of EMULATION_RESET_CALLS) {
      try {
        await send(tabId, method, params);
      } catch (error) {
        errors.push(`${method}: ${String(error && error.message ? error.message : error)}`);
      }
    }
    emulationByTab.delete(tabId);
    return errors;
  }

  /** The deviceScaleFactor in effect for this tab (0 means "native"). */
  function effectiveDeviceScaleFactor(tabId, nativeDpr) {
    const emulation = emulationByTab.get(tabId);
    const dsf = Number(emulation?.deviceScaleFactor ?? 0);
    if (Number.isFinite(dsf) && dsf > 0) return dsf;
    const dpr = Number(nativeDpr ?? 0);
    return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  }

  /** Restore the device-metrics override that was active before a fullPage capture. */
  async function restoreDeviceMetrics(tabId, previous) {
    if (previous !== undefined && Number.isFinite(Number(previous.width)) && Number.isFinite(Number(previous.height))) {
      await send(tabId, "Emulation.setDeviceMetricsOverride", {
        width: Number(previous.width),
        height: Number(previous.height),
        deviceScaleFactor: Number(previous.deviceScaleFactor ?? 0) > 0 ? Number(previous.deviceScaleFactor) : 0,
        mobile: previous.mobile === true,
        screenWidth: Number(previous.width),
        screenHeight: Number(previous.height),
      });
      return;
    }
    await send(tabId, "Emulation.clearDeviceMetricsOverride");
  }

  /**
   * Full-page capture without `captureBeyondViewport`.
   *
   * Real Chrome 156 hangs on `Page.captureScreenshot` when captureBeyondViewport
   * (with or without a clip) is sent through chrome.debugger on a background tab
   * — the promise never settles and the tab can be left at the capture surface
   * size. Instead: keep the current width/deviceScaleFactor, temporarily grow the
   * emulated viewport to the content height, capture the now-complete viewport,
   * then restore the previous device-metrics override.
   */
  async function captureFullPage(tabId, options = {}) {
    const format = screenshotFormatOf(options.format);
    const quality = screenshotQualityOf(options.quality, format);
    const size = await contentSize(tabId);
    const measured = await pageViewport(tabId);
    const previous = emulationByTab.get(tabId);
    const width = Math.max(1, Math.round(Number(previous?.width ?? measured.viewport.width ?? size.width)));
    const capturedHeight = Math.max(1, Math.min(size.height, FULL_PAGE_MAX_CSS_PX));
    const dsf = Math.max(0, Number(previous?.deviceScaleFactor ?? 0));
    try {
      await send(tabId, "Emulation.setDeviceMetricsOverride", {
        width,
        height: capturedHeight,
        deviceScaleFactor: dsf,
        mobile: previous?.mobile === true,
        screenWidth: width,
        screenHeight: capturedHeight,
      });
      // Give the renderer a frame to relayout before capturing.
      await delay(120);
      const params = { format, fromSurface: true };
      if (quality !== undefined) params.quality = quality;
      const response = await send(tabId, "Page.captureScreenshot", params);
      if (typeof response?.data !== "string" || response.data === "") throw new Error("fullPage screenshot failed");
      const effectiveDsf = effectiveDeviceScaleFactor(tabId, measured.viewport.devicePixelRatio);
      return {
        data: response.data,
        format,
        ...(quality === undefined ? {} : { quality }),
        capture: {
          mode: "fullPage",
          width: Math.max(1, Math.round(width * effectiveDsf)),
          height: Math.max(1, Math.round(capturedHeight * effectiveDsf)),
          cssWidth: width,
          cssHeight: capturedHeight,
          capped: size.height > FULL_PAGE_MAX_CSS_PX,
          requestedHeight: size.height,
        },
      };
    } finally {
      await restoreDeviceMetrics(tabId, previous).catch(() => {});
    }
  }

  /**
   * Parameterised Page.captureScreenshot.
   *
   * clip is in **viewport (CSS px) coordinates** and is intersected with the real
   * viewport: element/ref/selector targets are scrolled into view first, and
   * explicit clips are viewport rectangles. `captureBeyondViewport` is never
   * used (see captureFullPage); fullPage grows the emulated viewport instead.
   */
  async function captureScreenshot(tabId, input = {}) {
    const id = tabIdOf(tabId);
    await assertAgentTab(id);
    await ensureAttached(id);
    const options = input ?? {};
    const format = screenshotFormatOf(options.format);
    const quality = screenshotQualityOf(options.quality, format);
    const wantsFullPage = options.fullPage === true;
    const wantsRef = options.ref !== undefined && options.ref !== null && String(options.ref) !== "";
    const wantsSelector = typeof options.selector === "string" && options.selector.trim() !== "";
    const explicitClip = options.clip !== undefined && options.clip !== null ? screenshotClipOf(options.clip) : undefined;
    const modes = [
      wantsFullPage ? "fullPage" : undefined,
      wantsRef ? "ref" : undefined,
      wantsSelector ? "selector" : undefined,
      explicitClip === undefined ? undefined : "clip",
    ].filter((mode) => mode !== undefined);
    if (modes.length > 1) throw new Error(`screenshot accepts only one of fullPage, clip, ref or selector (got ${modes.join(", ")})`);
    if (wantsFullPage) {
      const shot = await captureFullPage(id, { format, quality });
      if (shot.data.length > MAX_CAPTURE_BASE64) {
        throw new Error(`fullPage screenshot is too large for the bridge (${shot.data.length} base64 chars; limit ${MAX_CAPTURE_BASE64}) — lower deviceScaleFactor or capture a clip instead`);
      }
      return { ok: true, tabId: id, ...shot };
    }
    let clip = explicitClip;
    let mode = explicitClip === undefined ? "viewport" : "clip";
    if (wantsRef) {
      const ref = String(options.ref);
      const refInfo = refsByTab.get(id)?.get(ref);
      if (refInfo === undefined) throw new Error(`element ref ${ref} is not in the current snapshot; take a new snapshot`);
      clip = await refScreenshotClip(id, ref, refInfo);
      mode = "ref";
    } else if (wantsSelector) {
      clip = await selectorScreenshotClip(id, options.selector.trim());
      mode = "selector";
    }
    const measured = await pageViewport(id);
    if (clip !== undefined) {
      const clamped = clipToViewport(clip, measured.viewport);
      if (clamped === undefined) throw new Error("screenshot region is outside the visible viewport; scroll it into view or use fullPage");
      clip = clamped;
    }
    const params = { format, fromSurface: true };
    if (quality !== undefined) params.quality = quality;
    if (clip !== undefined) {
      // clip.scale is mandatory in current CDP; keep the caller's scale (or 1).
      params.clip = { ...clip, scale: Number(clip.scale) > 0 ? Number(clip.scale) : 1 };
    }
    const response = await send(id, "Page.captureScreenshot", params);
    if (typeof response?.data !== "string" || response.data === "") throw new Error("screenshot failed");
    if (response.data.length > MAX_CAPTURE_BASE64) {
      throw new Error(`screenshot is too large for the bridge (${response.data.length} base64 chars; limit ${MAX_CAPTURE_BASE64}) — lower deviceScaleFactor or capture a smaller clip`);
    }
    const effectiveDsf = effectiveDeviceScaleFactor(id, measured.viewport.devicePixelRatio);
    const cssWidth = clip === undefined ? measured.viewport.width : clip.width;
    const cssHeight = clip === undefined ? measured.viewport.height : clip.height;
    const clipScale = clip === undefined ? 1 : Number(clip.scale) > 0 ? Number(clip.scale) : 1;
    return {
      ok: true,
      tabId: id,
      data: response.data,
      format,
      ...(quality === undefined ? {} : { quality }),
      capture: {
        mode,
        ...(clip === undefined ? {} : { clip: params.clip }),
        width: Math.max(1, Math.round(cssWidth * clipScale * effectiveDsf)),
        height: Math.max(1, Math.round(cssHeight * clipScale * effectiveDsf)),
      },
    };
  }

  /**
   * Temporarily emulate a device viewport and/or prefers-color-scheme in this
   * real tab. The override is recorded per tab and reverted by reset, detach,
   * closeTab or Chrome ending the debugger session.
   */
  async function emulate(tabId, input = {}) {
    const id = tabIdOf(tabId);
    await assertAgentTab(id);
    await ensureAttached(id);
    const options = input ?? {};
    if (options.reset === true) {
      const resetErrors = await applyEmulationReset(id);
      const measured = await pageViewport(id).catch(() => undefined);
      return {
        ok: true,
        tabId: id,
        reset: true,
        viewport: measured?.viewport,
        colorScheme: measured?.colorScheme,
        ...(resetErrors.length === 0 ? {} : { resetErrors }),
      };
    }
    const widthGiven = options.width !== undefined && options.width !== null;
    const heightGiven = options.height !== undefined && options.height !== null;
    if (widthGiven !== heightGiven) throw new Error("emulate requires both width and height");
    let width;
    let height;
    if (widthGiven) {
      width = Number(options.width);
      height = Number(options.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error("emulate width and height must be positive numbers");
      }
      width = Math.round(width);
      height = Math.round(height);
    }
    let deviceScaleFactor;
    if (options.deviceScaleFactor !== undefined && options.deviceScaleFactor !== null) {
      deviceScaleFactor = Number(options.deviceScaleFactor);
      if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) throw new Error("emulate deviceScaleFactor must be a positive number");
      if (!widthGiven) throw new Error("emulate deviceScaleFactor requires width and height");
    }
    let mobile;
    if (options.mobile !== undefined && options.mobile !== null) {
      if (typeof options.mobile !== "boolean") throw new Error("emulate mobile must be a boolean");
      mobile = options.mobile;
      if (!widthGiven) throw new Error("emulate mobile requires width and height");
    }
    let colorScheme;
    if (options.colorScheme !== undefined && options.colorScheme !== null) {
      colorScheme = String(options.colorScheme).trim().toLowerCase();
      if (colorScheme !== "light" && colorScheme !== "dark") throw new Error('emulate colorScheme must be "light" or "dark"');
    }
    if (!widthGiven && colorScheme === undefined) throw new Error("emulate requires width/height, colorScheme, or reset=true");
    const previous = emulationByTab.get(id) ?? {};
    const next = { ...previous };
    if (widthGiven) {
      next.width = width;
      next.height = height;
      next.deviceScaleFactor = deviceScaleFactor ?? previous.deviceScaleFactor ?? 0;
      next.mobile = mobile ?? previous.mobile ?? false;
    }
    if (colorScheme !== undefined) next.colorScheme = colorScheme;
    // Record before applying so a partially failed call is still cleared by reset.
    emulationByTab.set(id, next);
    if (widthGiven) {
      await send(id, "Emulation.setDeviceMetricsOverride", {
        width: next.width,
        height: next.height,
        deviceScaleFactor: next.deviceScaleFactor ?? 0,
        mobile: next.mobile === true,
        screenWidth: next.width,
        screenHeight: next.height,
      });
    }
    if (colorScheme !== undefined) {
      await send(id, "Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: colorScheme }] });
    }
    const measured = await pageViewport(id).catch(() => undefined);
    const emulated = {
      ...(next.width === undefined
        ? {}
        : { width: next.width, height: next.height, deviceScaleFactor: next.deviceScaleFactor ?? 0, mobile: next.mobile === true }),
      ...(next.colorScheme === undefined ? {} : { colorScheme: next.colorScheme }),
    };
    return {
      ok: true,
      tabId: id,
      reset: false,
      emulated,
      applied: { deviceMetrics: widthGiven, media: colorScheme !== undefined },
      viewport: measured?.viewport,
      colorScheme: next.colorScheme ?? measured?.colorScheme,
    };
  }

  async function newTab(url, options = {}) {
    const target = toHttpUrl(url);
    const active = options.active === true;
    const tab = await chromeApi.tabs.create({ url: target, active });
    const grouping = await ensureAgentGroup(tab.id);
    return { ok: true, tabId: tab?.id, url: target, active, ...grouping };
  }

  async function closeTab(tabId) {
    const id = tabIdOf(tabId);
    let emulationReset = false;
    if (emulationByTab.has(id)) {
      // Restore the tab before it disappears so a leftover override cannot
      // outlive the command if Chrome keeps the tab alive for a moment.
      emulationReset = (await applyEmulationReset(id)).length === 0;
    }
    releaseTabState(id);
    await chromeApi.tabs.remove(id);
    return { ok: true, tabId: id, ...(emulationReset ? { emulationReset: true } : {}) };
  }

  async function execute(command) {
    try {
      switch (command?.type) {
        case "list-tabs":
          return await listTabs();
        case "new-tab":
          return await newTab(command.url, { active: command.active === true });
        case "close-tab":
          return await closeTab(command.tabId);
        case "attach":
          return await attach(command.tabId);
        case "detach":
          return await detach(command.tabId);
        case "navigate":
          return await navigate(command.tabId, command.url);
        case "snapshot":
          return await snapshot(command.tabId);
        case "click":
          return await click(command.tabId, command);
        case "type":
          return await type(command.tabId, command);
        case "key":
          return await key(command.tabId, command);
        case "scroll":
          return await scroll(command.tabId, command);
        case "logs":
          return await logs(command.tabId, command);
        case "upload":
          return await upload(command.tabId, command);
        case "evaluate":
          return await evaluatePage(command.tabId, command);
        case "wait":
          return await waitFor(command.tabId, command);
        case "screenshot":
          return await captureScreenshot(command.tabId, command);
        case "emulate":
          return await emulate(command.tabId, command);
        default:
          return { ok: false, error: `unknown command ${String(command?.type)}` };
      }
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  }

  wireTabEvents();

  return {
    listTabs,
    attach,
    detach,
    navigate,
    snapshot,
    click,
    type,
    key,
    scroll,
    logs,
    upload,
    evaluatePage,
    waitFor,
    captureScreenshot,
    emulate,
    newTab,
    closeTab,
    execute,
  };
}
