import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, For, type JSX } from "solid-js";
import type { Command, LeaderNode } from "../../core/commands/registry";
import type { AppApi } from "../app";
import { useLayer } from "../context/keys";
import { useTheme } from "../context/theme";
import { cellWidth, cutCells, graphemes } from "./cells";
import { keyLabel } from "./key-label";

import { printable } from "./printable";

type HelpItem =
  | { kind: "heading"; text: string }
  | { kind: "entry"; key: string; description: string }
  | { kind: "blank" };

type RenderedHelpRow =
  | { kind: "heading"; text: string }
  | { kind: "entry"; keyText: string; descLine: string }
  | { kind: "blank" };

const KEY_CAP = 30;
function truncateCells(text: string, maxCells: number): string {
  if (maxCells <= 0) return "";
  return cutCells(text, maxCells, { ellipsis: true });
}

function padCells(text: string, width: number): string {
  const w = cellWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
}

function splitLongWord(word: string, width: number): string[] {
  const parts: string[] = [];
  let part = "";
  let partWidth = 0;
  for (const { segment } of graphemes.segment(word)) {
    const sw = cellWidth(segment);
    if (part.length > 0 && partWidth + sw > width) {
      parts.push(part);
      part = segment;
      partWidth = sw;
    } else {
      part += segment;
      partWidth += sw;
    }
  }
  if (part.length > 0) {
    parts.push(part);
  }
  return parts.length > 0 ? parts : [""];
}

function wrapWords(text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const width = Math.max(1, maxWidth);
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const word of words) {
    const ww = cellWidth(word);
    if (ww > width) {
      if (current.length > 0) {
        lines.push(current);
        current = "";
        currentWidth = 0;
      }
      const chunks = splitLongWord(word, width);
      for (let i = 0; i < chunks.length - 1; i++) {
        lines.push(chunks[i]!);
      }
      const last = chunks[chunks.length - 1]!;
      current = last;
      currentWidth = cellWidth(last);
    } else if (current.length === 0) {
      current = word;
      currentWidth = ww;
    } else if (currentWidth + 1 + ww <= width) {
      current += ` ${word}`;
      currentWidth += 1 + ww;
    } else {
      lines.push(current);
      current = word;
      currentWidth = ww;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}

const GLOBAL_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["ctrl+w h/j/k/l/w", "focus the Pane to the left, below, above, right, or the next one"],
  ["ctrl+h/j/k/l", "focus the Pane to the left, below, above, or right"],
  ["shift+h/j/k/l", "the same, when the Pane takes no text and no vim command is in progress"],
  ["space", "Leader: open the key menu"],
  [":", "command line"],
  ["ctrl+p", "command palette"],
  ["ctrl+c", "cancel the running Run or Turn; pressed twice within a second, quit"],
  ["F1", "help"],
];

const EDITOR_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["Enter (normal)", "run the Statement under the cursor"],
  ["Enter (visual)", "run the selected text, split into Statements and run in order"],
  ["ctrl+s / ctrl+enter", "run the Statement under the cursor"],
  ["gt / gT", "next / previous Buffer"],
  ["gJ", "join lines (plain J focuses the Results Pane)"],
  ["ctrl+n / ctrl+p (insert)", "open completion, next / previous item; Enter or Tab accepts, Esc closes"],
];

const RESULTS_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["h j k l, 0 $, gg G, ctrl+d/u", "move the cell cursor"],
  ["Tab / shift+Tab", "next / previous Result view"],
  ["Enter", "open the current row as a Record; Esc or q returns"],
  ["y", "yank the cell"],
  ["yy / Y", "yank the row as JSON"],
  ["V then y", "yank the selected rows as a JSON array"],
  ["/, n, N", "search cells"],
];

const SCHEMA_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["j k gg G", "move selection"],
  ["l / h", "expand and collapse"],
  ["Enter", "peek Relation into Results"],
  ["i", "insert the name at the editor cursor"],
  ["y", "yank the name"],
  ["/", "filter"],
  ["R", "refresh"],
];

const AGENT_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["j k gg G ctrl+d/u", "scroll the Conversation"],
  ["{ / }", "select the previous and next Proposal"],
  ["Enter", "accept the selected Proposal"],
  ["r", "accept and run the selected Proposal"],
  ["y", "yank the selected Proposal"],
  ["i", "focus the input"],
  ["Enter (input)", "send Turn"],
  ["ctrl+j (input)", "add a line"],
  ["Esc (input)", "return to normal mode"],
];

function collectLeaderCommands(nodes: LeaderNode<AppApi>[]): Command<AppApi>[] {
  const out: Command<AppApi>[] = [];
  for (const node of nodes) {
    if (node.kind === "command") {
      out.push(node.command);
    } else {
      out.push(...collectLeaderCommands(node.children));
    }
  }
  return out;
}

function buildHelpItems(api: AppApi): HelpItem[] {
  const rows: HelpItem[] = [];
  const leader = api.config.config().leader;

  const addSection = (title: string, entries: ReadonlyArray<readonly [string, string]>) => {
    if (rows.length > 0) rows.push({ kind: "blank" });
    rows.push({ kind: "heading", text: title });
    for (const [key, description] of entries) {
      rows.push({ kind: "entry", key: printable(key), description: printable(description) });
    }
  };

  addSection("Global", GLOBAL_KEYS);

  const leaderCmds = collectLeaderCommands(api.commands.registry.leaderTree(api));
  const leaderEntries: Array<readonly [string, string]> = leaderCmds
    .filter((cmd) => Boolean(cmd.keys))
    .map((cmd) => [keyLabel(cmd.keys!, leader), cmd.title] as const);
  addSection("Leader", leaderEntries);

  addSection("Editor", EDITOR_KEYS);
  addSection("Results", RESULTS_KEYS);
  addSection("Schema", SCHEMA_KEYS);
  addSection("Agent", AGENT_KEYS);

  const exEntries: Array<readonly [string, string]> = api.commands.registry
    .all()
    .filter((cmd) => cmd.ex && cmd.ex.length > 0 && cmd.ex[0])
    .map((cmd) => [`:${cmd.ex![0]!}`, cmd.title] as const);
  addSection("Commands", exEntries);

  return rows;
}

