import { type BoxRenderable, TextAttributes } from "@opentui/core";
import {
  createComputed,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { copyToClipboard } from "../../../core/clipboard";
import type { Connection, SchemaSnapshot } from "../../../core/db/types";
import type { Key } from "../../../core/vim/keys";
import { useCmdline } from "../../context/commands";
import { useConfig } from "../../context/config";
import { useDeps } from "../../context/deps";
import { useFocus } from "../../context/focus";
import { useKeys } from "../../context/keys";
import { useSession } from "../../context/session";
import { useStatus } from "../../context/status";
import { useTheme } from "../../context/theme";
import { cellWidth } from "../../ui/cells";
import { printable } from "../../ui/printable";
import { Spinner } from "../../ui/spinner";
import { PaneFrame } from "../frame";
import {
  buildTree,
  defaultExpanded,
  formatColumnRow,
  peekSql,
  rowText,
  syncExpandedOnRefresh,
  type TreeRow,
  truncateCells,
} from "./tree-model";

export interface SchemaApi {
  rows(): TreeRow[];
  cursor(): number;
  filter(): string;
}

export function SchemaPane(props: {
  expose?: (api: SchemaApi) => void;
  onInsert?: (text: string) => void;
}): JSX.Element {
  const deps = useDeps();
  const config = useConfig();
  const focus = useFocus();
  const theme = useTheme();
  const keys = useKeys();
  const status = useStatus();
  // Set when the Pane is disposed: a copy that finishes later changes nothing.
  let disposed = false;
  const cmdline = useCmdline();
  const session = useSession();

  const initialSchema = untrack(() => session.schema());
  const [expanded, setExpanded] = createSignal<Set<string>>(
    initialSchema ? defaultExpanded(initialSchema) : new Set(),
  );
  const [filter, setFilter] = createSignal("");
  const [cursorSignal, setCursorSignal] = createSignal(0);
  const [pendingCount, setPendingCount] = createSignal("");
  const [pendingOp, setPendingOp] = createSignal<"" | "g">("");

  let boxRef: BoxRenderable | null = null;
  const [boxDims, setBoxDims] = createSignal({ width: 29, height: 34 });
  let prevFirstRow = 0;

  let lastConnection: Connection | null = untrack(() => session.connection());
  let lastNonNullSchema: SchemaSnapshot | null = initialSchema;
  let lastCursorRowId: string | null = null;

  createComputed(() => {
    const conn = session.connection();
    const schema = session.schema();

    if (conn !== lastConnection) {
      lastConnection = conn;
      lastNonNullSchema = schema;
      lastCursorRowId = null;
      prevFirstRow = 0;
      setFilter("");
      setCursorSignal(0);
      if (schema) {
        setExpanded(defaultExpanded(schema));
      } else {
        setExpanded(new Set<string>());
      }
      return;
    }

    if (schema !== null && schema !== lastNonNullSchema) {
      const prevSchema = lastNonNullSchema;
      lastNonNullSchema = schema;
      if (prevSchema === null) {
        setExpanded(defaultExpanded(schema));
      } else {
        setExpanded((prev) => syncExpandedOnRefresh(prevSchema, schema, prev));
      }
    }
  });

  const rows = createMemo<TreeRow[]>(() => {
    const schema = session.schema();
    if (!schema) return [];
    return buildTree(schema, expanded(), filter());
  });

  createComputed(() => {
    const currentRows = rows();
    if (currentRows.length === 0) {
      setCursorSignal(0);
      prevFirstRow = 0;
      return;
    }
    const cur = untrack(cursorSignal);
    if (lastCursorRowId !== null) {
      const atCur = currentRows[cur];
      if (atCur && atCur.id === lastCursorRowId) {
        return;
      }
      const foundIdx = currentRows.findIndex((r) => r.id === lastCursorRowId);
      if (foundIdx >= 0) {
        setCursorSignal(foundIdx);
        return;
      }
    }
    const clamped = Math.max(0, Math.min(currentRows.length - 1, cur));
    if (clamped !== cur) {
      setCursorSignal(clamped);
    }
    lastCursorRowId = currentRows[clamped]?.id ?? null;
  });

  const clampedCursor = createMemo(() => {
    const total = rows().length;
    if (total === 0) return 0;
    return Math.max(0, Math.min(total - 1, cursorSignal()));
  });

  const setCursor = (index: number, currentRows = rows()) => {
    const total = currentRows.length;
    if (total === 0) {
      lastCursorRowId = null;
      setCursorSignal(0);
      return;
    }
    const clamped = Math.max(0, Math.min(total - 1, index));
    lastCursorRowId = currentRows[clamped]?.id ?? null;
    setCursorSignal(clamped);
  };

  const moveCursor = (delta: number) => {
    const currentRows = rows();
    if (currentRows.length === 0) return;
    setCursor(clampedCursor() + delta, currentRows);
  };

  const viewportHeight = createMemo<number>(() => {
    const dims = boxDims();
    return Math.max(1, boxRef && boxRef.height > 0 ? boxRef.height : dims.height);
  });

  const viewportWidth = createMemo<number>(() => {
    const dims = boxDims();
    return Math.max(1, boxRef && boxRef.width > 0 ? boxRef.width : dims.width);
  });

  const firstRowMemo = createMemo<number>(() => {
    const total = rows().length;
    const height = viewportHeight();
    if (total === 0) {
      prevFirstRow = 0;
      return 0;
    }
    const cur = clampedCursor();
    let nextFirst = prevFirstRow;
    if (cur < nextFirst) {
      nextFirst = cur;
    } else if (cur >= nextFirst + height) {
      nextFirst = cur - height + 1;
    }
    nextFirst = Math.max(0, Math.min(Math.max(0, total - height), nextFirst));
    prevFirstRow = nextFirst;
    return nextFirst;
  });

  const visibleItems = createMemo<TreeRow[]>(() => {
    const all = rows();
    if (all.length === 0) return [];
    const start = firstRowMemo();
    const height = viewportHeight();
    return all.slice(start, start + height);
  });

  const hasNoRelations = createMemo(() => {
    const schema = session.schema();
    if (!schema) return false;
    return schema.namespaces.every((ns) => ns.relations.length === 0);
  });

  const takeCount = (): { count: number; hasExplicitCount: boolean } => {
    const raw = pendingCount();
    setPendingCount("");
    if (raw === "") return { count: 1, hasExplicitCount: false };
    const parsed = Number.parseInt(raw, 10);
    return {
      count: Number.isNaN(parsed) || parsed < 1 ? 1 : parsed,
      hasExplicitCount: true,
    };
  };

  const clearPending = () => {
    setPendingCount("");
    setPendingOp("");
  };

  const toggleNode = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const expandNode = (id: string) => {
    setExpanded((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  const collapseNode = (id: string) => {
    setExpanded((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const runPeek = (namespace: string, relationName: string) => {
    const peekRows = config.config().results.peekRows;
    const sql = peekSql(namespace, relationName, peekRows);
    void session
      .run({
        statements: [sql],
        readOnly: true,
        record: false,
        maxRows: peekRows,
      })
      .then((outcomes) => {
        const first = outcomes[0];
        if (first && !first.ok && session.shown() !== first) {
          status.say(printable(first.error.message), "error");
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        status.say(printable(msg), "error");
      });
  };

  const onKey = (key: Key): boolean => {
    const isPlain = !key.ctrl && !key.meta;

    if (pendingOp() === "g") {
      setPendingOp("");
      const { count, hasExplicitCount } = takeCount();
      if (isPlain && key.text === "g") {
        setCursor(hasExplicitCount ? count - 1 : 0);
        return true;
      }
      return false;
    }

    if (isPlain && key.text && /^[1-9]$/.test(key.text)) {
      setPendingCount((prev) => prev + key.text!);
      return true;
    }

    if (isPlain && key.text === "0" && pendingCount() !== "") {
      setPendingCount((prev) => prev + "0");
      return true;
    }

    if (isPlain && key.text === "g") {
      setPendingOp("g");
      return true;
    }

    if (isPlain && (key.text === "j" || key.name === "down")) {
      const { count } = takeCount();
      moveCursor(count);
      return true;
    }

    if (isPlain && (key.text === "k" || key.name === "up")) {
      const { count } = takeCount();
      moveCursor(-count);
      return true;
    }

    if (isPlain && key.text === "G") {
      const { count, hasExplicitCount } = takeCount();
      const currentRows = rows();
      const target = hasExplicitCount ? count - 1 : Math.max(0, currentRows.length - 1);
      setCursor(target, currentRows);
      return true;
    }

    if (key.ctrl && !key.meta && key.name === "d") {
      clearPending();
      const half = Math.max(1, Math.floor(viewportHeight() / 2));
      moveCursor(half);
      return true;
    }

    if (key.ctrl && !key.meta && key.name === "u") {
      clearPending();
      const half = Math.max(1, Math.floor(viewportHeight() / 2));
      moveCursor(-half);
      return true;
    }

    if (isPlain && (key.text === "l" || key.name === "right")) {
      clearPending();
      const currentRows = rows();
      const cur = clampedCursor();
      const row = currentRows[cur];
      if (!row) return true;
      if (row.kind === "namespace" && filter().length > 0) return true;
      if (row.kind === "namespace" || row.kind === "relation") {
        if (!row.expanded) {
          expandNode(row.id);
        } else {
          const nextRow = currentRows[cur + 1];
          if (nextRow && nextRow.depth === row.depth + 1) {
            setCursor(cur + 1, currentRows);
          }
        }
      }
      return true;
    }

    if (isPlain && (key.text === "h" || key.name === "left")) {
      clearPending();
      const currentRows = rows();
      const cur = clampedCursor();
      const row = currentRows[cur];
      if (!row) return true;
      if (row.kind === "namespace" && filter().length > 0) return true;
      if ((row.kind === "namespace" || row.kind === "relation") && row.expanded) {
        collapseNode(row.id);
        return true;
      }
      if (row.depth > 0) {
        for (let i = cur - 1; i >= 0; i--) {
          if (currentRows[i]!.depth === row.depth - 1) {
            setCursor(i, currentRows);
            break;
          }
        }
      }
      return true;
    }

    if (isPlain && key.name === "enter") {
      clearPending();
      const row = rows()[clampedCursor()];
      if (!row) return true;
      if (row.kind === "namespace") {
        if (filter().length === 0) {
          toggleNode(row.id);
        }
      } else {
        runPeek(row.namespace, row.relation.name);
      }
      return true;
    }

    if (isPlain && key.text === "i") {
      clearPending();
      const row = rows()[clampedCursor()];
      if (row) {
        props.onInsert?.(rowText(row));
        focus.focus("editor");
      }
      return true;
    }

    if (isPlain && key.text === "y") {
      clearPending();
      const row = rows()[clampedCursor()];
      if (row) {
        void copyToClipboard(rowText(row), {
          write: deps.write,
          which: deps.which,
          exec: deps.exec,
        }).then((res) => {
          if (!disposed && !res.ok) status.say(`Could not copy: ${printable(res.reason)}`, "error");
        });
      }
      return true;
    }

    if (isPlain && key.text === "/") {
      clearPending();
      cmdline.open({
        prefix: "/",
        initial: filter(),
        onSubmit: (nextFilter) => {
          setFilter(nextFilter);
          const nextRows = rows();
          const firstRel = nextRows.findIndex((r) => r.kind === "relation");
          setCursor(firstRel >= 0 ? firstRel : 0, nextRows);
        },
      });
      return true;
    }

    if (isPlain && key.name === "escape") {
      clearPending();
      if (filter().length > 0) {
        setFilter("");
        return true;
      }
      return false;
    }

    if (isPlain && key.text === "R") {
      clearPending();
      void session.refreshSchema();
      return true;
    }

    clearPending();
    return false;
  };

  keys.setPaneHandler("schema", onKey);
  onCleanup(() => {
    disposed = true;
    keys.setPaneHandler("schema", null);
  });

  status.register("schema", () => {
    const total = rows().length;
    const pos = total === 0 ? "0/0" : `${clampedCursor() + 1}/${total}`;
    return {
      mode: "NORMAL",
      pending: pendingCount() + pendingOp(),
      position: pos,
    };
  });

  const api: SchemaApi = {
    rows,
    cursor: clampedCursor,
    filter,
  };

  props.expose?.(api);

  const titleElement = (
    <box height={1} width="100%" flexDirection="row" gap={1}>
      <text fg={theme.color("textMuted")} attributes={TextAttributes.BOLD} flexShrink={0}>
        SCHEMA
      </text>
      <Show when={filter().length > 0}>
        <text fg={theme.color("primary")} flexShrink={0}>
          {`/${printable(filter())}`}
        </text>
      </Show>
    </box>
  );

  return (
    <PaneFrame pane="schema" title={titleElement}>
      <Switch>
        <Match when={session.status() === "none" && session.schema() === null}>
          <text fg={theme.color("textMuted")}>Not connected</text>
        </Match>
        <Match when={session.schema() === null && session.schemaError() !== null}>
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
            <text fg={theme.color("textMuted")}>
              {truncateCells("Schema could not be loaded", viewportWidth())}
            </text>
            <text fg={theme.color("textMuted")}>
              {truncateCells(printable(session.schemaError() ?? ""), viewportWidth())}
            </text>
            <text fg={theme.color("textMuted")}>
              {truncateCells("R retries", viewportWidth())}
            </text>
          </box>
        </Match>
        <Match when={session.schema() === null}>
          <Spinner label="loading schema" />
        </Match>
        <Match when={session.schema() !== null}>
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
            <For each={visibleItems()}>
              {(row, idx) => {
                const rowIndex = () => firstRowMemo() + idx();
                const isSelected = createMemo(() => rowIndex() === clampedCursor());
                const rowBg = () => {
                  if (!isSelected()) return undefined;
                  return focus.pane() === "schema"
                    ? theme.color("selection")
                    : theme.color("backgroundElement");
                };

                return (
                  <box
                    height={1}
                    width="100%"
                    flexShrink={0}
                    flexDirection="row"
                    backgroundColor={rowBg()}
                  >
                    <Show
                      when={row.kind === "column"}
                      fallback={
                        <text
                          fg={theme.color("text")}
                          bg={rowBg()}
                          attributes={
                            row.kind === "namespace" ? TextAttributes.BOLD : undefined
                          }
                          flexShrink={0}
                        >
                          {(() => {
                            const indent = "  ".repeat(row.depth);
                            const arrow =
                              (row.kind === "namespace" || row.kind === "relation") &&
                              row.expanded
                                ? "▾ "
                                : "▸ ";
                            const prefix = indent + arrow;
                            const budget = Math.max(
                              0,
                              viewportWidth() - cellWidth(prefix),
                            );
                            return prefix + truncateCells(printable(row.label), budget);
                          })()}
                        </text>
                      }
                    >
                      {(() => {
                        const colRow = row as Extract<TreeRow, { kind: "column" }>;
                        const formatted = createMemo(() =>
                          formatColumnRow(
                            colRow.label,
                            colRow.detail,
                            viewportWidth(),
                          ),
                        );
                        return (
                          <>
                            <text fg={theme.color("text")} bg={rowBg()} flexShrink={0}>
                              {`    ${formatted().label}`}
                            </text>
                            <Show when={formatted().detail.length > 0}>
                              <text
                                fg={theme.color("textMuted")}
                                bg={rowBg()}
                                flexShrink={0}
                              >
                                {formatted().detail}
                              </text>
                            </Show>
                          </>
                        );
                      })()}
                    </Show>
                  </box>
                );
              }}
            </For>
            <Show when={filter().length === 0 && hasNoRelations()}>
              <box height={1} width="100%" flexShrink={0}>
                <text fg={theme.color("textMuted")}>No tables</text>
              </box>
            </Show>
            <Show when={filter().length > 0 && rows().length === 0}>
              <box height={1} width="100%" flexShrink={0}>
                <text fg={theme.color("textMuted")}>
                  {truncateCells(`No matches for "${printable(filter())}"`, viewportWidth())}
                </text>
              </box>
            </Show>
          </box>
        </Match>
      </Switch>
    </PaneFrame>
  );
}
