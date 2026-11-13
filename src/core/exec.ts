export interface ExecRequest {
  cmd: string[];
  cwd?: string;
  stdin?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  discardOutput?: boolean;
  onStdoutLine?: (line: string) => void;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  outputLimitHit?: boolean;
}

export type Exec = (request: ExecRequest) => Promise<ExecResult>;

const KILL_GRACE_MS = 1000;
const DRAIN_GRACE_MS = 500;

export const bunExec: Exec = async (request: ExecRequest): Promise<ExecResult> => {
  const proc = Bun.spawn(request.cmd, {
    cwd: request.cwd,
    env: request.env,
    stdin: "pipe",
    stdout: request.discardOutput ? "ignore" : "pipe",
    stderr: request.discardOutput ? "ignore" : "pipe",
  });

  void (async () => {
    try {
      if (request.stdin !== undefined && request.stdin.length > 0) {
        await proc.stdin.write(request.stdin);
      }
      await proc.stdin.end();
    } catch {
      // Ignore broken pipe if child exited early
    }
  })();

  let timedOut = false;
  let aborted = false;
  let outputLimitHit = false;
  let totalOutputBytes = 0;
  let terminating = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  const terminate = () => {
    if (terminating) return;
    terminating = true;
    try {
      proc.kill();
    } catch {
      // Ignore if already exited
    }
    killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Ignore if already exited
      }
    }, KILL_GRACE_MS);
  };

  if (request.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);
  }

  const onAbort = () => {
    aborted = true;
    terminate();
  };

  if (request.signal) {
    if (request.signal.aborted) {
      onAbort();
    } else {
      request.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  if (request.discardOutput) {
    try {
      await proc.exited;
      return {
        code: proc.exitCode,
        stdout: "",
        stderr: "",
        timedOut,
        aborted,
      };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      if (request.signal) {
        request.signal.removeEventListener("abort", onAbort);
      }
    }
  }

  const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();

  const recordBytes = (chunkBytes: number): boolean => {
    totalOutputBytes += chunkBytes;
    if (request.maxOutputBytes !== undefined && totalOutputBytes > request.maxOutputBytes) {
      if (!outputLimitHit) {
        outputLimitHit = true;
        terminate();
        void stdoutReader.cancel().catch(() => {});
        void stderrReader.cancel().catch(() => {});
      }
      return false;
    }
    return true;
  };

  const readStdout = async (): Promise<string> => {
    const decoder = new TextDecoder();
    const parts: string[] = [];
    const lineChunks: string[] = [];

    const emitFromChunk = (chunk: string) => {
      if (!request.onStdoutLine) return;
      let start = 0;
      let newlineIdx = chunk.indexOf("\n", start);
      if (newlineIdx === -1) {
        if (chunk.length > 0) {
          lineChunks.push(chunk);
        }
        return;
      }
      while (newlineIdx !== -1) {
        const segment = chunk.slice(start, newlineIdx);
        let line: string;
        if (lineChunks.length > 0) {
          lineChunks.push(segment);
          line = lineChunks.join("");
          lineChunks.length = 0;
        } else {
          line = segment;
        }
        request.onStdoutLine(line);
        start = newlineIdx + 1;
        newlineIdx = chunk.indexOf("\n", start);
      }
      if (start < chunk.length) {
        lineChunks.push(chunk.slice(start));
      }
    };

    try {
      while (true) {
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          ({ done, value } = await stdoutReader.read());
        } catch {
          break;
        }
        if (done || !value) break;
        if (!recordBytes(value.byteLength)) {
          break;
        }
        const chunk = decoder.decode(value, { stream: true });
        parts.push(chunk);
        emitFromChunk(chunk);
      }
      if (!outputLimitHit) {
        const tail = decoder.decode();
        if (tail.length > 0) {
          parts.push(tail);
          emitFromChunk(tail);
        }
        if (request.onStdoutLine && lineChunks.length > 0) {
          request.onStdoutLine(lineChunks.join(""));
          lineChunks.length = 0;
        }
      }
    } finally {
      stdoutReader.releaseLock();
    }

    return parts.join("");
  };

  const readStderr = async (): Promise<string> => {
    const decoder = new TextDecoder();
    const parts: string[] = [];

    try {
      while (true) {
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          ({ done, value } = await stderrReader.read());
        } catch {
          break;
        }
        if (done || !value) break;
        if (!recordBytes(value.byteLength)) {
          break;
        }
        parts.push(decoder.decode(value, { stream: true }));
      }
      if (!outputLimitHit) {
        const tail = decoder.decode();
        if (tail.length > 0) {
          parts.push(tail);
        }
      }
    } finally {
      stderrReader.releaseLock();
    }

    return parts.join("");
  };

  const watchExit = async (): Promise<void> => {
    await proc.exited;
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
      killTimer = undefined;
    }
    drainTimer = setTimeout(() => {
      void stdoutReader.cancel().catch(() => {});
      void stderrReader.cancel().catch(() => {});
    }, DRAIN_GRACE_MS);
  };

  try {
    const exitDone = watchExit();
    let stdout = "";
    let stderr = "";
    try {
      [stdout, stderr] = await Promise.all([readStdout(), readStderr(), exitDone]);
    } catch (err) {
      terminate();
      await exitDone;
      throw err;
    }

    const result: ExecResult = {
      code: proc.exitCode,
      stdout,
      stderr,
      timedOut,
      aborted,
    };
    if (outputLimitHit) {
      result.outputLimitHit = true;
    }
    return result;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
    }
    if (drainTimer !== undefined) {
      clearTimeout(drainTimer);
    }
    if (request.signal) {
      request.signal.removeEventListener("abort", onAbort);
    }
  }
};

