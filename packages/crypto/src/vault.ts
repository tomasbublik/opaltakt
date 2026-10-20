import { timingSafeEqual } from "node:crypto";
import { decrypt, encrypt, type CipherBlob } from "./cipher";
import {
  deriveKey,
  generateSalt,
  pickKdf,
  type KdfAlgo,
  type KdfParams,
} from "./kdf";

/**
 * The token vault (SPEC_02 §3): one master passphrase, entered at start,
 * unlocks every stored OP token. The derived AES-256 key lives ONLY in this
 * object's memory — never on disk, never in a response. Persistence of the
 * KDF config + verifier is delegated to a VaultStore (vault_meta in @osp/db).
 */

/** Known-constant blob; decrypting it successfully proves the passphrase. */
const VERIFIER_PLAINTEXT = "osp-vault-verifier-v1";

export type VaultErrorCode =
  | "VAULT_LOCKED"
  | "VAULT_NOT_INITIALIZED"
  | "VAULT_ALREADY_INITIALIZED"
  | "VAULT_INVALID_PASSPHRASE";

export class VaultError extends Error {
  override readonly name = "VaultError";
  constructor(
    readonly code: VaultErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Persisted vault metadata — matches vault_meta minus id/created_at. */
export interface VaultMetaData {
  kdf_algo: KdfAlgo;
  /** base64 */
  kdf_salt: string;
  /** JSON-serialized KdfParams */
  kdf_params_json: string;
  /** base64(ciphertext || 16-byte GCM tag) of VERIFIER_PLAINTEXT */
  verifier_ct: string;
  /** base64 */
  verifier_nonce: string;
}

export interface VaultStore {
  get(): Promise<VaultMetaData | null>;
  save(meta: VaultMetaData): Promise<void>;
  delete(): Promise<void>;
}

export interface VaultStatus {
  initialized: boolean;
  locked: boolean;
}

export interface Vault {
  status(): Promise<VaultStatus>;
  /** Create the vault (auto-unlocks). Throws VAULT_ALREADY_INITIALIZED. */
  init(passphrase: string): Promise<void>;
  /** Throws VAULT_NOT_INITIALIZED / VAULT_INVALID_PASSPHRASE. */
  unlock(passphrase: string): Promise<void>;
  /** Drop the in-memory key. Safe to call repeatedly. */
  lock(): void;
  isLocked(): boolean;
  /** Throws VAULT_LOCKED when no key is in memory. */
  encryptToken(plaintext: string): CipherBlob;
  /** Throws VAULT_LOCKED; throws on wrong key / tampered data (GCM). */
  decryptToken(blob: CipherBlob): string;
  /**
   * Re-key: verify the old passphrase, derive a fresh key (new salt), let the
   * caller re-encrypt every stored token via the callback, then persist the new
   * verifier. Ends unlocked with the NEW key.
   */
  changePassphrase(
    oldPassphrase: string,
    newPassphrase: string,
    rekey: (
      decryptOld: (blob: CipherBlob) => string,
      encryptNew: (plaintext: string) => CipherBlob,
    ) => Promise<void>,
  ): Promise<void>;
  /** Forget the vault entirely (meta deleted + locked). Caller clears tokens. */
  reset(): Promise<void>;
}

/** Split base64(ct || tag) back into a CipherBlob. */
function verifierBlob(meta: VaultMetaData): CipherBlob {
  const combined = Buffer.from(meta.verifier_ct, "base64");
  const tag = combined.subarray(combined.length - 16);
  const ct = combined.subarray(0, combined.length - 16);
  return {
    ct: ct.toString("base64"),
    nonce: meta.verifier_nonce,
    tag: tag.toString("base64"),
  };
}

async function makeMeta(
  passphrase: string,
): Promise<{ meta: VaultMetaData; key: Buffer }> {
  const { algo, params } = await pickKdf();
  return makeMetaWith(passphrase, algo, params);
}

async function makeMetaWith(
  passphrase: string,
  algo: KdfAlgo,
  params: KdfParams,
): Promise<{ meta: VaultMetaData; key: Buffer }> {
  const salt = generateSalt();
  const key = await deriveKey(passphrase, salt, algo, params);
  const v = encrypt(key, VERIFIER_PLAINTEXT);
  const combined = Buffer.concat([
    Buffer.from(v.ct, "base64"),
    Buffer.from(v.tag, "base64"),
  ]);
  return {
    meta: {
      kdf_algo: algo,
      kdf_salt: salt.toString("base64"),
      kdf_params_json: JSON.stringify(params),
      verifier_ct: combined.toString("base64"),
      verifier_nonce: v.nonce,
    },
    key,
  };
}

async function deriveFromMeta(
  meta: VaultMetaData,
  passphrase: string,
): Promise<Buffer> {
  return deriveKey(
    passphrase,
    Buffer.from(meta.kdf_salt, "base64"),
    meta.kdf_algo,
    JSON.parse(meta.kdf_params_json) as KdfParams,
  );
}

/** True when `key` decrypts the stored verifier to the known constant. */
function keyMatches(meta: VaultMetaData, key: Buffer): boolean {
  try {
    const plain = Buffer.from(decrypt(key, verifierBlob(meta)), "utf8");
    const expected = Buffer.from(VERIFIER_PLAINTEXT, "utf8");
    return plain.length === expected.length && timingSafeEqual(plain, expected);
  } catch {
    // GCM auth failure — wrong passphrase.
    return false;
  }
}

export function createVault(store: VaultStore): Vault {
  // The ONLY place the derived key ever lives.
  let key: Buffer | null = null;

  const dropKey = (): void => {
    if (key) key.fill(0);
    key = null;
  };

  const requireKey = (): Buffer => {
    if (!key) throw new VaultError("VAULT_LOCKED", "The vault is locked");
    return key;
  };

  return {
    async status(): Promise<VaultStatus> {
      const meta = await store.get();
      return { initialized: meta != null, locked: key == null };
    },

    async init(passphrase: string): Promise<void> {
      if ((await store.get()) != null) {
        throw new VaultError("VAULT_ALREADY_INITIALIZED");
      }
      const made = await makeMeta(passphrase);
      await store.save(made.meta);
      dropKey();
      key = made.key;
    },

    async unlock(passphrase: string): Promise<void> {
      const meta = await store.get();
      if (!meta) throw new VaultError("VAULT_NOT_INITIALIZED");
      const candidate = await deriveFromMeta(meta, passphrase);
      if (!keyMatches(meta, candidate)) {
        candidate.fill(0);
        throw new VaultError("VAULT_INVALID_PASSPHRASE", "Wrong passphrase");
      }
      dropKey();
      key = candidate;
    },

    lock(): void {
      dropKey();
    },

    isLocked(): boolean {
      return key == null;
    },

    encryptToken(plaintext: string): CipherBlob {
      return encrypt(requireKey(), plaintext);
    },

    decryptToken(blob: CipherBlob): string {
      return decrypt(requireKey(), blob);
    },

    async changePassphrase(oldPassphrase, newPassphrase, rekey): Promise<void> {
      const meta = await store.get();
      if (!meta) throw new VaultError("VAULT_NOT_INITIALIZED");
      const oldKey = await deriveFromMeta(meta, oldPassphrase);
      if (!keyMatches(meta, oldKey)) {
        oldKey.fill(0);
        throw new VaultError("VAULT_INVALID_PASSPHRASE", "Wrong passphrase");
      }
      const made = await makeMetaWith(
        newPassphrase,
        meta.kdf_algo,
        JSON.parse(meta.kdf_params_json) as KdfParams,
      );
      // Re-encrypt every stored secret BEFORE persisting the new verifier, so a
      // failing rekey leaves the vault fully on the old passphrase.
      await rekey(
        (blob) => decrypt(oldKey, blob),
        (plaintext) => encrypt(made.key, plaintext),
      );
      await store.save(made.meta);
      oldKey.fill(0);
      dropKey();
      key = made.key;
    },

    async reset(): Promise<void> {
      await store.delete();
      dropKey();
    },
  };
}
