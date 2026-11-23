# Chat UI Redesign, Upgraded Table View, Structure Inspection, and Agent Tool Polish Implementation Plan

> **For agentic workers:** REQUIRED SKILL: invoke the dispatch skill via the skill tool to implement this plan task-by-task. Execution is subagent-driven only: never execute inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship losql `v0.3.0` with an OpenCode-style Agent transcript (quote design on user messages only), a shared box-drawing Table `DataGrid`, on-demand Relation Structure inspection (Columns, Indexes, Constraints, Definition) with Leader shortcuts, reliable Driver/Agent Step fixes, refreshed landing media, GitHub Release binaries, and NixOS VPS deployment.

**Auto-approved:** auto-approve: true ("I approve design and plan")

**Architecture:** Keep the Schema snapshot lightweight. Load rich Relation details through an optional `Driver.describeRelation` method shared by Structure and Agent `describe`. Keep Structure state alongside the three Result views in the Results Pane and render its tables through the same `DataGrid` as Table. Verify the compiled TUI and inspect live screenshots before regenerating published media. Publish `v0.3.0` release assets from merged `master` before redeploying `losql.dev` on `nixos-vps`.

**Tech Stack:** Bun 1.3.9, TypeScript 5, SolidJS, OpenTUI (`@opentui/core`, `@opentui/solid`), SQLite (`bun:sqlite`), PostgreSQL (`postgres`), Node ESM landing builder.

Run the tasks in order. For each task, send the red tests through the `tester` seat (`opencode/opencode-go/deepseek-v4.1-flash`, `variant=high`), then dispatch implementation to Claude Opus 5.5 (`claudeAgent/claude-opus-5-5`, `effort=high`) per user request. After each task commit, run Stage 1 (spec compliance) then Stage 2 (code quality) sequentially via `task-reviewer` (`codex/gpt-6.2-sol`, `reasoningEffort=high`). `GLOSSARY.md` defines `Structure` and keeps `Result view` as Table, JSON, or Record.

---

## Task 1 — Driver Structure types and SQLite `describeRelation`

**Files**

- Create: `src/core/db/sqlite-ddl.ts`
- Modify: `src/core/db/types.ts`, `src/core/db/sqlite.ts`
- Test: `src/core/db/sqlite.test.ts`

**Glossary terms / seams preserved:** Driver, Relation, Schema snapshot. Keep the existing `Relation`, `RelationColumn`, `SchemaSnapshot` and `schema()` contracts. Existing Driver mocks continue to compile.

**Complexity flag:** `standard`
**Behavior-to-test flag:** `has_tests: true`

- [ ] **Step 1 — Failing test spec.** Reuse the per-test temporary file Driver in `sqlite.test.ts`. Create a composite parent key and a child with explicit and implicit references to it, including two FKs from one column. Assert ordered pairs, constraint names and actions, and empty unresolved target columns for an invalid or absent implicit target. Assert distinct representations for an absent default and `DEFAULT NULL`, and verify virtual and stored generated columns. Test a rowid-alias PK, `INTEGER PRIMARY KEY DESC`, a nullable ordinary composite PK, and a `WITHOUT ROWID` PK. Create named column and table checks, an unnamed check with nested parentheses and a quoted comma, a named UNIQUE constraint, and a standalone unique partial expression index. Assert key order, check definitions, index expression and predicate, and the standalone index's absence from UNIQUE constraints. Also check a quoted identifier, a `temp` Relation, a view's stored SQL, `null` for a missing Relation, and an already-aborted signal.
- [ ] **Step 2 — Run red.** `bun test src/core/db/sqlite.test.ts`
- [ ] **Step 3 — Implement.**
  - Add the spec's exported interfaces to `types.ts`: `RelationRef`, `RelationForeignKeyRef`, `RelationColumnDetail`, `RelationIndex`, `RelationConstraintKind`, `RelationConstraint`, and `RelationDetails`. Add `Driver.describeRelation?(ref: RelationRef, options?: { signal?: AbortSignal }): Promise<RelationDetails | null>`. Keep ordered PK positions 1-based and `references` on each detailed column an array. Use `undefined` for unavailable metadata and `[]` for confirmed empty lists.
  - In `openSqlite`, use `mainDb` so temporary objects and the current Session's schema are visible. Check the signal before catalog work. Match the namespace against `PRAGMA database_list`; return `null` for an absent namespace or Relation. Query the qualified `sqlite_schema` or `sqlite_temp_schema`, with a bound Relation name and a table/view filter. Quote namespace, Relation and index names with `quoteIdent` for PRAGMAs. Retain stored SQL as `definition`, and normalize database errors through `toQueryError`.
  - Read `table_xinfo`, exclude `hidden = 1`, convert numeric PRAGMA fields with `Number`, and preserve `dflt_value` when non-null. Use the generated expression when recognized and `VIRTUAL` or `STORED` as a fallback. Use `table_list` flags for `WITHOUT ROWID` and `STRICT`. A single declared `INTEGER` PK with no `origin = 'pk'` index is a rowid alias on a rowid table. Combine these facts with `notnull` to preserve SQLite's nullable ordinary PK behavior, including the inline `DESC` exception.
  - Group `foreign_key_list` by `id`, order groups by `id` and columns by `seq`, and resolve omitted target names from the parent's declared PK in the same namespace. Require a matching PK arity. Use `""` for unresolved positions and preserve the other positions. Populate the grouped constraint and each originating column's `references` with action names.
  - Read `index_list` and use `index_xinfo` ordered by `seqno`, retaining only `key = 1`. Use the matching parsed SQL term for `cid = -2`, `rowid` for `cid = -1` where present, and the PRAGMA name for ordinary key columns. Retain raw index SQL and partial predicate where available. Synthesize PK and UNIQUE constraints from ordered PK columns and `origin = 'u'` indexes, respectively.
  - Give `sqlite-ddl.ts` two entry points: `parseSqliteTableDdl(sql: string): { constraints: RelationConstraint[]; generated: Map<string, string> }` and `parseSqliteIndexDdl(sql: string): { terms: string[]; predicate?: string }`. Use `tokenize` from `../sql/lexer` and token offsets to split only on depth-one commas, preserve expression slices, and recognize optional `CONSTRAINT` names at the declaration's depth. Respect comments and quoted identifiers, including SQLite bracket quoting. Capture each `CHECK (...)`, with its declaring column for inline checks and an empty column list for table checks without a declared list. Match parsed PK, UNIQUE and FK names back to PRAGMA facts by kind and ordered source columns, and by target/actions for FKs. If matching is ambiguous or parsing fails, keep the PRAGMA-derived facts and stored SQL. Never turn an expression or unresolved target into a guessed column.
