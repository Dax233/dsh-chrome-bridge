const DEFAULT_PORT = 47835;
const DEFAULT_TOKEN = "dsh-chrome-bridge-local";

const portInput = document.getElementById("port");
const tokenInput = document.getElementById("token");
const statusBox = document.getElementById("status");

function show(text) {
  statusBox.textContent = text;
}

async function load() {
  const stored = await chrome.storage.local.get({ port: DEFAULT_PORT, token: DEFAULT_TOKEN });
  portInput.value = String(stored.port);
  tokenInput.value = String(stored.token);
}

document.getElementById("save").addEventListener("click", async () => {
  const port = Number(portInput.value) || DEFAULT_PORT;
  const token = tokenInput.value.trim() || DEFAULT_TOKEN;
  await chrome.storage.local.set({ port, token });
  show(`已保存：ws://127.0.0.1:${port}/ext（service worker 会立即重连）`);
});

document.getElementById("test").addEventListener("click", async () => {
  const port = Number(portInput.value) || DEFAULT_PORT;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/hello`, { cache: "no-store" });
    const body = await response.text();
    show(`DSH chrome-bridge 可达：HTTP ${response.status}\n${body}`);
  } catch (error) {
    show(`无法连接 127.0.0.1:${port}：${String(error)}\n请确认 DSH 桌面版正在运行且 chrome-bridge 插件已启用。`);
  }
});

void load();
