# 浏览器控制插件：设计与落地顺序

> 状态：Phase 0 进行中 —— S2（Host↔Client 桥）**已验证通过**（2026-10-22）；
> S1（侧边栏 webview 控制）代码完成、等待重启验证；测试先行流程已建立（§10）。
> 事故复盘见 §0。
> 最后更新：2026-10-22。

## 0. 事故复盘：重启后无限加载（2026-10-22）

- **现象**：spike 插件启用时重启 DSH 桌面版，启动停在加载页；从 UI 禁用两个插件后恢复正常。
- **根因**：Client 半 `apply()` 末尾 `return loop;`，而 `loop` 是永不 resolve 的 bridge 轮询 Promise。
  Cordis 把 apply 返回的 thenable 视为"仍在加载"，client 启动审计会等待每个 entry 就绪 → 永远等不到 → 无限加载。
- **为什么之前没暴露**：首版 client 是通过运行期 HMR 加载的，不走启动审计；只有重启后按 boot graph 加载才会等 apply 完成。
- **修复**：`apply()` 同步返回 `undefined`；bridge 轮询改为 fire-and-forget（`loop.catch(...)` 兜住异常）；
  整个 apply 包 try/catch；侧边栏 tab 打开改为重试（启动早期会报 `no session surface is mounted`）。
- **防护**：新增 `tests/browser-control-client.test.mjs` 的 **BOOT CONTRACT** 回归测试
  （`apply()` 必须返回 `undefined`），并做过变异验证：把 `void loop` 改回 `return loop` 时测试必红。
- **另一条环境事实**：打包版桌面 App 的 client 模块只在**页面启动时**从 boot graph 加载；
  运行中新增/替换 client 插件不会生效（graph/rebuilt 帧不落地）。因此 **client 代码每次改动都必须重启 App 验证**，
  不要指望 HMR。

目标（用户 2026-10-22 提出）：

- **A. 侧边栏内置浏览器 + Agent 操控 + 独立虚拟光标**
  Agent 能打开/点击/输入/滚动；用户能看到 Agent 的“鼠标”与点击反馈；这个鼠标不抢占用户真实系统指针。
- **B. Chrome 扩展 + 配套控制插件**
  Agent 连接用户真实 Chrome，控制指定标签页；标签页切到后台后仍可继续操作。

原则：不依赖 Playwright/Puppeteer/额外 Chromium 下载（宿主机 F: 仅剩约 11.8 GB），
优先复用 DSH 自身与 Electron 已带的能力；每一步都可安装、可实测、可回滚。

## 1. 外部参考（OpenAI Codex / ChatGPT 桌面版）

已验证（来源）：

- Codex CLI 与 IDE 扩展**没有**内置浏览器；内置浏览器位于 ChatGPT/Codex 桌面 App 中，
  作为对话旁的浏览器标签页（分栏/全屏）。来源：<https://learn.chatgpt.com/docs/browser.md>、
  相关 issue <https://github.com/openai/codex/issues/53521>。
- 桌面 App 中由 **Computer Use** 驱动内置浏览器（打开页面、点击、输入、读取渲染状态、截图、验证结果）；
  Windows 上 Computer Use 会接管真实桌面指针、不能后台运行。来源：
  <https://learn.chatgpt.com/docs/browser.md>、<https://learn.chatgpt.com/docs/computer-use.md>。
- CDP 是**需要显式开启**的开发/检查通道（Settings → Browser → Developer mode → Enable full CDP access，
  且可由管理员策略关闭）。来源同上。
- Agent 光标的实现线索：注入到页面里的 shadow-DOM 覆盖层 + 自定义光标元素，
  原生光标被隐藏（`cursor: none !important`）。证据：
  <https://github.com/openai/codex/issues/36222>、<https://github.com/openai/codex/issues/52941>；
  另有“光标形状的控制标记”在停止后残留的报告 <https://github.com/openai/codex/issues/55540>。
- 已知难点：坐标映射（DPI/缩放下点击位置与可见光标错位）<https://github.com/openai/codex/issues/48505>；
  因此实现时必须做点击前命中测试（`elementFromPoint` + 可见/可用/未被遮挡检查）。

可对比的开源实现：

- **Nanobrowser**（Apache-2.0，Chrome 侧边栏）：只通过 `chrome.debugger` 操作页面，
  Puppeteer 仅用于 frame 管理；点击/输入是真实浏览器输入；一个任务一个标签组；
  操作前检查元素可见、未移动、可用、未被遮挡。无视觉光标。来源：<https://github.com/nanobrowser/nanobrowser>。
- **Stagehand / browser-use / Chrome DevTools MCP / Playwright MCP**：均无公开的“页面内 Agent 光标”实现；
  Playwright MCP 通过浏览器扩展接管用户已打开的标签页。来源：
  <https://github.com/browserbase/stagehand>、<https://github.com/browser-use/browser-use>、
  <https://github.com/ChromeDevTools/chrome-devtools-mcp>、
  <https://github.com/microsoft/playwright/tree/main/packages/extension>。

关于 Chrom 扩展的关键结论（来自调研）：

- OpenAI 的扩展权限里同时出现 “Access the page debugger” 与 “Communicate with cooperating native applications”，
  推断其生产实现是 **`chrome.debugger` + native messaging**，而不是 `--remote-debugging-port`。
  来源：<https://learn.chatgpt.com/docs/chrome-extension>（权限文案见该页）。
- Chrome 144+ 起，普通 `--remote-debugging-port` 需要用户在 `chrome://inspect` 里手动勾选并允许，
  端口动态；因此“直接开调试端口”不再是零摩擦方案（Nanobrowser 因此只走扩展内 `chrome.debugger`）。
- `chrome.debugger` 能操作**后台标签页**（按标签页 attach，不要求前台），这是 Goal B 的核心机制；
  代价是 Chrome 会显示“正在调试此浏览器”的提示条（不可屏蔽），权限范围按标签页、可随时撤销。

## 2. 本机 DSH 可行性（已验证，来自当前安装的 0.2.1-rc.2）

- DSH 已自带侧边栏浏览器：`@deepseek-ai/dsh-client-ui-sidebar-browser`。
  Desktop 使用 Electron `<webview>`；主进程 `DesktopBrowserGuests` 用 **lease** 管控每个 guest：
  渲染进程通过 preload 暴露的 `window.dshDesktop.browser.acquire(workspace)` 拿到 `{ lease, partition }`，
  然后创建 `<webview name=lease partition=partition src="about:blank#<lease>">`；
  主进程在 `will-attach-webview` 校验 lease/partition 并固定安全参数（sandbox、无 node、devTools 打包后关闭），
  `did-attach-webview` 后才允许页面存活。参考实现位置（app.asar 内）：
  `lib/main.js` 的 `DesktopBrowserGuests`、`dsh-client-ui-sidebar-browser/lib/client.js`、
  `lib/preload-app.cjs` 的 `createProductApi().browser`。
- 该 webview 是**用户向**的：DSH 自身不提供 Agent 控制，也没有对外暴露“控制已有 guest”的 API。
- 侧边栏提供了**公开扩展点**，第三方插件可以注册自己的标签页类型与内容：
  `ctx.sidebarRightTabs.register({ id, kind, title, ... })` + 在 `sidebar.right.pane.tab` 槽位注册 body
  （`ctx.slots.register`）；参考 `@deepseek-ai/dsh-client-ui-sidebar-right/README.md`。
- Host 插件可以：
  - 注册 Agent 工具（`ctx.tools.register`）；
  - 监听普通 Node HTTP 服务（插件是普通 Node 进程内代码）；
  - 使用 `ctx.webServer.register/registerUpgrade`、`ctx.connection.admit` 等公开服务（备用通道方案）。
- 因此 Goal A 的合理做法：**新建我们自己的“Agent Browser”标签类型，拥有自己的 leased webview**，
  由我们自己的客户端插件驱动；不去接管 DSH 自带 Browser 标签的 guest（那是私有实现，跨版本会碎）。

## 3. 总体架构

```
                 ┌───────────────────────── DSH Host 进程 (Node) ─────────────────────────┐
                 │  plugin: sidebar-browser-control (Host half)                          │
  Agent tools ◄──┤  ctx.tools.register("browser", actions)                              │
  (模型调用)      │   ├─ per-session panel registry / command queue / timeout / policy    │
                 │   └─ bridge server: 127.0.0.1:<port> + token                          │
                 │        ├─ /panel  ←→ 侧边栏客户端插件（自定义 webview）                │
                 │        └─ /ext    ←→ Chrome 扩展（Goal B，Phase 3）                    │
                 └──────────────────────────────────────────────────────────────────────┘
                                        ▲ 长期轮询/WS（JSON 命令）
                                        │
                 ┌──────────────────────┴──────── DSH 客户端 (renderer) ─────────────────┐
                 │  plugin: sidebar-browser-control (Client half)                        │
                 │   侧边栏 tab type "Agent Browser" + body slot                         │
                 │   ├─ dshDesktop.browser.acquire → <webview>（我们自己的 guest）        │
                 │   ├─ webview.executeJavaScript：DOM/AX 快照、注入光标覆盖层            │
                 │   ├─ webview.sendInputEvent：真实鼠标/键盘输入（不移动系统指针）       │
                 │   └─ 操作状态 UI：Agent 控制中 / 用户接管 / 停止                      │
                 └──────────────────────────────────────────────────────────────────────┘
```

为什么桥使用**独立 loopback 服务**而不是 DSH 内部 RPC：

- Host→Client（工具给面板下命令）在 DSH 的公开插件 API 里没有直接的“调用客户端”入口；
  内部 Typert Remote/Client 适配器需要代码生成，本地纯 JS 插件用不了（详见 §7 风险）。
- 独立 127.0.0.1 服务 + 随机/固定 token 与 DSH 版本解耦，Host/Client 两边都是我们自己的代码，
  失败模式简单；不给 DSH 升级引入私有依赖。代价是需要处理 CORS/PNA 与端口发现（Phase 0 验证）。

## 4. Goal A 交互与实现要点

工具（首版，模型可一次传 action）：

| action | 参数 | 说明 |
|---|---|---|
| `open` | `url` | 在侧边栏打开/复用 Agent Browser 标签并导航 |
| `snapshot` | `maxChars?` | 返回可交互元素列表：`ref`、角色/标签、文本、坐标、是否可见；作为模型点击的依据 |
| `click` | `ref` 或 `x,y` | 先 `elementFromPoint` 校验，再在元素中心派发真实鼠标事件 |
| `type` | `ref`/`text` | 先聚焦元素再逐键输入（或 `input` 事件） |
| `key` | `key` | Enter/Tab/Escape/方向键等 |
| `scroll` | `deltaY` / `ref` | 滚轮事件 |
| `navigate` | `url` | 地址导航 |
| `wait` | `ms` / `selector` | 等待加载/选择器 |
| `screenshot` | — | 若 webview 可截屏则返回图片，否则暂不提供（Phase 2 决定） |

前端光标（对齐 Codex 的做法，但更克制）：