- [ ] **Step 4 — Run green.** `bun run typecheck && bun test src/core/db/sqlite.test.ts`
- [ ] **Step 5 — Commit.** `git add -- src/core/db/types.ts src/core/db/sqlite-ddl.ts src/core/db/sqlite.ts src/core/db/sqlite.test.ts && git commit -m "feat(db): describe SQLite relation structure"`

---

## Task 2 — PostgreSQL `side` queue and `describeRelation`

**Files**

- Modify: `src/core/db/postgres.ts`
- Test: `src/core/db/postgres.test.ts`

**Glossary terms / seams preserved:** Driver, Session, Run, Relation, Schema snapshot. Preserve the user connection's transaction state, loss reporting, and the read-only Run's rollback and cleanup.

**Complexity flag:** `complex`
**Behavior-to-test flag:** `has_tests: true`

- [ ] **Step 1 — Failing test spec.** Extend the `LOSQL_TEST_PG_URL`-gated suite inside its temporary schema (and add unit tests for the queue/parsers if Postgres is absent locally, while also running the live Postgres suite when available). Create a Relation with a composite PK, explicit and implicit composite FKs to a table in another namespace or a distinct Relation in the fixture schema, a named UNIQUE and CHECK, a generated column, a non-null default, and a column with no default. Assert ordered FK mappings and actions, PK positions, `format_type` output and default/generated separation. For `DEFAULT NULL`, assert the catalog representation, since PostgreSQL can normalize away the declaration. Assert expression and partial index terms, `INCLUDE` separation, index method, view and materialized view SQL, and missing Relation `null`. Add a queue case that overlaps a read-only Run with `schema()`, `describeRelation()` and a read-only Result containing an unseeded type such as `uuid[]`. Assert all complete with correct results. Use the suite's advisory-lock pattern or an explicit server-side wait to hold the first Run while aborting a queued describe. Verify the aborted waiter rejects before the holder releases, the next queued operation completes, and `close()` releases queued schema/describe callers with a closed-Session `QueryError`.
- [ ] **Step 2 — Run red.** `bun test src/core/db/postgres.test.ts` (with `LOSQL_TEST_PG_URL` set if available)
- [ ] **Step 3 — Implement.**
  - Generalize `readOnlyChain` and `acquireReadOnlyTurn` into `withSide<T>(operation: () => Promise<T>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>`. Enqueue synchronously, reject abandoned waiters promptly, and release an abandoned slot only after its predecessor settles. Release acquired slots in `finally`. Keep the original read-only timeout budget starting at the Run request and hold the slot through rollback, `reset all` and advisory unlock. Use `activeQueries` for waiting and executing cancellation. A public close or abort may reject promptly, but the queue must hold the slot until any started side work and cleanup settle. Check close and signal again before issuing follow-up queries.
  - Run all `schema()` queries inside one slot and preserve the close-interruption behavior. Run `resolveTypeNames(oids: number[], signal?: AbortSignal)` in its own short slot only for cache misses, rechecking the cache inside the slot. Resolve types after the read-only transaction slot has released. Keep `user` queries on their existing path.
  - Resolve the Relation with bound namespace/name parameters using `pg_class` joined to `pg_namespace` and `relkind IN ('r','p','v','m','f')`. Map `v` and `m` to `view`, and the remaining kinds to `table`. Preserve the existing lightweight snapshot projection and include foreign tables in its Relation list so they can be selected in the TUI.
  - Read `pg_attribute` in `attnum` order, omitting dropped and system attributes. Join `pg_attrdef` for `pg_get_expr`, use `attgenerated` to distinguish generation from a default, use `attnotnull` for nullability, and derive PK order from `unnest(indkey) WITH ORDINALITY` on the primary index's key entries.
  - Read indexes via `pg_index`, `pg_class` and `pg_am`. Enumerate `1..indnatts` with `pg_get_indexdef(indexrelid, pos, true)`, split at `indnkeyatts`, and include the full `pg_get_indexdef` and `pg_get_expr(indpred, indrelid)`. Read `p/u/f/c` constraints with `pg_get_constraintdef`. Join source and target attributes by the ordinal position in `conkey` and `confkey`, preserving ordered pairs. Map action codes `a/r/c/n/d` to `NO ACTION`/`RESTRICT`/`CASCADE`/`SET NULL`/`SET DEFAULT`. Use the mapped FK constraints to populate per-column references. Read `pg_get_viewdef(oid, true)` for views and materialized views.
  - Track cancellable catalog queries while they are executing and remove cancellation hooks in `finally`. Normalize failures through the Driver's existing `toQueryError(err, secrets)` path.
