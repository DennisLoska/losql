# losql v2: a vim-first agentic SQL client

Date: 2026-11-11 · Branch: `feat/agentic-sql-client` · Status: awaiting design approval (Gate 1)

Terms in capitals (Connection, Session, Buffer, Statement, Run, Result, Provider, Agent, Turn, Step, Proposal, Pane, Command) are defined in `GLOSSARY.md`. Decisions with lasting consequences are recorded in `docs/adr/0001` to `0004`.

## 1. Summary

losql becomes a terminal SQL client in the spirit of lazysql and harlequin with two differences: every Pane is driven by vim grammar, and an Agent can inspect the database and draft SQL for you. The Agent needs no API key; it drives a coding CLI you already have installed (Claude Code, Codex, OpenCode or Antigravity).

You can write SQL yourself in a modal editor with syntax highlighting, or ask the Agent for it. A Result is shown as a navigable table, as highlighted JSON, or as a single Record. SQLite and Postgres are supported. The look follows opencode: Tokyo Night by default, the live Omarchy theme when present, optional transparency, and animated transitions.

### What exists today

About 1,500 lines of Bun + OpenTUI 0.1.66 + Solid. `main.ts` starts an HTTP server on port 3000 that the TUI calls with `fetch`; the only database path is Bun's `sql` with `DATABASE_URL`, so Postgres only. There is a 971-line vim textarea (normal, insert, visual, visual-line; no counts, text objects, search or command line), Results are JSON in a second textarea, the SQL grammar is downloaded from a URL at startup, and there are no tests.

## 2. Goals and non-goals

Goals:

1. Write and run SQL with a real vim editing model.
2. Ask an Agent to write, explain, fix and optimize SQL, with read-only access to the schema and data.
3. Show a Result as Table, JSON or Record, with syntax highlighting for SQL and JSON.
4. Support SQLite and Postgres behind one Driver interface.
5. Look and feel like opencode: theme tokens, split borders, dialogs, toasts, leader key menu, animations; transparent and opaque.
6. First-run onboarding that connects a database, sets up a Provider, and picks a look.
7. A test suite that covers core logic, UI components and the command line end to end.

Non-goals for this version:

- Editing cells in place or staging row changes.
- Exporting a Result to a file (yank to clipboard is in scope).
- Databases other than SQLite and Postgres; SSH tunnels; more than one Session at a time.
- Vim macros, marks, block-visual mode, `:s` substitution, folds.
- Remapping keys other than the Leader.
- An LSP, a SQL formatter, mouse-driven workflows (the mouse only scrolls and focuses).
- Windows.

## 3. Approaches considered

**A. In-process core with a thin TUI, Agent as a losql-owned loop over a Provider CLI (chosen).** Remove the HTTP server. Put database, SQL, vim, theme, config and Agent logic in plain modules under `src/core` that take their dependencies as arguments. The TUI and the headless commands are two front ends over that core. The Agent sends a Provider one self-contained prompt per Step and reads back one JSON action; losql runs the queries.

**B. Keep the client/server split.** A daemon owns the database and the Agent, the TUI is a client. This allows remote use and other front ends, but adds a wire protocol, a second lifecycle and a port for no present need. Rejected (ADR 0001).

**C. Let the Provider run the loop, with losql exposed over MCP or ACP.** More autonomy and native streaming, but MCP is configured four different ways, ACP ships natively in only two of the four CLIs, the CLI's own file and shell tools stay available, and the loop can no longer be bounded or tested by losql. Rejected for now (ADR 0002); the Provider interface leaves room to add it.

Three further choices follow from A:

- **Highlighting:** a hand-written SQL lexer instead of tree-sitter, because the same lexer is needed to split and classify Statements, and it works offline and synchronously (ADR 0004).
- **Postgres:** postgres.js instead of Bun's client, for column metadata and cursors (ADR 0003).
- **Vim:** a pure engine behind a small text-buffer interface, so the grammar is unit-tested without a renderer and reused by the editor, the JSON view and the Agent input.

## 4. Architecture

