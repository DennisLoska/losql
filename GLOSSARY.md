# losql

losql is a vim-first SQL client for the terminal in which an agent can inspect the database and draft SQL for the user. This glossary fixes the words used in code, docs and UI.

## Language

### Database

**Connection**:
A saved, named way to reach one database: a dialect plus a URL or file path.
_Avoid_: datasource, profile, database (for the saved entry)

**Session**:
The live link to one Connection while losql is open.
_Avoid_: connection (for the live link), client

**Driver**:
The dialect-specific implementation that runs Statements and reads the Schema snapshot for a Session.
_Avoid_: adapter, client, backend

**Schema snapshot**:
The namespaces, Relations and columns read from the database at one point in time.
_Avoid_: catalog, metadata

**Relation**:
A table or a database view.
_Avoid_: table (when database views are included)

### Editing and running

**Buffer**:
One editable SQL text in the editor, optionally backed by a file.
_Avoid_: tab, document, query

**Statement**:
One SQL command inside a Buffer, delimited by semicolons.
_Avoid_: query

**Run**:
One execution of a Statement against the Session, ending in a Result or an error.
_Avoid_: execution, job

**Result**:
What a Run returned: columns and rows, or an affected-row count.
_Avoid_: result set, response, output

**Result view**:
One way of displaying a Result: Table, JSON or Record.
_Avoid_: mode, tab, view (alone; it collides with database views)

**Record**:
One row of a Result shown as a vertical list of fields.
_Avoid_: detail, row view

### Agent

**Provider**:
An installed coding-agent CLI (Claude Code, Codex, OpenCode, Antigravity) that losql drives to answer Turns.
_Avoid_: backend, LLM, model (for the CLI)

**Model**:
A model identifier offered by a Provider.

**Agent**:
The loop inside losql that drives a Provider through Steps to answer a Turn.
_Avoid_: assistant, AI, bot

**Conversation**:
The ordered Turns between the user and the Agent within one Session.
_Avoid_: session, chat, thread

**Turn**:
One user request to the Agent together with every Step taken to answer it.
_Avoid_: request, prompt, message

**Step**:
One action the Agent takes during a Turn: a read-only query, a describe, or the final answer.
_Avoid_: tool call, iteration

**Proposal**:
SQL the Agent offers as the answer to a Turn; it does not run until the user accepts it.
_Avoid_: suggestion, completion, patch

### Interface

**Pane**:
A focusable region of the workspace: Schema, Editor, Results or Agent.
_Avoid_: panel, window, split

**Command**:
A named action reachable from the command line, the palette or a key.
_Avoid_: action, handler

**Leader**:
The prefix key that opens the key menu.

**Theme**:
A named set of colour tokens.

**Transparent**:
The display setting in which Pane backgrounds are not painted, so the terminal background shows through.