- [ ] **Step 4 — Run green.** `bun run typecheck && bun test src/core/db/postgres.test.ts`
- [ ] **Step 5 — Commit.** `git add -- src/core/db/postgres.ts src/core/db/postgres.test.ts && git commit -m "feat(db): serialize PostgreSQL side work and describe relations"`

---

## Task 3 — Agent Step payloads and tool advertisement

**Files**

- Modify: `src/core/agent/digest.ts`, `src/core/agent/loop.ts`, `src/core/agent/prompt.ts`
- Test: `src/core/agent/digest.test.ts`, `src/core/agent/loop.test.ts`, `src/core/agent/prompt.test.ts`

**Glossary terms / seams preserved:** Agent, Step, Statement, Buffer, Result, Schema snapshot. Keep the Provider action protocol and the authorization checks for read-only Runs.

**Complexity flag:** `standard`
**Behavior-to-test flag:** `has_tests: true`

- [ ] **Step 1 — Failing test spec.** Reuse `scripted()` and the demo Driver in `loop.test.ts`. Give `describeRelation` a stub that records refs and signal, enriches one Relation, returns `null` for a second, and throws a redaction-sensitive error in a separate Turn. Assert ordered sections and defaults, fallback text, exact signal forwarding, and another Provider invocation after the failed Step. In `digest.test.ts`, retain the existing bounded-work test and add mixed-case names, an unknown name and hostile tags/control characters in rich SQL fields. Assert the same relation and character budgets. For `query`, assert the Statement sent to `driver.run` appears in success and execution error payloads. Assert truncation for omitted columns alone, oversized string or serialized JSON cells, omitted rows and Driver truncation, and no truncation at the exact cell cap. Test ASCII and astral error input, with and without URL credentials, against `MAX_AGENT_ERROR`. In `prompt.test.ts` assert action and rule presence independently for buffer-only, results-only, both and neither. Extend the schema-mode loop test to check that the prompt omits `read_results` even when the dependency exists.
- [ ] **Step 2 — Run red.** `bun test src/core/agent/digest.test.ts src/core/agent/loop.test.ts src/core/agent/prompt.test.ts`
- [ ] **Step 3 — Implement.**
  - Keep `describeRelations(schema: SchemaSnapshot, names: string[]): string` for existing synchronous callers. Share its bounded, case-insensitive resolver and formatter with `describeRelationsWithDetails(schema: SchemaSnapshot, names: string[], load: (ref: RelationRef) => Promise<RelationDetails | null>, signal?: AbortSignal): Promise<string>`. Resolve only the first `MAX_DESCRIBE_RELATIONS` inputs in input order, reuse a lookup for duplicate refs in one Step, and check for abort before each load. Fall back to snapshot columns for `null` or an absent Driver method. Render rich columns, then `indexes:` and `constraints:` when those lists are available. Sanitize identifier fields through `sanitizeIdentifier` and clean SQL expression text as untrusted data before applying the existing `MAX_DESCRIBE_CHARS` budget. Preserve prompt closing-tag escaping.
  - In the `runAgent` describe branch, call the optional Driver method through a closure to preserve its receiver. Catch failures and emit `{ error: sanitizeAgentError(message) }` as the normal Step payload. Let the next loop iteration honor Turn cancellation.
  - In `executeQueryStep`, pass `statements[0]!.text` to `driver.run` and to `formatBoundedResultPayload`. Add the same bounded Statement to errors caught around the Run. Preserve existing payloads for early schema-only and invalid-Statement refusals. In `formatBoundedResultPayload`, mark `truncated` if the Driver flag is set, rows or columns were dropped, or any included cell's string/serialized JSON exceeded `MAX_AGENT_CELL`. Count Unicode code points, reserve one for `…`, and preserve scalar types. Apply the same bounded code-point behavior to `sanitizeAgentError` after redaction.
  - Replace `hasWorkspaceTools` with optional, default-false `hasReadBuffer` and `hasReadResults` inputs to `buildPrompt`. Compute them in `runAgent` with `Boolean(deps.readBuffer)` and `Boolean(deps.readResults) && deps.config.dataAccess !== "schema"`. Emit each action and its rule independently. Keep the existing runtime guards.