```
src/
  main.ts                 parse argv, then run a headless command or start the TUI
  cli/                    argument parsing; exec, ask, providers, help, version
  core/                   no UI imports; every module takes its dependencies as arguments
    paths.ts config.ts state.ts fuzzy.ts clipboard.ts
    db/                   types, connection parsing, sqlite driver, postgres driver, demo data, formatting
    sql/                  lexer, statements, classify, json tokenizer, completion
    vim/                  keys, text-buffer interface, in-memory buffer, engine
    theme/                tokens, resolver, built-in themes, omarchy loader
    agent/                provider adapters, detection, process runner, protocol, prompt, loop
    commands/             command registry, ex-command parser
  tui/
    app.tsx               providers, layout, onboarding or workspace
    context/              theme, config, focus and keymap, dialogs, toasts, session, agent
    motion/               tween, spring, shimmer (injectable clock)
    ui/                   dialog, select, prompt, confirm, toast, spinner, logo, statusline, cmdline, key menu
    panes/                editor, results, schema, agent
    dialogs/              connections, provider, model, theme, history, help
    onboarding/
```

Rules:

- `src/core` never imports from `src/tui` or `@opentui/*`. `src/tui` never talks to a database or spawns a process directly; it calls core.
- One process, no server, no port, no network access at startup.
- Tests sit next to the code as `*.test.ts(x)`; end-to-end tests live in `test/e2e`.

Dependencies: `@opentui/core` and `@opentui/solid` 0.8.4 (from 0.1.66), `solid-js` 1.9.17, `postgres` 4.x. Bun 1.3.9 or newer; verified that 0.8.4 renders, tests and compiles to a single binary on 1.3.9.

## 5. Core modules

### 5.1 Config and state

`$XDG_CONFIG_HOME/losql/config.json` (default `~/.config/losql`), written atomically with mode 0600:

```json
{
  "theme": "tokyonight",
  "mode": "dark",
  "transparent": false,
  "animations": true,
  "leader": "space",
  "connections": [{ "name": "dev", "url": "postgres://app:${PGPASSWORD}@localhost:5432/dev" }],
  "results": { "maxRows": 1000, "jsonMaxRows": 200, "peekRows": 100 },
  "agent": { "provider": "claude", "model": null, "dataAccess": "rows", "maxSteps": 8, "stepTimeoutMs": 120000 }
}
```

- Every key is optional. An invalid value falls back to its default and produces a warning shown as a toast; a malformed file never prevents startup and is never overwritten without the user changing a setting.
- Unknown keys are preserved when saving.
- `${NAME}` in a connection URL is replaced from the environment when the Connection is opened, so passwords need not be stored.
- User themes are read from `$XDG_CONFIG_HOME/losql/themes/<name>.json`.

`$XDG_STATE_HOME/losql/` (default `~/.local/state/losql`):

- `state.json`: `onboarded`, `lastConnection`, last Provider test results.
- `history.jsonl`: one line per Run (`ts`, `connection`, `sql`, `ok`, `rows`, `ms`), capped at 5,000 lines.
- `buffers/<connection-id>.json`: open Buffers, restored on the next start.

`LOSQL_CONFIG_DIR` and `LOSQL_STATE_DIR` override both directories (used by tests). `LOSQL_NO_ANIMATIONS=1` forces animations off.

### 5.2 Database

```ts
type Dialect = "sqlite" | "postgres"

interface Connection { id: string; name: string; dialect: Dialect; url: string; display: string }

interface Column { name: string; type: string }
type Cell = null | boolean | number | string | JsonObject | JsonArray

interface Result {
  columns: Column[]
  rows: Cell[][]
  truncated: boolean        // more rows existed than maxRows
  affected: number | null   // for statements that return no rows
  command: string           // SELECT, UPDATE, CREATE TABLE ...
  durationMs: number
}

interface RunOptions { maxRows?: number; readOnly?: boolean; timeoutMs?: number; signal?: AbortSignal }

interface Driver {
  readonly connection: Connection
  run(statement: string, options?: RunOptions): Promise<Result>
  schema(): Promise<SchemaSnapshot>
  close(): Promise<void>
}

class QueryError extends Error { code?: string; position?: number; detail?: string; hint?: string }

interface SchemaSnapshot { dialect: Dialect; namespaces: { name: string; relations: Relation[] }[] }
interface Relation { name: string; kind: "table" | "view"; columns: RelationColumn[] }
interface RelationColumn { name: string; type: string; nullable: boolean; primaryKey: boolean; references?: { relation: string; column: string } }
```

`parseConnection(input)` accepts:

- `postgres://` and `postgresql://` URLs, including `sslmode`.
- `sqlite:<path>`, `sqlite:///abs/path`, `file:<path>`, `:memory:`, and a bare path to an existing file.
- `demo`, an in-memory SQLite database seeded with `customers`, `products`, `orders` and `order_items` (fixed data, so tests and screenshots are stable).

`display` never contains a password. `openSession(connection)` returns a Driver or throws a `QueryError` with a message fit to show the user.

Behaviour common to both Drivers:

