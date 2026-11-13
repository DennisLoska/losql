import { TextAttributes } from "@opentui/core";
import {
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { PROVIDERS } from "../../../core/agent/providers";
import { copyToClipboard } from "../../../core/clipboard";
import type { Key } from "../../../core/vim/keys";
import { useAgent } from "../../context/agent";
import { useCommands } from "../../context/commands";
import { useDeps } from "../../context/deps";
import { useFocus } from "../../context/focus";
import { useKeys } from "../../context/keys";
import { useSession } from "../../context/session";
import { useStatus } from "../../context/status";
import { useTheme } from "../../context/theme";
import { cellWidth } from "../../ui/cells";
import { InputLine } from "../../ui/input-line";
import { createLineInput } from "../../ui/line-input";
import { printable } from "../../ui/printable";
import { PaneFrame } from "../frame";
import { Transcript, type TranscriptHandle } from "./Transcript";
import { wrapText } from "./transcript-model";

export function AgentPane(): JSX.Element {
  const deps = useDeps();
  const focus = useFocus();
  const theme = useTheme();
  const keys = useKeys();
  const status = useStatus();
  // Set when the Pane is disposed: a copy that finishes later changes nothing.
  let disposed = false;
  const commands = useCommands();
  const session = useSession();
  const agent = useAgent();

  const [mode, setMode] = createSignal<"normal" | "insert">("normal");
  const [pendingG, setPendingG] = createSignal(false);
  const input = createLineInput({ multiline: true });
  let transcriptHandle: TranscriptHandle | null = null;

  const isSetupState = createMemo(() => {
    const prov = agent.provider();
    return prov === null || !prov.installed;
  });

  const providerMeta = createMemo(() => {
    const prov = agent.provider();
    if (!prov) return null;
    const adapter = PROVIDERS[prov.id];
    return {
      label: prov.label,
      binary: adapter.binaries[0] ?? prov.id,
      installHint: prov.installHint,
    };
  });

  const handleEnterInSetup = () => {
    if (commands.registry.byId("provider.pick")) {
      void commands.run("provider.pick", "");
    } else {
      status.say('Run "losql providers" to see what is supported');
    }
  };

  const onKey = (key: Key): boolean => {
    if (key.ctrl && !key.meta && key.name === "c" && agent.running()) {
      return false;
    }

    const isPlain = !key.ctrl && !key.meta;

    if (mode() === "insert") {
      if (isPlain && key.name === "escape") {
        setMode("normal");
        return true;
      }
      if (isPlain && key.name === "enter") {
        const raw = input.text();
        if (raw.trim().length === 0) {
          return true;
        }
        // The Agent alone decides whether it takes the question; the input is cleared only then.
        const asked = agent.ask({ intent: "ask", text: raw });
        if (asked.accepted) {
          input.set("");
        }
        return true;
      }
      if (key.ctrl && !key.meta && key.name === "c") {
        setMode("normal");
        return true;
      }
      if (key.ctrl && !key.meta && key.name === "h") {
        input.feed({ ...key, name: "backspace", ctrl: false });
        return true;
      }
      input.feed(key);
      return true;
    }

    // Normal mode
    if (pendingG()) {
      setPendingG(false);
      if (isPlain && key.text === "g") {
        transcriptHandle?.scrollToTop();
        return true;
      }
      return false;
    }

    if (isPlain && key.text === "g") {
      setPendingG(true);
      return true;
    }

    if (isPlain && (key.text === "j" || key.name === "down")) {
      transcriptHandle?.scrollBy(1);
      return true;
    }

    if (isPlain && (key.text === "k" || key.name === "up")) {
      transcriptHandle?.scrollBy(-1);
      return true;
    }

    if (key.ctrl && !key.meta && key.name === "d") {
      transcriptHandle?.scrollPage(1);
      return true;
    }

    if (key.ctrl && !key.meta && key.name === "u") {
      transcriptHandle?.scrollPage(-1);
      return true;
    }

    if (isPlain && key.text === "G") {
      transcriptHandle?.scrollToBottom();
      return true;
    }

    if (isPlain && (key.text === "{" || key.text === "}")) {
      const dir = key.text === "{" ? -1 : 1;
      agent.select(dir);
      const sel = agent.selected();
      if (sel) {
        transcriptHandle?.scrollToProposal(sel.id);
      }
      return true;
    }

    if (isPlain && key.name === "enter") {
      if (isSetupState()) {
        handleEnterInSetup();
        return true;
      }
      const sel = agent.selected();
      if (sel) {
        agent.accept(sel);
      }
      return true;
    }

    if (isPlain && key.text === "r") {
      const sel = agent.selected();
      if (sel) {
        void agent.run(sel);
      }
      return true;
    }

    if (isPlain && key.text === "y") {
      const sel = agent.selected();
      if (sel) {
        void copyToClipboard(sel.sql, {
          write: deps.write,
          which: deps.which,
          exec: deps.exec,
        }).then((res) => {
          if (!disposed && !res.ok) status.say(`Could not copy: ${printable(res.reason)}`, "error");
        });
      }
      return true;
    }

    if (isPlain && (key.text === "i" || key.text === "a")) {
      if (!isSetupState()) {
        setMode("insert");
      }
      return true;
    }

    return false;
  };

  keys.setPaneHandler("agent", onKey);
  keys.setPasteHandler("agent", (pasted) => {
    if (!isSetupState()) {
      input.paste(pasted);
    }
  });
  onCleanup(() => {
    disposed = true;
    keys.setPaneHandler("agent", null);
    keys.setPasteHandler("agent", null);
  });

  status.register("agent", () => ({
    mode: mode() === "insert" ? "INSERT" : "NORMAL",
    pending: pendingG() ? "g" : "",
    position: "",
  }));

  commands.register({
    id: "agent.toggle",
    title: "Agent: show, focus or hide",
    group: "Agent",
    keys: "a a",
    run: (ctx) => {
      ctx.focus.toggle("agent");
    },
  });

  commands.register({
    id: "agent.ask",
    title: "Ask the agent",
    group: "Agent",
    ex: ["ask"],
    keys: "a i",
    run: async (_ctx, args) => {
      const trimmed = args.trim();
      if (trimmed.length > 0) {
        await agent.ask({ intent: "ask", text: trimmed });
      } else {
        focus.focus("agent");
        if (!isSetupState()) {
          setMode("insert");
        }
      }
    },
  });

  commands.register({
    id: "agent.explain",
    title: "Explain the statement",
    group: "Agent",
    keys: "a e",
    run: async () => {
      await agent.ask({ intent: "explain" });
    },
  });

  commands.register({
    id: "agent.fix",
    title: "Fix the last error",
    group: "Agent",
    keys: "a f",
    when: () => session.lastError() !== null,
    run: async () => {
      await agent.ask({ intent: "fix" });
    },
  });

  commands.register({
    id: "agent.optimize",
    title: "Optimize the statement",
    group: "Agent",
    keys: "a o",
    run: async () => {
      await agent.ask({ intent: "optimize" });
    },
  });

  commands.register({
    id: "agent.new",
    title: "New conversation",
    group: "Agent",
    keys: "a n",
    run: () => {
      agent.reset();
    },
  });

  const providerSummary = createMemo(() => {
    const prov = agent.provider();
    if (!prov) return null;
    const m = agent.model() ?? "default";
    return `${printable(prov.id)} · ${printable(m)}`;
  });

  const titleElement = (
    <box height={1} width="100%" flexDirection="row" gap={2}>
      <text fg={theme.color("textMuted")} attributes={TextAttributes.BOLD} flexShrink={0}>
        AGENT
      </text>
      <Show when={providerSummary() !== null}>
        <text fg={theme.color("textMuted")} flexShrink={0}>
          {providerSummary()!}
        </text>
      </Show>
    </box>
  );

  return (
    <PaneFrame pane="agent" title={titleElement}>
      <Switch>
        <Match when={agent.provider() === null}>
          <box flexDirection="column" gap={1} paddingTop={1}>
            <text fg={theme.color("text")}>No agent is set up.</text>
            <box flexDirection="column">
              <For
                each={wrapText(
                  "Press Enter to choose one of the coding CLIs installed on this machine.",
                  41,
                )}
              >
                {(line) => <text fg={theme.color("textMuted")}>{line}</text>}
              </For>
            </box>
          </box>
        </Match>
        <Match when={agent.provider() !== null && !agent.provider()!.installed}>
          <box flexDirection="column" gap={1} paddingTop={1}>
            <box flexDirection="column">
              <For
                each={wrapText(
                  `${printable(agent.provider()!.label)} is not installed.`,
                  41,
                )}
              >
                {(line) => <text fg={theme.color("text")}>{line}</text>}
              </For>
            </box>
            <box flexDirection="column">
              <For
                each={(() => {
                  const hint = printable(agent.provider()!.installHint);
                  if (cellWidth(hint) <= 41) return [hint];
                  const colonIdx = hint.indexOf(": ");
                  if (colonIdx > 0) {
                    const head = hint.slice(0, colonIdx + 1);
                    const tail = hint.slice(colonIdx + 2);
                    if (cellWidth(tail) <= 41) {
                      return [...wrapText(head, 41), tail];
                    }
                  }
                  return wrapText(hint, 41);
                })()}
              >
                {(line) => <text fg={theme.color("textMuted")}>{line}</text>}
              </For>
            </box>
            <text fg={theme.color("textMuted")}>Press Enter to choose another.</text>
          </box>
        </Match>
        <Match when={agent.provider()?.installed}>
          <box flexGrow={1} width="100%" height="100%" flexDirection="column">
            <Transcript
              turns={agent.turns()}
              provider={providerMeta()}
              selectedProposalId={agent.selected()?.id ?? null}
              onReady={(h) => {
                transcriptHandle = h;
              }}
            />
            <InputLine
              input={input}
              prefix="> "
              placeholder="ask the agent"
              active={focus.pane() === "agent" && mode() === "insert"}
            />
          </box>
        </Match>
      </Switch>
    </PaneFrame>
  );
}
