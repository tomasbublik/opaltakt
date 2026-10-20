import {
  randomBytes,
  scrypt as scryptCb,
  type ScryptOptions,
} from "node:crypto";

/**
 * Key derivation for the token vault (SPEC_02 §3).
 * Preferred KDF is argon2id (@node-rs/argon2, prebuilt native binding); when it
 * is unavailable on the platform we fall back to Node's built-in scrypt. The
 * algorithm + params are persisted in vault_meta so unlock always re-derives
 * with exactly the parameters the vault was created with.
 */

export type KdfAlgo = "argon2id" | "scrypt";

/** Serializable KDF parameters (stored as vault_meta.kdf_params_json). */
export type KdfParams =
  | { memory_kib: number; iterations: number; parallelism: number } // argon2id
  | { N: number; r: number; p: number }; // scrypt

export const KEY_LENGTH = 32; // AES-256
export const SALT_LENGTH = 16;

/** OWASP-recommended ballpark: 64 MiB memory, 3 passes, 4 lanes. */
export const ARGON2ID_DEFAULT_PARAMS = {
  memory_kib: 65536,
  iterations: 3,
  parallelism: 4,
} as const;

/** Interactive-login strength; N=2^15 keeps unlock well under a second. */
export const SCRYPT_DEFAULT_PARAMS = { N: 32768, r: 8, p: 1 } as const;

// promisify() picks the option-less overload; wrap by hand instead.
const scrypt = (
  passphrase: string,
  salt: Buffer,
  keylen: number,
  opts: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scryptCb(passphrase, salt, keylen, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );

export function generateSalt(): Buffer {
  return randomBytes(SALT_LENGTH);
}

/** Detect the best available KDF: argon2id when loadable, else scrypt. */
export async function pickKdf(): Promise<{ algo: KdfAlgo; params: KdfParams }> {
  try {
    await import("@node-rs/argon2");
    return { algo: "argon2id", params: { ...ARGON2ID_DEFAULT_PARAMS } };
  } catch {
    return { algo: "scrypt", params: { ...SCRYPT_DEFAULT_PARAMS } };
  }
}

/** Derive the 32-byte vault key from the passphrase (CPU-heavy — async). */
export async function deriveKey(
  passphrase: string,
  salt: Buffer,
  algo: KdfAlgo,
  params: KdfParams,
): Promise<Buffer> {
  if (algo === "argon2id") {
    const p = params as { memory_kib: number; iterations: number; parallelism: number };
    const { hashRaw } = await import("@node-rs/argon2");
    // @node-rs/argon2 Algorithm is an ambient const enum (unusable under
    // verbatimModuleSyntax); Argon2id is the numeric value 2.
    const ARGON2ID = 2;
    const raw = await hashRaw(passphrase, {
      algorithm: ARGON2ID,
      salt,
      memoryCost: p.memory_kib,
      timeCost: p.iterations,
      parallelism: p.parallelism,
      outputLen: KEY_LENGTH,
    });
    return Buffer.from(raw);
  }
  const p = params as { N: number; r: number; p: number };
  const key = (await scrypt(passphrase, salt, KEY_LENGTH, {
    N: p.N,
    r: p.r,
    p: p.p,
    // scrypt needs 128*N*r bytes; leave generous headroom.
    maxmem: 256 * p.N * p.r,
  })) as Buffer;
  return key;
}