- `run` executes exactly one Statement. Values are normalized to JSON-safe Cells: integers beyond 2^53 and numerics become strings, timestamps become ISO-8601 strings, `json`/`jsonb` become objects, binary becomes a `\x` hex string.
- At most `maxRows` rows are returned; `truncated` says whether more existed. The Driver stops reading rather than loading everything.
- `readOnly: true` is enforced by the database, not by inspecting the SQL.
- Aborting `signal` cancels the Run where the Driver can.

SQLite (`bun:sqlite`):

- Runs in-process. `iterate()` is used so the row cap stops the scan early.
- Read-only Runs use a second handle opened with `readonly: true`; for in-memory databases the same handle is bracketed with `PRAGMA query_only`.
- A path that does not exist is an error unless the caller passes `create`.
- Schema comes from `sqlite_schema`, `pragma table_info` and `pragma foreign_key_list`.
- Known limits, shown in the README: a long-running Statement blocks the interface and cannot be cancelled, and duplicate output column names collapse to one column. The Driver interface is asynchronous so this can move to a worker later without touching callers.

Postgres (postgres.js):

- One connection for the user's Runs, so `BEGIN`, `SET` and temp tables persist between Runs. A second connection serves read-only Runs and schema reads, so the Agent never disturbs an open transaction.
- Row cap through a cursor. Read-only Runs execute inside `BEGIN TRANSACTION READ ONLY` with `SET LOCAL statement_timeout`, then roll back.
- `QueryError.position` carries the server's error position so the editor can mark it.
- Schema comes from `information_schema` and `pg_catalog`, excluding system schemas.

### 5.3 SQL

```ts
type TokenKind = "keyword" | "identifier" | "quotedIdentifier" | "string" | "number" | "comment"
               | "operator" | "punctuation" | "function" | "type" | "parameter" | "whitespace"
interface Token { kind: TokenKind; start: number; end: number }

tokenize(text: string): Token[]                       // total: never throws, covers every character
splitStatements(text: string): Statement[]            // { start, end, text }, empty statements dropped
statementAt(text: string, offset: number): Statement | null
classify(statement: string): "read" | "write" | "ddl" | "transaction" | "other"
tokenizeJson(text: string): JsonToken[]               // key, string, number, boolean, null, punctuation
complete(text: string, offset: number, schema: SchemaSnapshot | null): { from: number; items: CompletionItem[] }
```

