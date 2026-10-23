# DSH Chrome Bridge 扩展（MV3）

配合 `chrome-bridge/` Host 插件，让 Agent 通过 `chrome.debugger` 控制你真实 Chrome 的标签页。

## 安装（开发者模式）

1. Chrome 打开 `chrome://extensions`，打开右上角 **开发者模式**。
2. **加载已解压的扩展程序** → 选择本目录（`<repo>\extensions\chrome-extension`）。
3. 点扩展的「详情」→「扩展程序选项」（或地址栏打开 Options），确认端口/token
   与 DSH 插件默认值一致（`47835` / `dsh-chrome-bridge-local`），点「保存并重连」。
4. 在 DSH 会话里调用 `chrome` 工具 `action=status`，应看到 extension 已连接。

## 行为与限制

- 使用 `chrome.debugger`（Chrome 会显示“正在调试此浏览器”的提示条，属正常，可随时关闭）。
- 按标签页 attach；**后台标签页也能操作**（不要求前台）。
- 只允许 http(s) 导航；refs 只对最近一次 snapshot 有效。
- 刷新/重载扩展或改端口后，service worker 会按 1 分钟 alarm 自动重连。
- 不注入远程代码、不使用 content_scripts；页面脚本只在动作执行时通过 `Runtime.evaluate` 求值。

## 开发与测试

控制器逻辑在 `controller.js`（Node 下用 mock `chrome` 测试：`tests/chrome-extension-controller.test.mjs`），
manifest 结构由 `tests/chrome-extension-manifest.test.mjs` 守护。改动后重新加载扩展即可（无需重启 Chrome）。
