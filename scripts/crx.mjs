/**
 * Dependency-free CRX3 builder for the DSH Chrome extension.
 *
 * CRX3 format (Chromium extensions):
 *   "Cr24" | uint32le version=3 | uint32le header_size | CrxFileHeader | zip
 * CrxFileHeader (protobuf):
 *   field 2  repeated AsymmetricKeyProof { public_key=1, signature=2 }  (sha256_with_rsa)
 *   field 10000 bytes signed_header_data = SignedData { crx_id=1 }
 * Signature covers:
 *   "CRX3 SignedData\0" | uint32le(len(signed_header_data)) | signed_header_data | zip
 *
 * The zip is written here too (store method), so packaging needs no npm deps
 * and stays small on disk.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const MAGIC = Buffer.from("Cr24", "latin1");
const SIGNATURE_PREFIX = Buffer.from("CRX3 SignedData\x00", "latin1");

function u32le(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

// ---------------------------------------------------------------------------
// ZIP (store method only; extension archives are small)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

function listFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      const stat = statSync(absolute);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) {
        const name = relative(root, absolute).split(sep).join("/");
        files.push({ name, bytes: readFileSync(absolute) });
      }
    }
  };
  walk(root);
  files.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return files;
}

/**
 * Build a ZIP archive (store method) from a directory.
 * @param {string} directory
 * @returns {Buffer}
 */
export function buildZip(directory) {
  const files = listFiles(directory);
  const { time, day } = dosDateTime();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(file.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 file names
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.bytes.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, file.bytes);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(file.bytes.length, 20);
    entry.writeUInt32LE(file.bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + file.bytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBytes, eocd]);
}

// ---------------------------------------------------------------------------
// Protobuf helpers
// ---------------------------------------------------------------------------

function varint(value) {
  const bytes = [];
  let current = BigInt(value);
  for (;;) {
    const byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current === 0n) {
      bytes.push(byte);
      break;
    }
    bytes.push(byte | 0x80);
  }
  return Buffer.from(bytes);
}

function lengthDelimited(fieldNumber, payload) {
  return Buffer.concat([varint((fieldNumber << 3) | 2), varint(payload.length), payload]);
}

function readVarint(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  let index = offset;
  for (;;) {
    const byte = buffer[index];
    if (byte === undefined) throw new Error("truncated varint");
    result |= BigInt(byte & 0x7f) << shift;
    index += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: Number(result), offset: index };
}

function parseFields(buffer) {
  const fields = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (wire === 0) {
      const value = readVarint(buffer, offset);
      offset = value.offset;
      fields.set(field, [...(fields.get(field) ?? []), { wire, value: value.value }]);
    } else if (wire === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const payload = buffer.subarray(offset, offset + length.value);
      offset += length.value;
      fields.set(field, [...(fields.get(field) ?? []), { wire, payload }]);
    } else if (wire === 1) {
      offset += 8;
    } else if (wire === 5) {
      offset += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// CRX3
// ---------------------------------------------------------------------------

/** Generate an RSA-2048 signing key (PKCS#8 PEM + SPKI DER). */
export function generateSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyDer: publicKey.export({ type: "spki", format: "der" }),
  };
}

/** Derive the SPKI DER public key from a PKCS#8/PKCS#1 PEM private key. */
export function publicKeyDerFromPem(privateKeyPem) {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "der" });
}

function crxIdOf(publicKeyDer) {
  return createHash("sha256").update(publicKeyDer).digest().subarray(0, 16);
}

/**
 * Build a CRX3 file around a zip payload.
 * @param {{zip: Buffer, privateKeyPem: string, publicKeyDer: Buffer}} input
 * @returns {Buffer}
 */
export function buildCrx(input) {
  const { zip, privateKeyPem, publicKeyDer } = input;
  if (!Buffer.isBuffer(zip) || zip.length === 0) throw new Error("buildCrx: zip buffer is required");
  if (typeof privateKeyPem !== "string" || privateKeyPem === "") throw new Error("buildCrx: privateKeyPem is required");
  if (!Buffer.isBuffer(publicKeyDer) || publicKeyDer.length === 0) throw new Error("buildCrx: publicKeyDer is required");

  const signedHeaderData = lengthDelimited(1, crxIdOf(publicKeyDer)); // SignedData { crx_id }
  const signedContent = Buffer.concat([SIGNATURE_PREFIX, u32le(signedHeaderData.length), signedHeaderData, zip]);
  const signature = sign("sha256", signedContent, privateKeyPem);
  const proof = Buffer.concat([lengthDelimited(1, publicKeyDer), lengthDelimited(2, signature)]);
  const header = Buffer.concat([lengthDelimited(2, proof), lengthDelimited(10000, signedHeaderData)]);

  const prefix = Buffer.alloc(12);
  MAGIC.copy(prefix, 0);
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, zip]);
}

/**
 * Parse a CRX3 file back into its parts and verify the signature.
 * @param {Buffer} crx
 */
export function parseCrx(crx) {
  if (!Buffer.isBuffer(crx) || crx.length < 12) throw new Error("parseCrx: not a CRX3 file");
  if (crx.subarray(0, 4).toString("latin1") !== "Cr24") throw new Error("parseCrx: bad magic");
  const version = crx.readUInt32LE(4);
  if (version !== 3) throw new Error(`parseCrx: unsupported version ${version}`);
  const headerSize = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerSize);
  const zip = crx.subarray(12 + headerSize);
  const fields = parseFields(header);
  const proof = fields.get(2)?.[0]?.payload;
  if (proof === undefined) throw new Error("parseCrx: missing sha256_with_rsa proof");
  const proofFields = parseFields(proof);
  const publicKeyDer = proofFields.get(1)?.[0]?.payload;
  const signature = proofFields.get(2)?.[0]?.payload;
  const signedHeaderData = fields.get(10000)?.[0]?.payload;
  if (publicKeyDer === undefined || signature === undefined || signedHeaderData === undefined) {
    throw new Error("parseCrx: incomplete header");
  }
  const signedFields = parseFields(signedHeaderData);
  const crxId = signedFields.get(1)?.[0]?.payload;
  const signedContent = Buffer.concat([SIGNATURE_PREFIX, u32le(signedHeaderData.length), signedHeaderData, zip]);
  return {
    version,
    header,
    zip,
    publicKeyDer,
    signature,
    signedHeaderData,
    crxId,
    expectedCrxId: () => crxIdOf(publicKeyDer),
    verifySignature: () => verify("sha256", signedContent, { key: publicKeyDer, format: "der", type: "spki" }, signature),
  };
}
