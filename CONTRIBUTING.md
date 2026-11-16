# Contributing to losql

Thank you for your interest in contributing to **losql**!

## Architecture & Vocabulary

Before making changes, please read:

- [`GLOSSARY.md`](GLOSSARY.md) — Ubiquitous language used across code, documentation, and the UI (**Connection**, **Session**, **Driver**, **Schema snapshot**, **Relation**, **Buffer**, **Statement**, **Run**, **Result**, **Result view**, **Record**, **Provider**, **Model**, **Agent**, **Conversation**, **Turn**, **Step**, **Proposal**, **Pane**, **Command**, **Leader**, **Theme**, **Transparent**).
- [`docs/specs/`](docs/specs/) — Architectural and feature specifications.
- [`docs/adr/`](docs/adr/) — Architecture Decision Records (`0001` through `0004`).

### Layering Rules

1. `src/core` never imports from `src/tui` or `@opentui/*`. Every core module accepts its external dependencies as arguments so it can be tested deterministically.
2. `src/tui` never talks to a database or spawns a child process directly; it calls `src/core`.
3. `losql` runs as a single process: no background daemon, no local HTTP server, and no network requests other than connecting to a PostgreSQL database the user specifies (`test/e2e/no-network.test.ts` enforces this invariant).

## Development Setup

Prerequisites:

- [Bun](https://bun.sh) 1.3.9 or newer
- `tmux` and `perl` (optional, for `bun run verify:tui`)
- PostgreSQL (optional, for running the live Postgres test suite via `LOSQL_TEST_PG_URL`)

Install dependencies and run from source:

```bash
bun install
bun run dev -- demo
```

## Verification & Testing

Run the typechecker and test suite before opening a pull request:

```bash
bun run typecheck        # TypeScript strict typecheck
bun run test             # Unit, component, landing page, and E2E tests
bun run check            # Both typecheck and test
bun run build            # Compile standalone ./losql binary
bun run verify:tui       # Drive the compiled binary in an isolated tmux session
```

To run the PostgreSQL integration tests locally, point `LOSQL_TEST_PG_URL` at a writable test database:

```bash
LOSQL_TEST_PG_URL=postgres://losql@localhost:5432/postgres bun run test
```

## Releases

Releases are managed through [`scripts/release.ts`](scripts/release.ts) and [`.github/workflows/release.yml`](.github/workflows/release.yml):

```bash
bun run release:check                     # Verify version consistency and CHANGELOG.md entry
bun run release:notes                     # Preview formatted GitHub Release notes
bun run release:build                     # Cross-compile Linux & macOS binaries + SHA256SUMS.txt
bun run release -- publish --dry-run      # Full dry run of checks, builds, and release notes
```

## License

By contributing to `losql`, you agree that your contributions will be licensed under the [MIT License](LICENSE).
