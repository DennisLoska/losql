import { createContext, type JSX, type ParentProps, useContext } from "solid-js";
import type { AppDeps } from "../deps";

const DepsContext = createContext<AppDeps>();

export function DepsProvider(props: ParentProps<{ deps: AppDeps }>): JSX.Element {
  return <DepsContext.Provider value={props.deps}>{props.children}</DepsContext.Provider>;
}

export function useDeps(): AppDeps {
  const ctx = useContext(DepsContext);
  if (!ctx) throw new Error("useDeps must be used within a DepsProvider");
  return ctx;
}
