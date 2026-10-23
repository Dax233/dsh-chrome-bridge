import assert from "node:assert/strict";
import { test } from "node:test";
import { createChromeController } from "../extensions/chrome-extension/controller.js";

function makeChromeMock() {
  const calls = [];
  const state = {
    debuggerListeners: [],
    evaluateResults: {
      snapshot: {
        title: "Example Domain",
        url: "https://example.com/",
        count: 1,
        skipped: 0,
        elements: [{ ref: 0, tag: "a", text: "Learn more", x: 10, y: 20, href: "https://iana.org/help/example-domains" }],
      },
      clickTarget: { ok: true, x: 10, y: 20, label: "Learn more", hitTrusted: true },
      scrollState: { scrollY: 321, scrollHeight: 4000, innerHeight: 700 },
      focusedValue: { value: "hi" },
    },
  };
  const chromeApi = {
    tabs: {
      async query() {
        calls.push({ method: "tabs.query" });
        return [
          { id: 1, title: "Example Domain", url: "https://example.com/", active: true },
          { id: 2, title: "Docs", url: "https://example.org/docs", active: false },
        ];
      },
      async create(properties) {
        calls.push({ method: "tabs.create", properties });
        return { id: 42, ...properties };
      },
      async remove(tabId) {
        calls.push({ method: "tabs.remove", tabId });
      },
      async group(options) {
        calls.push({ method: "tabs.group", options });
        return options.groupId ?? 42;
      },
      async get(tabId) {
        calls.push({ method: "tabs.get", tabId });
        const groupId = state.tabGroupOverrides?.[tabId] ?? 42;
        return { id: tabId, groupId };
      },
    },
    tabGroups: {
      async query(queryInfo) {
        calls.push({ method: "tabGroups.query", queryInfo });
        return state.groups ?? [];
      },
      async update(groupId, properties) {
        calls.push({ method: "tabGroups.update", groupId, properties });
      },
    },
    debugger: {
      onEvent: {
        addListener(listener) {
          state.debuggerListeners.push(listener);
        },
      },
      async attach(target, version) {
        calls.push({ method: "debugger.attach", target, version });
      },
      async detach(target) {
        calls.push({ method: "debugger.detach", target });
      },
      async sendCommand(target, method, params) {
        calls.push({ method: "debugger.sendCommand", target, cdp: method, params });
        if (method === "Runtime.evaluate") {
          const expression = String(params?.expression ?? "");
          if (expression.includes("__dshAgentSettle")) return { result: { value: { settled: true, mutations: 2, waitedMs: 120, quietMs: 100 } } };
          if (expression.includes("__dshAgentSnapshot")) return { result: { value: state.evaluateResults.snapshot } };
          if (expression.includes("__dshAgentClickTarget")) return { result: { value: state.evaluateResults.clickTarget } };
          if (expression.includes("__dshAgentClickFallback")) return { result: { value: { ok: true, clicked: true } } };
          if (expression.includes("__dshAgentScrollState")) return { result: { value: state.evaluateResults.scrollState } };
          if (expression.includes("__dshAgentFocusedValue")) return { result: { value: state.evaluateResults.focusedValue } };
          if (expression.includes("__dshAgentEditable")) return { result: { value: state.editable ?? { editable: true, tag: "input", value: "hello" } } };
          if (expression.includes("__dshAgentWait")) return { result: { value: { found: true } } };
          if (expression.includes("__dshAgentFrameClick")) return { result: { value: { clicked: true, tag: "A" } } };
          if (expression.includes("__dshAgentScrollFallback")) return { result: { value: { scrolled: true } } };
          return { result: { value: { title: "Example Domain", url: "https://example.com/" } } };
        }
        if (method === "Accessibility.getFullAXTree") {
          if (params?.frameId !== undefined) return { nodes: state.axTrees?.[params.frameId] ?? [] };
          return { nodes: state.axTree ?? [] };
        }
        if (method === "DOM.pushNodesByBackendIdsToFrontend") {
          if (Array.isArray(params?.backendNodeIds)) {
            return { nodeIds: params.backendNodeIds.map((backendId, index) => (state.frontendNodeIds?.[backendId] ?? state.frontendNodeId ?? 70 + index)) };
          }
          return { nodeIds: [state.frontendNodeId ?? 7] };
        }
        if (method === "Page.getFrameTree") return state.frameTree === undefined ? {} : { frameTree: state.frameTree };
        if (method === "DOM.getFrameOwner") return { backendNodeId: state.frameOwners?.[params?.frameId] };
        if (method === "DOM.describeNode") return { node: { frameId: state.describeFrameIds?.[params?.nodeId] } };
        if (method === "Runtime.callFunctionOn") return { result: { value: true } };
        if (method === "DOM.getBoxModel") {
          return { model: { content: state.boxModels?.[params?.nodeId] ?? [0, 0, 10, 0, 10, 10, 0, 10] } };
        }
        if (method === "DOM.getNodeForLocation" && state.hitBackendNodeId !== undefined) return { backendNodeId: state.hitBackendNodeId };
        if (method === "DOM.resolveNode") return { objectId: "object-1" };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 5 };
        if (method === "Page.captureScreenshot") return { data: "AAAA" };
        return {};
      },
    },
  };
  return { chromeApi, calls, state };
}

