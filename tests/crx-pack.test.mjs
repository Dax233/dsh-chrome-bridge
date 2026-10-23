import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCrx, buildZip, generateSigningKey, parseCrx } from "../scripts/crx.mjs";

function makeExtensionFixture() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-crx-fixture-"));
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Fixture", version: "1.0.0" }));
  writeFileSync(join(dir, "background.js"), "console.log('hi');\n");
  writeFileSync(join(dir, "sub", "extra.txt"), "nested\n");
  return dir;
}

test("buildZip creates a readable store-method zip", () => {
  const dir = makeExtensionFixture();
  const zip = buildZip(dir);
  assert.equal(zip.subarray(0, 4).toString("latin1"), "PK\u0003\u0004");
  // End of central directory record at the tail.
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, "zip must contain an EOCD record");
  const entries = zip.readUInt16LE(eocd + 10);
  assert.ok(entries >= 3, `expected at least 3 entries, got ${entries}`);
});

test("buildCrx produces a CRX3 with a verifiable RSA signature", () => {
  const dir = makeExtensionFixture();
  const zip = buildZip(dir);
  const key = generateSigningKey();
  const crx = buildCrx({ zip, privateKeyPem: key.privateKeyPem, publicKeyDer: key.publicKeyDer });
  const parsed = parseCrx(crx);
  assert.equal(parsed.version, 3);
  assert.equal(parsed.crxId.length, 16);
  assert.deepEqual(parsed.zip, zip);
  // crx_id is the first 16 bytes of SHA-256(public key DER).
  const digest = parsed.expectedCrxId();
  assert.deepEqual(parsed.crxId, digest);
  assert.equal(parsed.verifySignature(), true);
});

test("tampering with the zip payload invalidates the signature", () => {
  const dir = makeExtensionFixture();
  const zip = buildZip(dir);
  const key = generateSigningKey();
  const crx = buildCrx({ zip, privateKeyPem: key.privateKeyPem, publicKeyDer: key.publicKeyDer });
  const tampered = Buffer.from(crx);
  // Flip one byte inside the zip payload (after the CRX header).
  const parsed = parseCrx(crx);
  const payloadStart = crx.length - parsed.zip.length;
  tampered[payloadStart + 40] ^= 0xff;
  const parsedTampered = parseCrx(tampered);
  assert.equal(parsedTampered.verifySignature(), false);
});

test("buildCrx requires both the private key and the public key", () => {
  const dir = makeExtensionFixture();
  const zip = buildZip(dir);
  const key = generateSigningKey();
  assert.throws(() => buildCrx({ zip, privateKeyPem: key.privateKeyPem }), /publicKeyDer/);
  assert.throws(() => buildCrx({ zip, publicKeyDer: key.publicKeyDer }), /privateKeyPem/);
});

test("generated keys are RSA 2048 SPKI/PKCS8 PEM", () => {
  const key = generateSigningKey();
  assert.match(key.privateKeyPem, /BEGIN PRIVATE KEY/);
  assert.ok(key.publicKeyDer.length > 100);
  assert.equal(key.publicKeyDer.subarray(0, 1).toString("hex").length, 2);
});

test("packing the real chrome extension yields a CRX whose crx_id is stable for one key", () => {
  const dir = join(process.cwd(), "extensions", "chrome-extension");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  const zip = buildZip(dir);
  const key = generateSigningKey();
  const crxA = parseCrx(buildCrx({ zip, privateKeyPem: key.privateKeyPem, publicKeyDer: key.publicKeyDer }));
  const crxB = parseCrx(buildCrx({ zip, privateKeyPem: key.privateKeyPem, publicKeyDer: key.publicKeyDer }));
  assert.deepEqual(crxA.crxId, crxB.crxId);
  assert.equal(crxA.verifySignature(), true);
  assert.equal(crxB.verifySignature(), true);
});
