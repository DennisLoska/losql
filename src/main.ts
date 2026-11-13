import { parseArgs, USAGE } from "./cli/args";
import {
  consumeStdoutWriteError,
  flushCliStreams,
  realCliDeps,
  runAsk,
  runExec,
  runHeadlessWithSignals,
  runProviders,
} from "./cli/commands";
import { escapeControl } from "./cli/terminal-text";
import { VERSION } from "./version";

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});
process.stderr.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});

async function flushAndExit(code: number, rawStderr: (text: string) => void): Promise<never> {
  await flushCliStreams();
  const writeErr = consumeStdoutWriteError();
  let exitCode = code;
  if (writeErr) {
    rawStderr(escapeControl(`losql: could not write output: ${writeErr.message}\n`));
    await flushCliStreams();
    if (exitCode === 0) {
      exitCode = 1;
    }
  }
  process.exit(exitCode);
}


const args = parseArgs(process.argv.slice(2));
const deps = realCliDeps();

switch (args.kind) {
  case "help":
    deps.stdout(`${USAGE}\n`);
    await flushAndExit(0, deps.stderr);
    break;
  case "version":
    deps.stdout(`losql ${VERSION}\n`);
    await flushAndExit(0, deps.stderr);
    break;
  case "error":
    deps.stderr(`${escapeControl(`losql: ${args.message}`)}\n\n${USAGE}\n`);
    await flushAndExit(2, deps.stderr);
    break;

  case "tui": {
    const { startTui } = await import("./tui/start");
    await startTui(args);
    break;
  }
  case "exec":
  case "ask":
  case "providers": {
    const rawStdout = deps.stdout;
    const rawStderr = deps.stderr;
    const exitCode = await runHeadlessWithSignals({
      rawStdout,
      rawStderr,
      onForceExit: (c) => process.exit(c),
      flush: () => flushCliStreams(),
      runCommand: async (signal) => {
        deps.signal = signal;
        deps.stdout = (text: string) => {
          if (signal.aborted) return;
          rawStdout(text);
        };
        deps.stderr = (text: string) => {
          if (signal.aborted) return;
          rawStderr(text);
        };
        return args.kind === "exec"
          ? await runExec(args, deps)
          : args.kind === "ask"
            ? await runAsk(args, deps)
            : await runProviders(args, deps);
      },
    });
    process.exit(exitCode);
  }
}