- 注入一个 `position:fixed; inset:0; pointer-events:none; z-index:max` 的覆盖层（open shadow root），
  内部一个“Agent 光标”元素与点击涟漪；用 CSS transition/transform 移动到目标点，不移动系统指针。
- 覆盖层只在 Agent 操作时出现，`pointer-events:none` 保证用户仍可直接操作页面；
  用户一旦直接操作（面板获得焦点/真实输入）即视为“接管”，暂停 Agent 操作并提示。
- 页面 CSP 可能拦截注入 `<style>`：使用 `adoptedStyleSheets` 注入样式（调研中发现的实际坑）。
- 点击坐标换算统一用 `getBoundingClientRect` + devicePixelRatio 校准；点击前做命中测试，避免 Codex 的坐标错位问题。

安全边界（首版）：

- 只操作我们自己的 webview；不触碰 DSH 自带 Browser guest。
- 导航限 http(s)，拒绝 DSH 自身 origin 与 file:（主进程已有部分限制，插件再校验一次）。
- 面板内提供显眼的“Agent 控制 / 停止 / 用户接管”状态与开关。
- Tool 默认超时与“面板未打开”明确报错，不静默失败。

## 5. Goal B（Chrome 扩展）实现要点

- **扩展（MV3）**：`extensions/chrome-bridge/`
  - service worker：连接 `ws://127.0.0.1:<port>/ext?token=…`（或 HTTP 长轮询回退）；
  - `chrome.debugger.attach({tabId}, "1.3")` 按标签页 attach；`chrome.tabs.query` 列表；
  - CDP 动作：`Page.navigate`、`Input.dispatchMouseEvent`、`Input.insertText`、`Runtime.evaluate`、
    `Page.captureScreenshot`、`DOM.getDocument`/`Accessibility.getFullAXTree`；
  - 配对：扩展 popup 里输入/自动发现端口+token；标签组标识“Agent 正在控制的标签”；
  - 用户可随时关闭调试（Chrome 自带提示条与“取消”），插件检测断连。
- **Host 侧**：与 Goal A 共用一个 bridge，增加 `channel=chrome`；工具面统一为 `browser`，
  以 `target: "sidebar" | "chrome"` 区分（或按需拆成两个工具，Phase 3 定）。
- **后台标签页**：`chrome.debugger` 按标签页 attach，不要求标签在前台；
  截图/点击在后台标签的表现需 Phase 3 实测（其中“后台截图是否空白”是主要不确定点，
  若不支持则以 DOM/AX 文本操作为主）。
- **安装方式（待定）**：开发期 `chrome://extensions` → 开发者模式 → 加载已解压扩展；
  正式分发可选自签名 CRX / 商店上架（需要用户决定）。

## 6. 分阶段计划与验收

| 阶段 | 内容 | 验收（都必须在运行中的 DSH 实测） |
|---|---|---|
| **Phase 0 spike**（1 个插件骨架，失败即删） | S1：客户端插件在自己注册的 tab 里创建 leased webview，`executeJavaScript`/`sendInputEvent` 生效、覆盖层可见；S2：Host 工具 ↔ loopback 面板桥往返；S3：webview 截屏是否可用 | `example.com` 上：snapshot 有元素、click 链接跳转、type 进输入框；无系统鼠标移动；桥往返 < 100ms |
| **Phase 1 Goal A MVP** | 上面 §4 的工具与光标、状态 UI、错误处理 | 打开站点→snapshot→点击/输入/滚动→验证页面状态；用户可直接接管；停止按钮立即生效 |
| **Phase 2 Goal A 硬化** | 多标签、iframe、等待策略、locale/icon、设置页、安全策略、文档 | 在 3 个真实站点（含中文站点）完成一次端到端任务；插件页显示正常 |
| **Phase 3 Goal B MVP** | 扩展 + WS + `chrome.debugger` + 前台/后台标签操作 + 配对 | 用户 Chrome 中一个新标签：导航/点击/输入；切到后台后仍能 snapshot/点击；可随时断开 |
| **Phase 4 收尾** | 统一工具体验、可选 native messaging、dist 打包、版本 1.0.0 | 两个 goal 的用户流程走通，文档与 dist 更新 |

每个阶段：`plugin_manager install_bundle` → 实测 → `git commit` → 更新 dist（需要时）。

## 7. 主要风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| DSH 无公开 Host→Client 调用入口 | 桥不通 | 采用 loopback 服务桥（不依赖内部 RPC）；Phase 0 先验证 |
| 客户端页面（dsh-app://）到 127.0.0.1 的 CORS/PNA 限制 | 面板连不上 Host | 服务端返回 CORS/PNA 头 + token；备选：走 DSH `webServer` 升级路由 |
| webview 主进程策略（lease、导航限制）与版本升级 | 插件失效 | 用公开能力（`dshDesktop.browser`、公开 tab 扩展点）；产品升级后用 `scripts/verify.ps1` 思路加浏览器专项自检 |
| `webview.sendInputEvent` 在后台/失焦时的行为 | 点击无效 | Phase 0 实测；备选注入 DOM 事件（isTrusted=false）或让面板先聚焦 webview |
| 后台标签页截图空白（Chrome 渲染节流） | Vision 能力受限 | 以 DOM/AX 文本为第一等公民；截图作为增强 |
| `chrome.debugger` 的“正在调试”提示与权限 | 用户观感 | 明示状态；按标签页 attach；可一键断开 |
| 依赖体积/磁盘 | 宿主磁盘紧张 | 零第三方依赖（不装 Playwright/Puppeteer/Chromium）；必要时 pnpm store 迁到 K: |
| 安全：Agent 自动操作登录态页面 | 误操作风险 | 默认“面板内显式授权/站点白名单”，操作日志 + 停止（待用户决策，见 §8） |

## 8. 已决策（用户，2026-10-22）

1. **授权模型：B — 完全自动**。Agent 打开面板后可操作任何站点，无需逐站批准；
   保留显眼的「停止 / 用户接管」与操作日志作为安全阀。
2. **Chrome 扩展分发：B — 同时做自签名 CRX**。开发期用开发者模式加载未打包目录迭代，
   Phase 4 产出自签名 `.crx` 便于固定安装（仍需开发者模式/策略允许）。

## 10. 开发流程与测试（强制，2026-10-22 起）

用户要求：**先构建测试用例，对着测试用例开发，测试通过确认无误后再应用**。
仓库根目录提供测试入口：

```powershell
cd <repo>
npm test
```

现有测试覆盖（见 `npm test`）：

| 文件 | 覆盖 |
|---|---|
| `tests/support/client-harness.mjs` | 在 Node VM 里用 mock 的 `window.__ModuleLoader__` / `require` / `fetch` / `document` / `AbortSignal` 执行**真实 client.js** |
| `tests/browser-control-client.test.mjs` | 模块 id、plugin 形状、**BOOT CONTRACT（apply 不得返回 thenable）**、tab/body 注册、openTab 重试、ping 往返、**卸载后停止轮询**、mount/命令分发/光标/点击/输入/滚动/导航等待 |
| `tests/bridge.test.mjs` | 桥的 HTTP 契约：token 鉴权、poll 投递、result 结算、diag、关闭时结算 pending、**只投递给最新 client 实例**、**关闭时结束挂起 long-poll**（端口 0，不占用真实端口） |
| `tests/browser-control-host.test.mjs` | Host apply 同步完成、工具注册、**DS 兼容 schema 回归**、参数校验、fake client 端到端往返（open/snapshot/click/type/scroll）、监听启动、dispose 安全 |
| `tests/browser-control-*.test.mjs` / `tests/bridge.test.mjs` | Agent 浏览器 client/host 与桥的回归测试 |

**两条硬规则**（违反其一就会重现 2026-10-22 的启动事故）：

1. client 插件 `apply()` **必须同步返回 `undefined`**，后台循环一律 fire-and-forget；
   client 代码禁止顶层 await / 阻塞式初始化。
2. 打包桌面端 **client 代码改动必须重启 App 验证**；不要依赖运行期 HMR。

开发顺序（每个变更都必须遵守）：

1. 先在 `tests/` 写/改测试并让它失败（红）；
2. 改实现直到 `npm test` 全绿；
3. `plugin_manager remove_bundle` → `install_bundle` 重新安装 Host 半；
4. 需要 client 半变更时，请用户重启 App，再按 `%TEMP%\dsh-browser-control-state.json` 的诊断验证；
5. 验证通过才提交；**测试未绿不允许启用 bundle**。

## 11. Phase 0 进展（早期 spike 代码已在公开前移除，历史提交可查）

- **S2 桥已验证**（2026-10-22）：
  - Host 插件零依赖注册工具 + 起站 `127.0.0.1:47833`（`node:http`），写诊断状态到 `%TEMP%\dsh-browser-spike-state.json`；
  - 客户端半（`dsh.client.immediately: true`）**热加载即生效，无需重启/刷新**，从 `dsh-app://app`
    页面直接 `fetch` 该端口（CORS `*` + PNA 允许头即可），证明 CORS/PNA 不拦；
  - Host→Client→Host 全链路自动 ping：往返 **3–6ms**，客户端回报
    `origin: dsh-app://app`、Electron 44.7.0 / Chrome 152 / DSH 0.2.1-rc.2。
- **工具 schema 的坑（已修复）**：profile 插件用裸对象注册工具时不会经过
  `defineTool` 的 `parameterSchemaSpecToJsonSchema` 转换，DSH 方言
  （属性内 `required: true`）原样上 wire，DS 上游 400：`schema must be a JSON Schema of type:"object", got type:null`。
  修法：**手写等价 JSON Schema** —— 顶层 `{ type:"object", properties, required:[...] }`，
  属性内不带 `required` 标志（与 `defineTool` 输出逐字段同形）。正式插件沿用此约定，
  （若事实证明 profile 插件可 `import "@deepseek-ai/dsh-tools"`，可改回 `defineTool`，待验证）。
- **S1 侧边栏 webview 控制已验证**（2026-10-22，自检 7/7 全过）：
  - `dshDesktop.browser.acquire()` 拿到 lease/partition；`<webview src="about:blank#lease">` 成功挂载
    （`dom-ready`，webContentsId=2），导航 `https://example.com/` 正常；
  - `snapshot`：`executeJavaScript` 返回可交互元素（ref/文本/坐标/可见性），example.com 上正确列出
    “Learn more” 链接（x=280,y=731）；
  - `overlay`：shadow-DOM 光标覆盖层注入成功（`translate(48px,64px)`），`pointer-events:none`，
    不影响系统鼠标；
  - `click`：在链接中心派发 `sendInputEvent`（mouseDown/mouseUp）→ **真实跳转**到
    `https://www.iana.org/help/example-domains`（`navigated: true`）；
  - `type`：`sendInputEvent({type:'char'})` 逐字符输入，注入的输入框得到 `"abc"`；
  - `capabilities`：`loadURL / executeJavaScript / sendInputEvent / insertCSS / **capturePage** /
    getWebContentsId / focus / reload / getURL` 全部可用 → 截图能力具备（Phase 2 接）；
  - 桥在整套自检期间保持 **3–7ms** 往返。
