# postgres.js for Postgres instead of Bun's built-in SQL client

The Postgres Driver uses the `postgres` package (postgres.js), not `import { sql } from "bun"`. Bun's client returns rows without column metadata, so an empty Result has no headers and duplicate column names cannot be labelled, and it has no cursor to stop reading a large Result early. postgres.js exposes column names and type OIDs, array-mode rows, cursors, read-only transactions and cancellation, all of which the Results pane and the Agent rely on. Checked against Bun 1.3.9 and PostgreSQL 18 on 2026-11-11.

SQLite keeps using `bun:sqlite`, which has no equivalent gap that matters here.
