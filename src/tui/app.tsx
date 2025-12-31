import { render } from "@opentui/solid";

render(() => (
  <box
    backgroundColor="black"
    alignItems="center"
    justifyContent="flex-start"
    flexGrow={1}
  >
    <box backgroundColor="green" width="99%" height="50%">
      <textarea
        focused
        initialValue="SELECT * FROM table LIMIT 1;"
        cursorColor="orange"
      ></textarea>
    </box>
  </box>
));
