import { render } from "@opentui/solid";
import { createSignal, Show } from "solid-js";
import { VimTextarea } from "./components/vim-textarea";
import { parseColor, SyntaxStyle, type KeyEvent } from "@opentui/core";
import { fetch } from "bun";

type SqlResponse = {
  results?: Record<string, unknown>[];
  report?: Record<string, unknown>[];
  error?: string;
};

const tokyoNightStyle = SyntaxStyle.fromStyles({
  string: { fg: parseColor("#9ece6a") },
  number: { fg: parseColor("#ff9e64") },
  "constant.builtin": { fg: parseColor("#ff9e64") },
  "punctuation.bracket": { fg: parseColor("#a9b1d6") },
  "punctuation.delimiter": { fg: parseColor("#89ddff") },
  property: { fg: parseColor("#7aa2f7") },
  keyword: { fg: parseColor("#bb9af7") },
  comment: { fg: parseColor("#565f89"), italic: true },
  function: { fg: parseColor("#7aa2f7") },
  variable: { fg: parseColor("#c0caf5") },
  operator: { fg: parseColor("#89ddff") },
  type: { fg: parseColor("#2ac3de") },
});

const App = () => {
  const [query, setQuery] = createSignal("SELECT * FROM calls LIMIT 5;");
  const [result, setResult] = createSignal<SqlResponse | null>(null);

  function handleKeyDown(key: KeyEvent) {
    // Ctrl+s to execute query
    if (key.ctrl && key.name === "s") {
      executeQuery();
      return;
    }
  }

  async function executeQuery() {
    const res = await fetch("http://localhost:3000/api/sql", {
      method: "POST",
      body: JSON.stringify({ query: query().trim() }),
    });

    if (!res.ok) return;
    setResult((await res.json()) as SqlResponse);
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
          borderColor="orange"
          minHeight="5%"
          maxHeight="35%"
          paddingLeft="1%"
        >
          <VimTextarea
            focused
            initialValue={query()}
            cursorColor="orange"
            onBufferChange={setQuery}
            onKeyDown={handleKeyDown}
            height="auto"
          />
        </box>
        <box
          border
          height="auto"
          maxHeight="95%"
          flexGrow={1}
          overflow="scroll"
        >
          <Show when={result()?.results}>
            <code
              content={JSON.stringify(result()?.results, null, 2)}
              filetype="javascript"
              syntaxStyle={tokyoNightStyle}
              width="100%"
            />
          </Show>
          <Show when={result()?.error}>
            <code
              content={JSON.stringify(result()?.error, null, 2)}
              filetype="javascript"
              syntaxStyle={tokyoNightStyle}
              width="100%"
            />
          </Show>
        </box>
      </box>

      <box
        border
        width="30%"
        height="100%"
        overflow="scroll"
        flexDirection="column"
      >
        <Show when={result()?.report}>
          <code
            content={JSON.stringify(result()?.report?.[0], undefined, 2)}
            filetype="javascript"
            syntaxStyle={tokyoNightStyle}
          />
        </Show>
      </box>
    </box>
  );
};

render(() => <App />);
