# Increment 40 — DRAFT: OpenProject projekt u každého ticketu

> Stav: **návrh k rozhodnutí** (nic neimplementováno). Na konci jsou otázky — vyber varianty
> (D1/D2, F1/F2, …) a teprve pak vznikne `INCREMENT_40_CONTRACTS.md`.
> Příklady v tomto dokumentu používají fiktivní instanci `openproject.acme.example`
> a fiktivní projekt `northwind` (pravidlo z public-release: žádná reálná jména).

---

## Část 1 — Výzkum: jak spolehlivě získat projekt work packagu

### 1.1 Co vrací OP API v3 (bez jakéhokoli dalšího volání)

Každý work package v `GET /api/v3/work_packages…` nese HAL odkaz:

```json
"_links": { "project": { "href": "/api/v3/projects/42", "title": "Northwind" } }
```

- `href` → **numerické `op_id` projektu** (stabilní identita, nikdy se nemění).
- `title` → **zobrazované jméno** projektu (`name`), aktuální k okamžiku fetche.
- **`identifier` v payloadu WP NENÍ.** Ten (`northwind` — to, co uživatel zná z URL
  `…/projects/northwind/work_packages/12152`) vrací až `GET /api/v3/projects/{id}` nebo kolekce
  `GET /api/v3/projects`.
- Stejný odkaz `_links.project {href,title}` nese i **time entry** (`OpTimeEntry._links.project`,
  `packages/op-client/src/types.ts:141`) — relevantní pro off-sprint report.

Přesměrování z `/work_packages/12152` na `/projects/<identifier>/work_packages/12152` je jen
UI chování webu OP; API ho nepotřebuje — `_links.project.href` je spolehlivější a máme ho už
v každém fetchnutém WP.

> Ověřeno proti kódu a mocku; **proti živé OP instanci ověřeno nebylo** (vyžaduje tvůj
> souhlas — stačil by jeden GET na `/api/v3/work_packages/<id>` a `/api/v3/projects/<id>`).

### 1.2 Co už dnes ukládáme (ověřeno v kódu)

| Kde | Co | Poznámka |
|---|---|---|
| `work_package_cache.project_op_id` (NOT NULL) | id z `_links.project.href` | `toWorkPackageCacheRow`, `packages/sync/src/index.ts:305`; chybějící odkaz → `0` |
| `work_package_cache.raw_json` (jsonb) | celý WP payload **včetně `_links.project.title`** | jméno tedy máme, jen ho nikdo nečte → backfill bez OP volání je možný |
| tabulka `project` (`connection_id`, `op_id`, `identifier`, `name`) | identifier + name | **plní se JEN v `GET /api/projects`** (Import picker), `routes/index.ts:1130–1180` |
| `import_selection.project_name` | jméno v okamžiku importu | jen pro seznam importů |
| `sprint_item.frozen_project_op_id` | id při freeze (Inc. 31 amendment) | **jméno/identifier se nezmrazuje** |
| `ticket_baseline.raw_json` | payload při aktivaci, vč. `_links.project` | žádný projektový sloupec, ale title+href jsou v JSONu |
| `off_sprint_time_entry` | `wp_op_id`, `wp_subject`, … | **projekt zahozen** (je v payloadu time entry) |

