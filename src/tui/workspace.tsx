import { createMemo, type JSX } from "solid-js";
import { useConfig } from "./context/config";
import { useDeps } from "./context/deps";
import { useFocus } from "./context/focus";
import { createTween } from "./motion/tween";
import { AgentPane } from "./panes/agent/AgentPane";
import { type EditorApi, EditorPane } from "./panes/editor/EditorPane";
import { type ResultsApi, ResultsPane } from "./panes/results/ResultsPane";
import { type SchemaApi, SchemaPane } from "./panes/schema/SchemaPane";
import { Statusline } from "./ui/statusline";

export function Workspace(props: {
  exposeSchema?: (api: SchemaApi) => void;
  exposeEditor?: (api: EditorApi) => void;
  exposeResults?: (api: ResultsApi) => void;
  onQuit?: (hook: () => void | Promise<void>) => void;
} = {}): JSX.Element {
  const deps = useDeps();
  const config = useConfig();
  const focus = useFocus();

  let editorApi: EditorApi | undefined;

  const schemaTween = createTween(() => (focus.visible("schema") ? 32 : 0), {
    duration: 180,
    clock: deps.clock,
    enabled: () => config.animations(),
  });

  const agentTween = createTween(() => (focus.visible("agent") ? 44 : 0), {
    duration: 180,
    clock: deps.clock,
    enabled: () => config.animations(),
  });

  const schemaCols = createMemo(() => Math.round(schemaTween()));
  const agentCols = createMemo(() => Math.round(agentTween()));

  const schemaOverlay = createMemo(() => focus.layout().schema === "overlay");
  const agentOverlay = createMemo(() => focus.layout().agent === "overlay");

  return (
    <box flexGrow={1} width="100%" height="100%" flexDirection="column">
      <box flexGrow={1} width="100%" flexDirection="row" position="relative">
        <box
          visible={schemaCols() > 0 && !focus.zoomed()}
          position={schemaOverlay() ? "absolute" : "relative"}
          left={schemaOverlay() ? 0 : undefined}
          top={schemaOverlay() ? 0 : undefined}
          width={schemaCols()}
          height="100%"
          flexShrink={0}
          zIndex={schemaOverlay() ? 10 : 0}
        >
          <SchemaPane
            expose={props.exposeSchema}
            onInsert={(text) => {
              editorApi?.insert(text);
            }}
          />
        </box>

        <box flexGrow={1} height="100%" flexDirection="column" position="relative">
          <box flexGrow={1} width="100%" visible={!focus.zoomed()}>
            <EditorPane
              expose={(api) => {
                editorApi = api;
                props.exposeEditor?.(api);
              }}
              onQuit={props.onQuit}
            />
          </box>
          <box height={focus.zoomed() ? "100%" : "40%"} width="100%" flexShrink={0}>
            <ResultsPane expose={props.exposeResults} />
          </box>
        </box>

        <box
          visible={agentCols() > 0 && !focus.zoomed()}
          position={agentOverlay() ? "absolute" : "relative"}
          right={agentOverlay() ? 0 : undefined}
          top={agentOverlay() ? 0 : undefined}
          width={agentCols()}
          height="100%"
          flexShrink={0}
          zIndex={agentOverlay() ? 10 : 0}
        >
          <AgentPane />
        </box>
      </box>
      <Statusline />
    </box>
  );
}