- [ ] **Step 4 — Run green.** `bun run typecheck && bun test src/core/agent/digest.test.ts src/core/agent/loop.test.ts src/core/agent/prompt.test.ts`
- [ ] **Step 5 — Commit.** `git add -- src/core/agent/{digest,loop,prompt}.ts src/core/agent/{digest,loop,prompt}.test.ts && git commit -m "fix(agent): improve describe and bound workspace Step payloads"`

---

## Task 4 — Agent transcript, Proposal cards and scroll status

**Files**

- Modify: `src/tui/panes/agent/transcript-model.ts`, `src/tui/panes/agent/ProposalCard.tsx`, `src/tui/panes/agent/Transcript.tsx`, `src/tui/panes/agent/AgentPane.tsx`, `src/tui/context/agent.tsx`
- Test: `src/tui/panes/agent/transcript-model.test.ts`, `src/tui/panes/agent/agent.test.tsx`

**Glossary terms / seams preserved:** Agent, Turn, Step, Proposal, Leader. Preserve Proposal selection, acceptance, explicit Run and yank behavior, SQL highlighting and wrapping, and following the bottom of the Conversation.

**Complexity flag:** `standard`
**Behavior-to-test flag:** `has_tests: true`

- [ ] **Step 1 — Failing test spec.** Extend the Turn fixtures and existing `mount`/Provider-fixture tests. Assert user padding and `┃  ` in the rendered character frame, and assert every Agent label, Step, prose, running status, SQL and hint row has no quote chrome (`┃`). Assert the blank row between Steps and prose, and check that a failed describe's Step uses the error foreground. Use captured spans for Proposal header accent/bold and selected SQL background. Deselect or switch Proposals and assert styling moves. Verify fenced SQL has an inset and base surface with no header or hint. Mount with `leader: ","`, render a settled error Turn, change the Leader with `app.api.config.set`, and assert cached advice changes while the Turn object remains the same. On a scrollable transcript, assert `app.api.status.current().position` is `bot` at the bottom, a positive `line/total` after scrolling up, and empty when the transcript fits.
- [ ] **Step 2 — Run red.** `bun test src/tui/panes/agent/transcript-model.test.ts src/tui/panes/agent/agent.test.tsx`
- [ ] **Step 3 — Implement.**
  - In `transcript-model.ts`, keep `max(1, W - 3)` for user card text. Use `W` for Agent prose and `stepSummary()`, which already emits its own `▸` prefix. Add a Step `tone: "muted" | "error"` based on structured Step errors, and render failed `describe` summaries with their error. Add a blank after the final Step only when prose follows. Add a `proposal-header` line with `proposalId`. Use an inset of two cells at `W >= 12`, otherwise zero, and share `max(1, W - inset)` between SQL wrapping and card rendering. Keep the SQL row cap, continuation marker and proposal ownership for overflow rows.
  - Extend `ProposalCardLine` to take `kind: "header" | "sql" | "hint"`, `inset: number`, and `selected: boolean`. Render a plain inset, then the card surface. Use `backgroundElement` normally and `selection` when selected. Render `SQL Proposal` in muted text and `▸ SQL Proposal` in bold accent when selected. Use accent for the selected footer and retain `highlightSqlCardRows` for SQL. Render fenced SQL through the same SQL row renderer with `selected=false`. Keep `┃` exclusively in Transcript's user branch and render Agent status as spinner, space and shimmer at column zero.
  - Extend the model's advice and Turn formatting functions with a defaulted `leader = "space"` argument. Add a Leader prop to `Transcript` and include it in the per-Turn cache key. Use the actual `keyLabel(keys, leader)` signature from `src/tui/ui/key-label.ts`. Read the reactive config in `AgentPane` and in the Agent context's Provider setup error, and use that formatter for the `m` and `p` references.
  - Add `TranscriptHandle.scrollPosition(): { effectiveScrollTop: number; maxScroll: number; totalLines: number }` backed by the current viewport accessors. In `AgentPane`, keep the exposed handle reactive and clear it on Transcript disposal. Render `""` when `maxScroll === 0`, `bot` at the bottom, otherwise `${effectiveScrollTop + 1}/${totalLines}`. Include the Proposal header in the existing scroll-to-Proposal range.
- [ ] **Step 4 — Run green.** `bun run typecheck && bun test src/tui/panes/agent/transcript-model.test.ts src/tui/panes/agent/agent.test.tsx`
- [ ] **Step 5 — Commit.** `git add -- src/tui/panes/agent/{transcript-model.ts,transcript-model.test.ts,ProposalCard.tsx,Transcript.tsx,AgentPane.tsx,agent.test.tsx} src/tui/context/agent.tsx && git commit -m "feat(tui): redesign Agent transcript and Proposal cards"`

---

## Task 5 — Shared `DataGrid` and Table view fixes

**Files**