- 经验修正：在**新启动**的 App 实例里，运行期启用 bundle 仍可热加载 client 模块（graph 通道存活）；
  但**替换已加载的同一模块**不会生效。所以 client 代码迭代仍需重启，新 id 的首次加载可以不重启。
- 待办：`scroll` 用例在 google.com 上测到 `scrollHeight == innerHeight`（页面未撑开/加载未完成），
  Phase 1 用更稳的等待策略重测。

## 12. Phase 1 进展（`sidebar-browser-control/` → `@local/dsh-sidebar-browser-control`）

**MVP 已落地并完成端到端验证**（2026-10-22）：

- **工具面**：`browser`（`open / navigate / snapshot / click / type / key / scroll / wait / status`），
  参数为 wire-ready JSON Schema（object root + required 数组），坐标/ref 两种寻址；
  只允许 http(s) 导航。
- **Client**：注册 `Agent Browser` 侧边栏标签类型；`dshDesktop.browser.acquire()` 拿 lease 建 webview；
  snapshot 用页面内 `window.__dshAgentRefs` 保存元素引用；点击前先 `elementFromPoint` 命中测试、
  再移动 shadow-DOM 虚拟光标（180ms 过渡），然后 `sendInputEvent` 派发真实 mouseDown/mouseUp；
  `type` 支持 ref 聚焦 + 逐字符 char 事件；`wait` 支持时间或选择器轮询。
- **测试先行**：`tests/browser-control-client.test.mjs`（12 项，VM 执行真实 client.js）+
  `tests/browser-control-host.test.mjs`（7 项，含 fake client 端到端往返）；整套 **36 项全绿**。
- **端到端实测**（子 agent 只调 `browser` 工具）：
  - `status` → 桥 47834、client 在线；
  - `open https://example.com/` → `opened ... (Example Domain)`；
  - `snapshot` → `ref=0 <a> "Learn more" @280,731`；
  - `click ref=0` → 真实跳转到 `https://www.iana.org/help/example-domains`；
  - 再次 `snapshot` → 31 个可交互元素；`scroll deltaY=300` → ok。
- 已知体验缺口（下一批改进，需一次重启验证）：scroll 结果没有回显 `scrollY`；type 后没有回显输入框值；
  click 后对“是否发生导航”只是事后比对 URL（可改为等待导航事件）；截图（`capturePage` 可用）尚未接入工具。

**Phase 1 修复与增强（2026-10-22 第二轮，已测试但待重启验证）**：

- **生命周期 bug**：client 桥循环在插件卸载后不会停止（重装后出现多个重复 client 轮询）；
  修复为 `AbortController` 生命周期 + 循环内检查，卸载即中止。
- **多实例路由**：bridge 只把命令投递给**最新注册**的 client 实例（`firstSeenAt`），
  旧实例的 poll 立即返回空——重装后不会把命令发给已销毁的旧面板。
- **关闭挂起**：`bridge.close()` 先结束所有挂起的长轮询再关闭监听，Host 卸载/测试不再挂起。
- **体验增强**：click 等待 `did-navigate` 并回报 `navigated`；scroll 回显 `scrollY/scrollHeight/innerHeight`；
  type 回显聚焦元素当前值；snapshot 过滤不可见元素并回报 `skipped` 数量；工具文本提示“refs 仅对最近一次 snapshot 有效”。
- 测试从 36 → **42 项全绿**（新增卸载停止轮询、最新实例路由、关闭长轮询、导航等待、scroll/type 回显等用例）。
- 验证状态：以上 client 改动需**重启 App** 后生效；当前页面里残留的是修复前的旧 client 实例（会造成 47834 端口轮询争用），
  重启即清空。重启后按 `%TEMP%\dsh-browser-control-state.json` 的 `activeClient` 与 `diags` 验证。

**Phase 1 重启后验证（2026-10-22，已通过）**：

- 干净状态：重启后仅一个 client（`activeClient` 正确）；旧标签页自动恢复面板并拿到新 lease。
- 子 agent 实测（仅用 `browser` 工具）：open/snapshot/click 导航到 iana.org 且 click 文本回报
  `page changed to …`；`type` 回显 `focused value`；snapshot 过滤隐藏元素（DuckDuckGo 175 可见 + 9 hidden skipped）；
  `scroll` 现在**真实滚动**（example.com 35px、Wikipedia 600px），并标记 `[script fallback]`——
  合成 wheel 事件在 guest 中不稳定，脚本 fallback 兜底。
- 已知小问题：ref-click 回显的坐标是"滚动到视口后"的坐标，与 snapshot 里的 @坐标不一定相同（仅观感差异，点击本身正确）。
- **截图能力已验证**（2026-10-22 第三轮）：`browser action=screenshot` → `capturePage()` 生成 PNG
  落盘到 `%TEMP%\dsh-browser-shots\`（实测 46,534 字节、575×742），返回路径；用 `read_image` 打开确认
  是真实页面渲染（不是空白/黑图）。工具描述里已提示模型用 `read_image` 查看。

## 13. Goal B 进展（`chrome-bridge/` + `extensions/chrome-extension/`）

**MVP 代码完成、测试通过，等待在 Chrome 中加载扩展后做真实端到端验证**（2026-10-22）：

- 传输：`chrome-bridge/ws.js` —— 零依赖 RFC6455 服务端（握手、64 位帧、ping/pong、close、
  token 鉴权、新连接替换旧扩展实例），监听 `127.0.0.1:47835`。
- Host 工具：`chrome`（status/tabs/newTab/closeTab/attach/detach/navigate/snapshot/click/type/key/scroll/screenshot），
  schema 为 DS 兼容的 object-rooted JSON Schema；无扩展时返回加载扩展的操作提示；
  `newTab` 默认在**后台**新建（不抢用户当前标签），`screenshot` 经 CDP 截 PNG 后返回文件路径（`read_image` 查看）。
- 扩展：MV3（`debugger/tabs/storage/alarms` 权限，无 content_scripts、无远程代码）；
  service worker 维持到 Host 的 WebSocket（Chrome 116+ 的 WebSocket keepalive）+ 1 分钟 alarm 兜底重连；
  `controller.js` 按标签页 `chrome.debugger.attach(…, "1.3")`，用 `Runtime.evaluate` 做 snapshot/refs、
  `Input.dispatchMouseEvent/insertText/dispatchKeyEvent` 做真实输入；操作时不要求标签页在前台。
- 测试：`tests/ws-bridge.test.mjs`（6）、`tests/chrome-bridge-host.test.mjs`（6）、
  `tests/chrome-extension-controller.test.mjs`（9）、`tests/chrome-extension-manifest.test.mjs`（4）；
  全套 **69 项全绿**。
- 待验证（需人工加载扩展）：`chrome://extensions` → 开发者模式 → 加载已解压扩展
  （`extensions/chrome-extension/`）→ 选项页确认端口/token → `chrome action=tabs` 应列出真实标签页，
  `attach/navigate/snapshot/click` 生效，且标签页切后台后仍可操作。

**Goal B 真机联调结果（2026-10-22，最终通过）**：

- 用户加载扩展后，`chrome` 工具 13/13 步全部一次通过（0 重试、0 超时）：
  `status → newTab(后台) → attach → snapshot → click(ref) → snapshot → navigate → snapshot →
  type(ref) → key Enter → wait → snapshot → screenshot → closeTab`。
  - 后台新建标签 `1221655429`，点击 "Learn more" **真实跳转**到 iana.org（无脚本兜底）；
  - 在 DuckDuckGo 输入 `deepseek harness` + Enter，快照 URL 带 `q=deepseek+harness`；
  - 后台标签截图成功（1662×1355 PNG，240KB），`read_image` 确认是真实搜索结果页；
  - 用户原有的视频标签与后台标签**全程未触碰**，测试标签最后已关闭。
- 心跳保活验证：同一连接 `connectedAt` 稳定超过 2.5 分钟（修复前每 45–75 秒重连一次）。
- 结论：Goal B（真实 Chrome、后台标签、截图）MVP 完成并验证。
- **标签组**（用户建议）：Agent 新建/接管的标签自动进入橙色的 “DSH Agent” 标签组
  （`chrome.tabs.group` + `chrome.tabGroups.update`，manifest 增加 `tabGroups` 权限），
  用户可一眼区分 Agent 工作标签与自己的标签，避免误关；分组失败只报告不阻塞操作。
  改动已通过单测；用户在 `chrome://extensions` 刷新扩展后实测：`newTab` 返回
  `created tab … in the background [tab group: DSH Agent]`，分组生效（空组在标签关闭后自动消失）。

## 14. 打包与分发（2026-10-22）

- **Chrome 扩展自签名 CRX3**（用户决策 B）：`npm run pack:crx`
  → 本地构建产物（不入库）：`npm run pack:crx` 生成 `dist/dsh-chrome-bridge.crx`、同名 `.zip`
  与签名私钥 `dist/*.pem`。私钥永不提交；换私钥 = 换扩展 ID。
- CRX3 格式与签名由零依赖实现（`scripts/crx.mjs`：store-method ZIP + protobuf + RSA-2048
  PKCS#1 v1.5 over `CRX3 SignedData\0 | len | signed_header_data | zip`），
  `tests/crx-pack.test.mjs` 6 项覆盖：结构、签名可验证、篡改必失败、crx_id 稳定性、真实扩展打包。
- 安装方式：
  - `chrome://extensions` → 开发者模式 → **加载已解压**（`extensions/chrome-extension/`，最稳）；
  - 或把 `.crx` 拖入扩展页（部分 Chrome 版本会拒绝非商店 CRX；被拒时用上面的解压目录方式，代码相同）。
- 本机日常使用建议：扩展保持“加载已解压”指向本仓库目录（改代码后点刷新即可），
  CRX/zip 作为备份与其它设备分发。


**Goal B 首次真机联调（2026-10-22）发现的缺陷与修复**：

- **MV3 连接抖动**：service worker 被挂起后重连，`status` 仍报“已连接”，实际命令分发失败
  （实测约 45–75 秒重连一次；WS 协议层 ping 不算 JS 活动）。修复：Host 每 15s 发**应用层
  `{type:"ping"}`**，扩展回 `pong`（JS 消息保活）；45s 无响应判定 stale 并断开；
  工具侧遇到瞬时断连先等 2.5–3s 重连再重试一次，而不是立刻返回“未连接”。
- **后台标签输入不生效**：chrome.debugger attach 后，隐藏标签没有焦点，合成鼠标事件被丢弃。
  修复：attach 时调用 `Emulation.setFocusEmulationEnabled {enabled:true}`；
  鼠标事件补 `buttons` 位掩码（按下 1 / 抬起 0）；若 700ms 内没有导航，ref 点击再走
  `element.click()` 脚本兜底（返回 `method: "input+script"`）。
