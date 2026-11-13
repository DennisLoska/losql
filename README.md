<h1 align="center">losql</h1>

<p align="center">
  <em>Write the query yourself, or ask for it.</em><br/>
  A vim-first SQL client for the terminal, with an agent on board. SQLite and Postgres, one binary, no API keys.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-7aa2f7?style=flat-square" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/Bun-1.3-1a1b26?style=flat-square&logo=bun&logoColor=white" alt="Bun 1.3" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/OpenTUI-SolidJS-2C4F7C?style=flat-square&logo=solid&logoColor=white" alt="OpenTUI and SolidJS" />
  <img src="https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/Postgres-336791?style=flat-square&logo=postgresql&logoColor=white" alt="Postgres" />
  <img src="https://img.shields.io/badge/agent-Claude%20Code%20%7C%20Codex%20%7C%20OpenCode%20%7C%20Antigravity-bb9af7?style=flat-square" alt="Agent: Claude Code, Codex, OpenCode, Antigravity" />
  <img src="https://img.shields.io/badge/version-0.2.0-9ece6a?style=flat-square" alt="version 0.2.0" />
</p>

<p align="center">
  <a href="#tour">Tour</a> •
  <a href="#quick-start">Quick start</a> •
  <a href="#what-it-does">What it does</a> •
  <a href="#keys">Keys</a> •
  <a href="#the-agent">The agent</a> •
  <a href="#themes">Themes</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#without-the-interface">Scripts</a> •
  <a href="#limits">Limits</a>
</p>

<p align="center">
  <img src="readme/hero.webp" alt="losql: schema tree, SQL editor, results table and the agent sidebar, in the tokyonight theme" width="100%" />
</p>

---

losql is a SQL client you drive like vim. You write queries in a modal editor with highlighting and completion, and see the result as a table, as JSON or one record at a time. When you would rather ask, an agent writes the query for you. The agent is a coding CLI you already have installed (Claude Code, Codex, OpenCode or Antigravity), so there is nothing to sign up for and no key to paste. Everything runs in one process on your machine.

---

## Tour

All screenshots show the built-in `tokyonight` theme on the bundled `demo` database.

<table>
<tr>
<td width="50%">

**Editor: vim, with SQL in mind**

Modal editing with motions, operators, text objects, registers, undo and search. `is`/`as` select the SQL statement under the cursor, and `Enter` runs it. Completion knows your tables and columns.

<img src="readme/editor.webp" alt="The editor in insert mode with a completion popup listing columns" width="100%" />

</td>
<td width="50%">

**Agent: asks the database before it answers**

The agent can look at the schema and run read-only queries, step by step, and then proposes a statement. A proposal never runs by itself: `Enter` puts it into the editor, `r` runs it.

<img src="readme/agent.webp" alt="The agent pane with a question, a query step and a proposal card" width="100%" />

</td>
</tr>
<tr>
<td width="50%">

**Results as JSON**

`Tab` switches between Table, JSON and Record. JSON is highlighted and searchable, and `yy` yanks a row as JSON.

<img src="readme/json.webp" alt="The results pane in JSON view with syntax highlighting" width="100%" />

</td>
<td width="50%">

**One record at a time**

`Enter` on a row opens it in Record view: every column on its own line, long values in full.

<img src="readme/record.webp" alt="The results pane in Record view showing one row" width="100%" />

</td>
</tr>
<tr>
<td colspan="2" align="center">

**Zoom: the result full screen**

`space z` gives the results pane the whole terminal, scrollable in every direction. `space z` again brings the other panes back exactly as they were.

<img src="readme/zoom.webp" alt="The results pane zoomed to the full terminal" width="90%" />

</td>
</tr>
<tr>
<td width="50%">

**Providers: use the CLI you already have**

losql finds the coding CLIs on your `PATH`, shows their versions and tests the one you pick with a one-word prompt. `space p` changes it later, `space m` picks a model.

