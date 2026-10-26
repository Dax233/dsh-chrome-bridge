# dsh-chrome-bridge

控制用户真实 Chrome 的 DSH 插件：Host 侧 `chrome` 工具 + MV3 扩展（`chrome.debugger`），支持后台标签、DSH Agent 标签组、UIA refs、动作回执、console/network 日志、iframe 观测与 frame 内点击，以及参数化截图（fullPage/clip/元素/格式）、CDP 设备视口与配色仿真、networkIdle 等待。

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
- 快照使用 Host 侧 `n<backendNodeId>` refs；动作带 settle/回执。
- `logs` 支持 `filter`/`clear`；`wait` 支持 selector/text/networkIdle/idleMs/ms（多条件 AND）；`upload` 用 `DOM.setFileInputFiles`。
- `screenshot {format?, quality?, fullPage?, clip?, ref?, selector?}`：`fullPage`/`clip`/`ref`/`selector` 只能选一种；`clip` 是**视口（CSS px）坐标**，`ref`/`selector` 会先滚动到目标再按视口坐标截取；`fullPage` 临时把仿真视口拉高到内容高度再截、随后恢复。Host 按格式落盘并回填真实像素尺寸。
- `emulate {width?, height?, deviceScaleFactor?, mobile?, colorScheme?, reset?}`：CDP device metrics + `prefers-color-scheme` 仿真，按 tab 记录，detach/关闭/reset 自动复位。
- iframe：内容带 `(iframe)` 标记；点击在 frame 隔离世界中按可访问名执行 `.click()`。
- 本机桥只监听 127.0.0.1，hello 帧 token 鉴权、Host/Origin 校验；默认 token 只用于本机配对，可在扩展选项/环境变量中覆盖。

## QA 仿真与定位边界

`screenshot` / `emulate` / `wait {networkIdle}` 是「改页面 → 多组验收」用的 QA 参数，但它们作用在**用户真实 Chrome 的可见标签页**上：

- `emulate` 调 `Emulation.setDeviceMetricsOverride` + `Emulation.setEmulatedMedia`：该标签页会真的按模拟视口/配色重排。覆盖状态按 tab 记录，`detach`、`closeTab`、`emulate {reset:true}` 会立即复位；Chrome 自己结束调试会话（用户点掉「正在调试此浏览器」提示条）时 CDP 覆盖随会话消失，插件同时清理记录，不会永久留在用户页面上。
- 只做 device metrics 与 prefers-color-scheme，不启用触摸仿真；`deviceScaleFactor` 是 CDP 视口仿真，不等于真机 DPR。
- `screenshot`：`fullPage` 取 `Page.getLayoutMetrics` 的 `cssContentSize`/`contentSize` 较大者作为目标高度（上限 12000 CSS px），**临时把当前仿真视口的高度改成该高度、截图后恢复**——不用 `captureBeyondViewport`：真机 Chrome 156 在后台 tab 上对它（带不带 clip 都一样）会永不返回、还会把 tab 留在截图尺寸。`clip`/`ref`/`selector` 都是**视口坐标**并只截可见表面（ref/selector 先 `scrollIntoView`）；`clip.scale` 当前 CDP 必填，控制器统一补默认 1（用户传的 scale 保留）。base64 超过桥 7MB 帧预算会直接报错（提示降 deviceScaleFactor / 改 clip）。Host 按 format 生成 `.png/.jpg/.webp` 并解析图片头回填真实像素尺寸。
- `wait {networkIdle:true, idleMs}` 从 attach 之后开始统计 `Network.requestWillBeSent` / `loadingFinished|loadingFailed` 的 in-flight；attach 之前已开始的请求不进入计数，`ms` 仍是总超时。超过 120s 仍未 finish 的请求视为被放弃（真机上页面 `fetch()` 不消费 body 时 Chromium 可能永远不发 `loadingFinished`），会被清出计数，避免 networkIdle 永久挂住。
- **不是 CI/离屏浏览器**：需要真实 Chrome 在运行、扩展已连接。无头/批量验收请用 sidebar 侧栏插件的 `qa` 或外部 CDP/Playwright，本插件不承诺离屏能力。

## 开发

```sh
npm test
```

测试覆盖 WebSocket 握手/安全、Host 工具往返、扩展 controller（含截图参数 / CDP 仿真 / networkIdle / 自动复位）、manifest 与 CRX 打包。

## License

MIT

详细设计（安全、快照、settle、iframe、ACL 等）：见 [docs/browser-control.md](docs/browser-control.md)。
