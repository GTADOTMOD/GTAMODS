import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { files, writePrivateFile } from "./paths.js";

/**
 * The wallet's secret key never touches disk unencrypted: it is sealed with
 * AES-256-GCM under a key derived from the user's password with scrypt.
 * The address is bound in as associated data, so editing it in the file
 * makes decryption fail instead of showing the wrong wallet.
 */
export interface KdfParams {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_KDF: KdfParams = { N: 2 ** 17, r: 8, p: 1 };

export interface KeystoreFile {
  version: 1;
  address: string;
  kdf: { name: "scrypt"; salt: string } & KdfParams;
  cipher: { name: "aes-256-gcm"; iv: string; tag: string; ciphertext: string };
  createdAt: string;
}

export class WrongPasswordError extends Error {
  constructor() {
    super("Wrong password (or the keystore file was modified).");
  }
}

export const MIN_PASSWORD_LENGTH = 10;

function deriveKey(password: string, salt: Buffer, kdf: KdfParams): Buffer {
  return crypto.scryptSync(password.normalize("NFKC"), salt, 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 256 * 1024 * 1024,
  });
}

export function encryptKeypair(
  keypair: Keypair,
  password: string,
  kdf: KdfParams = DEFAULT_KDF,
): KeystoreFile {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt, kdf);
  const address = keypair.publicKey.toBase58();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(address, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(keypair.secretKey)), cipher.final()]);
  key.fill(0);
  return {
    version: 1,
    address,
    kdf: { name: "scrypt", salt: salt.toString("base64"), ...kdf },
    cipher: {
      name: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    },
    createdAt: new Date().toISOString(),
  };
}

export function decryptKeypair(file: KeystoreFile, password: string): Keypair {
  if (file.version !== 1 || file.kdf?.name !== "scrypt" || file.cipher?.name !== "aes-256-gcm") {
    throw new Error("Unsupported keystore format.");
  }
  const key = deriveKey(password, Buffer.from(file.kdf.salt, "base64"), file.kdf);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(file.cipher.iv, "base64"));
  decipher.setAAD(Buffer.from(file.address, "utf8"));
  decipher.setAuthTag(Buffer.from(file.cipher.tag, "base64"));
  let secret: Buffer;
  try {
    secret = Buffer.concat([
      decipher.update(Buffer.from(file.cipher.ciphertext, "base64")),
      decipher.final(),
    ]);
  } catch {
    throw new WrongPasswordError();
  } finally {
    key.fill(0);
  }
  const keypair = Keypair.fromSecretKey(new Uint8Array(secret));
  secret.fill(0);
  if (keypair.publicKey.toBase58() !== file.address) {
    throw new Error("Keystore is corrupt: decrypted key does not match its address.");
  }
  return keypair;
}

/** Accepts the two formats wallets export: a base58 string (Phantom,
 * Solflare) or a JSON array of 64 numbers (solana-keygen). */
export function parseSecretKey(input: string): Keypair {
  const text = input.trim();
  let bytes: Uint8Array;
  if (text.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new Error("That looks like a JSON array but it does not parse.");
    }
    if (!Array.isArray(arr) || arr.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error("Expected a JSON array of byte values.");
    }
    bytes = Uint8Array.from(arr as number[]);
  } else {
    try {
      bytes = bs58.decode(text);
    } catch {
      throw new Error("Not a valid base58 secret key.");
    }
  }
  if (bytes.length !== 64) {
    throw new Error(`A Solana secret key is 64 bytes; got ${bytes.length}.`);
  }
  // fromSecretKey checks that the public half matches the private half.
  return Keypair.fromSecretKey(bytes);
}

export function keystoreExists(): boolean {
  return fs.existsSync(files.keystore());
}

export function readKeystore(): KeystoreFile {
  return JSON.parse(fs.readFileSync(files.keystore(), "utf8")) as KeystoreFile;
}

export function saveKeystore(ks: KeystoreFile): void {
  writePrivateFile(files.keystore(), JSON.stringify(ks, null, 2) + "\n");
}

/** Takes the wallet out of use. Its encrypted file is kept, in case that was a mistake. */
export function archiveKeystore(): void {
  fs.mkdirSync(files.oldWallets(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.renameSync(files.keystore(), path.join(files.oldWallets(), `keystore-${stamp}.json`));
}