<img src="readme/providers.webp" alt="The provider dialog listing Claude Code, Codex, OpenCode and Antigravity with their versions" width="100%" />

</td>
<td width="50%">

**Themes: opaque or transparent**

Eight themes with a live preview, each of them opaque or transparent. On Omarchy the `omarchy` theme follows the system theme as it changes.

<img src="readme/themes.webp" alt="The theme dialog with a live preview" width="100%" />

</td>
</tr>
<tr>
<td width="50%">

**Everything is one key away**

`space` opens a menu of actions, `ctrl+p` searches every command, `:` is a command line, `F1` shows all keys.

<img src="readme/menu.webp" alt="The leader menu listing actions and their keys" width="100%" />

</td>
<td width="50%">

**A first start that sets you up**

Three steps on the first run: connect a database, choose an agent, pick a look. `Esc` skips them.

<img src="readme/onboarding.webp" alt="The welcome screen of the first start" width="100%" />

</td>
</tr>
</table>

---

## Quick start

Needs [Bun](https://bun.sh) to build (developed and tested with Bun 1.3.9). The result is a single binary.

```bash
git clone https://github.com/DennisLoska/losql.git
cd losql
bun install
bun run build
mv losql ~/.local/bin/
```

```bash
losql demo                               # a small sample database, nothing to set up
losql ./app.db                           # an existing SQLite file (or :memory:)
losql postgres://user@localhost/mydb     # Postgres
losql                                    # DATABASE_URL, or the last connection, or a list to pick from
```

The first start walks through up to three steps: connect a database (skipped when the one passed on the command line or in `DATABASE_URL` is already open), choose an agent, and pick a theme. You can skip onboarding with `Esc` and change any choice later (`space c`, `space p`, `space t`).

Then, in the editor: `i` to type, `Esc` and `Enter` to run the statement under the cursor, `space` for the menu, `space a i` to ask the agent.

---

## What it does

| | |
| --- | --- |
| **Write queries** | A modal editor with vim motions, operators, text objects, registers, dot repeat, undo and search. SQL highlighting for SQLite and Postgres. Completion of keywords, tables and columns from the live schema. Several buffers, saved per connection and restored on the next start. |
| **Let the agent write them** | Ask in plain words, or have the agent explain a statement, fix the last error or optimize a query. It reads the schema and may run read-only queries before it proposes SQL. You decide whether a proposal goes into the editor or runs. |
| **Look at results** | A table with a cell cursor and horizontal scrolling, highlighted JSON, and a Record view for one row. Search, yank a cell or rows as JSON, zoom to full screen with `space z`. |
| **Browse the schema** | A tree of namespaces, relations and columns with types and keys. Peek at a relation's rows, insert a name into the editor, filter with `/`. |
| **SQLite and Postgres** | Both in process: no server, no driver to install. Saved connections can read their password from the environment. Run one statement, a selection or the whole buffer; `:explain` shows the plan. |
| **Stay safe** | The agent's queries run read-only. A proposal that changes data asks before it runs. After a lost connection a statement that changes data is never sent twice. Passwords are hidden on screen and are not handed to the agent's process. |
| **Make it yours** | Eight themes in opencode's theme format, opaque or transparent, with animations you can turn off. The `omarchy` theme follows Omarchy. |
| **Script it** | `losql exec`, `losql ask` and `losql providers` work without the interface, with table, JSON or CSV output and proper exit codes. |

---

## Keys

losql is modal, like vim. `space` (the default leader key) opens a menu of actions, `:` opens the command line, `ctrl+p` searches all commands, `F1` shows help.

| Where | Keys |
| --- | --- |
| Everywhere | `shift+h/j/k/l` move between panes (also `ctrl+h/j/k/l` and `ctrl+w h/j/k/l/w`), whenever you are not typing text. `space z` zooms the results pane to full screen and back. `ctrl+c` cancels a running statement or agent turn; twice within 1s it quits (in insert mode `ctrl+c` leaves insert mode; a `ctrl+c` that closes a dialog or a popup does not count towards quitting) |
| Editor | vim motions, operators (`d`, `c`, `y`, `>`, `<`), text objects (`is`/`as` is the SQL statement), registers, `.`, `u`/`ctrl+r` undo/redo, `/` and `?` search (`n`/`N`). `Enter` runs the statement under the cursor, in visual mode the selection. `ctrl+s` (or `ctrl+enter`) runs the statement under the cursor from any mode. `gt`/`gT` switch buffers. `gJ` joins lines (plain `J` moves to the results pane; with a count, as in `3J`, it still joins). In insert mode `ctrl+n`/`ctrl+p` complete the word before the cursor (nothing without a typed prefix, except after `name.`); a name that needs quotes is inserted quoted, also inside a quoted name |
| Results | `h j k l`, `gg G`, `0 $`, `ctrl+d`/`ctrl+u` move the cell cursor. `Tab`/`shift+Tab` switch Table, JSON and Record. `Enter` opens the row in Record view (`q` or `Esc` returns). `y` yanks the cell, `yy` or `Y` the row as JSON, `V…y` several rows as a JSON array. `/` searches (`?` too in JSON view) |
| Schema | `j k`, `gg G`, `ctrl+d`/`ctrl+u` move, `l`/`h` expand and collapse, `Enter` toggles a namespace or peeks at a relation, `i` inserts the selected name into the editor, `y` yanks it, `/` filters, `R` refreshes |
| Agent | `j k`, `gg G`, `ctrl+d`/`ctrl+u` scroll, `i` (or `a`) to type, `Enter` to send, `ctrl+j` for a new line. `{`/`}` choose a proposal, `Enter` accepts it into the editor, `r` runs it, `y` yanks it. `Esc` then `shift+h` goes back to the editor |

Leader menu: `r` run, `R` run all, `x` explain, `e` schema, `z` zoom results, `a…` agent (`a a` toggle/focus agent, `a i` ask, `a e` explain, `a f` fix the last error, `a o` optimize, `a n` new conversation), `v…` result view (`v t` Table, `v j` JSON, `v r` Record), `b…` buffers (`b l` list, `b n` new, `b d` close), `c` connections, `p` provider, `m` model, `t` themes, `h` history, `?` help.

Commands: `:q`, `:w [path]`, `:e <path>`, `:new`, `:ls`, `:bn`, `:bp`, `:bd`, `:run [all]`, `:explain [analyze]`, `:connect [name, url or path]`, `:connections`, `:provider`, `:model`, `:theme [name]`, `:set [no]transparent`, `:set [no]animations`, `:set maxrows=<n>`, `:view table|json|record`, `:zoom`, `:ask [text]`, `:history`, `:refresh`, `:noh`, `:help`, `:<line>`.

---

## The agent

The agent is one of these CLIs, started without its interface in a new, empty temporary directory and restricted by the options below. Restricted means it cannot change anything; it does not mean it cannot read local files your user can read:

| Provider | Binary | How its own tools are restricted |
| --- | --- | --- |
| Claude Code | `claude` | Safe mode, all tools (`--tools ""`) and slash commands off, no session saved |
| Codex | `codex` | Read-only sandbox, ephemeral session; can read local files |
| OpenCode | `opencode` | Its `plan` agent; can read local files |
| Antigravity | `antigravity` (or `agy`) | Its `plan` mode; can read local files |

Claude Code, Codex and OpenCode receive what losql sends on standard input; Antigravity receives it as an argument on its command line, which other users of the machine can see in the process list while a turn runs.

`losql providers` (or `losql providers --json`) shows what was found and asks each CLI for its version; `losql providers --test` sends each installed provider a one-word prompt. Each CLI must be installed and logged in on its own; losql neither installs nor configures them. Database credentials in your environment (`DATABASE_URL`, `*_DATABASE_URL`, `PGPASSWORD` and the other `PG…` variables, `POSTGRES*`, `MYSQL*`, `MARIADB*`, `LOSQL_*_URL`) are removed from the environment of every provider process losql starts.

How it works: losql sends the provider a digest of your schema (up to 60 relations in full, or relation names above 60 relations or 24,000 characters), your question, any statement, error or query plan involved, and the conversation history. Across up to 8 steps (`maxSteps`, 120s per step), the agent may ask losql to describe relations (up to 50 relations / 12,000 characters) or run one read-only query per step (at most 50 rows, 40 columns, 200 characters per cell, and 15 seconds on Postgres) and then answers with a proposal. A proposal never runs by itself: you accept it into the editor (`Enter`) or run it (`r`), and running a proposal that is not a plain read asks for confirmation first. Statements you run yourself from the editor run without asking. A conversation belongs to one connection: connecting to another database starts a new one.

Read-only (the agent's queries, `exec --read-only`, `ask --run`) means two things. The statement's text must be a read: a `select` that calls one of 65 known functions with side effects (such as `nextval`, `pg_notify` or `dblink`) counts as a write. It then runs on SQLite through a read-only connection (`PRAGMA query_only` for `demo` and `:memory:`), on Postgres in a read-only transaction that is rolled back, after which session settings and advisory locks are reset. The list is a floor: the check cannot know what a function of your own (or one not on the list) does, so on Postgres a function with effects outside the transaction is not stopped.

What leaves your machine: the connection's name and dialect, the schema, the statements, error messages or query plans involved, the conversation, and the rows the agent's read-only queries return go to the provider you chose. With `"agent": { "dataAccess": "schema" }` the agent runs no queries, so no rows are sent, and a database error is sent whole only when it is about the statement's text or the schema (a syntax error, an unknown table or column); any other error is sent as its code with the quoted and parenthesised parts of its message removed. Everything else still is sent, and a statement, a query plan or the message of an error raised by a function of your own can contain values from your data.

---

## Themes

Built in: `tokyonight` (default), `catppuccin`, `everforest`, `gruvbox`, `kanagawa`, `nord`, `rosepine`; choose with `space t`, `:theme <name>` or `--theme <name>`. Theme files use [opencode](https://opencode.ai)'s theme format, so an opencode theme dropped into `~/.config/losql/themes/<name>.json` works as is.

- **Transparent:** `:set transparent` (or `ctrl+t` in the theme dialog, or `--transparent` / `--no-transparent`) stops painting pane backgrounds, so your terminal's background and blur show through. Overlays and dialogs stay opaque.
- **Omarchy:** on [Omarchy](https://omarchy.org) the `omarchy` theme reads Omarchy's current `colors.toml` and updates live when the system theme changes.
- **Animations:** `:set noanimations`, `--no-animations` or `LOSQL_NO_ANIMATIONS=1` turn all motion off.

---

## Configuration

`~/.config/losql/config.json` (or `$XDG_CONFIG_HOME/losql/config.json`, or `$LOSQL_CONFIG_DIR/config.json`; every key is optional, and `connections` defaults to `[]` and `agent.provider` to `null`):

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

`${NAME}` in a saved connection URL is read from the environment when connecting, so passwords need not be stored on disk.

`losql` without an argument (and `exec` or `ask` without `-c`) uses `DATABASE_URL`, else the last connection. The last connection is remembered in `state.json`: a saved connection by its name; a URL or path typed in the application or passed as `losql <connection>` exactly as given, so a password in that URL is stored there (use a saved connection with `${NAME}` instead). A connection given as the same text as `DATABASE_URL` is not written there; the one remembered before is kept.

State lives in `~/.local/state/losql/` (or `$XDG_STATE_HOME/losql/`, or `$LOSQL_STATE_DIR/`): `state.json` holds onboarding, the last connection and the outcome of provider tests, `history.jsonl` keeps the SQL of each statement you run in the interface as you wrote it, literals included (not peeks or explains; up to 5,000 entries), and `buffers/` holds open editor buffers per connection. `config.json`, `state.json`, `history.jsonl` and buffer files are written with mode `0600`.

---

## Without the interface

```bash
losql exec -c demo "select count(*) from orders"            # prints a table
losql exec -c ./app.db --format json "select * from users"  # table, json, or csv; also --max-rows <n>, --read-only
cat migration.sql | losql exec -c dev -                     # runs the statements in order, prints the last result with columns
losql ask -c demo "which customers ordered the most?"       # SQL on stdout, explanation on stderr; also --provider, --model
losql ask -c demo --run "revenue per month"                 # also runs it, read-only
losql providers --test                                      # or --json
```

`exec` runs the statements in order, each on its own, and prints the last result that has columns (or the last command summary when none return columns). It stops at the first statement that fails; with more than one statement it writes `losql: statement <i> of <n> failed` to stderr before the error. `--read-only` and `ask --run` are read-only as described under The agent.

`ask` prints the proposal's SQL on stdout and the agent's explanation and steps on stderr; when the agent gives no SQL, only the explanation is printed and the exit code is `0`. With `--run` the result follows the SQL on stdout.

Exit codes: `0` success, `1` query, connection or provider error (also when a statement before the last one fails), `2` usage error (also when no connection is given or its form is not recognised; a file or database that does not exist is `1`), `130` after `SIGINT` and `143` after `SIGTERM`. The first signal ends the command within about a second, with output that may be incomplete. A SQLite statement cannot be interrupted while it runs, so there the command ends when the running statement has finished, and the statements after it do not run.

---

## Limits

- SQLite statements run in-process: a long statement blocks the interface and cannot be cancelled. Postgres statements cancel with `ctrl+c`.
- When a Postgres connection is lost, losql opens it again and says so: an open transaction, session settings and temporary tables are gone. A read is then run again; a statement that changes data is not, because it may already have been applied.
- `:explain analyze` runs read-only, so it is refused for a statement that changes data.
- On SQLite, a `SELECT` with duplicate column names loads all rows into memory before applying the row limit; a `RETURNING` clause with duplicate column names falls back to `column1`, `column2`, …; and JSON output renames duplicate keys to `name_2`, `name_3`, ….
- Vim motions step by code point, so a motion can stop inside a multi-part emoji or a letter with a combining mark.
- Search patterns (`/`, `?`) are JavaScript regular expressions run without a time limit.
- Statements are split by a lexer, not a parser: inside a SQLite trigger body, `end` used as a column alias without `as` is read as the end of the body.
- Passwords are hidden in what losql shows about a connection, but a `passfile=` path is shown, and a URL typed or passed as an argument is stored in `state.json` as given.
- Buffers and history are kept per connection under a name made of its saved name, or else its user, host, port and database (or file path), in lower case with punctuation turned into `-`: connections that differ only in case or punctuation share them.
- `:e` refuses files larger than 5 MiB and files that contain a NUL byte.
- No inline editing of result cells, no export dialog, no vim macros or marks, no counts on inserts (`3A`) or on `.` after an insert, no `ctrl+o` in insert mode.
- Linux and macOS (tested on Linux); not Windows.

---

## Development

```bash
bun run dev -- demo      # run from source (bun run src/main.ts)
bun run test             # unit, component and end-to-end tests
bun run typecheck
bun run build            # ./losql
bun run verify:tui       # builds, then drives the binary in tmux
```

Postgres tests run when `LOSQL_TEST_PG_URL` points at a database you can write to. `verify:tui` needs tmux and `perl`; with `LOSQL_VERIFY_PG_URL` set it also checks a Postgres connection. The design is in `docs/specs/`, the decisions in `docs/adr/`, and the vocabulary in `GLOSSARY.md`.

---

## Credits

Built with [OpenTUI](https://github.com/anomalyco/opentui) and [Bun](https://bun.sh). Themes and several interface ideas come from [opencode](https://github.com/sst/opencode) (MIT, see `NOTICE`). Inspired by [lazysql](https://github.com/jorgerojas26/lazysql) and [harlequin](https://harlequin.sh).

## License

MIT, see `LICENSE`.