- 首次联调已验证：`status`/`tabs`（列出用户真实标签）、`newTab`（后台 1221655422）、
  `attach`、`snapshot`（Example Domain）、`screenshot`（PNG 45,731 字节落盘）、`closeTab` 均可用；
  点击导航与后台输入待扩展重新加载后用新代码复验。

## 15. 本机桥安全加固（2026-10-23）

侧栏浏览器插件的 Host↔Client 桥曾使用**固定默认 token + query 参数**，且不校验
`Host`/`Origin`。对照 BrowserTools MCP 1.x 的 WS RCE 事故后按最小成本加固：

- 仍只绑定 `127.0.0.1`；新增 **Host 校验**（必须是 `127.0.0.1:<port>` / `localhost:<port>`，
  防 DNS rebinding）。
- Token 从 query 移到 **`Authorization: Bearer`**（URL 会进日志/进程列表）；
  比较改为 `timingSafeEqual`。
- **Origin 白名单**：只放行 DSH renderer 的 `dsh-app://app` 与 `null`；网页 Origin 一律 403。
  CORS 不再返回 `*`，只回显允许的 Origin，并声明 `Vary: Origin`。
- OPTIONS 预检在 Origin/Host 校验之后处理；允许 `authorization` 请求头。
- 诊断状态新增 `lastRejectedOrigin` / `lastRejectedHost`，联调时可直接看被拒来源。

测试：`tests/bridge.test.mjs` 新增 6 项（拒绝 query token、foreign Host、foreign Origin、
允许 dsh-app origin + CORS 回显、允许/拒绝预检），全套 **129 项全绿**；真机重装后
新 client（`bc-…`）正常连上，`browser status/open/snapshot/screenshot` 全通。


### chrome 桥（2026-10-23）

- 升级握手：token 从 `ws://…/ext?token=…` 移到连接后的 `hello` 消息字段；URL 不再携带密钥。
- 升级请求校验 **Host**（`127.0.0.1:<port>` / `localhost:<port>`）与 **Origin**
  （只允许 `chrome-extension://…`；网页 Origin 一律 403）；`/hello` 的 CORS 同样只回显扩展 Origin。
- token 比较改为 `timingSafeEqual`；诊断状态记录 `lastRejectedToken/Origin/Host`。
- 扩展 background 改为无 query 连接 + hello 带 token；版本 0.1.2。
- 测试：`tests/ws-bridge.test.mjs` 新增 5 项（错误 hello token、query token 无效、foreign Host/Origin、
  chrome-extension Origin 放行），`tests/chrome-bridge-host.test.mjs` 更新握手；全套 **133 项全绿**。
- 真机：Host 重装后旧扩展被正确拒绝（`lastRejectedToken`），扩展刷新后复验。

后续（未做）：随机配对 token（避免固定默认值）。
chrome 桥同样的 Origin/Host 加固与
token 移出 WS query。

## 9. 与仓库其他部分的关系

- 本仓库每个插件一个顶层目录；本插件的 Host/Client 代码放 `sidebar-browser-control/`，
  Chrome 扩展放 `extensions/chrome-bridge/`，测试放 `tests/`，设计与记录放 `docs/`。
- 通用更新复检沿用根 README 的流程：DSH 更新后跑 `scripts/verify.ps1`（后续扩展为同时检查本插件）。


## 16. 快照 v2：缩进树 + 稳定 refs（2026-10-23）

- 快照从 400 元素平铺改为**深度受限缩进树**（interactive 元素 + h1–h3/landmark），每行 `[ref] role "name" @x,y -> href`。
- ref 改为基于 tag/role/text/href/name/type 的 FNV **稳定 id**（如 `e52c4ns`），跨快照复用；缺失/过期返回明确提示（`take a new snapshot`）。
- 虚拟光标/波纹带 `data-dsh-agent-ui`，快照时排除，避免 ref 漂移或点到自身 overlay。
- 截断可操作：返回 `omitted`/`skipped`/`pagesBelow` 并提示 `action=scroll`；Host 最多输出 80 行。
- click 回执带 `hitTrusted`；目标被遮挡时输出 warning，提示改用坐标点击。
- 真机验证：example.com = 1 个 link（`e52c4ns`）；Wikipedia DeepSeek = 150 元素 / 1217 over limit / 23 页提示；refs 稳定。
- 测试：全套 **134 项全绿**（快照树、稳定 ref、overlay 排除、stale 报错、截断提示断言）。

## 17. 动作 settle 与回执、ref 点击坐标修复（2026-10-23）

- 动作后执行页面内 **settle**：MutationObserver 统计 DOM 突变，约 100ms 静默或 3s 上限；导航销毁上下文时降级为 `navigatedAway`。
- `click`/`type`/`key`/`scroll` 返回 `settle` 与 `changed`；click 还带 `hitTrusted`，无 URL/滚动/DOM 变化时提示 `no observable change`（可能被遮挡或 inert）。
- 修复 ref 点击坐标偏移：`scrollIntoView` 可能是异步/平滑滚动，旧代码立即取 rect 导致点到滚动前位置。现在等待两帧并循环确认 `scrollY` 稳定后再测 rect。
- 真机验证：Wikipedia "Liang Wenfeng" ref 点击在滚动稳定后命中并正确导航（快照 y=707 → 实际派发 y=334，导航证明 resol 正确）。
- 待复验：type 测试时 Agent Browser 面板被关闭/客户端断连（bridge 返回 no client result），需要重开面板后继续验证。
- 测试：全套 **135 项全绿**（settle 调用、回执警告、滚动稳定脚本断言）。

## 18. 输入 / 引用稳定性 / chrome settle（2026-10-23）

- **type 改用 `webContents.insertText`**（走真实编辑管线，React/Vue 受控输入能收到）；无 insertText 时回退逐字符 char 事件。真机 Bing：输入后 `focused value` 与下一次快照 `= "deepseek harness"` 均确认落地。
- 快照元素新增 `value`（input/textarea/select）与 `checked`（checkbox/radio），Host 输出 `= "…"` / `[checked]`，便于验证输入结果。
- **control ref 稳定**：stableId 对 input/textarea/select 排除其当前 value 派生的可访问名，输入前后 ref 不变（真机 evjx1pi 保持）。
- key Enter 增加 char keypress 事件（隐式提交所需）；真机测试中 Enter 触发后 Agent Browser 面板被关闭（两次复现），提交结果未确认，面板需重开。疑似导航/面板 teardown 关联，待改用 form.requestSubmit 或显式提交控件再验证。
- chrome 侧同步加入同样的 settle（MutationObserver 100ms/3s）、click `changed` 警告与回执；扩展需刷新后真机验证。
- 测试：全套 **135 项全绿**。

## 19. chrome Host 侧 refs、console/network 回执（2026-10-23）

- `snapshot` 优先调用 `Accessibility.getFullAXTree`；refs 为 `n<backendDOMNodeId>`（如 `n123`），只保存在扩展 Host 侧，页面 JS 无法伪造/覆盖，节点重现时可复用；旧页面 JS 快照保留为 fallback。
- `click` 通过 `DOM.pushNodesByBackendIdsToFrontend` → `scrollIntoViewIfNeeded` → `getBoxModel` 实时取坐标，并用 `DOM.getNodeForLocation` 给出 `hitTrusted`；`type` 用 `DOM.resolveNode` + `Runtime.callFunctionOn` 聚焦后 `Input.insertText`。
- 快照输出与侧栏一致：缩进树、`[n123] role "name"`、value/checked、omitted/truncated 提示。
- 新增 `logs {tabId,limit?}`：收集 `Runtime.consoleAPICalled`、`Log.entryAdded`、`Network.loadingFailed`、HTTP>=400 响应，每 tab 120 条环形缓冲。
- key Enter 在未导航时回退 `form.requestSubmit()`（与侧栏相同策略）。
- 扩展升到 0.1.5；测试 138 项全绿。真机验证需刷新扩展（AX refs/logs 生效）。

## 20. chrome AX refs 真机修复（2026-10-23）

- 真机发现 `click` 报 `Document needs to be requested first`：AX ref 解析前必须先 `DOM.enable` + `DOM.getDocument`（已加）。
- `Accessibility.getFullAXTree` 会混入浏览器 UI（翻译气泡/右键菜单等）；快照现在批量 `DOM.pushNodesByBackendIdsToFrontend`，只保留能解析到本页 document 的节点，同时提前校验 ref。
- `type` 在不可编辑页面会假成功（把 body 文本当 focused value）；现在要求 activeElement 是 input/textarea/select/contenteditable，否则明确报错。
- 版本 0.1.6；测试 139 绿；待扩展刷新后复验 click/type/过滤效果。

## 21. chrome upload 与侧栏输入校验（2026-10-23）

- chrome 新增 `upload {tabId, ref, paths[]}`：对快照中的 file input（AX ref）调用 `DOM.setFileInputFiles`，返回 settle/回执。
- 侧栏 `type` 与 chrome 一致：要求 activeElement 是 input/textarea/select/contenteditable，否则明确报错（避免把 body 文本当输入成功）。
- 扩展/宿主升到 0.1.7；测试 **141 项全绿**；需刷新扩展与重开侧栏面板复验。

## 22. chrome execute 分派修复、evaluate、帧过滤（2026-10-23）

- 修复 `logs`/`upload` 在 Host schema 中存在但扩展 `execute` 未分派的问题（真机曾报 `unknown action`）。
- 新增 `evaluate {tabId, expression}`：Runtime.evaluate（returnByValue + awaitPromise），用于调试/读取页面状态。
- AX 快照增加帧过滤：`Page.getFrameTree` 取主 frameId，`DOM.describeNode` 校验节点 frameId，剔除浏览器 UI（翻译气泡/右键菜单等）节点。
- 版本 0.1.8；测试 **142 项全绿**；需刷新扩展后复验 logs/upload/快照过滤。

## 23. chrome AX 浏览器 UI 过滤与 Host 分派修复（2026-10-23）

- 真机发现 `logs/upload/evaluate` 在 Host schema 中存在但 `toCommand` 无分支 → Host 直接报 unknown action；已补 `toCommand` + `formatResult`，并加 host dispatch 单测（143 绿）。
- AX 树混入的浏览器 UI 节点（图片翻译/语音翻译/添加到收藏夹/快捷设置）不在页面 DOM（`document.querySelectorAll` 与 textContent 扫描为空），帧过滤无效；现对每个候选 `DOM.resolveNode` + `Runtime.callFunctionOn` 校验 `getRootNode() === document`，不属于页面文档的节点全部剔除。
- 版本 0.1.9；需刷新扩展后复验：快照只含页面节点、`logs`/`evaluate`/`upload` 可调用。

## 24. 侧栏浮动兜底面板、Enter 提交与 chrome wait（2026-10-23）

