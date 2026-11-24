# Chat UI Redesign, Upgraded Table View, Structure Inspection, and Agent Tool Polish

auto-approve: true ("I approve design and plan")

## Overview

This design covers four cohesive improvements for `losql` `v0.3.0`:

1. **OpenCode-style Agent Transcript**: Only user turns use the left-barred quote card (`┃` + `backgroundElement`). Agent responses render in clean document flow without a quote bar, with crisp hierarchy for Steps, prose, errors, and selectable SQL Proposal cards.
2. **Upgraded Table Rendering (`DataGrid`)**: Crisp box-drawing column separators (`│`), a header rule (`─`/`┼`), cell horizontal padding, horizontal overflow indicators (`‹`/`›`), refined semantic cell styling (numbers, `∅`, booleans, JSON), and full transparent-mode compatibility — shared across both query Results and Structure tables.
3. **Dedicated Relation Structure View + Leader Shortcuts**: Inspect any Relation's **Columns**, **Indexes**, **Constraints**, and **Definition** (SQLite & PostgreSQL) in a dedicated Structure mode inside the Results Pane, reachable from Schema (`S`), the Leader menu (`<leader> v s`), `:inspect [relation]`, and `:view structure`, plus leader-menu paging and config-aware key labels.
4. **Agent Tool & Driver Reliability Fixes**: Upgrade `describe` to include defaults, indexes, and constraints; guard `describe` errors in the Agent loop; include executed SQL `statement` in `query` results; decouple `read_buffer`/`read_results` tool advertisement; fix cell-truncation signaling and error-length off-by-one; serialize PostgreSQL `side` client operations to eliminate schema/read-only-tx races.

After implementation and live screenshot verification, landing page and README media will be regenerated, `v0.3.0` released with macOS & Linux binaries via GitHub Releases, and `losql.dev` redeployed on `nixos-vps`.

---

## Assumptions

- Design and implementation plan are explicitly pre-approved by the user (`auto-approve: true`).
- PR merge, GitHub release binary publishing (`v0.3.0` for Linux and macOS `x64`/`arm64`), and NixOS VPS redeployment of `losql.dev` are explicitly requested after verification and council consensus.
- Structure inspects one Relation at a time in the active Session, works even before any SQL Run has occurred, and supports tables and views in both SQLite and PostgreSQL.
- `nixos-vps` deployment follows the documented workflow (`docs/specs/2026-11-16-losql-landing-page-design.md`): merge PR to `master`, publish `v0.3.0` release assets first so the version-pinned install command works immediately, then run `nix flake update losql` and `just deploy` in `/home/dennis/work/nixos-vps`.

---

## Architectural Approaches Considered

| Approach | Trade-offs |
| --- | --- |
| **A. Fourth Result view + enriched `SchemaSnapshot`** | Reuses `ResultView` tabs directly and caches all metadata upfront. Pollutes `Table → JSON → Record` `Tab` cycling, forces guessing a Relation for arbitrary join Results, and loads indexes/constraints for every table on every schema refresh. |
| **B. Full-screen modal overlay + on-demand `describeRelation`** | Keeps schema refresh lightweight and provides wide space. Introduces a parallel modal focus/sizing/navigation stack outside Pane zoom and Results chrome. |
| **C. Structure mode in the Results Pane + hybrid introspection (Recommended)** | Reuses the upgraded `DataGrid`, Pane focus, zoom, and status bar while keeping `Table → JSON → Record` cycling untouched. `SchemaSnapshot` stays fast for the Schema tree and Agent digest; optional `Driver.describeRelation` loads full metadata on demand for both Structure and Agent `describe`. Requires explicit mode entry/exit and stale-load guards. |

**Chosen Approach: C (auto-approved).** It delivers a native, zoomable, vim-navigable multi-table Structure workspace inside the Results Pane without penalizing schema refresh or muddying query-result cycling, and gives the TUI and Agent `describe` tool a single per-Driver introspection source of truth.

---

## Detailed Design

### 1. Chat / Agent Transcript UI (`src/tui/panes/agent/`)

**Visual layout:**

```text
┃
┃ Show revenue by customer
┃

Agent
▸ describe  customers, orders
▸ query     8 rows · 12 ms

Ada leads in total revenue across three orders.

  SQL Proposal
  SELECT name, SUM(total) AS revenue
  FROM customers c
  JOIN orders o ON o.customer_id = c.id
  GROUP BY c.id
  enter accept   r run   y yank
```

