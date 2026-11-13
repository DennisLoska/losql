import { createEffect, createMemo, type JSX, Show } from "solid-js";
import { resultToJson } from "../../../core/db/format";
import type { Result } from "../../../core/db/types";
import { useConfig } from "../../context/config";
import { useTheme } from "../../context/theme";
import { printable } from "../../ui/printable";
import { VimTextarea, type VimTextareaHandle } from "../editor/VimTextarea";

function escapeJsonUnsafe(json: string): string {
  return json.replace(
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function JsonView(props: {
  result: Result;
  active: boolean;
  onReady: (handle: VimTextareaHandle) => void;
}): JSX.Element {
  const config = useConfig();
  const theme = useTheme();

  const maxRows = createMemo(() => Math.max(0, config.config().results.jsonMaxRows));
  const totalRows = createMemo(() => props.result.rows.length);
  const shownRows = createMemo(() => Math.min(totalRows(), maxRows()));
  const omitted = createMemo(() => shownRows() < totalRows());

  const jsonText = createMemo(() => {
    const sliced: Result =
      shownRows() < totalRows()
        ? { ...props.result, rows: props.result.rows.slice(0, shownRows()) }
        : props.result;
    return printable(escapeJsonUnsafe(resultToJson(sliced)), { keepNewlines: true });
  });

  let handleRef: VimTextareaHandle | null = null;
  let initialRendered = false;

  createEffect(() => {
    const text = jsonText();
    if (handleRef && initialRendered) {
      handleRef.setText(text);
    }
    initialRendered = true;
  });

  return (
    <box flexGrow={1} width="100%" height="100%" flexDirection="column">
      <Show when={omitted()}>
        <box height={1} width="100%" flexShrink={0}>
          <text fg={theme.color("textMuted")}>
            {`showing ${shownRows()} of ${totalRows()} rows`}
          </text>
        </box>
      </Show>
      <box flexGrow={1} width="100%" flexDirection="column">
        <VimTextarea
          language="json"
          initialText={jsonText()}
          readOnly
          active={props.active}
          lineNumbers={false}
          onReady={(h) => {
            handleRef = h;
            props.onReady(h);
          }}
        />
      </box>
    </box>
  );
}
