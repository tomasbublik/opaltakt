import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { decrypt, deriveKey, type KdfAlgo, type KdfParams } from "@osp/crypto";
import {
  ExportFormatError,
  exportAll,
  importAll,
  validateEnvelope,
  type ExportEnvelope,
  type OspDatabase,
} from "@osp/db";
import { AppError } from "../errors";

/**
 * Data export / import routes (Increment 27, CONTRACTS §6).
 *
 *   GET  /api/data/export?include_credentials=0|1   → the §6 JSON envelope,
 *                                                     as a file download
 *   POST /api/data/import                           → replace-mode load
 *
 * These are the "move my planning data somewhere else" endpoints: laptop →
 * server, one machine → another, or simply a backup a human can read. They sit
 * beside — not instead of — `scripts/backup.sh` (`pg_dump -Fc`), which is the
 * operational, byte-exact backup. This one is portable and engine-independent;
 * that one is faster and complete. See README §Backup, restore & transfer.
 *
 * ⚠️ Register this plugin from `server.ts` with the SAME `db` handle the
 * repositories were built on — it deliberately bypasses the repository layer
 * (it works table-wise, not entity-wise) and needs the raw Drizzle handle.
 */

/** Wrapper body for POST /api/data/import. */
const ImportBody = z.object({
  /** The §6 export envelope, verbatim. Validated structurally by @osp/db. */
  payload: z.unknown(),
  /**
   * Required **only** for a credentialed payload, where it proves the caller can
   * actually open the vault they are importing. Deliberately a sibling of
   * `payload` rather than a key inside it, so the secret never mingles with the
   * table data (and never ends up in a re-export of that same object).
   */
  passphrase: z.string().min(1).optional(),
});

const ExportQuery = z.object({
  include_credentials: z
    .union([z.literal("0"), z.literal("1"), z.literal("true"), z.literal("false")])
    .optional(),
});

export interface DataRoutesDeps {
  /** Raw Drizzle handle (`DbHandle.db`) — not the repositories. */
  db: OspDatabase;
  /** Clock override for deterministic tests. */
  now?: () => Date;
}