- **User messages (quote design kept exclusively here):**
  - Keep `backgroundElement` surface, `┃` left bar in `secondary`, 2-space inset after `┃` (1 visual cell gutter + space), and top/bottom padding rows (`pad: true`).
  - Wrap budget: `max(1, W - 3)` where `W` is the measured transcript inner width.
- **Agent messages (normal OpenCode-style design — NO `┃` left quote bar):**
  - Remove `"┃ "` from `label`, `text`, `step`, `status`, `sql`, and `hint` rows.
  - Label row: `Agent` in `primary` (`TextAttributes.BOLD`), rendered flush at column 0.
  - Step rows: compact `▸ <action>  <summary>` flush at column 0 in `textMuted` (using `error` foreground if the step payload represents an error). Width budget accounts for the actual marker prefix.
  - Blank line between the last Step row and Agent prose (when both exist) for breathing room.
  - Prose lines: normal `text` (or `error` / `textMuted`), wrapping at full width `W`.
  - Running indicator (`status` line): flush at column 0 with `<Spinner />` + space + `<Shimmer />` (`thinking…` / `running a query…`).
  - **SQL cards (`ProposalCard.tsx`):**
    - Indented by 2 spaces (`inset = W >= 12 ? 2 : 0`) with `backgroundElement` surface and syntax highlighting (`highlightSqlCardRows`). Wrap width is `max(1, W - inset)`.
    - Actionable Proposals display a crisp compact header row (`SQL Proposal` in `textMuted`, or `▸ SQL Proposal` in `accent` bold when selected) and a footer hint row (`enter accept  r run  y yank` in `textMuted`, or `accent` when selected).
    - When selected (`props.selectedProposalId === proposalId`), the Proposal header uses `accent` bold and the SQL card rows use a subtle selection surface (`selection` or `backgroundElement` + accented left indicator pill — specifically `backgroundColor={props.selected ? theme.color("selection") : theme.color("backgroundElement")}` — NO `┃` quote bar!). Fenced SQL inside prose uses the same 2-space inset and `backgroundElement` without the Proposal header, selection highlight, or action hints.
- **Leader-aware advice & scroll indicator:**
  - Replace hardcoded `space m` / `space p` in `transcript-model.ts`, `AgentPane.tsx`, and `agent.tsx` with formatted `keyLabel(leader, "m")` / `keyLabel(leader, "p")`.
  - Include the configured `leader` in `Transcript.tsx`'s per-Turn cache key so changing `config.leader` immediately re-renders advice lines.
  - Expose scroll position (`effectiveScrollTop`, `maxScroll`, `totalLines`) from `Transcript` to `AgentPane` so the Agent status line shows scroll position when scrollable (e.g. `12/40` or `bot`), matching Schema and Results conventions.

---

### 2. Upgraded Table Rendering (`src/tui/panes/results/DataGrid.tsx` & `grid-model.ts`)

**Visual layout:**

```text
  customer    │   revenue │ paid  │ details   ›
 ─────────────┼───────────┼───────┼───────────
  Ada         │    129.50 │ true  │ {"tier":…}
  Grace       │         ∅ │ false │ ∅
```

- **Shared `DataGrid` component (`src/tui/panes/results/DataGrid.tsx`):**
  - Accepts generic `columns: readonly GridColumn[]` (`{ name: string; align?: "left" | "right" }`), `rows: readonly Cell[][]`, `cursor`, `selectedRows`, `flash`, `fadeT`, and `onViewport`.
  - `ResultGrid.tsx` becomes a thin wrapper around `DataGrid` handling `Result` fade animation, `isNumericColumn` alignment, and passing `result.columns`/`result.rows`.
  - `StructureView.tsx` reuses `DataGrid` directly for its **Columns**, **Indexes**, and **Constraints** tables without synthesizing fake `Result` objects.