Kde se dnes projekt zobrazuje: **jen Backlog** (sloupec „Project" + filtr, `BacklogScreen.tsx:518,
658, 411`), `BacklogItem.project_name` a `SprintItemDetail.project_name` (ten ale web na kartě
nerenderuje). Closure (`TicketEstimateLine`), Reports, oba PDF (`report.ts`, `statusReport.ts`) ani
karta na Sprint Boardu (`WpCard`) projekt nemají vůbec.

### 1.3 Nalezené mezery a latentní chyby

1. **Cross-server kolize jména projektu.** `sprintItemsDetailed.ts:112` a `GET /backlog`
   (`routes/index.ts:1899`) mapují `project_name` přes `Map(op_id → name)` **bez connection_id**.
   Dva servery s projektem id 3 → jeden přepíše druhý (stejná třída chyb jako Turing/Dalby id 3,
   Inc. 23). `GET /backlog/out-of-selection` to už dělá správně (klíč `connection:op_id` + fallback)
   — to je vzor k převzetí.
2. **Tabulka `project` je neúplná.**
   - plní se jen návštěvou Import pickeru;
   - `getProjects()` (`op-client/src/impl.ts:203`) **nestránkuje** — OP vrací default jen první
     stránku (typicky 20–30 projektů), takže při víc projektech chybí identifier/jméno;
   - ticket přidaný přes „Add by id" / retro-add z projektu, který v pickeru nikdy nebyl → `null`.
3. **Zmrazený sprint má `project_name` vždy `null`.** `sprintItemsDetailed.ts:107` dělá
   `wpByOpId.clear()` (invariant 10) a `project_name` se počítá jen `wp ? … : null` (ř. 230).
   Dnes to nikdo nevidí, protože Board/PDF projekt nerenderují — po tomto incrementu by to
   vidět bylo. Řešení = snapshot (viz D-freeze).
4. **`ticket_baseline` nemá projektový sloupec** — ale `raw_json` ho obsahuje → fallback pro
   retro/gapnuté tickety bez cache řádku je možný bez OP volání.
5. **Přejmenování.** `op_id` je identita; `name` i `identifier` se v OP dají změnit (identifier
   v nastavení projektu, staré URL OP přesměruje). Musíme je brát jako *display-only* a nikdy
   podle nich nejoinovat. Backlog filtr dnes filtruje **podle jména** (`BacklogScreen.tsx:74`) —
   dva různé projekty stejného jména (na dvou serverech) splynou.
6. **Oprávnění.** Když token vidí WP, vidí i jeho projekt (view_work_packages je per-projekt),
   takže `_links.project.title` přijde vždy. `GET /projects/{id}` ale může vrátit 404 (archivovaný
   projekt, změna práv mezi synci) → identifier `null`, jméno z WP payloadu. Nikdy nepadat.
7. **Subprojekty.** `_links.project` ukazuje na skutečný (pod)projekt WP — správně i při importu
   rodiče. Rodičovský projekt (`project._links.parent`) navrhuji **nezobrazovat** (scope creep).
8. **`project_op_id = 0`** pro WP bez odkazu (teoreticky) — zobrazit „—", ne „Project 0".
9. **Mock.** Scenario mode modeluje projekty korektně (`ScenarioProject {id, identifier, name}`,
   `hal.ts:358` dává `title: project.name`). Legacy membership endpoint vrací
   `title: "Project N"` (`mock-op-server/index.ts:275`) — kosmetické. Chybí: `GET /api/v3/projects/{id}`
   (single), stránkování `/projects`, scénář „sprint přes 2 projekty", „přejmenovaný projekt",
   „2 servery se stejným project id".

---

## Část 2 — Datový model

### D — kde držet projekt (vyber jednu)

**D1 (doporučuji): denormalizovat jméno na ticket + identifier z connection-scoped `project`.**
- Migrace: `work_package_cache.project_name text NULL` (+ totéž ve `*_staging`), mapper plní
  z `_links.project.title`. Backfill v migraci čistě SQL z `raw_json #>> '{_links,project,title}'`
  (nulové OP volání).
- `project` tabulka zůstává zdrojem **identifieru**; sync ji doplní: na konci běhu pro každé
  `(connection_id, project_op_id)` bez řádku zavolá `GET /api/v3/projects/{id}` (GET-only, jednou,
  pak cache), a `getProjects()` dostane stránkování. Opraví to mezeru 2.
- Jeden resolver `resolveProjectRef(connectionId, projectOpId, titleFallback)` → `{op_id,
  identifier|null, name|null}` v duchu konsolidace (žádné další ad-hoc mapy `op_id→name`).
- ✅ jméno sedí s tím, co OP ukazuje u daného WP při posledním syncu; funguje i pro add-by-id;
  ✅ backfill zdarma. ⚠️ jméno je zdvojené (WP vs `project`) — po přejmenování se srovná při
  dalším full syncu.

**D2: čistě normalizovaně přes `project` tabulku.**
- Žádný nový sloupec na cache; jen opravit klíč na `connection:op_id`, stránkovat `/projects`
  a dofetchovat neznámé projekty v syncu.
- ✅ menší migrace. ⚠️ jméno závisí na tom, že dofetch proběhl; při 404 (archiv/práva) nemáme
  nic, dokud nevytáhneme title z `raw_json` za běhu (pomalejší, rozlezlé).

### D-freeze — zmrazené sprinty (doporučuji vždy, nezávisle na D1/D2)
- Migrace: `sprint_item.frozen_project_name`, `sprint_item.frozen_project_identifier` (NULL),
  zapisuje `freezeSprint` vedle existujícího `frozen_project_op_id`, `reactivate()` nuluje.
- Backfill již zmrazených sprintů: z cache, pokud řádek existuje, jinak z
  `ticket_baseline.raw_json` (title) + `project` (identifier). Neřešitelné → `null` („—").
- Sémantika: zmrazený sprint ukazuje **jméno platné při freeze** (rozšíření invariantu 10 —
  golden test: čísla *i projekt* identické před/po smazání cache). Nezmrazený sprint = živé.
- Čísla kapacity/closure se **nemění** — projekt je čistě popisný atribut, `CAPACITY_BAR_RULES.md`
  se netýká (kromě případného per-project součtu, viz F/C2 → nový invariant Σ).

### Volitelně: off-sprint
- `off_sprint_time_entry.project_op_id` + `project_name` z `_links.project` time entry.
  Off-sprint tickety jsou typicky *jiné projekty*, takže „kolik hodin šlo mimo sprint, na který
  projekt" je pro delivery managera asi nejcennější nová informace. Replace-on-refresh → stačí
  další update run, backfill netřeba.

### Zobrazení: identifier vs. jméno (průřezové rozhodnutí)
- **I1 — identifier** (`northwind`): krátký, odpovídá URL, co uživatel zná; vhodný do PDF a na kartu.
  Riziko: u projektů, kde nemáme `project` řádek (404), fallback na jméno.
- **I2 — jméno** (`Northwind Payments`): čitelnější pro management, ale delší.
- **I3 — kombinace (doporučuji):** web = jméno, identifier v tooltipu / druhém řádku;
  karta Boardu a PDF = identifier (úzké), v PDF legenda „identifier → jméno" pod tabulkou.

---

## Část 3 — Varianty po plochách

### Backlog (sloupec už existuje)
- **B1 (doporučuji):** sloupec ponechat, doplnit **řazení** (`SortKey "project"`), filtr přepnout
  z jména na klíč `connection_id:project_op_id` (label = jméno, při kolizi jmen + server),
  `filter-options.projects` z `uniqStr(name)` na `{key, name, identifier}`. Opraví mezery 1 a 5.
- **B2:** jako B1 + seskupení řádků podle projektu (collapsible group header). Víc UI práce,
  koliduje se stránkováním — nedoporučuji teď.

### Sprint Board (karta `WpCard`)
- **S1 (doporučuji):** malý neutrální badge s identifierem v `card-meta` (před statusem),
  tooltip = celé jméno. Karta je sdílená s backlog kandidáty → projekt se ukáže v obou sloupcích.
- **S2:** S1 + barva badge odvozená z hashe `connection:op_id` + **filtr projektu na Boardu**
  (obdoba person filtru z Inc. 33). ⚠️ barvy nesmí kolidovat s barvami kapacitního baru
  (`CAPACITY_BAR_RULES.md`) — proto navrhuji jen obrys/odstín šedé, nebo filtr bez barev.

### Closure (`ClosureStats.tsx`, `TicketEstimateLine`)
- **C1 (doporučuji):** do `TicketEstimateLine` přidat `project: ProjectRef | null`; per-ticket
  tabulka dostane sloupec „Project". Hodnota z frozen snapshotu / cache / baseline fallbacku.
- **C2:** C1 + nová sekce „Per project" (tickety, estimate, dev logged, total logged, delivered).
  ⚠️ nová agregace → nový invariant: **Σ přes projekty = Σ per_ticket** (+ test v §6), a pozor
  na `removed_mid_sprint` hodiny, které per_ticket nelistuje (lekce Inc. 35).

### Reports (`ReportsScreen.tsx`)
- **R1:** stejný sloupec v tabulce „Estimate vs. actual" (data už z C1 — zero extra backend).
- **R2:** R1 + „Per project" blok z C2 (jen pokud vybereš C2).

### PDF exporty (oba renderují HTML → Chromium)
Status PDF (`statusReport.ts` `ticketTableHtml`, 7 sloupců) a Report/Closure PDF
(`report.ts` „Per ticket", 8 sloupců).
- **P1 (doporučuji):** nový sloupec „Project" hned za `#`, obsah = identifier, `max-width ≈ 14ch`
  + `text-overflow: ellipsis`, `white-space: nowrap`; Subject si nechá zbytek. Pod tabulkou
  legenda „identifier — jméno" jen pro projekty, které se v PDF vyskytly. Když má sprint
  **jediný projekt**, sloupec vynechat a projekt uvést v hlavičce (úspora šířky).
- **P2:** místo sloupce **seskupit řádky podle projektu** (mezititulek s jménem + identifier,
  mezisoučet estimate/logged). Čitelnější pro DM, ale mění strukturu tabulek a mezisoučty =
  stejná Σ-invariantní práce jako C2.
- Off-sprint sekce v Report PDF: pokud zvolíš off-sprint rozšíření, přidat projekt k ticketům
  (nebo per-project součet off-sprint hodin).

---

## Část 4 — Hrubý plán incrementu

**Phase 0 — kontrakty** (`INCREMENT_40_CONTRACTS.md`): `ProjectRef` v `@osp/contracts`,
rozšíření `BacklogItem`/`SprintItemDetail` (`project_identifier`), `TicketEstimateLine.project`,
volitelně `OffSprintTicketEntry.project`; migrace; sémantika frozen vs live; Σ-invariant (pokud C2/P2).

**Phase 1 — paralelní specialisté (disjunktní adresáře):**
- A — `packages/db` + `packages/sync` + `op-client`: migrace + backfill, mapper `project_name`,
  stránkování `getProjects`, `getProject(id)` (GET), dofetch neznámých projektů na konci syncu,
  freeze zápis/nulování.
- B — `apps/api`: `resolveProjectRef` (connection-scoped, fallback cache → frozen → baseline
  raw_json → `null`), napojení do backlog / items-detailed / closureStats / report / statusReport,
  oprava kolize (mezera 1).
- C — `apps/web`: backlog sort+filtr klíčem, badge na kartě, sloupec v Closure/Reports.
- D — `fixtures` + `tests`: mock `GET /projects/{id}` + stránkování; scénář S22 „sprint přes
  2 projekty + přejmenování + 2 servery se stejným project id"; golden testy (frozen projekt
  po smazání cache, cross-server kolize, backfill z raw_json, Σ per project pokud C2).

**Phase 2 — integrace:** e2e (Playwright), regenerace obou PDF, **live-verify výhradně na
throwaway `osp_test_*` DB + ne-defaultním PORT** (guardrail z CLAUDE.md), read-only guard test
(nová OP volání musí být GET).

Odhad: D1 + D-freeze + B1 + S1 + C1 + R1 + P1 ≈ středně velký increment (podobný Inc. 33);
C2/P2/S2-filtr/off-sprint přidávají každý zhruba +20–30 %.

---

## Otázky k rozhodnutí

1. **Datový model:** D1 (jméno denormalizované na ticket + identifier z `project`) / D2 (čistě `project`)?
2. **Zobrazení:** I1 identifier / I2 jméno / I3 kombinace (web jméno, karta+PDF identifier)?
3. **Backlog:** B1 / B2? **Board:** S1 / S2 (s filtrem projektu)?
4. **Closure + Reports:** C1+R1 (sloupec) / C2+R2 (+ per-project souhrn)?
5. **PDF:** P1 (sloupec + legenda, při jediném projektu v hlavičce) / P2 (seskupení s mezisoučty)?
6. **Off-sprint projekt** zahrnout teď, nebo odložit?
7. Smím jedním GET dotazem ověřit payload na živé OP instanci (`/work_packages/<id>` + `/projects/<id>`)?