- 多次插件重载后 DSH 右侧栏会保留陈旧 tab 且不再挂载 body（UIA/OCR 确认右侧空白）；新增**浮动 Agent Browser 兜底面板**（fixed 右侧、可关闭），侧栏 `waitReady` 2.5s 失败后自动创建并挂载 webview，工具恢复可用。
- tab type 改为每次模块加载唯一 id/kind（旧 tab 不再复用），并记录 mount-start/acquired/ready/failed 诊断。
- 真机验证：浮动面板下 `open/snapshot/screenshot` 通过；Bing 输入 + Enter 后**成功跳转搜索结果**（title `deepseek harness - 搜索`，URL `/search?q=...`），Enter `requestSubmit` 兜底生效。
- chrome 新增 `wait {tabId, selector|text|ms}`（轮询文档选择器/文本）；顺带修复 Host `toCommand` 未分派 `wait` 的问题。版本 0.1.12，测试 **145 项全绿**。

## 25. iframe 支持（2026-10-23）

- `buildFrameOffsets`：`Page.getFrameTree` 递归 + `DOM.getFrameOwner` + `DOM.getBoxModel` 计算每个子 frame 相对主 frame 视口的偏移表（嵌套累加）。
- AX 快照保留解析得到的子 frame 节点（`element.frame = frameId`，Host 输出附加 `(iframe)`）；主 frame 继续做浏览器 UI 过滤。
- `click` 对子 frame ref 使用 `getBoxModel` 本 frame 坐标 + frame 偏移换算成主视口坐标后 `Input.dispatchMouseEvent`；子 frame 不做主 frame 命中判断（`hitTrusted` 留空）。
- 限制：跨进程 OOPIF 若 `DOM.pushNodesByBackendIdsToFrontend` 失败会被丢弃（占位不可见），当前优先同进程 iframe；`type` 在子 frame 内暂不保证聚焦。
- 测试：controller 的 frame tree/frame owner/box model mock 回归（子 frame 元素保留、点击坐标 120,230 正确）；版本 0.1.14。

## 26. iframe 真机迭代（2026-10-23）

- 真机发现主 AX 树为空：新 `axSnapshot` 漏了 `Accessibility.enable`，导致只剩子 frame 结果（所有元素被标 `(iframe)`）。已补 enable。
- iframe 内容预留配额：主 frame 最多 120 个元素，子 frame 最多 30 个（无子 frame 时主 frame 仍可用满 150）。
- 子 frame 点击：优先 `DOM.resolveNode({backendNodeId})` + `Runtime.callFunctionOn(this.click())`；失败再回退 frame 偏移坐标点击，并标注方法。
- 真机验证被并发桌面占用打断（另一个对话使用 computer-use/chrome、COMPUTER_USE_BUSY、用户 Esc）；0.1.18 扩展尚未刷新，iframe 标记/点击需下一轮安静环境复验。
- 测试 **149 项全绿**。

## 27. iframe 状态收口（2026-10-23）

- 0.1.19 真机（纯 chrome）：`snapshot` 恢复主 frame 内容，并打印全部 150 行；其中 **30 行带 `(iframe)` 标记**（主 frame 120 + 子 frame 30 配额）。
- 仍存在限制：子 frame 内元素点击尝试 script-click/坐标回退，W3Schools 页面点击后无可观察变化（未触发 `iframe element click` 路径）；iframe 内容目前**可读、可定位，但点击可靠性未验证**。
- 结论：iframe 观测支持已交付；点击支持标记为实验性，后续可选通过逐 frame target session（Target.attachToTarget）实现，列入 backlog。
- Host 打印上限从 80 提到 150，避免预留的 iframe 行被截断（commit `66f20b7`）。

## 28. tab group ACL（2026-10-23）

- 一旦存在 “DSH Agent” 组，`snapshot/click/type/key/scroll/logs/upload/evaluate/wait/navigate/screenshot` 只允许组内 tab；`tabs.get(tabId).groupId` 不匹配时返回 `tab N is not in the DSH Agent group; call attach first to opt it in`。
- `newTab` 自动入组；`attach` 是显式 opt-in（把用户 tab 移入 DSH Agent 组，用户拖出组即撤销）。尚无组时不拦截。
- 测试：mock `tabs.get`/`tabGroups.query`，拒绝组外 tab、attach 后放行；全套 **150 项全绿**。
- 真机验证待扩展刷新到 0.1.20（用户手动刷新，未使用 desktop 自动化）。

## 29. tab group ACL 真机部分验证（2026-10-23）

- 0.1.20 真机：`newTab` 自动入组、`attach` 后 snapshot 正常；组外 `chrome://extensions` tab 被**更早的 scheme 守卫**拒绝（`Cannot access a chrome:// URL`），未走到 ACL 分支。
- 待验证：普通 http(s) 且不在 DSH Agent 组的 tab → snapshot 应返回 `not in the DSH Agent group; call attach first`。需要用户手动开一个普通标签页（不要 attach）。
- 单元测试已覆盖 ACL 拒绝与 attach 放行；全套 150 项全绿。

## 30. tab group ACL 入组修复（2026-10-23）

- 真机 ACL 拒绝路径通过：普通 example.com tab（非组内）snapshot 返回 `tab N is not in the DSH Agent group; call attach first to opt it in`。
- 但暴露入组 bug：扩展缓存了已不存在的 DSH Agent group id（991255573），`tabs.group` 报 `No group with id`，attach 仍显示 attached、newTab 无组后缀。
- 修复（0.1.21）：`ensureAgentGroup` 捕获失效 group id 后清空缓存并用无 groupId 重新建组；入组后用 `tabs.get` 轮询确认 membership（最长 600ms）；attach/newTab 暴露 `grouping failed: ...`。`assertAgentTab` 同样短轮询后再拒绝。
- 测试 150 全绿；待用户刷新 0.1.21 后复验 newTab/attach/snapshot 与 ACL 拒绝。

## 31. logs 过滤/清空（2026-10-23）

- `logs {tabId, limit?, filter?, clear?}`：`filter` 对条目 JSON 做大小写不敏感匹配；`clear:true` 清空该 tab 的环形缓冲并返回 clearedCount。
- Host 输出：清空提示、空结果带 filter 提示；schema 增加 `filter`/`clear`。
- 测试 **151 项全绿**；版本 0.1.22，等扩展刷新后真机验证。

## 32. logs 真机验证通过（2026-10-24）

- 0.1.22 真机（纯 chrome）：`newTab` 入组、`attach` 入组、`evaluate` 注入 console error/info、`logs filter=boom` 只返回 boom 条目、`logs clear` 返回 clearedCount=2、之后 `logs` 为 0 条。
- 当前 chrome 侧交付：Host 侧 backendNodeId refs、settle/动作回执、logs（console/network + filter/clear）、upload、evaluate、wait、tab group ACL、iframe 观测（标记 + 内容）；iframe 内点击为实验性（坐标回退）。
- 全套测试 **151 项全绿**；扩展/Host 版本 0.1.22。

## 33. iframe 内点击：frame 隔离世界脚本点击（2026-10-24）

- 参考实现确实解决了 iframe 点击：Playwright MCP 用 frame 前缀 refs（`f1e5`）+ frame 内 locator；chrome-devtools-mcp / browser-use 也通过 Puppeteer/CDP 的 frame 上下文操作。
- 本插件实现：快照时记录子 frame 的 `frameId` 与可访问名；点击子 frame ref 时 `Page.createIsolatedWorld({frameId})` 取得 executionContextId，再 `Runtime.evaluate({contextId})` 在 frame 内按文本定位元素并 `.click()`，返回 `method: iframe-script`；失败再依次回退 `ax-script`、frame 偏移坐标点击。
- 不需要新增扩展权限；Host 对 `iframe-script` 输出 `(iframe script click)`。
- 测试：mock `Page.createIsolatedWorld`/`Runtime.evaluate(contextId)`，断言点击在 frame 上下文执行且无坐标派发；全套 **151 项全绿**。
- 版本 0.1.23；待用户刷新扩展后真机验证 W3Schools iframe 内链接点击。

### iframe 点击受控验证（2026-10-24）

- 本地受控页面（outer + iframe inner.html）验证通过：点击 iframe 内 `GO TO INNER TWO` 后，`contentDocument.location.href` = `http://127.0.0.1:47999/inner2.html`，title/h1 = `Inner Two`；证明点击在 frame 上下文真实执行并触发 within-frame 导航。
- 注意：`iframe.src` 属性不会随内部导航更新，验证应读 `contentDocument.location`。
- W3Schools 的 "CSS" iframe ref 实际是 `target=_blank` 推广卡（campus.w3schools.com），所以此前测试无可观察变化——不是工具失效。
- 0.1.24：iframe 点击成功后 `changed` 记为 true，不再输出误导性的 "no observable change inside the frame"。

0.1.24 受控复验（2026-10-24）：点击 iframe 内 `GO TO INNER TWO` 输出 `(iframe script click)` 且无 no-observable-change 提示；`contentDocument.location.href` = `/inner2.html`，title/h1 = `Inner Two`。

## 34. CDP 仿真与 QA 参数（2026-10-26）

> 本轮迭代计划里写的编号是「25」，但文档 §25 已被 iframe 支持占用，故按现有编号续到 34。

需求来源：`dsh-plugins` 仓库的 `research/feedback-triage-2026-10-26.md` §1 #13（chrome-bridge 缺 screenshot 参数 / viewport·DPR·主题模拟 / networkidle）。chrome-bridge 的定位不变：驱动**真实 Chrome 标签页**，不是 CI/离屏（triage #14），本轮只补可单测的 CDP 参数面。

### screenshot 参数化（`Page.captureScreenshot`）

- controller `captureScreenshot(tabId, input)`：`format('png'|'jpeg'|'webp')`（默认 png）、`quality(0-100，仅 jpeg/webp)`、`clip{x,y,width,height,scale?}`（有限数、宽高 > 0）、`fullPage`、元素截图 `ref` / `selector`；`fullPage/clip/ref/selector` 互斥。
- `fullPage`：`Page.getLayoutMetrics` 取 `cssContentSize` 与 `contentSize` 的 **max**（cssContentSize 不受滚动条裁剪），clip `{0,0,ceil(w),ceil(h)}` 且 `captureBeyondViewport:true`。
- 元素：AX ref 走 `refsByTab` 的 `backendDOMNodeId` → `DOM.resolveNode` → `Runtime.callFunctionOn(this.getBoundingClientRect() + scrollX/Y)`；selector 走 `Runtime.evaluate` 取同样 rect；都是页面（文档）坐标，子 frame ref 再加快照记录的 frame 偏移。
- 回执 `data + format + capture:{mode, clip, width, height}`（width/height 为 round(clip × scale) 的预估像素）。Host `saveScreenshot(base64, format)` 按格式写 `.png/.jpg/.webp`，解析 PNG/JPEG/WebP 头得到**真实**像素尺寸；文案给出 format/像素/字节/路径，预估与真实不一致时标注 `controller expected ...`。
- 限制：超大 fullPage 受 Chrome 截图尺寸上限与 Host 20s 命令超时约束；`clip` 使用页面坐标（配合 captureBeyondViewport），不是视口坐标。

### emulate（CDP Emulation + per-tab 自动复位）