test("listTabs returns chrome.tabs.query results", async () => {
  const { chromeApi, calls } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  const result = await controller.listTabs();
  assert.equal(result.ok, true);
  assert.equal(result.tabs.length, 2);
  assert.equal(result.tabs[0].id, 1);
  assert.ok(calls.some((call) => call.method === "tabs.query"));
});

test("attach and detach call chrome.debugger with the tab target", async () => {
  const { chromeApi, calls } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  const attached = await controller.attach(7);
  assert.equal(attached.ok, true);
  const attachCall = calls.find((call) => call.method === "debugger.attach");
  assert.deepEqual(attachCall.target, { tabId: 7 });
  assert.equal(attachCall.version, "1.3");
  const detached = await controller.detach(7);
  assert.equal(detached.ok, true);
  assert.deepEqual(calls.find((call) => call.method === "debugger.detach").target, { tabId: 7 });
});

test("navigate validates the URL and sends Page.navigate", async () => {
  const { chromeApi, calls } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  await assert.rejects(() => controller.navigate(1, "file:///etc/passwd"));
  await assert.rejects(() => controller.navigate(1, "chrome://settings"));
  const result = await controller.navigate(1, "https://example.com/");
  assert.equal(result.ok, true);
  const navigateCall = calls.find((call) => call.cdp === "Page.navigate");
  assert.equal(navigateCall.params.url, "https://example.com/");
});

test("snapshot evaluates the page snapshot script and returns elements", async () => {
  const { chromeApi, calls } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  const result = await controller.snapshot(1);
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.title, "Example Domain");
  assert.equal(result.snapshot.elements[0].ref, 0);
  const evaluate = calls.find((call) => call.cdp === "Runtime.evaluate");
  assert.ok(evaluate);
  assert.equal(evaluate.params.returnByValue, true);
});

