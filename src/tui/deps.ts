import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { openSession } from "../core/db/connection";
import type { Connection, Driver } from "../core/db/types";
import { bunExec, type Exec } from "../core/exec";
import { type Paths, resolvePaths } from "../core/paths";
import type { loadBuffers as realLoadBuffers } from "../core/state";
import { type Clock, realClock } from "./motion/clock";

export interface AppDeps {
  env: Record<string, string | undefined>;
  home: string;
  cwd: string;
  paths: Paths;
  exec: Exec;
  which: (bin: string) => string | null;
  openSession: (connection: Connection) => Promise<Driver>;
  loadBuffers?: typeof realLoadBuffers;
  clock: Clock;
  now: () => number;
  write: (data: string) => void;
  exit: (code: number) => void;
  watch: (path: string, onChange: () => void) => () => void;
}

export function realDeps(): AppDeps {
  const env = process.env;
  const home = homedir();
  const cwd = process.cwd();
  const paths = resolvePaths(env, home);

  return {
    env,
    home,
    cwd,
    paths,
    exec: bunExec,
    which: (bin) => Bun.which(bin),
    openSession: (connection) => openSession(connection, { env }),
    clock: realClock(),
    now: () => Date.now(),
    write: (data) => {
      process.stdout.write(data);
    },
    exit: (code) => {
      process.exit(code);
    },
    watch: watchFile,
  };
}

/** How often `watchFile` looks at the file. */
const WATCH_POLL_MS = 200;

type Identity = string | null;

function identityOf(st: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
}

/**
 * Calls `onChange` when the file at `path` is there and is no longer the file (or the content) last seen.
 *
 * It looks at the file's identity (device, inode, size, modification and change time) every `pollMs`
 * instead of listening to the file system, because a watch on the file or its directory goes deaf when
 * the directory is removed and another one is moved into its place, as a theme switch of Omarchy does.
 * A look costs one `stat`; nothing else happens while the file stays the same.
 *
 * - While the file is missing nothing is called; when it is back and differs, it is.
 * - A change is reported once it has held for one look, so a burst of writes leads to one call, for the
 *   final state.
 * - The returned function stops the watch: no timer is left and nothing is called afterwards.
 */
function watchFile(path: string, onChange: () => void, pollMs = WATCH_POLL_MS): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reported: Identity;
  try {
    reported = identityOf(statSync(path));
  } catch {
    reported = null;
  }
  let pending: Identity = null;

  const look = async () => {
    timer = null;
    let now: Identity;
    try {
      now = identityOf(await stat(path));
    } catch {
      now = null;
    }
    if (stopped) return;
    if (now === null || now === reported) {
      pending = null;
    } else if (now === pending) {
      reported = now;
      pending = null;
      try {
        onChange();
      } catch {
        // A failing listener does not end the watch.
      }
      if (stopped) return;
    } else {
      pending = now;
    }
    timer = setTimeout(look, pollMs);
  };

  timer = setTimeout(look, pollMs);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
