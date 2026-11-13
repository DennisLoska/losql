import { TextAttributes } from "@opentui/core";
import { createSignal, type JSX, Show } from "solid-js";
import { useLayer } from "../context/keys";
import { useTheme } from "../context/theme";
import { InputLine } from "./input-line";
import { createLineInput } from "./line-input";
import { printable } from "./printable";

export interface PromptProps {
  title: string;
  description?: string;
  placeholder?: string;
  initial?: string;
  mask?: boolean;
  validate?: (value: string) => string | null | Promise<string | null>;
}

export function DialogPrompt(
  props: PromptProps & { onSubmit: (value: string) => void },
): JSX.Element {
  const theme = useTheme();
  const input = createLineInput({ initial: props.initial });
  const [error, setError] = createSignal<string | null>(null);
  let validating = false;

  const submit = async () => {
    if (validating) return;
    const value = input.text();
    if (props.validate) {
      validating = true;
      try {
        const err = await props.validate(value);
        if (input.text() !== value) return;
        if (err) {
          setError(err);
          return;
        }
      } catch (caught) {
        if (input.text() !== value) return;
        const msg = caught instanceof Error ? caught.message : String(caught);
        setError(msg || "Validation failed");
        return;
      } finally {
        validating = false;
      }
    }
    setError(null);
    props.onSubmit(value);
  };

  useLayer(
    (key) => {
      if (!key.ctrl && !key.meta && key.name === "enter") {
        void submit();
        return true;
      }
      const before = input.text();
      const handled = input.feed(key);
      if (handled && input.text() !== before) {
        setError(null);
      }
      return handled;
    },
    {
      onPaste(text) {
        const before = input.text();
        input.paste(text);
        if (input.text() !== before) {
          setError(null);
        }
      },
    },
  );

  return (
    <box flexDirection="column" width="100%" gap={1}>
      <box flexDirection="column" width="100%">
        <box flexDirection="row" justifyContent="space-between" width="100%">
          <text fg={theme.color("text")} attributes={TextAttributes.BOLD}>
            {printable(props.title)}
          </text>
          <text fg={theme.color("textMuted")}>esc</text>
        </box>
        <Show when={props.description}>
          <text fg={theme.color("textMuted")}>{printable(props.description!, { keepNewlines: true })}</text>
        </Show>
      </box>

      <InputLine
        input={input}
        prefix="> "
        placeholder={props.placeholder}
        mask={props.mask}
      />

      <Show when={error()}>
        <text fg={theme.color("error")}>{printable(error()!, { keepNewlines: true })}</text>
      </Show>
    </box>
  );
}