- **Box-drawing chrome & slot math (`grid-model.ts`):**
  - Each visible column occupies `w + 2` cells (` ` + fitted value of width `w` + ` `).
  - Interior separators between adjacent visible columns occupy 1 cell (`│` in header & data rows, `┼` in divider row) colored `borderSubtle`.
  - Header divider row: 1 row beneath the header row rendered with `─` across each column slot (`w + 2` chars) and `┼` at each interior separator, colored `borderSubtle`.
  - When viewport height `< 3` rows, omit the divider row so at least 1 header + 1 data row remain visible (`maxDataRows = height >= 3 ? height - 2 : Math.max(0, height - 1)`).
  - Edge overflow indicators: reserve 1 cell on the left edge and 1 cell on the right edge when `width >= 8`; display `‹` (in `accent`/`textMuted`) when `firstColumn > 0` and `›` when `lastVisibleCol < colCount - 1` (spaces otherwise, so columns stay aligned on a single slot grid). On narrow widths (`width < 8`), drop indicators and clamp the single visible cursor column to `width`.
  - Always ensure the cursor column fits in the viewport; if a single column exceeds the remaining viewport width, clamp its rendered cell width to fit without overflow.
  - Keep `MAX_COLUMN_WIDTH = 40`, 200-row intrinsic width sampling, and Unicode-safe `fitCells`/`cutCells`.
- **Visual styling & Transparent-mode safety:**
  - Header row: `backgroundElement` background (preserving transparent pane readability), column names in `text` with `TextAttributes.BOLD`, interior `│` in `borderSubtle`.
  - Data rows: no forced opaque row background on unselected rows (so `transparent: true` stays clean); cursor cell uses `selection` bg, flashed cells use `primary` bg, selected rows (`V`) use `selection` bg across the row.
  - Semantic cell foregrounds: `null` (`∅`) in `textMuted`; `boolean` (`true`/`false`) in `syntaxKeyword` (or `info`); `number` right-aligned in `text` (or `syntaxNumber` when not flashed); JSON objects via `<Highlighted language="json" />`.
  - Fix `ResultGrid` minor bugs found during scouting: move `props.onViewport` notification out of `createMemo` into `createEffect`; keep `summaryText` from showing `first 0 rows` on frame 0; only record `returnView` when entering `record` from a non-record view.

---

### 3. Dedicated Relation Structure View & Hybrid Driver Introspection

#### 3.1 Driver & Domain Types (`src/core/db/types.ts`)

Add additive, backwards-compatible types:

```ts
export interface RelationRef {
  namespace: string;
  name: string;
}

export interface RelationForeignKeyRef {
  namespace?: string;
  relation: string;
  column: string;
  constraintName?: string;
  onUpdate?: string;
  onDelete?: string;
}

export interface RelationColumnDetail {
  name: string;
  type: string;
  nullable: boolean;
  /** Raw SQL default expression; undefined means no default declared, "NULL" means explicit DEFAULT NULL. */
  defaultValue?: string;
  /** 1-based position in PRIMARY KEY, undefined if not part of PK. */
  primaryKeyPosition?: number;
  /** Generated column expression or kind if applicable. */
  generated?: string;
  /** All foreign key references originating from this column (supports multiple FKs). */
  references: RelationForeignKeyRef[];
}

export interface RelationIndex {
  name: string;
  unique: boolean;
  primary: boolean;
  /** Ordered key columns or expressions. */
  columns: string[];
  /** Optional INCLUDE columns (PostgreSQL). */
  includedColumns?: string[];
  /** Index access method (e.g. btree, gin, gist) when available. */
  method?: string;
  /** Partial index WHERE predicate when present. */
  predicate?: string;
  /** Raw CREATE INDEX / pg_get_indexdef definition when available. */
  definition?: string;
}

export type RelationConstraintKind = "PRIMARY KEY" | "UNIQUE" | "FOREIGN KEY" | "CHECK";

export interface RelationConstraint {
  name?: string;
  kind: RelationConstraintKind;
  columns: string[];
  /** Human-readable constraint expression / SQL definition when available. */
  definition?: string;
  /** Structured FK target when kind === "FOREIGN KEY". */
  references?: {
    namespace?: string;
    relation: string;
    columns: string[];
    onUpdate?: string;
    onDelete?: string;
  };
}

export interface RelationDetails {
  namespace: string;
  name: string;
  kind: "table" | "view";
  columns: RelationColumnDetail[];
  /** undefined means metadata unavailable (e.g. fallback driver); [] means confirmed none. */
  indexes?: RelationIndex[];
  /** undefined means metadata unavailable; [] means confirmed none. */
  constraints?: RelationConstraint[];
  /** Stored CREATE TABLE/VIEW SQL (SQLite) or pg_get_viewdef (PostgreSQL). */
  definition?: string;
}
```

