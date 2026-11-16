# Changelog

All notable changes to **losql** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
