# In-process core instead of a loopback HTTP server

losql used to start a Bun HTTP server on port 3000 and have the TUI call it with `fetch`. The database, agent, vim and theme logic now live in plain modules under `src/core` that the TUI and the headless commands import directly. A local server bought nothing for a single-user terminal client and cost a fixed port, a second lifecycle to shut down, and JSON round trips that lost column metadata.

**Considered Options:** keeping the client/server split would allow remote or daemon use and other front ends, but nothing asks for that today, and the core modules can be put behind a server later without changing their interfaces.
