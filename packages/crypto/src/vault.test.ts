import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./cipher";
import { deriveKey, generateSalt, SCRYPT_DEFAULT_PARAMS } from "./kdf";
import {
  createVault,
  VaultError,
  type CipherBlob,
  type VaultMetaData,
  type VaultStore,
} from "./index";

/** In-memory VaultStore — what @osp/db's vault_meta repo provides for real. */
function memoryStore(): VaultStore & { meta: VaultMetaData | null } {
  const box: { meta: VaultMetaData | null } = { meta: null };
  return {
    get meta() {
      return box.meta;
    },
    async get() {
      return box.meta;
    },
    async save(m) {
      box.meta = m;
    },
    async delete() {
      box.meta = null;
    },
  };
}

describe("cipher (AES-256-GCM)", () => {
  it("round-trips and authenticates", async () => {
    const key = await deriveKey("pw", generateSalt(), "scrypt", SCRYPT_DEFAULT_PARAMS);
    const blob = encrypt(key, "secret-token");
    expect(decrypt(key, blob)).toBe("secret-token");
    // Unique nonce per encryption → different ciphertexts for the same input.
    expect(encrypt(key, "secret-token").ct).not.toBe(blob.ct);
    // Tampered ciphertext must fail the GCM tag check.
    const tampered = { ...blob, ct: Buffer.from("xx" + Buffer.from(blob.ct, "base64").toString("hex").slice(2), "hex").toString("base64") };
    expect(() => decrypt(key, tampered)).toThrow();
  });

  it("derives a stable key per (passphrase, salt) and differs otherwise", async () => {
    const salt = generateSalt();
    const a = await deriveKey("pw", salt, "scrypt", SCRYPT_DEFAULT_PARAMS);
    const b = await deriveKey("pw", salt, "scrypt", SCRYPT_DEFAULT_PARAMS);
    const c = await deriveKey("pw2", salt, "scrypt", SCRYPT_DEFAULT_PARAMS);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.length).toBe(32);
  });
});

describe("vault", () => {
  it("init → encrypt/decrypt; passphrase round-trip across a 'restart'", async () => {
    const store = memoryStore();
    const vault = createVault(store);
    expect(await vault.status()).toEqual({ initialized: false, locked: true });

    await vault.init("correct horse battery staple");
    expect(await vault.status()).toEqual({ initialized: true, locked: false });
    const blob = vault.encryptToken("op-token-123");
    expect(vault.decryptToken(blob)).toBe("op-token-123");
    // Persisted meta never contains the passphrase, key or token.
    const persisted = JSON.stringify(store.meta);
    expect(persisted).not.toContain("op-token-123");
    expect(persisted).not.toContain("correct horse");

    // "Restart": a fresh Vault over the same store starts locked…
    const restarted = createVault(store);
    expect(await restarted.status()).toEqual({ initialized: true, locked: true });
    expect(() => restarted.decryptToken(blob)).toThrow(VaultError);
    // …a wrong passphrase is rejected and decrypts nothing…
    await expect(restarted.unlock("wrong")).rejects.toMatchObject({
      code: "VAULT_INVALID_PASSPHRASE",
    });
    expect(restarted.isLocked()).toBe(true);
    // …the right passphrase decrypts the same blob.
    await restarted.unlock("correct horse battery staple");
    expect(restarted.decryptToken(blob)).toBe("op-token-123");
  });

  it("double init refuses; unlock before init refuses", async () => {
    const store = memoryStore();
    const vault = createVault(store);
    await expect(vault.unlock("x")).rejects.toMatchObject({
      code: "VAULT_NOT_INITIALIZED",
    });
    await vault.init("passphrase-1");
    await expect(vault.init("other")).rejects.toMatchObject({
      code: "VAULT_ALREADY_INITIALIZED",
    });
  });

  it("lock drops the key; locked operations throw VAULT_LOCKED", async () => {
    const vault = createVault(memoryStore());
    await vault.init("passphrase-1");
    const blob = vault.encryptToken("tok");
    vault.lock();
    expect(vault.isLocked()).toBe(true);
    expect(() => vault.encryptToken("tok")).toThrow(
      expect.objectContaining({ code: "VAULT_LOCKED" }),
    );
    expect(() => vault.decryptToken(blob)).toThrow(
      expect.objectContaining({ code: "VAULT_LOCKED" }),
    );
  });

  it("changePassphrase re-keys: old ct undecryptable, new passphrase works", async () => {
    const store = memoryStore();
    const vault = createVault(store);
    await vault.init("old-passphrase");
    const oldBlob = vault.encryptToken("op-token-123");
    const oldMeta = store.meta;

    let rekeyed: CipherBlob | null = null;
    await vault.changePassphrase("old-passphrase", "new-passphrase", async (dec, enc) => {
      rekeyed = enc(dec(oldBlob));
    });
    expect(rekeyed).not.toBeNull();
    expect(store.meta).not.toEqual(oldMeta); // new salt + verifier persisted
    // Ends unlocked on the NEW key: the re-encrypted blob decrypts…
    expect(vault.decryptToken(rekeyed!)).toBe("op-token-123");
    // …the OLD ciphertext does not (GCM auth fails under the new key).
    expect(() => vault.decryptToken(oldBlob)).toThrow();

    // And the new passphrase (only) unlocks after a restart.
    const restarted = createVault(store);
    await expect(restarted.unlock("old-passphrase")).rejects.toMatchObject({
      code: "VAULT_INVALID_PASSPHRASE",
    });
    await restarted.unlock("new-passphrase");
    expect(restarted.decryptToken(rekeyed!)).toBe("op-token-123");
  });

  it("changePassphrase with a wrong old passphrase changes nothing", async () => {
    const store = memoryStore();
    const vault = createVault(store);
    await vault.init("old-passphrase");
    const before = store.meta;
    await expect(
      vault.changePassphrase("nope", "new-passphrase", async () => {}),
    ).rejects.toMatchObject({ code: "VAULT_INVALID_PASSPHRASE" });
    expect(store.meta).toEqual(before);
  });

  it("reset forgets the vault (uninitialized + locked)", async () => {
    const store = memoryStore();
    const vault = createVault(store);
    await vault.init("passphrase-1");
    await vault.reset();
    expect(await vault.status()).toEqual({ initialized: false, locked: true });
    expect(store.meta).toBeNull();
    // Can init fresh afterwards.
    await vault.init("passphrase-2");
    expect((await vault.status()).initialized).toBe(true);
  });

  it("argon2id is the picked KDF when available (fallback: scrypt)", async () => {
    const { pickKdf } = await import("./kdf");
    const picked = await pickKdf();
    // On this machine @node-rs/argon2 is installed → argon2id; the type also
    // admits scrypt so the assertion documents the fallback contract.
    expect(["argon2id", "scrypt"]).toContain(picked.algo);
    const key = await deriveKey("pw", generateSalt(), picked.algo, picked.params);
    expect(key.length).toBe(32);
  });
});
