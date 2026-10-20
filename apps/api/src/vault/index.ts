import {
  createVault,
  VaultError,
  type CipherBlob,
  type VaultMetaData,
  type VaultStore,
} from "@osp/crypto";
import type { VaultStatusResponse } from "@osp/contracts";
import type { Repositories } from "@osp/db";
import { AppError } from "../errors";

/**
 * App-level vault service (SPEC_02 §3): composes the @osp/crypto vault over the
 * vault_meta repository and layers the connection-token side effects on top
 * (legacy plaintext migration on init, re-key on change-passphrase, token wipe
 * on reset). The passphrase and the derived key never leave backend memory;
 * VaultError codes are re-thrown as AppError with the SAME code.
 */
export interface AppVault {
  status(): Promise<VaultStatusResponse>;
  /**
   * Create the vault (auto-unlocks) and migrate every legacy plaintext token
   * into the encrypted slots (SPEC_02 §2). Returns the migrated-row count.
   */
  init(passphrase: string): Promise<{ migrated: number }>;
  unlock(passphrase: string): Promise<void>;
  lock(): void;
  isLocked(): boolean;
  /** Throws VAULT_LOCKED when no key is in memory. */
  encryptToken(plaintext: string): CipherBlob;
  /** Throws VAULT_LOCKED / on tampered data. Decrypt AD-HOC, drop immediately. */
  decryptToken(blob: CipherBlob): string;
  /** Re-key: re-encrypts EVERY stored connection token under the new key. */
  changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void>;
  /** Forget the vault + delete all stored tokens (base_url/label survive). */
  reset(): Promise<{ cleared_tokens: number }>;
}

/** VaultError codes are a subset of ErrorCode — map 1:1 onto AppError. */
function rethrow(err: unknown): never {
  if (err instanceof VaultError) throw new AppError(err.code, err.message);
  throw err;
}

/** Assemble the CipherBlob from a connection row, or null when no token stored. */
export function connTokenBlob(c: {
  token_ct: string | null;
  token_nonce: string | null;
  token_tag: string | null;
}): CipherBlob | null {
  return c.token_ct != null && c.token_nonce != null && c.token_tag != null
    ? { ct: c.token_ct, nonce: c.token_nonce, tag: c.token_tag }
    : null;
}

export function createAppVault(repos: Repositories): AppVault {
  // Adapt repos.vaultMeta to the crypto VaultStore (strip id/created_at).
  const store: VaultStore = {
    async get(): Promise<VaultMetaData | null> {
      const meta = await repos.vaultMeta.get();
      if (!meta) return null;
      const { id: _id, created_at: _createdAt, ...data } = meta;
      return data;
    },
    async save(meta: VaultMetaData): Promise<void> {
      await repos.vaultMeta.save(meta);
    },
    delete: () => repos.vaultMeta.delete(),
  };
  const vault = createVault(store);

  return {
    status: () => vault.status(),

    async init(passphrase: string): Promise<{ migrated: number }> {
      try {
        await vault.init(passphrase);
      } catch (err) {
        rethrow(err);
      }
      // SPEC_02 §2 migration: encrypt each legacy plaintext token; the repo
      // nulls the plaintext slot in the same write.
      const legacy = await repos.connections.listLegacyPlaintext();
      let migrated = 0;
      for (const conn of legacy) {
        if (conn.token_encrypted == null) continue;
        await repos.connections.setEncryptedToken(
          conn.id,
          vault.encryptToken(conn.token_encrypted),
        );
        migrated += 1;
      }
      return { migrated };
    },

    async unlock(passphrase: string): Promise<void> {
      try {
        await vault.unlock(passphrase);
      } catch (err) {
        rethrow(err);
      }
    },

    lock: () => vault.lock(),
    isLocked: () => vault.isLocked(),

    encryptToken(plaintext: string): CipherBlob {
      try {
        return vault.encryptToken(plaintext);
      } catch (err) {
        rethrow(err);
      }
    },

    decryptToken(blob: CipherBlob): string {
      try {
        return vault.decryptToken(blob);
      } catch (err) {
        rethrow(err);
      }
    },

    async changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
      try {
        await vault.changePassphrase(oldPassphrase, newPassphrase, async (decryptOld, encryptNew) => {
          // Re-encrypt every stored token blob under the new key.
          for (const conn of await repos.connections.list()) {
            const blob = connTokenBlob(conn);
            if (!blob) continue;
            await repos.connections.setEncryptedToken(conn.id, encryptNew(decryptOld(blob)));
          }
        });
      } catch (err) {
        rethrow(err);
      }
    },

    async reset(): Promise<{ cleared_tokens: number }> {
      try {
        await vault.reset();
      } catch (err) {
        rethrow(err);
      }
      const cleared = await repos.connections.clearAllTokens();
      return { cleared_tokens: cleared };
    },
  };
}
