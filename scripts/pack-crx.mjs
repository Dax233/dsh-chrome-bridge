#!/usr/bin/env node
/**
 * Package the DSH Chrome extension as a self-signed CRX3 (+ zip).
 *
 *   node scripts/pack-crx.mjs [--dir extensions/chrome-extension]
 *                             [--out dist/dsh-chrome-bridge.crx]
 *                             [--key dist/dsh-chrome-bridge.pem]
 *
 * The private key is generated on first run and must be kept (a changed key
 * changes the extension id). Never commit the .pem; dist/*.pem is gitignored.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { buildCrx, buildZip, generateSigningKey, parseCrx, publicKeyDerFromPem } from "./crx.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    args[name] = value;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const extensionDir = resolve(args.dir ?? "extensions/chrome-extension");
const outFile = resolve(args.out ?? "dist/dsh-chrome-bridge.crx");
const keyFile = resolve(args.key ?? "dist/dsh-chrome-bridge.pem");

if (!existsSync(join(extensionDir, "manifest.json"))) {
  console.error(`not an extension directory (manifest.json missing): ${extensionDir}`);
  process.exit(1);
}
mkdirSync(dirname(outFile), { recursive: true });

let privateKeyPem;
let publicKeyDer;
if (existsSync(keyFile)) {
  privateKeyPem = readFileSync(keyFile, "utf8");
  publicKeyDer = publicKeyDerFromPem(privateKeyPem);
  console.log(`using existing signing key: ${keyFile}`);
} else {
  const generated = generateSigningKey();
  privateKeyPem = generated.privateKeyPem;
  publicKeyDer = generated.publicKeyDer;
  writeFileSync(keyFile, privateKeyPem, { mode: 0o600 });
  console.log(`generated signing key: ${keyFile} (keep it; the extension id depends on it)`);
}

const zip = buildZip(extensionDir);
const crx = buildCrx({ zip, privateKeyPem, publicKeyDer });
writeFileSync(outFile, crx);

const zipFile = outFile.replace(/\.crx$/i, "") + ".zip";
writeFileSync(zipFile, zip);

const parsed = parseCrx(crx);
const crxId = parsed.crxId.toString("hex");
if (!parsed.verifySignature()) {
  console.error("signature self-check failed");
  process.exit(1);
}

console.log(`extension dir : ${extensionDir}`);
console.log(`zip           : ${zipFile} (${zip.length} bytes)`);
console.log(`crx           : ${outFile} (${crx.length} bytes)`);
console.log(`crx_id        : ${crxId} (stable while the key is stable)`);
console.log(`manifest      : ${basename(join(extensionDir, "manifest.json"))} v${JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8")).version}`);
console.log("install       : chrome://extensions → developer mode → drag the .crx in (this Chrome may refuse"); 
console.log('                non-store CRX; "Load unpacked" on the directory works identically)');
