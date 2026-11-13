import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, type JSX, onCleanup, Show, Switch, Match } from "solid-js";
import { useAgent } from "../context/agent";
import { useCmdline } from "../context/commands";
import { useConfig } from "../context/config";
import { useDeps } from "../context/deps";
import { useFocus } from "../context/focus";
import { useKeys } from "../context/keys";
import { useSession } from "../context/session";
import { useStatus } from "../context/status";
import { useTheme } from "../context/theme";
import { toRGBA } from "../theme-bridge";
import { cellWidth } from "./cells";
import { formatDuration } from "./duration";
import { printable } from "./printable";
import { Spinner } from "./spinner";

export function Statusline(): JSX.Element {
  const deps = useDeps();
  const status = useStatus();
  const keys = useKeys();
  const theme = useTheme();
  const cmdline = useCmdline();
  const config = useConfig();
  const session = useSession();
  const agent = useAgent();
  const focus = useFocus();
  const dimensions = useTerminalDimensions();

  const modeBg = createMemo(() => toRGBA({ ...theme.theme().primary, a: 255 }));
  const modeFg = createMemo(() => toRGBA({ ...theme.theme().background, a: 255 }));
  const pending = createMemo(() => keys.chord() || status.current().pending);

  const [nowSignal, setNowSignal] = createSignal(deps.clock.now());

  createEffect(() => {
    const running = session.running();
    if (!running || !config.animations()) {
      return;
    }
    setNowSignal(deps.clock.now());
    const off = deps.clock.onFrame((now) => {
      setNowSignal(now);
    });
    onCleanup(off);
  });

  const runningLabel = createMemo(() => {
    const r = session.running();
    if (!r) return "";
    if (!config.animations()) return "running";
    const seconds = Math.max(0, (nowSignal() - r.startedAt) / 1000);
    return `running ${seconds.toFixed(1)}s`;
  });

  const shownSummary = createMemo(() => {
    const outcome = session.shown();
    if (!outcome) return null;
    if (!outcome.ok) return "error";
    const res = outcome.result;
    const dur = formatDuration(res.durationMs);
    if (res.columns.length > 0) {
      const count = res.rows.length;
      const unit = count === 1 ? "row" : "rows";
      return `${count} ${unit} · ${dur}`;
    }
    return `${printable(res.command)} · ${dur}`;
  });

  const modeText = createMemo(() => ` ${status.current().mode} `);

  const connText = createMemo(() => {
    const s = session.status();
    const conn = session.connection();
    if (s === "connected" && conn) {
      return `${printable(conn.name)} · ${conn.dialect}`;
    }
    if (s === "connecting") {
      return "connecting…";
    }
    if (s === "disconnected" && conn) {
      return `${printable(conn.name)} · disconnected`;
    }
    return "no connection";
  });

  const runWidth = createMemo(() => {
    if (session.running() !== null) {
      const label = runningLabel();
      return label ? 2 + cellWidth(label) : 1;
    }
    const summary = shownSummary();
    return summary !== null ? cellWidth(summary) : 0;
  });

  const pendingText = createMemo(() => {
    const p = pending();
    return p !== "" ? printable(p) : "";
  });

  const positionText = createMemo(() => {
    const pos = status.current().position;
    return pos !== "" ? printable(pos) : "";
  });

  const messageText = createMemo(() => {
    const msg = status.message();
    return msg !== null ? printable(msg.text) : null;
  });

  const agentText = createMemo(() => {
    const prov = agent.provider();
    if (!prov || !prov.installed) {
      return "no agent";
    }
    const m = agent.model() ?? "default";
    return `${printable(prov.id)} · ${printable(m)}`;
  });

  const hintText = createMemo(() => `${printable(config.config().leader)} menu  : command`);

  const visibleSegments = createMemo(() => {
    const avail = Math.max(0, dimensions().width - 1);
    const modeW = cellWidth(modeText());
    const connW = cellWidth(connText());
    const rW = runWidth();
    const pendW = cellWidth(pendingText());
    const posW = cellWidth(positionText());
    const msg = messageText();
    const msgW = msg !== null ? cellWidth(msg) : 0;
    const agentW = cellWidth(agentText());
    const hintW = cellWidth(hintText());

    let used = modeW + (focus.zoomed() ? 2 + cellWidth("ZOOM") : 0);
    const showConn = used + 2 + connW <= avail || msg === null;
    if (showConn) {
      used += 2 + connW;
    }

    const rightReserve = msg !== null ? 2 + msgW : 0;
    const leftBudget = Math.max(used, avail - rightReserve);

    let showRun = false;
    if (rW > 0 && used + 2 + rW <= leftBudget) {
      showRun = true;
      used += 2 + rW;
    }

    let showPending = false;
    if (pendW > 0 && used + 2 + pendW <= leftBudget) {
      showPending = true;
      used += 2 + pendW;
    }

    let showPosition = false;
    if (posW > 0 && used + 2 + posW <= leftBudget) {
      showPosition = true;
      used += 2 + posW;
    }

    const showMessage = msg !== null;
    let showAgent = false;
    let showHint = false;
    if (msg === null) {
      if (used + 2 + agentW <= avail) {
        showAgent = true;
        used += 2 + agentW;
      }
      if (used + 2 + hintW <= avail) {
        showHint = true;
      }
    }

    return {
      showConn,
      showRun,
      showPending,
      showPosition,
      showMessage,
      showAgent,
      showHint,
    };
  });

  return (
    <Show
      when={!cmdline.active()}
      fallback={<box height={1} width="100%" flexShrink={0} backgroundColor={theme.color("background")} />}
    >
      <box
        height={1}
        width="100%"
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
        backgroundColor={theme.color("background")}
        paddingRight={1}
      >
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text bg={modeBg()} fg={modeFg()} attributes={TextAttributes.BOLD} flexShrink={0}>
            {modeText()}
          </text>
          <Show when={focus.zoomed()}>
            <text fg={theme.color("accent")} attributes={TextAttributes.BOLD} flexShrink={0}>ZOOM</text>
          </Show>
          <Show when={visibleSegments().showConn}>
            <Switch fallback={<text fg={theme.color("textMuted")} flexShrink={0}>no connection</text>}>
              <Match when={session.status() === "connected" && session.connection()}>
                <text fg={theme.color("text")} flexShrink={0}>
                  {connText()}
                </text>
              </Match>
              <Match when={session.status() === "connecting"}>
                <text fg={theme.color("textMuted")} flexShrink={0}>connecting…</text>
              </Match>
              <Match when={session.status() === "disconnected" && session.connection()}>
                <text fg={theme.color("error")} flexShrink={0}>
                  {connText()}
                </text>
              </Match>
            </Switch>
          </Show>
          <Show when={visibleSegments().showRun}>
            <Show
              when={session.running() !== null}
              fallback={
                <Show when={shownSummary() !== null}>
                  <text fg={theme.color("textMuted")} flexShrink={0}>{shownSummary()!}</text>
                </Show>
              }
            >
              <Spinner label={runningLabel()} />
            </Show>
          </Show>
          <Show when={visibleSegments().showPending}>
            <text fg={theme.color("accent")} flexShrink={0}>{pendingText()}</text>
          </Show>
          <Show when={visibleSegments().showPosition}>
            <text fg={theme.color("textMuted")} flexShrink={0}>{positionText()}</text>
          </Show>
        </box>
        <Show
          when={visibleSegments().showMessage && status.message() !== null}
          fallback={
            <box flexDirection="row" gap={2} flexShrink={0}>
              <Show when={visibleSegments().showAgent}>
                <text fg={theme.color("textMuted")} flexShrink={0}>{agentText()}</text>
              </Show>
              <Show when={visibleSegments().showHint}>
                <text fg={theme.color("textMuted")} flexShrink={0}>{hintText()}</text>
              </Show>
            </box>
          }
        >
          <text
            fg={status.message()!.kind === "error" ? theme.color("error") : theme.color("text")}
            flexShrink={0}
          >
            {messageText()!}
          </text>
        </Show>
      </box>
    </Show>
  );
}