Extend `Driver`:
```ts
describeRelation?(ref: RelationRef, options?: { signal?: AbortSignal }): Promise<RelationDetails | null>;
```
Returns `null` when the relation does not exist. Existing `SchemaSnapshot`, `Relation`, and `RelationColumn` remain untouched so all existing consumers and mock drivers stay compatible.

#### 3.2 SQLite Introspection (`src/core/db/sqlite.ts` + helper `src/core/db/sqlite-ddl.ts`)

- Validate relation exists via `sqlite_schema` (or `sqlite_temp_schema` if `namespace === "temp"`) for `type IN ('table', 'view')`, retrieving stored `sql`. Return `null` if absent.
- **Columns:** `PRAGMA "<ns>".table_xinfo("<name>")` gives `name`, `type`, `notnull`, `dflt_value`, `pk` (1-based PK order), `hidden` (2 = virtual generated, 3 = stored generated). Account for `INTEGER PRIMARY KEY` rowid alias, `WITHOUT ROWID`, and SQLite's nullable non-rowid PK quirk cleanly (`nullable = col.notnull === 0 && !isImplicitlyNotNullPk`).
- **Foreign keys:** `PRAGMA "<ns>".foreign_key_list("<name>")` grouped by `id`, sorted by `seq`. When `to` is null (omitted target column list), resolve against the referenced table's declared PK columns in order (leaving unresolved column empty/marked rather than silently corrupting composite non-PK targets). Populate both `column.references` and `FOREIGN KEY` constraints (including `on_update`/`on_delete`).
- **Indexes:** `PRAGMA "<ns>".index_list("<name>")` + `PRAGMA "<ns>".index_xinfo("<index>")` (key columns `key === 1`, expression marker `cid === -2`, `unique`, `origin`: `pk`/`u`/`c`, `partial`). Fetch stored `CREATE [UNIQUE] INDEX` SQL from `sqlite_schema` for `definition`, partial `WHERE` predicate, and expression key terms via a small balanced-parenthesis SQL token helper (`sqlite-ddl.ts`, reusing `src/core/sql/lexer.ts`!).
- **Constraints:** Synthesize `PRIMARY KEY` from ordered `pk > 0` columns, `UNIQUE` from `origin === 'u'` indexes (distinct from standalone `CREATE UNIQUE INDEX` with `origin === 'c'`), `FOREIGN KEY` from `foreign_key_list`, and extract named/unnamed `CHECK (...)` expressions (both column-level and table-level) plus constraint names from stored `CREATE TABLE` SQL via `sqlite-ddl.ts`. If DDL parsing encounters unexpected syntax, keep all PRAGMA-derived facts and preserve `definition`.

#### 3.3 PostgreSQL Introspection (`src/core/db/postgres.ts`)

- Serialize all `side` client operations (`run` read-only transactions, `schema()`, `describeRelation()`, and `resolveTypeNames()`) through a single exclusive `side` queue so concurrent `schema()` / `describeRelation()` calls can never interleave into an active read-only transaction or inherit its `SET LOCAL statement_timeout`.
- Acquire the queue slot once per operation; release the read-only transaction's slot before calling `resolveTypeNames()` (which acquires its own short slot only on cache miss) to avoid reentrancy deadlock. Honor `AbortSignal` and `close()` cleanly, always releasing waiters in `finally`.
- **`describeRelation(ref, options)`**: Run parameterized catalog lookups by `(nspname, relname)` -> OID (`relkind IN ('r', 'p', 'v', 'm', 'f')`):
  - Columns: `pg_attribute` + `format_type(a.atttypid, a.atttypmod)` + `pg_get_expr(ad.adbin, ad.adrelid)` for default/generated + `pg_index` (`indisprimary`) for 1-based PK order.
  - Indexes: `pg_index` + `pg_class` + `pg_am` (`amname`), `pg_get_indexdef(i.indexrelid)` (and `pg_get_indexdef(i.indexrelid, pos, true)` for ordered key & included columns using `indnkeyatts`), `pg_get_expr(i.indpred, i.indrelid)` for partial predicate.
  - Constraints: `pg_constraint` (`contype IN ('p', 'u', 'f', 'c')`), `pg_get_constraintdef(c.oid, true)`, pairing `conkey` and `confkey` by ordinality with `confrelid` namespace/name and `confupdtype`/`confdeltype` action labels (`CASCADE`, `RESTRICT`, `SET NULL`, `SET DEFAULT`, `NO ACTION`).
  - Views/Matviews: `pg_get_viewdef(oid, true)` as `definition`.

