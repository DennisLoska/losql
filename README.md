# Losql

A vim-first terminal-based SQL client with Vim keybindings, syntax highlighting, and query plan visualization. Built with [OpenTUI](https://github.com/opentui/opentui) and [Bun](https://bun.sh).

## Features

- Vim-style text editing for SQL queries
- SQL syntax highlighting (Tokyo Night theme)
- Query execution with JSON results
- Query plan visualization (EXPLAIN ANALYZE)
- Keyboard-driven navigation between panels

## Requirements

- [Bun](https://bun.sh) v1.0 or later
- PostgreSQL database

## Installation

### Build from source

```bash
# Clone the repository
git clone https://github.com/dennisloska/losql.git
cd losql

# Install dependencies
bun install

# Build the binary
bun run build
```

This produces a standalone `losql` binary in the project root.

### Install the binary

Move the binary to a directory in your PATH:

```bash
# macOS / Linux
mv losql /usr/local/bin/

# Or add to your custom bin directory
mv losql ~/.local/bin/
```

## Configuration

Losql connects to PostgreSQL using the `DATABASE_URL` environment variable.

### DATABASE_URL format

```
postgresql://[user]:[password]@[host]:[port]/[database]
```

### Examples

```bash
# Local database
export DATABASE_URL="postgresql://postgres:password@localhost:5432/mydb"

# Remote database with SSL
export DATABASE_URL="postgresql://user:pass@db.example.com:5432/production?sslmode=require"

# Using default postgres user
export DATABASE_URL="postgresql://localhost:5432/mydb"
```

## Usage

```bash
# Set your database connection
export DATABASE_URL="postgresql://postgres:password@localhost:5432/mydb"

# Run losql
losql
```

### Development mode

```bash
# Run with hot reload
bun dev
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `?` | Toggle help overlay |
| `Ctrl+s` | Execute SQL query |
| `Shift+E` | Toggle query plan panel |
| `Shift+J` | Move focus down (Editor → Results) |
| `Shift+K` | Move focus up (Results → Editor) |
| `Shift+H` | Move focus left (Report → Editor) |
| `Shift+L` | Move focus right (Editor/Results → Report) |

### Vim Keybindings

The SQL editor supports standard Vim keybindings:

- `i` - Insert mode
- `Esc` - Normal mode
- `h/j/k/l` - Cursor movement
- `w/b` - Word navigation
- `0/$` - Line start/end
- `dd` - Delete line
- `yy` - Yank line
- `p` - Paste

## Panels

1. **Editor** (top-left) - Write your SQL queries here
2. **Results** (bottom-left) - Query results displayed as JSON
3. **Report** (right) - Query execution plan (toggle with `Shift+E`)

## License

MIT