- `emulate(tabId, {width?,height?,deviceScaleFactor?,mobile?,colorScheme?,reset?})`：`tabId` 校验 + `assertAgentTab` + `ensureAttached`。
- set：`width/height` 必须成对；`deviceScaleFactor/mobile` 依赖 width/height；`Emulation.setDeviceMetricsOverride({width,height,deviceScaleFactor,mobile,screenWidth,screenHeight})`；`colorScheme('light'|'dark')` 走 `Emulation.setEmulatedMedia({features:[{name:'prefers-color-scheme',value}]})`。状态按 tab 累加（先只设尺寸再只设配色会保留另一项）。
- 回执：等一帧后 `Runtime.evaluate` 读页面真实 `innerWidth/innerHeight/devicePixelRatio` 与 `matchMedia('(prefers-color-scheme: dark)')`（rAF 在隐藏标签页会被节流，故与 250ms 定时器竞速兜底），返回 `emulated / applied / viewport / colorScheme`。
- reset：`Emulation.clearDeviceMetricsOverride` + `Emulation.setEmulatedMedia({features:[]})` + `Emulation.setTouchEmulationEnabled({enabled:false})`（逐个 try/catch，失败进 `resetErrors`）。
- 自动复位：`detach`、`closeTab` 在结束会话/移除 tab **之前**先复位；`chrome.tabs.onRemoved` / `chrome.debugger.onDetach` 清理 per-tab 记录（Chrome 结束会话时 CDP 覆盖本就随会话丢弃，不会永久留在用户页面）。
- 边界：真实标签页的显示会被临时改变（这是设计目的）；本轮只做 device metrics + media，**未启用触摸仿真**（`mobile:true` 只影响视口布局），是否要 `setTouchEmulationEnabled` 留给真机验证。

### wait networkIdle

- 事件层按 tab 维护 `{pending:Set<requestId>, lastActivity}`：`Network.requestWillBeSent` 加入，`Network.loadingFinished/loadingFailed` 移除并刷新 lastActivity。
- **忽略类型集合**：`Network.requestWillBeSent` 的 `payload.type` 属于 `IGNORED_NETWORK_TYPES = {WebSocket, EventSource, Ping, CSPViolationReport, Prefetch}` 的请求**不进 pending、不刷新 lastActivity**（计数记入 `state.ignored`，回执以 `networkIdle.ignoredTypes` 报出）。这类请求（GitHub 的 beacon/长连接）永不按对产生 `loadingFinished`，计进去会让 pending 永不清零；`loadingFinished/Failed` 对它们的 delete 是无害 no-op。
- `wait {networkIdle, idleMs(default 500)}`：与 selector/text **AND** 轮询；networkIdle 要求 `pending.size === 0` 且静默 ≥ idleMs；总超时仍是 `ms`。回执 `waitedMs` + `networkIdle:{pendingRequests, idleMs, idleForMs(, ignoredTypes)(, timedOut)}`。
- **best-effort 超时**：到 `ms` 时若**只有 networkIdle 未满足**（selector/text 已满足或未要求），返回 `ok:true, waitedMs, networkIdle:{..., timedOut:true, ignoredTypes?}, warning` 而不是抛错（0.1.30 起；此前 github.com 因 beacon 长连接必然 20–30s 超时失败）。warning 文案含 pending 数与「long-lived requests such as beacons may never reach idle」；Host `formatResult` 在 network idle 文案后追加 `best-effort: still N pending (...)` 并回显 warning。**selector/text 未满足的超时仍按原样报错**（错误信息仍带 pending 数与未命中条件）。
- 限制：in-flight 统计从 attach（`Network.enable`）之后开始；attach 前已开始、attach 后才结束的请求不在计数内。`stalePendingMs` 默认 120s 保留（best-effort 超时后不再需要它兜住整体命令），测试可覆盖。

### Host / 测试 / 版本

- Host：`ACTIONS` 增加 `emulate`；schema 新增 `fullPage/clip/format/quality/width/height/deviceScaleFactor/mobile/colorScheme/reset/networkIdle/idleMs`；`toCommand` 逐 action 校验并构造命令，`formatResult` 新增 screenshot/emulate 文案（format/像素/路径、viewport/dpr/colorScheme/reset），DESCRIPTION 注明「真实标签页仿真、会临时改变显示、detach/reset 恢复、不适合 CI/离屏」。
- 测试：controller 新增 15 项（fullPage / jpeg+quality / ref clip / selector+clip / emulate set·reset·colorScheme-only·参数校验 / detach·closeTab·tab 移除复位 / networkIdle 排空·AND·超时 / execute 分派），Host 新增 9 项（schema / toCommand screenshot·emulate·wait / 参数先拒绝 / 图片头尺寸 / 落盘扩展名 / 文案 / 假扩展往返）。全套 **87 项全绿**（基线 62，0.1.27 再 +1 陈旧请求清理）。
- 版本：package.json / manifest / Hello 帧统一 0.1.27。

### 34.6 真机首验记录（2026-10-26，0.1.26 → 0.1.27）

扩展 reload 到 0.1.26 + Host 重启后，在真实 Chrome 上验证（新建后台 tab → attach）：

- **通过**：`newTab`/`attach`/`snapshot`（1662x1355 前台视口）、`emulate {width:390,height:844,deviceScaleFactor:3,mobile:true,colorScheme:"dark"}`（页面回读 `innerWidth=390, innerHeight=844, dpr=3, prefers-dark=true`）、viewport PNG/JPEG 截图（1170x2532 = 390x844 @3x，`read_image` 内容正确、深色配色生效）、`evaluate`、`logs`（console error 与 network-failed 都能读到）、`emulate {reset:true}`（回读 1662x1299 @1x）、`closeTab`。
- **bug 1：clip.scale 必填**。`screenshot {fullPage:true}` 真机报
  `Failed to deserialize params.clip.scale - BINDINGS: mandatory field missing`；当前 Chrome 把
  `clip.scale` 当必填。0.1.27 对所有 clip（用户 clip、fullPage、ref、selector）统一补 `scale: 1`。
- **bug 2：networkIdle 可能挂住**。真机上用 `evaluate` 发一个**不读取 body** 的 `fetch('/slow.png')`，
  Chromium 不发 `Network.loadingFinished`，`pending` 永久停在 1，`wait {networkIdle}` 只能超时。
  0.1.27 给 pending 加 startedAt，超过 `stalePendingMs`（默认 120s，测试可覆盖）的请求视为放弃并清出；
  正常资源（图片/CSS/JS，body 被消费）仍按 loadingFinished 精确排空。
- 待下一轮扩展 reload 后复验：fullPage 实际像素、ref/selector/clip 元素截图、`networkIdle` 在慢页面上的
  等待时长（已用本地 slow probe 观察 requestWillBeSent 计数正确）。

### 34.7 第三轮真机（2026-10-27，0.1.27 → 0.1.28）

0.1.27（clip.scale 修复）reload 后，**viewport 截图正常**（390x844 @2x → 780x1688），但：

- `screenshot {clip: {...}}` 与 `screenshot {fullPage:true}` 都 **20s 超时**；fullPage 尝试后
  tab 被留在 `innerWidth=780, innerHeight=7000`（= clip 尺寸 × dsf），detach/attach 新会话也不恢复，
  只能关掉标签页。结论：真机 Chrome 156 上 `Page.captureScreenshot` 一旦带
  `captureBeyondViewport`（无论有没有 clip）就**不返回**，并且可能污染 tab 的 viewport 状态。
- 0.1.28 重写截图路径，完全不用 `captureBeyondViewport`：
  - `fullPage`：保留当前仿真宽/deviceScaleFactor，`Emulation.setDeviceMetricsOverride` 把高度改成
    内容高度（≤12000 CSS px），等 120ms，截完整视口，再恢复原来的 device metrics（原本没有就
    `clearDeviceMetricsOverride`）。输出像素 = 宽 × 高 × 有效 dsf；base64 超 7MB 帧预算直接报错。
  - `clip` / `ref` / `selector`：统一改为**视口坐标**，只截可见表面；ref/selector 先
    `scrollIntoView({behavior:'instant'})` 并等两帧；越出视口就报错而不是静默截空。
- 测试：fullPage 的 grow/restore 时序、emulation 激活时的 dsf 预测、ref/selector 的 scrollIntoView
  与 awaitPromise、clip 视口裁剪、`captureBeyondViewport` 不再出现；全套 **88 项全绿**。
- 版本：package.json / manifest / Hello 帧统一 0.1.28。真机复验需再 reload 扩展一次。

### 34.8 第四轮真机（2026-10-27，0.1.28 → 0.1.29）

0.1.28 reload 后在真实 Chrome 156 上复验：

- **fullPage 通过**：390x844 @2x + dark 下得到 **780x7000 px**（= 390×3500 × dsf2），读图确认 5 个
  section/颜色/badge 全部正确；截完回读视口仍是 390x844 @2x，没有 34.7 里那种 tab 被卡在截图尺寸的问题。
- **clip 通过**：`{x:20,y:100,width:300,height:200}` → 600x400 px（视口坐标 × dsf2）。
- **selector 通过**（干净的 tab 上）：`#sec2 .badge` → 326x156 px（163x78 × dsf2，滚动条占用后布局宽度）。
- `emulate reset` 回读 1662x1355 @1x；`closeTab` 报 `emulation restored`。
- `networkIdle` 在已空闲页 0ms 返回（慢请求跟踪/放弃清理有单测覆盖）。
- **新问题：并发命令会让其中一个挂死**。同一 tab 同时发 selector 截图 + clip 截图（agent 并行 tool
  call），clip 成功、selector 永久挂住；单独重试 selector 正常。0.1.29 在 `background.js` 里把命令
  串行化（一条 promise 队列），从协议层消除同 tab 并发 CDP 命令的互相踩踏。
- 测试：新增 service worker 串行化断言；全套 **88 项全绿**。版本 0.1.29。

### 34.9 第五轮修复（2026-10-27，0.1.29 → 0.1.30）

反馈真机现象（Lead 复现）：`wait {tabId, networkIdle:true}` 在 github.com 两次 20–30s 超时
（`no extension result before timeout`），`wait {ms}` 与 selector-only 正常。原因：GitHub 有
beacon/长连接请求（Ping/WebSocket 等）不按对产生 `Network.loadingFinished`，pending 永不清零，
而 `stalePendingMs=120s` 大于 Host 20s 命令超时，超时前永不放行。

0.1.30：

- `controller.js`：新增 `IGNORED_NETWORK_TYPES = {WebSocket, EventSource, Ping, CSPViolationReport, Prefetch}`，
  这些类型的 `requestWillBeSent` 不进 pending、不刷新 lastActivity（`networkIdle.ignoredTypes` 报出计数）。
- `waitFor` 超时改 best-effort：只有 networkIdle 未满足时返回 `ok:true + networkIdle:{timedOut:true,
  pendingRequests, idleForMs, ignoredTypes?} + warning`，不再让命令失败；selector/text 未满足仍报错。
