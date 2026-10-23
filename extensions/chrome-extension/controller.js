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
  const body = selector !== undefined
    ? `const el = document.querySelector(${JSON.stringify(selector)}); return { found: el !== null };`
    : `return { found: (document.body ? document.body.innerText : "").includes(${JSON.stringify(text)}) };`;
  return `(() => { // __dshAgentWait\n${body}\n})()`;
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

export function createChromeController(chromeApi) {
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
      } else if (method === "Network.loadingFailed") {
        buffer.push({ type: "network-failed", url: String(params?.url ?? ""), errorText: String(params?.errorText ?? "") });
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
    attached.delete(id);
    refsByTab.delete(id);
    logBuffers.delete(id);
    await chromeApi.debugger.detach({ tabId: id });
    return { ok: true, tabId: id };
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

  async function waitFor(tabId, input) {
    const id = tabIdOf(tabId);
    await assertAgentTab(id);
    await ensureAttached(id);
    const selector = typeof input.selector === "string" && input.selector !== "" ? input.selector : undefined;
    const text = typeof input.text === "string" && input.text !== "" ? input.text : undefined;
    const timeoutMs = Math.max(0, Number(input.ms ?? 8000));
    const started = Date.now();
    if (selector === undefined && text === undefined) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(input.ms ?? 500))));
      return { ok: true, tabId: id, waitedMs: Date.now() - started };
    }
    while (true) {
      const state = await evaluate(id, WAIT_JS(selector, text));
      if (state?.found === true) {
        return { ok: true, tabId: id, waitedMs: Date.now() - started, selector, text };
      }
      if (Date.now() - started >= timeoutMs) throw new Error(`wait timed out after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 150));
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

  async function captureScreenshot(tabId) {
    const id = tabIdOf(tabId);
    await assertAgentTab(id);
    await ensureAttached(id);
    const response = await send(id, "Page.captureScreenshot", { format: "png" });
    if (typeof response?.data !== "string") throw new Error("screenshot failed");
    return { ok: true, tabId: id, data: response.data };
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
    attached.delete(id);
    await chromeApi.tabs.remove(id);
    return { ok: true, tabId: id };
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
          return await captureScreenshot(command.tabId);
        default:
          return { ok: false, error: `unknown command ${String(command?.type)}` };
      }
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  }

  return { listTabs, attach, detach, navigate, snapshot, click, type, key, scroll, logs, upload, evaluatePage, waitFor, captureScreenshot, newTab, closeTab, execute };
}