- Create: `src/tui/panes/results/DataGrid.tsx`
- Modify: `src/tui/panes/results/grid-model.ts`, `src/tui/panes/results/ResultGrid.tsx`, `src/tui/panes/results/ResultsPane.tsx`
- Test: `src/tui/panes/results/grid-model.test.ts`, `src/tui/panes/results/results.test.tsx`, `src/tui/cells.frames.test.tsx`

**Glossary terms / seams preserved:** Result, Result view, Record, Transparent. Preserve cursor, selection, yank and search behavior. Keep Result animation in `ResultGrid` and make `DataGrid` independent of `Result`.

**Complexity flag:** `standard`
**Behavior-to-test flag:** `has_tests: true`

- [ ] **Step 1 — Failing test spec.** In `grid-model.test.ts`, test exact-fit slots, separator alignment, a cursor column wider than the viewport, widths `0`, `1`, `7` and `8`, heights `0` through `3`, both overflow flags and cursor visibility after scrolling in either direction. Assert the slot total stays within the input width with wide Unicode values. In rendered `mount` tests, use `fixed()` for boolean, JSON, null and numeric values. Assert grid chrome and styles from spans, including an unpainted unselected row in Transparent mode and the selection and flash colors. Mount `DataGrid` with plain columns and rows and assert it reports the resulting viewport. On the first animated frame of a truncated Result, assert no `first 0 rows`; enter Record from JSON, invoke Record again, and assert `q` restores JSON. Update `cells.frames.test.tsx` assertions that encode pre-change Table spacing to verify rendered terminal-cell geometry with the new chrome.
- [ ] **Step 2 — Run red.** `bun test src/tui/panes/results/grid-model.test.ts src/tui/panes/results/results.test.tsx src/tui/cells.frames.test.tsx`
- [ ] **Step 3 — Implement.**
  - Export `GridColumn { name: string; align?: "left" | "right" }` from `grid-model.ts`. Retarget `columnWidths` to a structural `{ columns: readonly GridColumn[]; rows: readonly Cell[][] }` input compatible with existing Result callers. Keep 200-row sampling, `MAX_COLUMN_WIDTH = 40`, and bounded `fitCell`/`fitCells` rendering.
  - Extend `Viewport` with `slots: { column: number; valueWidth: number; padding: 0 | 1 }[]`, `divider: boolean`, and `leftOverflow`/`rightOverflow` booleans, retaining `firstRow`, `rowCount`, `firstColumn` and `columns`. At width >= 8 reserve two edge cells, charge `valueWidth + 2` per slot and one cell per interior separator, and advance the first column until the cursor is visible. Clamp an oversized first slot to the usable budget. At widths `1..7`, render only the cursor column, with padding if width allows at least one content cell and zero padding otherwise. At width zero render no slots. At height >= 3 use `height - 2` data rows with a divider, otherwise `max(0, height - 1)` without one. Pad unused space before the right indicator to keep it at the edge.
  - Define `DataGrid` props as `columns`, `rows`, `cursor: { row: number; column: number }`, `selectedRows: { start: number; end: number } | null`, `flash: FlashSpec | null`, optional `fadeT: number`, and optional `onViewport(vp: Viewport, boxHeight: number): void`. Move `FlashSpec` into `DataGrid` and re-export its type from `ResultGrid` for current callers. Render headers, separators and rule from the same slots. Paint the header with `backgroundElement`, names in bold `text`, chrome in `borderSubtle`, and overflow indicators in a muted accent. Leave unselected body rows unpainted, paint selected rows across the full line, and make flash take precedence over cell selection. Use muted `∅`, `syntaxKeyword` booleans, right-aligned numeric columns and bounded JSON highlighting. Preserve the existing flash text contrast.
  - Derive the viewport in a memo and report it from `createEffect`, using measured dimensions and the previous scroll origin. In the thin `ResultGrid` wrapper, keep the existing 200 ms fade, calculate numeric column alignment with `isNumericColumn`, and reset scroll origin by remounting the grid on Result identity change. Use actual `Viewport.rowCount` for Table half-page motion. In `ResultsPane`, display the actual row count when a nonempty truncated Result's animation is at zero. Update `returnView` only on a non-Record -> Record transition, including the Table Enter path.
- [ ] **Step 4 — Run green.** `bun run typecheck && bun test src/tui/panes/results/grid-model.test.ts src/tui/panes/results/results.test.tsx src/tui/cells.frames.test.tsx`
- [ ] **Step 5 — Commit.** `git add -- src/tui/panes/results/{grid-model.ts,grid-model.test.ts,DataGrid.tsx,ResultGrid.tsx,ResultsPane.tsx,results.test.tsx} src/tui/cells.frames.test.tsx && git commit -m "feat(tui): render Results through a shared DataGrid"`

---

## Task 6 — Relation Structure, Commands and Leader navigation

**Files**