- Host `formatResult`：best-effort 文案 `best-effort: still N pending (long-lived requests such as
  beacons may never reach idle)` + 回显 warning。
- 测试：controller 新增 3 项（忽略类型不阻塞 idle、networkIdle-only 超时 best-effort ok、selector 超时仍失败），
  原 networkIdle-only 超时断言随之改为 best-effort 断言；Host 新增 1 项 best-effort 文案测试。
- 文档边界（不是 bug）：`emulate reset` 后回执 colorScheme 反映的是**页面真实偏好**——reset 只清 CDP
  覆盖，Chrome 页面的 prefers-color-scheme 跟随 Chrome 主题/系统策略，可能与 OS 不一致；真实 Chrome
  里登录账号的 GitHub 用 `data-color-mode=dark` 强制配色时，CDP `colorScheme` 改不动页面，主题 QA 建议
  未登录/独立 profile/无痕。
- 待真机复验（需 reload 扩展 0.1.30）：github.com 上 `wait {networkIdle:true}` 应在 ms 内 best-effort
  返回 ok + pending + warning；普通页面仍真正等 idle。版本 0.1.30。


### 34.10 断连状态与重复建组修复（2026-11-02，0.1.30 → 0.1.31）

用户反馈：①「手动取消连接 / 关闭浏览器窗口后，chrome 桥仍显示已连接」；②「模型在已有标签组时重新调起
chrome 桥会重复建组」。以下均为真机复现（Chrome 156，真实用户 profile，`chrome.debugger` 扩展从仓库目录加载）。

**复现与根因**

1. **窗口关掉了，桥仍然“已连接”**。关闭 Chrome 的最后一个普通窗口后，Chrome 进程并不退出（后台/扩展
   常驻），扩展的 MV3 service worker 也活着：WebSocket 仍开着，应用层 ping/pong 正常，于是 Host `status`
   只看到 `extension.connectedAt` 就报“connected”。但 `chrome.windows.getAll({windowTypes:["normal"]})`
   为空、`chrome.tabs.query({})` 为空，所有标签动作都没有可操作对象；旧的 `status` 完全没有窗口维度，
   `tabs` 还会把空列表说成 "no visible tabs"，把“桥在、浏览器没窗口”误报成“正常”。
   实测：关掉最后一个窗口后，`status` 的 `connectedAt` 连续数小时不变（0.1.30 行为）。
2. **重复建组**。控制器的 `ensureAgentGroup` 缓存 `agentGroupId`；窗口关闭后该 id 失效，下一次
   `newTab/attach` 进入 fallback：**直接** `chrome.tabs.group({tabIds})` 新建组，不重新查询已有组。
   同时，Chrome 会把带标题的组在**窗口关闭时自动存为 “saved tab group”**（书签栏里的已保存标签组），
   而 `chrome.tabGroups.query` 只返回当前打开的组、扩展 API 也无法访问/重新打开 saved group。结果每经历
   一次「关窗口 → 再 newTab」就多一个同名 “DSH Agent” 组：真机在书签栏累计到 4 个 DSH Agent 组
   （1 个打开 + 3 个已保存）。旧 ACL 还只认缓存的单个 group id：窗口一关，新窗口里所有 tab 都被判
   “not in the DSH Agent group; call attach first”，即用户看到的“空白标签页也不接管”。

**0.1.31 修复**

- 扩展新增 `state` 快照命令，并在 pong 心跳里附带快照：`{normalWindows, windows[], tabs, agentGroups[],
  agentGroupId, savedGroupPossible, lastWindowCloseAt}`；窗口/标签组事件（`windows.onCreated/onRemoved`、
  `tabGroups.onCreated/onUpdated/onRemoved`）会失效缓存并主动 `{type:"state"}` 推送给 Host。
- Host `status` 合并实时快照，新增 `usableWindows`；`normalWindows===0` 时给出明确 hint（桥已连接但
  Chrome 没有窗口；`newTab` 会让 Chrome 新建窗口；旧组可能被 Chrome 存成 saved group）。`tabs` 在
  零 tab 且无窗口时返回 windowless 文案而不是 "no visible tabs"。`ws.js` 把快照存进 `status()` 与
  `chrome-bridge-state.json`，`sanitizeState` 保证坏快照不会污染输出。旧版扩展（不认 `state`）只是
  status/空 tabs 多等 1.5s 超时后回退，不影响功能。
- 组逻辑以 `tabGroups.query({})` 的**实时结果**为准：缓存 id 只作提示；`ensureAgentGroup` 每次先查
  全部候选组，优先同窗口组、其次缓存 id、最后第一个；`tabs.group` 失败时**重新查询一次再决定是否新建**
  （不再盲目新建）。同一窗口里出现多个 “DSH Agent” 组时把它们的 tab 合并进主组（`tabs.group` 会删除
  被清空的组），`attach/newTab` 回执带 `groupAction: created|reused`、`groupsMerged`。
- ACL 改为「tab 属于任意一个打开的 DSH Agent 组即可」，不再信任单一缓存 id；无打开组时 ACL 不拦
  （窗口关闭后新窗口 tab 恢复可控），并在成员判断失败时强制刷新一次组缓存。
- 窗口关闭后首次新建组时，扩展用 `windows.get(旧窗口)` 判定“组是被窗口关闭带走的”，回执附
  `savedGroupPossible:true` + warning（Chrome 把旧组存成了 saved tab group，API 无法重开/删除，
  需用户从书签栏 saved tab groups 里重开或关掉多余条目）。`status` 也会预测并持续提示该状态。
- `newTab` 在无窗口时若 `tabs.create` 抛错，回退 `chrome.windows.create` 显式开窗口，仍能完成建 tab + 建组。
- **平台边界（无法在扩展侧消除）**：Chrome 的 saved tab groups 没有扩展 API。桥不能再复用“已保存/已关闭”
  的组，只能在新建组时如实回执、并合并所有**仍打开**的同名重复组。要彻底避免历史 saved 条目，需用户在
  Chrome 书签栏手动清理（或在关窗前先把组内 tab 移出）。

**测试**

- controller 新增 8 项：第二个 tab 复用组、失效缓存重新查询并复用他组（不新建）、窗口关闭后新建组带
  saved warning、同窗口重复组合并、ACL 接受任意 DSH Agent 组、无组时 ACL 放行、state 快照（含窗口/组/
  预测 saved 状态）、窗口事件推送快照。
- ws/host 新增 20 项：pong 携带 state 落盘、主动 state 推送、坏快照 sanitize、status 有/无窗口、空 tabs
  两分支、newTab 诊断文案、纯格式化 helper。
- 全套 **111 项全绿**（基线 88）；真机复验：无窗口时 `status.usableWindows=0` + hint、`tabs` 的
  windowless 文案、`newTab` 自动开窗并回执 saved warning、扩展 reload 后仍复用同一组、组数量不增长；
  Host 半需重启 DSH 生效（安装副本已同步）。
- 版本：package.json / manifest / Hello 帧统一 **0.1.31**。

### 34.11 无窗口自愈（「No current window」）与可观测性（2026-11-03，0.1.31 → 0.1.32）

用户（另一 DSH Agent 会话）报告的 bug：Chrome 窗口被关闭/崩溃后，Chrome 进程仍在
（`chrome.exe --no-startup-window`），扩展仍连接，但 `chrome tabs` 返回空、`chrome newTab` 报
`No current window`；用 `Start-Process chrome.exe` 拉起“新窗口”后仍然失败，直到重载扩展才恢复。
以下为逐项复现与结论（Chrome 156，真机）。

**对报告里三个候选根因的修正**

1. 「缓存 windowId 失效」— **不成立**。0.1.30/0.1.31 的代码从不缓存 windowId（`tabs.create` 不传
   windowId），`windows.create` 也没有缓存路径。真正原因是 Chrome 处于“进程在、零个 normal 窗口”时
   没有 `current window`：`chrome.tabs.create({url})` 直接抛 `No current window`，和缓存的 id 无关。
2. 「只枚举 Agent 分组内标签」— **不成立**。`tabs` 一直用 `chrome.tabs.query({})` 列全部标签，分组
   只作用于动作 ACL；报告里 `tabs: 2` 也证明未分组标签能列出。空列表是因为 `tabs.query` 真的没有窗口。
3. 「SW 休眠后 windowId 状态陈旧」— **只占很小一部分**。0.1.31 起组与 ACL 都以实时查询为准；真正要
   补的是**恢复动作本身**的确定性（见下）。

**真机追加发现（两个关键点）**

- **「新窗口」陷阱**：在本机用 `Start-Process chrome.exe` 在后台 Chrome 上拉起窗口时，出现的是
  **Chrome 的 profile picker**（标题 “Google Chrome”、有焦点，但它是选择用户的窗口，不是浏览器窗口；
  本机 Chrome 设置「起動時に表示する」开着）。它不会出现在扩展的 `windows.getAll({windowTypes:["normal"]})`
  里（或没有可驱动标签），所以 `tabs` 仍空；如果顺手点进另一个 profile，桥扩展根本不在那个 profile 里，
  更会一直“空 + No current window”。这解释了报告步骤 4 的“窗口出现了但依然失败”。
- **Chrome 156 分组怪癖**：`chrome.windows.create({focused:false})` 创建出来的 normal 窗口，其标签
  在窗口被激活过一次之前无法分组：`chrome.tabs.group` 报
  `Tabs can only be moved to and from normal windows.`（即使 `windows.getAll` 报告 type=normal，
  再等多久也不恢复）。`focused:true` 创建的同款窗口一次就分组成功；对已存在的 `focused:false` 窗口
  `chrome.windows.update(id,{focused:true})` 后重试即可成功。0.1.31 的窗口恢复路径正好创建的是
  `focused:false` 窗口，于是“窗口建出来了、组却建不上”，ACL 之后又把它当组外标签。

**0.1.32 修复**

- `newTab` 不再依赖异常：每次实时解析 normal 窗口（零缓存）。0 个窗口 → `windows.create` 创建
  **focused** 窗口（即恢复窗口），否则 `tabs.create`；只有 `tabs.create` 因窗口在查询后消失而抛
  `No current window` 时才回退建窗。结果带 `createdWindow:true`，Host 文案注明
  `[created a new Chrome window because none was open]`。
- `tabs.group` 统一走 `groupTabs()`：命中 `Tabs can only be moved to and from normal windows.` 时先
  `windows.update(tab.windowId,{focused:true})`、等 150ms、**原样重试一次**；其他错误照常抛。
  合并重复组、复用组、建组三条路径都走它。
- `status` 新增 `windowState`：`disconnected` / `unknown` / `windowless` / `no-agent-group` / `ready`，
  并分别给 actionable hint（`windowless` 提示 `newTab` 会建窗；`no-agent-group` 提示 `newTab/attach`
  会建组/入组、旧组可能被 Chrome 存成 saved group）。
