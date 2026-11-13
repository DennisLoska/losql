# Provider output fixtures

Output captured from the real provider CLIs on 2026-11-11 with the prompt
`Reply with exactly this JSON and nothing else: {"action":"answer","message":"ok"}`.
Lines are trimmed to the fields losql reads; working-directory paths are replaced.

| File | Source |
| --- | --- |
| `claude.success.ndjson`, `claude.error.ndjson` | Claude Code 2.1.322, `--output-format stream-json --verbose`; the error run used an unknown model |
| `codex.error.ndjson` | codex-cli 0.167.1, `exec --json`, real usage-limit failure |
| `codex.success.ndjson` | written by hand from the Codex `exec --json` event schema; the account was over its usage limit when the others were captured |
| `opencode.success.ndjson`, `opencode.error.ndjson` | OpenCode 2.2.7, `run --format json`; the error run used an unknown model |
| `antigravity.success.ndjson`, `antigravity.error.ndjson` | Antigravity 1.5.5, `--output-format stream-json`; the error run used an unknown model |
| `opencode.models.txt`, `antigravity.models.txt` | first lines of `opencode models` and `antigravity models` |
