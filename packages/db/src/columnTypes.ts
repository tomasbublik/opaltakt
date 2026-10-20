import { customType } from "drizzle-orm/pg-core";

/**
 * Shared custom Postgres column types (Increment 27, CONTRACTS §3a/§3b).
 *
 * These two types carry the whole SQLite→Postgres mapping for the "interesting"
 * columns. They exist for one reason: **the TypeScript-facing type of every
 * column stays byte-identical to what it was under SQLite** (`string`). That is
 * what makes the repository conversion a purely mechanical sync→async change
 * with no data-shape churn, and it is why `mappers.ts` and every `JSON.parse`
 * call site in the app keep working untouched.
 *
 * Do not "simplify" either of these into a stock Drizzle column type. Both
 * replace a stock type that was tried first and found to be subtly wrong — see
 * the WHY comments below.
 */

/**
 * `isoTimestamp` — a real `timestamp with time zone` that reads back as a
 * **contract-valid ISO-8601 string**.
 *
 * ⚠️ THE TRAP (verified in Phase 0, the single biggest gotcha of this cut):
 * Drizzle's stock `timestamp({ withTimezone: true, mode: "string" })` hands
 * back Postgres's *own* rendering of a timestamptz:
 *
 *     "2026-08-10 07:39:19.488+00"      ← space instead of 'T', offset "+00"
 *
 * That string **fails** `z.string().datetime({ offset: true })`, which is
 * exactly what `@osp/contracts` validates every datetime field with
 * (`IsoDateTime`, common.ts). Using `mode: "string"` would therefore break
 * contract validation across the whole API surface — and it would do so at
 * runtime, in responses, not at compile time.
 *
 * The obvious alternative, `mode: "date"`, returns a `Date` object, which
 * changes the TS type of ~35 columns and every consumer that touches them.
 *
 * So: store a genuine `timestamptz` (native comparison, `ORDER BY` and index
 * behaviour, UTC normalisation — all free), let the driver give us its `Date`,
 * and normalise to `Date#toISOString()` on the way out. `"…T…Z"` in →
 * byte-identical `"…T…Z"` out.
 *
 * `fromDriver` tolerates a non-Date (PGlite / a driver configured with a
 * string parser) by re-parsing it, so the type is engine-agnostic.
 */
export const isoTimestamp = customType<{ data: string; driverData: Date }>({
  dataType: () => "timestamp with time zone",
  fromDriver: (v) => (v instanceof Date ? v.toISOString() : new Date(v as string).toISOString()),
  toDriver: (v) => new Date(v),
});

/**
 * `jsonbText` — stored natively as `jsonb`, exposed to TypeScript as the JSON
 * `string` it has always been.
 *
 * WHY not `jsonb()` (which would give TS an `unknown`/parsed object)? Every
 * `*_json` column in this app is written as an already-serialized string and
 * `JSON.parse`d at the call sites — that is true in repos, in the logic layer,
 * in the export path and in the contracts (which type these fields as
 * `string`). Switching to parsed objects would ripple through dozens of call
 * sites for no behavioural gain. Keeping `data: string` means the storage
 * upgrade (real jsonb: indexable, queryable, validated on write) is invisible
 * to every consumer.
 *
 * `toDriver` passes the JSON string straight through — node-postgres sends it
 * as a text parameter and Postgres casts it to `jsonb` for the column.
 * `fromDriver` re-serializes the value the driver already parsed for us.
 *
 * ⚠️ CAVEAT (CONTRACTS §3b): the parse→stringify round-trip **normalises key
 * order and whitespace**. The value is JSON-equal but not necessarily
 * byte-equal to what was written. Nothing may compare a `*_json` column
 * byte-for-byte against an expected string — assert on `JSON.parse(...)`
 * instead. (Applies to `raw_json`, `detail_json`, `changes_json`,
 * `kdf_params_json`, `done_json`, `not_done_json`, `version_change_json`,
 * `reconstruction_gaps_json`.)
 */
export const jsonbText = customType<{ data: string; driverData: unknown }>({
  dataType: () => "jsonb",
  fromDriver: (v) => (typeof v === "string" ? v : JSON.stringify(v)),
  toDriver: (v) => v,
});