#### 3.4 Structure UI & Navigation (`src/tui/panes/results/StructureView.tsx` & `ResultsPane.tsx`)

- **Results Pane mode:** `ResultsPane` adds an explicit `structureMode` state holding `{ ref: RelationRef; status: "loading" | "ready" | "missing" | "error"; details: RelationDetails | null; error?: string; section: StructureSection }` plus `returnView` and `returnFocus` (so `q`/`Esc` restores the previous Result view and focus cleanly without losing the underlying query `Result` or breaking Agent `read_results`).
- **Header strip:** `RESULTS` + `Table  JSON  Record  Structure` (clicking/activating `Structure` highlights `Structure` in `primary` bold; `Tab` in Results cycles `Table → JSON → Record` as before, while inside Structure `Tab`/`Shift+Tab` switches sections!).
- **Structure layout inside Results Pane:**
  1. **Relation Banner row:** Qualified relation name (`public.orders` or `orders`), kind badge (`table` / `view`), and compact summary counts (`5 cols · 3 idx · 2 constraints`) plus `c switch  q back`.
  2. **Section Tab Strip:** `Columns (N)` · `Indexes (N)` · `Constraints (N)` · `Definition` (shown when `definition` exists). Active section highlighted in `primary` bold.
  3. **Section Content:**
     - **Columns** (`DataGrid`): `Column | Type | Null | Default | Key` (`PK` / `PK(1)`, `FK -> target.col`).
     - **Indexes** (`DataGrid`): `Name | Flags | Columns | Method | Where` (`PK` / `UNIQUE`, comma-joined key cols + `(inc: ...)` if present).
     - **Constraints** (`DataGrid`): `Name | Type | Columns | Definition` (`PRIMARY KEY`, `UNIQUE`, `FOREIGN KEY`, `CHECK`, with target + `ON DELETE`/`ON UPDATE` or check expression).
     - **Definition**: Syntax-highlighted SQL (`Highlighted` / scrollable lines) showing the `CREATE TABLE` / `CREATE VIEW` SQL.
  4. **Full-text detail preview / yank:** `Enter` in a Structure table shows the full untruncated cell/definition in a compact bottom detail bar (or toggles expanded cell view), and `y` copies the selected cell (or full definition in Definition section) to clipboard with flash feedback.
  5. **Navigation inside Structure:** `Tab`/`Shift+Tab` (and `1`/`2`/`3`/`4`) switch sections; `h/j/k/l` & arrows & `gg`/`G`/`0`/`$`/`Ctrl+d`/`Ctrl+u` navigate the active section grid; `c` opens the Relation picker overlay; `R` refreshes the relation structure; `q`/`Esc` exits Structure mode and restores prior Result view & focus.
  6. **Stale-load & Session safety:** Track a monotonic request ID + active Session ID. Switching target, closing Structure, or changing Session aborts the in-flight `AbortController` and ignores late resolutions. On `session.refreshSchema()`, if Structure is open, re-fetch the active Relation (showing a clean "Relation no longer exists — press `c` to pick another" state if dropped).
  7. **Schema preview provenance:** Track `previewRelationRef` when Schema Pane `Enter` runs `runPeek`; clear it when the user runs an arbitrary Editor statement.

---

### 4. Leader Menu, Commands & Keyboard Shortcuts

| Shortcut / Ex | Command ID | Group | Behavior |
| --- | --- | --- | --- |
| `<leader> v t` / `:view table` | `view.table` | `View` | Exit Structure if active, switch to Table Result view |
| `<leader> v j` / `:view json` | `view.json` | `View` | Exit Structure if active, switch to JSON Result view |
| `<leader> v r` / `:view record` | `view.record` | `View` | Exit Structure if active, switch to Record Result view |
| `<leader> v s` / `:view structure` / `:inspect [relation]` | `view.structure` | `View` | Inspect Relation structure: (1) if argument given, resolve in Schema snapshot; (2) else if Schema pane is focused, inspect selected Relation (or parent Relation of selected column); (3) else if Results is showing a Schema preview, inspect its provenance Relation; (4) else open Relation picker overlay (preselecting last inspected Relation if any). Focuses Results pane in Structure mode. |
| `S` (in Schema pane) | Pane key | Schema | Inspect selected Relation (or parent Relation of selected column) in Structure mode immediately. (`Enter` remains row peek.) |

