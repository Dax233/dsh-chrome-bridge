# dsh-chrome-bridge

控制用户真实 Chrome 的 DSH 插件：Host 侧 `chrome` 工具 + MV3 扩展（`chrome.debugger`），支持后台标签、DSH Agent 标签组、UIA refs、动作回执、console/network 日志、iframe 观测与 frame 内点击，以及参数化截图（fullPage/clip/元素/格式）、CDP 设备视口与配色仿真、networkIdle 等待；`status` 能看到扩展侧的**窗口/标签组真实状态**（连上没有窗口时不再误报“可用”），标签组会复用/合并而不是重复新建。

## 组成

- `index.js`：注册 `chrome` 工具，启动 loopback WebSocket 服务（默认 `127.0.0.1:47835`）。
- `ws.js`：无依赖的 RFC 6455 服务端；hello 帧鉴权，Host/Origin 校验。
- `extensions/chrome-extension/`：MV3 扩展。
- `scripts/`：CRX 打包工具（`node scripts/pack-crx.mjs`）。

## 安装

```sh
dsh plugin --profile desktop add github:Dax233/dsh-chrome-bridge
```

然后在 Chrome 打开 `chrome://extensions` → 开发者模式 → **加载已解压的扩展程序**，选择本仓库的 `extensions/chrome-extension` 目录；打开扩展选项页确认端口/token（默认端口 `47835`，默认 token `dsh-chrome-bridge-local`）。

## Release / 下载安装

GitHub Releases（由 `.github/workflows/release.yml` 在推送 `v*` tag 或手动 dispatch 时生成）：

- `dsh-chrome-bridge-v<version>.zip`（推荐）：解压后在 `chrome://extensions` 开开发者模式 → **加载已解压的扩展程序**。
- `dsh-chrome-bridge-v<version>.crx`：自签名包，仅适用于企业策略/Chromium 开发版；Chrome 稳定版会拒绝拖入安装。

扩展 ID 默认随构建签名 key 变化。若需要稳定 ID（例如企业策略分发），在仓库 Secrets 中设置 `CRX_PRIVATE_KEY` 为签名私钥 PEM：workflow 会优先使用它。**私钥不要提交到仓库。**

手动触发：Actions → release → Run workflow；或 `git push origin v<version>`。

## 工具面

`chrome(action)`：`status`、`tabs`、`newTab`、`closeTab`、`attach`、`detach`、`navigate`、`snapshot`、`click`、`type`、`key`、`scroll`、`screenshot`、`emulate`、`logs`、`upload`、`evaluate`、`wait`。

安全/行为要点：

- 只有 **DSH Agent 标签组** 内的 tab 可被驱动；`newTab` 自动入组，`attach` 是显式 opt-in（用户把 tab 拖出组即撤销）。
- **连接 ≠ 可用**：Chrome 关掉最后一个窗口后台进程仍在时，WebSocket/心跳还活着。`status` 的 `usableWindows`、`windowState`（`disconnected`/`unknown`/`windowless`/`no-agent-group`/`ready`）、`lastError` 与扩展 state（`normalWindows/windows/tabs/agentGroups/savedGroupPossible`）会指出“已连接但没有窗口/没有 Agent 组”，`tabs` 也会返回 windowless 文案并在“有窗口但列不出标签”时自动重试+诊断。
- **无窗口自愈**：`newTab` 不再依赖 `current window`——每次实时解析 normal 窗口，零窗口时直接 `windows.create` 一个**聚焦**窗口（Chrome 156 对 `focused:false` 窗口的标签会拒绝分组），再建标签入组；`tabs.group` 命中 `Tabs can only be moved to and from normal windows.` 时先聚焦该窗口再重试一次。回执会注明 `[created a new Chrome window because none was open]`。
- **组只复用、不盲目新建**：每次 `newTab/attach` 先实时查询所有打开的 “DSH Agent” 组（优先同窗口），失败时重查一次再决定是否建组；同一窗口的重复组会自动合并，回执带 `groupAction: created|reused` 与 `groupsMerged`。
- 快照使用 Host 侧 `n<backendNodeId>` refs；动作带 settle/回执。
- `logs` 支持 `filter`/`clear`；`wait` 支持 selector/text/networkIdle/idleMs/ms（多条件 AND）；`upload` 用 `DOM.setFileInputFiles`。
- `screenshot {format?, quality?, fullPage?, clip?, ref?, selector?}`：`fullPage`/`clip`/`ref`/`selector` 只能选一种；`clip` 是**视口（CSS px）坐标**，`ref`/`selector` 会先滚动到目标再按视口坐标截取；`fullPage` 临时把仿真视口拉高到内容高度再截、随后恢复。Host 按格式落盘并回填真实像素尺寸。
- `emulate {width?, height?, deviceScaleFactor?, mobile?, colorScheme?, reset?}`：CDP device metrics + `prefers-color-scheme` 仿真，按 tab 记录，detach/关闭/reset 自动复位。
- iframe：内容带 `(iframe)` 标记；点击在 frame 隔离世界中按可访问名执行 `.click()`。
- 命令在扩展服务端**串行执行**（`background.js` 维护一条 promise 队列）：agent 并发发起多个工具调用时，同一个 tab 上的 CDP 命令不会互相踩踏（真机上并发 selector/clip 截图曾让其中一个永久挂住）。
- 本机桥只监听 127.0.0.1，hello 帧 token 鉴权、Host/Origin 校验；默认 token 只用于本机配对，可在扩展选项/环境变量中覆盖。

## QA 仿真与定位边界

