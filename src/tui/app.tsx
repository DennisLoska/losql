import { render, useKeyboard } from "@opentui/solid";
import { createSignal, Show } from "solid-js";
import { VimTextarea } from "./components/vim-textarea";
import { getTreeSitterClient, SyntaxStyle, type KeyEvent } from "@opentui/core";
import { fetch } from "bun";
import { tokyoNightStyle } from "./theme";

type SqlResponse = {
  results?: Record<string, unknown>[] | null;
  report?: Record<string, unknown>[] | null;
  error?: string | null;
};

const client = getTreeSitterClient();
await client.initialize();

// Unfortunately there is no official parser for SQL yet so that's
// as good as it gets! The wasm and highlights from m-novikov are
// not compatible / broken so I had to define highlights manually
const sqlHighlightsPath = new URL(
  "./sql-parser/queries/sql-highlights.scm",
  import.meta.url,
).pathname;

client.addFiletypeParser({
  filetype: "sql",
  wasm: "https://github.com/m-novikov/tree-sitter-sql/raw/main/docs/tree-sitter-sql.wasm",
  queries: {
    highlights: [sqlHighlightsPath],
  },
});

const App = () => {
  const [query, setQuery] = createSignal("SELECT * FROM calls LIMIT 5;");
  const [result, setResult] = createSignal<SqlResponse | null>(null);
  const [focus, setFocus] = createSignal("editor");
  const [help, setHelp] = createSignal(false);
  const [hideReport, setHideReport] = createSignal(true);

  useKeyboard((key) => {
    if (key.name === "?") {
      setHelp((prev) => !prev);
    }
  });

  function handleEditor(key: KeyEvent) {
    // Ctrl+s to execute query
    if (key.ctrl && key.name === "s") {
      executeQuery();
    }

    if (key.shift && key.name === "j") {
      setFocus("results");
    }

    if (key.shift && key.name === "l" && !hideReport()) {
      setFocus("report");
    }

    if (key.shift && key.name === "e") {
      setHideReport(!hideReport());
      if (hideReport() === false) setFocus("report");
    }
  }

  function handleResults(key: KeyEvent) {
    if (key.shift && key.name === "k") {
      setFocus("editor");
    }

    if (key.shift && key.name === "l" && !hideReport()) {
      setFocus("report");
    }

    if (key.shift && key.name === "e") {
      setHideReport(!hideReport());
      if (hideReport() === false) setFocus("report");
    }
  }

  function handleReport(key: KeyEvent) {
    if (key.shift && key.name === "h") {
      setFocus("editor");
    }
    if (key.shift && key.name === "e") {
      setHideReport(!hideReport());
      setFocus("editor");
    }
  }

  function handleError(key: KeyEvent) {
    if (key.shift && key.name === "k") {
      setFocus("editor");
    }

    if (key.shift && key.name === "l") {
      setFocus("report");
    }
  }

  async function executeQuery() {
    const res = await fetch("http://localhost:3000/api/sql", {
      method: "POST",
      body: JSON.stringify({ query: query().trim() }),
    });

    if (!res.ok) {
      setResult({
        results: null,
        report: null,
        error: JSON.stringify({ message: res.statusText, code: res.status }),
      });
      return;
    }

    const json = (await res.json()) as SqlResponse;

    setHideReport(false);
    setResult(json as SqlResponse);
  }

  const helpContent = `
# Key Shortcuts

- \`<?>\`                  - Show help

- \`<CTRL-s>\`             - Execute query (Editor pane)
- \`<SHIFT-e>\`            - Toggle Query Plan
- \`<SHIFT-h,j,k,l>\`      - Navigate between panels
          `;

  return (
    <box
      backgroundColor="#1a1b26"
      borderColor="#565f89"
      borderStyle="double"
      height="100%"
      width="100%"
      flexDirection="row"
    >
      <Show when={help()}>
        <box
          position="absolute"
          height="40%"
          width="25%"
          zIndex={1}
          left="40%"
          top="30%"
          padding={1}
          paddingTop={0}
          border
          borderStyle="double"
          borderColor="#565f89"
          backgroundColor="#1a1b26"
        >
          <code
            content={helpContent}
            syntaxStyle={tokyoNightStyle}
            filetype="markdown"
          />
        </box>
      </Show>
      <box
        flexDirection="column"
        justifyContent="space-between"
        width="70%"
        flexGrow={1}
        paddingLeft={1}
        paddingRight={1}
      >
        <box
          border
          focusedBorderColor="orange"
          borderColor={focus() === "editor" ? "orange" : "#565f89"}
          borderStyle="heavy"
          minHeight="7%"
          maxHeight="40%"
          flexWrap="no-wrap"
          paddingLeft={1}
        >
          <VimTextarea
            focused={focus() === "editor"}
            initialValue={query()}
            cursorColor="orange"
            onBufferChange={setQuery}
            onNormalModeKeyDown={handleEditor}
            height="auto"
            filetype="sql"
            syntaxStyle={tokyoNightStyle}
          />
        </box>
        <box
          borderColor={focus() === "results" ? "orange" : "#565f89"}
          border
          borderStyle="heavy"
          height="auto"
          maxHeight="93%"
          flexShrink={1}
          flexGrow={1}
          flexWrap="wrap"
          overflow="scroll"
        >
          <Show when={!result()?.error}>
            <VimTextarea
              focused={focus() === "results"}
              value={JSON.stringify(result()?.results, null, 2)}
              cursorColor="orange"
              onNormalModeKeyDown={handleResults}
              filetype="typescript"
              syntaxStyle={tokyoNightStyle}
              height="auto"
            />
          </Show>
          <Show when={result()?.error}>
            <VimTextarea
              focused={focus() === "results"}
              value={JSON.stringify(result()?.error, undefined, 2)}
              cursorColor="orange"
              onNormalModeKeyDown={handleError}
              filetype="typescript"
              syntaxStyle={tokyoNightStyle}
              height="auto"
            />
          </Show>
        </box>
      </box>

      <Show when={!hideReport()}>
        <box
          borderColor={focus() === "report" ? "orange" : "#565f89"}
          focusedBorderColor="orange"
          border
          borderStyle="heavy"
          width="30%"
          height="100%"
          overflow="scroll"
          flexDirection="column"
        >
          <VimTextarea
            focused={focus() === "report"}
            value={JSON.stringify(result()?.report?.[0], undefined, 2)}
            cursorColor="orange"
            onNormalModeKeyDown={handleReport}
            filetype="typescript"
            syntaxStyle={tokyoNightStyle}
            height="auto"
          />
        </box>
      </Show>
    </box>
  );
};

render(() => <App />);
