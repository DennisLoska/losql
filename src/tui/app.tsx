import { render } from "@opentui/solid";
import { VimTextarea } from "./components/vim-textarea";

render(() => (
  <box alignItems="center" justifyContent="flex-start">
    <box
      border
      focusedBorderColor="orange"
      width="100%"
      height="75%"
      paddingLeft="1%"
    >
      <VimTextarea
        focused
        initialValue="SELECT * FROM table LIMIT 1;"
        cursorColor="orange"
      />
    </box>
    <box border focusedBorderColor="orange" width="100%" height="25%"></box>
  </box>
));
