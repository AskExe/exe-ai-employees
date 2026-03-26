/**
 * Master key storage: OS keychain with file fallback.
 *
 * Tries the OS keychain first (macOS Keychain / Linux libsecret via keytar).
 * Falls back to ~/.exe-mem/master.key (base64-encoded, chmod 0600).
 *
 * Also handles BIP39 mnemonic export/import for multi-device key linking.
 *
 * @module keychain
 */

import { readFile, writeFile, unlink, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SERVICE = "exe-mem";
const ACCOUNT = "master-key";

function getKeyDir(): string {
  return process.env.EXE_MEM_DIR ?? path.join(process.env.HOME ?? "/tmp", ".exe-mem");
}

function getKeyPath(): string {
  return path.join(getKeyDir(), "master.key");
}

/**
 * Try to dynamically import keytar. Returns null if unavailable.
 */
async function tryKeytar(): Promise<{
  getPassword: (service: string, account: string) => Promise<string | null>;
  setPassword: (service: string, account: string, password: string) => Promise<void>;
  deletePassword: (service: string, account: string) => Promise<boolean>;
} | null> {
  try {
    return await import("keytar");
  } catch {
    return null;
  }
}

/**
 * Retrieve the master key from OS keychain or file fallback.
 * Returns null if no key is stored anywhere.
 */
export async function getMasterKey(): Promise<Buffer | null> {
  // Try OS keychain first
  const keytar = await tryKeytar();
  if (keytar) {
    try {
      const stored = await keytar.getPassword(SERVICE, ACCOUNT);
      if (stored) {
        return Buffer.from(stored, "base64");
      }
    } catch {
      // Keychain access failed — fall through to file
    }
  }

  // File fallback
  const keyPath = getKeyPath();
  if (!existsSync(keyPath)) {
    return null;
  }

  try {
    const content = await readFile(keyPath, "utf-8");
    return Buffer.from(content.trim(), "base64");
  } catch {
    return null;
  }
}

/**
 * Store the master key in OS keychain (preferred) or file fallback.
 */
export async function setMasterKey(key: Buffer): Promise<void> {
  const b64 = key.toString("base64");

  // Try OS keychain first
  const keytar = await tryKeytar();
  if (keytar) {
    try {
      await keytar.setPassword(SERVICE, ACCOUNT, b64);
      return;
    } catch {
      // Keychain failed — fall through to file
    }
  }

  // File fallback
  const dir = getKeyDir();
  await mkdir(dir, { recursive: true });
  const keyPath = getKeyPath();
  await writeFile(keyPath, b64 + "\n", "utf-8");
  await chmod(keyPath, 0o600);
}

/**
 * Delete the master key from all storage locations.
 */
export async function deleteMasterKey(): Promise<void> {
  // Try keychain
  const keytar = await tryKeytar();
  if (keytar) {
    try {
      await keytar.deletePassword(SERVICE, ACCOUNT);
    } catch {
      // Ignore
    }
  }

  // File
  const keyPath = getKeyPath();
  if (existsSync(keyPath)) {
    await unlink(keyPath);
  }
}

// ---------------------------------------------------------------------------
// BIP39 mnemonic (simplified — uses the standard 2048-word English list)
// ---------------------------------------------------------------------------

/**
 * BIP39 English word list (2048 words).
 * Loaded lazily from bip39 package or built-in fallback.
 */
// BIP39 wordlist loaded lazily via require("bip39") in export/import functions

/**
 * Export a 32-byte master key as a 24-word BIP39 mnemonic.
 * 256 bits → 256/11 = ~23.3 → 24 words (with 8-bit checksum).
 */
export function exportMnemonic(key: Buffer): string {
  if (key.length !== 32) {
    throw new Error(`Key must be 32 bytes, got ${key.length}`);
  }

  // BIP39: 256 bits of entropy + 8 bits checksum = 264 bits = 24 × 11-bit words
  const hash = crypto.createHash("sha256").update(key).digest();
  const checksumByte = hash[0]!;

  // Convert key bytes + checksum to bit string
  let bits = "";
  for (const byte of key) {
    bits += byte.toString(2).padStart(8, "0");
  }
  bits += checksumByte.toString(2).padStart(8, "0");

  // Split into 11-bit groups → word indices
  const words: string[] = [];

  // We need the wordlist synchronously here — require it to be pre-loaded
  // or use a sync approach
  let wordlist: string[];
  try {
    const bip39 = require("bip39");
    wordlist = bip39.wordlists?.english ?? bip39.default?.wordlists?.english;
    if (!wordlist) throw new Error("no wordlist");
  } catch {
    throw new Error("bip39 package required. Install with: npm install bip39");
  }

  for (let i = 0; i < 264; i += 11) {
    const index = parseInt(bits.slice(i, i + 11), 2);
    words.push(wordlist[index]!);
  }

  return words.join(" ");
}

/**
 * Import a 24-word BIP39 mnemonic back to a 32-byte master key.
 */
export function importMnemonic(mnemonic: string): Buffer {
  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 24) {
    throw new Error(`Expected 24 words, got ${words.length}`);
  }

  let wordlist: string[];
  try {
    const bip39 = require("bip39");
    wordlist = bip39.wordlists?.english ?? bip39.default?.wordlists?.english;
    if (!wordlist) throw new Error("no wordlist");
  } catch {
    throw new Error("bip39 package required. Install with: npm install bip39");
  }

  // Convert words → 11-bit indices → bit string
  let bits = "";
  for (const word of words) {
    const index = wordlist.indexOf(word.toLowerCase());
    if (index === -1) {
      throw new Error(`Invalid BIP39 word: "${word}"`);
    }
    bits += index.toString(2).padStart(11, "0");
  }

  // 264 bits = 256 entropy + 8 checksum
  const entropyBits = bits.slice(0, 256);
  const checksumBits = bits.slice(256, 264);

  // Convert entropy bits to bytes
  const key = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    key[i] = parseInt(entropyBits.slice(i * 8, (i + 1) * 8), 2);
  }

  // Verify checksum
  const hash = crypto.createHash("sha256").update(key).digest();
  const expectedChecksum = hash[0]!.toString(2).padStart(8, "0");
  if (checksumBits !== expectedChecksum) {
    throw new Error("Invalid mnemonic checksum");
  }

  return key;
}
