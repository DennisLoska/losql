import { TextAttributes } from "@opentui/core";
import { render } from "@opentui/solid";

render(() => (
  <box alignItems="center" justifyContent="center" flexGrow={1}>
    <box justifyContent="center" alignItems="flex-end">
      <ascii_font font="tiny" text="Losql" />
      <text attributes={TextAttributes.DIM}>It's just the beginning!</text>
    </box>
  </box>
));