- The lexer understands line and block comments, single-quoted strings with doubled quotes, `E''` strings, dollar-quoted strings, double-quoted and backtick identifiers, numbers, and `$1`, `?`, `:name` parameters. An unterminated string or comment extends to the end of the text.
- A semicolon inside a string, comment or dollar-quoted body does not end a Statement.
- `statementAt` returns the Statement containing the offset. In the gap between two Statements, or after the last one, it returns the preceding Statement; before the first it returns the first; in a text with no Statement it returns `null`.
- `classify` is advisory. It decides whether a confirmation is shown and lets the Agent reject an obviously wrong action early. Enforcement is the Driver's `readOnly`.
- `complete` offers keywords, Relation names, column names (only that Relation's columns after `name.` or a known alias), and words already in the Buffer, filtered by the prefix under the cursor.

### 5.4 Vim engine

```ts
interface TextBuffer {
  lineCount(): number
  line(row: number): string
  text(): string
  setText(text: string): void
  cursor(): Position
  setCursor(position: Position): void
  replace(range: Range, text: string): void
  setSelection(range: Range | null, linewise?: boolean): void
}

class VimEngine {
  constructor(buffer: TextBuffer, options?: {
    readOnly?: boolean
    clipboard?: (text: string) => void
    statementRange?: (position: Position) => Range | null
    pageSize?: () => number
  })
  readonly mode: "normal" | "insert" | "visual" | "visual-line"
  readonly pending: string          // keys typed so far, for the statusline
  feed(key: Key): "handled" | "ignored"
  search(pattern: string, direction: 1 | -1): boolean
  on(event: "mode" | "change" | "yank" | "search", listener): () => void
}
```

`feed` returns `"ignored"` for keys the engine does not own (Enter in normal mode, the Leader, `ctrl+w`, `:`), so the application keymap can handle them. Two `TextBuffer` implementations exist: `MemoryBuffer` for tests and an adapter over OpenTUI's `EditBuffer` in the editor. The existing `VimTextareaRenderable` is rewritten as that adapter.

Supported grammar:

| Area | Keys |
| --- | --- |
| Counts | `3j`, `d2w`, `2dd`, `5G` |
| Motions | `h j k l`, `w b e W B E`, `0 ^ $`, `gg G`, `f F t T ; ,`, `%`, `{ }`, `ctrl+d ctrl+u`, `n N * #` |
| Operators | `d c y > <` with any motion or text object; `dd cc yy >> <<`; `D C Y`; `x X s S r J ~`; `p P`; `u ctrl+r`; `.` |
| Text objects | `iw aw iW aW`, `i" a" i' a'` and backtick, `i( a( i[ a[ i{ a{`, `ip ap`, and `is as` for the SQL Statement |
| Registers | unnamed, `"0`, `"a` to `"z`, `"+` (system clipboard), `"_` |
| Insert | text, Enter with indent carried over, Tab as two spaces, Backspace, `ctrl+w`, `ctrl+u`, arrows; `Esc`, `ctrl+[` or `ctrl+c` to leave |
| Visual | `v`, `V`, every motion, `o`, then `d y c x > < ~` |
| Search | `/` and `?` (smart case, literal when the pattern is not a valid regular expression), `n N`, `* #`, `:noh` |

- An undo unit is one normal-mode command or one whole insert session. The engine keeps its own undo stack.
- `.` repeats the last change, including text typed in the insert session it opened.
- `readOnly` rejects every change and leaves motions, search, visual mode and yank working.
- Yanks go to the clipboard through OSC 52, falling back to `wl-copy`, `xclip` or `pbcopy` when present.

### 5.5 Themes

A theme file uses opencode's theme JSON format (`defs` plus `theme`, values as hex, a reference into `defs`, a `{ "dark", "light" }` pair, or `"transparent"`), so an opencode theme file works unchanged. Unknown keys are ignored.

Tokens used: `primary secondary accent error warning success info text textMuted background backgroundPanel backgroundElement border borderActive borderSubtle` and `syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation`.

```ts
resolveTheme(json: ThemeJson, options: { mode: "dark" | "light"; transparent: boolean }): Theme
listThemes(dirs): ThemeInfo[]
loadTheme(name, dirs): ThemeJson
loadOmarchyTheme(colorsTomlPath): ThemeJson | null
```

- Built in: `tokyonight` (default), `catppuccin`, `gruvbox`, `nord`, `rosepine`, `everforest`, `kanagawa`, taken from opencode's MIT-licensed theme files with attribution in `NOTICE`.
- `omarchy`: built from `~/.local/state/omarchy/current/theme/colors.toml` (falling back to `~/.config/omarchy/current/theme/colors.toml`). It is offered only when that file exists, and it is re-read when the file changes, so losql follows `omarchy theme set` while running. Mapping: `accent` to primary, `foreground` to text, `dark_foreground` to muted text, `background`, `dark_background` and `lighter_background` to the three background tones, `muted` to border, and the named colours to status and syntax tokens; `mode` selects dark or light.
- Transparent: when on, `background` and Pane backgrounds resolve to fully transparent, so the terminal's own background and blur show through. Overlays (dialogs, toasts, key menu, completion) keep an opaque `backgroundPanel` so text stays readable. It is independent of the theme and toggles at runtime.

### 5.6 Agent

Provider interface:

```ts
interface ProviderAdapter {
  id: "claude" | "codex" | "opencode" | "antigravity"
  label: string
  binaries: string[]
  models(exec: Exec): Promise<string[]>
  command(request: { prompt: string; system: string; model?: string }): { args: string[]; stdin?: string }
  parse(line: string): ProviderEvent | null    // text delta, final text, or error
}

detectProviders(deps): Promise<ProviderStatus[]>           // installed, version, path
runProvider(adapter, request, { spawn, signal, timeoutMs, onText }): Promise<string>
```

Each Step starts the CLI in an empty temporary directory with the prompt on stdin where the CLI reads it, and the CLI's own tools off. Commands, checked on this machine on 2026-11-11:

| Provider | Command | Output read |
| --- | --- | --- |
| Claude Code 2.1 | `claude -p --safe-mode --tools "" --disable-slash-commands --no-session-persistence --output-format stream-json --verbose --system-prompt <s> [--model m]` | `assistant` text blocks; `result.result`, `result.is_error` |
| Codex 0.167 | `codex exec --json --skip-git-repo-check --ephemeral --sandbox read-only [-m m] -` | `item.completed` of type `agent_message`; `error`, `turn.failed` |
| OpenCode 2.2 | `opencode run --format json --agent plan [-m provider/model]` | `text` parts; `error.message` |
| Antigravity 1.5 | `antigravity --print=<prompt> --mode plan --output-format stream-json [--model m]` (or `agy`) | `step_update` text deltas; `result.response`, `result.status` |

A Provider error is classified as `quota`, `auth`, `missing`, `timeout` or `other` from its message, so the interface can say what to do (for example "Codex usage limit reached, try again Nov 16" or "run `claude` once to log in").

Model lists: fixed aliases for Claude Code (`default`, `fable`, `opus`, `sonnet`, `haiku`), `opencode models` and `antigravity models` output for those two, `default` for Codex; every list also accepts a typed model name.

The loop:

```ts
runAgent(turn: TurnRequest, deps: AgentDeps, onEvent: (event: AgentEvent) => void): Promise<TurnOutcome>

interface TurnRequest {
  intent: "ask" | "explain" | "fix" | "optimize"
  text: string
  statement?: string     // the Statement the Turn is about
  error?: string         // the failed Run's message, for "fix"
  plan?: string          // EXPLAIN output, for "optimize"
  conversation: Turn[]
}
```

Each Step sends one prompt containing the rules, the dialect, a schema digest, any Statement, error or plan, and the Conversation so far including earlier Step results. The Provider must answer with one JSON object:

```json
{ "action": "query", "sql": "select ...", "why": "..." }
{ "action": "describe", "relations": ["public.orders"] }
{ "action": "answer", "message": "...", "sql": "..." }
```

- `query` runs with `readOnly: true`, at most 50 rows, a 15-second timeout, and cells cut to 200 characters. The columns and rows, or the error, go into the next prompt.
- `describe` returns full column detail for the named Relations. The schema digest lists every Relation with its columns; above 60 Relations it lists names only and the Agent uses `describe`.
- `answer` ends the Turn. If it carries `sql`, that becomes a Proposal.
- A Turn has at most `maxSteps` Steps (default 8); after that the Agent is told to answer.
- Reply parsing is tolerant: code fences are stripped and the first complete JSON object is used. A reply with no JSON is treated as an `answer` whose Proposal is the first fenced `sql` block, so weaker models still work. An unknown action gets one corrective retry, then the Turn fails with a protocol error.
- Cancelling a Turn kills the Provider process.

`agent.dataAccess` is `"rows"` (default) or `"schema"`. With `"schema"` a `query` action is refused and the Agent is told to answer from the schema alone; no row ever leaves the machine.

### 5.7 Commands

One registry holds every Command: an id, a title, optional ex-command names, an optional key, the Panes it applies to, and a `run` function. The command line, the palette, the key menu and the help dialog are all views of this registry, so they cannot drift apart.

## 6. Interface

### 6.1 Layout

```
 SCHEMA             ┃ 1 scratch  2 revenue.sql                       ┃ AGENT
 ▾ main             ┃  1 select c.name, sum(o.total) as revenue      ┃
   ▾ customers      ┃  2 from customers c                            ┃ ┃ you
       id  integer  ┃  3 join orders o on o.customer_id = c.id       ┃ ┃ top customers by revenue
       name  text   ┃  4 group by c.name                             ┃
   ▸ orders         ┃  5 order by revenue desc;                      ┃ ┃ agent
   ▸ order_items    ┃                                                ┃ ┃ ▸ read schema
   ▸ products       ┣━ RESULTS  Table  JSON  Record   3 rows  2 ms ━━┫ ┃ ▸ ran 1 read-only query
                    ┃ name       revenue                             ┃ ┃ Revenue per customer:
                    ┃ Ada         1284.50                            ┃ ┃ ┃ select c.name, ...
                    ┃ Linus        930.00                            ┃ ┃ ┃ enter accept  r run  y yank
                    ┃ Grace        ∅                                 ┃ ┃
                    ┃                                                ┃ ┃ > ask the agent
 NORMAL  demo · sqlite    3:14     space menu  : command          claude · sonnet
```

- Four Panes: Schema (left), Editor (top centre), Results (bottom centre), Agent (right). Schema and Agent can be hidden.
- No box borders. Panes are separated by background tone and a `┃` split border, which takes the accent colour on the focused Pane.
- The statusline shows the mode, Connection, pending keys, cursor position, the running or last Run, and the Provider and Model.
- Below 100 columns the Agent Pane overlays the Editor instead of sitting beside it; below 70 the Schema Pane does too.

### 6.2 Keys

Everywhere outside insert mode:

| Key | Action |
| --- | --- |
| `ctrl+w` then `h j k l w` | focus the Pane to the left, below, above, right, or the next one |
| `ctrl+h j k l` | the same, where the terminal reports these keys distinctly (kitty keyboard protocol) |
| `space` | Leader: open the key menu |
| `:` | command line |
| `ctrl+p` | command palette (fuzzy search over every Command) |
| `ctrl+c` | cancel the running Run or Turn; pressed twice within a second, quit |
| `F1` | help |

Leader menu:

| Keys | Action |
| --- | --- |
| `r` / `R` | run the Statement under the cursor / every Statement in the Buffer |
| `x` | explain the Statement |
| `e` | show, focus or hide the Schema Pane |
| `a a`, `a i`, `a e`, `a f`, `a o`, `a n` | Agent: toggle Pane, ask, explain, fix last error, optimize, new Conversation |
| `v t`, `v j`, `v r` | Result view: Table, JSON, Record |
| `b n`, `b d`, `b l` | Buffer: new, close, list |
| `c`, `p`, `m`, `t`, `h`, `?` | Connections, Provider, Model, Theme, history, help |

Command line: `:q`, `:w [path]`, `:e <path>`, `:new`, `:bn`, `:bp`, `:bd`, `:run [all]`, `:explain [analyze]`, `:connect [name or url]`, `:provider`, `:model`, `:theme [name]`, `:set [no]transparent`, `:set [no]animations`, `:set maxrows=<n>`, `:view table|json|record`, `:ask <text>`, `:history`, `:refresh`, `:noh`, `:help`, `:<line>`.

Editor, beyond the vim grammar of 5.4:

| Key | Action |
| --- | --- |
| `Enter` in normal mode | run the Statement under the cursor |
| `Enter` in visual mode | run the selected text, split into Statements and run in order |
| `ctrl+s`, `ctrl+enter` in any mode | run the Statement under the cursor |
| `gt` / `gT` | next / previous Buffer |
| `ctrl+n` / `ctrl+p` in insert mode | open completion, next / previous item; `Enter` or `Tab` accepts, `Esc` closes |

Results:

| Key | Action |
| --- | --- |
| `h j k l`, `0 $`, `gg G`, `ctrl+d ctrl+u`, counts | move the cell cursor |
| `Tab` / `shift+Tab` | next / previous Result view |
| `Enter` | open the current row as a Record; `Esc` or `q` returns |
| `y` | yank the cell |
| `yy` or `Y` | yank the row as JSON |
| `V` then `y` | yank the selected rows as a JSON array |
| `/`, `n`, `N` | search cells |

Schema: `j k gg G`, `l` and `h` to expand and collapse, `Enter` on a Relation to peek (`select * ... limit 100` into Results without touching the Buffer), `i` to insert the name at the editor cursor, `y` to yank it, `/` to filter, `R` to refresh.

Agent: in normal mode `j k gg G ctrl+d ctrl+u` scroll the Conversation, `{` and `}` select the previous and next Proposal, `Enter` accepts the selected Proposal, `r` accepts and runs it, `y` yanks it, `i` focuses the input. In the input, `Enter` sends, `ctrl+j` adds a line, `Esc` returns to normal mode.

Dialogs: typing filters, `ctrl+n`/`ctrl+p` or the arrows move, `Enter` confirms, `Esc` closes.

### 6.3 Running and Results

- A Run shows a spinner and elapsed time in the Results header. `ctrl+c` cancels it on Postgres; on SQLite a Run cannot be cancelled (5.2).
- A Result with rows opens in the Table view. Columns are sized to content up to a maximum, numbers are right-aligned, `NULL` is drawn as a muted `∅`, JSON cells are drawn compact and highlighted.
- The JSON view is a read-only vim Buffer holding the rows as a highlighted JSON array of objects, limited to `jsonMaxRows` with a notice when rows were left out.
- The Record view lists the current row's fields vertically, pretty-printing JSON values.
- A truncated Result says so in the header ("first 1000 rows").
- A Statement that returns no rows shows its command, affected count and time.
- An error shows the message, detail and hint, and marks the position in the editor when the Driver reports one.
- `:run all` runs every Statement in order and stops at the first error; Results shows the last Result with rows and a toast summarizes the batch.
- `:explain` runs `EXPLAIN` (Postgres) or `EXPLAIN QUERY PLAN` (SQLite) and shows the plan as a Result. `:explain analyze` runs `EXPLAIN (ANALYZE, BUFFERS)` inside a transaction that is rolled back.

### 6.4 Agent Pane

- A Turn renders as a "you" block and an "agent" block. While it runs, the agent block shows a spinner with shimmering status text. Each Step adds one line: its kind, its SQL cut to the Pane width, and the row count or error it produced.
- The answer text is shown as plain paragraphs; fenced SQL and the Proposal are highlighted.
- Accepting a Proposal puts it in a new Buffer for an `ask` Turn and replaces the source Statement for a `fix` or `optimize` Turn. Nothing runs on accept.
- `r` runs the Proposal. If `classify` says it is not a read, a confirmation dialog shows the SQL first.
- `space a e`, `space a f` and `space a o` start a Turn about the Statement under the cursor (or the visual selection) without typing a question. `space a f` is available after a failed Run and includes its error. `space a o` includes the `EXPLAIN` output.
- With no Provider configured, opening the Agent Pane shows a short explanation and `Enter` opens the Provider dialog.

### 6.5 Onboarding and setup dialogs

First start (no `onboarded` flag) shows a welcome screen with the animated logo, then three steps with a progress indicator. `Enter` confirms the selected entry and `Esc` goes back one step. Every step has an entry that moves on without configuring anything, so no step can trap the user.

1. **Connect a database.** Choices: `DATABASE_URL` when set, SQLite files found in the working directory, "Enter a URL or file path", and "Explore the demo database". A failed connection shows the Driver's message inline and stays on the step.
2. **Choose your agent.** The four Providers are listed with what was detected: installed with version and path, or not found with a one-line install hint. Selecting one opens its Model list, then runs a one-word test prompt and shows the reply time or the classified error with what to do. "Continue without an agent" is always available.
3. **Pick a look.** The theme list previews live behind the dialog as the selection moves. `ctrl+t` toggles Transparent. `omarchy` is listed first and preselected when its colour file exists.

Each step is the same dialog that `space c`, `space p` and `space t` open later. The Connections dialog also adds, edits and deletes saved Connections.

### 6.6 Animation

All motion goes through `tui/motion`, which takes an injectable clock and jumps straight to the end value when animations are off.

| Where | Motion |
| --- | --- |
| Schema and Agent Panes | width eases open and closed, 180 ms |
| Dialogs | backdrop fades in and the dialog rises one row, 120 ms |
| Toasts | slide in from the right, fade out |
| Focus | the split border cross-fades to the accent colour, 120 ms |
| Run and Turn in progress | braille spinner and a shimmer sweep across the status text |
| Yank | the yanked text or row flashes for 150 ms |
| New Result | the row count counts up and rows fade in, 200 ms |
| Theme change | all colours cross-fade, 200 ms |
| Key menu | slides up from the statusline, 100 ms |
| Welcome | a gradient sweep across the logo |

## 7. Command line

```
losql [connection]                 start the TUI (connection: saved name, URL, file path, or "demo")
  --theme <name>  --transparent / --no-transparent  --no-animations
losql exec [-c <connection>] [--format table|json|csv] [--max-rows <n>] [--read-only] <sql | ->
losql ask  [-c <connection>] [--provider <id>] [--model <m>] [--run] <question>
losql providers [--json] [--test]
losql --help | --version
```

- The Connection is resolved in this order: the argument or `-c`, `DATABASE_URL`, the last Connection used. With none, the TUI opens the Connections dialog and headless commands exit with an error.
- `exec` runs every Statement in the input and prints the last Result. Exit code 0 on success, 1 on a query error, 2 on a usage error.
- `ask` runs one Turn and prints the Proposal's SQL to stdout and the Agent's message to stderr; `--run` also runs the Proposal read-only and prints the Result.
- `providers` prints detection results; `--test` runs the test prompt against each installed Provider.

## 8. Errors

- A Driver error never crashes the TUI. It becomes a `QueryError` shown in the Results Pane or inline in the dialog that caused it.
- Losing the Postgres connection marks the Session disconnected in the statusline; the next Run reconnects once before failing.
- A Provider that is missing, logged out, out of quota, timed out or returned an unusable reply ends the Turn with a classified message and leaves the Conversation intact.
- A bad config file, theme file or state file produces a warning toast and defaults; files are never deleted.
- An unexpected exception restores the terminal before printing the error.

## 9. Security and privacy

- The Agent cannot change data. Its queries run read-only at the database level, with a row cap and a timeout.
- A Proposal never runs on its own. A Proposal that is not a read needs explicit confirmation.
- Provider CLIs run in an empty temporary directory with their file, shell and web tools disabled or in their read-only mode.
- Schema, the Statements involved and the rows returned by Agent queries are sent to the chosen Provider. Onboarding says so, and `agent.dataAccess: "schema"` keeps rows local.
- Database content is passed to the Provider as delimited data with an instruction to treat it as data. Because a Proposal must still be accepted by the user, a prompt injected through table content cannot execute anything.
- Passwords are never logged or shown; `display` strips them, and `${NAME}` references keep them out of the config file.

## 10. Testing

| Layer | What | How |
| --- | --- | --- |
| Unit | lexer, statement splitting and classification, completion, vim engine (table-driven key sequences), theme resolution and Omarchy mapping, config and state, connection parsing, action parsing, prompt building, fuzzy matching, command parsing, motion maths | `bun test`, no I/O |
| Unit with fixtures | each Provider adapter's `parse` against output captured from the real CLIs, including the Codex usage-limit error | recorded NDJSON |
| Integration | SQLite Driver on temporary files; Agent loop with a scripted Provider against SQLite; Provider detection and `runProvider` against stub executables on a temporary `PATH`; history and Buffer persistence | `bun test` |
| Integration, gated | Postgres Driver: metadata, cursor cap, read-only enforcement, error position, schema | runs when `LOSQL_TEST_PG_URL` is set; CI provides a Postgres service |
| Component | result grid, JSON and Record views, schema tree, dialogs, key menu, command line, statusline, onboarding, Agent Pane, Transparent backgrounds | OpenTUI `testRender`, mock keys, frame capture, animations off |
| End to end | `exec`, `ask` and `providers` as child processes with a stub Provider; the compiled binary's `--version` and `exec` | `test/e2e` |
| Manual, scripted | the real TUI in tmux: onboarding, typing and running SQL, switching Result views, an Agent Turn with a real Provider, theme and Transparent switching, on SQLite and on a throwaway Postgres | key sequences sent with `tmux send-keys`, screen read with `capture-pane` |

`package.json` gains `test`, `typecheck` and `check` scripts. A GitHub Actions workflow runs typecheck, tests with a Postgres service, and the build.

## 11. Acceptance criteria

1. `bun install`, `bun run typecheck`, `bun test` and `bun run build` succeed, and the built `losql` binary runs `--version` and `exec` from another directory.
2. `losql exec -c demo "select count(*) from orders"` prints a table; `--format json` and `--format csv` print those formats.
3. The same `exec` works against Postgres, and the Postgres integration tests pass.
4. First start shows onboarding; the demo database can be opened; all four Providers show their real installed state; a test prompt succeeds for at least one installed Provider.
5. In the Editor: insert SQL, see it highlighted, leave insert mode, run with `Enter`, see the Table; `Tab` shows highlighted JSON; `Enter` on a row shows the Record.
6. Counts, operators with motions and text objects, registers, `.`, undo and search behave as listed in 5.4.
7. An Agent Turn against the demo database takes at least one read-only Step, produces a Proposal, and accepting it puts the SQL in a Buffer that then runs.
8. An Agent `query` action containing a write fails at the database on both dialects and changes nothing.
9. `:theme <name>` switches themes; `:set transparent` leaves Pane background cells unpainted; the `omarchy` theme reflects the current Omarchy colours.
10. `:q` quits from every Pane, and `ctrl+c` twice quits.
11. With animations off the interface is static and tests are deterministic.
12. Starting losql opens no port and makes no network request.

## 12. Milestones

1. **Foundation:** dependency upgrade, scripts, CI, remove the server, argument parsing, config and state.
2. **Core:** SQL lexer, both Drivers and the demo database, vim engine, themes, Provider adapters and the Agent loop, headless `exec`, `ask` and `providers`.
3. **Workspace:** TUI shell, motion, dialogs and toasts, command registry with command line, palette and key menu, Editor, Results, Schema.
4. **Agent and setup:** Agent Pane and quick actions, Connections, Provider, Model and Theme dialogs, history, onboarding, completion.
5. **Finish:** single-binary build, README, scripted verification in tmux on SQLite and Postgres.

This is one spec and one branch because the workspace cannot be exercised without the core and the user asked for the refactor end to end; the milestones are the review boundaries.

## 13. Assumptions

These were decided without asking; say so if any should change.

- Pane focus moves with `ctrl+w` chords. The old `Shift+H/J/K/L` bindings are dropped because `J` is vim's join. `ctrl+s` still runs the Statement.
- `Enter` in normal mode runs the Statement under the cursor.
- The Agent may read rows by default (`dataAccess: "rows"`), capped at 50 per query.
- SQLite runs in-process; a long Statement blocks the interface. A compiled-binary worker thread was tried and was not reliable on Bun 1.3.9.
- Saved Connection URLs live in the config file with mode 0600; there is no keyring integration.
- The query-plan side panel is replaced by `:explain`, which shows the plan in the Results Pane.
- Themes from opencode are vendored with attribution.
- The README is rewritten for the new interface.
