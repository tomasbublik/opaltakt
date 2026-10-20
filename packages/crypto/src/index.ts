/**
 * @osp/crypto — token vault primitives for Increment 2 (SPEC_02 §3).
 *
 * KDF (argon2id, scrypt fallback) + AES-256-GCM + the in-memory Vault. The
 * backend composes createVault() with the vault_meta repository from @osp/db.
 * Nothing here ever persists or returns a plaintext token on its own.
 */
export * from "./kdf";
export * from "./cipher";
export * from "./vault";
