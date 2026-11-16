# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| `0.2.x` | :white_check_mark: |
| `< 0.2.0` | :x: |

## Security Model

`losql` is designed to keep your database and credentials safe while working with local coding-agent CLIs:

1. **No Telemetry or Background Network Calls:** `losql` opens no network port and makes no network requests of its own (`test/e2e/no-network.test.ts`). The only network client in the binary is the PostgreSQL driver when connected to a Postgres URL you provide.
2. **Credential Scrubbing for Agent Processes:** Before spawning any Provider CLI (`claude`, `codex`, `opencode`, `antigravity`), `losql` strips `DATABASE_URL`, `*_DATABASE_URL`, `PGPASSWORD`, `PG*`, `POSTGRES*`, `MYSQL*`, `MARIADB*`, and `LOSQL_*_URL` from the child process environment, and runs the CLI in a newly created empty temporary directory.
3. **Read-Only Agent Steps & Proposal Confirmation:** Agent `query` Steps are checked against a read-only SQL gate (blocking 65 known side-effecting functions) and executed on a read-only SQLite connection (`PRAGMA query_only` for `:memory:` / `demo`) or inside a `READ ONLY` PostgreSQL transaction that is rolled back and followed by session/lock resets. Agent Proposals never execute automatically, and running a Proposal that modifies data requires explicit confirmation.
4. **Local File Permissions:** Configuration (`config.json`), state (`state.json`), history (`history.jsonl`), and open Buffer snapshots are written with mode `0600`. Use `${ENV_VAR}` placeholders in saved connection URLs to avoid storing plaintext passwords on disk.
5. **Data Access Control (`agent.dataAccess`):** Setting `"agent": { "dataAccess": "schema" }` in `config.json` prevents the Agent from running row queries and scrubs non-schema database error details before sending context to the Provider.

## Reporting a Vulnerability

If you discover a security vulnerability in `losql` (such as a bypass of the read-only gate, credential leakage to a Provider child process, or terminal escape injection):

1. **Do not open a public GitHub issue** for undisclosed vulnerabilities.
2. Report the issue privately via [GitHub Private Vulnerability Reporting](https://github.com/DennisLoska/losql/security/advisories/new) on the repository.
3. Include minimal reproduction steps, the affected version or commit SHA, and the database dialect (`sqlite` or `postgres`) involved.
