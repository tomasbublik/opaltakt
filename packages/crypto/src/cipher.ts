import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for vault-encrypted secrets (SPEC_02 §3): per-encryption random
 * 12-byte nonce, ciphertext + auth tag stored separately, everything base64.
 */

export const NONCE_LENGTH = 12;
export const TAG_LENGTH = 16;

/** Encrypted secret triple, base64-encoded (maps 1:1 to token_ct/nonce/tag). */
export interface CipherBlob {
  ct: string;
  nonce: string;
  tag: string;
}

export function encrypt(key: Buffer, plaintext: string): CipherBlob {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ct: ct.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/** Throws on a wrong key or tampered ciphertext (GCM auth failure). */
export function decrypt(key: Buffer, blob: CipherBlob): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(blob.nonce, "base64"),
  );
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(blob.ct, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}