`screenshot` / `emulate` / `wait {networkIdle}` 是「改页面 → 多组验收」用的 QA 参数，但它们作用在**用户真实 Chrome 的可见标签页**上：

- `emulate` 调 `Emulation.setDeviceMetricsOverride` + `Emulation.setEmulatedMedia`：该标签页会真的按模拟视口/配色重排。覆盖状态按 tab 记录，`detach`、`closeTab`、`emulate {reset:true}` 会立即复位；Chrome 自己结束调试会话（用户点掉「正在调试此浏览器」提示条）时 CDP 覆盖随会话消失，插件同时清理记录，不会永久留在用户页面上。
- 只做 device metrics 与 prefers-color-scheme，不启用触摸仿真；`deviceScaleFactor` 是 CDP 视口仿真，不等于真机 DPR。
- `screenshot`：`fullPage` 取 `Page.getLayoutMetrics` 的 `cssContentSize`/`contentSize` 较大者作为目标高度（上限 12000 CSS px），**临时把当前仿真视口的高度改成该高度、截图后恢复**——不用 `captureBeyondViewport`：真机 Chrome 156 在后台 tab 上对它（带不带 clip 都一样）会永不返回、还会把 tab 留在截图尺寸。`clip`/`ref`/`selector` 都是**视口坐标**并只截可见表面（ref/selector 先 `scrollIntoView`）；`clip.scale` 当前 CDP 必填，控制器统一补默认 1（用户传的 scale 保留）。base64 超过桥 7MB 帧预算会直接报错（提示降 deviceScaleFactor / 改 clip）。Host 按 format 生成 `.png/.jpg/.webp` 并解析图片头回填真实像素尺寸。
- `wait {networkIdle:true, idleMs}` 从 attach 之后开始统计 `Network.requestWillBeSent` / `loadingFinished|loadingFailed` 的 in-flight；attach 之前已开始的请求不进入计数，`ms` 仍是总超时。超过 120s 仍未 finish 的请求视为被放弃（真机上页面 `fetch()` 不消费 body 时 Chromium 可能永远不发 `loadingFinished`），会被清出计数，避免 networkIdle 永久挂住。
- `wait {networkIdle}` 从 0.1.30 起忽略 **WebSocket / EventSource / Ping / CSPViolationReport / Prefetch** 类型的请求（GitHub 的 beacon/长连接永不 `loadingFinished`，会把 pending 永久卡在非零）；总超时到达时若只有 networkIdle 未满足，返回**best-effort 成功**：`ok:true + networkIdle:{timedOut:true, pendingRequests, ignoredTypes?} + warning`（Host 文案标注 "best-effort: still N pending (long-lived requests such as beacons may never reach idle)"），不再让命令失败。selector/text 未找到的超时仍照常报错。
- `emulate {reset:true}` 的回执 colorScheme 反映的是**页面真实偏好**：reset 只清 CDP 覆盖，Chrome 页面的 prefers-color-scheme 跟随 Chrome 主题/系统策略，可能与你预期的 OS/系统配色不一致（如系统 dark 但 Chrome 主题 light 页面报 light）。这是 Chrome 行为，不是 bug。
- 登录账号的 GitHub 用页面级 `data-color-mode` 强制裁剪：真实 Chrome 里 CDP `colorScheme` 可能改不动它的配色。主题相关的 QA 建议在**未登录 / 独立 profile / 无痕**窗口里做。
- **不是 CI/离屏浏览器**：需要真实 Chrome 在运行、扩展已连接。无头/批量验收请用 sidebar 侧栏插件的 `qa` 或外部 CDP/Playwright，本插件不承诺离屏能力。

## 已知边界：Chrome 的 saved tab groups

Chrome 会在**窗口关闭时把带标题的标签组存为 saved tab group**（书签栏里的「已保存的标签组」）。扩展 API
`chrome.tabGroups.query` 只返回当前打开的组，也没有任何 API 能读取/重新打开/删除 saved group。因此：

- 关窗后第一次 `newTab` 必然要新建一个 “DSH Agent” 组；旧组由 Chrome 保留成 saved 条目，桥无法复用。
  此时 `newTab/attach` 回执会带 `savedGroupPossible:true` 的 warning，`status.note` 也会提示去书签栏处理。
- 用户从书签栏重新打开旧 saved 组、与新建组同时存在时，桥会把**同一窗口**内的重复组自动合并（回执
  `groupsMerged>0`）；不同窗口的同名组会保留，但 ACL 接受任意一个打开的 “DSH Agent” 组。
- **不要用 `Start-Process chrome.exe` 当“开窗恢复”**：本机 Chrome 开着「起動時に表示する」时它只会弹
  profile picker（标题也叫 “Google Chrome”，但不是可驱动的浏览器窗口；选错 profile 时桥扩展甚至不在
  那个 profile 里）。恢复请直接用 `chrome newTab`，桥会自己创建 focused 窗口。
- 想彻底避免历史 saved 条目，只能在 Chrome 里手动关闭/删除（或在关窗前把 agent tab 移出组）。

## 开发

```sh
npm test
```

测试覆盖 WebSocket 握手/安全与状态快照、Host 工具往返与 status/窗口诊断（windowState/lastError/失败 hint/空 tabs 重试）、扩展 controller（含无窗口自愈、组复用/合并/ACL、Chrome 156 分组怪癖重试、截图参数 / CDP 仿真 / networkIdle / 自动复位）、manifest 与 CRX 打包。

## License

MIT

详细设计（安全、快照、settle、iframe、ACL 等）：见 [docs/browser-control.md](docs/browser-control.md)。