- Create: `src/tui/panes/results/StructureView.tsx`, `src/tui/panes/results/structure.test.tsx`
- Modify: `src/tui/panes/results/ResultsPane.tsx`, `src/tui/panes/schema/SchemaPane.tsx`, `src/tui/context/session.tsx`, `src/tui/app.tsx`, `src/tui/workspace.tsx`, `src/tui/ui/keymenu.tsx`, `src/tui/ui/help.tsx`
- Test: `src/tui/panes/results/structure.test.tsx`, `src/tui/panes/results/results.test.tsx`, `src/tui/panes/schema/schema.test.tsx`, `src/tui/ui/commands.test.tsx`

**Glossary terms / seams preserved:** Structure, Relation, Session, Result, Result view, Pane, Command, Leader. Keep Structure out of `ResultView`, `session.shown()`, and Agent `read_results`.

**Complexity flag:** `complex`
**Behavior-to-test flag:** `has_tests: true`

- [ ] **Step 1 — Failing test spec.** Use `mount`, `app.press`, `app.resize`, `app.frame`, and `app.waitFor` in the new integration test. From Schema, use `S` on a Relation and its child column before any Run, and assert the expected banner and focused Results Pane. Check `:inspect orders`, qualified names, a missing explicit name, `<leader> v s`, `:view structure`, and picker selection, preselection and dismissal. Peek with Schema Enter, then invoke Structure from Results and assert it uses that Relation. Run an arbitrary Statement and verify a subsequent no-arg invocation opens the picker. Verify section wrap and `1`–`4`, grid motion past the viewport, full-value detail and yank, `R` reload, and both `q` and `Esc` restoring the prior view/focus and the same shown outcome object. Assert each `v t/j/r` route exits Structure into the named Result view. Use `deps.openSession` overrides with deferred `describeRelation` promises to verify abort and late-completion guards on target switch, exit and Session replacement, plus a same-Session refresh after a drop. Assert fallback metadata is shown as unavailable, distinct from empty lists. In `commands.test.tsx`, mount a small terminal, exercise `[`, `]` and OpenTUI `pageup`/`pagedown` via `app.setup.mockInput`, and assert the footer, page clamping on resize, reset on submenu entry and direct prefix execution from another page. Open Help under a custom Leader and assert both the Global label and Structure shortcuts.
- [ ] **Step 2 — Run red.** `bun test src/tui/panes/results/structure.test.tsx src/tui/panes/results/results.test.tsx src/tui/panes/schema/schema.test.tsx src/tui/ui/commands.test.tsx`
- [ ] **Step 3 — Implement.**
  - In `SessionApi`, expose `sessionId(): number`, `schemaRevision(): number` and `previewRelationRef(): RelationRef | null`. Add `previewRelationRef?: RelationRef` to `RunRequest`. Advance Session identity when the underlying Driver changes, including reconnect and teardown, and advance the schema revision when the latest refresh commits for that Driver. Set provenance alongside the shown successful peek outcome. Clear it on a new shown arbitrary Run, a failed peek, direct `show()` replacement, or Session change. Hidden Runs leave displayed provenance alone. Pass the ref from Schema's `runPeek`.
  - Add `SchemaApi.selectedRelation(): RelationRef | null`. For relation/column rows return their shared namespace and parent Relation name, and return `null` for a namespace. Add `onInspect?: (ref: RelationRef) => void` to `SchemaPane`, invoke it on uppercase `S`, and thread it through `Workspace` to the Results API. Keep Enter's peek behavior.
  - Add `ResultsApi.inspect(ref: RelationRef): void` and `structure(): StructureState | null`. Give `StructureState` the spec's `ref`, `status`, `details`, `error?` and `section`, with `StructureSection = "columns" | "indexes" | "constraints" | "definition"`. Save the prior `ResultView` and `PaneId` on first entry. Ref changes while Structure is open retain that original return target. On `q`/`Esc`, abort, restore the prior Result view and focus, and leave the shown outcome intact. Existing explicit Result view Commands close Structure and select the requested view in Results. Append a mouse-activatable Structure label using the same Command as keyboard activation.
  - In `app.tsx`, register `view.structure` with `group: "View"`, `keys: "v s"` and `ex: ["inspect"]`. Route `:view structure` through it from `view.set`. Resolve an explicit argument against the latest snapshot, preferring exact match before case-folded match, using namespace and name for qualified input, and reporting unknown or ambiguous names through Command errors. For no argument, use Schema's selection when focused there, then shown peek provenance when Results is focused, otherwise open `DialogApi.select<RelationRef>()`. Build picker options from the snapshot with qualified titles and pass the matching option's actual `value` object as `current` for identity-based preselection. Share this picker with `c` in Structure. On picker return, verify Session identity and the originating Structure instance before applying the selection.
  - Keep the load controller and monotonically increasing request ID in `ResultsPane`. Capture the Session ID and Driver at load time. Abort and invalidate on target switch, explicit exit, Session replacement and disposal. Accept a completion only if its request ID, Session ID and Driver are current. Re-fetch on `R` and a committed schema refresh for the same Session. On refresh keep the active section if it still exists. Map `null` to `Relation no longer exists — press c to pick another`. Redact and render Driver errors through safe text. When a Driver omits `describeRelation`, use the snapshot's column facts with indexes, constraints and definition unavailable.
  - Render Structure with `StructureView` inside Results. Show the Relation name, kind, available counts and `c switch  q back`. Use `DataGrid` directly for `Column | Type | Null | Default | Key`, `Name | Flags | Columns | Method | Where`, and `Name | Type | Columns | Definition`. Format composite key positions, FK target and actions, and included index columns. Show an empty or unavailable message when appropriate. Use `Highlighted` for Definition and a scrollable full-cell detail region toggled by Enter. Show Definition only when present. Keep an independent clamped grid cursor and Definition scroll position, resetting on section or target change. Route `Tab`/`Shift+Tab`, `1`–`4`, `h/j/k/l`, arrows, `gg`/`G`, `0`/`$`, `Ctrl+d`/`Ctrl+u`, `c`, `R`, `y`, `q` and `Esc` through the Results Pane's key handler while Structure is active. Copy the raw cell value or full definition through the existing clipboard dependency. Apply flash only after a successful copy that still belongs to the current target and section.
  - In `keymenu.tsx`, reserve one footer row on overflow and calculate page capacity from the remaining row count and existing column count. Page the rendered slice, keep lookup on the full current node list, and honor registered direct keys from any page. Clamp after resize and reset on open, submenu entry and back. Use renderer key names `pageup`/`pagedown` with `[`/`]` aliases and a `page X/Y · PgUp/PgDn` footer. In `help.tsx`, replace the static Global `space` label with the configured Leader, reuse `keyLabel("v s", leader)`, and document `S`, `:inspect`, `:view structure`, section switching, navigation, refresh, picker, detail, yank and back.
