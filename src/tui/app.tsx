import { render } from "@opentui/solid";
import { createSignal } from "solid-js";
import { VimTextarea } from "./components/vim-textarea";

const App = () => {
  const [text, setText] = createSignal("SELECT * FROM table LIMIT 1;");

  return (
    <box alignItems="center" justifyContent="flex-start">
      <box border width="100%" height="75%" paddingLeft="1%">
        <VimTextarea
          focused
          initialValue={text()}
          cursorColor="orange"
          onBufferChange={(newContent) => setText(newContent)}
        />
      </box>
      <box border width="100%" height="25%" paddingLeft="1%">
        <text>{text()}</text>
      </box>
    </box>
  );
};

render(() => <App />);
