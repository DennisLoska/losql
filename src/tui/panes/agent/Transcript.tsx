import { type BoxRenderable, TextAttributes } from "@opentui/core";
import {
  createComputed,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  Switch,
} from "solid-js";
import type { TurnView } from "../../context/agent";
import { useTheme } from "../../context/theme";
import { printable } from "../../ui/printable";
import { Shimmer } from "../../ui/shimmer";
import { Spinner } from "../../ui/spinner";
import {
  highlightSqlCardRows,
  ProposalCardLine,
  type SqlHighlightPiece,
} from "./ProposalCard";
import { type TranscriptLine, turnTranscriptLines } from "./transcript-model";

export interface TranscriptHandle {
  scrollBy(delta: number): void;
  scrollPage(direction: 1 | -1): void;
  scrollToTop(): void;
  scrollToBottom(): void;
  scrollToProposal(proposalId: number): void;
}

interface RenderedTranscriptLine {
  line: TranscriptLine;
  who: "you" | "agent";
  pieces?: SqlHighlightPiece[];
  proposalId?: number | null;
}

interface TurnLineCacheEntry {
  turn: TurnView;
  width: number;
  providerKey: string;
  items: RenderedTranscriptLine[];
}

export function Transcript(props: {
  turns: TurnView[];
  provider: { label: string; binary: string; installHint: string } | null;
  selectedProposalId: number | null;
  onReady?: (handle: TranscriptHandle) => void;
}): JSX.Element {
  const theme = useTheme();
  let boxRef: BoxRenderable | null = null;
  const [boxDims, setBoxDims] = createSignal({ width: 41, height: 32 });
  const [scrollTop, setScrollTop] = createSignal(0);
  const [following, setFollowing] = createSignal(true);

  const cache = new Map<number, TurnLineCacheEntry>();

  const viewportHeight = createMemo(() => {
    const dims = boxDims();
    return Math.max(1, boxRef && boxRef.height > 0 ? boxRef.height : dims.height);
  });

  const innerWidth = createMemo(() => {
    const dims = boxDims();
    const boxW = boxRef && boxRef.width > 0 ? boxRef.width : dims.width;
    return Math.max(1, boxW - 2);
  });

  const allLines = createMemo<RenderedTranscriptLine[]>(() => {
    const w = innerWidth();
    const prov = props.provider;
    const provKey = prov ? `${prov.label}:${prov.binary}:${prov.installHint}` : "";
    const out: RenderedTranscriptLine[] = [];
    const seenIds = new Set<number>();

    for (const turn of props.turns) {
      seenIds.add(turn.id);
      const cached = cache.get(turn.id);
      if (
        cached &&
        cached.turn === turn &&
        cached.width === w &&
        cached.providerKey === provKey
      ) {
        for (let i = 0; i < cached.items.length; i++) {
          out.push(cached.items[i]!);
        }
      } else {
        const rawLines = turnTranscriptLines(turn, w, prov);
        let currentWho: "you" | "agent" = "you";
        const items: RenderedTranscriptLine[] = new Array(rawLines.length);
        for (let i = 0; i < rawLines.length; i++) {
          const l = rawLines[i]!;
          if (l.kind === "label") {
            currentWho = l.who;
          }
          const next = rawLines[i + 1];
          const attachedProposalId =
            l.kind === "text" && l.tone === "muted" && next?.kind === "hint"
              ? next.proposalId
              : null;
          items[i] = { line: l, who: currentWho, proposalId: attachedProposalId };
        }

        let idx = 0;
        while (idx < rawLines.length) {
          const first = rawLines[idx]!;
          if (first.kind === "sql") {
            const propId = first.proposalId;
            let end = idx + 1;
            while (end < rawLines.length) {
              const cur = rawLines[end]!;
              if (cur.kind !== "sql" || cur.proposalId !== propId) break;
              end++;
            }
            const sqlRows = rawLines.slice(idx, end) as Extract<TranscriptLine, { kind: "sql" }>[];
            const highlighted = highlightSqlCardRows(sqlRows);
            for (let k = idx; k < end; k++) {
              items[k]!.pieces = highlighted[k - idx];
            }
            idx = end;
          } else {
            idx++;
          }
        }

        for (let i = 0; i < items.length; i++) {
          out.push(items[i]!);
        }
        cache.set(turn.id, { turn, width: w, providerKey: provKey, items });
      }
    }

    if (cache.size > seenIds.size) {
      for (const id of cache.keys()) {
        if (!seenIds.has(id)) {
          cache.delete(id);
        }
      }
    }

    return out;
  });

  const maxScroll = createMemo(() =>
    Math.max(0, allLines().length - viewportHeight()),
  );

  let prevTurnCount = 0;

  createComputed(() => {
    allLines();
    const turns = props.turns;
    const max = maxScroll();

    if (turns.length === 0) {
      prevTurnCount = 0;
      setFollowing(true);
      setScrollTop(0);
      return;
    }

    if (turns.length > prevTurnCount) {
      setFollowing(true);
    }

    prevTurnCount = turns.length;

    if (following()) {
      setScrollTop(max);
    } else {
      setScrollTop((prev) => Math.max(0, Math.min(max, prev)));
    }
  });

  const effectiveScrollTop = createMemo(() => {
    const max = maxScroll();
    if (following()) return max;
    return Math.max(0, Math.min(max, scrollTop()));
  });

  const visibleSlice = createMemo(() => {
    const lines = allLines();
    const start = effectiveScrollTop();
    const height = viewportHeight();
    return lines.slice(start, Math.min(lines.length, start + height));
  });

  const handle: TranscriptHandle = {
    scrollBy(delta: number) {
      const max = maxScroll();
      const current = effectiveScrollTop();
      const next = Math.max(0, Math.min(max, current + delta));
      setScrollTop(next);
      if (delta < 0 && next < max) {
        setFollowing(false);
      } else if (next >= max) {
        setFollowing(true);
      }
    },
    scrollPage(direction: 1 | -1) {
      const half = Math.max(1, Math.floor(viewportHeight() / 2));
      handle.scrollBy(direction * half);
    },
    scrollToTop() {
      const max = maxScroll();
      setScrollTop(0);
      if (max > 0) {
        setFollowing(false);
      }
    },
    scrollToBottom() {
      setFollowing(true);
      setScrollTop(maxScroll());
    },
    scrollToProposal(proposalId: number) {
      const lines = allLines();
      let firstIdx = -1;
      let lastIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!.line;
        if (
          (l.kind === "sql" || l.kind === "hint") &&
          l.proposalId === proposalId
        ) {
          if (firstIdx === -1) firstIdx = i;
          lastIdx = i;
        }
      }
      if (firstIdx === -1) return;
      const height = viewportHeight();
      const max = maxScroll();
      const cur = effectiveScrollTop();
      let next = cur;
      if (firstIdx < cur) {
        next = firstIdx;
      } else if (lastIdx >= cur + height) {
        next = Math.max(0, lastIdx - height + 1);
      }
      next = Math.max(0, Math.min(max, next));
      setScrollTop(next);
      setFollowing(next >= max);
    },
  };

  props.onReady?.(handle);

  return (
    <box
      ref={(el: BoxRenderable) => {
        boxRef = el;
        if (el.width > 0 && el.height > 0) {
          setBoxDims({ width: el.width, height: el.height });
        }
      }}
      onSizeChange={() => {
        if (boxRef && boxRef.width > 0 && boxRef.height > 0) {
          setBoxDims({ width: boxRef.width, height: boxRef.height });
        }
      }}
      flexGrow={1}
      width="100%"
      height="100%"
      flexDirection="column"
    >
      <For each={visibleSlice()}>
        {(item) => {
          const line = item.line;
          const turnBarColor = () =>
            item.who === "you" ? theme.color("secondary") : theme.color("primary");

          return (
            <Switch>
              <Match when={line.kind === "blank"}>
                <box height={1} width="100%" flexShrink={0} />
              </Match>
              <Match when={line.kind === "label"}>
                {(() => {
                  const lbl = line as Extract<TranscriptLine, { kind: "label" }>;
                  return (
                    <box height={1} width="100%" flexShrink={0} flexDirection="row">
                      <text fg={turnBarColor()} flexShrink={0}>
                        {"┃ "}
                      </text>
                      <text
                        fg={
                          lbl.who === "you"
                            ? theme.color("secondary")
                            : theme.color("primary")
                        }
                        attributes={TextAttributes.BOLD}
                        flexShrink={0}
                      >
                        {lbl.who}
                      </text>
                    </box>
                  );
                })()}
              </Match>
              <Match when={line.kind === "text"}>
                {(() => {
                  const txt = line as Extract<TranscriptLine, { kind: "text" }>;
                  const fg = () => {
                    if (txt.tone === "error") return theme.color("error");
                    if (txt.tone === "muted") return theme.color("textMuted");
                    return theme.color("text");
                  };
                  const barFg = () =>
                    item.proposalId !== null &&
                    item.proposalId !== undefined &&
                    props.selectedProposalId === item.proposalId
                      ? theme.color("accent")
                      : turnBarColor();
                  return (
                    <box height={1} width="100%" flexShrink={0} flexDirection="row" overflow="hidden">
                      <text fg={barFg()} flexShrink={0}>
                        {"┃ "}
                      </text>
                      <text fg={fg()} wrapMode="none" flexShrink={0}>
                        {printable(txt.text)}
                      </text>
                    </box>
                  );
                })()}
              </Match>
              <Match when={line.kind === "step"}>
                {(() => {
                  const stp = line as Extract<TranscriptLine, { kind: "step" }>;
                  return (
                    <box height={1} width="100%" flexShrink={0} flexDirection="row">
                      <text fg={turnBarColor()} flexShrink={0}>
                        {"┃ "}
                      </text>
                      <text fg={theme.color("textMuted")} flexShrink={0}>
                        {printable(stp.text)}
                      </text>
                    </box>
                  );
                })()}
              </Match>
              <Match when={line.kind === "sql"}>
                {(() => {
                  const sqlLine = line as Extract<TranscriptLine, { kind: "sql" }>;
                  const propId = sqlLine.proposalId;
                  return (
                    <ProposalCardLine
                      kind="sql"
                      text={sqlLine.text}
                      continuation={sqlLine.continuation === true}
                      pieces={item.pieces}
                      selected={propId !== null && props.selectedProposalId === propId}
                      turnBarColor={turnBarColor()}
                    />
                  );
                })()}
              </Match>
              <Match when={line.kind === "hint"}>
                {(() => {
                  const hintLine = line as Extract<TranscriptLine, { kind: "hint" }>;
                  return (
                    <ProposalCardLine
                      kind="hint"
                      text={hintLine.text}
                      selected={props.selectedProposalId === hintLine.proposalId}
                      turnBarColor={turnBarColor()}
                    />
                  );
                })()}
              </Match>
              <Match when={line.kind === "status"}>
                {(() => {
                  const st = line as Extract<TranscriptLine, { kind: "status" }>;
                  return (
                    <box height={1} width="100%" flexShrink={0} flexDirection="row">
                      <text fg={turnBarColor()} flexShrink={0}>
                        {"┃ "}
                      </text>
                      <Spinner />
                      <text flexShrink={0}>{" "}</text>
                      <Shimmer
                        text={
                          st.activity === "thinking"
                            ? "thinking…"
                            : "running a query…"
                        }
                      />
                    </box>
                  );
                })()}
              </Match>
            </Switch>
          );
        }}
      </For>
    </box>
  );
}
