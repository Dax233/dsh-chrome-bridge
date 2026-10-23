# dsh-chrome-bridge

控制用户真实 Chrome 的 DSH 插件：Host 侧 `chrome` 工具 + MV3 扩展（`chrome.debugger`），支持后台标签、DSH Agent 标签组、UIA refs、动作回执、console/network 日志、iframe 观测与 frame 内点击。

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

`chrome(action)`：`status`、`tabs`、`newTab`、`closeTab`、`attach`、`detach`、`navigate`、`snapshot`、`click`、`type`、`key`、`scroll`、`screenshot`、`logs`、`upload`、`evaluate`、`wait`。

安全/行为要点：

- 只有 **DSH Agent 标签组** 内的 tab 可被驱动；`newTab` 自动入组，`attach` 是显式 opt-in（用户把 tab 拖出组即撤销）。
- 快照使用 Host 侧 `n<backendNodeId>` refs；动作带 settle/回执。
- `logs` 支持 `filter`/`clear`；`wait` 支持 selector/text/ms；`upload` 用 `DOM.setFileInputFiles`。
- iframe：内容带 `(iframe)` 标记；点击在 frame 隔离世界中按可访问名执行 `.click()`。
- 本机桥只监听 127.0.0.1，hello 帧 token 鉴权、Host/Origin 校验；默认 token 只用于本机配对，可在扩展选项/环境变量中覆盖。

## 开发

```sh
npm test
```

测试覆盖 WebSocket 握手/安全、Host 工具往返、扩展 controller、manifest 与 CRX 打包。

## License

AGPL-3.0-or-later

详细设计（安全、快照、settle、iframe、ACL 等）：见 [docs/browser-control.md](docs/browser-control.md)。
