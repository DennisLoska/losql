# Changelog

All notable changes to **losql** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-24

### Added

- **Relation Structure inspection:** Inspect a Relation's Columns (types, nullability, defaults, generated columns, references), Indexes, Constraints and Definition inside the Results Pane, on SQLite and PostgreSQL. Open it with `S` in the Schema Pane, `<leader> v s`, `:inspect [relation]` or `:view structure`; switch sections with `Tab` / `1`-`4`, open row details with `Enter`, yank with `y`, pick another Relation with `c`, reload with `R`, and return to the Result with `q`.
- **Leader menu paging:** A key menu that does not fit the terminal pages with `]` / `[` or `PageDown` / `PageUp` and names the page in its footer instead of hiding entries.

### Changed

- **Agent transcript redesign:** The Agent Pane reads like a chat in the style of OpenCode: your question as a `┃` quote, unbarred Agent Steps and prose, and a SQL Proposal card with its `enter accept  r run  y yank` hint.
- **Shared box-drawing `DataGrid`:** The Table Result view and Structure sections render through one box-drawn grid with a consistent cell cursor, row selection and yank flash.
- **Help follows a custom Leader:** Key help and advice show the configured `leader` instead of assuming `space`.
- **Agent `describe` Steps:** Load the Driver's rich Relation details (defaults, generated columns, indexes, constraints), with a Schema snapshot fallback; a Driver error becomes a Step error instead of ending the Turn.

### Fixed

- **Agent Step payloads:** Query Steps carry the executed Statement, mark any cut as truncated, and bound cells and errors in code points.
- **PostgreSQL side queue:** Schema, type and describe side work is serialized on its own queue, read-only type lookups keep their deadline and no longer deadlock against a user transaction, and names are compared as text.
- **SQLite DDL parsing:** Relation structure parsing handles reference targets, index modifiers and adjacent constraints in linear time.

## [0.2.0] - 2026-11-16

### Added

- **Modal Vim SQL Editor:** Full modal editing grammar with motions, operators (`d`, `c`, `y`, `>`, `<`), SQL Statement text objects (`is` / `as`), registers, dot repeat (`.`), undo/redo (`u` / `ctrl+r`), `/` and `?` regex search, multi-Buffer persistence per Connection (`gt` / `gT`), and live Schema snapshot completion (`ctrl+n` / `ctrl+p`).
- **Agent on Board (Zero API Keys):** Drives installed coding CLIs on your `PATH` (**Claude Code**, **Codex**, **OpenCode**, and **Antigravity**) in an isolated temporary directory with database credentials stripped from the child environment. Supports up to 8 read-only `describe`, `query`, and `explain` Steps per Turn, presenting a highlighted SQL Proposal card (`Enter` to accept into Buffer, `r` to Run with write confirmation).
- **In-Process SQLite & Postgres Drivers:** Single compiled binary supporting SQLite (`bun:sqlite`), PostgreSQL (`postgres`), and a bundled `demo` database (`losql demo`) with zero external database drivers to install.
- **Three Result Views & Full-Screen Zoom:** Switch seamlessly between navigable **Table**, syntax-highlighted **JSON**, and vertical **Record** views (`Tab` / `shift+Tab`), yank cells or rows as JSON (`y` / `yy`), and zoom Results to the full terminal (`space z`).
- **Schema Snapshot Tree:** Browse namespaces, tables, views, columns, types, primary keys, and foreign keys; filter with `/` and peek at Relations with `Enter`.
- **Omarchy Live Theme & Transparent Mode:** Eight themes (`tokyonight`, `catppuccin`, `everforest`, `gruvbox`, `kanagawa`, `nord`, `rosepine`, plus live `omarchy` system `colors.toml` tracking), OpenCode JSON theme compatibility (`~/.config/losql/themes/<name>.json`), and `:set transparent` (`ctrl+t`) so terminal background and blur shine through.
- **First-Run Onboarding & Leader Menu:** Guided three-step onboarding (Connection, Provider, Theme), contextual `space` Leader menu, `ctrl+p` command palette, `:` command line, and `F1` key help.
- **Headless CLI & Scripting:** `losql exec` (table, JSON, and CSV output, `--read-only`), `losql ask` (`--run`), and `losql providers` (`--test`, `--json`) with clean signal handling and exit codes.
- **Binary Release Pipeline & Installer:** Prebuilt standalone binaries for Linux (`x64`, `arm64`) and macOS (`x64`, `arm64`) with `SHA256SUMS.txt` verification and `install.sh`.