- [ ] **Step 4 — Run green.** `bun run typecheck && bun test src/tui/panes/results/structure.test.tsx src/tui/panes/results/results.test.tsx src/tui/panes/schema/schema.test.tsx src/tui/ui/commands.test.tsx`
- [ ] **Step 5 — Commit.** `git add -- src/tui/panes/results/{StructureView.tsx,ResultsPane.tsx,structure.test.tsx,results.test.tsx} src/tui/panes/schema/{SchemaPane.tsx,schema.test.tsx} src/tui/context/session.tsx src/tui/{app.tsx,workspace.tsx} src/tui/ui/{keymenu.tsx,help.tsx,commands.test.tsx} && git commit -m "feat(tui): inspect Relation structure from Results"`

---

## Task 7 — Release source checks and live TUI verification

**Files**

- Modify: `scripts/release.ts`, `scripts/verify-tui.sh`
- Test: `scripts/release.test.ts`

**Glossary terms / seams preserved:** Relation, Structure, Result view, Leader. Keep `package.json` canonical and use the existing tmux fixtures and `expect` helpers.

**Complexity flag:** `standard`
**Behavior-to-test flag:** `has_tests: true`

- [ ] **Step 1 — Failing test spec.** Extend the existing release fixtures with `landingBuild` text containing the generated `llms.txt` install line, README installer URL, and two versioned HTML install links. Assert valid sources pass, any stale URL gives the corresponding path-specific failure, a missing `llms.txt` pin gives a specific failure, and bump updates every matched pin plus the badge, JSON-LD and footer. Make the live repository consistency test compare against the current package version. In the tmux script, add scenarios for `S` on `orders`, Columns/Indexes/Constraints switching, `q` from Schema entry and JSON Results entry, and `Space v s` on the shown peek. Assert active content such as the `customer_id` column, empty indexes message and `FOREIGN KEY` row, since section labels are visible regardless of selection. Add a separate launch with an isolated custom-Leader config and no Provider, trigger `:ask` with text, and assert its setup advice displays the configured Provider shortcut.
- [ ] **Step 2 — Run red.** `bun test scripts/release.test.ts`
- [ ] **Step 3 — Implement.**
  - Add `landingBuild: string` to `VersionSources`, include it in `readRepoSources`, and return its updated value from `bumpVersionSources`. Use the existing raw GitHub installer URL pattern for README, HTML and the `llms.txt` source literal. Verify every occurrence per file and require at least one. Update each version using a replacement callback that preserves surrounding source, then write `landing/build.mjs` from the CLI bump branch. Update CLI usage. Keep the changelog requirement and validate the source set before writing.
  - Make `verify-tui.sh` assert the new scenarios with the existing `keys`, `screen`, `expect` and `expect_re` helpers. Restrict content checks to the Results Pane where ambiguity is possible, and keep the custom Leader launch scoped to a separate config directory within the script's temp workspace. Adjust any existing matching patterns that assume columns are separated by spaces alone.
- [ ] **Step 4 — Run green.** `bun run typecheck && bun test scripts/release.test.ts && bash -n scripts/verify-tui.sh && bun run release:check && bun run verify:tui`. Also capture & visually inspect live PNG screenshots of Agent, Table, and Structure in opaque and Transparent themes from `./losql` in tmux.
- [ ] **Step 5 — Commit.** `git add -- scripts/release.ts scripts/release.test.ts scripts/verify-tui.sh && git commit -m "test(release): verify installer pins and Structure workflows"`

---

## Task 8 — Regenerate media and prepare `v0.3.0`

**Files**