- **Leader Menu (`src/tui/ui/keymenu.tsx`):** When items exceed the visible grid capacity, support `PgDn`/`PgUp` (and `]`/`[`) paging with a visible `page X/Y · PgUp/PgDn` footer instead of opaque `… N more`, while keeping all direct key prefixes executable from any page.
- **Help Overlay (`src/tui/ui/help.tsx`):** Replace hardcoded `space` leader prefix with `config.config().leader` via `keyLabel`, and document Schema `S`, `<leader> v s`, `:inspect`, and Structure keys (`Tab`/`1-4`, `c`, `y`, `q`).

---

### 5. Agent Tool & Loop Improvements (`src/core/agent/`)

1. **Enriched `describe` tool (`digest.ts` & `loop.ts`):**
   - Resolve requested relation names against `SchemaSnapshot` as today.
   - When `deps.driver.describeRelation` exists, load `RelationDetails` for each matched relation (up to `MAX_DESCRIBE_RELATIONS`, respecting `deps.signal`) and render columns (type, `not null`, `default ...`, `primary key`, `references ...`), `indexes:` (name, unique/primary, columns, method, where), and `constraints:` (name, kind, columns, definition) under the existing `MAX_DESCRIBE_CHARS` budget and `sanitizeIdentifier` / untrusted-data sanitization.
   - Fall back to `SchemaSnapshot` columns when `describeRelation` is absent or returns `null`.
   - Wrap `describe` step execution in `try/catch` inside `loop.ts` so a driver error yields `{ error: sanitizeAgentError(...) }` instead of crashing `runAgent`.
2. **`query` step payload (`loop.ts`):**
   - Pass the executed `sql` statement to `formatBoundedResultPayload(result, sql)` and include `statement: cutAtCodePoint(sql, MAX_AGENT_SQL_CHARS)` in sanitized execution error payloads, matching `read_results`.
3. **Cell truncation signaling & error cap (`loop.ts`):**
   - In `formatBoundedResultPayload`, set `truncated: true` if `result.truncated` OR rows/columns were omitted OR any cell exceeded the 200-char cap.
   - In `sanitizeAgentError`, reserve 1 char for `…` so the returned string is strictly `<= MAX_AGENT_ERROR` code points (redacting before truncating).
4. **Independent workspace tool advertisement (`prompt.ts` & `loop.ts`):**
   - Replace single `hasWorkspaceTools` with `hasReadBuffer: boolean` and `hasReadResults: boolean` (where `hasReadResults` is `Boolean(deps.readResults) && deps.config.dataAccess !== "schema"`). Advertise each action and rule independently in `buildPrompt`, keeping runtime guards in `loop.ts`.

---

### 6. Landing Page, Screenshots, Release & NixOS VPS Deployment

- **Live TUI verification & screenshots:**
  - Extend `scripts/verify-tui.sh` with scenarios covering Structure entry from Schema (`S`), Structure via `<leader> v s`, section switching (`Columns`/`Indexes`/`Constraints`), return to prior Result view (`q`), and custom leader key advice.
  - Run `./losql` interactively in tmux, capture PNG screenshots of the updated Chat UI, upgraded Table view, and Structure view (opaque + transparent themes), and visually inspect them to confirm polish.
- **Landing page & README media (`landing/` & `README.md`):**
  - Update `landing/scripts/capture-media.ts` to build `./losql`, capture a new `structure.webp` screenshot (showing a rich demo table with columns, indexes, and constraints), regenerate `hero.webp`, `agent.webp`, `zoom.webp`, `editor.webp`, `json.webp`, `record.webp`, `menu.webp`, `themes.webp`, `providers.webp`, `onboarding.webp`, `omarchy*.webp`, and animated WebPs (`workflow-tour`, `recording-vim`, `recording-agent`, `recording-omarchy`), update `manifest.json`, and mirror non-omarchy shots to `readme/*.webp`.
  - Update `landing/src/index.html` to include a dedicated **Structure** stop in the interactive tour (referencing `media/structure.webp` with keyboard shortcut `<leader> v s` / `S`) and update copy highlighting the OpenCode-style agent chat, crisp table grid, and schema/index/constraint inspector.
  - Add `media/structure.webp` to `landing/build.mjs` required assets, and update `README.md` tour/keys sections.
