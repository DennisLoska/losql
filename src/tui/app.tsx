import { render } from "@opentui/solid";
import { createSignal, Show } from "solid-js";
import { VimTextarea } from "./components/vim-textarea";
import { getTreeSitterClient, type KeyEvent } from "@opentui/core";
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
  const [hideReport, setHideReport] = createSignal(true);

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

  return (
    <box height="100%" width="100%" flexDirection="row">
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
          borderColor={focus() === "editor" ? "orange" : "white"}
          minHeight="5%"
          maxHeight="40%"
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
          borderColor={focus() === "results" ? "orange" : "white"}
          border
          height="auto"
          flexGrow={1}
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
          focusedBorderColor="orange"
          border
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
