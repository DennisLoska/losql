# The Agent drives installed coding CLIs in headless mode

losql has no API keys and no model client of its own. A Provider is a coding-agent CLI the user already has installed and logged in (Claude Code, Codex, OpenCode, Antigravity). losql runs it once per Step in non-interactive print mode with its own tools disabled, sends one self-contained prompt, and reads one JSON action back. losql itself owns the loop, executes the read-only queries, and feeds the results into the next prompt.

This keeps setup to "pick an installed CLI", works the same across four vendors, keeps every database access inside losql where it can be made read-only, and is testable with a stub executable.

**Considered Options:**

- Exposing the database as an MCP server and letting each CLI run its own loop gives the model more autonomy, but each CLI configures MCP differently, the CLI's own file and shell tools stay available, and the loop is no longer ours to bound or test.
- Driving the CLIs over the Agent Client Protocol gives streaming and sessions, but only two of the four ship it natively.
- Calling vendor APIs directly needs keys and per-vendor billing setup, which is the onboarding friction this design exists to avoid.

**Consequences:** every Step pays a process start and resends the Conversation, so a Turn is slower than a native tool loop. Prompts are stateless on purpose; Provider session resume is not used.
