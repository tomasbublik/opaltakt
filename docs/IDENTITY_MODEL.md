# Person identity — the canonical model (decision record)

> Written during the identity-unification run (HANDOFF "Jedna identita osoby",
> post-Increment 30). Read this before touching `personKey`,
> `createPersonResolver`, or anything that groups hours per person.

## The decision

**A person is GLOBAL; an `op_user_id` is a per-connection alias of a person.**

- `team_member` has **no `connection_id`** — deliberately. One human is one
  roster row, whichever OP server their tickets live on. Identity IS the name
  (Increment 13); the numeric id is opportunistic enrichment.
- A bare `op_user_id` is only unique **within** one connection (Increment 23:
  Alan Turing id 3 on the mock ≠ Cameron Dalby id 3 on Acme), so an
  id-based lookup needs connection context to be trusted — but the *person* it
  resolves to is connection-free.

The old structural mismatch ("`team_member` is global × `personKey` is
per-connection") is resolved in favour of the **person**: the canonical key is

1. `tm:<team_member.id>` — the person has a roster row. Ids, names, spellings
   (via `user_name_alias`) and connections all fold onto it.
2. `id:<connection>:<op_user_id>` — no roster row, but an id. A null-connection
   appearance (purged cache row, legacy un-backfilled cache) **adopts** the one
   connection that knows the id, so missing context can never fork the key.
3. `nm:<name>` — nothing but a name (journal-only person). Connection-agnostic;
   a genuine cross-connection same-name clash is curated apart via
   `user_name_alias`, never split silently.

There is exactly **one** implementation: `packages/contracts/src/identity.ts`
(`personKey` — the raw fallback shape — and `createPersonResolver` — the
folding layer applied everywhere in production). `apps/api/src/logic/
personResolver.ts` is the assembly helper that builds the resolver from the DB
(roster + aliases + learned (name ↔ id) pairs from cached WPs, baselines and
time-log actors). The former second definition in `logic/capacity.ts` and the
ad-hoc `resolvePerson` in `closureStats.ts` are deleted.

## The cross-connection guard

An id-based roster match is rejected only on **connection-scoped evidence** of
a different person: the appearance carries a non-null connection AND a name
disagreeing with the roster person (or that connection's own cache names the
id differently). With no connection context, a differing spelling on the same
id is a spelling variant and folds — rejecting it is exactly the fragmentation
this model exists to end. A curated alias (`op_user_id` pin) overrides the
guard: the human said so.

## Role defaulting (why Zbynek Trnka vanished)

`capacityEffectiveRole` (same module): **only an explicit tester / customer /
other makes a person non-developer**; "unset" — including "not in
`team_member` at all" — stays plannable. `/capacity` always applied this
(`capacityRoleForMemberRole`, now deleted in its favour); `closure-stats`
did not, so a logging-but-unrostered person was counted on one surface and
invisible on the other. Both surfaces now share the one default. The
done-matrix (`classifyWithRole`) still receives the RAW role — there "unset"
must stay ambiguous ("admit, don't infer").

## Guarantees (pinned by golden tests)

`tests/src/identity-golden.test.ts` + `tests/src/identity-golden-unit.test.ts`
(written FIRST, red against the pre-unification build):

- every name appears at most once per surface; nobody who logged time or holds
  a ticket is missing;
- `connectionId = null` vs a known connection, and id-carrying vs name-only
  appearances, key identically for one person;
- aliases fold **before** keying;
- the one split that must survive: the same numeric id on two different
  connections stays two people;
- what the Capacity panel joins (`capacityLineKey` over `per_developer`)
  equals `/capacity`'s own lines, per person, planned and logged.

`pnpm diag -- --sprint <id>` (read-only) prints the cross-surface comparison
and flags duplicate identities / missing people — see README.