- `status` 新增 `lastError: {at, action, message}`（最近一次失败的工具调用，同时写入
  `chrome-bridge-state.json`）。失败文案统一做 **recovery hint 映射**：
  `No current window` → 提示 `newTab` 会自动建窗后重试；`No tab with given id/N not found` → 提示标签
  已随窗口关闭，先 `tabs/status` 再 `newTab`；`not in the DSH Agent group` → 提示 `attach`。
- `tabs` 空列表分诊：无窗口 → windowless 文案；**有窗口但列表为空** → 自动重试一次 list-tabs，仍空则
  返回「Chrome 报告 N 个窗口但扩展列不出标签，worker 可能陈旧」的诊断（并记 lastError）。
- 可观测性：扩展在 connect/disconnect、窗口数 0↔N 变化时写 `console` 日志（含时间、窗口数、组数）；
  Host `ws.js` 在 hello/disconnect/窗口数变化时各写一行 `[chrome-bridge]` 日志。
- 版本 0.1.32（package.json / manifest / Hello 帧）；Host 半需重启 DSH 生效。

**测试与真机验证**

- controller 新增：零窗口 newTab 建窗+分组（断言 `focused:true`）、tabs.create 失去窗口时回退、
  非 `No current window` 错误不被吞、`Tabs can only be moved...` 分组怪癖的 focus+retry；
  host 新增：`windowState` 四态、`lastError` 记录/输出、失败文案 hint 映射、空 tabs 两分支与重试成功、
  `[created a new Chrome window...]` 文案。全套 **119 项全绿**（基线 111）。
- 真机（0.1.32 扩展 + 0.1.31 Host）：保留 DevTools 窗口、关掉所有 normal 窗口 → `status` 报
  `normalWindows:0/usableWindows:0` + hint；`newTab` 成功创建 focused 窗口并把标签放进新的
  “DSH Agent” 组（0.1.32 前同场景分组失败，`attach` 回执 `grouping failed: Tabs can only be moved...`）；
  `snapshot` 在该恢复窗口的标签上正常。
- Host 0.1.32 的 status/lastError/hint 由单测覆盖（真机 Host 需重启 DSH 后生效）。

### 34.12 会话收尾自动 detach 调试会话（2026-11-03，0.1.32 → 0.1.33）

需求（用户）：桥的 WebSocket 跨会话常连是预期，但 Chrome 的「DSH Chrome Bridge 正在调试此浏览器」提示条
不应在会话收尾后继续挂着。0.1.33 增加「最后一个运行中的 turn 结束时自动 detach 全部标签」，
并新增 `chrome detachAll` 手动动作；扩展在 Host 连接断开时也会自行 detach（防 DSH 退出后提示条残留）。

**实现**

- 扩展 `controller.js`：新增 `detachAll()`（逐个 `applyEmulationReset` → 清 per-tab 记录 →
  `chrome.debugger.detach`，幂等；返回 `{ok, detached, tabIds}`）；`state` 快照新增 `attachedTabs`
  （当前仍持有 debugger 会话的标签，供诊断/测试）；`execute` 增加 `detach-all` 命令。
- 扩展 `background.js`：WebSocket `close` 时 best-effort `detachAll()`（Host 重启/退出/崩溃后不再残留
  调试提示条；下一轮需要 CDP 的动作会自动重新 attach）。
- Host `auto-detach.js`（新文件）：纯逻辑协调器。监听 DSH 的 `session/event`（`turn/start`/`turn/end`，
  durable 事件，含取消原因；`{global:true}` 从根插件上下文订阅 scoped 事件）与 `session/disposed`；
  维护 per-session active turn，**只有当最后一个活跃 turn 结束时**才发送 `detach-all`（父子 subagent
  并发时不会打断别人）；200ms 内多次收尾合并为一次；`DSH_CHROME_BRIDGE_AUTO_DETACH=0` 可关闭。
- Host `index.js`：新增工具动作 `detachAll`（→ `{type:"detach-all"}`）；`status` 增加
  `lastAutoDetach: {at, reason, detached}`；自动 detach 失败只记日志/状态，绝不影响 turn 收尾；
  `auto-detach.js` 已加入 npm `files`。
- 版本 0.1.33（package.json / manifest / Hello 帧）；Host 半需重启 DSH 生效。

**验证与边界**

- 单测：`tests/auto-detach.test.mjs`（6 项：最后 turn 才 detach、跨会话 turn 跟踪、session disposed
  冲刷、disabled、快速收尾合并、失败不抛）；controller 新增 detachAll 幂等/attachedTabs 断言；host
  集成测试（fake ctx 注入 `session/event` → 验证 `detach-all` 发到扩展、双会话时不提前 detach、
  `status.lastAutoDetach`、`detachAll` 工具文案）。全套 **128 项全绿**（基线 119）。
- 真机验证（需 DSH 重启到 0.1.33 后）：turn 结束应看到 Chrome 调试提示条消失；`chrome detachAll`
  可立即清理；扩展/Chrome 退出导致的断连由扩展侧自行 detach 兜底。
- 已知边界：多会话**同时**运行时，detach 针对的是全部调试会话（桥不按会话区分 attach 归属）；
  如果另一会话正在用 CDP，它会在下一个动作时自动重新 attach，只会有提示条短暂闪烁，不影响命令。

**0.1.34（同日补丁）**：`ws.js` 的 `sanitizeState` 之前会丢弃扩展新增的 `attachedTabs` 字段，导致 `status.state.attachedTabs`
实际不可见；0.1.34 把它加入白名单（仅保留 >0 的数字 tabId），并有单测覆盖。Host 半需下次重启 DSH 生效；
不影响 0.1.33 的自动 detach 行为。

### 34.13 closed shadow DOM 可定位：`find` 结构检索 + snapshot 影子树救援（2026-11-04，0.1.35 → 0.1.36）

需求（用户）：小红书发布按钮 `<xhs-publish-btn>` 内部是 **closed shadow root**。`snapshot` 的 a11y 树/DOM 元素表
里完全没有它 → click by ref 无从谈起，模型误判「按钮不存在」；而按钮其实存在于页面结构中（只是页面 JS
无法访问 closed shadow）。用户希望：给出文字/标签，能返回 rect + 是否在影子树里。

**复现（真机 Chrome 156 + 本地 closed-shadow 测试页）**

- 根因：Chrome 的 AX 树**能**看到 closed shadow 内容，但可点击的 `<div>` 在 AX 里是 `ignored:true` 或
  role 不在交互/信息白名单里，被 snapshot 过滤；页面 JS `host.shadowRoot === null`，`querySelectorAll` 也
  看不到。`DOM.resolveNode` 对 closed shadow 节点通常失败，但 **`DOM.getBoxModel` / `scrollIntoViewIfNeeded`
  / `setFileInputFiles` 都接受 `backendNodeId`**，配合 CDP 点击坐标可用 → 定位与点击完全可以做到。
- 另发现 Chrome 156 后台标签的 `Page.captureScreenshot` 偶发**永不返回**（首个截图调用等不到帧），
  以及个别 CDP 调用可能挂起不 settle；这些会卡死扩展的命令队列，必须加超时/重试。

**实现**

- 新增工具动作 `find {tabId, text?, tag?, selector?, limit?}`（`{type:"find"}`）：`DOM.getDocument{depth:-1,pierce:true}`
  遍历（含 author shadow root，区分 open/closed），支持 text（ownText/aria-label/title/placeholder/AX name，
  找不到时回退聚合文本）、tag（含自定义元素名）、selector（light DOM，`DOM.querySelectorAll`）；每个命中返回
  `ref`（`n<backendNodeId>`，已注册到 refs，可直接 click）、tag/role/name、`rect`+`center`、
  `shadow: closed|open|none`、match 原因；上限 50。`scanned`/`shadowRoots` 给出扫描规模。
- snapshot 影子树救援：每次 snapshot 额外做一次 `DOM.getDocument{depth:-1,pierce:true}`（20k 节点上限），
  把 closed shadow 里带文本/aria-label/title/placeholder 的元素作为 `role: "generic"` 加入快照并标
  `[shadow: closed]`（最多 20 个）；AX 已收录的 shadow 元素也会打上同样标记；`shadowElements` 计数。
  这直接解决「snapshot 完全看不到、模型误判不存在」。
- 动作兜底：`screenshot {ref}` 对 closed-shadow ref 直接走 `DOM.getBoxModel(backendNodeId)`（不再
  resolveNode）；`upload` 命中 push 失败时用 `setFileInputFiles {backendNodeId}`；`type {ref}` 对
  closed-shadow 输入用坐标点击聚焦 + `Input.insertText`，页面读不到内部值就返回 `ok:true, verified:false`
  + note（instead of 报「not editable」）。
- 稳定性：新增 `sendBounded`（CDP 调用 1.5–3s 上限）包住 boxModel/resolveNode/scrollIntoView/callFunctionOn/
  pushNodes/setFileInputFiles 等易挂调用；`Page.captureScreenshot` 改为「第一次 4s 上限，超时重试一次 12s」
  （Chrome 156 后台标签首帧截图的已知挂起，第二次通常立即成功）。任何 CDP 挂起不再无限阻塞命令队列。
- 版本 0.1.36（package/manifest/Hello）；Host 半需重启 DSH 生效（新 tool action `find`），扩展 reload 即生效。

**真机验证（0.1.36 扩展 + 本地 closed-shadow 页面）**

- 测试页含：closed shadow 内 button（有 aria-label）、icon-only button、可点击 div（无 aria）、另一个
  bare div、closed shadow input。`snapshot` 输出 5 个 `[shadow: closed]` 元素（button 发布/✏️、textbox
  输入内容、generic 提交/立即发布）——之前一个都看不到。
- `find {text:"立即发布"}` → `n38 <div> generic rect=50,443 56x22 [shadow: closed]`；`click n38` 触发页面
  事件（`document.title = "CLICKED:btn-4"` 验证）；`find {tag:"xhs-publish-btn"}` 命中自定义元素宿主；
  `find {text:"输入内容"}` 命中 shadow input；`type` 成功写入（页面 `#typed` 收到 `TYPED:hello`，
  verified:false 符合 closed shadow 语义）。
- `screenshot {ref}`（closed shadow）首次 4s 超时自动重试后成功（~4.2s），viewport 截图同样重试成功；
  期间无命令队列卡死。
- 单测 136 项全绿（新增：snapshot 影子救援、find（text/tag/selector/缺失 hint/click 复用 ref）、
  screenshot box-model fallback、type closed-shadow 未验证成功、capture 重试）。真机浏览器测试通过
  临时 harness 端口（扩展 options 改 47899 → `createExtensionBridge` 直连）验证，完成后已恢复 47835。

**边界**

- closed shadow 内容无法用页面 JS 访问，所以 `evaluate`/`wait {selector|text}` 仍看不到它；定位请走
  `find`/snapshot 的 ref。`find`/snapshot 的影子树标记依赖 `DOM.getDocument{pierce:true}`，对超大页面
  有扫描成本（snapshot 每次一次、find 每次一次；均有节点上限）。
- 后台标签首帧截图仍可能有 4s 重试延迟（Chrome 156 行为），不是插件逻辑错误。