- **Release `v0.3.0` & `llms.txt` sync (`scripts/release.ts`, `landing/build.mjs`, `CHANGELOG.md`):**
  - Extend `scripts/release.ts` (`checkVersionSources` and `bumpVersionSources`) to validate and bump the pinned version URL inside `landing/build.mjs` (`llms.txt` install line) alongside `package.json`, `README.md`, and `landing/src/index.html`.
  - Bump version to `0.3.0`, add `## [0.3.0]` section to `CHANGELOG.md`, run `bun run release:check`, `bun run check`, `bun run landing:build`.
  - After PR passes CI, council review, and merges to `master`:
    1. Tag merged `master` commit `v0.3.0` and push tag to trigger `.github/workflows/release.yml` (cross-compiling Linux `x64`/`arm64` and macOS `x64`/`arm64` + `SHA256SUMS.txt` + `install.sh` onto GitHub Releases).
    2. Verify GitHub Release `v0.3.0` contains all 4 OS/arch tarballs + `SHA256SUMS.txt` + `install.sh` and smoke-test the pinned installer command.
    3. Redeploy `losql.dev` from `/home/dennis/work/nixos-vps` (`nix flake update losql` + `just deploy`) and verify `https://losql.dev` serves the updated page, `structure.webp`, `llms.txt`, and `v0.3.0` install command.

---

## Glossary Updates

Update `GLOSSARY.md` (`Editing and running` section) to add:
- **Structure**: The inspection of one Relation's columns, indexes, constraints and available definition in the Results Pane.

Keep **Result view** defined as `Table`, `JSON` or `Record`.

---

## Testing & Verification Strategy

1. **Unit & Component Tests (`bun test`)**:
   - `transcript-model.test.ts` & `agent.test.tsx`: verify `┃` quote bar renders ONLY on `user` rows, never on `label`/`text`/`step`/`status`/`sql`/`hint`; verify Proposal selection styling, custom leader advice & cache invalidation, and Agent scroll status.
   - `grid-model.test.ts` & `results.test.tsx`: verify box-drawing `│`/`─`/`┼` slot math, narrow-width degradation (`< 3` rows, `< 8` cols), edge `‹`/`›` overflow indicators, transparent-mode safety, and `DataGrid` reuse.
   - `sqlite.test.ts` & `postgres.test.ts`: test `describeRelation` with composite PKs, composite FKs (explicit and implicit target columns), defaults (including `DEFAULT NULL` vs none), named/unnamed `CHECK` constraints, unique constraints vs standalone unique indexes, partial & expression indexes, included columns (Postgres), views/matviews, missing relations (`null`), and interleaved concurrent `schema()` + `describeRelation()` + read-only `run()` on Postgres.
   - `structure.test.tsx` / `results.test.tsx` / `schema.test.tsx`: test `S` from Schema (on relation & column), `<leader> v s`, `:inspect [relation]`, `:view structure`, Relation picker, section switching, `q`/`Esc` return to prior view/focus, no-result entry, stale-load abort, and dropped-relation handling.
   - `commands.test.tsx` / `keymenu` / `help`: verify `PgUp`/`PgDn` paging in `keymenu.tsx`, direct prefix execution across pages, and config-driven leader labels in Help.
   - `loop.test.ts`, `digest.test.ts`, `prompt.test.ts`: verify enriched `describe` output + `try/catch` error handling, `query` `statement` inclusion, `truncated: true` on 200-char cell truncation, `sanitizeAgentError <= MAX_AGENT_ERROR`, and independent `hasReadBuffer`/`hasReadResults`.
   - `scripts/release.test.ts` & `landing/tests/`: verify `llms.txt` version check/bump, new `structure.webp` asset & tour tab, manifest validity, and built landing output.
2. **End-to-End TUI & Visual Verification**:
   - `bun run verify:tui` (extended `scripts/verify-tui.sh`)
   - Live interactive tmux + screenshot visual review (Chat UI, Table view, Structure view in opaque & transparent themes).
3. **Post-Merge Release & Live Site Verification**:
   - Verify GitHub Actions `release.yml` succeeds and GitHub Release `v0.3.0` exposes Linux & macOS (`x64`/`arm64`) binaries + checksums.
   - Verify `https://losql.dev` HTTP 200, updated `v0.3.0` install command, `llms.txt`, and `media/structure.webp`.
