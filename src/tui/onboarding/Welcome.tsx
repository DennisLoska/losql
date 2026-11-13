import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, type JSX, Show } from "solid-js";
import { VERSION } from "../../version";
import { useTheme } from "../context/theme";
import { cellWidth, cutCells } from "../ui/cells";
import { LOGO, Logo } from "../ui/logo";
import { printable } from "../ui/printable";

export const TAGLINE = "A vim-first SQL client with an agent on board.";

const HINT_FULL = "enter get started · esc skip setup";
const HINT_SHORT = "enter start · esc skip";
const HINT_MINI = "enter · esc";

function truncateCells(text: string, maxCells: number): string {
  if (maxCells <= 0) return "";
  return cutCells(text, maxCells, { ellipsis: true });
}

/** Measured when drawn, under the width method of the running renderer. */
const logoWidth = () => Math.max(1, ...LOGO.map((l) => cellWidth(l)));
const LOGO_HEIGHT = LOGO.length;

export function Welcome(): JSX.Element {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();

  const availWidth = createMemo(() => Math.max(1, dimensions().width));
  const availHeight = createMemo(() => Math.max(1, dimensions().height));

  const showLogo = createMemo(
    () => availWidth() >= logoWidth() && availHeight() >= LOGO_HEIGHT + 5,
  );
  const showVersion = createMemo(() => availHeight() >= 4);
  const showTagline = createMemo(() => availHeight() >= 2);
  const showSpacer = createMemo(() => availHeight() >= LOGO_HEIGHT + 7);

  const taglineText = createMemo(() => truncateCells(TAGLINE, availWidth()));
  const versionText = createMemo(() =>
    truncateCells(`losql ${printable(VERSION)}`, availWidth()),
  );
  const hintText = createMemo(() => {
    const w = availWidth();
    if (cellWidth(HINT_FULL) <= w) return HINT_FULL;
    if (cellWidth(HINT_SHORT) <= w) return HINT_SHORT;
    if (cellWidth(HINT_MINI) <= w) return HINT_MINI;
    return truncateCells("enter/esc", w);
  });

  return (
    <box
      flexGrow={1}
      width="100%"
      height="100%"
      flexDirection="column"
      alignItems="center"
    >
      <box flexGrow={1} minHeight={0} />
      <Show when={showLogo()}>
        <box flexShrink={0}>
          <Logo />
        </box>
        <Show when={showSpacer()}>
          <box height={1} flexShrink={0} />
        </Show>
      </Show>
      <Show when={showTagline()}>
        <text fg={theme.color("text")} flexShrink={0}>
          {taglineText()}
        </text>
      </Show>
      <Show when={showVersion()}>
        <text fg={theme.color("textMuted")} flexShrink={0}>
          {versionText()}
        </text>
      </Show>
      <box flexGrow={1} minHeight={0} />
      <text fg={theme.color("textMuted")} flexShrink={0}>
        {hintText()}
      </text>
    </box>
  );
}