test("click by ref resolves the element then dispatches real mouse events", async () => {
  const { chromeApi, calls } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  const result = await controller.click(1, { ref: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.x, 10);
  assert.equal(result.y, 20);
  const mouseEvents = calls.filter((call) => call.cdp === "Input.dispatchMouseEvent");
  assert.equal(mouseEvents.length, 2);
  assert.equal(mouseEvents[0].params.type, "mousePressed");
  assert.equal(mouseEvents[0].params.x, 10);
  assert.equal(mouseEvents[1].params.type, "mouseReleased");
});

test("click by coordinates skips the element lookup", async () => {
  const { chromeApi, calls } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  const result = await controller.click(1, { x: 5, y: 6 });
  assert.equal(result.ok, true);
  assert.equal(calls.some((call) => call.cdp === "Runtime.evaluate" && String(call.params.expression).includes("__dshAgentClickTarget")), false);
  const mouseEvents = calls.filter((call) => call.cdp === "Input.dispatchMouseEvent");
  assert.equal(mouseEvents[0].params.x, 5);
});

test("type inserts text and key presses a functional key", async () => {
  const { chromeApi, calls } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  const typed = await controller.type(1, { text: "hi" });
  assert.equal(typed.ok, true);
  const insert = calls.find((call) => call.cdp === "Input.insertText");
  assert.equal(insert.params.text, "hi");
  const key = await controller.key(1, { key: "Enter" });
  assert.equal(key.ok, true);
  const keyEvents = calls.filter((call) => call.cdp === "Input.dispatchKeyEvent");
  assert.equal(keyEvents.length, 2);
});

test("scroll dispatches a wheel event and reports the resulting position", async () => {
  const { chromeApi, calls } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  const result = await controller.scroll(1, { deltaY: 200 });
  assert.equal(result.ok, true);
  assert.equal(result.scrollY, 321);
  const wheel = calls.find((call) => call.cdp === "Input.dispatchMouseEvent" && call.params.type === "mouseWheel");
  assert.equal(wheel.params.deltaY, 200);
});

test("execute maps bridge command types and unknown commands fail", async () => {
  const { chromeApi } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  const listed = await controller.execute({ type: "list-tabs" });
  assert.equal(listed.ok, true);
  assert.equal(listed.tabs.length, 2);
  const attached = await controller.execute({ type: "attach", tabId: 1 });
  assert.equal(attached.ok, true);
  const unknown = await controller.execute({ type: "dance" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown command/);
});

test("newTab creates a background tab by default and reports its id", async () => {
  const { chromeApi, calls } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  const result = await controller.newTab("https://example.com/");
  assert.equal(result.ok, true);
  assert.equal(result.tabId, 42);
  const create = calls.find((call) => call.method === "tabs.create");
  assert.deepEqual(create.properties, { url: "https://example.com/", active: false });
});

test("closeTab removes the tab", async () => {
  const { chromeApi, calls } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  const result = await controller.closeTab(42);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.find((call) => call.method === "tabs.remove"), { method: "tabs.remove", tabId: 42 });
});

test("execute maps new-tab / close-tab / screenshot", async () => {
  const { chromeApi, calls } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  const created = await controller.execute({ type: "new-tab", url: "https://example.com/", active: true });
  assert.equal(created.ok, true);
  assert.equal(calls.find((call) => call.method === "tabs.create").properties.active, true);
  const closed = await controller.execute({ type: "close-tab", tabId: 42 });
  assert.equal(closed.ok, true);
  const shot = await controller.execute({ type: "screenshot", tabId: 1 });
  assert.equal(shot.ok, true);
  assert.equal(shot.data, "AAAA");
  assert.ok(calls.some((call) => call.cdp === "Page.captureScreenshot"));
});

test("attach enables focus emulation so background tabs accept input", async () => {
  const { chromeApi, calls } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  await controller.attach(5);
  const focus = calls.find((call) => call.cdp === "Emulation.setFocusEmulationEnabled");
  assert.ok(focus, "attach must enable focus emulation for background tabs");
  assert.equal(focus.params.enabled, true);
});

test("click dispatches button bitmasks on press and release", async () => {
  const { chromeApi, calls } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  await controller.click(1, { x: 3, y: 4 });
  const mouseEvents = calls.filter((call) => call.cdp === "Input.dispatchMouseEvent");
  assert.equal(mouseEvents[0].params.buttons, 1);
  assert.equal(mouseEvents[1].params.buttons, 0);
});

test("click falls back to element.click when input dispatch does not navigate", async () => {
  const { chromeApi, calls } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  const result = await controller.click(1, { ref: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.method, "input+script");
  assert.ok(
    calls.some((call) => call.cdp === "Runtime.evaluate" && String(call.params.expression).includes("__dshAgentClickFallback")),
    "the script fallback must run when the synthetic click did not navigate",
  );
});

test("newTab puts the tab into the DSH Agent tab group", async () => {
  const { chromeApi, calls } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  const result = await controller.newTab("https://example.com/");
  assert.equal(result.ok, true);
  assert.equal(result.grouped, true);
  assert.equal(result.groupId, 42);
  const groupCall = calls.find((call) => call.method === "tabs.group");
  assert.deepEqual(groupCall.options.tabIds, [42]);
  assert.equal(groupCall.options.groupId, undefined, "the first agent tab creates the group");
  const update = calls.find((call) => call.method === "tabGroups.update");
  assert.equal(update.properties.title, "DSH Agent");
  assert.equal(update.properties.color, "orange");
});

test("a second agent tab reuses the existing DSH Agent group", async () => {
  const { chromeApi, calls } = makeChromeMock();
  chromeApi.tabGroups.query = async () => {
    calls.push({ method: "tabGroups.query" });
    return [{ id: 42, title: "DSH Agent" }];
  };
  const controller = createChromeController(chromeApi);
  await controller.newTab("https://example.com/a");
  await controller.newTab("https://example.com/b");
  const groupCalls = calls.filter((call) => call.method === "tabs.group");
  assert.equal(groupCalls.length, 2);
  assert.equal(groupCalls[1].options.groupId, 42, "later agent tabs join the existing group");
  assert.equal(calls.filter((call) => call.method === "tabGroups.query").length, 1, "the group is looked up once");
});

test("attach moves the controlled tab into the agent group", async () => {
  const { chromeApi, calls } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  const result = await controller.attach(5);
  assert.equal(result.ok, true);
  assert.equal(result.grouped, true);
  const groupCall = calls.find((call) => call.method === "tabs.group");
  assert.deepEqual(groupCall.options.tabIds, [5]);
});

test("a tab-group failure does not fail the navigation action", async () => {
  const { chromeApi } = makeChromeMock();
  chromeApi.tabs.group = async () => {
    throw new Error("tabGroups permission denied");
  };
  const controller = createChromeController(chromeApi);
  const result = await controller.newTab("https://example.com/");
  assert.equal(result.ok, true);
  assert.equal(result.grouped, false);
  assert.match(String(result.groupingError), /permission denied/);
});


test("AX snapshot uses backendNodeId refs resolved on the host side", async () => {
  const { chromeApi, state } = makeChromeMock();
  state.axTree = [
    { nodeId: "1", ignored: false, role: { value: "RootWebArea" }, name: { value: "Example" }, backendDOMNodeId: 100 },
    { nodeId: "2", parentId: "1", ignored: false, role: { value: "link" }, name: { value: "Learn more" }, backendDOMNodeId: 123 },
    { nodeId: "3", parentId: "1", ignored: false, role: { value: "textbox" }, name: { value: "" }, backendDOMNodeId: 124, properties: [{ name: "value", value: { value: "hello" } }] },
  ];
  state.hitBackendNodeId = 123;
  const controller = createChromeController(chromeApi);
  const snapshot = await controller.snapshot(1);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.snapshot.backend, "ax");
  const link = snapshot.snapshot.elements.find((element) => element.role === "link");
  assert.equal(link.ref, "n123", "refs must be keyed by backendNodeId");
  const textbox = snapshot.snapshot.elements.find((element) => element.role === "textbox");
  assert.equal(textbox.value, "hello");
  const click = await controller.click(1, { ref: "n123" });
  assert.equal(click.ok, true);
  assert.equal(click.hitTrusted, true, "the hit test must come from DOM.getNodeForLocation");
  assert.ok(click.x > 0 && click.y > 0);
});

test("logs collects console/network events for the attached tab", async () => {
  const { chromeApi, state } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  const empty = await controller.logs(1);
  assert.equal(empty.ok, true);
  const listener = state.debuggerListeners[0];
  assert.equal(typeof listener, "function");
  listener({ tabId: 1 }, "Runtime.consoleAPICalled", { type: "error", args: [{ value: "boom" }] });
  listener({ tabId: 1 }, "Network.loadingFailed", { url: "https://x.test/a", errorText: "net::ERR_FAILED" });
  const result = await controller.logs(1);
  assert.equal(result.entries.length, 2);
  assert.match(result.entries[0].text, /boom/);
  assert.equal(result.entries[1].type, "network-failed");
});

test("type refuses to report success when the focus is not editable", async () => {
  const { chromeApi, state } = makeChromeMock();
  state.editable = { editable: false, tag: "body", value: "" };
  const controller = createChromeController(chromeApi);
  await assert.rejects(() => controller.type(1, { text: "typo" }), /not editable/i);
});

test("upload sets files on the file input resolved from a ref", async () => {
  const { chromeApi, calls, state } = makeChromeMock();
  state.axTree = [
    { nodeId: "1", ignored: false, role: { value: "RootWebArea" }, name: { value: "Form" }, backendDOMNodeId: 100 },
    { nodeId: "2", parentId: "1", ignored: false, role: { value: "button" }, name: { value: "Choose file" }, backendDOMNodeId: 321 },
  ];
  const controller = createChromeController(chromeApi);
  await controller.snapshot(1);
  const result = await controller.upload(1, { ref: "n321", paths: ["C:\\tmp\\a.txt"] });
  assert.equal(result.ok, true);
  const call = calls.find((entry) => entry.cdp === "DOM.setFileInputFiles");
  assert.ok(call, "upload must call DOM.setFileInputFiles");
  assert.deepEqual(call.params.files, ["C:\\tmp\\a.txt"]);
});

test("execute dispatches logs, upload and evaluate", async () => {
  const { chromeApi, state } = makeChromeMock();
  state.axTree = [
    { nodeId: "1", ignored: false, role: { value: "RootWebArea" }, name: { value: "Form" }, backendDOMNodeId: 100 },
    { nodeId: "2", parentId: "1", ignored: false, role: { value: "button" }, name: { value: "Choose file" }, backendDOMNodeId: 321 },
  ];
  const controller = createChromeController(chromeApi);
  const logs = await controller.execute({ type: "logs", tabId: 1, limit: 5 });
  assert.equal(logs.ok, true);
  await controller.snapshot(1);
  const upload = await controller.execute({ type: "upload", tabId: 1, ref: "n321", paths: ["C:\\tmp\\a.txt"] });
  assert.equal(upload.ok, true);
  const evaluated = await controller.execute({ type: "evaluate", tabId: 1, expression: "1 + 1" });
  assert.equal(evaluated.ok, true);
});

test("AX snapshot drops known Chrome UI nodes", async () => {
  const { chromeApi, state } = makeChromeMock();
  state.axTree = [
    { nodeId: "1", ignored: false, role: { value: "RootWebArea" }, name: { value: "Example" }, backendDOMNodeId: 100 },
    { nodeId: "2", parentId: "1", ignored: false, role: { value: "link" }, name: { value: "Learn more" }, backendDOMNodeId: 123 },
    { nodeId: "3", parentId: "1", ignored: false, role: { value: "button" }, name: { value: "图片翻译" }, backendDOMNodeId: 999 },
    { nodeId: "4", parentId: "1", ignored: false, role: { value: "button" }, name: { value: "Quick settings" }, backendDOMNodeId: 998 },
    { nodeId: "5", parentId: "1", ignored: false, role: { value: "button" }, name: { value: "" }, backendDOMNodeId: 997 },
  ];
  const controller = createChromeController(chromeApi);
  const snapshot = await controller.snapshot(1);
  const names = snapshot.snapshot.elements.map((element) => element.text);
  assert.ok(names.includes("Learn more"), "page content must stay");
  assert.ok(!names.includes("图片翻译"), "chrome translate UI must be filtered");
  assert.ok(!names.some((name) => /quick settings/i.test(name)), "chrome quick settings must be filtered");
  assert.ok(!snapshot.snapshot.elements.some((element) => element.ref === "n997"), "unnamed buttons must be filtered");
});

test("wait resolves when a selector or text appears", async () => {
  const { chromeApi } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  const bySelector = await controller.execute({ type: "wait", tabId: 1, selector: "#ready" });
  assert.equal(bySelector.ok, true);
  const byText = await controller.execute({ type: "wait", tabId: 1, text: "Done" });
  assert.equal(byText.ok, true);
  const byMs = await controller.execute({ type: "wait", tabId: 1, ms: 1 });
  assert.equal(byMs.ok, true);
});

test("wait interpolates the selector into the page expression", async () => {
  const { chromeApi, calls } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  await controller.execute({ type: "wait", tabId: 1, selector: "#ready", ms: 50 });
  const waitCall = calls.find((call) => call.cdp === "Runtime.evaluate" && String(call.params?.expression ?? "").includes("__dshAgentWait"));
  assert.ok(waitCall, "wait must evaluate a page expression");
  assert.match(String(waitCall.params.expression), /querySelector\("#ready"\)/);
});

test("iframe snapshot keeps child-frame nodes and click applies the frame offset", async () => {
  const { chromeApi, calls, state } = makeChromeMock();
  state.frameTree = { frame: { id: "f1" }, childFrames: [{ frame: { id: "f2" } }] };
  state.frameOwners = { f2: 200 };
  state.frontendNodeIds = { 200: 80, 123: 70, 300: 81 };
  state.boxModels = {
    80: [100, 200, 140, 200, 140, 240, 100, 240],
    81: [10, 20, 30, 20, 30, 40, 10, 40],
  };
  state.describeFrameIds = { 70: "f1", 81: "f2" };
  state.axTree = [
    { nodeId: "1", ignored: false, role: { value: "RootWebArea" }, name: { value: "Page" }, backendDOMNodeId: 100 },
    { nodeId: "2", parentId: "1", ignored: false, role: { value: "link" }, name: { value: "Outside" }, backendDOMNodeId: 123 },
  ];
  state.axTrees = {
    f2: [
      { nodeId: "1", ignored: false, role: { value: "RootWebArea" }, name: { value: "Frame" }, backendDOMNodeId: 400 },
      { nodeId: "2", parentId: "1", ignored: false, role: { value: "link" }, name: { value: "Inside" }, backendDOMNodeId: 300 },
    ],
  };
  const controller = createChromeController(chromeApi);
  const snapshot = await controller.snapshot(1);
  const inside = snapshot.snapshot.elements.find((element) => element.text === "Inside");
  assert.equal(inside.frame, "f2");
  const outside = snapshot.snapshot.elements.find((element) => element.text === "Outside");
  assert.equal(outside.frame, undefined);
  const click = await controller.click(1, { ref: inside.ref });
  assert.equal(click.ok, true);
  assert.equal(click.method, "iframe-script", "child-frame clicks run inside the frame context");
  const world = calls.find((call) => call.cdp === "Page.createIsolatedWorld");
  assert.ok(world, "iframe click must create an isolated world for the frame");
  const frameEval = calls.find((call) => call.cdp === "Runtime.evaluate" && String(call.params?.expression ?? "").includes("__dshAgentFrameClick"));
  assert.ok(frameEval, "iframe click must evaluate the click inside the frame");
  assert.equal(frameEval.params.contextId, 5);
  assert.equal(click.changed, true, "an executed iframe click counts as a change");
  assert.equal(calls.some((call) => call.cdp === "Input.dispatchMouseEvent"), false, "no coordinate dispatch for iframe refs");
});

test("tab group ACL: operations outside the DSH Agent group are rejected", async () => {
  const { chromeApi, state } = makeChromeMock();
  state.groups = [{ id: 42, title: "DSH Agent" }];
  state.tabGroupOverrides = { 9: 99 };
  const controller = createChromeController(chromeApi);
  await assert.rejects(() => controller.snapshot(9), /not in the DSH Agent group/);
  // attach opts the tab in (groups it), after which operations are allowed.
  await controller.attach(9);
  state.tabGroupOverrides = { 9: 42 };
  const snapshot = await controller.snapshot(9);
  assert.equal(snapshot.ok, true);
});

test("logs supports keyword filtering and clearing", async () => {
  const { chromeApi, state } = makeChromeMock();
  const controller = createChromeController(chromeApi);
  await controller.logs(1);
  const listener = state.debuggerListeners[0];
  listener({ tabId: 1 }, "Runtime.consoleAPICalled", { type: "error", args: [{ value: "boom-one" }] });
  listener({ tabId: 1 }, "Runtime.consoleAPICalled", { type: "info", args: [{ value: "quiet-two" }] });
  const filtered = await controller.logs(1, { filter: "boom" });
  assert.equal(filtered.entries.length, 1);
  assert.match(filtered.entries[0].text, /boom-one/);
  assert.equal(filtered.bufferTotal, 2);
  const cleared = await controller.logs(1, { clear: true });
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.total, 0);
  const after = await controller.logs(1);
  assert.equal(after.entries.length, 0);
});
