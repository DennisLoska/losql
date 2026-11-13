import { TextareaRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import {
  createComputed,
  createContext,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  type ParentProps,
  Show,
  Switch,
  untrack,
  useContext,
} from "solid-js";
import { detectProviders, type ProviderStatus } from "../../core/agent/detect";
import {
  type Intent,
  runAgent,
  type StepRecord,
  type Turn,
  type TurnRequest,
} from "../../core/agent/loop";
import { providerErrorText } from "../../core/agent/prompt";
import { PROVIDERS } from "../../core/agent/providers";
import { type ProviderErrorKind, runProvider } from "../../core/agent/run";
import { resultToTable } from "../../core/db/format";
import { classify, type StatementClass } from "../../core/sql/classify";
import { splitStatements } from "../../core/sql/statements";
import type { AppApi } from "../app";
import { highlightSqlCardRows, type SqlHighlightPiece } from "../panes/agent/ProposalCard";
import {
  ESCAPED_MARKER_CHAR,
  sqlCardRows,
  startsWithMarkerChar,
  wrapText,
} from "../panes/agent/transcript-model";
import { useConfig } from "./config";
import { useDeps } from "./deps";
import { useDialog } from "./dialog";
import { useFocus } from "./focus";
import { useKeys } from "./keys";
import { useSession } from "./session";
import { useStatus } from "./status";
import { useTheme } from "./theme";

export interface Proposal {
  id: number;
  turnId: number;
  sql: string;
  kind: StatementClass;
  /**
   * The id of the Connection the Proposal was made on. It is run or accepted only while that
   * Connection is the Session's; one without it is never run or accepted.
   */
  connectionId?: string;
}

export interface TurnView {
  id: number;
  intent: Intent;
  text: string;
  steps: StepRecord[];
  status: "running" | "done" | "error" | "cancelled";
  activity: "thinking" | "querying" | null;
  message: string | null;
  errorKind: ProviderErrorKind | "protocol" | null;
  proposal: Proposal | null;
  source: { bufferId: number; statement: string } | null;
}

/**
 * What `ask` returns: a promise that settles when the request is done (true when it was
 * accepted), and `accepted`, known as soon as `ask` returns, saying whether the Agent took it.
 */
export type AskResult = Promise<boolean> & { readonly accepted: boolean };

export interface AgentApi {
  providers(): ProviderStatus[];
  detect(): Promise<ProviderStatus[]>;
  provider(): ProviderStatus | null;
  model(): string | null;
  turns(): TurnView[];
  running(): boolean;
  ask(request: { intent: Intent; text?: string }): AskResult;
  cancel(): boolean;
  reset(): void;
  proposals(): Proposal[];
  selected(): Proposal | null;
  select(direction: 1 | -1): void;
  accept(proposal: Proposal): void;
  run(proposal: Proposal): Promise<void>;
}

const AgentContext = createContext<AgentApi>();

export function AgentProvider(
  props: ParentProps<{
    getApi: () => AppApi;
    onQuit?: (hook: () => void | Promise<void>) => void;
    expose?: (api: AgentApi) => void;
  }>,
): JSX.Element {
  const deps = useDeps();
  const config = useConfig();
  const session = useSession();
  const focus = useFocus();
  const status = useStatus();
  const keys = useKeys();
  const dialog = useDialog();
  const renderer = useRenderer();

  const [providersSignal, setProvidersSignal] = createSignal<ProviderStatus[]>([]);
  const [turnsSignal, setTurnsSignal] = createSignal<TurnView[]>([]);
  const [selectedIdSignal, setSelectedIdSignal] = createSignal<number | null>(null);

  let nextTurnId = 1;
  let nextProposalId = 1;
  let activeTurn: {
    id: number;
    controller: AbortController;
    abandoned: boolean;
  } | null = null;
  let detectGeneration = 0;
  let disposed = false;

  const detect = async (): Promise<ProviderStatus[]> => {
    const gen = ++detectGeneration;
    // The saved Connections name the variables their passwords are read from; no Provider process gets them.
    const list = await detectProviders({
      which: deps.which,
      exec: deps.exec,
      env: deps.env,
      connections: untrack(() => config.config().connections),
    });
    if (!disposed && gen === detectGeneration) {
      setProvidersSignal(list);
    }
    return list;
  };

  onMount(() => {
    void detect();
  });

  const provider = createMemo<ProviderStatus | null>(() => {
    const id = config.config().agent.provider;
    if (!id) return null;
    const found = providersSignal().find((p) => p.id === id);
    if (found) return found;
    const adapter = PROVIDERS[id];
    return {
      id: adapter.id,
      label: adapter.label,
      installed: false,
      path: null,
      version: null,
      installHint: adapter.installHint,
    };
  });

  const model = createMemo<string | null>(() => config.config().agent.model);

  const running = createMemo<boolean>(() =>
    turnsSignal().some((t) => t.status === "running"),
  );

  const proposals = createMemo<Proposal[]>(() => {
    const list: Proposal[] = [];
    for (const t of turnsSignal()) {
      if (t.proposal) {
        list.push(t.proposal);
      }
    }
    return list;
  });

  const selected = createMemo<Proposal | null>(() => {
    const list = proposals();
    if (list.length === 0) return null;
    const selId = selectedIdSignal();
    if (selId !== null) {
      const found = list.find((p) => p.id === selId);
      if (found) return found;
    }
    return list[list.length - 1]!;
  });

  const select = (direction: 1 | -1): void => {
    const list = proposals();
    if (list.length === 0) return;
    const cur = selected();
    const curIdx = cur ? list.findIndex((p) => p.id === cur.id) : list.length - 1;
    const nextIdx = Math.max(0, Math.min(list.length - 1, curIdx + direction));
    setSelectedIdSignal(list[nextIdx]!.id);
  };

  const cancel = (): boolean => {
    if (!activeTurn) return false;
    activeTurn.controller.abort();
    return true;
  };

  const updateTurn = (id: number, updater: (t: TurnView) => TurnView): void => {
    if (disposed) return;
    setTurnsSignal((prev) => prev.map((t) => (t.id === id ? updater(t) : t)));
  };

  const clearConversation = (): void => {
    if (disposed) return;
    setTurnsSignal([]);
    setSelectedIdSignal(null);
  };

  const abortAndAbandonActive = () => {
    if (!activeTurn) return;
    const abandonedId = activeTurn.id;
    activeTurn.abandoned = true;
    activeTurn.controller.abort();
    activeTurn = null;
    if (!disposed) {
      updateTurn(abandonedId, (t) =>
        t.status === "running"
          ? { ...t, status: "cancelled", activity: null }
          : t,
      );
    }
  };

  // The Conversation belongs to the Connection it was held on: when the Session changes to another
  // Connection (by its id), the running Turn is abandoned and the Conversation is emptied, so that no
  // Proposal or result of one database is run on or sent with another. A new Driver of the same
  // Connection (a reopened connection, `:connect` with the same Connection) keeps it, and so does a
  // Session that only lost its connection.
  let lastDriver = untrack(() => session.driver());
  let lastStatus = untrack(() => session.status());
  let lastConnectionId: string | null = null;
  let driverInitialized = false;
  createComputed(() => {
    const currentDriver = session.driver();
    const currentStatus = session.status();
    const currentConnectionId = currentDriver?.connection.id ?? null;
    if (!driverInitialized) {
      driverInitialized = true;
      lastDriver = currentDriver;
      lastStatus = currentStatus;
      lastConnectionId = currentConnectionId;
      return;
    }
    const driverChanged = currentDriver !== lastDriver;
    const lostConnection = lastStatus === "connected" && currentStatus !== "connected";
    const connectionChanged = currentConnectionId !== null && currentConnectionId !== lastConnectionId;
    lastDriver = currentDriver;
    lastStatus = currentStatus;
    if (currentConnectionId !== null) {
      lastConnectionId = currentConnectionId;
    }
    if (driverChanged || lostConnection || connectionChanged) {
      abortAndAbandonActive();
    }
    if (connectionChanged) {
      clearConversation();
    }
  });

  const removeInterrupt = keys.onInterrupt(cancel);

  onCleanup(() => {
    disposed = true;
    removeInterrupt();
    abortAndAbandonActive();
  });

  props.onQuit?.(() => {
    disposed = true;
    abortAndAbandonActive();
  });

  const reset = (): void => {
    if (running() || activeTurn !== null) return;
    clearConversation();
  };

  const findEditorVisualSelection = (): string | null => {
    const pane = renderer.root.findDescendantById("pane-editor");
    if (!pane) return null;
    const walk = (node: unknown): TextareaRenderable | null => {
      if (!node || typeof node !== "object") return null;
      if (node instanceof TextareaRenderable && node.visible) {
        return node;
      }
      const children = (node as { getChildren?: () => unknown[] }).getChildren?.() ?? [];
      for (const child of children) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    const ta = walk(pane);
    if (!ta) return null;
    const sel = ta.getSelectedText();
    return sel && sel.trim().length > 0 ? sel.trim() : null;
  };

  // Decides at once, without waiting, whether a request is accepted: every refusal is here, and an
  // accepted request has taken the active Turn before this returns.
  const startTurn = (request: { intent: Intent; text?: string }) => {
    const activeDriver = session.driver();
    if (!activeDriver || session.status() !== "connected") {
      status.say("Not connected (use :connect)", "error");
      return null;
    }
    if (running() || activeTurn !== null) {
      status.say("The agent is still working");
      return null;
    }
    if (request.intent === "ask") {
      const trimmed = (request.text ?? "").trim();
      if (trimmed.length === 0) {
        return null;
      }
    }

    const prov = provider();
    if (!prov || !prov.installed || !prov.path) {
      status.say(prov ? `${prov.label} was not found (use space p)` : "No agent is set up (use space p)", "error");
      focus.focus("agent");
      return null;
    }

    let turnText = "";
    let reqText = "";
    let statement: string | undefined;
    let errorText: string | undefined;
    let source: { bufferId: number; statement: string } | null = null;

    const editor = props.getApi()?.editor;
    const activeBuf = editor ? editor.buffers()[editor.active()] : undefined;

    if (request.intent === "ask") {
      turnText = (request.text ?? "").trim();
      reqText = turnText;
    } else if (request.intent === "fix") {
      const lastErr = session.lastError();
      if (!lastErr) {
        status.say("No failed Run to fix", "error");
        return null;
      }
      statement = lastErr.statement;
      // In schema mode no value of a row leaves the machine, not even inside the text of an error.
      errorText = providerErrorText(
        lastErr.error,
        activeDriver.connection.dialect,
        config.config().agent.dataAccess,
      );
      turnText = "Fix the last error";
      reqText = "";
      if (activeBuf) {
        source = { bufferId: activeBuf.id, statement };
      }
    } else {
      // explain or optimize
      let selectedStmt: string | null = null;
      if (editor) {
        const mode = editor.mode();
        if (mode === "visual" || mode === "visual-line") {
          selectedStmt = findEditorVisualSelection();
        }
        if (selectedStmt === null) {
          const stmt = editor.statement();
          if (stmt && stmt.text.trim().length > 0) {
            selectedStmt = stmt.text;
          }
        }
      }
      if (!selectedStmt) {
        status.say("No statement under the cursor", "error");
        return null;
      }
      statement = selectedStmt;
      if (request.intent === "explain") {
        turnText = "Explain this statement";
        reqText = "";
      } else {
        turnText = "Optimize this statement";
        reqText = "";
        if (activeBuf) {
          source = { bufferId: activeBuf.id, statement };
        }
      }
    }

    const controller = new AbortController();
    const turnId = nextTurnId++;
    const turnState = {
      id: turnId,
      controller,
      abandoned: false,
    };
    activeTurn = turnState;

    const isStillValid = () =>
      !disposed &&
      !turnState.abandoned &&
      session.driver() === activeDriver &&
      session.status() === "connected";

    return {
      request,
      activeDriver,
      prov,
      binPath: prov.path,
      turnText,
      reqText,
      statement,
      errorText,
      source,
      controller,
      turnId,
      turnState,
      isStillValid,
    };
  };

  const runTurn = async (started: NonNullable<ReturnType<typeof startTurn>>): Promise<boolean> => {
    const {
      request,
      activeDriver,
      prov,
      binPath,
      turnText,
      reqText,
      statement,
      errorText,
      source,
      controller,
      turnId,
      turnState,
      isStillValid,
    } = started;
    let planText: string | undefined;

    if (request.intent === "optimize" && statement !== undefined) {
      try {
        const explainOutcomes = await session.explain(statement, false, false);
        if (!isStillValid()) {
          if (activeTurn === turnState) activeTurn = null;
          return true;
        }
        const first = explainOutcomes[0];
        if (first && first.ok) {
          planText = resultToTable(first.result);
        }
      } catch {
        // Leave plan out when explain fails
      }
      if (!isStillValid()) {
        if (activeTurn === turnState) activeTurn = null;
        return true;
      }
      if (controller.signal.aborted) {
        if (activeTurn === turnState) activeTurn = null;
        return true;
      }
    }

    const conversation: Turn[] = turnsSignal()
      .filter((t) => t.status === "done")
      .map((t) => ({
        intent: t.intent,
        text: t.text,
        steps: t.steps,
        answer:
          t.message !== null
            ? {
                message: t.message,
                ...(t.proposal ? { sql: t.proposal.sql } : {}),
              }
            : null,
      }));

    const newTurnView: TurnView = {
      id: turnId,
      intent: request.intent,
      text: turnText,
      steps: [],
      status: "running",
      activity: "thinking",
      message: null,
      errorKind: null,
      proposal: null,
      source,
    };

    focus.setVisible("agent", true);
    setTurnsSignal((prev) => [...prev, newTurnView]);

    const turnReq: TurnRequest = {
      intent: request.intent,
      text: reqText,
      ...(statement !== undefined ? { statement } : {}),
      ...(errorText !== undefined ? { error: errorText } : {}),
      ...(planText !== undefined ? { plan: planText } : {}),
      conversation,
    };

    const adapter = PROVIDERS[prov.id];
    const agentCfg = config.config().agent;

    try {
      const outcome = await runAgent(
        turnReq,
        {
          ask: (prompt, system, onText) =>
            runProvider(
              adapter,
              { prompt, system, model: agentCfg.model },
              {
                exec: deps.exec,
                binPath,
                env: deps.env,
                connections: untrack(() => config.config().connections),
                signal: controller.signal,
                timeoutMs: agentCfg.stepTimeoutMs,
                onText,
              },
            ),
          driver: activeDriver,
          config: agentCfg,
          signal: controller.signal,
        },
        (event) => {
          if (!isStillValid()) return;
          if (event.type === "thinking") {
            updateTurn(turnId, (t) =>
              t.activity === "thinking" ? t : { ...t, activity: "thinking" },
            );
          } else if (event.type === "step") {
            updateTurn(turnId, (t) => ({
              ...t,
              steps: [...t.steps, event.step],
              activity: "querying",
            }));
          }
        },
      );

      if (!isStillValid()) return true;

      if (outcome.ok) {
        let proposal: Proposal | null = null;
        if (outcome.sql !== undefined && outcome.sql.trim().length > 0) {
          proposal = {
            id: nextProposalId++,
            turnId,
            sql: outcome.sql,
            kind: classify(outcome.sql),
            connectionId: activeDriver.connection.id,
          };
        }
        updateTurn(turnId, (t) => ({
          ...t,
          steps: outcome.steps,
          status: "done",
          activity: null,
          message: outcome.message,
          errorKind: null,
          proposal,
        }));
        if (proposal) {
          setSelectedIdSignal(proposal.id);
        }
      } else if (outcome.kind === "cancelled") {
        updateTurn(turnId, (t) => ({
          ...t,
          steps: outcome.steps,
          status: "cancelled",
          activity: null,
          message: outcome.message,
          errorKind: "cancelled",
          proposal: null,
        }));
      } else {
        updateTurn(turnId, (t) => ({
          ...t,
          steps: outcome.steps,
          status: "error",
          activity: null,
          message: outcome.message,
          errorKind: outcome.kind,
          proposal: null,
        }));
      }
      return true;
    } finally {
      if (activeTurn === turnState) {
        activeTurn = null;
      }
    }
  };

  const ask = (request: { intent: Intent; text?: string }): AskResult => {
    const started = startTurn(request);
    const done = started === null ? Promise.resolve(false) : runTurn(started);
    return Object.assign(done, { accepted: started !== null });
  };

  // Every path that runs or accepts a Proposal asks this first: a Proposal is only used on the
  // Connection it was made on, whatever order events came in.
  const isForCurrentConnection = (proposal: Proposal): boolean => {
    const current = session.connection();
    if (!current) {
      status.say("Not connected (use :connect)", "error");
      return false;
    }
    if (proposal.connectionId === undefined || proposal.connectionId !== current.id) {
      status.say("This proposal was made for another connection", "error");
      return false;
    }
    return true;
  };

  const accept = (proposal: Proposal): void => {
    if (!isForCurrentConnection(proposal)) return;
    acceptChecked(proposal);
  };

  const acceptChecked = (proposal: Proposal): void => {
    const editor = props.getApi()?.editor;
    if (!editor) return;
    const turn = turnsSignal().find((t) => t.id === proposal.turnId);
    const src = turn?.source ?? null;

    if (src) {
      const bufs = editor.buffers();
      const targetIdx = bufs.findIndex((b) => b.id === src.bufferId);
      if (targetIdx >= 0) {
        const targetBuf = bufs[targetIdx]!;
        const currentText =
          editor.active() === targetIdx ? editor.text() : targetBuf.text;
        const pos = currentText.indexOf(src.statement);
        if (pos >= 0) {
          while (editor.active() !== targetIdx) {
            const before = editor.active();
            props.getApi().commands.run("buffer.next");
            if (editor.active() === before) break;
          }
          const activeText = editor.text();
          const replaceIdx = activeText.indexOf(src.statement);
          if (replaceIdx >= 0) {
            editor.replace(replaceIdx, replaceIdx + src.statement.length, proposal.sql);
            focus.focus("editor");
            return;
          }
        }
      }
    }

    editor.openBuffer({ name: "agent", text: proposal.sql });
    focus.focus("editor");
  };

  const run = async (proposal: Proposal): Promise<void> => {
    if (!isForCurrentConnection(proposal)) return;
    if (proposal.kind !== "read") {
      const message = "The agent proposed a statement that is not a read.";
      const confirmed = await dialog.confirm({
        title: "Run this statement?",
        message,
        body: () => <ProposalConfirmBody sql={proposal.sql} message={message} />,
        confirm: "Run",
        danger: true,
      });
      if (!confirmed) return;
      // The Connection may have changed while the confirmation was open.
      if (!isForCurrentConnection(proposal)) return;
    }
    acceptChecked(proposal);
    const statements = splitStatements(proposal.sql).map((s) => s.text);
    if (statements.length > 0) {
      await session.run({ statements });
    }
  };

  const api: AgentApi = {
    providers: providersSignal,
    detect,
    provider,
    model,
    turns: turnsSignal,
    running,
    ask,
    cancel,
    reset,
    proposals,
    selected,
    select,
    accept,
    run,
  };

  props.expose?.(api);

  return <AgentContext.Provider value={api}>{props.children}</AgentContext.Provider>;
}

export type ConfirmBodyRow =
  | { kind: "summary"; text: string }
  | { kind: "blank" }
  | {
      kind: "sql";
      /** The row as the card path gives it: cleaned SQL, after `↪ ` on a continuation row. */
      text: string;
      continuation: boolean;
      /** The text as drawn (a leading `↪` of a real line written out); never wider than the box. */
      shown: string;
      /** Which listed Statement the row belongs to. */
      statement: number;
      /** The row's index among the rows of its Statement. */
      index: number;
    }
  | { kind: "marker"; text: string };

/**
 * Every row of the confirmation's body before it is fitted into the dialog: the summary (when the
 * Proposal has more than one Statement) and the Statements that are not reads, through the same
 * path as the Proposal card (cleaned first, wrapped afterwards).
 */
export function confirmBodyRows(sql: string, contentWidth: number): ConfirmBodyRow[] {
  const statements = splitStatements(sql).map((s) => s.text);
  const total = statements.length;
  const nonReads = statements.filter((s) => classify(s) !== "read");
  const rows: ConfirmBodyRow[] = [];

  if (total > 1) {
    for (const line of wrapText(`${total} statements, ${nonReads.length} change data or structure:`, contentWidth)) {
      rows.push({ kind: "summary", text: line });
    }
  }

  const targets = nonReads.length > 0 ? nonReads : [sql];
  for (let sIdx = 0; sIdx < targets.length; sIdx++) {
    if (sIdx > 0) {
      rows.push({ kind: "blank" });
    }
    const stmtRows = sqlCardRows(targets[sIdx]!, contentWidth);
    for (let i = 0; i < stmtRows.length; i++) {
      const row = stmtRows[i]!;
      rows.push({
        kind: "sql",
        text: row.text,
        continuation: row.continuation,
        shown: startsWithMarkerChar(row) ? `${ESCAPED_MARKER_CHAR}${row.text.slice(1)}` : row.text,
        statement: sIdx,
        index: i,
      });
    }
  }

  return rows;
}

/**
 * Fits the body into `maxRows`: when it does not fit, the last rows are replaced by the marker,
 * wrapped onto as many rows as it needs, and the marker's own rows are counted.
 */
export function fitConfirmBodyRows(
  all: ConfirmBodyRow[],
  maxRows: number,
  contentWidth: number,
): ConfirmBodyRow[] {
  const budget = Math.max(1, maxRows);
  if (all.length <= budget) {
    return all;
  }
  for (let markerRows = 1; ; markerRows++) {
    const kept = Math.max(0, budget - markerRows);
    const hidden = all.length - kept;
    const lines = wrapText(`… ${hidden} more rows · cancel, then open it in the editor`, contentWidth);
    if (lines.length <= markerRows || kept === 0) {
      return [...all.slice(0, kept), ...lines.map((text) => ({ kind: "marker" as const, text }))];
    }
  }
}

function ProposalConfirmBody(props: { sql: string; message: string }): JSX.Element {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();

  const contentWidth = createMemo(() => {
    const panelWidth = Math.max(10, Math.min(60, dimensions().width - 4));
    return Math.max(1, panelWidth - 4);
  });

  const maxBodyRows = createMemo(() => {
    const h = dimensions().height;
    const margin = h >= 10 ? 2 : 0;
    const avail = Math.max(0, h - 6 - margin);
    const cw = contentWidth();
    const msgRows = wrapText(props.message, cw);
    const maxMsg = Math.max(1, avail - 2);
    const actualMsg = Math.min(msgRows.length, maxMsg);
    const usedByMsg = h >= 8 && actualMsg > 0 ? actualMsg + 1 : 0;
    return Math.max(1, avail - usedByMsg);
  });

  const allBodyRows = createMemo<ConfirmBodyRow[]>(() => confirmBodyRows(props.sql, contentWidth()));

  const visibleRows = createMemo<ConfirmBodyRow[]>(() =>
    fitConfirmBodyRows(allBodyRows(), maxBodyRows(), contentWidth()),
  );

  // Colours are computed over every row of a Statement that has a visible row, so a string or
  // comment that started above the visible part keeps its colour.
  const visiblePieces = createMemo<Map<ConfirmBodyRow, SqlHighlightPiece[]>>(() => {
    const all = allBodyRows();
    const byStatement = new Map<number, Extract<ConfirmBodyRow, { kind: "sql" }>[]>();
    for (const row of visibleRows()) {
      if (row.kind === "sql" && !byStatement.has(row.statement)) byStatement.set(row.statement, []);
    }
    for (const row of all) {
      if (row.kind === "sql") byStatement.get(row.statement)?.push(row);
    }
    const pieces = new Map<ConfirmBodyRow, SqlHighlightPiece[]>();
    for (const rows of byStatement.values()) {
      const highlighted = highlightSqlCardRows(rows);
      for (let i = 0; i < rows.length; i++) pieces.set(rows[i]!, highlighted[i]!);
    }
    return pieces;
  });

  return (
    <box flexDirection="column" width="100%">
      <For each={visibleRows()}>
        {(row) => (
          <Switch>
            <Match when={row.kind === "blank"}>
              <box height={1} width="100%" flexShrink={0} />
            </Match>
            <Match when={row.kind === "summary"}>
              <box height={1} width="100%" flexShrink={0} overflow="hidden">
                <text fg={theme.color("text")} wrapMode="none">
                  {(row as Extract<ConfirmBodyRow, { kind: "summary" }>).text}
                </text>
              </box>
            </Match>
            <Match when={row.kind === "sql"}>
              <box height={1} width="100%" flexShrink={0} overflow="hidden">
                <text fg={theme.color("text")} wrapMode="none">
                  <For each={visiblePieces().get(row) ?? []}>
                    {(piece) => <span style={{ fg: theme.color(piece.token) }}>{piece.text}</span>}
                  </For>
                </text>
              </box>
            </Match>
            <Match when={row.kind === "marker"}>
              <box height={1} width="100%" flexShrink={0} overflow="hidden">
                <text fg={theme.color("textMuted")} wrapMode="none">
                  {(row as Extract<ConfirmBodyRow, { kind: "marker" }>).text}
                </text>
              </box>
            </Match>
          </Switch>
        )}
      </For>
    </box>
  );
}

export function useAgent(): AgentApi {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent must be used within an AgentProvider");
  return ctx;
}
