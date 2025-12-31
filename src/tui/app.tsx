import { render } from "@opentui/solid";
import { createSignal, Show } from "solid-js";
import { VimTextarea } from "./components/vim-textarea";
import type { KeyEvent } from "@opentui/core";
import { fetch } from "bun";

const App = () => {
  const [query, setQuery] = createSignal("SELECT * FROM calls LIMIT 5;");
  const [result, setResult] = createSignal<Record<string, unknown>[] | null>(
    null,
  );

  async function execute(key: KeyEvent) {
    if (!(key.name === "s" && key.ctrl)) return;

    const res = await fetch("http://localhost:3000/api/sql", {
      method: "POST",
      body: JSON.stringify({ query: query().trim() }),
    });

    if (!res.ok) return;
    setResult(await res.json());
  }

  return (
    <box height="100%" flexDirection="column">
      <box border width="100%" flexGrow={1} paddingLeft={1} paddingRight={1}>
        <VimTextarea
          focused
          initialValue={query()}
          cursorColor="orange"
          onBufferChange={setQuery}
          onKeyDown={execute}
        />
        <box></box>
      </box>

      <box
        border
        width="100%"
        minHeight="25%"
        maxHeight="40%"
        overflow="scroll"
        flexDirection="column"
      >
        <Show when={result()?.results}>
          <text>{JSON.stringify(result().results, null, 2)}</text>
        </Show>
        <Show when={result()?.error}>
          <text>{JSON.stringify(result().error, null, 2)}</text>
        </Show>
      </box>
    </box>
  );
};

render(() => <App />);