/** `osp-export-20260810-094612.json` — sortable, no separators to escape. */
export function exportFileName(at: Date, withCredentials: boolean): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}` +
    `-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`;
  return `osp-export-${stamp}${withCredentials ? "-with-credentials" : ""}.json`;
}

/**
 * Prove the caller knows the passphrase for the vault carried IN THE PAYLOAD —
 * not the one currently installed, which the import is about to replace.
 *
 * Done **before** the import transaction opens, so a wrong passphrase cannot
 * leave the tables half-replaced: nothing has been touched yet when this throws.
 *
 * The check itself is AES-GCM authentication on the vault's verifier blob:
 * derive the key with the payload's own KDF parameters and try to decrypt. A
 * wrong passphrase fails the tag, which is exactly the same test
 * `Vault.unlock()` performs.
 */
async function assertPassphraseOpensPayloadVault(
  envelope: ExportEnvelope,
  passphrase: string,
): Promise<void> {
  const rows = envelope.tables.vault_meta;
  const meta = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  if (!meta) {
    // includes_credentials with no vault rows: token ciphertext (if any) is
    // unopenable by anyone, and there is no verifier to check against. Nothing
    // to validate — let the import proceed rather than reject on a technicality.
    return;
  }
  const kdfSalt = String(meta.kdf_salt ?? "");
  const kdfAlgo = String(meta.kdf_algo ?? "") as KdfAlgo;
  const verifierCt = String(meta.verifier_ct ?? "");
  const verifierNonce = String(meta.verifier_nonce ?? "");
  if (!kdfSalt || !kdfAlgo || !verifierCt || !verifierNonce) {
    throw new AppError(
      "BAD_REQUEST",
      "The export carries credentials but its vault_meta row is incomplete — " +
        "it cannot be verified or used. Re-export from the source machine.",
    );
  }

  // kdf_params_json is a *_json column, so the envelope holds it parsed.
  const rawParams = meta.kdf_params_json;
  let params: KdfParams;
  try {
    params = (typeof rawParams === "string" ? JSON.parse(rawParams) : rawParams) as KdfParams;
  } catch {
    throw new AppError("BAD_REQUEST", "vault_meta.kdf_params_json is not valid JSON.");
  }

  const key = await deriveKey(passphrase, Buffer.from(kdfSalt, "base64"), kdfAlgo, params);
  // verifier_ct is base64(ciphertext || 16-byte GCM tag) — same split Vault does.
  const combined = Buffer.from(verifierCt, "base64");
  const blob = {
    ct: combined.subarray(0, Math.max(0, combined.length - 16)).toString("base64"),
    nonce: verifierNonce,
    tag: combined.subarray(Math.max(0, combined.length - 16)).toString("base64"),
  };
  try {
    decrypt(key, blob);
  } catch {
    throw new AppError(
      "VAULT_INVALID_PASSPHRASE",
      "Wrong passphrase for the vault in this export — nothing was imported.",
    );
  }
}

export function createDataRoutes(deps: DataRoutesDeps): FastifyPluginAsync {
  const now = deps.now ?? (() => new Date());

  return async (app) => {
    // ── GET /api/data/export ────────────────────────────────────────────────
    // Streams the raw envelope as a download. Deliberately NOT wrapped in the
    // app's usual response envelope: the body is the file, byte for byte, so
    // that what the browser saves is exactly what POST /api/data/import and
    // scripts/migrate-sqlite-to-pg.ts consume.
    app.get("/data/export", { config: { access: "planner" } }, async (req, reply) => {
      const q = ExportQuery.parse(req.query ?? {});
      const includeCredentials = q.include_credentials === "1" || q.include_credentials === "true";
      const at = now();
      const envelope = await exportAll(deps.db, { includeCredentials, now: () => at });
      const body = JSON.stringify(envelope, null, 2);

      reply
        .header("Content-Type", "application/json; charset=utf-8")
        .header(
          "Content-Disposition",
          `attachment; filename="${exportFileName(at, includeCredentials)}"`,
        )
        // Lets a browser fetch() read the filename it would otherwise be
        // blocked from seeing on a cross-origin dev setup (web :5173 → api :3001).
        .header("Access-Control-Expose-Headers", "Content-Disposition")
        .header("X-Osp-Includes-Credentials", includeCredentials ? "1" : "0");
      return reply.send(body);
    });

    // ── POST /api/data/import ───────────────────────────────────────────────
    // Replace mode only (CONTRACTS §6 / decision §9.3): wipe the included
    // tables and load, in ONE transaction. The UI is responsible for the
    // "this destroys the current data" confirmation.
    app.post(
      "/data/import",
      {
        config: { access: "planner" },
        // Fastify's default body limit is 1 MB — far too small. A real export
        // of this app is a few hundred KB today, but ticket_changelog_entry and
        // ticket_baseline.raw_json grow without bound over a project's life,
        // and hitting the cap presents as an opaque 413 rather than "too big".
        bodyLimit: 64 * 1024 * 1024,
      },
      async (req) => {
        const body = ImportBody.parse(req.body ?? {});

        let envelope: ExportEnvelope;
        try {
          envelope = validateEnvelope(body.payload);
        } catch (err) {
          if (err instanceof ExportFormatError) {
            throw new AppError("BAD_REQUEST", err.message);
          }
          throw err;
        }

        const credentialed = envelope.includes_credentials === true;
        if (credentialed) {
          if (!body.passphrase) {
            throw new AppError(
              "BAD_REQUEST",
              "This export carries vault credentials — the vault passphrase is " +
                "required to import it.",
            );
          }
          await assertPassphraseOpensPayloadVault(envelope, body.passphrase);
        } else if (body.passphrase) {
          throw new AppError(
            "BAD_REQUEST",
            "This export carries no credentials, so no passphrase is needed. " +
              "Re-submit without one.",
          );
        }

        let result;
        try {
          result = await importAll(deps.db, envelope);
        } catch (err) {
          if (err instanceof ExportFormatError) {
            throw new AppError("BAD_REQUEST", err.message);
          }
          throw err;
        }

        return {
          imported_at: now().toISOString(),
          tables: result.inserted,
        };
      },
    );
  };
}
