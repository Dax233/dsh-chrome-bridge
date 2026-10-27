import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "extensions", "chrome-extension");
const manifest = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8"));

test("manifest is MV3 and references files that exist", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(typeof manifest.name, "string");
  assert.ok(manifest.version.length > 0);
  assert.equal(manifest.background?.type, "module");
  for (const relative of [manifest.background.service_worker, manifest.options_page, "controller.js", "options.js"]) {
    assert.ok(existsSync(join(extensionDir, relative)), `missing extension file: ${relative}`);
  }
});

test("manifest requests the debugger and tab permissions the bridge needs", () => {
  for (const permission of ["debugger", "tabs", "tabGroups", "storage", "alarms"]) {
    assert.ok(manifest.permissions.includes(permission), `missing permission: ${permission}`);
  }
  assert.ok(
    manifest.host_permissions.some((pattern) => pattern.startsWith("http://127.0.0.1/")),
    "the extension must be able to reach the loopback bridge",
  );
  assert.ok(Number(manifest.minimum_chrome_version) >= 116, "WebSocket keepalive needs Chrome 116+");
});

test("service worker imports the controller and keeps a WebSocket connection", () => {
  const background = readFileSync(join(extensionDir, "background.js"), "utf8");
  assert.match(background, /from "\.\/controller\.js"/);
  assert.match(background, /new WebSocket\(/);
  assert.match(background, /type: "hello"/);
  assert.match(background, /type: "result"/);
  assert.match(background, /type: "pong"/, "the service worker must answer the keepalive heartbeat");
  assert.match(background, /commandQueue = commandQueue/, "commands must be serialized (concurrent CDP calls can hang)");
});

test("extension ships no remote code or content scripts", () => {
  assert.equal(manifest.content_scripts, undefined);
  const controllers = readFileSync(join(extensionDir, "controller.js"), "utf8");
  assert.doesNotMatch(controllers, /eval\(|new Function\(/);
  for (const file of ["background.js", "controller.js", "options.js"]) {
    const source = readFileSync(join(extensionDir, file), "utf8");
    assert.doesNotMatch(source, /https?:\/\/(?!127\.0\.0\.1|www\.w3\.org|example\.com|en\.wikipedia\.org)[a-z0-9.-]+/i, `${file} must not fetch remote code`);
  }
});