- Create: `landing/public/media/structure.webp`, `readme/structure.webp`
- Modify: `landing/scripts/capture-media.ts`, `landing/src/index.html`, `landing/build.mjs`, `README.md`, `CHANGELOG.md`, `package.json`
- Regenerate: `landing/public/media/manifest.json`, the existing 12 static WebPs, the four animated WebP/GIF pairs, and their existing non-Omarchy README mirrors
- Test: `landing/tests/landing.test.ts`, `landing/tests/media.test.ts`

**Glossary terms / seams preserved:** Agent, Turn, Proposal, Result view, Structure, Transparent. Keep the compiled binary capture path, fixture Provider, real SQLite reads, and existing accessible tour controls.

**Complexity flag:** `standard`
**Behavior-to-test flag:** `has_tests: true`

- [ ] **Step 1 — Failing test spec.** In `landing.test.ts`, extend the deterministic DOM tour check to ten stops. Verify the Structure tab's `aria-controls`, panel label, `/media/structure.webp` and shortcut, and keyboard traversal through the new panel. Assert the built asset exists and `llms.txt` emits the `v0.3.0` installer URL. Update repository-version expectations for the hero, clipboard command, footer and JSON-LD. Use `media.test.ts`'s RIFF/dimension, manifest SHA-256 and README parity checks for `structure.webp`. Keep historical `0.2.0` test fixtures that exercise old releases.
- [ ] **Step 2 — Run red.** `bun test landing/tests/landing.test.ts landing/tests/media.test.ts`
- [ ] **Step 3 — Implement.**
  - In `capture-media.ts`'s existing isolated demo Session, prepare a named index and CHECK on a deterministic Relation with defaults and an FK. Use `:inspect <relation>` to enter Structure, wait for the Relation banner and nonzero index and constraint counts, and capture the Columns section as `structure`. Create or alter only the capture Session's demo database. Run capture after the existing Agent and Result interactions or restore their prior focus, so the other screenshots keep their intended workflow. Add `structure` to the static list and workflow-tour sequence. Keep animated WebP and GIF generation, and hash the encoded files for the manifest. Use the checked-in fonts when no external `CAPTURE_FONT_SOURCE` is supplied, and preserve the current explicit Chromium/Playwright overrides.
  - Add `structure` to `landing/build.mjs`'s required static media. Append a Structure stop using `tour-stop-tab-9` and `tour-stop-panel-9` with the same ARIA pairing, zoom button, image dimensions and keyboard support as existing stops. Update landing and README copy to explain the clearer Agent transcript, Table grid and Structure inspection. Add a README image and document Schema `S`, `<leader> v s`, `:inspect`, and the section and back keys.
  - Run `bun run release bump 0.3.0` after the landing and README source edits. Add a dated `## [0.3.0]` changelog section covering Structure, the Table grid, Agent transcript and Driver/Agent fixes. Then run `bun landing/scripts/capture-media.ts` so the manifest tracks the compiled `0.3.0` binary. Inspect the new Structure image and regenerated Agent/Table assets before staging them.
- [ ] **Step 4 — Run green.** `bun run typecheck && bun test landing/tests/landing.test.ts landing/tests/media.test.ts && bun run release:check && bun run check && bun run landing:build && bun run verify:tui`. Check `./losql --version` reports `0.3.0` and the built page and `llms.txt` carry the same installer pin.
- [ ] **Step 5 — Commit.**

  ```bash
  git add -- landing/scripts/capture-media.ts landing/src/index.html landing/build.mjs \
    landing/tests/{landing,media}.test.ts README.md CHANGELOG.md package.json \
    landing/public/media/manifest.json \
    landing/public/media/{hero,editor,agent,json,record,structure,zoom,providers,themes,menu,onboarding,omarchy,omarchy-transparent}.webp \
    landing/public/media/{workflow-tour,recording-vim,recording-agent,recording-omarchy}.{webp,gif} \
    readme/{hero,editor,agent,json,record,structure,zoom,providers,themes,menu,onboarding}.webp
  git commit -m "chore(release): prepare losql v0.3.0 and refresh tour media"
  ```

---

## Release and deployment after merge (post-Phase 7)

- [ ] Run Phase 4 (Verify), Phase 5 (PR), Phase 6.5 (CI), Phase 6 (Council), and Phase 7 (Land/merge to `master`).
- [ ] Fetch `origin/master`, verify `0.3.0` on `master`, tag `v0.3.0` and push `refs/tags/v0.3.0` to trigger `.github/workflows/release.yml`.
- [ ] Verify GitHub Release `v0.3.0` publishes `losql-linux-x64.tar.gz`, `losql-linux-arm64.tar.gz`, `losql-darwin-x64.tar.gz`, `losql-darwin-arm64.tar.gz`, `SHA256SUMS.txt` and `install.sh`, and smoke-test the installer with `--version v0.3.0`.
- [ ] Run `nix flake update losql` and `just deploy` in `/home/dennis/work/nixos-vps` and verify `https://losql.dev` (200 OK, Structure stop, `/media/structure.webp`, `/llms.txt`, `v0.3.0` install command).