function buildHelpRows(api: AppApi, termWidth: number): { keyColWidth: number; rows: RenderedHelpRow[] } {
  const items = buildHelpItems(api);
  let widestKey = 0;
  for (const item of items) {
    if (item.kind === "entry") {
      const w = cellWidth(item.key);
      if (w > widestKey) widestKey = w;
    }
  }
  const panelWidth = Math.max(10, Math.min(76, termWidth - 4));
  const contentWidth = Math.max(1, panelWidth - 4);
  const keyColWidth = Math.max(8, Math.min(widestKey, KEY_CAP, contentWidth - 17));
  const descWidth = Math.max(1, contentWidth - keyColWidth - 1);
  const blankKey = " ".repeat(keyColWidth);

  const rows: RenderedHelpRow[] = [];
  for (const item of items) {
    if (item.kind === "blank") {
      rows.push(item);
      continue;
    }
    if (item.kind === "heading") {
      rows.push({ kind: "heading", text: truncateCells(item.text, contentWidth) });
      continue;
    }
    const truncatedKey = truncateCells(item.key, keyColWidth);
    const paddedKey = padCells(truncatedKey, keyColWidth);
    const wrapped = wrapWords(item.description, descWidth);
    for (let i = 0; i < wrapped.length; i++) {
      rows.push({
        kind: "entry",
        keyText: i === 0 ? paddedKey : blankKey,
        descLine: wrapped[i]!,
      });
    }
  }

  return { keyColWidth, rows };
}

export function HelpDialog(props: { api: AppApi; close: () => void }): JSX.Element {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const [scrollTop, setScrollTop] = createSignal(0);
  const [pendingG, setPendingG] = createSignal(false);

  const layout = createMemo(() => buildHelpRows(props.api, dimensions().width));
  const rows = createMemo(() => layout().rows);
  const keyColWidth = createMemo(() => layout().keyColWidth);
  const viewportHeight = createMemo(() => Math.max(5, Math.min(24, dimensions().height - 8)));
  const maxScroll = createMemo(() => Math.max(0, rows().length - viewportHeight()));

  const scrollTo = (target: number) => {
    setScrollTop(Math.max(0, Math.min(target, maxScroll())));
  };

  useLayer((key) => {
    if (pendingG()) {
      setPendingG(false);
      if (!key.ctrl && !key.meta && key.text === "g") {
        scrollTo(0);
        return true;
      }
    }

    if (!key.ctrl && !key.meta && key.text === "q") {
      props.close();
      return true;
    }

    if (
      (!key.ctrl && !key.meta && key.text === "j") ||
      (!key.ctrl && !key.meta && key.name === "down")
    ) {
      scrollTo(scrollTop() + 1);
      return true;
    }

    if (
      (!key.ctrl && !key.meta && key.text === "k") ||
      (!key.ctrl && !key.meta && key.name === "up")
    ) {
      scrollTo(scrollTop() - 1);
      return true;
    }

    if (key.ctrl && !key.meta && key.name === "d") {
      const half = Math.max(1, Math.floor(viewportHeight() / 2));
      scrollTo(scrollTop() + half);
      return true;
    }

    if (key.ctrl && !key.meta && key.name === "u") {
      const half = Math.max(1, Math.floor(viewportHeight() / 2));
      scrollTo(scrollTop() - half);
      return true;
    }

    if (!key.ctrl && !key.meta && key.text === "G") {
      scrollTo(maxScroll());
      return true;
    }

    if (!key.ctrl && !key.meta && key.text === "g") {
      setPendingG(true);
      return true;
    }

    return false;
  });

  const visibleRows = createMemo(() => {
    const top = Math.min(scrollTop(), maxScroll());
    return rows().slice(top, top + viewportHeight());
  });

  return (
    <box flexDirection="column" width="100%" gap={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <text fg={theme.color("text")} attributes={TextAttributes.BOLD}>
          Help
        </text>
        <text fg={theme.color("textMuted")}>q / esc</text>
      </box>

      <box flexDirection="column" width="100%">
        <For each={visibleRows()}>
          {(row) => {
            if (row.kind === "blank") {
              return <box height={1} width="100%" />;
            }
            if (row.kind === "heading") {
              return (
                <text
                  fg={theme.color("accent")}
                  bg={theme.color("overlayBackground")}
                  attributes={TextAttributes.BOLD}
                >
                  {row.text}
                </text>
              );
            }
            return (
              <box flexDirection="row" width="100%" height={1}>
                <box width={keyColWidth()} flexShrink={0}>
                  <text
                    fg={theme.color("primary")}
                    bg={theme.color("overlayBackground")}
                  >
                    {row.keyText}
                  </text>
                </box>
                <box width={1} flexShrink={0}>
                  <text bg={theme.color("overlayBackground")}>{" "}</text>
                </box>
                <text fg={theme.color("text")} bg={theme.color("overlayBackground")} flexShrink={0}>
                  {row.descLine}
                </text>
              </box>
            );
          }}
        </For>
      </box>
    </box>
  );
}

export function openHelp(api: AppApi): void {
  api.dialog.open((close) => <HelpDialog api={api} close={close} />, { width: 76 });
}
