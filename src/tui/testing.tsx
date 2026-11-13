import type { CapturedFrame, CapturedSpan } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JSX } from "solid-js";
import { loadConfig } from "../core/config";
import { openSession } from "../core/db/connection";
import { resolvePaths } from "../core/paths";
import { loadState, type AppState } from "../core/state";
import { parseKeys } from "../core/vim/keys";
import { App, type AppApi, type Loaded, type TuiArgs } from "./app";
import { loadInitialTheme } from "./context/theme";
import type { AppDeps } from "./deps";
import { manualClock, type ManualClock } from "./motion/clock";
import { setWidthMethod } from "./ui/cells";

export interface TestDeps extends AppDeps {
  clock: ManualClock;
  dir: string;        // temporary directory holding config/, state/ and work/
  exits: number[];    // codes passed to exit()
  written: string[];  // data passed to write()
}

export async function testDeps(overrides: Partial<AppDeps> = {}): Promise<TestDeps> {
  const dir = await mkdtemp(join(tmpdir(), "losql-tui-"));
  const env = { LOSQL_CONFIG_DIR: join(dir, "config"), LOSQL_STATE_DIR: join(dir, "state"), ...overrides.env };
  const cwd = overrides.cwd ?? join(dir, "work");
  await mkdir(cwd, { recursive: true });
  const exits: number[] = [];
  const written: string[] = [];
  const clock = manualClock();
  return {
    home: dir,
    exec: async () => {
      throw new Error("exec is not available in this test");
    },
    which: () => null,
    openSession: (connection) => openSession(connection, { env }),
    now: () => 1_800_000_000_000 + clock.now(),
    write: (data) => {
      written.push(data);
    },
    exit: (code) => {
      exits.push(code);
    },
    watch: () => () => {},
    ...overrides,
    env,
    cwd,
    paths: resolvePaths(env, dir),
    clock,
    dir,
    exits,
    written,
  };
}

export interface MountOptions {
  width?: number;                      // default 120
  height?: number;                     // default 36
  connection?: string | null;          // default "demo"; null starts without a Connection
  args?: TuiArgs;
  config?: Record<string, unknown>;    // written to config.json before it is loaded
  state?: Partial<AppState>;           // written to state.json; onboarded defaults to true
  deps?: Partial<AppDeps>;
  animations?: boolean;                // default false
  seed?: (deps: TestDeps) => Promise<void>;   // runs after config and state are written, before the first render
  ui?: (api: AppApi) => JSX.Element;   // render this instead of the workspace
}

export interface TestApp {
  api: AppApi;
  deps: TestDeps;
  setup: Awaited<ReturnType<typeof testRender>>;
  frame(): string;
  spans(): CapturedFrame;
  press(keys: string): Promise<void>;
  settle(): Promise<void>;
  advance(ms: number): Promise<void>;
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  dispose(): Promise<void>;
}

export async function mount(options: MountOptions = {}): Promise<TestApp> {
  const deps = await testDeps(options.deps);
  await mkdir(deps.paths.configDir, { recursive: true });
  await mkdir(deps.paths.stateDir, { recursive: true });
  await writeFile(deps.paths.configFile, JSON.stringify({ animations: options.animations ?? false, ...options.config }));
  await writeFile(
    deps.paths.stateFile,
    JSON.stringify({ onboarded: true, lastConnection: null, providerTests: {}, ...options.state }),
  );
  await options.seed?.(deps);
  const configLoaded = await loadConfig(deps.paths);
  const state = await loadState(deps.paths);
  const connection = options.connection === undefined ? "demo" : options.connection;
  const args: TuiArgs = { ...(connection === null ? {} : { connection }), ...options.args };
  const initialTheme = await loadInitialTheme(
    deps,
    args.theme ?? configLoaded.config.theme,
    configLoaded.config.mode,
    args.transparent ?? configLoaded.config.transparent,
  );
  const loaded: Loaded = { ...configLoaded, state, initialTheme };

  let api!: AppApi;
  const setup = await testRender(
    () => <App deps={deps} args={args} loaded={loaded} expose={(exposed) => (api = exposed)} ui={options.ui} />,
    { width: options.width ?? 120, height: options.height ?? 36 },
  );
  setWidthMethod(setup.renderer.widthMethod);

  const settle = async () => {
    for (let pass = 0; pass < 3; pass++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await setup.renderOnce();
    }
    let prev = setup.captureCharFrame();
    for (let extra = 0; extra < 5; extra++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await setup.renderOnce();
      const next = setup.captureCharFrame();
      if (next === prev) break;
      prev = next;
    }
  };
  await settle();

  return {
    api,
    deps,
    setup,
    frame: () => setup.captureCharFrame(),
    spans: () => setup.captureSpans(),
    settle,
    async press(keys) {
      for (const key of parseKeys(keys)) {
        api.keys.dispatch(key);
        await Promise.resolve();
      }
      await settle();
    },
    async advance(ms) {
      deps.clock.advance(ms);
      await settle();
    },
    async waitFor(predicate, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("waitFor timed out; frame:\n" + setup.captureCharFrame());
        await new Promise((resolve) => setTimeout(resolve, 5));
        await setup.renderOnce();
      }
      await settle();
    },
    async resize(width, height) {
      setup.resize(width, height);
      await settle();
    },
    async dispose() {
      await setup.dispose();
      await rm(deps.dir, { recursive: true, force: true });
    },
  };
}

/** The share of screen cells whose background is not painted (alpha 0). */
export function transparentRatio(frame: CapturedFrame): number {
  let clear = 0;
  let total = 0;
  for (const line of frame.lines) {
    for (const span of line.spans) {
      total += span.width;
      if (span.bg.toInts()[3] === 0) clear += span.width;
    }
  }
  return total === 0 ? 0 : clear / total;
}

/**
 * Where `marker` (printable ASCII) is drawn in the current frame, read from the renderer's cells: one entry per
 * occurrence, with the cell column `x` and row `y`. Wide characters take their real number of cells here.
 */
export function cellsWith(setup: TestApp["setup"], marker: string): { x: number; y: number }[] {
  const codes = Array.from(marker, (c) => c.charCodeAt(0));
  const found: { x: number; y: number }[] = [];
  setup.renderer.currentRenderBuffer.withBuffers((cells) => {
    const { width, height, char } = cells;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x + codes.length <= width; x++) {
        let all = true;
        for (let i = 0; i < codes.length; i++) {
          if (char[y * width + x + i] !== codes[i]) {
            all = false;
            break;
          }
        }
        if (all) found.push({ x, y });
      }
    }
  });
  return found;
}

/** The first span whose text contains `text`. Use short, single-colour strings. */
export function spanWith(frame: CapturedFrame, text: string): CapturedSpan | null {
  for (const line of frame.lines) {
    for (const span of line.spans) if (span.text.includes(text)) return span;
  }
  return null;
}

export { type FakeReply, fakeClaude } from "../core/agent/testing";
